#!/usr/bin/env node
// @ts-check
// Durable one-shot follow-up for long Noe tasks.
//
// This is intentionally not a multi-day foreground process. It reads the local
// observation/continuous snapshots, decides whether a scheduled check is due,
// optionally refreshes the safe verifiers, then writes a small handoff artifact
// that the next window, launchd, or a manual operator can continue from.

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'output', 'noe-long-task-followup');
const OBSERVATION_REF = 'output/noe-observation-status/latest.json';
const CONTINUOUS_REF = 'output/noe-continuous-autonomy/latest.json';
const RUN_LOG_REF = 'output/noe-long-task-followup/runs.jsonl';
const LAUNCHD_LABEL = 'com.noe.long-task-followup';

const SECRET_TEXT_RE = /((?:api[_-]?key|authorization|bearer|cookie|credential|owner[_-]?token|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;

function rel(file, root = ROOT) {
  return relative(root, file).replace(/\\/g, '/');
}

function redactText(value, max = 800) {
  return String(value || '')
    .replace(SECRET_TEXT_RE, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|tp-[a-z0-9]{8,}|AIza[0-9A-Za-z_-]{8,})\b/g, '[REDACTED_KEY]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function asIso(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '';
}

function asLocalIso(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const pad = (value, size = 2) => String(Math.trunc(Math.abs(value))).padStart(size, '0');
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return [
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    `${sign}${pad(offset / 60)}:${pad(offset % 60)}`,
  ].join('');
}

function parseTime(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

function compactObservation(report, { now = Date.now() } = {}) {
  const decision = report?.decision || {};
  const nextCheckAt = String(decision.nextCheckAt || '');
  const nextCheckMs = parseTime(nextCheckAt);
  const generatedMs = parseTime(report?.generatedAt);
  const nextCheckDue = nextCheckMs != null && now >= nextCheckMs;
  const staleForNextCheck = nextCheckDue && (generatedMs == null || generatedMs < nextCheckMs);
  const currentDueWindow = nextCheckDue && !staleForNextCheck;
  const blockers = Array.isArray(decision.blockers)
    ? decision.blockers.map((item) => redactText(item, 140)).filter(Boolean).slice(0, 16)
    : [];
  return {
    available: Boolean(report),
    generatedAt: String(report?.generatedAt || ''),
    status: redactText(decision.status || '', 120),
    readyForNextStageReview: decision.readyForNextStageReview === true,
    nextAction: redactText(decision.nextAction || '', 180),
    nextCheckAt,
    nextCheckAtLocal: nextCheckMs == null ? '' : asLocalIso(nextCheckMs),
    nextCheckDue,
    staleForNextCheck,
    currentDueWindow,
    msUntilNextCheck: nextCheckMs == null ? null : Math.max(0, nextCheckMs - now),
    minutesUntilNextCheck: nextCheckMs == null ? null : Math.ceil(Math.max(0, nextCheckMs - now) / 60_000),
    blockers,
    naturalExpectation: {
      resolved: Number(report?.expectationCalibration?.naturalLiveResolved || 0),
      required: Number(report?.expectationCalibration?.required || 0),
      remaining: Number(report?.expectationCalibration?.remaining || 0),
      dueNowOpen: Number(report?.expectationCalibration?.dueNowOpen || 0),
      dueWithin24h: Number(report?.expectationCalibration?.dueWithin24h || 0),
    },
    soak: {
      activeDays: Number(report?.soakSnapshot?.soak?.activeDays || 0),
      requiredDays: Number(report?.soakSnapshot?.soak?.requiredDays || 0),
      daysRemaining: Number(report?.soakSnapshot?.soak?.daysRemaining || 0),
    },
    hermes: {
      status: redactText(report?.hermesBackgroundAudit?.status || '', 80),
      observedHours: Number(report?.hermesBackgroundAudit?.observedHours || 0),
      remainingHours: Number(report?.hermesBackgroundAudit?.remainingHours || 0),
    },
  };
}

function compactContinuous(report) {
  return {
    available: Boolean(report),
    generatedAt: String(report?.generatedAt || ''),
    ok: report?.ok === true,
    blockers: Array.isArray(report?.blockers)
      ? report.blockers.map((item) => redactText(item, 140)).filter(Boolean).slice(0, 16)
      : [],
    observationStatus: report?.observationStatus || null,
  };
}

function parseLaunchdPrint(stdout = '') {
  const text = String(stdout || '');
  const field = (name) => {
    const match = text.match(new RegExp(`\\b${name}\\s*=\\s*([^\\n]+)`));
    return match ? redactText(match[1], 220) : '';
  };
  const numberField = (name) => {
    const raw = field(name);
    const match = raw.match(/-?\d+/);
    return match ? Number(match[0]) : null;
  };
  return {
    state: field('state'),
    jobState: field('job state'),
    path: field('path'),
    runs: numberField('runs'),
    lastExitCode: numberField('last exit code'),
    runIntervalSeconds: numberField('run interval'),
    stdoutPath: field('stdout path'),
    stderrPath: field('stderr path'),
  };
}

function fileMeta(file) {
  if (!file) return null;
  try {
    const st = statSync(file);
    return {
      path: redactText(file, 220),
      exists: true,
      bytes: Number(st.size || 0),
      mtimeAt: st.mtime instanceof Date ? st.mtime.toISOString() : '',
    };
  } catch {
    return { path: redactText(file, 220), exists: false, bytes: 0, mtimeAt: '' };
  }
}

function readLaunchdStatus({ runner = spawnSync } = {}) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const domain = uid == null ? '' : `gui/${uid}/${LAUNCHD_LABEL}`;
  if (!domain) return { label: LAUNCHD_LABEL, available: false, error: 'launchd_uid_unavailable' };
  const child = runner('launchctl', ['print', domain], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = child.status === 0 ? parseLaunchdPrint(child.stdout || '') : {};
  const stdoutPath = parsed.stdoutPath || '';
  const stderrPath = parsed.stderrPath || '';
  return {
    label: LAUNCHD_LABEL,
    domain,
    available: child.status === 0,
    status: child.status ?? null,
    ...parsed,
    logs: child.status === 0 ? {
      stdout: fileMeta(stdoutPath),
      stderr: fileMeta(stderrPath),
    } : null,
    error: child.status === 0 ? '' : redactText(child.stderr || child.stdout || 'launchctl print failed', 600),
  };
}

function latestSchedulerEvidenceMs(scheduler) {
  const stdout = scheduler?.logs?.stdout;
  const stderr = scheduler?.logs?.stderr;
  const stdoutMs = stdout?.exists === true ? parseTime(stdout.mtimeAt) : null;
  const stderrMs = stderr?.exists === true ? parseTime(stderr.mtimeAt) : null;
  if (stdout?.exists === true && Number(stdout.bytes || 0) > 0 && Number.isFinite(stdoutMs)) return stdoutMs;
  if (stderr?.exists === true && Number(stderr.bytes || 0) > 0 && Number.isFinite(stderrMs)) return stderrMs;
  const candidates = [
    stdoutMs,
    stderrMs,
  ].filter((value) => Number.isFinite(value));
  return candidates.length ? Math.max(...candidates) : null;
}

export function buildLongTaskFollowupReport({
  now = Date.now(),
  observationReport = null,
  continuousReport = null,
  commandResults = [],
  schedulerStatus = null,
} = {}) {
  const observation = compactObservation(observationReport, { now });
  const continuous = compactContinuous(continuousReport);
  const commandsFailed = commandResults.some((cmd) => cmd.ok === false);
  let status = 'waiting';
  let nextCommand = 'npm run verify:noe:long-task-followup';
  let action = observation.nextAction || 'keep_observing';

  if (!observation.available) {
    status = 'needs_initial_observation_status';
    action = 'run npm run verify:noe:observation-status';
    nextCommand = 'npm run verify:noe:observation-status && npm run verify:noe:long-task-followup';
  } else if (commandsFailed) {
    status = 'refresh_failed';
    action = 'inspect failed command, then rerun npm run verify:noe:long-task-followup';
  } else if (observation.readyForNextStageReview) {
    status = 'ready_for_next_stage_review';
    action = 'start next-stage review gate';
  } else if (observation.staleForNextCheck) {
    status = 'refresh_due';
    action = 'run npm run verify:noe:observation-status';
    nextCommand = 'npm run verify:noe:long-task-followup';
  } else if (observation.currentDueWindow) {
    status = 'waiting_for_natural_judgement';
    action = observation.nextAction || 'wait_for_natural_judgement_or_owner_outcome';
  }
  const completionAllowed = !commandsFailed && observation.readyForNextStageReview === true;
  const refs = {
    observation: OBSERVATION_REF,
    continuous: CONTINUOUS_REF,
    workMap: 'output/noe-work-map/latest.json',
    followupJson: 'output/noe-long-task-followup/latest.json',
    followupMarkdown: 'output/noe-long-task-followup/latest.md',
    runLog: RUN_LOG_REF,
  };
  const canRunNow = status === 'needs_initial_observation_status'
    || status === 'refresh_due'
    || status === 'refresh_failed';
  const scheduler = schedulerStatus || { label: LAUNCHD_LABEL, available: false, status: null, error: 'not_checked' };
  const schedulerIntervalSeconds = Number(scheduler.runIntervalSeconds || 0);
  const schedulerEvidenceMs = latestSchedulerEvidenceMs(scheduler);
  const schedulerExpectationBaseMs = schedulerEvidenceMs ?? now;
  const schedulerExpectationBasis = schedulerEvidenceMs == null ? 'report_generated_at' : 'launchd_log_mtime';
  const nextSchedulerRunMs = scheduler.available === true && schedulerIntervalSeconds > 0
    ? schedulerExpectationBaseMs + schedulerIntervalSeconds * 1000
    : null;
  const staleSchedulerMs = nextSchedulerRunMs == null
    ? null
    : schedulerExpectationBaseMs + Math.max(schedulerIntervalSeconds * 2, 1800) * 1000;
  const schedulerExpectation = {
    available: scheduler.available === true,
    intervalSeconds: schedulerIntervalSeconds || null,
    basis: scheduler.available === true && schedulerIntervalSeconds > 0 ? schedulerExpectationBasis : '',
    lastEvidenceAt: schedulerEvidenceMs == null ? '' : asIso(schedulerEvidenceMs),
    lastEvidenceAtLocal: schedulerEvidenceMs == null ? '' : asLocalIso(schedulerEvidenceMs),
    expectedNextRunAt: nextSchedulerRunMs == null ? '' : asIso(nextSchedulerRunMs),
    expectedNextRunAtLocal: nextSchedulerRunMs == null ? '' : asLocalIso(nextSchedulerRunMs),
    staleIfNoRunAfter: staleSchedulerMs == null ? '' : asIso(staleSchedulerMs),
    staleIfNoRunAfterLocal: staleSchedulerMs == null ? '' : asLocalIso(staleSchedulerMs),
  };
  let operatorGuidance = 'run_next_command_if_due';
  if (status === 'waiting_for_natural_judgement') {
    operatorGuidance = schedulerExpectation.expectedNextRunAtLocal
      ? 'wait_for_launchd_or_natural_judgement; do_not_force_refresh_until_scheduler_stale'
      : 'wait_for_natural_judgement; rerun_next_command_after_external_evidence_changes';
  } else if (status === 'waiting') {
    operatorGuidance = 'wait_until_next_check_time_then_run_next_command';
  } else if (status === 'ready_for_next_stage_review') {
    operatorGuidance = 'manual_review_allowed; verify_completion_gate_before_next_stage';
  } else if (status === 'refresh_failed') {
    operatorGuidance = 'inspect_failed_command_before_retry';
  } else if (status === 'refresh_due' || status === 'needs_initial_observation_status') {
    operatorGuidance = 'run_next_command_now';
  }
  let nextWindowInstruction = `Run \`${nextCommand}\` if the next check time has passed.`;
  if (operatorGuidance === 'wait_for_launchd_or_natural_judgement; do_not_force_refresh_until_scheduler_stale') {
    nextWindowInstruction = schedulerExpectation.staleIfNoRunAfterLocal
      ? `Wait for launchd or natural judgement. Do not force refresh before schedulerStaleIfNoRunAfterLocal=${schedulerExpectation.staleIfNoRunAfterLocal}.`
      : 'Wait for launchd or natural judgement. Do not force refresh while the current due window is already covered.';
  } else if (operatorGuidance === 'wait_for_natural_judgement; rerun_next_command_after_external_evidence_changes') {
    nextWindowInstruction = 'Wait for natural judgement or external evidence changes, then rerun the next command.';
  } else if (operatorGuidance === 'wait_until_next_check_time_then_run_next_command') {
    nextWindowInstruction = observation.nextCheckAtLocal
      ? `Wait until ${observation.nextCheckAtLocal}, then run \`${nextCommand}\`.`
      : `Wait until the next check time, then run \`${nextCommand}\`.`;
  } else if (operatorGuidance === 'run_next_command_now') {
    nextWindowInstruction = `Run \`${nextCommand}\` now.`;
  } else if (operatorGuidance === 'inspect_failed_command_before_retry') {
    nextWindowInstruction = 'Inspect failed command results before retrying the next command.';
  } else if (operatorGuidance === 'manual_review_allowed; verify_completion_gate_before_next_stage') {
    nextWindowInstruction = 'Manual next-stage review is allowed only after verifying completionGate.canMarkComplete=true.';
  }

  return {
    ok: !commandsFailed,
    generatedAt: asIso(now),
    generatedAtLocal: asLocalIso(now),
    policy: {
      durableOneShot: true,
      noSecretValues: true,
      noModelCallsDirectly: true,
      noDbWritesDirectly: true,
      doesNotBypassObservationGates: true,
      safeToRunFromNextWindow: true,
    },
    refs,
    scheduler,
    schedulerExpectation,
    status,
    action,
    operatorGuidance,
    nextWindowInstruction,
    nextCommand,
    resumeProtocol: {
      safeToResumeFromNextWindow: true,
      canRunNow,
      requiresManualInspection: commandsFailed,
      waitUntil: observation.nextCheckAt || '',
      waitUntilLocal: observation.nextCheckAtLocal || '',
      nextCommand,
      operatorGuidance,
      nextWindowInstruction,
      completionAllowed,
      waitingForNaturalJudgement: status === 'waiting_for_natural_judgement',
      nextSchedulerExpectedAt: schedulerExpectation.expectedNextRunAt,
      nextSchedulerExpectedAtLocal: schedulerExpectation.expectedNextRunAtLocal,
      schedulerStaleIfNoRunAfterLocal: schedulerExpectation.staleIfNoRunAfterLocal,
      mustNotMarkCompleteUntil: [
        'completionGate.canMarkComplete=true',
        'expectation resolved >= required',
        'soak activeDays >= requiredDays',
        'Hermes observedHours >= 24',
      ],
      evidenceRefs: refs,
    },
    nextCheckAt: observation.nextCheckAt || '',
    nextCheckAtLocal: observation.nextCheckAtLocal || '',
    nextCheckDue: observation.nextCheckDue === true,
    staleForNextCheck: observation.staleForNextCheck === true,
    currentDueWindow: observation.currentDueWindow === true,
    msUntilNextCheck: observation.msUntilNextCheck,
    minutesUntilNextCheck: observation.minutesUntilNextCheck,
    blockerCount: observation.blockers.length,
    blockers: observation.blockers,
    gateProgress: {
      naturalExpectation: observation.naturalExpectation,
      soak: observation.soak,
      hermes: observation.hermes,
    },
    completionGate: {
      canMarkComplete: completionAllowed,
      readyForNextStageReview: observation.readyForNextStageReview === true,
      criteria: {
        naturalExpectationResolved: Number(observation.naturalExpectation.required || 0),
        soakActiveDays: Number(observation.soak.requiredDays || 0),
        hermesObservedHours: 24,
      },
      current: {
        naturalExpectationResolved: Number(observation.naturalExpectation.resolved || 0),
        soakActiveDays: Number(observation.soak.activeDays || 0),
        hermesObservedHours: Number(observation.hermes.observedHours || 0),
      },
      remaining: {
        naturalExpectation: Number(observation.naturalExpectation.remaining || 0),
        soakDays: Number(observation.soak.daysRemaining || 0),
        hermesHours: Number(observation.hermes.remainingHours || 0),
      },
    },
    observation,
    continuous,
    commandResults,
  };
}

function renderLongTaskFollowupMarkdown(report) {
  const expectation = report.gateProgress?.naturalExpectation || {};
  const soak = report.gateProgress?.soak || {};
  const hermes = report.gateProgress?.hermes || {};
  const scheduler = report.scheduler || {};
  const blockers = Array.isArray(report.blockers) && report.blockers.length
    ? report.blockers.map((item) => `- ${redactText(item, 160)}`).join('\n')
    : '- none';
  const commandResults = Array.isArray(report.commandResults) && report.commandResults.length
    ? report.commandResults.map((cmd) => `- ${cmd.command}: ${cmd.ok ? 'ok' : 'failed'} status=${cmd.status ?? 'unknown'}`).join('\n')
    : '- none';
  return `# Noe Long Task Follow-up

Generated: ${redactText(report.generatedAt || '', 80)}
Generated local: ${redactText(report.generatedAtLocal || '', 80)}
Status: ${redactText(report.status || '', 80)}
Action: ${redactText(report.action || '', 180)}
Operator guidance: ${redactText(report.operatorGuidance || '', 180)}
Next command: \`${redactText(report.nextCommand || '', 180)}\`
Next check: ${redactText(report.nextCheckAt || '', 120)}
Next check local: ${redactText(report.nextCheckAtLocal || '', 120)}
Next check due: ${report.nextCheckDue === true}
Minutes until next check: ${report.minutesUntilNextCheck ?? ''}

## Gate Progress

- expectation: ${Number(expectation.resolved || 0)}/${Number(expectation.required || 0)} remaining ${Number(expectation.remaining || 0)}
- soak: ${Number(soak.activeDays || 0)}/${Number(soak.requiredDays || 0)}d remaining ${Number(soak.daysRemaining || 0)}
- hermes: ${redactText(hermes.status || '', 80)} observed ${Number(hermes.observedHours || 0).toFixed(2)}h remaining ${Number(hermes.remainingHours || 0).toFixed(2)}h

## Completion Gate

- canMarkComplete: ${report.completionGate?.canMarkComplete === true}
- readyForNextStageReview: ${report.completionGate?.readyForNextStageReview === true}
- requirement: expectation / soak / Hermes gates must all pass before completion

## Resume Protocol

- safeToResumeFromNextWindow: ${report.resumeProtocol?.safeToResumeFromNextWindow === true}
- canRunNow: ${report.resumeProtocol?.canRunNow === true}
- waitingForNaturalJudgement: ${report.resumeProtocol?.waitingForNaturalJudgement === true}
- requiresManualInspection: ${report.resumeProtocol?.requiresManualInspection === true}
- waitUntilLocal: ${redactText(report.resumeProtocol?.waitUntilLocal || '', 120)}
- nextCommand: \`${redactText(report.resumeProtocol?.nextCommand || report.nextCommand || '', 180)}\`
- operatorGuidance: ${redactText(report.resumeProtocol?.operatorGuidance || report.operatorGuidance || '', 180)}
- nextWindowInstruction: ${redactText(report.resumeProtocol?.nextWindowInstruction || report.nextWindowInstruction || '', 260)}
- completionAllowed: ${report.resumeProtocol?.completionAllowed === true}
- nextSchedulerExpectedAtLocal: ${redactText(report.resumeProtocol?.nextSchedulerExpectedAtLocal || '', 120)}
- schedulerStaleIfNoRunAfterLocal: ${redactText(report.resumeProtocol?.schedulerStaleIfNoRunAfterLocal || '', 120)}

## Scheduler

- label: ${redactText(scheduler.label || 'com.noe.long-task-followup', 100)}
- available: ${scheduler.available === true}
- state: ${redactText(scheduler.state || '', 80)}
- jobState: ${redactText(scheduler.jobState || '', 80)}
- runs: ${scheduler.runs ?? ''}
- lastExitCode: ${scheduler.lastExitCode ?? ''}
- runIntervalSeconds: ${scheduler.runIntervalSeconds ?? ''}
- expectationBasis: ${redactText(report.schedulerExpectation?.basis || '', 80)}
- lastSchedulerEvidenceLocal: ${redactText(report.schedulerExpectation?.lastEvidenceAtLocal || '', 120)}
- expectedNextRunLocal: ${redactText(report.schedulerExpectation?.expectedNextRunAtLocal || '', 120)}
- staleIfNoRunAfterLocal: ${redactText(report.schedulerExpectation?.staleIfNoRunAfterLocal || '', 120)}
- note: launchd state is a point-in-time snapshot; this one-shot script may appear running while it writes this report. Use runs, lastExitCode, and staleIfNoRunAfterLocal to judge scheduler health.

## Blockers

${blockers}

## Command Results

${commandResults}

## Evidence

- JSON: output/noe-long-task-followup/latest.json
- Observation: ${OBSERVATION_REF}
- Continuous autonomy: ${CONTINUOUS_REF}
- Work Map: output/noe-work-map/latest.json

## Next Window

${redactText(report.nextWindowInstruction || `Run \`${report.nextCommand || 'npm run verify:noe:long-task-followup'}\` if the next check time has passed.`, 280)}
Do not mark the long task complete until expectation, soak, and Hermes gates all pass.
`;
}

function runCommand(command, { runner = spawnSync } = {}) {
  const startedAt = Date.now();
  const child = runner('npm', ['run', command], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    command: `npm run ${command}`,
    ok: child.status === 0,
    status: child.status,
    signal: child.signal || null,
    durationMs: Math.max(0, Date.now() - startedAt),
    stderr: redactText(child.stderr || '', 1200),
    stdoutTail: redactText(String(child.stdout || '').slice(-1600), 1600),
  };
}

export function writeLongTaskFollowupReport(report, { root = ROOT, outDir = OUT_DIR } = {}) {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const stamp = report.generatedAt.replace(/[-:.]/g, '').replace('T', 'T').replace('Z', 'Z');
  const reportPath = join(outDir, `long-task-followup-${stamp}.json`);
  const markdownPath = join(outDir, `long-task-followup-${stamp}.md`);
  const latestPath = join(outDir, 'latest.json');
  const latestMarkdownPath = join(outDir, 'latest.md');
  const runLogPath = join(outDir, 'runs.jsonl');
  const body = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = renderLongTaskFollowupMarkdown(report);
  writeFileSync(reportPath, body, { mode: 0o600 });
  writeFileSync(latestPath, body, { mode: 0o600 });
  writeFileSync(markdownPath, markdown, { mode: 0o600 });
  writeFileSync(latestMarkdownPath, markdown, { mode: 0o600 });
  appendFileSync(runLogPath, `${JSON.stringify({
    generatedAt: report.generatedAt,
    generatedAtLocal: report.generatedAtLocal,
    status: report.status,
    ok: report.ok === true,
    operatorGuidance: report.operatorGuidance || '',
    nextWindowInstruction: report.nextWindowInstruction || '',
    nextCheckAt: report.nextCheckAt,
    nextCheckAtLocal: report.nextCheckAtLocal,
    canRunNow: report.resumeProtocol?.canRunNow === true,
    resumeOperatorGuidance: report.resumeProtocol?.operatorGuidance || '',
    resumeNextWindowInstruction: report.resumeProtocol?.nextWindowInstruction || '',
    waitingForNaturalJudgement: report.resumeProtocol?.waitingForNaturalJudgement === true,
    completionAllowed: report.resumeProtocol?.completionAllowed === true,
    canMarkComplete: report.completionGate?.canMarkComplete === true,
    blockerCount: Number(report.blockerCount || 0),
    blockers: Array.isArray(report.blockers) ? report.blockers.slice(0, 16) : [],
    scheduler: report.scheduler ? {
      available: report.scheduler.available === true,
      state: report.scheduler.state || '',
      runs: report.scheduler.runs ?? null,
      lastExitCode: report.scheduler.lastExitCode ?? null,
      logs: report.scheduler.logs ? {
        stdout: report.scheduler.logs.stdout ? {
          exists: report.scheduler.logs.stdout.exists === true,
          bytes: Number(report.scheduler.logs.stdout.bytes || 0),
          mtimeAt: report.scheduler.logs.stdout.mtimeAt || '',
        } : null,
        stderr: report.scheduler.logs.stderr ? {
          exists: report.scheduler.logs.stderr.exists === true,
          bytes: Number(report.scheduler.logs.stderr.bytes || 0),
          mtimeAt: report.scheduler.logs.stderr.mtimeAt || '',
        } : null,
      } : null,
    } : null,
    schedulerExpectation: report.schedulerExpectation ? {
      expectedNextRunAt: report.schedulerExpectation.expectedNextRunAt,
      expectedNextRunAtLocal: report.schedulerExpectation.expectedNextRunAtLocal,
      staleIfNoRunAfter: report.schedulerExpectation.staleIfNoRunAfter,
      staleIfNoRunAfterLocal: report.schedulerExpectation.staleIfNoRunAfterLocal,
    } : null,
    reportPath: rel(reportPath, root),
    handoffPath: rel(markdownPath, root),
  })}\n`, { mode: 0o600 });
  return {
    reportPath: rel(reportPath, root),
    latestPath: rel(latestPath, root),
    handoffPath: rel(markdownPath, root),
    latestHandoffPath: rel(latestMarkdownPath, root),
    runLogPath: rel(runLogPath, root),
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { noRun: false, write: true, outDir: OUT_DIR, includeSchedulerStatus: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--no-run') opts.noRun = true;
    else if (arg === '--no-write') opts.write = false;
    else if (arg === '--no-scheduler-status') opts.includeSchedulerStatus = false;
    else if (arg === '--out-dir') { opts.outDir = resolve(String(next || '')); i += 1; }
  }
  return opts;
}

export function runLongTaskFollowup({
  now = Date.now(),
  nowAfterRun = Date.now,
  noRun = false,
  runner = spawnSync,
  root = ROOT,
  outDir = OUT_DIR,
  write = true,
  includeSchedulerStatus = true,
} = {}) {
  let observationReport = readJson(join(root, OBSERVATION_REF));
  let continuousReport = readJson(join(root, CONTINUOUS_REF));
  const first = buildLongTaskFollowupReport({ now, observationReport, continuousReport });
  const commandResults = [];

  if (!noRun && (
    first.status === 'refresh_due'
    || first.status === 'needs_initial_observation_status'
  )) {
    commandResults.push(runCommand('verify:noe:observation-status', { runner }));
    if (commandResults.every((cmd) => cmd.ok)) {
      commandResults.push(runCommand('verify:noe:continuous-autonomy', { runner }));
    }
    observationReport = readJson(join(root, OBSERVATION_REF));
    continuousReport = readJson(join(root, CONTINUOUS_REF));
  }

  const schedulerStatus = includeSchedulerStatus ? readLaunchdStatus({ runner }) : null;
  const finalNow = commandResults.length
    ? (typeof nowAfterRun === 'function' ? nowAfterRun() : Number(nowAfterRun))
    : now;
  const report = buildLongTaskFollowupReport({ now: finalNow, observationReport, continuousReport, commandResults, schedulerStatus });
  const paths = write ? writeLongTaskFollowupReport(report, { root, outDir }) : null;
  return { report, paths };
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const { report, paths } = runLongTaskFollowup(opts);
  console.log(JSON.stringify({ ...report, ...(paths || {}) }, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
