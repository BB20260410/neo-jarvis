#!/usr/bin/env node
// @ts-check
// P8 observation status aggregator. It runs the read-only observation checks in
// a fixed order and writes one compact report without bypassing any gate.

import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'output', 'noe-observation-status');
const P8_GATE_REF = 'output/noe-p8-observation-gate/latest.json';
const SOAK_DAILY_REF = 'output/noe-soak-daily/latest.json';
const SECRET_TEXT_RE = /((?:api[_-]?key|authorization|bearer|cookie|credential|owner[_-]?token|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;

function rel(file, root = ROOT) {
  return relative(root, file).replace(/\\/g, '/');
}

function finiteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nonNegativeNumber(value, fallback = 0) {
  const n = finiteNumber(value, fallback);
  return n == null ? fallback : Math.max(0, n);
}

function roundNumber(value, digits = 4) {
  const n = finiteNumber(value, null);
  if (n == null) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function redactText(value, max = 500) {
  return String(value || '')
    .replace(SECRET_TEXT_RE, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|tp-[a-z0-9]{8,}|AIza[0-9A-Za-z_-]{8,})\b/g, '[REDACTED_KEY]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function parseJsonStdout(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return null;
}

function isoFromMs(value) {
  const n = finiteNumber(value, null);
  return n == null || n <= 0 ? '' : new Date(n).toISOString();
}

function toStepResult(step, child, startedAt, finishedAt) {
  const stdoutJson = parseJsonStdout(child?.stdout);
  return {
    id: step.id,
    ok: child?.status === 0 && Boolean(stdoutJson),
    status: child?.status ?? null,
    durationMs: Math.max(0, finishedAt - startedAt),
    command: ['node', ...step.args.map((arg) => relArg(arg, step.root))].join(' '),
    stderr: redactText(child?.stderr || '', 800),
    stdoutJson,
  };
}

function relArg(arg, root = ROOT) {
  const raw = String(arg || '');
  const abs = resolve(raw);
  return abs.startsWith(root) ? rel(abs, root) : raw;
}

function defaultSteps(root = ROOT) {
  const ensure = join(root, 'scripts', 'ensure-node22.mjs');
  return [
    {
      id: 'expectation_calibration',
      root,
      args: [
        ensure,
        '--require-22',
        '--exec',
        join(root, 'scripts', 'noe-expectation-calibration-snapshot.mjs'),
      ],
    },
    {
      id: 'p8_observation_gate',
      root,
      args: [
        ensure,
        '--require-22',
        '--exec',
        join(root, 'scripts', 'noe-p8-observation-gate.mjs'),
        '--no-write',
      ],
    },
    {
      id: 'soak_snapshot',
      root,
      args: [
        ensure,
        '--require-22',
        '--exec',
        join(root, 'scripts', 'noe-soak-daily-snapshot.mjs'),
        '--no-refresh-readiness',
        '--no-refresh-calibration',
      ],
    },
    {
      id: 'hermes_background_audit',
      root,
      args: [
        ensure,
        '--require-22',
        '--exec',
        join(root, 'scripts', 'noe-hermes-background-audit.mjs'),
      ],
    },
  ];
}

function runChildStep(step) {
  return spawnSync(process.execPath, step.args, {
    cwd: step.root || ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function compactExpectation(report) {
  const live = report?.live || {};
  const gate = report?.postHintJudgementGate || {};
  const naturalLiveResolved = nonNegativeNumber(live.naturalResolvedScored ?? live.naturalLiveResolved, 0);
  const required = nonNegativeNumber(live.liveResolvedRequired ?? live.requiredLiveResolved, 20);
  const remaining = nonNegativeNumber(
    live.naturalLiveResolvedRemaining ?? live.liveResolvedRemaining ?? Math.max(0, required - naturalLiveResolved),
    Math.max(0, required - naturalLiveResolved),
  );
  const dueNowOpen = nonNegativeNumber(gate.dueNowOpen ?? live.dueNowOpen, 0);
  const nextOpenDueAtIso = gate.nextOpenDueAtIso || isoFromMs(gate.nextOpenDueAt ?? live.nextOpenDueAt);
  const secondsUntilNextOpenDue = finiteNumber(gate.secondsUntilNextOpenDue, null)
    ?? finiteNumber(live.secondsUntilNextOpenDue, null)
    ?? (finiteNumber(live.hoursUntilNextOpenDue, null) == null ? null : Math.max(0, Math.round(Number(live.hoursUntilNextOpenDue) * 3600)));
  return {
    available: Boolean(report),
    generatedAt: report?.generatedAt || '',
    liveCalibrationReady: live.liveCalibrationReady === true,
    naturalLiveCalibrationReady: live.naturalLiveCalibrationReady === true,
    naturalLiveResolved,
    required,
    remaining,
    dueNowOpen,
    dueWithin24h: nonNegativeNumber(live.dueWithin24h, 0),
    resolverActionableNow: live.resolverActionableNow === true || dueNowOpen > 0,
    nextOpenDueAtIso,
    secondsUntilNextOpenDue,
    postHintGateStatus: gate.status || '',
    goalModeNextStep: gate.nextStep || '',
  };
}

function compactP8(report) {
  const gate = report?.gate || {};
  const observationDays = finiteNumber(gate.observationDays, null);
  const minObservationDays = finiteNumber(gate.minObservationDays, null);
  const maxObservationDays = finiteNumber(gate.maxObservationDays, null);
  const daysRemaining = observationDays == null || minObservationDays == null
    ? null
    : roundNumber(Math.max(0, minObservationDays - observationDays), 4);
  const observationDayIndex = observationDays == null
    ? null
    : Math.max(1, Math.floor(Math.max(0, observationDays)) + 1);
  const progressPct = observationDays == null || minObservationDays == null || minObservationDays <= 0
    ? null
    : roundNumber(Math.min(100, Math.max(0, (observationDays / minObservationDays) * 100)), 2);
  return {
    available: Boolean(report),
    ok: report?.ok === true,
    baselineId: report?.source?.baselineId || report?.baseline?.missionId || '',
    readyForNextStage: gate.readyForNextStage === true,
    minObservationDays,
    maxObservationDays,
    observationDays,
    observationDayIndex,
    daysRemaining,
    progressPct,
    observationStartedAt: gate.observationStartedAt || '',
    earliestNextStageAt: gate.earliestNextStageAt || '',
    blockers: Array.isArray(gate.blockers) ? gate.blockers.slice(0, 12) : [],
    warnings: Array.isArray(gate.warnings) ? gate.warnings.slice(0, 12) : [],
    recommendation: gate.recommendation || '',
    nextAllowedWork: Array.isArray(report?.nextAllowedWork) ? report.nextAllowedWork.slice(0, 8) : [],
    evidenceRefs: [P8_GATE_REF, SOAK_DAILY_REF],
    doNotStartNextStage: gate.readyForNextStage !== true,
  };
}

function buildP8DailyObservation(p8, soak) {
  const ready = p8.readyForNextStage === true;
  const evidenceRefs = [
    P8_GATE_REF,
    ...(soak.available ? [SOAK_DAILY_REF] : []),
  ];
  return {
    available: p8.available === true,
    status: ready ? 'ready_for_next_stage_review' : 'collect_daily_observation_snapshot',
    baselineId: p8.baselineId || '',
    observationDayIndex: p8.observationDayIndex,
    minObservationDays: p8.minObservationDays,
    maxObservationDays: p8.maxObservationDays,
    observationDays: p8.observationDays,
    daysRemaining: p8.daysRemaining,
    progressPct: p8.progressPct,
    observationStartedAt: p8.observationStartedAt || '',
    earliestNextStageAt: p8.earliestNextStageAt || '',
    blockers: Array.isArray(p8.blockers) ? p8.blockers.slice(0, 12) : [],
    warnings: Array.isArray(p8.warnings) ? p8.warnings.slice(0, 12) : [],
    allowedWork: Array.isArray(p8.nextAllowedWork) ? p8.nextAllowedWork.slice(0, 8) : [],
    forbiddenWork: ready ? [] : ['P9-A0', 'P9-D0', 'P9-G0', 'research/R line'],
    evidenceRefs,
    doNotStartNextStage: !ready,
    nextAction: ready
      ? 'review_p7j0_lite_next_stage_without_skipping_owner_gate'
      : 'capture_daily_observation_snapshot_and_rerun_observation_status',
    completionAllowed: ready,
  };
}

function compactSoak(report) {
  return {
    available: Boolean(report),
    generatedAt: report?.generatedAt || '',
    reportPath: report?.reportPath || '',
    latestPath: report?.latestPath || '',
    noe100: {
      passed: report?.noe100?.passed === true,
      score: finiteNumber(report?.noe100?.score, null),
      blockers: Array.isArray(report?.noe100?.blockers) ? report.noe100.blockers.slice(0, 12) : [],
    },
    soak: {
      status: report?.soak?.status || '',
      activeDays: finiteNumber(report?.soak?.activeDays, null),
      requiredDays: finiteNumber(report?.soak?.requiredDays, null),
      daysRemaining: finiteNumber(report?.soak?.daysRemaining, null),
      blocker: report?.soak?.blocker || '',
    },
    expectations: {
      naturalLiveResolved: finiteNumber(report?.expectationCalibration?.naturalLiveResolved ?? report?.expectations?.naturalLiveResolved, null),
      longTermReady: report?.expectations?.longTermReady === true || report?.expectationCalibration?.liveCalibrationReady === true,
    },
    p8ObservationGate: {
      readyForNextStage: report?.p8ObservationGate?.readyForNextStage === true,
      blockers: Array.isArray(report?.p8ObservationGate?.blockers) ? report.p8ObservationGate.blockers.slice(0, 12) : [],
    },
  };
}

function compactHermes(report) {
  const observedHours = finiteNumber(report?.observed?.observedHours, null);
  const windowHours = finiteNumber(report?.windowHours, 24);
  const remainingHours = observedHours == null || windowHours == null
    ? null
    : Math.max(0, Math.round((windowHours - observedHours) * 100) / 100);
  const categories = report?.categories && typeof report.categories === 'object'
    ? Object.fromEntries(Object.entries(report.categories).map(([name, value]) => [name, {
        count: nonNegativeNumber(value?.count, 0),
        okCount: nonNegativeNumber(value?.okCount, 0),
        failedCount: nonNegativeNumber(value?.failedCount, 0),
      }]))
    : {};
  return {
    available: Boolean(report),
    generatedAt: report?.generatedAt || '',
    status: report?.status || '',
    passed: report?.status === 'passed',
    windowHours,
    observedHours,
    remainingHours,
    firstAt: report?.observed?.firstAt || '',
    lastAt: report?.observed?.lastAt || '',
    blockers: Array.isArray(report?.blockers) ? report.blockers.slice(0, 12) : [],
    categories,
    reportPath: report?.paths?.reportPath || '',
    latestPath: report?.paths?.latestPath || '',
  };
}

export function summarizeObservationStatus({
  expectationReport,
  p8Report,
  soakReport,
  hermesReport,
  steps = [],
  nowMs = Date.now(),
} = {}) {
  const expectation = compactExpectation(expectationReport);
  const p8 = compactP8(p8Report);
  const soak = compactSoak(soakReport);
  const hermes = compactHermes(hermesReport);
  const p8DailyObservation = buildP8DailyObservation(p8, soak);
  const commandOk = steps.every((step) => step.ok !== false);
  const expectationReady = expectation.liveCalibrationReady || expectation.naturalLiveCalibrationReady || expectation.naturalLiveResolved >= expectation.required;
  const p8Ready = p8.readyForNextStage;
  const hermesReady = hermes.passed;
  const blockers = [
    ...(!commandOk ? ['observation_command_failed'] : []),
    ...(!expectation.available ? ['expectation_calibration_unavailable'] : []),
    ...(!p8.available ? ['p8_observation_gate_unavailable'] : []),
    ...(!soak.available ? ['soak_snapshot_unavailable'] : []),
    ...(!hermes.available ? ['hermes_background_audit_unavailable'] : []),
    ...(!expectationReady ? ['expectation_calibration_pending'] : []),
    ...(!hermesReady ? ['hermes_background_audit_pending'] : []),
    ...p8.blockers,
    ...soak.noe100.blockers,
    ...hermes.blockers,
  ].filter(Boolean);

  let status = 'continue_p8_observation';
  let nextAction = 'continue_daily_observation_do_not_start_p9_or_research_bridge';
  let nextCheckAt = p8.earliestNextStageAt || '';
  if (!commandOk || !expectation.available || !p8.available || !soak.available || !hermes.available) {
    status = 'blocked_by_observation_command';
    nextAction = 'fix_observation_status_command_failure_then_rerun';
    nextCheckAt = new Date(nowMs).toISOString();
  } else if (expectationReady && p8Ready && hermesReady) {
    status = 'ready_for_next_stage_review';
    nextAction = 'review_p7j0_lite_next_stage_without_skipping_owner_gate';
    nextCheckAt = new Date(nowMs).toISOString();
  } else if (expectationReady && p8Ready && !hermesReady) {
    status = 'continue_hermes_background_observation';
    nextAction = 'continue_background_observation_until_hermes_audit_window_passes';
    nextCheckAt = hermes.remainingHours == null
      ? new Date(nowMs).toISOString()
      : new Date(nowMs + Math.ceil(hermes.remainingHours * 3_600_000)).toISOString();
  } else if (!expectationReady && expectation.resolverActionableNow) {
    status = 'observe_due_expectations';
    nextAction = 'observe_next_natural_judgement_then_rerun_observation_status';
    nextCheckAt = new Date(nowMs).toISOString();
  } else if (!expectationReady) {
    status = 'wait_for_expectation_due';
    nextAction = 'wait_until_next_expectation_due_then_rerun_observation_status';
    nextCheckAt = expectation.nextOpenDueAtIso || p8.earliestNextStageAt || '';
  }

  return {
    ok: commandOk && expectation.available && p8.available && soak.available && hermes.available, // B1.2: ok 必须纳入 hermes.available(与 :332 status=blocked 一致)，否则 Hermes 审计不可用时 status 已 blocked、ok 却仍 true 自相矛盾
    generatedAt: new Date(nowMs).toISOString(),
    policy: {
      readOnly: true,
      noDbWrites: true,
      noModelCalls: true,
      noOwnerToken: true,
      noRawOwnerTextOutput: true,
      doesNotBypassSoak: true,
      doesNotStartP9OrResearch: true,
      noP8GateHistoryWrite: true,
    },
    steps: steps.map((step) => ({
      id: step.id,
      ok: step.ok,
      status: step.status,
      durationMs: step.durationMs,
      command: step.command,
      stderr: step.stderr,
    })),
    expectationCalibration: expectation,
    p8ObservationGate: p8,
    p8DailyObservation,
    soakSnapshot: soak,
    hermesBackgroundAudit: hermes,
    decision: {
      status,
      blockers: Array.from(new Set(blockers)),
      nextAction,
      nextCheckAt,
      readyForNextStageReview: status === 'ready_for_next_stage_review',
    },
  };
}

export function writeObservationStatusReport(report, { root = ROOT, outDir = OUT_DIR } = {}) {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  const dir = join(outDir, stamp);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const reportPath = join(dir, 'report.json');
  const latestPath = join(outDir, 'latest.json');
  const body = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(reportPath, body, { mode: 0o600 });
  writeFileSync(latestPath, body, { mode: 0o600 });
  return { reportPath: rel(reportPath, root), latestPath: rel(latestPath, root) };
}

export function runObservationStatus({
  root = ROOT,
  outDir = OUT_DIR,
  nowMs = Date.now(),
  write = true,
  runner = runChildStep,
} = {}) {
  const steps = defaultSteps(root).map((step) => {
    const startedAt = Date.now();
    const child = runner(step);
    const finishedAt = Date.now();
    return toStepResult(step, child, startedAt, finishedAt);
  });
  const byId = Object.fromEntries(steps.map((step) => [step.id, step.stdoutJson]));
  const report = summarizeObservationStatus({
    expectationReport: byId.expectation_calibration,
    p8Report: byId.p8_observation_gate,
    soakReport: byId.soak_snapshot,
    hermesReport: byId.hermes_background_audit,
    steps,
    nowMs,
  });
  const written = write ? writeObservationStatusReport(report, { root, outDir }) : null;
  return { report, written };
}

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { write: true, outDir: OUT_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--no-write') opts.write = false;
    else if (arg === '--out-dir') { opts.outDir = resolve(String(next || '')); i += 1; }
  }
  return opts;
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const { report, written } = runObservationStatus(opts);
  console.log(JSON.stringify({ ...report, written }, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
