#!/usr/bin/env node
// @ts-check
/**
 * Precise Neo-owned orphan cleanup planner (default dry-run).
 * Never mass-kills node PPID=1. Only neo-owned patterns under neo roots.
 *
 *   node scripts/noe-orphan-precise-cleanup.mjs [--apply] [--limit N]
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const { NoeProcessRegistry, isNeoOwnedCommand } = await import(
  pathToFileURL(join(root, 'src/runtime/NoeProcessRegistry.js')).href
);

function parseArgs(argv) {
  const out = { apply: false, limit: 50, onlyMcpSafe: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--apply') out.apply = true;
    else if (argv[i] === '--limit') out.limit = Number(argv[++i] || 50);
    else if (argv[i] === '--only-mcp-safe-server') out.onlyMcpSafe = true;
  }
  return out;
}

const args = parseArgs(process.argv);
const apply = args.apply && process.env.NOE_ORPHAN_CLEANUP_APPLY === '1';

const ps = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
if (ps.status !== 0) {
  console.error('ps failed');
  process.exit(2);
}
const live = ps.stdout.split('\n').map((line) => {
  const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
  if (!m) return null;
  return { pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] };
}).filter(Boolean);

const reg = new NoeProcessRegistry({ neoRoots: [root] });
for (const p of live) {
  if (isNeoOwnedCommand(p.cmd, '', [root])) {
    reg.register({ pid: p.pid, ppid: p.ppid, cmd: p.cmd, kind: 'live_scan' });
  }
}
const report = reg.reconcile(live);
const plan = reg.planPreciseCleanup(report);
let candidates = plan.targets;
if (args.onlyMcpSafe) {
  candidates = candidates.filter((t) => /noe-chrome-devtools-mcp-safe-server/i.test(String(t.cmd || '')));
}
const targets = candidates.slice(0, Math.max(0, args.limit));

const results = [];
if (apply) {
  for (const t of targets) {
    // never kill live panel server.js / ensure-node22 / npm start:noe
    if (/server\.js|ensure-node22|start:noe/i.test(t.cmd || '') && !/mcp-safe-server|devtools-mcp/i.test(t.cmd || '')) {
      results.push({ pid: t.pid, action: 'skipped_panel_like', cmd: String(t.cmd || '').slice(0, 160) });
      continue;
    }
    if (args.onlyMcpSafe && !/noe-chrome-devtools-mcp-safe-server/i.test(String(t.cmd || ''))) {
      results.push({ pid: t.pid, action: 'skipped_not_mcp_safe', cmd: String(t.cmd || '').slice(0, 160) });
      continue;
    }
    const r = spawnSync('kill', ['-TERM', String(t.pid)], { encoding: 'utf8' });
    results.push({
      pid: t.pid,
      action: r.status === 0 ? 'sigterm' : 'kill_failed',
      stderr: (r.stderr || '').slice(0, 200),
      cmd: String(t.cmd || '').slice(0, 160),
    });
  }
}

const out = {
  dryRun: !apply,
  requireEnv: 'NOE_ORPHAN_CLEANUP_APPLY=1 with --apply',
  neoOwnedOrphanProcessCount: report.neoOwnedOrphanProcessCount,
  plannedTargets: targets.length,
  totalCandidates: plan.targets.length,
  sample: targets.slice(0, 10),
  results,
  rejected: plan.rejected,
  at: new Date().toISOString(),
};

const outPath = process.env.NOE_ORPHAN_REPORT_PATH
  || resolve(root, 'output/noe-orphan-cleanup-plan.json');
try {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
} catch {
  // ignore write failure
}
console.log(JSON.stringify(out, null, 2));
process.exit(0);
