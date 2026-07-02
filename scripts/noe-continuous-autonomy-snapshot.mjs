#!/usr/bin/env node
// @ts-check
// Continuous autonomy snapshot. Read-only verifier for high-frequency thinking,
// proactive ticks, expectation resolution cadence, and rolling self_learning.
// It never reads secret files, never calls a model, and never writes the live DB.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { default: Database } = await import('better-sqlite3');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DB_PATH = join(homedir(), '.noe-panel', 'panel.db');
const DEFAULT_OUT_DIR = join(ROOT, 'output', 'noe-continuous-autonomy');
const DEFAULT_OBSERVATION_STATUS_PATH = join(ROOT, 'output', 'noe-observation-status', 'latest.json');
const BASE_URL = (process.env.NOE_PANEL_URL || 'http://127.0.0.1:51835').replace(/\/+$/, '');
const DB_PATH = process.env.NOE_CONTINUOUS_AUTONOMY_DB_PATH || DEFAULT_DB_PATH;
const OUT_DIR = process.env.NOE_CONTINUOUS_AUTONOMY_OUT_DIR || DEFAULT_OUT_DIR;

export const EXPECTED_CADENCE_MS = Object.freeze({
  meso: 5_000,
  micro: 10_000,
  proactive: 10_000,
  expectation: 600_000,
});

const SECRET_TEXT_RE = /((?:api[_-]?key|authorization|bearer|cookie|credential|owner[_-]?token|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;

function rel(file, root = ROOT) {
  return relative(root, file).replace(/\\/g, '/');
}

function redactText(value, max = 240) {
  return String(value || '')
    .replace(SECRET_TEXT_RE, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|tp-[a-z0-9]{8,}|AIza[0-9A-Za-z_-]{8,})\b/g, '[REDACTED_KEY]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function readPackageScripts(root = ROOT) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return pkg.scripts || {};
  } catch {
    return {};
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function tableExists(db, table) {
  try {
    return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
  } catch {
    return false;
  }
}

function compactLiveHealth(sample) {
  return {
    ok: sample?.ok === true,
    status: Number(sample?.status || 0),
    serviceOk: sample?.json?.ok === true,
    port: sample?.json?.port || null,
    error: redactText(sample?.error || '', 400),
  };
}

function compactLiveReadiness(sample) {
  return {
    ok: sample?.ok === true,
    status: Number(sample?.status || 0),
    readinessStatus: sample?.json?.status || sample?.json?.readiness?.status || '',
    counts: sample?.json?.counts || null,
    error: redactText(sample?.error || '', 400),
  };
}

function parsePlan(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function summarizePlanSteps(plan = []) {
  const counts = {};
  for (const step of plan) {
    const status = String(step?.status || 'open');
    counts[status] = (counts[status] || 0) + 1;
  }
  return {
    total: plan.length,
    byStatus: counts,
    openLike: (counts.open || 0) + (counts.doing || 0) + (counts.awaiting_approval || 0),
    doneLike: (counts.done || 0) + (counts.recovered || 0),
  };
}

function compactGoal(row) {
  if (!row) return null;
  const plan = parsePlan(row.plan);
  return {
    id: String(row.id || ''),
    source: String(row.source || ''),
    status: String(row.status || ''),
    title: redactText(row.title || '', 180),
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
    steps: summarizePlanSteps(plan),
  };
}

function compactObservationStatus(report, { now = Date.now(), ref = 'output/noe-observation-status/latest.json' } = {}) {
  if (!report || typeof report !== 'object') {
    return {
      available: false,
      ref,
      action: 'run npm run verify:noe:observation-status',
      reason: 'observation_status_missing',
    };
  }
  const decision = report.decision || {};
  const nextCheckAt = String(decision.nextCheckAt || '');
  const nextCheckMs = nextCheckAt ? Date.parse(nextCheckAt) : NaN;
  const generatedMs = report.generatedAt ? Date.parse(String(report.generatedAt)) : NaN;
  const nextCheckDue = Number.isFinite(nextCheckMs) && Number(now) >= nextCheckMs;
  const staleForNextCheck = nextCheckDue && (!Number.isFinite(generatedMs) || generatedMs < nextCheckMs);
  const blockers = Array.isArray(decision.blockers)
    ? decision.blockers.map((item) => redactText(item, 140)).filter(Boolean).slice(0, 12)
    : [];
  return {
    available: true,
    ref,
    generatedAt: String(report.generatedAt || ''),
    status: redactText(decision.status || '', 120),
    readyForNextStageReview: decision.readyForNextStageReview === true,
    nextAction: redactText(decision.nextAction || '', 180),
    nextCheckAt,
    nextCheckDue,
    staleForNextCheck,
    msUntilNextCheck: Number.isFinite(nextCheckMs) ? Math.max(0, nextCheckMs - Number(now)) : null,
    blockerCount: blockers.length,
    blockers,
    naturalExpectation: {
      resolved: Number(report.expectationCalibration?.naturalLiveResolved || 0),
      required: Number(report.expectationCalibration?.required || 0),
      remaining: Number(report.expectationCalibration?.remaining || 0),
      dueNowOpen: Number(report.expectationCalibration?.dueNowOpen || 0),
      dueWithin24h: Number(report.expectationCalibration?.dueWithin24h || 0),
    },
    soak: {
      activeDays: Number(report.soakSnapshot?.soak?.activeDays || 0),
      requiredDays: Number(report.soakSnapshot?.soak?.requiredDays || 0),
      daysRemaining: Number(report.soakSnapshot?.soak?.daysRemaining || 0),
    },
    hermes: {
      status: redactText(report.hermesBackgroundAudit?.status || '', 80),
      observedHours: Number(report.hermesBackgroundAudit?.observedHours || 0),
      remainingHours: Number(report.hermesBackgroundAudit?.remainingHours || 0),
    },
    action: staleForNextCheck
      ? 'rerun npm run verify:noe:observation-status'
      : redactText(decision.nextAction || 'keep observing', 180),
  };
}

export function buildContinuousAutonomySnapshot({
  now = Date.now(),
  dbPath = DB_PATH,
  packageScripts = readPackageScripts(),
  liveHealth = null,
  liveReadiness = null,
  dbEvidence = null,
  dbError = '',
  observationReport = null,
} = {}) {
  const blockers = [];
  const health = compactLiveHealth(liveHealth);
  const readiness = compactLiveReadiness(liveReadiness);
  if (!health.ok || !health.serviceOk) blockers.push('live_health_not_ok');
  if (!readiness.ok || !['passed', 'ok', 'ready'].includes(String(readiness.readinessStatus || '').toLowerCase())) {
    blockers.push('live_readiness_not_ok');
  }
  if (!dbEvidence) blockers.push('db_evidence_unavailable');
  if (dbError) blockers.push('db_read_failed');

  const cursorRows = Array.isArray(dbEvidence?.cursors) ? dbEvidence.cursors : [];
  const cursorByKind = new Map(cursorRows.map((row) => [String(row.kind), row]));
  const cadenceChecks = Object.entries(EXPECTED_CADENCE_MS).map(([kind, maxCadenceMs]) => {
    const row = cursorByKind.get(kind) || null;
    const cadenceMs = Number(row?.cadence_ms || 0);
    const lagMs = row ? Math.max(0, now - Number(row.next_due || 0)) : null;
    const ok = Boolean(row) && cadenceMs > 0 && cadenceMs <= maxCadenceMs;
    if (!ok) blockers.push(`cadence_${kind}_too_slow_or_missing`);
    return {
      kind,
      ok,
      cadenceMs: cadenceMs || null,
      maxCadenceMs,
      nextDue: row ? Number(row.next_due || 0) : null,
      updatedAt: row ? Number(row.updated_at || 0) : null,
      lagMs,
    };
  });

  const tickCounts = Array.isArray(dbEvidence?.tickCounts) ? dbEvidence.tickCounts : [];
  const recentTicks = Array.isArray(dbEvidence?.recentTicks) ? dbEvidence.recentTicks : [];
  const windowDoneKinds = Array.from(new Set(tickCounts
    .filter((row) => row.status === 'done' && Number(row.n || 0) > 0)
    .map((row) => String(row.kind || ''))
    .filter(Boolean))).sort();
  const requiredWindowDoneKinds = ['meso', 'micro', 'proactive'];
  for (const kind of requiredWindowDoneKinds) {
    if (!windowDoneKinds.includes(kind)) blockers.push(`no_recent_done_tick_${kind}`);
  }

  const selfLearning = dbEvidence?.selfLearning || {};
  const selfLearningHasEvidence = Number(selfLearning.total || 0) > 0
    && (Number(selfLearning.activeCount || 0) > 0 || Number(selfLearning.doneCount || 0) > 0 || selfLearning.latest);
  if (!selfLearningHasEvidence) blockers.push('self_learning_no_goal_evidence');

  const continuousLearningScript = String(packageScripts['verify:noe:continuous-autonomy'] || '');
  const testP0 = String(packageScripts['test:p0:unit'] || '');
  const continuousConfigured = continuousLearningScript.includes('noe-continuous-autonomy-snapshot.mjs')
    && testP0.includes('tests/unit/noe-continuous-autonomy-snapshot.test.js');
  if (!continuousConfigured) blockers.push('continuous_autonomy_validation_not_registered');

  const tickKinds = Object.keys(EXPECTED_CADENCE_MS);
  const seenKinds = new Set(recentTicks.map((row) => row.kind));
  const liveCadenceKindsSeen = tickKinds.filter((kind) => cursorByKind.has(kind));
  const observationStatus = compactObservationStatus(observationReport, { now });

  return {
    ok: blockers.length === 0,
    generatedAt: new Date(now).toISOString(),
    policy: {
      readOnly: true,
      noSecretValues: true,
      noModelCalls: true,
      noDbWrites: true,
      lmStudioLoadUnloadChanged: false,
      contextLengthIsNotOutputBudget: true,
      noArtificialTotalStepOrTimeLimit: true,
    },
    source: {
      dbPath,
      baseUrl: BASE_URL,
    },
    live: { health, readiness },
    heartbeat: {
      expectedCadenceMs: EXPECTED_CADENCE_MS,
      checks: cadenceChecks,
      liveCadenceKindsSeen,
      allExpectedKindsSeen: liveCadenceKindsSeen.length === tickKinds.length,
    },
    ticks: {
      windowMs: Number(dbEvidence?.tickWindowMs || 0),
      counts: tickCounts,
      recent: recentTicks.map((row) => ({
        id: Number(row.id || 0),
        kind: String(row.kind || ''),
        status: String(row.status || ''),
        dueAt: Number(row.due_at || 0),
        startedAt: Number(row.started_at || 0),
        finishedAt: Number(row.finished_at || 0),
      })),
      recentKindsSeen: Array.from(seenKinds).sort(),
      windowDoneKinds,
      requiredWindowDoneKinds,
      requiredWindowDoneKindsSatisfied: requiredWindowDoneKinds.every((kind) => windowDoneKinds.includes(kind)),
    },
    selfLearning: {
      total: Number(selfLearning.total || 0),
      activeCount: Number(selfLearning.activeCount || 0),
      doneCount: Number(selfLearning.doneCount || 0),
      latest: compactGoal(selfLearning.latest),
      latestDone: compactGoal(selfLearning.latestDone),
      recent: Array.isArray(selfLearning.recent) ? selfLearning.recent.map(compactGoal).filter(Boolean) : [],
      continuousReady: selfLearningHasEvidence,
      nextCanSeedWithoutIntervalWhenDone: selfLearning.latest?.status === 'done' && Number(selfLearning.activeCount || 0) === 0,
    },
    observationStatus,
    registration: {
      packageScript: continuousLearningScript ? 'present' : 'missing',
      p0UnitIncludesSnapshotTest: testP0.includes('tests/unit/noe-continuous-autonomy-snapshot.test.js'),
    },
    blockers,
  };
}

export function collectDbEvidence({ dbPath = DB_PATH, now = Date.now(), tickWindowMs = 10 * 60_000 } = {}) {
  if (!existsSync(dbPath)) return { dbEvidence: null, dbError: `missing db: ${dbPath}` };
  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const evidence = { tickWindowMs, cursors: [], tickCounts: [], recentTicks: [], selfLearning: {} };
    if (tableExists(db, 'noe_tick_cursor')) {
      evidence.cursors = db.prepare('SELECT kind, next_due, cadence_ms, updated_at FROM noe_tick_cursor ORDER BY kind').all();
    }
    if (tableExists(db, 'noe_ticks')) {
      const since = now - tickWindowMs;
      evidence.tickCounts = db.prepare(`
        SELECT kind, status, COUNT(*) AS n
        FROM noe_ticks
        WHERE COALESCE(finished_at, started_at, due_at, 0) >= ?
        GROUP BY kind, status
        ORDER BY kind, status
      `).all(since);
      evidence.recentTicks = db.prepare(`
        SELECT id, kind, due_at, started_at, finished_at, status
        FROM noe_ticks
        ORDER BY id DESC
        LIMIT 24
      `).all();
    }
    if (tableExists(db, 'noe_goals')) {
      evidence.selfLearning = {
        total: Number(db.prepare("SELECT COUNT(*) AS n FROM noe_goals WHERE source='self_learning'").get()?.n || 0),
        activeCount: Number(db.prepare("SELECT COUNT(*) AS n FROM noe_goals WHERE source='self_learning' AND status IN ('open','active')").get()?.n || 0),
        doneCount: Number(db.prepare("SELECT COUNT(*) AS n FROM noe_goals WHERE source='self_learning' AND status='done'").get()?.n || 0),
        latest: db.prepare("SELECT id, created_at, source, title, status, plan, updated_at FROM noe_goals WHERE source='self_learning' ORDER BY updated_at DESC LIMIT 1").get() || null,
        latestDone: db.prepare("SELECT id, created_at, source, title, status, plan, updated_at FROM noe_goals WHERE source='self_learning' AND status='done' ORDER BY updated_at DESC LIMIT 1").get() || null,
        recent: db.prepare("SELECT id, created_at, source, title, status, plan, updated_at FROM noe_goals WHERE source='self_learning' ORDER BY updated_at DESC LIMIT 5").all(),
      };
    }
    return { dbEvidence: evidence, dbError: '' };
  } catch (e) {
    return { dbEvidence: null, dbError: redactText(e?.message || String(e), 500) };
  } finally {
    try { db?.close?.(); } catch {}
  }
}

async function fetchJson(path) {
  const startedAt = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${BASE_URL}${path}`, { signal: ctrl.signal });
    clearTimeout(timer);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { ok: res.ok, status: res.status, elapsedMs: Date.now() - startedAt, json, error: res.ok ? '' : text.slice(0, 500) };
  } catch (e) {
    return { ok: false, status: 0, elapsedMs: Date.now() - startedAt, json: null, error: e?.message || String(e) };
  }
}

export function writeContinuousAutonomySnapshot(snapshot, { root = ROOT, outDir = OUT_DIR } = {}) {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const stamp = snapshot.generatedAt.replace(/[-:.]/g, '').replace('T', 'T').replace('Z', 'Z');
  const reportPath = join(outDir, `continuous-autonomy-${stamp}.json`);
  const latestPath = join(outDir, 'latest.json');
  const body = `${JSON.stringify(snapshot, null, 2)}\n`;
  writeFileSync(reportPath, body, { mode: 0o600 });
  writeFileSync(latestPath, body, { mode: 0o600 });
  try { chmodSync(reportPath, 0o600); chmodSync(latestPath, 0o600); } catch {}
  return { reportPath: rel(reportPath, root), latestPath: rel(latestPath, root) };
}

export async function main() {
  const now = Date.now();
  const [liveHealth, liveReadiness] = await Promise.all([
    fetchJson('/health'),
    fetchJson('/api/noe/readiness'),
  ]);
  const { dbEvidence, dbError } = collectDbEvidence({ dbPath: DB_PATH, now });
  const snapshot = buildContinuousAutonomySnapshot({
    now,
    dbPath: DB_PATH,
    packageScripts: readPackageScripts(),
    liveHealth,
    liveReadiness,
    dbEvidence,
    dbError,
    observationReport: readJsonFile(DEFAULT_OBSERVATION_STATUS_PATH),
  });
  const paths = writeContinuousAutonomySnapshot(snapshot);
  console.log(JSON.stringify({ ...snapshot, ...paths }, null, 2));
  if (!snapshot.ok) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error(redactText(e?.stack || e?.message || String(e), 2000));
    process.exit(1);
  });
}
