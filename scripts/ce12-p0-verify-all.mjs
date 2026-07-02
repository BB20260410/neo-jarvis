#!/usr/bin/env node
// CE12 P0 一键证据聚合器（FR-P0-6 交付证据闭环的可验收切片）。
//
// 目的：把分散在 7 条命令里的 P0 验证收敛为「一条命令 + 单一退出码」。
// 设计：本脚本只做编排（spawnSync 子进程），自身不 import 任何走 better-sqlite3
//   的模块；所有 ABI 相关子任务都经 scripts/ensure-node22.mjs --require-22 --exec
//   re-exec 到 Node 22.22.2(ABI 127)，因此本脚本可安全地在 Node 26 下直接运行。
//
// 用法：
//   node scripts/ce12-p0-verify-all.mjs            # 跑全部 7 个门
//   node scripts/ce12-p0-verify-all.mjs --fast     # 跳过较重的浏览器 e2e 和 Electron smoke
//   node scripts/ce12-p0-verify-all.mjs --skip-e2e # 跳过较重的浏览器 e2e
//   node scripts/ce12-p0-verify-all.mjs --skip-integration # 跳过受管 server API 集成测试
//   node scripts/ce12-p0-verify-all.mjs --skip-electron --skip-e2e
//   node scripts/ce12-p0-verify-all.mjs --json     # 仅输出汇总 JSON
//
// 退出码：全部门通过 → 0；任意门失败 → 1。

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'output', 'ce12-p0');
const GATE = join('scripts', 'ensure-node22.mjs');

const args = new Set(process.argv.slice(2));
const SKIP_E2E = args.has('--skip-e2e') || args.has('--fast');
const SKIP_ELECTRON = args.has('--skip-electron') || args.has('--fast');
const SKIP_INTEGRATION = args.has('--skip-integration');
const JSON_ONLY = args.has('--json');
const PROFILE = !SKIP_E2E && !SKIP_ELECTRON && !SKIP_INTEGRATION
  ? 'full'
  : (SKIP_E2E && SKIP_ELECTRON && !SKIP_INTEGRATION ? 'fast' : 'partial');

function log(...a) { if (!JSON_ONLY) console.log(...a); }

function run(cmd, cmdArgs) {
  const res = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 360_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env },
  });
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  return { code: res.status, signal: res.signal, stdout, stderr, error: res.error?.message || null };
}

// 每个 step: { id, requirement, title, run() -> {ok, code, marker, detail} }
const steps = [];

// FR-P0-* 需求 canonical verify（纯文本校验，不碰 DB，可用任意 node）
steps.push({
  id: 'requirements_verify',
  requirement: 'FR-P0-1..7',
  title: '需求 canonical 60 项一致性',
  enabled: true,
  exec() {
    const r = run('node', ['NOE_CE12_P0_REQUIREMENTS_VERIFY.mjs']);
    const m = (r.stdout.match(/Result:\s*(\d+)\/(\d+)\s*checks passed/) || []);
    const ok = r.code === 0 && m[1] && m[1] === m[2];
    return { ok, code: r.code, marker: m[0] || '(no result line)', detail: r.stderr.trim().slice(0, 300) };
  },
});

// FR-P0-1 Node22 gate：--require-22 应选中 v22.22.2(ABI127)
steps.push({
  id: 'node22_gate',
  requirement: 'FR-P0-1',
  title: 'Node22 fail-fast / re-exec gate',
  enabled: true,
  exec() {
    const r = run('node', [GATE, '--require-22', '--json']);
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch { /* ignore */ }
    const sel = parsed?.selected || {};
    const ok = r.code === 0 && parsed?.ok === true && Number(sel.major) === 22 && String(sel.modules) === '127';
    return { ok, code: r.code, marker: `mode=${parsed?.mode} selected=${sel.version} ABI${sel.modules}`, detail: parsed?.nvmrc ? `nvmrc=${parsed.nvmrc}` : '' };
  },
});

// FR-P0-1/4/7 P0 单测（经 gate re-exec 到 Node22 跑 vitest）
steps.push({
  id: 'p0_unit_tests',
  requirement: 'FR-P0-1/4/7',
  title: 'P0 单元测试（Node22 gate + Act Pipeline + MiniMaxSpawnAdapter + routes）',
  enabled: true,
  exec() {
    const files = [
      'tests/unit/node22-gate.test.js',
      'tests/unit/node-runtime-gate.test.js',
      'tests/unit/noe-act-pipeline.test.js',
      'tests/unit/noe-act-pipeline-safety.test.js',
      'tests/unit/noe-act-pipeline-failure-branches.test.js',
      'tests/unit/minimax-spawn-adapter.test.js',
      'tests/unit/minimax-suggestion-router.test.js',
      'tests/unit/minimax-suggestion-pipeline.test.js',
      'tests/unit/noe-file-index.test.js',
      'tests/unit/noe-memory-m1.test.js',
      'tests/unit/routes/noe-routes.test.js',
      'tests/unit/routes/noe-act-routes-status.test.js',
      'tests/unit/routes/noe-m3-file-routes.test.js',
    ].filter((f) => existsSync(join(ROOT, f)));
    const r = run('node', [GATE, '--require-22', '--exec', 'node_modules/vitest/vitest.mjs', 'run', ...files]);
    const m = r.stdout.match(/Tests\s+(\d+)\s+passed\s+\((\d+)\)/);
    const failed = /Tests\s+\d+\s+failed|FAIL\s/.test(r.stdout);
    const ok = r.code === 0 && !failed && !!m;
    return { ok, code: r.code, marker: m ? `${m[1]}/${m[2]} tests passed` : '(no test summary)', detail: `files=${files.length}` };
  },
});

// FR-P0-4 Act Pipeline 运行时证据（三条终态 + noRealExecution）
steps.push({
  id: 'act_pipeline_evidence',
  requirement: 'FR-P0-4',
  title: 'Act Pipeline 运行时证据（dry-run / approval / blocked_safety）',
  enabled: true,
  exec() {
    const r = run('node', [GATE, '--require-22', '--exec', 'scripts/ce12-p0-act-evidence.mjs']);
    let evid = null;
    const evidPath = join(OUT_DIR, 'act-pipeline-evidence.json');
    try { evid = JSON.parse(readFileSync(evidPath, 'utf8')); } catch { /* ignore */ }
    const ok = r.code === 0 && evid?.allPass === true && evid?.noRealExecution === true;
    return {
      ok,
      code: r.code,
      marker: evid ? `allPass=${evid.allPass} noRealExecution=${evid.noRealExecution} approvals=${evid.approvalsCreated}` : '(no evidence json)',
      detail: evid ? evid.results.map((x) => `${x.scenario}:${x.finalStatus}`).join(', ') : '',
    };
  },
});

// CE07 integration：真实 server + HTTP API + SQLite stores + approvals + safety.
steps.push({
  id: 'p0_integration',
  requirement: 'FR-P0-2/3/4/6',
  title: 'P0 集成测试（server/API/storage/ActPipeline/approval/safety）',
  enabled: !SKIP_INTEGRATION,
  exec() {
    const r = run('npm', ['run', 'test:p0:integration']);
    const out = r.stdout + r.stderr;
    const m = out.match(/Result:\s*(\d+)\/(\d+)\s*checks passed/);
    const ok = r.code === 0 && m && m[1] === m[2] && !/\[FAIL\]/.test(out);
    const reportLine = (out.match(/report=([^\n]+)/) || [])[1] || '';
    return {
      ok,
      code: r.code,
      marker: m ? `${m[0]}` : '(no integration result)',
      detail: reportLine ? `report=${reportLine}` : '',
    };
  },
});

// FR-P0-5 Electron smoke
steps.push({
  id: 'electron_smoke',
  requirement: 'FR-P0-5',
  title: 'Electron 启动/菜单/server/窗口/退出 smoke',
  enabled: !SKIP_ELECTRON,
  exec() {
    const r = run('npm', ['run', 'smoke:electron']);
    const out = r.stdout + r.stderr;
    const eventsLine = (out.match(/\[electron-smoke\] events=([^\n]+)/) || [])[1] || '';
    const required = ['app_ready', 'menu_registered', 'server_ready', 'window_loaded'];
    const hasAll = required.every((e) => eventsLine.includes(e));
    const ok = r.code === 0 && /\[electron-smoke\] PASS/.test(out) && hasAll;
    return { ok, code: r.code, marker: /PASS/.test(out) ? 'electron-smoke PASS' : 'electron-smoke FAIL', detail: `events=${eventsLine}` };
  },
});

// FR-P0-2/3 Brain UI 执行可视化 e2e（受管 server + 浏览器）
steps.push({
  id: 'brain_ui_e2e',
  requirement: 'FR-P0-2/3',
  title: 'Brain UI 执行可视化 e2e（7 个 DOM 锚点 + Act 数据流）',
  enabled: !SKIP_E2E,
  exec() {
    const r = run('npm', ['run', 'test:e2e:p0']);
    const out = r.stdout + r.stderr;
    const m = out.match(/Result:\s*(\d+)\/(\d+)\s*checks passed/);
    const noFail = !/\[FAIL\]/.test(out);
    const ok = r.code === 0 && noFail && m && m[1] === m[2];
    return { ok, code: r.code, marker: m ? `${m[0]}` : '(no e2e result)', detail: noFail ? 'no FAIL lines' : 'has FAIL lines' };
  },
});

// ---- 执行 ----
mkdirSync(OUT_DIR, { recursive: true });
const ts = Date.now();
const summary = {
  generatedBy: 'scripts/ce12-p0-verify-all.mjs',
  generatedAt: new Date(ts).toISOString(),
  ts,
  profile: PROFILE,
  runnerNode: process.version,
  runnerAbi: process.versions.modules,
  workspace: ROOT,
  skipped: { e2e: SKIP_E2E, electron: SKIP_ELECTRON, integration: SKIP_INTEGRATION },
  steps: [],
  allPass: false,
};

log(`\n=== CE12 P0 一键证据聚合 (runner ${process.version}/ABI${process.versions.modules}) ===\n`);
for (const step of steps) {
  if (!step.enabled) {
    log(`  SKIP  [${step.requirement}] ${step.title}`);
    summary.steps.push({ id: step.id, requirement: step.requirement, title: step.title, status: 'skipped' });
    continue;
  }
  const out = step.exec();
  const tag = out.ok ? 'PASS' : 'FAIL';
  log(`  ${tag}  [${step.requirement}] ${step.title}\n        ↳ exit=${out.code} ${out.marker}${out.detail ? `\n        ↳ ${out.detail}` : ''}`);
  summary.steps.push({
    id: step.id, requirement: step.requirement, title: step.title,
    status: out.ok ? 'pass' : 'fail', exitCode: out.code, marker: out.marker, detail: out.detail,
  });
}

const active = summary.steps.filter((s) => s.status !== 'skipped');
summary.allPass = active.length > 0 && active.every((s) => s.status === 'pass');

const outPath = join(OUT_DIR, `p0-verify-all-${ts}.json`);
const profileLatestPath = join(OUT_DIR, `p0-verify-all-${PROFILE}-latest.json`);
const legacyLatestPath = join(OUT_DIR, 'p0-verify-all-latest.json');
summary.evidence = {
  timestamped: outPath,
  profileLatest: profileLatestPath,
  legacyLatest: PROFILE === 'full' ? legacyLatestPath : null,
};
writeFileSync(outPath, JSON.stringify(summary, null, 2));
writeFileSync(profileLatestPath, JSON.stringify(summary, null, 2));
if (PROFILE === 'full') {
  writeFileSync(legacyLatestPath, JSON.stringify(summary, null, 2));
}

if (JSON_ONLY) {
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
} else {
  log(`\n  汇总: ${active.filter((s) => s.status === 'pass').length}/${active.length} 门通过` +
      `${summary.steps.some((s) => s.status === 'skipped') ? `（跳过 ${summary.steps.filter((s) => s.status === 'skipped').length}）` : ''}`);
  log(`  证据: ${outPath}`);
  log(`  ${PROFILE} latest: ${profileLatestPath}`);
  if (PROFILE === 'full') log(`  legacy latest: ${legacyLatestPath}`);
  log(`  结果: ${summary.allPass ? 'ALL PASS ✅' : 'HAS FAILURES ❌'}\n`);
}

process.exit(summary.allPass ? 0 : 1);
