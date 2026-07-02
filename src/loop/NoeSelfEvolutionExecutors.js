// @ts-check
// 环1：self-evolution executor（手脚）——让自改 act 真能被 ActPipeline 真实执行。
//
// 设计：全注入式 + env 门控（NOE_SELF_EVOLUTION_EXECUTORS，默认 OFF，唯一注册入口在
//   SafeActExecutors）。OFF 时 executors Map 无这四个 key = 与现状逐字一致零回归。
//
// 安全网（全部保留，只接线不拆）：
//   - 每 executor 先 assertGatePassed（纵深防御）：act.payload.selfEvolutionGate.ok===true 否则 throw。
//     pipeline 正常链路只在 gate ok 时写入并到达 executor；此处挡住任何绕过 pipeline 的直接调用。
//   - apply/rollback 走 NoePatchApplyExecutor：备份 0o600 + sha256 + SECRET_PATH_RE/games 硬挡
//     + dryRun 预检 + confirmOwner 必需。
//   - P1-5：runtime verify 失败时自动 rollback 并 **throw**——ActPipeline #executeReal 对非 throw 的
//     result 一律标 completed（ActPipeline.js L313），失败必须 throw 才会标 failed（L272）。
//   - implementation/self_repair 额外要求 standing grant（scope=self-evolution:run，P1-3 第三处硬校验）。
//   - memory_writeback 只写脱敏 summary，绝不写 diff/secret。

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { runNoePatchApply, runNoePatchRollback, extractNoePatchPlan } from '../runtime/mission/NoePatchApplyExecutor.js';
import { noeStructuredCall } from '../runtime/NoeStructuredCall.js';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';
import { sanitizeNoeHostExecEnv } from '../security/NoeHostExecEnv.js';
import { shouldRollbackVerify } from './NoeRelativeBaselineGate.js';
import { isNoePolicyFilePath } from '../security/NoePolicyFileGuard.js';

export const SELF_EVOLUTION_GRANT_SCOPE = 'self-evolution:run';
const SELF_EVOLUTION_OUTPUT_DIR = 'output/noe-self-evolution';
// 镜像 NoePatchApplyExecutor.NOE_PATCH_APPLY_REPORT_DIR 的规范路径（apply-report 落盘目录）。
//   不直接 import 该常量是为避免既有 executors 单测的 vi.mock（不导出此常量 → 严格 mock 会抛 "No export"）连带误炸；
//   值与底座保持一致即可（底座变更时一并改这里——它只是去重扫描的默认根，可被 deps.applyReportsDir 覆盖）。
const DEFAULT_APPLY_REPORTS_DIR = 'output/noe-patch-transactions/apply-reports';

export const NOE_SELF_EVOLUTION_EXECUTOR_ACTIONS = Object.freeze([
  'noe.self_evolution.implementation',
  'noe.self_evolution.self_repair',
  'noe.self_evolution.memory_writeback',
  'noe.self_evolution.complete',
]);

function clean(value, max = 2000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function asDate(now) {
  const value = typeof now === 'function' ? now() : now;
  return value instanceof Date ? value : new Date(value || Date.now());
}

function stampOf(date) {
  return date.toISOString().replace(/[-:.]/g, '').slice(0, 15);
}

function selfEvolutionContext(act = {}) {
  const payload = (act && act.payload) || {};
  const ctx = payload.selfEvolution || payload.self_evolution || {};
  return (ctx && typeof ctx === 'object' && !Array.isArray(ctx)) ? ctx : {};
}

// 纵深防御：二次确认 pipeline gate 已放行。绕过 pipeline 直接调 executor → 立刻 throw。
function assertGatePassed(act = {}) {
  const gate = act && act.payload && act.payload.selfEvolutionGate;
  if (!gate || gate.ok !== true) throw new Error('gate_not_passed_in_executor');
}

// P1-3 第三处 scope 硬校验：实施类 act 在 executor 侧再独立评估 standing grant（不信 payload）。
function assertStandingGrant(evaluateGrant) {
  const grant = typeof evaluateGrant === 'function'
    ? evaluateGrant({ scope: SELF_EVOLUTION_GRANT_SCOPE })
    : { authorized: false };
  if (!grant || grant.authorized !== true) throw new Error('self_evolution_apply_requires_standing_grant');
  return grant;
}

// throw 携带结构化自改语义的 Error（P1-5）。message 经脱敏，绝不含 secret/diff；
// 结构化字段挂在 error 上供未来 trigger / 审计读取（ActPipeline 当前只读 message → failed）。
function selfEvolutionError(code, details = {}) {
  const err = /** @type {Error & { selfEvolution?: Record<string, unknown> }} */ (new Error(code));
  err.selfEvolution = { code, secretValuesReturned: false, ...details };
  return err;
}

// P3：确定性 patchPlanId —— 同一「objective + operations 内容」必产同一 id（可复算，不含时间戳/随机/路径）。
//   只取操作的语义字段（op/path/content/from/to）并按固定 key 序规范化，让重排无关字段 / 加 UUID dir 不影响 id。
//   用途：apply 幂等去重的稳定键（patchPlanRef 每轮带新 UUID 目录 → 不可作键；内容指纹才稳）。
function normalizeOperationForId(op = {}) {
  const o = (op && typeof op === 'object') ? op : {};
  // 固定 key 顺序 + 仅语义字段；缺省补空串，保证形状一致（{op,path} vs {op,path,content} 不应因键存在与否漂移）。
  return {
    op: String(o.op ?? o.type ?? ''),
    path: String(o.path ?? ''),
    content: String(o.content ?? ''),
    from: String(o.from ?? ''),
    to: String(o.to ?? ''),
  };
}

/**
 * 基于 objective + operations 内容算确定性 patchPlanId（sha256 前 24 hex）。同输入必同 id。
 * @param {{objective?: string, operations?: any[]}} input
 * @returns {string}
 */
export function noeSelfEvolutionPatchPlanId({ objective = '', operations = [] } = {}) {
  const canonical = JSON.stringify({
    objective: String(objective ?? '').trim(),
    operations: (Array.isArray(operations) ? operations : []).map(normalizeOperationForId),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 24);
}

// 从已落盘的 patch-plan.json（patchPlanRef 指向）**复算** patchPlanId（内容指纹）。
//   防伪造（P3 红队 blocker，Codex 复现）：**绝不信任文件里写的 patchPlanId 字段**——它可被伪造成与他人
//   相同的 id 来骗过去重、跳过真 apply（prior=src/b.js、current=src/a.js 只要伪造同 id 就 skip + verify 0 次）。
//   故判定一律从 canonical operations 复算；文件内 patchPlanId 仅作审计字段，不参与判定。
//   fail-open：读不到 / 解析失败 → 返回 ''（调用方据此不去重，照常 apply，绝不因此漏 apply）。
function readPatchPlanIdFromRef(root, patchPlanRef) {
  try {
    const file = resolve(resolve(root), String(patchPlanRef || ''));
    if (!existsSync(file)) return '';
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const plan = extractNoePatchPlan(data) || {};
    return noeSelfEvolutionPatchPlanId({ objective: data && data.objective, operations: plan.operations });
  } catch { return ''; }
}

// P0 进化度量：读 patchPlan 的 touchedFiles 路径（apply 前后 measure 客观指标用）。fail-open 返 []。
// 测试文件路径判据（补测试有效性门用）：tests/ 或任意目录下的 *.test.js / *.spec.js（含 .mjs/.ts 变体）。
const SELF_EVOLUTION_TEST_FILE_RE = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i;

function readPatchPlanPaths(root, patchPlanRef) {
  try {
    const file = resolve(resolve(root), String(patchPlanRef || ''));
    if (!existsSync(file)) return [];
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const plan = extractNoePatchPlan(data) || {};
    return [...new Set((plan.operations || []).map((o) => o && o.path).filter(Boolean))];
  } catch { return []; }
}

/**
 * 幂等去重扫描：在 apply-reports 目录里找「同 patchPlanId 且 status==='applied'」的既有报告。
 *   匹配键 = patchPlanId（内容指纹）：逐份 applied 报告解析其 patchPlanRef → 复算 id → 比对。
 *   fail-open：目录不存在 / 单份报告读坏 → 跳过，绝不因扫描失败而漏 apply。
 * @returns {{ priorApplyReportRef: string } | null}  命中返回既有 apply-report 引用；未命中返回 null。
 */
function findPriorAppliedReport({ root, patchPlanId, applyReportsDir }) {
  if (!patchPlanId) return null;
  const rootAbs = resolve(root);
  const dirRef = applyReportsDir || DEFAULT_APPLY_REPORTS_DIR;
  const dirAbs = resolve(rootAbs, dirRef);
  let names = [];
  try {
    if (!existsSync(dirAbs)) return null;
    names = readdirSync(dirAbs).filter((n) => n.endsWith('.json'));
  } catch { return null; }
  for (const name of names) {
    try {
      const report = JSON.parse(readFileSync(resolve(dirAbs, name), 'utf8'));
      if (!report || report.status !== 'applied') continue;
      const ref = String(report.patchPlanRef || '').trim();
      if (!ref) continue;
      if (readPatchPlanIdFromRef(rootAbs, ref) === patchPlanId) {
        return { priorApplyReportRef: String(report.reportRef || `${dirRef}/${name}`) };
      }
    } catch { /* 单份报告读坏不阻断扫描（fail-open） */ }
  }
  return null;
}

// 从 apply-report 读出 changedFiles（幂等 skip 回填实现证据用）。fail-open：读不到 / 解析失败 → []。
//   兼容 changedFiles 为 string / {path} / {file} 三种形状。
function readChangedFilesFromReport(root, reportRef) {
  try {
    const file = resolve(resolve(root), String(reportRef || ''));
    if (!existsSync(file)) return [];
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(data.changedFiles)) return [];
    return data.changedFiles
      .map((f) => (f && typeof f === 'object' ? (f.path || f.file || '') : f))
      .filter((f) => typeof f === 'string' && f);
  } catch { return []; }
}

// apply → verify →（失败）rollback 的核心串法，implementation 与 self_repair 复用。
//
// P3 影子 worktree 评估结论（路线图原写「apply 跑影子 worktree，test 绿才 promote 回主树」，此处落定不采纳并说明）：
//   对 Neo 这种「live 工作树长期领先 origin、含大量未提交改动」的现实，git worktree add 出的新树是干净 HEAD
//   **不含未提交改动** → 在其中跑 npm test 测的是旧代码，无意义；且 node_modules 含 better-sqlite3 native binding，
//   worktree 需重装/symlink，成本高。故事务性不靠影子 worktree，而由本函数的 backup(0o600+sha256) + verify 失败
//   原子 rollback（源文件按 manifest 还原 + throw）提供——见下方 applied/verify/rolledBack 串法。
//   更强隔离（真正独立进程跑全量测试）走隔离端口 PORT=51999 的独立 `npm run start:noe` 实例，不在本热路径内。
//   幂等：apply 前用 patchPlanId（内容指纹复算）扫 apply-reports，已 applied 同内容 → 跳过重复 apply，但仍跑
//   verify + 回填证据让 cycle 收口；self_repair（skipDedup）不去重，因其语义是重新应用而非跳过。
async function applyAndVerify({ root, patchPlanRef, runtimeVerify, now, applyReportsDir, skipDedup = false, evolutionOutcome = null, evolutionLogicGate = null }) {
  // P3 幂等：同内容 patch 已 applied 过 → 跳过**重复 apply**（不重复改代码），但**仍跑 runtime verify** 确认当前
  //   含该 patch 的系统真绿 + 回填既有 apply 的 changedFiles 证据，让 cycle 完成门（需 implementation 证据 + runtime
  //   ok）能收口——否则「代码已就位却因缺证据卡死」(P3 一致性模块想防的半截状态被幂等亲手制造，红队 blocker)。
  //   skipDedup=true（self_repair 专用）：self_repair 先 rollback 上一轮失败 apply 再**重新应用**，绝不能被旧
  //   applied 报告骗去跳过（否则文件停在 rollback 后的坏内容 + verify 0 次，红队 blocker）。fail-open：去重失败照常 apply。
  if (!skipDedup) {
    const patchPlanId = readPatchPlanIdFromRef(root, patchPlanRef);
    const prior = findPriorAppliedReport({ root, patchPlanId, applyReportsDir });
    if (prior) {
      const priorChangedFiles = readChangedFilesFromReport(root, prior.priorApplyReportRef);
      let skipVerify;
      try { skipVerify = await runtimeVerify({ root, applyReportRef: prior.priorApplyReportRef }); }
      catch (e) { skipVerify = { ok: false, error: clean(e && e.message ? e.message : e, 300) }; }
      return {
        ok: !!(skipVerify && skipVerify.ok === true),
        skipped: true,
        reason: 'already_applied',
        patchPlanId,
        priorApplyReportRef: prior.priorApplyReportRef,
        changedFiles: priorChangedFiles,
        verify: skipVerify,
      };
    }
  }
  const dryRun = runNoePatchApply({ root, patchPlanRef, dryRun: true, now });
  if (!dryRun.ok) {
    throw selfEvolutionError('self_evolution_apply_preflight_blocked', {
      blockers: (dryRun.blocked || []).flatMap((b) => b.blockers || []).slice(0, 20),
      reportRef: dryRun.reportRef,
    });
  }
  // A2 post-apply 一致性：apply 后文件已落盘，事后无法判「新建 vs 改现有」。故 apply 前快照 patch 目标的存在状态——
  //   新建 tests/ 测试 apply 前不存在 → 下方 mutatedProtected 经 fileExists 报「不存在」→ PolicyFileGuard 放行（与
  //   preflight 的 allowNewTestFiles 判断一致）；改现有受保护文件 apply 前已存在 → 仍挡（防改现有测试/安全门假绿）。
  const existedBeforeApply = new Set(
    readPatchPlanPaths(root, patchPlanRef)
      .filter((p) => { try { return existsSync(resolve(root, p)); } catch { return true; } })
      .map((p) => String(p).replace(/\\/g, '/')),
  );
  // P0 进化度量：apply 前采集 touchedFiles 客观指标（仅 flag ON 注入 evolutionOutcome 时；fail-open）。
  let outcomePaths = [];
  let outcomeBefore = null;
  if (evolutionOutcome) {
    try { outcomePaths = readPatchPlanPaths(root, patchPlanRef); outcomeBefore = evolutionOutcome.measure(outcomePaths); } catch { outcomeBefore = null; }
  }
  // P3 双绿门前半：flag ON 时 apply 前跑 baseline verify（确立行为基线可信，排除「改前就坏、改后还坏」被误判为安全）。
  //   flag OFF 不跑（改逻辑会被下方 preCheck 早拒，省一次全量 test）。fail-open：探针失败 → baselineGreen=false（postCheck 保守拒）。
  let baselineGreen = null;
  let baselineTotalTests = null; // 补测试有效性门用：apply 前 vitest 用例总数，apply 后须真增加才算补测试生效。
  let baselineFailedTests = null; // 相对 baseline 健壮性用：apply 前 fail 数，apply 后没超它=飞轮没新增 fail（别窗已有 fail 不算破坏）。
  if (evolutionLogicGate && typeof evolutionLogicGate.enabled === 'function' && evolutionLogicGate.enabled()) {
    try {
      const b = await runtimeVerify({ root });
      baselineGreen = !!(b && b.ok === true);
      baselineTotalTests = (b && typeof b.numTotalTests === 'number') ? b.numTotalTests : null;
      baselineFailedTests = (b && typeof b.numFailedTests === 'number') ? b.numFailedTests : null;
    } catch { baselineGreen = false; }
  }
  const applied = runNoePatchApply({ root, patchPlanRef, dryRun: false, confirmOwner: true, now });
  if (applied.status !== 'applied') {
    throw selfEvolutionError('self_evolution_apply_failed', {
      status: applied.status,
      errors: (applied.errors || []).map((e) => e && e.error).filter(Boolean).slice(0, 20),
      reportRef: applied.reportRef,
    });
  }
  // P0 进化度量：apply 后立即采集 after（趁文件是改后状态，任何 rollback 前）+ summarize 算 verdict（给 P3 门判分流）。
  //   根因修复：此处只算不落账；最终落账延到结局确定后标 applied（保留/回滚），防 P4/P5 把被回滚的尝试误判为成功。
  let outcomeAfter = null;
  let outcomeSummary = null;
  if (evolutionOutcome && outcomeBefore) {
    try {
      outcomeAfter = evolutionOutcome.measure(outcomePaths);
      outcomeSummary = (typeof evolutionOutcome.summarize === 'function') ? evolutionOutcome.summarize({ before: outcomeBefore, after: outcomeAfter }) : null;
    } catch { outcomeAfter = null; outcomeSummary = null; }
  }
  // 落账 helper：各结局点调，kept = 最终是否保留（成功 true / 被拦/回滚 false）。用已采的 after，rollback 后调也准。fail-open。
  const recordOutcomeFinal = (kept) => {
    if (evolutionOutcome && outcomeBefore && outcomeAfter) {
      try { evolutionOutcome.record({ patchPlanId: readPatchPlanIdFromRef(root, patchPlanRef), before: outcomeBefore, after: outcomeAfter, applied: kept }); } catch { /* fail-open */ }
    }
  };
  // P0-2 防 reward hack 纵深第二道：apply 落盘后核 changedFiles，受 PolicyFileGuard 保护文件被改 → rollback + throw。
  //   诚实说明（审计）：changedFiles 来自 NoePatchTransaction.apply 的同源词法路径，preflight 已用同一
  //   policyFileBlockReason 在写盘前挡死，正常 patchPlan 路径此处几乎不触发——保留为「未来其他 executor 形态 /
  //   返回形状漂移」的兜底带，非挡某个当前可达的绕过（软链写穿已在 NoePatchTransaction 层用 lstat 闭掉）。
  //   changedFiles 兼容 string / {path} 两种形状。
  // A2：放行飞轮「新增」tests/ 测试文件（apply 前不存在）；改现有受保护文件仍挡。allowNewTestFiles + apply 前快照 fileExists。
  const allowNewTestFiles = process.env.NOE_ALLOW_NEW_TEST_FILES === '1';
  const mutatedProtected = (applied.changedFiles || [])
    .map((f) => (f && typeof f === 'object' ? (f.path || f.file || '') : f))
    .filter((f) => {
      if (!f) return false;
      const relPath = String(f).replace(/\\/g, '/');
      const fileExists = () => existedBeforeApply.has(relPath); // apply 前存在=改现有(挡)；不存在=新建(A2 放行)
      return isNoePolicyFilePath(f, { root, cwd: root, allowNewTestFiles, fileExists });
    });
  if (mutatedProtected.length) {
    const rolledBack = runNoePatchRollback({ root, applyReportRef: applied.reportRef, dryRun: false, confirmOwner: true, now });
    recordOutcomeFinal(false);
    throw selfEvolutionError('self_evolution_protected_file_mutated_post_apply', {
      mutatedProtected: mutatedProtected.slice(0, 20),
      applyReportRef: applied.reportRef,
      rolledBack: !!(rolledBack && rolledBack.status === 'rolled_back'),
    });
  }
  // P3 受控逻辑改进门 preCheck：改 src 逻辑(verdict=logic_changed) + flag OFF → rollback + 记账(applied:false) + throw。
  //   doc_only/neutral/test_only 放行（当前行为零回归）。summary 缺失（度量 flag OFF）→ 门不接入，零回归。
  if (evolutionLogicGate && outcomeSummary) {
    let pre = { block: false };
    try { pre = evolutionLogicGate.preCheck({ summary: outcomeSummary, paths: outcomePaths }); } catch { pre = { block: false }; }
    if (pre.block) {
      const rolledBack = runNoePatchRollback({ root, applyReportRef: applied.reportRef, dryRun: false, confirmOwner: true, now });
      recordOutcomeFinal(false);
      throw selfEvolutionError('self_evolution_logic_change_blocked', {
        reason: pre.reason, phase: 'pre_verify',
        applyReportRef: applied.reportRef,
        rolledBack: !!(rolledBack && rolledBack.status === 'rolled_back'),
      });
    }
  }
  let verify;
  try {
    verify = await runtimeVerify({ root, applyReportRef: applied.reportRef });
  } catch (e) {
    verify = { ok: false, error: clean(e && e.message ? e.message : e, 300) };
  }
  // 相对 baseline 健壮性（flag NOE_EVOLUTION_RELATIVE_BASELINE 默认 OFF=绝对绿、零回归）：verify 不绿时，若 fail 数没超 apply 前 baseline
  //   （别窗/已有 fail 非飞轮新增）→ 不回滚、放行，免飞轮被别窗 untracked fail 测试拖垮停摆（曾停 20h 的根因）。
  if (shouldRollbackVerify({ verify, baselineFailedTests, relativeEnabled: process.env.NOE_EVOLUTION_RELATIVE_BASELINE === '1' })) {
    // 自动 rollback（confirmOwner 必需，撑 Gate 的 rollback 约束）；不吞错——回滚结果一并返回。
    const rolledBack = runNoePatchRollback({ root, applyReportRef: applied.reportRef, dryRun: false, confirmOwner: true, now });
    recordOutcomeFinal(false);
    return { ok: false, applied, verify: verify || { ok: false }, rolledBack };
  }
  // 补测试有效性门（堵假性 complete）：新增 *.test.js 必须真让 vitest 运行用例数增加。
  //   实测教训：M3 默认写 test/(单数,vitest include 不收) + node:test(vitest 不收集) → 测试零运行、verify 照绿、假性
  //   complete（写了测试等于没补覆盖）。现有 verify 只堵「逻辑错的测试在 tests/ 下跑出 failure」，堵不住「测试根本没被
  //   运行」。仅在拿得到 baseline 测试数(NOE_EVOLUTION_LOGIC ON)时启用；拿不到则 fail-open 回退现状，不引入新失败模式。
  const addsTestFile = (applied.changedFiles || [])
    .map((f) => (f && typeof f === 'object' ? (f.path || f.file || '') : f))
    .some((f) => f && SELF_EVOLUTION_TEST_FILE_RE.test(String(f)));
  if (addsTestFile && baselineTotalTests != null && typeof verify.numTotalTests === 'number'
      && verify.numTotalTests <= baselineTotalTests) {
    const rolledBack = runNoePatchRollback({ root, applyReportRef: applied.reportRef, dryRun: false, confirmOwner: true, now });
    recordOutcomeFinal(false);
    return {
      ok: false, applied, verify, rolledBack,
      reason: 'added_test_not_effective',
      detail: { baselineTotalTests, afterTotalTests: verify.numTotalTests },
    };
  }
  // P3 受控逻辑改进门 postCheck（双绿门终判）：改 src 逻辑需 baseline+verify 双绿才保留重构；test_only 只需 verify 绿。
  //   verify 已绿到这里（上方 !verify.ok 已 return）→ verifyGreen=true；改前 baseline 见上方探针。不过门 → rollback + throw。
  if (evolutionLogicGate && outcomeSummary) {
    let post = { allow: true };
    try { post = evolutionLogicGate.postCheck({ summary: outcomeSummary, paths: outcomePaths, baselineGreen, verifyGreen: true }); } catch { post = { allow: true }; }
    if (!post.allow) {
      const rolledBack = runNoePatchRollback({ root, applyReportRef: applied.reportRef, dryRun: false, confirmOwner: true, now });
      recordOutcomeFinal(false);
      throw selfEvolutionError('self_evolution_logic_change_blocked', {
        reason: post.reason, phase: 'post_verify',
        applyReportRef: applied.reportRef,
        rolledBack: !!(rolledBack && rolledBack.status === 'rolled_back'),
      });
    }
  }
  // 全部门通过 + verify 绿 → 改动真保留，落账 applied:true（真成功；P4 据此蒸馏成功模式、P5 据此诊断健康）。
  recordOutcomeFinal(true);
  return { ok: true, applied, verify };
}

async function resolvePatchPlanRef({ ctx, root, spawnImplementer, gate }) {
  const provided = String(ctx.patchPlanRef || '').trim();
  if (provided) return provided;
  if (typeof spawnImplementer !== 'function') throw selfEvolutionError('self_evolution_implementer_unavailable');
  const out = await spawnImplementer({ objective: clean(ctx.objective || ctx.goal || '', 1000), targetFile: ctx.targetFile || '', root, gate });
  const ref = String((out && out.patchPlanRef) || '').trim();
  if (!ref) throw selfEvolutionError('self_evolution_patch_plan_ref_missing');
  return ref;
}

/**
 * 注册四个 self-evolution executor 到现有 executors Map。全注入式，便于单测 stub。
 * @param {Map<string, Function>} executors
 * @param {{root?: string, evaluateGrant?: Function, spawnImplementer?: Function, runtimeVerify?: Function, memoryWrite?: Function, appendEvent?: Function, now?: any, applyReportsDir?: string}} deps
 */
export function registerNoeSelfEvolutionExecutors(executors, deps = {}) {
  if (!(executors instanceof Map)) throw new Error('registerNoeSelfEvolutionExecutors requires a Map');
  const {
    root = process.cwd(),
    evaluateGrant,
    spawnImplementer,
    runtimeVerify,
    memoryWrite,
    appendEvent,
    now = () => new Date(),
    // P3 幂等去重：apply-reports 目录可注入（默认真实路径）；测试借此喂「含已 applied 同 patchPlanId report」的临时目录。
    applyReportsDir = DEFAULT_APPLY_REPORTS_DIR,
    evolutionOutcome = null, // P0 进化价值度量（shadow 记账）；flag OFF 时 null = 零接入零回归
    evolutionLogicGate = null, // P3 受控逻辑改进门；null = 零接入零回归（改逻辑走旧无门路径）
    typeErrorVerify = null, // type_error_fix 域：对 type_error goal 包装 runtimeVerify 加 typecheck+防作弊价值锚；null = 不启用（零回归）
  } = deps;

  executors.set('noe.self_evolution.implementation', async ({ act }) => {
    assertGatePassed(act);
    assertStandingGrant(evaluateGrant);
    const ctx = selfEvolutionContext(act);
    const gate = act.payload.selfEvolutionGate;
    const patchPlanRef = await resolvePatchPlanRef({ ctx, root, spawnImplementer, gate });
    // type_error_fix 域：对 type_error goal 包装 runtimeVerify（npm test 绿后跑 typecheck + 防作弊价值锚）。
    //   守卫：仅 ctx.signal==='type_error' 且注入了 typeErrorVerify 才包装；其他 goal 走原 runtimeVerify（零回归）。
    let effectiveVerify = runtimeVerify;
    if (ctx.signal === 'type_error' && ctx.targetFile && typeof typeErrorVerify === 'function') {
      effectiveVerify = typeErrorVerify({ baseVerify: runtimeVerify, targetFile: ctx.targetFile, beforeErrorCount: ctx.beforeErrorCount, root });
    }
    const outcome = await applyAndVerify({ root, patchPlanRef, runtimeVerify: effectiveVerify, now: asDate(now), applyReportsDir, evolutionOutcome, evolutionLogicGate });
    // P3 幂等：同内容已 applied → 跳过重复 apply（不重复改代码），applyAndVerify 已仍跑 verify 确认当前真绿。
    if (outcome.skipped) {
      // skip 但当前 verify 失败 → 当前系统不绿（patch 在但别处坏了），绝不假绿收口：抛 needsSelfRepair。
      if (!outcome.ok) {
        throw selfEvolutionError('self_evolution_verify_failed_rolled_back_needs_self_repair', {
          needsSelfRepair: true,
          skipped: true,
          applyReportRef: outcome.priorApplyReportRef || '',
          runtimeReportRef: (outcome.verify && outcome.verify.reportRef) || '',
        });
      }
      // 回填既有 apply 证据(applyReportRef/diffRef/changedFiles/touchedFiles) + 显式 runtimeOk，让 cycle 完成门
      //   (需 implementation 证据 + runtime ok)能收口——红队 blocker：原 skip 缺证据 → cycle 卡死(半截状态)。
      const skipChanged = outcome.changedFiles || [];
      return {
        applied: true,
        skipped: true,
        reason: outcome.reason || 'already_applied',
        patchPlanRef,
        patchPlanId: outcome.patchPlanId || '',
        applyReportRef: outcome.priorApplyReportRef || '',
        diffRef: outcome.priorApplyReportRef || '',
        changedFiles: skipChanged,
        touchedFiles: skipChanged,
        runtimeReportRef: (outcome.verify && outcome.verify.reportRef) || '',
        runtimeOk: true,
        priorApplyReportRef: outcome.priorApplyReportRef || '',
        secretValuesReturned: false,
      };
    }
    if (!outcome.ok) {
      throw selfEvolutionError('self_evolution_verify_failed_rolled_back_needs_self_repair', {
        needsSelfRepair: true,
        applyReportRef: outcome.applied.reportRef,
        runtimeReportRef: (outcome.verify && outcome.verify.reportRef) || '',
        rollbackReportRef: (outcome.rolledBack && outcome.rolledBack.reportRef) || '',
        rolledBack: !!(outcome.rolledBack && outcome.rolledBack.status === 'rolled_back'),
      });
    }
    // 回填 touchedFiles + diffRef + 显式 runtimeOk，让 Trigger 组装的 cycle.implementation 过证据门(blocker:
    //   原正常路径 Trigger 只填 applyReportRef → 证据门 diffRef||evidenceRef||touchedFiles 不过 = complete=0 根因)。
    const implChanged = outcome.applied.changedFiles || [];
    return {
      applied: true,
      patchPlanRef,
      applyReportRef: outcome.applied.reportRef,
      diffRef: outcome.applied.reportRef,
      backupManifestRef: outcome.applied.backupManifestRef,
      runtimeReportRef: (outcome.verify && outcome.verify.reportRef) || '',
      runtimeOk: true,
      changedFiles: implChanged,
      touchedFiles: implChanged,
      secretValuesReturned: false,
    };
  });

  executors.set('noe.self_evolution.self_repair', async ({ act }) => {
    assertGatePassed(act);
    assertStandingGrant(evaluateGrant);
    const ctx = selfEvolutionContext(act);
    const gate = act.payload.selfEvolutionGate;
    // rollbackFirst：先还原上一轮失败的 apply（若提供了 priorApplyReportRef）。
    const priorRef = String(ctx.priorApplyReportRef || ctx.failedApplyReportRef || '').trim();
    let priorRollback = null;
    if (priorRef) {
      priorRollback = runNoePatchRollback({ root, applyReportRef: priorRef, dryRun: false, confirmOwner: true, now: asDate(now) });
    }
    const patchPlanRef = await resolvePatchPlanRef({ ctx, root, spawnImplementer, gate });
    // P3 红队 blocker 修复：self_repair 传 skipDedup:true —— 它先 rollback 上一轮失败 apply 再**重新应用**，
    //   绝不能被旧 applied 报告骗去跳过（否则文件停在 rollback 后的坏内容 + verify 0 次）。故此处不再有 skipped 分支。
    const outcome = await applyAndVerify({ root, patchPlanRef, runtimeVerify, now: asDate(now), applyReportsDir, skipDedup: true, evolutionOutcome, evolutionLogicGate });
    if (!outcome.ok) {
      throw selfEvolutionError('self_repair_failed_needs_consensus', {
        needsConsensus: true,
        priorRollbackRef: (priorRollback && priorRollback.reportRef) || '',
        applyReportRef: outcome.applied.reportRef,
        rollbackReportRef: (outcome.rolledBack && outcome.rolledBack.reportRef) || '',
        rolledBack: !!(outcome.rolledBack && outcome.rolledBack.status === 'rolled_back'),
      });
    }
    // 回填 touchedFiles + diffRef + runtimeOk，让 self_repair 成功后 Trigger 组装的 cycle 也能过证据门收口。
    const repairChanged = outcome.applied.changedFiles || [];
    return {
      repaired: true,
      patchPlanRef,
      priorRollbackRef: (priorRollback && priorRollback.reportRef) || '',
      applyReportRef: outcome.applied.reportRef,
      diffRef: outcome.applied.reportRef,
      runtimeReportRef: (outcome.verify && outcome.verify.reportRef) || '',
      runtimeOk: true,
      changedFiles: repairChanged,
      touchedFiles: repairChanged,
      secretValuesReturned: false,
    };
  });

  executors.set('noe.self_evolution.memory_writeback', async ({ act }) => {
    assertGatePassed(act);
    const ctx = selfEvolutionContext(act);
    const mw = (ctx.memoryWriteback && typeof ctx.memoryWriteback === 'object') ? ctx.memoryWriteback : {};
    // 只取 summary 文本，脱敏后写；绝不读/写 diff/secret。
    const summary = clean(mw.summary || ctx.summary || '', 4000);
    if (!summary) throw selfEvolutionError('self_evolution_memory_summary_required');
    const written = typeof memoryWrite === 'function'
      ? memoryWrite({ body: summary, scope: 'fact', sourceType: 'self_evolution', title: clean(ctx.objective || 'self-evolution', 120) })
      : null;
    // 防假绿（多模型审）：memoryWrite 是函数却返回 falsy = 记忆没真写进持久层 → 抛错让 act 走失败分支、cycle 绝不
    //   advance 到 complete（否则「complete 了但记忆没写」= 假绿、complete 虚高）。memoryWrite 未注入（非函数）= 测试/
    //   未通电场景，保持旧 no-op（不抛）。
    if (typeof memoryWrite === 'function' && !written) {
      throw selfEvolutionError('self_evolution_memory_write_failed');
    }
    // 落「脱敏 summary」到 artifact 并返回 summaryRef —— cycle 完成完整校验要求 memoryWriteback.summaryRef
    //   (NoeSelfEvolutionCycle.cycle_memory_summary_ref_required)，缺则 advance 到 complete 被 upsert 完整校验拒、
    //   cycle 永不收口、DB complete=0。summary 已 clean()(redactSensitiveText) 脱敏，绝不含 diff/secret。
    const date = asDate(now);
    const summaryRef = `${SELF_EVOLUTION_OUTPUT_DIR}/memory-writeback/${stampOf(date)}-${randomUUID().slice(0, 8)}.md`;
    let summaryWritten = false;
    try {
      const file = resolve(root, summaryRef);
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, `# 自我进化记忆回写 summary\n\n${summary}\n`, { mode: 0o600 });
      try { chmodSync(file, 0o600); } catch { /* best-effort */ }
      summaryWritten = true;
    } catch { /* 落盘失败不阻断：仍返回 summaryRef（cycle 层 requireFile=false 只校验非空文本），summaryWritten=false 留痕 */ }
    return { written: !!written, memoryId: (written && written.id) || '', summaryRef, summaryWritten, secretValuesReturned: false };
  });

  executors.set('noe.self_evolution.complete', async ({ act }) => {
    assertGatePassed(act);
    const ctx = selfEvolutionContext(act);
    const refs = {
      applyReportRef: clean(ctx.applyReportRef || '', 500),
      runtimeReportRef: clean(ctx.runtimeReportRef || '', 500),
      memoryId: clean(ctx.memoryId || '', 200),
      retrospectiveRef: clean(ctx.retrospectiveRef || (ctx.retrospective && ctx.retrospective.ref) || '', 500),
    };
    let eventId = null;
    if (typeof appendEvent === 'function') {
      eventId = appendEvent({
        kind: 'noe_self_evolution_completed',
        ts: Date.now(),
        tag: 'noe.self_evolution.completed',
        entityType: 'noe_act',
        entityId: act.id,
        projectId: act.projectId || 'noe',
        action: act.action,
        refs,
        secretValuesReturned: false,
      });
    }
    return { completed: true, eventId, refs, secretValuesReturned: false };
  });

  return executors;
}

const IMPLEMENTER_SYSTEM = [
  'You are Noe\'s self-evolution implementer.',
  'Output ONLY a JSON object of kind "noe_patch_plan" with an "operations" array — no prose.',
  'For a small or precise change, prefer { "id", "op": "replace", "path": "<repo-relative path>", "from": "<exact existing snippet, occurring exactly once in the file, copied verbatim with indentation>", "to": "<replacement text>" }.',
  'For a brand-new file or a full rewrite, use { "id", "op": "write_file", "path": "<repo-relative path>", "content": "<full file content>" }.',
  'Never include secrets, tokens, API keys or .env content. Never target .git, node_modules or games/cartoon-apocalypse.',
  // 补测试约定（实测教训：M3 默认用 node:test + test/ 单数 → vitest 不收录 → 假性 complete）。明确项目约定堵这个。
  'When ADDING TESTS: this project runs Vitest, NOT node:test. Import helpers from "vitest" (e.g. `import { describe, it, expect } from \'vitest\'`); never import from "node:test" or "node:assert".',
  'New test files MUST be placed under the "tests/" directory (plural), e.g. tests/unit/<kebab-name>.test.js — files under "test/" (singular) or any other directory are NOT picked up by Vitest and will be rejected.',
  // 治 protected 测试文件 preflight(2026-07-01)：改现有测试被 PolicyFileGuard 拦(防假绿)，新建测试默认也禁(需 NOE_ALLOW_NEW_TEST_FILES)。
  //   引导 logic_changed 聚焦 src 逻辑、别碰测试文件，避开 preflight_blocked；测试留人补。
  'Do NOT modify EXISTING test files — they are protected against false-green tampering and any patch targeting one will be rejected by preflight. For a logic_changed direction, focus the patch on the target src file\'s own logic; leave test coverage to be added separately.',
  // 治飞轮偶发跑偏(2026-07-01)：实测飞轮曾新建 src/noe-structured-call.js(重复已有 runtime/NoeStructuredCall.js、没接生产的孤儿)
  //   + 空壳测试(断言两字符串常量不等永真)。明确禁止：优先改目标文件现有代码，别新建重复模块，别写无意义占位测试。
  'Prefer editing the EXISTING code of the target file (op:replace) over creating new files. Do NOT create a new standalone module that duplicates functionality already present elsewhere in the repo (that produces orphan dead code). Do NOT write placeholder/empty tests that merely assert trivial constants (e.g. that two different string literals are not equal) — such changes have no real value and count as drift.',
  'Keep the change minimal and verifiable by `npm test`.',
].join(' ');

/**
 * 生产实施者：route → 选 code adapter（Codex）→ chat 出 noe_patch_plan → 校验 → 写 patch-plan.json。
 * 注入式（getAdapter/route），不设硬超时（跑模型纪律）。
 */
// rank7：patch plan 的 JSON Schema（json_schema 档约束 codex 输出；不支持的 adapter 降级 json_object/text）。
const NOE_PATCH_PLAN_JSON_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    kind: { type: 'string' },
    operations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, op: { type: 'string' }, path: { type: 'string' }, content: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } },
        required: ['op', 'path'],
      },
    },
  },
  required: ['operations'],
});

// 为 implementer 附目标文件真实内容：本地模型 chat 无文件访问、会凭想象编 from（实测 hallucinate 出文件里
//   不存在的 pattern 致 apply blocked）；把 objective 提到的源文件逐字附进 prompt，让 codex/本地模型据真实
//   代码出准 from，杜绝编造。objective 含「path:line」且 line 靠后(>maxLines)时按目标行附近窗口取（治死板前
//   maxLines 截断看不到靠后函数→编 from→apply patch_replace_from_not_found；路 2 真信号实测坐实
//   NoeActionCatalog.js:268 在 160 行外被漏）；无 line/靠前则前 maxLines（逐字现状 fallback）。
//   DI（fsRead/fileExists）便于单测，export 供测试。
export function readTargetFileContext(objective, root, { maxFiles = 2, maxLines = 160, windowBefore = 20, windowAfter = 160, fsRead = readFileSync, fileExists = existsSync } = {}) {
  const rootAbs = resolve(root);
  // 匹配 path，后可带 ":75" 或 ":75,208,283"（聚合·同文件多函数一次取覆盖窗口）：组 1=path、组 2=逗号分隔行号。
  const matches = [...String(objective).matchAll(/((?:src|tests|docs|scripts)\/[\w/.-]+\.\w+)(?::(\d+(?:,\d+)*))?/g)];
  const byPath = new Map();
  for (const m of matches) {
    if (!byPath.has(m[1]) && byPath.size >= maxFiles) continue; // 限文件数
    const lines = byPath.get(m[1]) || [];
    if (m[2]) for (const n of m[2].split(',')) { const v = Number(n); if (Number.isFinite(v) && v > 0) lines.push(v); }
    byPath.set(m[1], lines);
  }
  const parts = [];
  for (const [p, lines] of byPath) {
    try {
      const abs = resolve(rootAbs, p);
      if (abs !== rootAbs && !abs.startsWith(`${rootAbs}/`)) continue; // 沙箱
      if (!fileExists(abs)) continue;
      const allLines = fsRead(abs, 'utf8').split('\n');
      const maxL = lines.length ? Math.max(...lines) : 0;
      const minL = lines.length ? Math.min(...lines) : 0;
      if (maxL > maxLines && maxL <= allLines.length) {
        // 目标行靠后/多行（聚合）：取覆盖所有目标行的窗口（min-windowBefore 到 max+windowAfter），治前 maxLines 截断漏看。
        const from = Math.max(0, minL - 1 - windowBefore);
        const slice = allLines.slice(from, maxL - 1 + windowAfter);
        parts.push(`--- ${p}（第 ${from + 1}-${from + slice.length} 行，目标行 ${lines.join(',')}）---\n${slice.join('\n')}`);
      } else {
        const slice = allLines.slice(0, maxLines);
        parts.push(`--- ${p}（前 ${slice.length} 行）---\n${slice.join('\n')}`);
      }
    } catch { /* 单文件读失败不阻断 */ }
  }
  return parts.join('\n\n');
}

export function makeNoeSelfEvolutionImplementer({ getAdapter, route, root = process.cwd(), now = () => new Date(), structuredCall = noeStructuredCall, localFirst = false } = {}) {
  return async function spawnImplementer({ objective = '', targetFile = '', root: callRoot = root } = {}) {
    if (typeof route !== 'function' || typeof getAdapter !== 'function') {
      throw selfEvolutionError('self_evolution_implementer_not_wired');
    }
    const obj = clean(objective, 1000);
    const tf = clean(targetFile, 200);
    const decision = route({ text: `self-evolution implementation: ${obj}`, requiresTools: true }) || {};
    // 附目标文件真实内容（让 implementer 据真实代码出准 from，治本地模型编造 from）。
    // 根因修复(2026-07-01)：self_directed 方向的 objective 只有模块名(如"CircuitBreaker")、无 src/ 完整路径，
    //   readTargetFileContext 正则匹配不到 → fileContext 空 → minimax 猜路径 → patch_replace_file_missing → dropped。
    //   透传的真实 targetFile(完整路径)拼进，让正则匹配到真实文件、读到真实内容；无 targetFile 时逐字回退现状(零回归)。
    const fileContext = readTargetFileContext(tf ? `${tf}\n${obj}` : obj, callRoot);
    const targetLine = tf ? `\n目标文件（patch operations 的 path 必须逐字用这个真实路径，勿猜勿缩写）：${tf}` : '';
    const userContent = fileContext
      ? `Objective: ${obj}${targetLine}\n\n目标文件的真实当前内容（"from" 必须从下面逐字复制，严禁编造文件里不存在的片段）：\n${fileContext}\n\nProduce the noe_patch_plan now.`
      : `Objective: ${obj}${targetLine}\nProduce the noe_patch_plan now.`;
    // codex 失败（网络 error 61 / no_patch_plan）→ 降级本地 lmstudio（localhost 绕外网，据 fileContext 出准）。
    //   不设硬超时（跑模型纪律：一次运行多久不可预测）；三档结构化降级在 noeStructuredCall 内。
    // #26 本地优先（localFirst，server 按 flag NOE_SELFEVO_LOCAL_FIRST 注入）：本地 lmstudio 先试（不会 token 失效、
    //   localhost 不卡 401 认证循环——消除 codex 单点：codex token revoked 时 codex exec 卡 401 重试致 selfEvolve tick 卡
    //   running 几小时致飞轮停摆），codex 降为可选兜底；默认 OFF=现状（route 选的优先，codex 先）逐字零回归。两向都留 fallback。
    const candidateIds = localFirst
      ? [...new Set(['lmstudio', decision.adapterId].filter(Boolean))]
      : [...new Set([decision.adapterId, 'lmstudio'].filter(Boolean))];
    // codex 失败（网络 error 61 / 空回 / no_patch_plan）→ 每 adapter 先重试 K 次（治 API 429/超时/瞬时空回），
    //   仍不出再降级下一 candidate（lmstudio localhost 绕外网兜底）。硬网络断（error 61）重试无益但成本低；
    //   真正韧性来自降级。不设硬超时（跑模型纪律）。
    const MAX_ATTEMPTS_PER_ADAPTER = 2;
    // 「可用 patch」必须有非空 operations 数组——codex 空回 {operations:[]} 被 extractNoePatchPlan 当 patch 返回，
    //   会让 spawnImplementer 误判成功、跳过降级 lmstudio（红队实锤）；空 plan 随后必在 apply 因 patch_operations_required
    //   失败、白费一轮。要求非空才接受，否则继续重试 / 降级。
    const isUsablePatchPlan = (p) => !!(p && Array.isArray(p.operations) && p.operations.length > 0);
    let result = null;
    let patchPlan = null;
    let usedAdapterId = '';
    // P1 可观测（修「fail-report 只记 routed adapter」黑洞）：逐候选记真实尝试——id/尝试次数/是否出可用patch/
    //   operations 长度/末次错。让"lmstudio 兜底到底试没试、返回了什么"可见（先诊断后修：实测 42 报告 80 次 codex error61）。
    const attemptedCandidates = [];
    // 硬网络断（连接被拒/host 不存在）重试无益：跳出该候选重试、更快降级（治"codex 挂了还猛捶"）。
    //   多模型 review 收窄：原含 timeout/EAI_AGAIN/socket hang up 会误杀本可重试的瞬时故障——只保留确凿"端点不可达"。
    const HARD_NET_RE = /\berror 61\b|ECONNREFUSED|ENOTFOUND/i;
    for (const aid of candidateIds) {
      const adapter = getAdapter(aid);
      if (!adapter || typeof adapter.chat !== 'function') {
        attemptedCandidates.push({ id: aid, ok: false, attempts: 0, operationsLen: 0, error: 'adapter_unavailable' });
        continue;
      }
      let candPlan = null;
      let candAttempts = 0;
      let candError = '';
      for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_ADAPTER; attempt += 1) {
        candAttempts += 1;
        try {
          result = await structuredCall({
            adapter,
            messages: [
              { role: 'system', content: IMPLEMENTER_SYSTEM },
              { role: 'user', content: userContent },
            ],
            jsonSchema: NOE_PATCH_PLAN_JSON_SCHEMA,
            opts: { disableMcp: true, budgetContext: { projectId: 'noe', taskId: 'noe-self-evolution-implementer' } },
            name: 'noe_patch_plan',
          });
        } catch (e) { result = { ok: false, error: e?.message || String(e) }; }
        if (result && result.ok) {
          const p = extractNoePatchPlan(result.value);
          if (isUsablePatchPlan(p)) { candPlan = p; candError = ''; break; } // 出可用 patch（operations 非空）即停
          // ok 但 operations 空/形状不对 = 静默失败：必须留明确因（多模型 review：别让"兜底试了却没救场"再隐形）。
          candPlan = null;
          candError = 'non_usable_patch_plan';
        } else {
          candPlan = null;
          candError = redactSensitiveText(String((result && result.error) || 'unknown_error').slice(0, 300));
          if (HARD_NET_RE.test(String((result && result.error) || ''))) break; // 硬网络错不重试
        }
      }
      attemptedCandidates.push({
        id: aid,
        ok: isUsablePatchPlan(candPlan),
        attempts: candAttempts,
        operationsLen: (candPlan && Array.isArray(candPlan.operations)) ? candPlan.operations.length : 0,
        error: candError,
      });
      if (isUsablePatchPlan(candPlan)) { usedAdapterId = aid; patchPlan = candPlan; break; }
    }
    if (!result) {
      throw selfEvolutionError('self_evolution_implementer_no_adapter', { adapterId: candidateIds.join(',') || '' });
    }
    if (!patchPlan) {
      // P0-1 诊断落地：codex 出 patch 失败时落原始诊断（tier/error/codex 原文脱敏），不再黑盒抛错。
      //   下次失败可据此定位是 codex 没出 operations / route 没选 code adapter / 形状不匹配 / adapter 空回。
      let diagRef = '';
      try {
        const dref = `${SELF_EVOLUTION_OUTPUT_DIR}/implementer-fail/${stampOf(asDate(now))}-${randomUUID().slice(0, 8)}.json`;
        const dfile = resolve(resolve(callRoot), dref);
        mkdirSync(dirname(dfile), { recursive: true, mode: 0o700 });
        writeFileSync(dfile, `${JSON.stringify({
          kind: 'noe_self_evolution_implementer_fail',
          at: asDate(now).toISOString(),
          objective: obj,
          routedAdapterId: decision.adapterId || '', // route 选的（≠ 实际尝试序列；旧版只记这个=黑洞）
          attemptedCandidates, // P1：每个候选(codex/lmstudio)的真实尝试结果——定位是 codex 网络挂还是 lmstudio 也没出
          resultOk: result.ok === true,
          tier: result.tier || result.mode || '',
          error: redactSensitiveText(String(result.error || '').slice(0, 500)),
          // 多模型 review：value 为对象时 String() 会变 '[object Object]'，改 JSON.stringify 保留真实回复（如空 operations 的 patch）。
          rawReplyExcerpt: redactSensitiveText((() => {
            const v = result.value ?? result.raw ?? result.text ?? '';
            return (v && typeof v === 'object') ? JSON.stringify(v) : String(v);
          })().slice(0, 1500)),
        }, null, 2)}\n`, { mode: 0o600 });
        diagRef = dref;
      } catch { /* 诊断落盘失败不阻断主错误 */ }
      throw selfEvolutionError('self_evolution_no_patch_plan_in_reply', { diagRef });
    }
    const rootAbs = resolve(callRoot);
    const date = asDate(now);
    const ref = `${SELF_EVOLUTION_OUTPUT_DIR}/${stampOf(date)}-${randomUUID().slice(0, 8)}/patch-plan.json`;
    const file = resolve(rootAbs, ref);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const payload = {
      kind: 'noe_patch_plan',
      // P3 确定性 patchPlanId（sha256 前 24 hex，基于 objective + 规范化 operations）：同输入必同 id，供 apply 幂等去重。
      //   注意：generatedAt 等时间戳字段不参与 id，故同内容多次生成的 plan 文件 id 一致（幂等键稳定）。
      patchPlanId: noeSelfEvolutionPatchPlanId({ objective: obj, operations: patchPlan.operations }),
      generatedAt: date.toISOString(),
      objective: obj,
      adapterId: usedAdapterId || decision.adapterId || '', // 实际出 patch 的 adapter（降级时 ≠ route 选的）
      routedAdapterId: decision.adapterId || '',
      attemptedCandidates, // P1：成功路也记尝试序列（供 P3 SLO 看降级是否生效，如 codex 挂→lmstudio 救场）
      patchPlan,
      secretValuesReturned: false,
    };
    writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* best-effort */ }
    return { patchPlanRef: ref, adapterId: usedAdapterId || decision.adapterId || '' };
  };
}

function safeVerifyEnv() {
  return sanitizeNoeHostExecEnv(process.env, {
    allowlist: ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SHELL', 'NODE_ENV'],
  });
}

function defaultSpawnNpmTest(command, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd || process.cwd(),
      env: opts.env || process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c) => { stdout = (stdout + c.toString('utf8')).slice(-200_000); });
    child.stderr?.on('data', (c) => { stderr = (stderr + c.toString('utf8')).slice(-200_000); });
    child.on('error', reject);
    // 不设硬超时（跑测试纪律：测试跑多久不可预测，超时会误判失败）。
    child.on('close', (code) => resolvePromise({ exitCode: Number(code) || 0, stdout, stderr }));
  });
}

/**
 * 生产 runtime 校验（P0 堵假绿）：spawn `npm test -- --reporter=json --outputFile`（argv-style，sanitize host env，
 * 不设硬超时），**不再只信 exitCode**：交叉校验 vitest JSON 报告 numFailedTests===0 && numTotalTests>0。
 * fail-closed：报告缺失/解析失败/字段缺失 = 不可信 → ok=false，绝不回退到"只信 exitCode"（否则坏 patch 删掉报告就能假绿）。
 * 写一份脱敏 report 到 output/noe-self-evolution/runtime-verify/，返回 reportRef。
 * 注：改测试/退路/config(package.json/vitest.config/tests/**) 制造假绿，已由 NoePolicyFileGuard 在 apply 前后双道挡死，本函数不重复。
 */
export function makeNoeSelfEvolutionRuntimeVerify({ cwd = process.cwd(), spawnFn = null, now = () => new Date(), readJsonReport = null } = {}) {
  const run = typeof spawnFn === 'function' ? spawnFn : defaultSpawnNpmTest;
  // JSON 报告读取可注入（默认读 vitest 落盘的 json）；测试借此验 fail-closed，无需 mock spawn 去写文件。
  const readReport = typeof readJsonReport === 'function' ? readJsonReport : (p) => JSON.parse(readFileSync(p, 'utf8'));
  return async function runtimeVerify({ root: verifyRoot = cwd } = {}) {
    const date = asDate(now);
    // 报告落盘到临时文件（落盘而非读 stdout，规避工具输出语义化篡改层）。
    const jsonRef = `${SELF_EVOLUTION_OUTPUT_DIR}/runtime-verify/.vitest-${randomUUID().slice(0, 8)}.json`;
    const jsonPath = resolve(verifyRoot, jsonRef);
    mkdirSync(dirname(jsonPath), { recursive: true, mode: 0o700 });
    let exitCode = 1;
    let stdout = '';
    let stderr = '';
    let error = '';
    try {
      const res = await run('npm', ['test', '--', '--reporter=json', `--outputFile=${jsonPath}`], { cwd: verifyRoot, env: safeVerifyEnv() });
      const raw = Number(res && res.exitCode);
      exitCode = Number.isFinite(raw) ? raw : (res && res.exitCode === 0 ? 0 : 1);
      stdout = String((res && res.stdout) || '');
      stderr = String((res && res.stderr) || '');
    } catch (e) {
      error = clean(e && e.message ? e.message : e, 300);
    }
    // 交叉校验 vitest JSON 报告（fail-closed）。
    let numTotalTests = null;
    let numPassedTests = null;
    let numFailedTests = null;
    let reportError = '';
    let reportSaysFailure = false;
    try {
      const parsed = readReport(jsonPath);
      const rawTotal = parsed && parsed.numTotalTests;
      const rawFailed = parsed && parsed.numFailedTests;
      // 严格整数校验（多模型 review Finding2）：拒 boolean/字符串被 Number() 强转成"可信"（Number(true)=1、Number('0')=0）。
      if (typeof rawTotal === 'number' && Number.isInteger(rawTotal) && typeof rawFailed === 'number' && Number.isInteger(rawFailed)) {
        numTotalTests = rawTotal;
        numFailedTests = rawFailed;
        numPassedTests = (typeof parsed.numPassedTests === 'number' && Number.isInteger(parsed.numPassedTests)) ? parsed.numPassedTests : null;
        // vitest 自身的成功判定（多模型 review 遗漏3）：success===false 直接不信，不只赖 failed 计数。
        if (parsed.success === false) reportSaysFailure = true;
      } else {
        reportError = 'report_fields_invalid';
      }
    } catch (e) {
      reportError = clean(e && e.message ? e.message : 'report_read_failed', 200);
    } finally {
      try { unlinkSync(jsonPath); } catch { /* best-effort 清理临时报告 */ }
    }
    // 报告可信判据：报告 + 0 失败 + 真跑≥1 测试 + vitest 未自报失败（堵 exitCode0但JSON有失败 / 0测试 / success=false 三形态假绿）。
    // 威胁模型注（多模型 review 遗漏2）：本校验信任 test runner（vitest/npm/PATH）完整性——对 P0 范围（Neo 自己 patch 造假绿，
    //   受 NoePolicyFileGuard 约束改不到 node_modules/PATH/test 链路）成立；更强的隔离执行环境（影子 worktree）属 P3。
    const reportTrusted = numFailedTests === 0 && typeof numTotalTests === 'number' && numTotalTests > 0 && !reportSaysFailure;
    // ok = 无 spawn 错 + exitCode 0 + 报告可信，三者缺一即 false（fail-closed）。
    const ok = error === '' && exitCode === 0 && reportTrusted;
    // P0.6 SLO v2：记真实耗时。date=跑测前，endDate=跑测后；durationMs 真实（生产 now=()=>new Date()）→
    //   NoeSelfEvolutionSlo 自动纳入 P50/P95 百分位（原产物缺 durationMs 才给 null）。这是 P4.4 自演化提速
    //   放行的前提之一（successRate/耗时可测才敢缩短 tick）。
    const endDate = asDate(now);
    const durationMs = Math.max(0, endDate.getTime() - date.getTime());
    const ref = `${SELF_EVOLUTION_OUTPUT_DIR}/runtime-verify/${stampOf(date)}-${randomUUID().slice(0, 8)}.json`;
    const file = resolve(verifyRoot, ref);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const report = {
      kind: 'noe_self_evolution_runtime_verify',
      generatedAt: date.toISOString(),
      startedAt: date.toISOString(),
      durationMs,
      command: 'npm test -- --reporter=json',
      ok,
      exitCode,
      // 交叉校验来源（供 P3 SLO 统计 + 事后审计）；reportTrusted=false 即 fail-closed 拦下。
      numTotalTests,
      numPassedTests,
      numFailedTests,
      reportTrusted,
      reportError,
      error,
      stdoutTail: clean(stdout, 4000),
      stderrTail: clean(stderr, 4000),
      secretValuesReturned: false,
    };
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* best-effort */ }
    return { ok, exitCode, reportRef: ref, error, numTotalTests, numFailedTests, reportTrusted, reportError };
  };
}
