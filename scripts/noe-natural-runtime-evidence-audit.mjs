#!/usr/bin/env node
// @ts-check
// Read-only natural-runtime evidence audit for weak remaining lanes.
// This intentionally does not treat server imports, local drills, or text hits as
// natural invocation proof. It only summarizes structured runtime artifacts.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.NOE_NATURAL_RUNTIME_EVIDENCE_OUT_DIR || join(ROOT, 'output', 'noe-audit');
const OUT_BASE = process.env.NOE_NATURAL_RUNTIME_EVIDENCE_BASENAME || 'natural-runtime-evidence-audit-2026-06-15';

const DEFAULT_PATHS = {
  weakRuntimeRemainingLaneAudit: join(ROOT, 'output', 'noe-audit', 'weak-runtime-remaining-lane-audit-2026-06-15.json'),
  runtimeEvidence: join(ROOT, 'output', 'noe-runtime-evidence', 'latest.json'),
  workMap: join(ROOT, 'output', 'noe-work-map', 'latest.json'),
  longTaskFollowup: join(ROOT, 'output', 'noe-long-task-followup', 'latest.json'),
  memoryStatusDir: join(ROOT, 'output', 'noe-memory-status'),
};

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '', max = 240) {
  return String(value ?? '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [key]')
    .replace(/token[=:]\S+/gi, 'token=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function readJson(path) {
  if (!path || !existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

function rel(path) {
  return String(path || '').replace(`${ROOT}/`, '');
}

function inc(counts, key, amount = 1) {
  counts[key] = (counts[key] || 0) + amount;
}

function newestJsonInDir(dir) {
  if (!dir || !existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const path = join(dir, file);
      let mtimeMs = 0;
      try { mtimeMs = statSync(path).mtimeMs; } catch {}
      return { path, mtimeMs, file };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file))[0]?.path || '';
}

function targetFilesFromLaneAudit(laneAudit = {}) {
  return arr(laneAudit.files).filter((file) => file.naturalRuntimeNeeded === true);
}

function statusRank(status = '') {
  if (status === 'direct_structured_runtime_evidence') return 0;
  if (status === 'indirect_structured_runtime_signal') return 1;
  return 2;
}

function summarizeCommonArtifacts({ runtimeEvidence = {}, workMap = {}, longTaskFollowup = {}, memoryStatus = {} } = {}) {
  return {
    panelHealthOk: runtimeEvidence.panel?.health?.ok === true,
    panelReadinessOk: runtimeEvidence.panel?.readiness?.ok === true || runtimeEvidence.panel?.readiness?.status === 'passed',
    panelUptimeSec: runtimeEvidence.panel?.health?.uptimeSec ?? null,
    runtimeProcessCwdOk: runtimeEvidence.memory?.runtimeProcess?.primaryCwdMatchesExpected === true,
    heartbeatDone1h: Number(runtimeEvidence.heartbeat?.recentDone1h || 0),
    heartbeatByKind1h: runtimeEvidence.heartbeat?.byKind1h || {},
    actsRecent24h: Number(runtimeEvidence.acts?.recent24h || 0),
    actsWithEvidence: Number(runtimeEvidence.acts?.withEvidence || 0),
    workMapActiveRooms: Number(workMap.counts?.rooms?.activeCount || 0),
    workMapAutopilotSucceeded: Number(workMap.counts?.autopilot?.statusCounts?.succeeded || 0),
    longTaskLaunchdRunning: longTaskFollowup.scheduler?.state === 'running',
    longTaskLaunchdRuns: Number(longTaskFollowup.scheduler?.runs || 0),
    memoryVoiceEntries: Number(runtimeEvidence.memory?.counts?.byScope?.voice ?? memoryStatus.status?.counts?.byScope?.voice ?? memoryStatus.memory?.byScope?.voice ?? 0),
    memoryVoiceNotes: Number(memoryStatus.status?.counts?.bySourceType?.voice_note ?? memoryStatus.memory?.bySourceType?.voice_note ?? 0),
  };
}

function evidenceForFile(file = '', common = {}) {
  const bootEvidence = {
    livePanelOk: common.panelHealthOk && common.panelReadinessOk,
    runtimeProcessCwdOk: common.runtimeProcessCwdOk,
    panelUptimeSec: common.panelUptimeSec,
  };
  const missing = (remainingNeed) => ({
    naturalEvidenceStatus: 'missing_structured_runtime_evidence',
    evidence: bootEvidence,
    remainingNeed,
  });
  const indirect = (evidence, remainingNeed) => ({
    naturalEvidenceStatus: 'indirect_structured_runtime_signal',
    evidence: {
      ...bootEvidence,
      ...evidence,
    },
    remainingNeed,
  });

  if (file === 'src/autopilot/AutopilotScheduler.js') {
    if (common.workMapAutopilotSucceeded > 0) {
      return indirect({
        workMapAutopilotSucceeded: common.workMapAutopilotSucceeded,
      }, 'work-map has historical autopilot succeeded jobs; add live scheduler tick/run status or recent autopilot run timestamp to prove current natural invocation');
    }
    return missing('need readonly autopilot schedule/job/run summary with recent tick or executed job timestamp');
  }
  if (file === 'src/autopilot/AutopilotController.js') {
    if (common.workMapAutopilotSucceeded > 0) {
      return indirect({
        workMapAutopilotSucceeded: common.workMapAutopilotSucceeded,
      }, 'historical autopilot jobs exist; need recent room event -> controller rule log or readonly controller status to prove natural invocation');
    }
    return missing('need readonly autopilot rule/event log or recent controller-triggered room forward/notify evidence');
  }
  if (file === 'src/prefetch/NoePrefetchStore.js') {
    const sleepTimeCompute = Number(common.heartbeatByKind1h?.sleeptimeCompute || 0);
    if (sleepTimeCompute > 0) {
      return indirect({
        heartbeatSleeptimeCompute1h: sleepTimeCompute,
      }, 'sleeptimeCompute heartbeat suggests the prefetch path may run; need prefetch hit/set/prune counters or readonly store status');
    }
    return missing('need readonly prefetch store counters or recent sleeptimeCompute evidence tied to set/get/prune');
  }
  if (file === 'src/identity/Voiceprint.js') {
    if (common.memoryVoiceEntries > 0 || common.memoryVoiceNotes > 0) {
      return indirect({
        memoryVoiceEntries: common.memoryVoiceEntries,
        memoryVoiceNotes: common.memoryVoiceNotes,
      }, 'voice memories exist, but this does not prove Voiceprint embedding/scoring ran; need voice session identity/verification counter or fixture-linked natural session evidence');
    }
    return missing('need voice session identity verification counter or natural voiceprint scoring evidence');
  }
  if (file === 'src/autopilot/NoeHangAlert.js') {
    if (common.longTaskLaunchdRunning && common.longTaskLaunchdRuns > 0) {
      return indirect({
        longTaskLaunchdRunning: true,
        longTaskLaunchdRuns: common.longTaskLaunchdRuns,
      }, 'launchd long-task followup is running, but that is not NoeHangAlert; need hang-alert monitor check/alert/beat counter');
    }
    return missing('need readonly hang-alert monitor counters for started jobs, heartbeats, stale alerts, and cleared alerts');
  }
  if ([
    'src/metrics/MetricsStore.js',
    'src/mcp/McpStore.js',
    'src/templates/RoomTemplatesStore.js',
    'src/webhook/WebhookStore.js',
    'src/watcher/WatcherDispatcher.js',
    'src/webhook/WebhookDispatcher.js',
    'src/watcher/WatcherConfig.js',
    'src/capabilities/NoeCapabilityTrigger.js',
  ].includes(file)) {
    return missing('server boot/load is proven separately; need readonly status/counters from the owning route/store or a recent natural event timestamp');
  }
  if ([
    'src/cost/CostTracker.js',
    'src/state/AgentStateMachine.js',
    'src/planner/FocusChain.js',
  ].includes(file)) {
    if (common.actsRecent24h > 0 || common.actsWithEvidence > 0) {
      return indirect({
        actsRecent24h: common.actsRecent24h,
        actsWithEvidence: common.actsWithEvidence,
      }, 'action/runtime activity exists, but it is not tied to claude-runner service internals; need recent service runner session evidence or per-session state/cost/focus counters');
    }
    return missing('need managed service-runner evidence or recent session counters tied to state machine, cost tracker, and focus chain');
  }
  return missing('no module-specific structured natural runtime evidence rule yet');
}

export function buildNoeNaturalRuntimeEvidenceAudit({
  root = ROOT,
  paths = DEFAULT_PATHS,
  now = new Date(),
} = {}) {
  const resolvedPaths = { ...DEFAULT_PATHS, ...paths };
  const memoryStatusPath = resolvedPaths.memoryStatus || newestJsonInDir(resolvedPaths.memoryStatusDir);
  const weakRemaining = readJson(resolvedPaths.weakRuntimeRemainingLaneAudit);
  const runtimeEvidence = readJson(resolvedPaths.runtimeEvidence);
  const workMap = readJson(resolvedPaths.workMap);
  const longTaskFollowup = readJson(resolvedPaths.longTaskFollowup);
  const memoryStatus = readJson(memoryStatusPath);
  const common = summarizeCommonArtifacts({ runtimeEvidence, workMap, longTaskFollowup, memoryStatus });
  const targets = targetFilesFromLaneAudit(weakRemaining);
  const files = targets
    .map((target) => ({
      file: target.file,
      lane: target.lane,
      module: clean(target.module || '', 120),
      reviewClass: target.reviewClass,
      ...evidenceForFile(target.file, common),
    }))
    .sort((a, b) => statusRank(a.naturalEvidenceStatus) - statusRank(b.naturalEvidenceStatus)
      || a.lane.localeCompare(b.lane)
      || a.file.localeCompare(b.file));

  const statusCounts = {};
  const laneCounts = {};
  for (const file of files) {
    inc(statusCounts, file.naturalEvidenceStatus);
    inc(laneCounts, file.lane);
  }

  return {
    ok: true,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    root: weakRemaining.root || root,
    inputs: {
      weakRuntimeRemainingLaneAudit: rel(resolvedPaths.weakRuntimeRemainingLaneAudit),
      weakRuntimeRemainingLaneAuditGeneratedAt: weakRemaining.generatedAt || '',
      runtimeEvidence: rel(resolvedPaths.runtimeEvidence),
      runtimeEvidenceGeneratedAt: runtimeEvidence.generatedAt || '',
      workMap: rel(resolvedPaths.workMap),
      workMapGeneratedAt: workMap.generatedAt || '',
      longTaskFollowup: rel(resolvedPaths.longTaskFollowup),
      longTaskFollowupGeneratedAt: longTaskFollowup.generatedAt || '',
      memoryStatus: rel(memoryStatusPath),
      memoryStatusGeneratedAt: memoryStatus.generatedAt || '',
    },
    policy: {
      readOnlyArtifacts: true,
      noDbReads: true,
      noDbWrites: true,
      noEnvFileReads: true,
      noOwnerTokenReads: true,
      noProtectedApiAuth: true,
      noLiveHttpRequests: true,
      noModelCalls: true,
      noResponseBodiesStored: true,
      noSecretValuesReturned: true,
    },
    status: {
      audit: 'natural_runtime_evidence_audit_complete',
      completionClaim: 'not_complete',
      explanation: 'This audit accepts only structured runtime artifacts. Indirect signals do not prove natural module invocation.',
    },
    summary: {
      targetFiles: targets.length,
      directStructuredRuntimeEvidenceFiles: files.filter((file) => file.naturalEvidenceStatus === 'direct_structured_runtime_evidence').length,
      indirectStructuredRuntimeSignalFiles: files.filter((file) => file.naturalEvidenceStatus === 'indirect_structured_runtime_signal').length,
      missingStructuredRuntimeEvidenceFiles: files.filter((file) => file.naturalEvidenceStatus === 'missing_structured_runtime_evidence').length,
      naturalRuntimeProofStillNeeded: files.filter((file) => file.naturalEvidenceStatus !== 'direct_structured_runtime_evidence').length,
      statusCounts,
      laneCounts,
      common,
    },
    files,
  };
}

function mdTable(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function evidenceSummary(evidence = {}) {
  return Object.entries(evidence)
    .filter(([, value]) => value !== undefined && value !== null && value !== '' && value !== false)
    .slice(0, 8)
    .map(([key, value]) => `${key}:${Array.isArray(value) ? value.length : clean(value, 80)}`)
    .join('<br>') || '-';
}

export function renderMarkdown(report, jsonPath = '') {
  const rows = report.files.map((file) => [
    `\`${file.file}\``,
    file.lane,
    file.naturalEvidenceStatus,
    evidenceSummary(file.evidence || {}),
    clean(file.remainingNeed || '-', 180),
  ]);
  return [
    '# Noe Natural Runtime Evidence Audit',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Verdict',
    '',
    `- audit: \`${report.status.audit}\``,
    `- completion claim: \`${report.status.completionClaim}\``,
    `- explanation: ${report.status.explanation}`,
    '',
    '## Summary',
    '',
    `- target files: ${report.summary.targetFiles}`,
    `- direct structured runtime evidence: ${report.summary.directStructuredRuntimeEvidenceFiles}`,
    `- indirect structured runtime signals: ${report.summary.indirectStructuredRuntimeSignalFiles}`,
    `- missing structured runtime evidence: ${report.summary.missingStructuredRuntimeEvidenceFiles}`,
    `- natural runtime proof still needed: ${report.summary.naturalRuntimeProofStillNeeded}`,
    '',
    '## Files',
    '',
    mdTable([
      ['file', 'lane', 'natural evidence status', 'evidence', 'remaining need'],
      ['---', '---', '---', '---', '---'],
      ...rows,
    ]),
    '',
    '## Interpretation',
    '',
    '- `direct_structured_runtime_evidence` would require a module-specific readonly counter/status/recent timestamp.',
    '- `indirect_structured_runtime_signal` means related runtime activity exists but does not prove the target module naturally ran.',
    '- Server import wiring and isolated local drills remain valuable component evidence, but they are not natural invocation proof.',
    '',
    '## JSON',
    '',
    jsonPath ? `Full report: \`${jsonPath.replace(`${ROOT}/`, '')}\`.` : 'No JSON path supplied.',
  ].join('\n');
}

export function writeNoeNaturalRuntimeEvidenceAudit(report) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${OUT_BASE}.json`);
  const mdPath = join(OUT_DIR, `${OUT_BASE}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mdPath, `${renderMarkdown(report, jsonPath)}\n`, { mode: 0o600 });
  return { jsonPath, mdPath };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = buildNoeNaturalRuntimeEvidenceAudit();
  const paths = writeNoeNaturalRuntimeEvidenceAudit(report);
  console.log(JSON.stringify({
    ok: report.ok,
    audit: report.status.audit,
    targetFiles: report.summary.targetFiles,
    directStructuredRuntimeEvidenceFiles: report.summary.directStructuredRuntimeEvidenceFiles,
    indirectStructuredRuntimeSignalFiles: report.summary.indirectStructuredRuntimeSignalFiles,
    missingStructuredRuntimeEvidenceFiles: report.summary.missingStructuredRuntimeEvidenceFiles,
    naturalRuntimeProofStillNeeded: report.summary.naturalRuntimeProofStillNeeded,
    paths,
  }, null, 2));
}
