// @ts-check
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { redactSensitiveText, extractSecretLikeValues } from '../NoeContextScrubber.js';
import { classifyNoePolicyFilePath, gitAwareTestFileExists } from '../../security/NoePolicyFileGuard.js';
import { findFuzzyMatch } from './NoeFuzzyPatchMatcher.js';

const SECRET_PATH_RE = /(^|\/)(\.env|\.npmrc|\.netrc|.*token.*|.*cookie.*|.*oauth.*|.*secret.*|owner-token\.txt|room-adapters\.json)$/i;

function clean(value, max = 2000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function rel(root, file) {
  return relative(root, file).replace(/\\/g, '/');
}

// 父目录软链逃逸防护（红队 round-2 实锤）：lstat 只看路径末段，父目录是软链（src/evil -> /tmp/outside）时
//   末段是普通文件 → 词法判定「在 root 内」、lstat 末段也非软链 → 放行，但 writeFileSync 跟随父软链写到
//   沙箱外任意位置（触碰 owner 红线「不破坏电脑系统」）。故对「最深已存在祖先」realpath 后校验仍在
//   realpath(root) 内。新文件尚不存在的中间目录无法预解析，取最深已存在祖先（apply 时 mkdirSync 只会在
//   该真实祖先下建目录，不会再引入新软链）。
function ancestorRealpathWithinRoot(root, file) {
  let realRoot;
  try { realRoot = realpathSync(root); } catch { realRoot = resolve(root); }
  let dir = dirname(resolve(file));
  while (dir && dir !== dirname(dir) && !existsSync(dir)) dir = dirname(dir);
  let realDir;
  try { realDir = realpathSync(dir); } catch { return false; }
  return realDir === realRoot || realDir.startsWith(realRoot + sep);
}

function safeResolve(root, ref = '') {
  const file = resolve(root, String(ref || ''));
  // L2-L4 修复：startsWith(root) 缺尾分隔符，兄弟同前缀目录（/x-foo vs /x）会误判在沙箱内。
  if (!(file === root || file.startsWith(root + sep))) return null; // 词法在 root 内
  if (!ancestorRealpathWithinRoot(root, file)) return null;          // 真实路径（解软链后）也在 root 内
  return file;
}

// 命中受保护策略文件（PolicyFileGuard）→ 返回 matchedId 字符串供 blockers 标注；否则 ''。
// 安全门：禁止自改链路改掉自己的测试/授权脚本/安全门源码（与 SECRET_PATH_RE 同级硬挡）。
function policyFileBlockReason(root, ref = '') {
  // A2：NOE_ALLOW_NEW_TEST_FILES=1 时放行飞轮「新增 + 覆盖自己 untracked 残留」的测试文件（改 tracked 现有/scripts/具体policy文件仍禁）。
  //   git-aware fileExists 根治残留死循环：飞轮上次写的测试在 commit 前是 untracked，self_repair 重写它属正常，放行覆盖（不当「改现有」挡）。
  const hit = classifyNoePolicyFilePath(String(ref || ''), {
    root, cwd: root,
    allowNewTestFiles: process.env.NOE_ALLOW_NEW_TEST_FILES === '1',
    fileExists: (p) => gitAwareTestFileExists(p, root),
  });
  return hit && hit.protected === true ? (hit.matchedId || hit.reason || 'policy-file') : '';
}

function blockedPath(root, ref = '') {
  const normalized = String(ref || '').replace(/\\/g, '/');
  if (SECRET_PATH_RE.test(normalized) || normalized.includes('games/cartoon-apocalypse/')) return true;
  return policyFileBlockReason(root, ref) !== '';
}

// 安全读取 patch 目标（红队实锤两类问题）：
//   ① 软链写穿——目标若是软链，writeFileSync 会跟随写到软链指向处（可能是受保护文件），而词法分类只看
//      软链自身路径 → 绕过 preflight + post-apply changedFiles 二次核。lstat（不跟随）检出软链直接判 block。
//   ② 目录/特殊文件——目标是已存在目录时 readFileSync 抛 EISDIR、未捕获崩溃传播出执行器（小模型易吐
//      {op:'replace', path:'src/loop'} 或漏 path）。归一为干净 blocker 而非崩溃。
//   返回 { kind:'file'|'absent'|'block', content?, reason? }。
function safeReadForPatch(file) {
  let st;
  try { st = lstatSync(file); } catch { return { kind: 'absent' }; } // 不存在 = 新建文件，正常
  if (st.isSymbolicLink()) return { kind: 'block', reason: 'patch_path_is_symlink' };
  if (!st.isFile()) return { kind: 'block', reason: 'patch_path_not_a_file' };
  try { return { kind: 'file', content: readFileSync(file, 'utf8') }; }
  catch { return { kind: 'block', reason: 'patch_path_unreadable' }; }
}

export class NoePatchTransaction {
  constructor({ root = process.cwd(), missionId = 'unknown', patchPlan = {}, nowMs = Date.now, fuzzyEnabled, fuzzyMatch, fuzzyOptions } = {}) {
    this.root = resolve(root);
    this.missionId = clean(missionId, 160);
    this.patchPlan = patchPlan || {};
    this.nowMs = nowMs;
    this.operations = [];
    this.backups = [];
    this.applied = false;
    // 容漂移 patch（opt-in）：精确 from 未命中时用内容相似度唯一定位。**默认 OFF**（env NOE_FUZZY_PATCH==='1' 才开）；
    //   DI 可注入 fuzzyEnabled/fuzzyMatch/fuzzyOptions 便于测试与调参，不注入则回退 env + 合规版 findFuzzyMatch。
    this.fuzzyEnabled = typeof fuzzyEnabled === 'boolean' ? fuzzyEnabled : (process.env.NOE_FUZZY_PATCH === '1');
    this.fuzzyMatch = typeof fuzzyMatch === 'function' ? fuzzyMatch : findFuzzyMatch;
    this.fuzzyOptions = fuzzyOptions && typeof fuzzyOptions === 'object' ? fuzzyOptions : {};
  }

  parsePatch() {
    const operations = asArray(this.patchPlan.operations);
    this.operations = operations.map((operation, index) => ({
      id: clean(operation.id || `op-${index + 1}`, 160),
      op: clean(operation.op || operation.type || 'write_file', 80),
      path: clean(operation.path, 1000),
      content: String(operation.content ?? '').slice(0, 1_000_000),
      from: String(operation.from ?? '').slice(0, 200_000),
      to: String(operation.to ?? '').slice(0, 200_000),
    }));
    return { ok: true, operations: this.operations };
  }

  checkPreconditions() {
    if (this.operations.length === 0) this.parsePatch();
    const blockers = [];
    // 虚拟串行应用：同文件多 op 时，后续 op 的 from 唯一性必须基于「前序 op 改后的中间态」而非原盘，
    //   否则 op1 可注入/吃掉 op2 的 from，apply 串行写盘后错位或丢失（审计 + 红队端到端实锤）。
    const working = new Map(); // file(abs) -> 虚拟当前内容（null=不存在）
    const touched = [];        // {file, path} 顺序去重，供 finalText secret 检测
    for (const operation of this.operations) {
      const file = safeResolve(this.root, operation.path);
      if (operation.op !== 'write_file' && operation.op !== 'replace') blockers.push(`unsupported_patch_operation:${operation.op}`);
      if (!file) { blockers.push(`patch_path_outside_root:${operation.path}`); continue; }
      const policyHit = policyFileBlockReason(this.root, operation.path);
      if (policyHit) blockers.push(`patch_path_policy_protected:${operation.path}`);
      else if (blockedPath(this.root, operation.path)) blockers.push(`patch_path_blocked:${operation.path}`);
      if (!working.has(file)) {
        const r = safeReadForPatch(file); // 软链/目录/特殊文件 → 干净 blocker（非 EISDIR 崩溃、非写穿）
        if (r.kind === 'block') { blockers.push(`${r.reason}:${operation.path}`); continue; }
        const initial = r.kind === 'file' ? r.content : null;
        working.set(file, initial);
        touched.push({ file, path: operation.path, original: initial === null ? '' : initial });
      }
      if (operation.op === 'replace') {
        if (!operation.from) { blockers.push(`patch_replace_from_required:${operation.id}`); continue; }
        const cur = working.get(file);
        if (cur === null) { blockers.push(`patch_replace_file_missing:${operation.path}`); continue; }
        let occ = cur.split(operation.from).length - 1;
        // 容漂移回退（opt-in）：精确 from 逐字未命中（occ===0）时，flag 开则按**内容相似度**在文件里唯一定位，
        //   把 from 重解析为「文件内逐字块」（fuzzyMatch 返回的 block）——后续精确唯一性判定、apply() 末道 occApply
        //   铁律、finalText secret 检测全部照常走（不因 fuzzy 跳过任何验证）。安全铁律：仅「唯一（fuzzy 内部
        //   ambiguity 门 + 此处字符串级 occ===1 双核）」才采用；未唯一命中则不动 from，维持 occ===0 精确失败（绝不猜位置）。
        if (occ === 0 && this.fuzzyEnabled) {
          const fz = this.fuzzyMatch(cur, operation.from, this.fuzzyOptions) || {};
          if (fz.matched && typeof fz.block === 'string' && fz.block && cur.split(fz.block).length - 1 === 1) {
            operation.from = fz.block;
            operation.fuzzyMatched = true;
            occ = 1;
          }
        }
        if (occ === 0) { blockers.push(`patch_replace_from_not_found:${operation.id}`); continue; }
        if (occ > 1) { blockers.push(`patch_replace_from_ambiguous:${operation.id}:${occ}`); continue; }
        working.set(file, cur.replace(operation.from, () => operation.to)); // 推进中间态
      } else if (operation.op === 'write_file') {
        if (!operation.content) blockers.push(`patch_content_required:${operation.id}`);
        working.set(file, operation.content);
      }
    }
    // finalText secret 检测：看每文件 apply 后的最终全文，拦「补丁引入了原本没有的 secret」（含拆分写入绕过）。
    //   仅当 patch 引入新 secret 才拦，避免误拦本就含 secret-like 片段的现有文件的合法修改。
    for (const { file, path, original } of touched) {
      const finalText = working.get(file);
      if (typeof finalText !== 'string') continue;
      // original 取自首次安全读（safeReadForPatch），不再二次 readFileSync（避免目录/软链的 EISDIR/写穿重入）。
      // 只拦「patch 引入了 original 中不存在的新 secret 值」：按 secret 原始值集合差集判定。
      //   不用计数差(会被「删旧+加新 / 整文件覆盖」net 持平对冲绕过——复审实锤)；不做整文件豁免。
      const origSecrets = extractSecretLikeValues(original);
      const introduced = [...extractSecretLikeValues(finalText)].filter((s) => !origSecrets.has(s));
      if (introduced.length > 0) blockers.push(`patch_content_contains_secret_like_value:${path}`);
    }
    return { ok: blockers.length === 0, blockers: [...new Set(blockers)] };
  }

  apply() {
    const preflight = this.checkPreconditions();
    if (!preflight.ok) return { ok: false, status: 'blocked', preflight };
    this.backups = [];
    const changedFiles = [];
    for (const operation of this.operations) {
      const file = safeResolve(this.root, operation.path);
      if (!file) throw new Error(`patch_path_outside_root_at_apply:${operation.path}`); // 兜 preflight（含父软链逃逸）
      // 末道守门（preflight 已挡，此处兜 TOCTOU）：软链/目录绝不写穿/崩溃。
      let st = null; try { st = lstatSync(file); } catch { st = null; }
      if (st && st.isSymbolicLink()) throw new Error(`patch_path_is_symlink_at_apply:${operation.path}`);
      if (st && !st.isFile()) throw new Error(`patch_path_not_a_file_at_apply:${operation.path}`);
      const existed = !!st;
      const previous = existed ? readFileSync(file, 'utf8') : null;
      this.backups.push({ file, ref: rel(this.root, file), existed, previous });
      mkdirSync(dirname(file), { recursive: true });
      if (operation.op === 'replace') {
        // 末道守门：apply 基于「当前盘」重算唯一性（checkPreconditions 已虚拟串行校验，此处兜 TOCTOU）。
        const occApply = String(previous).split(operation.from).length - 1;
        if (occApply !== 1) throw new Error(`patch_replace_from_not_unique_at_apply:${operation.id}:${occApply}`);
        // 函数式 replace 避免 to 中 $&/$1 被当正则替换模式解释。
        writeFileSync(file, String(previous).replace(operation.from, () => operation.to), 'utf8');
      } else {
        writeFileSync(file, operation.content, 'utf8');
      }
      changedFiles.push(rel(this.root, file));
    }
    this.applied = true;
    return { ok: true, status: 'applied', changedFiles, rollbackAvailable: true, appliedAt: new Date(Number(this.nowMs())).toISOString() };
  }

  rollback() {
    const restored = [];
    for (const backup of [...this.backups].reverse()) {
      if (backup.existed) {
        writeFileSync(backup.file, backup.previous, 'utf8');
        restored.push(backup.ref);
      } else if (existsSync(backup.file)) {
        rmSync(backup.file, { force: true });
        restored.push(`${backup.ref}:removed_new_file`);
      }
    }
    this.applied = false;
    return { ok: true, status: 'rolled_back', restored };
  }

  recordDiff() {
    return {
      ok: true,
      missionId: this.missionId,
      changedFiles: this.backups.map((backup) => backup.ref),
      operations: this.operations.map((operation) => ({ id: operation.id, op: operation.op, path: operation.path })),
      secretValuesReturned: false,
    };
  }
}

export function createPatchTransaction(args = {}) {
  return new NoePatchTransaction(args);
}
