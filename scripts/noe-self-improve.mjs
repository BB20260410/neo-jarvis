#!/usr/bin/env node
// @ts-check
// noe-self-improve — 受控自改代码的最小执行环（长期规划 M14，Darwin Gödel Machine 范式落地 v1）。
//
// DGM 三件套全保留：①沙箱验证（git worktree + 全量测试门）②实证档案（archive.jsonl 记录每次
// 提案/补丁/测试结果，成败都留——stepping stones）③不自动合并（patch 留盘，采用是显式动作）。
// v1 范围收敛到"参数与提示词级"自改：深思脑产出 {file, find, replace} 字面替换（比 unified diff
// 对本地模型可靠一个量级），文件白名单=认知层；find 必须在文件中唯一命中。
//
// 用法：node scripts/noe-self-improve.mjs --proposal "把工作区深思日预算从 12 提到 16" [--apply]
//   默认只验证+存档+留 patch；--apply 才把通过测试门的改动落到主树（仍走 git，可回滚）。
// 纪律：本地深思脑（LM Studio /v1 直调，零付费）；不设超时；全程留痕。
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { NOE_MAIN_BRAIN_MODEL, normalizeNoeAutoModel } from '../src/model/NoeLocalModelPolicy.js';
import { buildNoeEvolutionArchiveEntry, createNoeEvolutionVariantId } from '../src/room/NoeEvolutionArchive.js';

// fileURLToPath 正确解码路径里的空格（"Neo 贾维斯"）——直接用 .pathname 会留 %20 导致 ENOENT
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const HOME_DIR = join(homedir(), '.noe-panel', 'self-improve');
const ARCHIVE = join(HOME_DIR, 'archive.jsonl');
const PATCH_DIR = join(HOME_DIR, 'patches');
const LMS = process.env.NOE_LMS_URL || 'http://127.0.0.1:1234/v1';
const MODEL = normalizeNoeAutoModel(process.env.NOE_REFLECT_MODEL || NOE_MAIN_BRAIN_MODEL);

// 白名单：只许改认知层（参数/提示词所在地）；server.js/存储层/安全层绝不在内
const ALLOW = [
  'src/cognition/NoeWorkspace.js',
  'src/cognition/NoeDeliberation.js',
  'src/cognition/NoeAffectEngine.js',
  'src/cognition/NoeMemoryEcho.js',
  'src/cognition/NoeSurfacingGate.js',
  'src/cognition/NoeGoalSystem.js',
  'src/loop/InnerMonologue.js',
  'src/loop/proactiveTick.js',
];

const args = process.argv.slice(2);
function argValue(name, fallback = '') {
  const idx = args.indexOf(name);
  if (idx >= 0) return String(args[idx + 1] || fallback);
  const prefix = `${name}=`;
  const found = args.find((item) => String(item).startsWith(prefix));
  return found ? String(found).slice(prefix.length) : fallback;
}
const PROPOSAL = argValue('--proposal');
const APPLY = args.includes('--apply');
const PARENT_ID = argValue('--parent');
const HOLDOUT_REF = argValue('--holdout-ref');
const BENCHMARK_REF = argValue('--benchmark-ref');
if (!PROPOSAL) { console.error('用法：node scripts/noe-self-improve.mjs --proposal "改进描述" [--apply] [--parent variantId] [--holdout-ref output/holdout.json] [--benchmark-ref output/benchmark.json]'); process.exit(1); }

function record(entry) {
  mkdirSync(HOME_DIR, { recursive: true });
  appendFileSync(ARCHIVE, JSON.stringify(buildNoeEvolutionArchiveEntry({
    archivePath: ARCHIVE,
    proposal: PROPOSAL,
    parentId: PARENT_ID,
    holdoutRef: HOLDOUT_REF,
    benchmarkRef: BENCHMARK_REF,
    ...entry,
  })) + '\n');
}

// 按提案关键词把候选缩到最相关的 1-2 个文件（喂全文，不截断）——实机教训：8 文件大杂烩会让本地模型消化不良
function pickFiles(proposal) {
  const terms = String(proposal).toLowerCase().match(/[a-z_][a-z0-9_]{2,}/gi) || [];
  const scored = ALLOW.map((f) => {
    let s = readFileSync(join(ROOT, f), 'utf8').toLowerCase();
    const base = f.toLowerCase();
    let score = 0;
    for (const t of terms) { if (base.includes(t)) score += 5; score += Math.min(3, s.split(t).length - 1); }
    return { f, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  return (scored.length ? scored : ALLOW.map((f) => ({ f, score: 0 }))).slice(0, 2).map((x) => x.f);
}

// 行号模式（实机教训：本地模型逐字复制 find 不可靠，空白/缩进必错；让它输出"改哪几行"可靠得多）
async function askBrain(proposal) {
  const files = pickFiles(proposal);
  console.log(`[self-improve] 聚焦文件：${files.join(', ')}`);
  const srcBlock = files.map((f) => {
    try {
      const numbered = readFileSync(join(ROOT, f), 'utf8').split('\n').map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join('\n');
      return `===== ${f} =====\n${numbered}`;
    } catch { return ''; }
  }).join('\n\n').slice(0, 55000);
  const res = await fetch(`${LMS}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: '你是 Noe 的自我改进执行器。把改进提案翻译成最小改动。源码每行前面有「行号|」。只输出 JSON：{"file":"相对路径","startLine":N,"endLine":M,"replace":"替换 startLine 到 endLine（含两端）这几行的新内容，不要带行号前缀","why":"一句话理由"}。改动越小越好，通常 1-3 行。提案无法用这些文件实现就输出 {"none":true,"why":"..."}。' },
        { role: 'user', content: `提案：${proposal}\n\n带行号的源码：\n\n${srcBlock}` },
      ],
    }),
  });
  const j = await res.json();
  const raw = String(j?.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('深思脑未输出 JSON');
  return JSON.parse(m[0]);
}

function sh(cmd, opts = {}) { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }); }

async function main() {
  console.log(`[self-improve] 提案：${PROPOSAL}`);
  const plan = await askBrain(PROPOSAL);
  if (plan.none) { console.log(`[self-improve] 深思脑判定不可改：${plan.why || ''}`); record({ proposal: PROPOSAL, verdict: 'brain_declined', why: plan.why }); return; }
  if (!ALLOW.includes(plan.file)) { console.log(`[self-improve] ❌ 拒绝：${plan.file} 不在白名单`); record({ proposal: PROPOSAL, verdict: 'file_not_allowed', plan }); return; }
  const target = join(ROOT, plan.file);
  const src = readFileSync(target, 'utf8');
  const lines = src.split('\n');
  const a = Number(plan.startLine); const b = Number(plan.endLine);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a || b > lines.length) {
    console.log(`[self-improve] ❌ 行号区间非法：${plan.startLine}-${plan.endLine}（文件 ${lines.length} 行）`);
    record({ proposal: PROPOSAL, verdict: 'bad_line_range', plan: { file: plan.file, startLine: plan.startLine, endLine: plan.endLine } });
    return;
  }
  const before = lines.slice(0, a - 1);
  const after = lines.slice(b);
  const newContent = [...before, ...String(plan.replace).split('\n'), ...after].join('\n');
  console.log(`[self-improve] 改动 ${plan.file}:${a}-${b}（原 ${b - a + 1} 行 → 新 ${String(plan.replace).split('\n').length} 行）：${plan.why || ''}`);
  console.log(`  - 原: ${lines.slice(a - 1, b).join(' / ').slice(0, 100)}`);
  console.log(`  + 新: ${String(plan.replace).replace(/\n/g, ' / ').slice(0, 100)}`);

  // 沙箱：worktree + node_modules 软链 + 应用替换 + 语法 + 全量测试门
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const wt = join(HOME_DIR, `wt-${ts}`);
  mkdirSync(HOME_DIR, { recursive: true });
  console.log('[self-improve] 建沙箱 worktree…');
  sh(`git -C "${ROOT}" worktree add --detach "${wt}" HEAD`);
  try {
    symlinkSync(join(ROOT, 'node_modules'), join(wt, 'node_modules'));
    writeFileSync(join(wt, plan.file), newContent);
    sh(`node --check "${join(wt, plan.file)}"`);
    console.log('[self-improve] 沙箱全量测试（pre-push 同款门）…');
    const t = spawnSync('node', ['scripts/ensure-node22.mjs', '--require-22', '--exec', 'node_modules/vitest/vitest.mjs', 'run'], { cwd: wt, encoding: 'utf8' });
    const passed = t.status === 0;
    const diff = sh(`git -C "${wt}" diff`);
    mkdirSync(PATCH_DIR, { recursive: true });
    const patchFile = join(PATCH_DIR, `${ts}.diff`);
    writeFileSync(patchFile, `# 提案：${PROPOSAL}\n# 理由：${plan.why || ''}\n# 测试门：${passed ? 'PASS' : 'FAIL'}\n${diff}`);
    const variantId = createNoeEvolutionVariantId({ ts: Date.now(), proposal: PROPOSAL, plan, patchFile });
    record({ verdict: passed ? 'tests_passed' : 'tests_failed', plan: { file: plan.file, why: plan.why, startLine: plan.startLine, endLine: plan.endLine }, patchFile, applied: false, variantId });
    console.log(`[self-improve] 测试门：${passed ? '✅ PASS' : '❌ FAIL'} · patch → ${patchFile}`);
    if (passed && APPLY) {
      writeFileSync(target, newContent);
      record({ verdict: 'applied', plan: { file: plan.file, why: plan.why, startLine: plan.startLine, endLine: plan.endLine }, patchFile, variantId });
      console.log(`[self-improve] ✅ 已应用到主树：${plan.file}（git 可回滚；commit 由调用方决定）`);
    } else if (passed) {
      console.log('[self-improve] 未应用（受控默认）。复核 patch 后用 --apply 或手动 git apply。');
    }
  } finally {
    try { sh(`git -C "${ROOT}" worktree remove --force "${wt}"`); } catch { try { rmSync(wt, { recursive: true, force: true }); } catch { /* 残留人工清 */ } }
  }
}

main().catch((e) => { console.error('[self-improve] ❌', e?.message || e); record({ proposal: PROPOSAL, verdict: 'error', error: String(e?.message || e) }); process.exit(1); });
