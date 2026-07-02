#!/usr/bin/env node
// @ts-check
// P8 post-soak observation gate. Read-only over output/noe-missions; no live ports, no model calls.

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MIN_OBSERVATION_DAYS = 7;
const DEFAULT_MAX_OBSERVATION_DAYS = 10;
const DEFAULT_MIN_SOAK_MS = 7 * 60 * 60 * 1000;
const DEFAULT_MISSION_ROOT = join(ROOT, 'output', 'noe-missions');
const DEFAULT_OUT_DIR = join(ROOT, 'output', 'noe-p8-observation-gate');

function rel(file) {
  const abs = resolve(file);
  return abs.startsWith(ROOT) ? relative(ROOT, abs).replace(/\\/g, '/') : abs;
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    missionRoot: DEFAULT_MISSION_ROOT,
    outDir: DEFAULT_OUT_DIR,
    baselineId: '',
    minObservationDays: DEFAULT_MIN_OBSERVATION_DAYS,
    maxObservationDays: DEFAULT_MAX_OBSERVATION_DAYS,
    minSoakMs: DEFAULT_MIN_SOAK_MS,
    requireReady: false,
    write: true,
    nowMs: Date.now(),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--mission-root') { opts.missionRoot = resolve(String(next || '')); i += 1; }
    else if (arg === '--out-dir') { opts.outDir = resolve(String(next || '')); i += 1; }
    else if (arg === '--baseline-id') { opts.baselineId = String(next || ''); i += 1; }
    else if (arg === '--min-days') { opts.minObservationDays = positiveNumber(next, DEFAULT_MIN_OBSERVATION_DAYS); i += 1; }
    else if (arg === '--max-days') { opts.maxObservationDays = positiveNumber(next, DEFAULT_MAX_OBSERVATION_DAYS); i += 1; }
    else if (arg === '--min-soak-ms') { opts.minSoakMs = positiveNumber(next, DEFAULT_MIN_SOAK_MS); i += 1; }
    else if (arg === '--now') { opts.nowMs = timestampMs(next) ?? opts.nowMs; i += 1; }
    else if (arg === '--require-ready') opts.requireReady = true;
    else if (arg === '--no-write') opts.write = false;
  }
  return opts;
}

function readEvents(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function countByType(events) {
  const counts = {};
  for (const event of events) {
    const type = String(event?.type || 'unknown');
    counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

function artifactCounts(dir) {
  const artifactDir = join(dir, 'artifacts');
  if (!existsSync(artifactDir)) {
    return { soakCheckpoints: 0, runSummaries: 0, hasCoverage: false, hasFinalReport: false, hasFinalization: false };
  }
  const names = readdirSync(artifactDir);
  return {
    soakCheckpoints: names.filter((name) => /^soak-checkpoint-\d+\.json$/.test(name)).length,
    runSummaries: names.filter((name) => /^run-summary-\d+\.json$/.test(name)).length,
    hasCoverage: names.includes('coverage-table.json'),
    hasFinalReport: names.includes('final-report.json'),
    hasFinalization: names.some((name) => /^finalization-\d+\.json$/.test(name)),
  };
}

// B1.2 防伪造：核验 evidence ref 指向的文件真实存在可读（不只信 coverage-table 的 readable 声明）。
// ref 形如 output/noe-missions/<id>/artifacts/<name>；只取 artifacts/ 之后的相对部分，在 mission 目录的
// artifacts 下定位（兼容测试临时根），并做穿越防护（拒 .. 与逃出 artifacts 目录的路径）。
function evidenceFileReadable(dir, ref) {
  const raw = String(ref || '');
  if (!raw) return false;
  const marker = raw.lastIndexOf('artifacts/');
  const relName = marker >= 0 ? raw.slice(marker + 'artifacts/'.length) : raw.split('/').pop();
  if (!relName || relName.includes('..')) return false;
  const artifactsDir = resolve(join(dir, 'artifacts'));
  const abs = resolve(join(artifactsDir, relName));
  if (abs !== artifactsDir && !abs.startsWith(`${artifactsDir}/`)) return false;
  try {
    // 防软链接逃逸/跨 mission 借用(对抗审查返工)：statSync 会跟随软链接，写 mission 目录者(=gate 不该信任
    // 的一方)可放软链接指向 mission 外文件或别 mission 的 evidence 冒充"本 mission 真实产出"。realpath 解析
    // 真实路径后重新断言仍落在本 mission artifacts 内，再判是不是真文件，堵死软链接逃逸 + 跨 mission 借用。
    const realArtifacts = realpathSync(artifactsDir);
    const realFile = realpathSync(abs);
    if (realFile !== realArtifacts && !realFile.startsWith(`${realArtifacts}/`)) return false;
    const st = statSync(realFile);
    // 防文件系统层借用(对抗审查返工)：realpath 堵软链接逃逸/跨 mission 借用，nlink>1 堵硬链接借用(把别处文件
    // 硬链进来冒充本 mission 产出；evidence 正常应是独立新文件 nlink=1)。两招覆盖"借别处文件冒充"全部路径。
    // 已知残留(优先级中低)：文件真实存在且独立、但"内容被伪造"防不住——根治需 coverage-table 记 evidence sha256、
    // 本 gate 校验内容哈希(超本次 scope，属上游产 evidence 时的契约升级)。
    return st.isFile() && st.nlink === 1;
  } catch { return false; }
}

// B1.2 窗口锚点：取某类事件流里最晚的真实时间戳（写进 events.jsonl 的事件比可写的 state 字段难伪造）。
function latestEventTimeMs(events, type) {
  let best = null;
  for (const event of events) {
    if (String(event?.type) !== type) continue;
    const t = timestampMs(event?.at) ?? timestampMs(event?.ts) ?? timestampMs(event?.timestamp);
    if (t !== null && (best === null || t > best)) best = t;
  }
  return best;
}

function missionDurationMs(mission) {
  const metadataDuration = Number(mission?.metadata?.durationMs);
  if (Number.isFinite(metadataDuration) && metadataDuration > 0) return metadataDuration;
  const criterion = (mission?.completionCriteria || []).find((item) => item?.type === 'mission_elapsed_at_least_ms');
  const criterionDuration = Number(criterion?.minElapsedMs);
  return Number.isFinite(criterionDuration) && criterionDuration > 0 ? criterionDuration : 0;
}

export function summarizeMissionDir(dir) {
  const mission = readJson(join(dir, 'mission.json'));
  const state = readJson(join(dir, 'state.json'));
  if (!mission || !state) return null;
  const events = readEvents(join(dir, 'events.jsonl'));
  const eventCounts = countByType(events);
  const artifacts = artifactCounts(dir);
  const coverage = readJson(join(dir, 'artifacts', 'coverage-table.json'));
  const finalReport = readJson(join(dir, 'artifacts', 'final-report.json'));
  const updatedAtMs = timestampMs(state.updatedAt) ?? statSync(join(dir, 'state.json')).mtimeMs;
  const createdAtMs = timestampMs(state.createdAt) ?? updatedAtMs;
  const durationMs = missionDurationMs(mission);
  const requiredEvidence = Array.isArray(coverage?.requiredEvidence) ? coverage.requiredEvidence : [];
  const readableRequired = requiredEvidence.filter((item) => item?.readable).length;
  // B1.2：真实存在可读的 evidence 文件数——核验每个 ref 指向的文件，不只信 coverage-table 的 readable 声明。
  const evidenceFilesPresent = requiredEvidence.filter((item) => evidenceFileReadable(dir, item?.ref)).length;
  const tracksFinalReportLinks = requiredEvidence.some((item) => Object.hasOwn(item || {}, 'inFinalReport'));
  const inFinalReportRequired = requiredEvidence.filter((item) => item?.inFinalReport).length;
  const requiredEvidenceRefs = Array.isArray(finalReport?.requiredEvidenceRefs) ? finalReport.requiredEvidenceRefs : [];
  const requiredEvidenceTraced = tracksFinalReportLinks
    ? inFinalReportRequired === requiredEvidence.length
    : requiredEvidenceRefs.length >= requiredEvidence.length;
  const minSummaryCount = Math.max(1, Math.floor(durationMs / (Number(mission?.metadata?.summaryEveryMs) || 60 * 60 * 1000)));
  const expectedCheckpointCount = Number(mission?.metadata?.checkpointCount) || artifacts.soakCheckpoints;
  // B1.2：state.status 自报 succeeded 必须有真实 mission.succeeded 事件佐证；观察窗口锚点取
  // 「真实 succeeded 事件时间」与「state.updatedAt」的较晚者，防把 updatedAt 写早来提前满足观察窗口
  // （取较晚=保守，绝不让被操纵的早时间戳提前放行）。
  const succeededEventMs = latestEventTimeMs(events, 'mission.succeeded');
  // 安全(对抗审查返工)：succeeded 不仅要"有事件"，还要"带可解析时间戳"——否则 observationAnchorMs 会
  // fallback 到可写的 updatedAt 被提前开门。无/空/非法时间戳的 succeeded 视为不合格，绝不退回 updatedAt 当锚点。
  const hasSucceededEvent = succeededEventMs !== null;
  const observationAnchorMs = succeededEventMs !== null ? Math.max(updatedAtMs, succeededEventMs) : updatedAtMs;
  // 已知残留(自我约束威胁模型下优先级中低)：updatedAt 与 succeeded at 都是 mission 自报、可被写 mission 者整体
  // 写早来提前开窗；取 max + 要求 succeeded 带时间戳已堵无意/低成本绕过，根治整体时间伪造需外部可信时钟锚点(超本次 scope)。
  const qualifiesLongSoak = mission?.metadata?.kind === 'p8_long_soak'
    && state.status === 'succeeded'
    && state.phase === 'complete'
    && durationMs >= DEFAULT_MIN_SOAK_MS
    && artifacts.soakCheckpoints >= expectedCheckpointCount
    && artifacts.runSummaries >= minSummaryCount
    && artifacts.hasCoverage
    && artifacts.hasFinalReport
    && artifacts.hasFinalization
    && coverage?.ok === true
    && finalReport?.ok === true
    && requiredEvidence.length > 0
    && readableRequired === requiredEvidence.length
    && evidenceFilesPresent === requiredEvidence.length
    && hasSucceededEvent
    && requiredEvidenceTraced;

  return {
    missionId: mission.missionId || state.missionId || dir.split('/').pop(),
    ref: rel(dir),
    kind: mission?.metadata?.kind || 'unknown',
    status: state.status || 'unknown',
    phase: state.phase || 'unknown',
    cursor: state.current_cursor ?? null,
    slice: state.current_slice ?? null,
    recoveryAttempts: Number(state.recovery_attempts || 0),
    blockers: Array.isArray(state.blockers) ? state.blockers : [],
    createdAt: new Date(createdAtMs).toISOString(),
    completedAt: state.status === 'succeeded' ? new Date(updatedAtMs).toISOString() : null,
    createdAtMs,
    updatedAtMs,
    observationAnchorMs,
    hasSucceededEvent,
    durationMs,
    expectedCheckpointCount,
    minSummaryCount,
    eventCounts,
    artifacts,
    coverage: {
      ok: coverage?.ok === true,
      requiredTotal: requiredEvidence.length,
      requiredReadable: readableRequired,
      requiredFilesPresent: evidenceFilesPresent,
      requiredInFinalReport: inFinalReportRequired,
      tracksFinalReportLinks,
      requiredEvidenceTraced,
    },
    finalReport: {
      ok: finalReport?.ok === true,
      requiredEvidenceRefs: requiredEvidenceRefs.length,
    },
    qualifiesLongSoak,
  };
}

export function scanMissionRoot(missionRoot = DEFAULT_MISSION_ROOT) {
  const root = resolve(missionRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => summarizeMissionDir(join(root, entry.name)))
    .filter(Boolean)
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

function chooseBaseline(missions, baselineId = '') {
  if (baselineId) return missions.find((mission) => mission.missionId === baselineId) || null;
  return missions
    .filter((mission) => mission.kind === 'p8_long_soak' && mission.qualifiesLongSoak)
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0] || null;
}

export function buildP8ObservationGateReport({
  missionRoot = DEFAULT_MISSION_ROOT,
  baselineId = '',
  minObservationDays = DEFAULT_MIN_OBSERVATION_DAYS,
  maxObservationDays = DEFAULT_MAX_OBSERVATION_DAYS,
  minSoakMs = DEFAULT_MIN_SOAK_MS,
  nowMs = Date.now(),
} = {}) {
  const missions = scanMissionRoot(missionRoot);
  const baseline = chooseBaseline(missions, baselineId);
  const blockers = [];
  const warnings = [];
  if (!baseline) blockers.push(baselineId ? 'baseline_long_soak_not_found' : 'qualified_p8_long_soak_missing');
  if (baseline && !baseline.qualifiesLongSoak) blockers.push('baseline_long_soak_not_qualified');
  if (baseline && baseline.durationMs < minSoakMs) blockers.push('baseline_soak_duration_too_short');

  const observationMs = baseline ? Math.max(0, Number(nowMs) - baseline.observationAnchorMs) : 0;
  const observationDays = observationMs / DAY_MS;
  if (baseline && observationDays < minObservationDays) blockers.push('observation_window_not_elapsed');
  if (baseline && observationDays > maxObservationDays) warnings.push('observation_window_exceeds_nominal_range');

  const afterBaseline = baseline ? missions.filter((mission) => mission.updatedAtMs >= baseline.updatedAtMs) : [];
  const unsettledLongSoaks = afterBaseline.filter((mission) => (
    mission.kind === 'p8_long_soak'
    && !['succeeded', 'cancelled'].includes(String(mission.status))
  ));
  if (unsettledLongSoaks.length) blockers.push('unsettled_p8_long_soak_exists');
  if (baseline && baseline.recoveryAttempts > 0) warnings.push('baseline_recovered_from_runner_interruptions');

  const gateReady = blockers.length === 0;
  return {
    schemaVersion: 1,
    generatedAt: new Date(Number(nowMs)).toISOString(),
    ok: Boolean(baseline && baseline.qualifiesLongSoak),
    policy: {
      readOnly: true,
      noLivePortsTouched: true,
      noModelCalls: true,
      noSecretsRead: true,
      nextStageMustWaitForGate: true,
    },
    source: {
      missionRoot: rel(missionRoot),
      missionCount: missions.length,
      baselineId: baseline?.missionId || baselineId || null,
    },
    gate: {
      name: 'p8_post_long_soak_observation_gate',
      readyForNextStage: gateReady,
      minObservationDays,
      maxObservationDays,
      observationDays: Number(observationDays.toFixed(4)),
      observationStartedAt: baseline ? new Date(baseline.observationAnchorMs).toISOString() : null,
      earliestNextStageAt: baseline ? new Date(baseline.observationAnchorMs + minObservationDays * DAY_MS).toISOString() : null,
      blockers,
      warnings,
      recommendation: gateReady
        ? 'ready_for_p7_j0_lite_or_next_stage_review'
        : 'continue_observation_do_not_start_p9_or_research_bridge',
    },
    baseline: baseline ? {
      missionId: baseline.missionId,
      ref: baseline.ref,
      status: baseline.status,
      phase: baseline.phase,
      cursor: baseline.cursor,
      slice: baseline.slice,
      durationMs: baseline.durationMs,
      recoveryAttempts: baseline.recoveryAttempts,
      eventCounts: {
        heartbeat: baseline.eventCounts['mission.heartbeat'] || 0,
        checkpoint: baseline.eventCounts['mission.checkpoint.written'] || 0,
        summary: baseline.eventCounts['mission.run_summary.written'] || 0,
        succeeded: baseline.eventCounts['mission.succeeded'] || 0,
      },
      artifacts: baseline.artifacts,
      coverage: baseline.coverage,
      finalReport: baseline.finalReport,
      qualifiesLongSoak: baseline.qualifiesLongSoak,
    } : null,
    stability: {
      missionsAfterBaseline: afterBaseline.length,
      unsettledLongSoakIds: unsettledLongSoaks.map((mission) => mission.missionId),
      succeededLongSoaks: missions.filter((mission) => mission.kind === 'p8_long_soak' && mission.status === 'succeeded').length,
      qualifiedLongSoaks: missions.filter((mission) => mission.kind === 'p8_long_soak' && mission.qualifiesLongSoak).length,
    },
    nextAllowedWork: gateReady
      ? ['P7-J0-lite mission-runtime integration review', 'P7-H0 failure modes completion if still below threshold']
      : ['daily observation snapshot', 'do not start P9-A0/P9-D0/P9-G0/R line from this gate'],
  };
}

export function writeObservationGateReport(report, outDir = DEFAULT_OUT_DIR) {
  mkdirSync(outDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  const dir = join(outDir, stamp);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'report.json');
  const latest = join(outDir, 'latest.json');
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(file, payload);
  writeFileSync(latest, payload);
  return { file: rel(file), latest: rel(latest) };
}

export function runP8ObservationGate(options = {}) {
  const report = buildP8ObservationGateReport(options);
  const written = options.write === false ? null : writeObservationGateReport(report, options.outDir || DEFAULT_OUT_DIR);
  return { report, written };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs();
  const { report, written } = runP8ObservationGate(options);
  console.log(JSON.stringify({ ...report, written }, null, 2));
  if (!report.ok || (options.requireReady && !report.gate.readyForNextStage)) process.exitCode = 1;
}
