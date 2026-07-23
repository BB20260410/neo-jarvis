#!/usr/bin/env node
// @ts-check
// Noe100 daily soak snapshot. Read-only: refreshes Noe100 readiness, samples
// live health/readiness, and records the current soak blocker without bypassing it.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildP8ObservationGateReport } from './noe-p8-observation-gate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'output', 'noe-soak-daily');
const BASE_URL = (process.env.NOE_PANEL_URL || 'http://127.0.0.1:51835').replace(/\/+$/, '');
const TZ = process.env.NOE_SOAK_TZ || 'Asia/Shanghai';

function rel(file, root = ROOT) {
  return relative(root, file).replace(/\\/g, '/');
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function latestJsonFile(dir, pred = () => true) {
  const files = walk(dir)
    .filter(pred)
    .map((file) => {
      try { return { file, mtimeMs: statSync(file).mtimeMs }; } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const item of files) {
    const json = readJson(item.file);
    if (json) return { file: item.file, json };
  }
  return { file: '', json: null };
}

export function formatSoakDay(now = Date.now(), timeZone = TZ) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const m = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${m.year}-${m.month}-${m.day}`;
}

function findCheck(report, id) {
  for (const dim of Object.values(report?.dimensions || {})) {
    for (const check of Array.isArray(dim?.checks) ? dim.checks : []) {
      if (check?.id === id) return check;
    }
  }
  return null;
}

function expectationDetails(report) {
  const fuel = findCheck(report, 'expectation_ledger_has_fuel')?.details || {};
  const settlement = findCheck(report, 'expectation_settlements_below_20')?.details || {};
  const brier = findCheck(report, 'brier_available')?.details || {};
  return {
    total: Number(fuel.total || 0),
    liveResolved: Number(fuel.resolved || 0),
    naturalLiveResolved: Number(settlement.naturalLiveResolved ?? fuel.naturalResolved ?? fuel.resolved ?? 0),
    controlledLiveResolved: Number(settlement.controlledLiveResolved || 0),
    controlledResolved: Number(settlement.controlledResolved || 0),
    controlledMechanismReady: settlement.controlledMechanismReady === true,
    longTermReady: settlement.ok === true,
    settlementSource: settlement.source || '',
    settlementReason: settlement.reason || '',
    brier: Number.isFinite(Number(brier.brier)) ? Number(brier.brier) : null,
    naturalLiveBrier: Number.isFinite(Number(settlement.brier?.naturalLiveBrier)) ? Number(settlement.brier.naturalLiveBrier) : null,
  };
}

function safeTag(value, max = 120) {
  const raw = String(value || '').slice(0, max);
  const safe = raw.replace(/[^A-Za-z0-9_.:=\-[\] /]+/g, '_').replace(/^_+|_+$/g, '');
  return safe || '';
}

function finiteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function compactCountEntries(items, keyName, limit = 6) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      const key = safeTag(item?.[keyName], 96);
      const count = Math.max(0, Math.min(10_000, Math.round(Number(item?.count) || 0)));
      return key && count > 0 ? { [keyName]: key, count } : null;
    })
    .filter(Boolean)
    .slice(0, limit);
}

function compactRecommendedActions(items, limit = 5) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      action: safeTag(item?.action, 96),
      priority: finiteNumber(item?.priority, null),
      gapCount: finiteNumber(item?.gapCount, null),
      gaps: Array.isArray(item?.gaps) ? item.gaps.map((gap) => safeTag(gap, 96)).filter(Boolean).slice(0, 8) : [],
      nextStep: safeTag(item?.nextStep, 180),
    }))
    .filter((item) => item.action)
    .slice(0, limit);
}

function compactPostHintJudgementGate(gate = {}) {
  if (!gate || typeof gate !== 'object') return null;
  return {
    status: safeTag(gate.status, 96),
    decisiveEvidenceDecisionCount: finiteNumber(gate.decisiveEvidenceDecisionCount, 0),
    decisiveEvidenceHintCount: finiteNumber(gate.decisiveEvidenceHintCount, 0),
    dueNowOpen: finiteNumber(gate.dueNowOpen, 0),
    nextOpenDueAt: finiteNumber(gate.nextOpenDueAt, null),
    nextOpenDueAtIso: safeTag(gate.nextOpenDueAtIso, 64),
    secondsUntilNextOpenDue: finiteNumber(gate.secondsUntilNextOpenDue, null),
    source: safeTag(gate.source, 96),
    nextStep: safeTag(gate.nextStep, 180),
  };
}

function goalModeExpectationNextStep(details) {
  if (!details.available) {
    return {
      action: 'refresh_expectation_calibration',
      reason: 'calibration_report_missing',
      waitSeconds: null,
    };
  }
  if (details.liveCalibrationReady) {
    return {
      action: 'continue_noe100_soak',
      reason: 'expectation_settlement_gate_passed',
      waitSeconds: null,
    };
  }
  if (details.resolverActionableNow) {
    return {
      action: 'observe_next_natural_judgement',
      reason: 'due_expectations_open',
      waitSeconds: 0,
    };
  }
  const waitSeconds = details.postHintJudgementGate?.secondsUntilNextOpenDue ?? null;
  return {
    action: details.postHintJudgementGate?.status || 'wait_for_next_open_due',
    reason: 'no_due_expectations_open',
    waitSeconds,
  };
}

function expectationCalibrationDetails(report, reportPath = '') {
  if (!report || typeof report !== 'object') {
    const missing = {
      available: false,
      reportPath,
      generatedAt: '',
      liveCalibrationReady: false,
      naturalLiveResolved: 0,
      requiredLiveResolved: 20,
      naturalLiveResolvedRemaining: 20,
      resolverActionableNow: false,
      dueNowOpen: 0,
      dueWithin24h: 0,
      nextOpenDueAt: null,
      hoursUntilNextOpenDue: null,
      postHintJudgementGate: null,
      actionFocus: null,
    };
    return { ...missing, goalModeNextStep: goalModeExpectationNextStep(missing) };
  }
  const live = report.live || {};
  const focus = report.recentAutoJudgements?.actionFocus || null;
  const details = {
    available: true,
    reportPath,
    generatedAt: report.generatedAt || '',
    liveCalibrationReady: live.liveCalibrationReady === true || live.naturalLiveCalibrationReady === true,
    naturalLiveResolved: finiteNumber(live.naturalResolvedScored ?? live.naturalLiveResolved, 0),
    requiredLiveResolved: finiteNumber(live.liveResolvedRequired, 20),
    naturalLiveResolvedRemaining: finiteNumber(live.naturalLiveResolvedRemaining ?? live.liveResolvedRemaining, 20),
    resolverActionableNow: live.resolverActionableNow === true,
    dueNowOpen: finiteNumber(live.dueNowOpen, 0),
    dueWithin24h: finiteNumber(live.dueWithin24h, 0),
    nextOpenDueAt: finiteNumber(live.nextOpenDueAt, null),
    hoursUntilNextOpenDue: finiteNumber(live.hoursUntilNextOpenDue, null),
    postHintJudgementGate: compactPostHintJudgementGate(report.postHintJudgementGate),
    actionFocus: focus ? {
      basis: safeTag(focus.basis, 96),
      tickId: finiteNumber(focus.tickId, null),
      evidenceSummaryCount: finiteNumber(focus.evidenceSummaryCount, 0),
      gapCounts: compactCountEntries(focus.gapCounts, 'gap', 8),
      recommendedActions: compactRecommendedActions(focus.recommendedActions, 5),
    } : null,
  };
  return { ...details, goalModeNextStep: goalModeExpectationNextStep(details) };
}

function compactLiveHealth(sample) {
  return {
    ok: sample?.ok === true,
    status: Number(sample?.status || 0),
    serviceOk: sample?.json?.ok === true,
    port: sample?.json?.port || null,
    error: sample?.error || '',
  };
}

function compactLiveReadiness(sample) {
  return {
    ok: sample?.ok === true,
    status: Number(sample?.status || 0),
    readinessStatus: sample?.json?.status || sample?.json?.readiness?.status || '',
    counts: sample?.json?.counts || null,
    error: sample?.error || '',
  };
}

function compactP8ObservationGate(report) {
  if (!report || typeof report !== 'object') {
    return {
      available: false,
      ok: false,
      readyForNextStage: false,
      baselineId: null,
      observationDays: 0,
      earliestNextStageAt: null,
      blockers: ['p8_observation_gate_unavailable'],
      warnings: [],
      recommendation: 'run_verify_noe_p8_observation_gate',
    };
  }
  return {
    available: true,
    ok: report.ok === true,
    readyForNextStage: report.gate?.readyForNextStage === true,
    baselineId: report.source?.baselineId || null,
    observationDays: finiteNumber(report.gate?.observationDays, 0),
    observationStartedAt: report.gate?.observationStartedAt || null,
    earliestNextStageAt: report.gate?.earliestNextStageAt || null,
    blockers: Array.isArray(report.gate?.blockers) ? report.gate.blockers.map((item) => safeTag(item, 96)).filter(Boolean) : [],
    warnings: Array.isArray(report.gate?.warnings) ? report.gate.warnings.map((item) => safeTag(item, 96)).filter(Boolean) : [],
    recommendation: safeTag(report.gate?.recommendation, 140),
    nextAllowedWork: Array.isArray(report.nextAllowedWork)
      ? report.nextAllowedWork.map((item) => safeTag(item, 140)).filter(Boolean)
      : [],
  };
}

export function buildSoakSnapshot({
  now = Date.now(),
  timeZone = TZ,
  readinessReport,
  readinessReportPath = '',
  expectationCalibrationReport = null,
  expectationCalibrationReportPath = '',
  liveHealth = null,
  liveReadiness = null,
  p8ObservationGateReport = null,
  existingSnapshotDays = [],
} = {}) {
  const soakCheck = findCheck(readinessReport, 'not_enough_soak_evidence');
  const activeDays = Number(soakCheck?.details?.activeDays || 0);
  const requiredDays = Number(soakCheck?.details?.requiredDays || 7);
  const blockers = Array.isArray(readinessReport?.blockers) ? readinessReport.blockers : [];
  const day = formatSoakDay(now, timeZone);
  const uniqueSnapshotDays = Array.from(new Set([...existingSnapshotDays, day])).sort();
  const soakPassed = Boolean(readinessReport?.passed === true && activeDays >= requiredDays && !blockers.includes('not_enough_soak_evidence'));
  return {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    timeZone,
    day,
    policy: {
      readOnly: true,
      noDbWrites: true,
      noModelCalls: true,
      lmStudioLoadUnloadChanged: false,
      doesNotBypassSoak: true,
    },
    live: {
      health: compactLiveHealth(liveHealth),
      readiness: compactLiveReadiness(liveReadiness),
    },
    noe100: {
      reportPath: readinessReportPath,
      generatedAt: readinessReport?.source?.generatedAt || readinessReport?.generatedAt || '',
      score: Number(readinessReport?.score || 0),
      passed: readinessReport?.passed === true,
      readyFor100: readinessReport?.readyFor100 === true,
      passedChecks: Number(readinessReport?.passedChecks || 0),
      failedChecks: Number(readinessReport?.failedChecks || 0),
      blockers,
    },
    soak: {
      status: soakPassed ? 'passed' : 'pending',
      activeDays,
      requiredDays,
      daysRemaining: Math.max(0, requiredDays - activeDays),
      blocker: activeDays >= requiredDays ? '' : 'not_enough_soak_evidence',
      evidenceSource: 'Noe100 readiness survival.not_enough_soak_evidence',
      snapshotDays: uniqueSnapshotDays,
      snapshotDayCount: uniqueSnapshotDays.length,
    },
    expectations: expectationDetails(readinessReport),
    expectationCalibration: expectationCalibrationDetails(expectationCalibrationReport, expectationCalibrationReportPath),
    p8ObservationGate: compactP8ObservationGate(p8ObservationGateReport),
  };
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

function refreshReadiness({ root = ROOT } = {}) {
  const child = spawnSync(process.execPath, [
    join(root, 'scripts', 'ensure-node22.mjs'),
    '--require-22',
    '--exec',
    join(root, 'scripts', 'noe-100-readiness.mjs'),
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let parsed = null;
  try { parsed = child.stdout ? JSON.parse(child.stdout) : null; } catch {}
  return {
    ok: child.status === 0 && Boolean(parsed),
    status: child.status,
    stdoutJson: parsed,
    stderr: String(child.stderr || '').slice(0, 2000),
  };
}

function refreshExpectationCalibration({ root = ROOT } = {}) {
  const child = spawnSync(process.execPath, [
    join(root, 'scripts', 'ensure-node22.mjs'),
    '--require-22',
    '--exec',
    join(root, 'scripts', 'noe-expectation-calibration-snapshot.mjs'),
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let parsed = null;
  try { parsed = child.stdout ? JSON.parse(child.stdout) : null; } catch {}
  return {
    ok: child.status === 0 && Boolean(parsed),
    status: child.status,
    stdoutJson: parsed,
    stderr: String(child.stderr || '').slice(0, 2000),
  };
}

function existingDays(outDir = OUT_DIR) {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir, { withFileTypes: true })
    .filter((ent) => ent.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(ent.name))
    .map((ent) => ent.name)
    .sort();
}

export function writeSoakSnapshot(snapshot, { root = ROOT, outDir = OUT_DIR } = {}) {
  const dayDir = join(outDir, snapshot.day);
  mkdirSync(dayDir, { recursive: true, mode: 0o700 });
  const reportPath = join(dayDir, 'report.json');
  const latestPath = join(outDir, 'latest.json');
  const body = `${JSON.stringify(snapshot, null, 2)}\n`;
  writeFileSync(reportPath, body, { mode: 0o600 });
  writeFileSync(latestPath, body, { mode: 0o600 });
  return { reportPath: rel(reportPath, root), latestPath: rel(latestPath, root) };
}

export async function main(argv = process.argv.slice(2)) {
  const args = new Set(argv);
  const now = Date.now();
  const refresh = !args.has('--no-refresh-readiness');
  const refreshCalibration = !args.has('--no-refresh-calibration');
  const refreshResult = refresh ? refreshReadiness() : { ok: true, status: 0, stdoutJson: null, stderr: '' };
  const calibrationRefreshResult = refreshCalibration
    ? refreshExpectationCalibration()
    : { ok: true, status: 0, stdoutJson: null, stderr: '' };
  const readinessHit = refreshResult.stdoutJson?.reportPath
    ? { file: join(ROOT, refreshResult.stdoutJson.reportPath), json: readJson(join(ROOT, refreshResult.stdoutJson.reportPath)) }
    : latestJsonFile(join(ROOT, 'output', 'noe-100-readiness'), (f) => /noe-100-readiness-\d+\.json$/.test(f));
  const calibrationHit = calibrationRefreshResult.stdoutJson?.reportPath
    ? { file: join(ROOT, calibrationRefreshResult.stdoutJson.reportPath), json: readJson(join(ROOT, calibrationRefreshResult.stdoutJson.reportPath)) }
    : latestJsonFile(join(ROOT, 'output', 'noe-expectation-calibration'), (f) => /\/report\.json$/.test(f));
  const [liveHealth, liveReadiness] = await Promise.all([
    fetchJson('/health'),
    fetchJson('/api/noe/readiness'),
  ]);
  const p8ObservationGateReport = buildP8ObservationGateReport({ nowMs: now });
  const snapshot = buildSoakSnapshot({
    now,
    timeZone: TZ,
    readinessReport: readinessHit.json,
    readinessReportPath: readinessHit.file ? rel(readinessHit.file) : '',
    expectationCalibrationReport: calibrationHit.json,
    expectationCalibrationReportPath: calibrationHit.file ? rel(calibrationHit.file) : '',
    liveHealth,
    liveReadiness,
    p8ObservationGateReport,
    existingSnapshotDays: existingDays(),
  });
  snapshot.readinessRefresh = {
    attempted: refresh,
    ok: refreshResult.ok,
    status: refreshResult.status,
    stderr: refreshResult.stderr,
  };
  snapshot.expectationCalibrationRefresh = {
    attempted: refreshCalibration,
    ok: calibrationRefreshResult.ok,
    status: calibrationRefreshResult.status,
    stderr: calibrationRefreshResult.stderr,
  };
  const paths = writeSoakSnapshot(snapshot);
  console.log(JSON.stringify({ ...snapshot, ...paths }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error(e?.stack || e?.message || String(e));
    process.exit(1);
  });
}
