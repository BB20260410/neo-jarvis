#!/usr/bin/env node
// @ts-check
/**
 * Append one soak sample (health, dual-writer, orphans, launchd).
 * Wall-clock soak must accumulate real samples over ≥72h — this only samples once.
 *
 *   node scripts/noe-soak-sample.mjs --log /path/to/soak-samples.jsonl
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, def = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const logPath = resolve(arg('--log', join(root, 'output/noe-soak/samples.jsonl')));
mkdirSync(dirname(logPath), { recursive: true });

const { assessDualWriterRisk } = await import(
  pathToFileURL(join(root, 'src/runtime/NoeDualWriterGuard.js')).href
);
const {
  resolveNoeLaunchdLabel,
  parseLaunchdPlistLabel,
  buildLaunchdAlignmentReport,
  isLaunchdLabelDisabledInPrint,
  NOE_CANONICAL_LAUNCHD_LABEL,
} = await import(pathToFileURL(join(root, 'src/runtime/NoeLaunchdLabel.js')).href);
const { NoeProcessRegistry, isNeoOwnedCommand } = await import(
  pathToFileURL(join(root, 'src/runtime/NoeProcessRegistry.js')).href
);

function run(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8' });
}

let health = null;
try {
  const h = run('curl', ['-sS', '-m', '3', 'http://127.0.0.1:51835/health']);
  health = JSON.parse(h.stdout || '{}');
} catch {
  health = { ok: false };
}

const dbPath = join(homedir(), '.noe-panel/panel.db');
let processes = [];
try {
  const out = run('lsof', ['-nP', dbPath]).stdout || '';
  const pids = new Set();
  for (const line of out.split('\n').slice(1)) {
    if (!line.trim()) continue;
    const pid = line.trim().split(/\s+/)[1];
    if (pid) pids.add(pid);
  }
  processes = [...pids].map((pid) => ({ pid, openFiles: [dbPath], cmd: 'node' }));
} catch { /* ignore */ }
const dual = assessDualWriterRisk({ dbPath, processes });

const uid = String(typeof process.getuid === 'function' ? process.getuid() : run('id', ['-u']).stdout.trim());
const plistPath = join(homedir(), 'Library/LaunchAgents', `${NOE_CANONICAL_LAUNCHD_LABEL}.plist`);
let installedLabel = null;
try {
  if (existsSync(plistPath)) {
    installedLabel = parseLaunchdPlistLabel(readFileSync(plistPath, 'utf8'));
  }
} catch { /* ignore */ }
const list = run('launchctl', ['list']).stdout || '';
const launchctlHas = list.split('\n').some((l) => l.trim().endsWith(NOE_CANONICAL_LAUNCHD_LABEL));
const disabledText = run('launchctl', ['print-disabled', `gui/${uid}`]).stdout || '';
const disabled = isLaunchdLabelDisabledInPrint(disabledText, NOE_CANONICAL_LAUNCHD_LABEL);
const resolved = resolveNoeLaunchdLabel({
  env: {},
  installedLabels: [installedLabel].filter(Boolean),
});
const launchd = buildLaunchdAlignmentReport({
  resolved,
  installedLabel,
  launchctlHasResolved: launchctlHas,
  disabled,
});

const ps = run('ps', ['-axo', 'pid=,ppid=,command=']).stdout || '';
const live = ps.split('\n').map((line) => {
  const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
  return m ? { pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] } : null;
}).filter(Boolean);
const reg = new NoeProcessRegistry({ neoRoots: [root] });
for (const p of live) {
  if (isNeoOwnedCommand(p.cmd, '', [root])) {
    reg.register({ pid: p.pid, ppid: p.ppid, cmd: p.cmd, kind: 'live_scan' });
  }
}
const orphans = reg.reconcile(live);

const sample = {
  at: new Date().toISOString(),
  healthOk: health?.ok === true,
  health,
  dualWriterOk: dual.dualWriter === false,
  dualWriter: dual.dualWriter === true,
  dualPids: dual.pids,
  launchdOk: launchd.ok === true,
  failureOrphans: orphans.neoOwnedOrphanProcessCount,
  companions: orphans.companionCount || 0,
  listenPids: (run('lsof', ['-nP', '-iTCP:51835', '-sTCP:LISTEN', '-t']).stdout || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean),
};

appendFileSync(logPath, `${JSON.stringify(sample)}\n`);
console.log(JSON.stringify({ logPath, sample }, null, 2));
