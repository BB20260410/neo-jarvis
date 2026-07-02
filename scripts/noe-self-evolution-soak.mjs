#!/usr/bin/env node
// @ts-check
// Noe self-evolution soak / leak monitor. READ-ONLY: samples resource counters
// (node process count, target RSS, open fds, isolated-DB WAL size, TMPDIR noe
// temp files, optional local-model port conns) across rounds, then judges whether
// any counter is monotonically/linearly growing (suspected leak) and records
// self-evolution stage-duration percentiles from existing run artifacts.
// NEVER mutates code, opens REAL_APPLY, or touches secret values; defaults its DB
// target to an ISOLATED test DB, not the live 51835 panel.db. Observes flywheel
// leak stability — does not verify self-edits.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { percentileNearestRank } from '../src/loop/NoeSelfEvolutionSlo.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'output', 'noe-self-evolution-soak');
const TZ = process.env.NOE_SOAK_TZ || 'Asia/Shanghai';
// Default DB target is an ISOLATED soak DB, never the live panel.db. Override with
// --db / NOE_SOAK_DB only when pointing at another isolated copy on purpose.
const DEFAULT_SOAK_DB = process.env.NOE_SOAK_DB
  || join(homedir(), '.noe-panel', 'soak', 'panel.db');
const LIVE_DB = join(homedir(), '.noe-panel', 'panel.db');

// Pure helpers (no IO) — leak judgement / percentile / slope. Side-effect free
// so unit tests verify them directly.

/** Coerce to a finite number, else fallback. @returns {number|null} */
export function finiteOr(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * True only for a real, finite numeric value. Critically rejects null/undefined
 * and '' — Number(null)/Number('')/Number(undefined) coerce to 0/NaN, which
 * would otherwise let absent samples masquerade as zeros in the series filters.
 */
function isFiniteValue(value) {
  if (value === null || value === undefined || value === '') return false;
  const n = Number(value);
  return Number.isFinite(n);
}

/**
 * OLS slope of y vs sample index (0..n-1). Finite y only, original index kept so
 * uneven sampling still reflects position. null if < 2 points or zero variance.
 * @param {Array<number|null|undefined>} ys
 * @returns {number|null}
 */
export function linearSlope(ys) {
  if (!Array.isArray(ys)) return null;
  const pts = [];
  for (let i = 0; i < ys.length; i += 1) {
    if (isFiniteValue(ys[i])) pts.push([i, Number(ys[i])]);
  }
  if (pts.length < 2) return null;
  const n = pts.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of pts) {
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  return (n * sxy - sx * sy) / denom;
}

/**
 * Strictly-monotonic-increasing check over finite values (ignores null gaps).
 * Empty/single usable point → false (cannot establish a trend).
 * @param {Array<number|null|undefined>} ys
 */
export function isMonotonicIncreasing(ys) {
  if (!Array.isArray(ys)) return false;
  const vals = ys.filter(isFiniteValue).map(Number);
  if (vals.length < 2) return false;
  for (let i = 1; i < vals.length; i += 1) {
    if (vals[i] <= vals[i - 1]) return false;
  }
  return true;
}

/**
 * Percentile — delegates to SLO's nearest-rank implementation so soak and SLO
 * never give different P95 on the same data. Kept as a named export for callers
 * (and tests) that reference it, but it is a thin wrapper, NOT a second algorithm.
 * nearest-rank avoids fabricating interpolated values absent from the raw sample
 * (sample sizes here are tiny). p in [0,100]. Non-finite dropped. Empty → null.
 * @param {Array<number|null|undefined>} values
 * @param {number} p
 * @returns {number|null}
 */
export function percentile(values, p) {
  return percentileNearestRank(Array.isArray(values) ? values : [], p);
}

/**
 * Judge whether a metric series looks like a leak.
 * leak = strictly monotonic increasing AND OLS slope/round ≥ slopeThreshold > 0.
 * Both conditions keep jitter from tripping the flag while catching a steady
 * climb. < 2 finite points → inconclusive.
 * @param {Array<number|null|undefined>} series
 * @param {{ slopeThreshold?: number }} [opts]
 */
export function judgeLeak(series, { slopeThreshold = 0 } = {}) {
  const finite = (Array.isArray(series) ? series : []).filter(isFiniteValue).map(Number);
  const slope = linearSlope(series);
  const monotonic = isMonotonicIncreasing(series);
  if (finite.length < 2 || slope === null) {
    return {
      leak: false,
      inconclusive: true,
      monotonic,
      slope,
      samples: finite.length,
      first: finite.length ? finite[0] : null,
      last: finite.length ? finite[finite.length - 1] : null,
      delta: null,
    };
  }
  const first = finite[0];
  const last = finite[finite.length - 1];
  return {
    leak: monotonic && slope >= slopeThreshold && slope > 0,
    inconclusive: false,
    monotonic,
    slope,
    samples: finite.length,
    first,
    last,
    delta: last - first,
  };
}

/** Pull one named metric out of an array of round snapshots into a series. */
export function seriesOf(rounds, picker) {
  if (!Array.isArray(rounds)) return [];
  return rounds.map((r) => {
    try {
      const v = picker(r);
      return isFiniteValue(v) ? Number(v) : null;
    } catch {
      return null;
    }
  });
}

/**
 * Build the leak summary across all tracked metrics.
 * @param {Array<object>} rounds
 * @param {{ slopeThresholds?: Record<string,number> }} [opts]
 */
export function summarizeLeaks(rounds, { slopeThresholds = {} } = {}) {
  const metrics = {
    nodeProcessCount: (r) => r?.process?.nodeProcessCount,
    targetRssKb: (r) => r?.process?.targetRssKb,
    targetFdCount: (r) => r?.fd?.targetFdCount,
    walBytes: (r) => r?.wal?.bytes,
    tmpNoeFileCount: (r) => r?.tmp?.noeFileCount,
    modelPortConnections: (r) => r?.model?.portConnections,
  };
  // Defaults: any positive sustained climb is suspicious. We lean on the
  // STRICTLY-monotonic gate in judgeLeak to reject GC/jitter — real GC churn is
  // non-monotonic (RSS dips after collection), so it never survives the monotonic
  // check. Stacking a large RSS slope floor on top of that gate did the opposite
  // of its stated intent: it let a genuinely monotonic but slow leak (e.g. +1 KB
  // every round, never reclaimed) read as "no leak". So RSS floor is 0 too —
  // monotonic-only, same as fd/tmp/process. WAL keeps a small floor because WAL
  // legitimately grows between checkpoints (a monotonic stretch there can be
  // benign), so a slope floor still guards against false positives.
  const defaults = {
    nodeProcessCount: 0,
    targetRssKb: 0, // monotonic-only; GC noise is non-monotonic so the monotonic gate already filters it
    targetFdCount: 0,
    walBytes: 65536, // ~64 KB/round sustained climb (checkpointing should reclaim; growth between checkpoints is benign)
    tmpNoeFileCount: 0,
    modelPortConnections: 0,
  };
  const out = {};
  let suspected = 0;
  for (const [name, picker] of Object.entries(metrics)) {
    const series = seriesOf(rounds, picker);
    const threshold = Number.isFinite(Number(slopeThresholds[name]))
      ? Number(slopeThresholds[name])
      : defaults[name];
    const verdict = judgeLeak(series, { slopeThreshold: threshold });
    out[name] = { ...verdict, slopeThreshold: threshold, series };
    if (verdict.leak) suspected += 1;
  }
  return { suspected, anyLeak: suspected > 0, metrics: out };
}

/**
 * Compute stage-duration percentiles from a flat list of millisecond durations.
 * @param {Array<number|null|undefined>} durationsMs
 */
export function stageDurationPercentiles(durationsMs) {
  const finite = (Array.isArray(durationsMs) ? durationsMs : [])
    .filter(isFiniteValue)
    .map(Number)
    .filter((n) => n >= 0);
  if (finite.length === 0) {
    return { count: 0, p50: null, p95: null, p99: null, min: null, max: null, percentileMethod: 'nearest-rank' };
  }
  return {
    count: finite.length,
    p50: percentile(finite, 50),
    p95: percentile(finite, 95),
    p99: percentile(finite, 99),
    min: Math.min(...finite),
    max: Math.max(...finite),
    percentileMethod: 'nearest-rank',
  };
}

export function formatStamp(now = Date.now(), timeZone = TZ) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(now));
  const m = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${m.year}${m.month}${m.day}T${m.hour}${m.minute}${m.second}`;
}

// IO / sampling — every probe degrades to null on failure, never throws.

function rel(file, root = ROOT) {
  return relative(root, file).replace(/\\/g, '/');
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** Run a command capturing stdout; return null on any failure. */
function tryExec(cmd, argv) {
  try {
    const child = spawnSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (child.error || child.status !== 0) return null;
    return String(child.stdout || '');
  } catch {
    return null;
  }
}

/** Count node processes via pgrep, fallback to ps. null if both unavailable. */
function sampleNodeProcessCount() {
  const pg = tryExec('pgrep', ['-f', 'node']);
  if (pg !== null) {
    const n = pg.split('\n').map((s) => s.trim()).filter(Boolean).length;
    return Number.isFinite(n) ? n : null;
  }
  const ps = tryExec('ps', ['-A', '-o', 'comm=']);
  if (ps !== null) {
    return ps.split('\n').filter((l) => /node/.test(l)).length;
  }
  return null;
}

/** RSS (KB) of a pid via ps. null if unavailable / pid gone. */
function sampleRssKb(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const out = tryExec('ps', ['-o', 'rss=', '-p', String(pid)]);
  if (out === null) return null;
  const n = parseInt(out.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** Open fd count of a pid via lsof. null if lsof unavailable / no permission. */
function sampleFdCount(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const out = tryExec('lsof', ['-p', String(pid)]);
  if (out === null) return null;
  const lines = out.split('\n').filter((l) => l.trim().length > 0); // drop header below
  if (lines.length === 0) return 0;
  return /^COMMAND\s/.test(lines[0]) ? lines.length - 1 : lines.length;
}

/** Stat-only WAL size in bytes. NEVER reads content. null if absent. */
function sampleWalBytes(dbPath) {
  const wal = `${dbPath}-wal`;
  try {
    if (!existsSync(wal)) return { bytes: null, path: rel(wal), exists: false };
    const st = statSync(wal);
    return { bytes: st.size, path: rel(wal), exists: true };
  } catch {
    return { bytes: null, path: rel(wal), exists: false };
  }
}

/** Count noe-related temp entries under TMPDIR by name only (no content read). */
function sampleTmpNoeFiles(dir = tmpdir()) {
  try {
    if (!existsSync(dir)) return { noeFileCount: null, dir };
    const ents = readdirSync(dir);
    const n = ents.filter((name) => /noe|self-evolution|patch-/i.test(name)).length;
    return { noeFileCount: n, dir };
  } catch {
    return { noeFileCount: null, dir };
  }
}

/**
 * Optional: count established connections to a local-model port via lsof.
 * Returns null (not 0) when lsof unavailable so we never fabricate "no leak".
 */
function sampleModelPortConnections(port) {
  if (!Number.isInteger(port) || port <= 0) return null;
  const out = tryExec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:ESTABLISHED']);
  if (out === null) return null;
  const lines = out.split('\n').filter((l) => l.trim().length > 0);
  return /^COMMAND\s/.test(lines[0] || '') ? lines.length - 1 : lines.length;
}

/** One round of read-only sampling. */
export function sampleRound({
  pid,
  dbPath = DEFAULT_SOAK_DB,
  tmpDir = tmpdir(),
  modelPort = finiteOr(process.env.NOE_SOAK_MODEL_PORT, null),
  now = Date.now(),
} = {}) {
  const wal = sampleWalBytes(dbPath);
  const tmp = sampleTmpNoeFiles(tmpDir);
  return {
    at: new Date(now).toISOString(),
    process: {
      pid: Number.isInteger(pid) ? pid : null,
      nodeProcessCount: sampleNodeProcessCount(),
      targetRssKb: sampleRssKb(pid),
    },
    fd: { targetFdCount: sampleFdCount(pid) },
    wal: { bytes: wal.bytes, path: wal.path, exists: wal.exists, dbPath: rel(dbPath) },
    tmp: { noeFileCount: tmp.noeFileCount, dir: tmp.dir },
    model: {
      port: Number.isInteger(modelPort) ? modelPort : null,
      portConnections: sampleModelPortConnections(modelPort),
    },
  };
}

const STAGE_DURATION_NOTE_NO_SOURCE =
  '产物无 durationMs/startedAt/endedAt 字段，且单个 run-dir 内无可配对的段起止时间戳；'
  + '跨 run-dir 的 generatedAt 相邻差是不同轮次的产出间隔（非阶段耗时），故不编造；'
  + '生产者给 patch-plan/runtime-verify 补 durationMs（或 startedAt+endedAt）后自动生效。';

/**
 * Extract a real, self-contained stage duration (ms) from a single artifact —
 * NEVER cross-artifact. Accepts an explicit durationMs, or a startedAt/endedAt
 * pair within the SAME object. Returns null if no real segment is present.
 * @param {any} json
 * @returns {number|null}
 */
function durationFromArtifact(json) {
  if (!json || typeof json !== 'object') return null;
  const explicit = Number(json.durationMs ?? json.elapsedMs);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  const start = json.startedAt ? Date.parse(json.startedAt) : NaN;
  const end = json.endedAt ? Date.parse(json.endedAt) : NaN;
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return end - start;
  return null;
}

/**
 * Derive self-evolution stage durations from existing run artifacts.
 *
 * Honesty rule (mirrors NoeSelfEvolutionSlo's durationNote stance): we ONLY count
 * a duration when a single artifact carries a real self-contained segment
 * (durationMs/elapsedMs, or a startedAt+endedAt pair). We deliberately do NOT
 * diff generatedAt across run-dirs — adjacent stamps belong to different cycles
 * (possibly different days), so their gap is an inter-cycle production interval,
 * not a stage duration; emitting it would fabricate a meaningless "stage cost".
 * No real segments → empty durationsMs + null percentiles + a note (no fabrication).
 */
export function collectStageDurations({ root = ROOT } = {}) {
  const dir = join(root, 'output', 'noe-self-evolution');
  // scanned = artifacts inspected; withDuration = those carrying a real segment.
  const source = { runDirsScanned: 0, runtimeVerifyScanned: 0, withDuration: 0, basis: 'per_artifact_durationMs' };
  const durations = [];
  const collect = (json) => {
    const d = durationFromArtifact(json);
    if (d !== null) { durations.push(d); source.withDuration += 1; }
  };
  try {
    if (existsSync(dir)) {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        // timestamped cycle run dirs look like 20260621T001809-<hash>
        if (!/^\d{8}T\d{6}-/.test(ent.name)) continue;
        source.runDirsScanned += 1;
        collect(readJson(join(dir, ent.name, 'patch-plan.json')));
      }
    }
    const rvDir = join(dir, 'runtime-verify');
    if (existsSync(rvDir)) {
      for (const name of readdirSync(rvDir)) {
        if (!name.endsWith('.json')) continue;
        source.runtimeVerifyScanned += 1;
        collect(readJson(join(rvDir, name)));
      }
    }
  } catch {
    // fall through to whatever we collected
  }
  const available = durations.length > 0;
  return {
    available,
    source,
    durationsMs: durations,
    percentileMethod: 'nearest-rank',
    note: available ? '' : STAGE_DURATION_NOTE_NO_SOURCE,
    percentiles: available
      ? stageDurationPercentiles(durations)
      : { count: 0, p50: null, p95: null, p99: null, min: null, max: null },
  };
}

function parseArgs(argv) {
  const args = {
    rounds: 5,
    intervalMs: 1000,
    pid: null,
    db: DEFAULT_SOAK_DB,
    out: OUT_DIR,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[i + 1];
    if (a === '--rounds') { args.rounds = Math.max(1, parseInt(next(), 10) || args.rounds); i += 1; }
    else if (a === '--interval-ms') { args.intervalMs = Math.max(0, parseInt(next(), 10) || 0); i += 1; }
    else if (a === '--pid') { args.pid = parseInt(next(), 10) || null; i += 1; }
    else if (a === '--db') { args.db = String(next() || args.db); i += 1; }
    else if (a === '--out') { args.out = String(next() || args.out); i += 1; }
  }
  return args;
}

/** Pick a pid to monitor: explicit --pid > isolated 51999 listener > self. */
function resolvePid(explicit) {
  if (Number.isInteger(explicit) && explicit > 0) return { pid: explicit, source: 'flag' };
  // Prefer an already-running ISOLATED soak port (51999) — never the live 51835.
  const out = tryExec('lsof', ['-nP', '-iTCP:51999', '-sTCP:LISTEN', '-t']);
  if (out !== null) {
    const pid = parseInt(out.split('\n').map((s) => s.trim()).filter(Boolean)[0] || '', 10);
    if (Number.isFinite(pid) && pid > 0) return { pid, source: 'isolated_port_51999' };
  }
  return { pid: process.pid, source: 'self' };
}

function sleep(ms) {
  return new Promise((r) => { setTimeout(r, ms); });
}

export function buildSummary({ rounds, stageDurations, args, pidInfo, now = Date.now() }) {
  const leaks = summarizeLeaks(rounds);
  return {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    timeZone: TZ,
    percentileMethod: 'nearest-rank',
    policy: {
      readOnly: true,
      noCodeChanges: true,
      noRealApply: true,
      noSecretAccess: true,
      dbTargetIsolated: resolve(args.db) !== resolve(LIVE_DB),
      noTimeout: true,
    },
    config: {
      rounds: args.rounds,
      intervalMs: args.intervalMs,
      monitoredPid: pidInfo.pid,
      pidSource: pidInfo.source,
      dbPath: rel(resolve(args.db)),
      liveDbAvoided: resolve(args.db) !== resolve(LIVE_DB),
    },
    leakSummary: leaks,
    stageDurations,
    sampledRounds: rounds.length,
  };
}

export function writeReport(report, { outDir = OUT_DIR, root = ROOT, now = Date.now() } = {}) {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const stamp = formatStamp(now);
  const reportPath = join(outDir, `${stamp}.json`);
  const latestPath = join(outDir, 'latest.json');
  const body = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(reportPath, body, { mode: 0o600 });
  writeFileSync(latestPath, body, { mode: 0o600 });
  return { reportPath: rel(reportPath, root), latestPath: rel(latestPath, root) };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const pidInfo = resolvePid(args.pid);
  const startedAt = Date.now();
  const rounds = [];
  for (let i = 0; i < args.rounds; i += 1) {
    rounds.push(sampleRound({ pid: pidInfo.pid, dbPath: args.db }));
    if (i < args.rounds - 1 && args.intervalMs > 0) {
      // No hard timeout anywhere — only the configured inter-round wait.
      await sleep(args.intervalMs);
    }
  }
  const stageDurations = collectStageDurations({ root: ROOT });
  const now = Date.now();
  const report = buildSummary({ rounds, stageDurations, args, pidInfo, now });
  report.rounds = rounds;
  report.elapsedMs = now - startedAt;
  const paths = writeReport(report, { outDir: args.out, now });
  console.log(JSON.stringify({ ...report, ...paths }, null, 2));
  return { ...report, ...paths };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error(e?.stack || e?.message || String(e));
    process.exit(1);
  });
}
