// @ts-check
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { redactSensitiveText } from '../NoeContextScrubber.js';
import { createQualityAuditActionExecutors } from './NoeMissionQualityAudit.js';

const DEFAULT_DURATION_MS = 7 * 60 * 60 * 1000;
const DEFAULT_CHECKPOINT_EVERY_MS = 15 * 60 * 1000;
const DEFAULT_SUMMARY_EVERY_MS = 60 * 60 * 1000;
const DEFAULT_HEARTBEAT_EVERY_MS = 60 * 1000;

function clean(value, max = 4000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function artifactRef(missionId, name) {
  return `output/noe-missions/${missionId}/artifacts/${name}`;
}

function pad(n) {
  return String(n).padStart(4, '0');
}

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, Math.max(0, Number(ms) || 0)));
}

async function sleepWithHeartbeat(totalMs, { sleepFn, heartbeatEveryMs, heartbeat } = {}) {
  let remainingMs = Math.max(0, Number(totalMs) || 0);
  const intervalMs = Math.max(0, Number(heartbeatEveryMs) || 0);
  if (remainingMs <= 0) return;
  if (intervalMs <= 0 || intervalMs >= remainingMs) {
    await sleepFn(remainingMs);
    await heartbeat?.();
    return;
  }
  while (remainingMs > 0) {
    const chunkMs = Math.min(remainingMs, intervalMs);
    await sleepFn(chunkMs);
    remainingMs -= chunkMs;
    await heartbeat?.();
  }
}

function runReadOnlyCommand(command, { cwd } = {}) {
  return new Promise((resolvePromise) => {
    const [bin, ...args] = Array.isArray(command) ? command : [];
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    const child = spawn(bin, args, { cwd, shell: false, env: process.env });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      resolvePromise({ exitCode: 127, stdout, stderr: `${stderr}\n${error.message}`, durationMs: Date.now() - startedAt });
    });
    child.on('close', (code) => {
      resolvePromise({ exitCode: Number(code), stdout, stderr, durationMs: Date.now() - startedAt });
    });
  });
}

export function createLongSoakMissionContract({
  missionId = `p8-long-soak-${Date.now()}`,
  durationMs = DEFAULT_DURATION_MS,
  checkpointEveryMs = DEFAULT_CHECKPOINT_EVERY_MS,
  summaryEveryMs = DEFAULT_SUMMARY_EVERY_MS,
  heartbeatEveryMs = DEFAULT_HEARTBEAT_EVERY_MS,
} = {}) {
  const totalDurationMs = positive(durationMs, DEFAULT_DURATION_MS);
  const intervalMs = positive(checkpointEveryMs, DEFAULT_CHECKPOINT_EVERY_MS);
  const hourlyMs = positive(summaryEveryMs, DEFAULT_SUMMARY_EVERY_MS);
  const heartbeatMs = Math.min(intervalMs, positive(heartbeatEveryMs, DEFAULT_HEARTBEAT_EVERY_MS));
  const checkpointCount = Math.max(1, Math.ceil(totalDurationMs / intervalMs));
  const checkpointRefs = Array.from({ length: checkpointCount }, (_, index) => (
    artifactRef(missionId, `soak-checkpoint-${pad(index + 1)}.json`)
  ));
  const inventoryRef = artifactRef(missionId, 'repo-inventory.json');
  const observationRef = artifactRef(missionId, 'self-observation.json');
  const coverageRef = artifactRef(missionId, 'coverage-table.json');
  const reportRef = artifactRef(missionId, 'final-report.json');
  const requiredRefs = [inventoryRef, ...checkpointRefs, observationRef, coverageRef];
  const minSummaryCount = Math.max(1, Math.floor(totalDurationMs / hourlyMs));

  return {
    missionId,
    objective: 'Run a read-only P8 long-soak mission for repository quality/readiness evidence without changing code.',
    scope: ['read repository files', 'run local read-only status probes', 'write output/noe-missions/**'],
    forbidden: ['.env', 'secret values', '51735', 'games/cartoon-apocalypse/**', 'live write', 'external write', 'git reset', 'git clean'],
    autonomyLevel: 'read_only',
    rollbackPlan: ['Remove output/noe-missions/<missionId> if the generated local soak evidence is no longer needed.'],
    reviewPolicy: {
      ownerGate: ['external_write', 'live_write', 'delete', 'publish', 'secret_access'],
      reviewBrain: ['code_write', 'self_evolution_apply', 'identity_memory_write'],
    },
    expectedArtifacts: [
      { id: 'coverage_table', type: 'coverage_table', ref: coverageRef },
      { id: 'final_report', type: 'final_report', ref: reportRef },
    ],
    evidenceRequirements: requiredRefs.map((ref, index) => ({ id: `soak-required-${index + 1}`, ref, required: true })),
    completionCriteria: [
      ...requiredRefs.map((ref, index) => ({ id: `soak-evidence-${index + 1}`, type: 'evidence_ref_exists', ref })),
      { id: 'soak-duration-reached', type: 'mission_elapsed_at_least_ms', minElapsedMs: totalDurationMs },
      { id: 'soak-checkpoint-count', type: 'event_type_count_at_least', eventType: 'mission.checkpoint.written', minCount: checkpointCount },
      { id: 'soak-summary-count', type: 'event_type_count_at_least', eventType: 'mission.run_summary.written', minCount: minSummaryCount },
      { id: 'final-report-traces-soak-refs', type: 'final_report_traces_evidence', reportRef, evidenceRefs: requiredRefs },
      { id: 'no-open-blockers', type: 'no_unresolved_blockers' },
      { id: 'no-truncation', type: 'no_truncated_results' },
    ],
    metadata: {
      kind: 'p8_long_soak',
      durationMs: totalDurationMs,
      checkpointEveryMs: intervalMs,
      summaryEveryMs: hourlyMs,
      heartbeatEveryMs: heartbeatMs,
      checkpointCount,
    },
    plan: [
      { id: 'repo-inventory', type: 'repo_inventory', name: 'repo-inventory.json' },
      ...checkpointRefs.map((ref, index) => ({
        id: `soak-checkpoint-${pad(index + 1)}`,
        type: 'soak_checkpoint',
        name: ref.split('/').pop(),
        checkpointIndex: index + 1,
        checkpointCount,
        waitMs: intervalMs,
        heartbeatEveryMs: heartbeatMs,
      })),
      { id: 'observe-thinking', type: 'self_observation', name: 'self-observation.json' },
      { id: 'coverage-table', type: 'coverage_table', name: 'coverage-table.json' },
      { id: 'final-report', type: 'soak_final_report', name: 'final-report.json', evidenceRefs: requiredRefs },
    ],
  };
}

export function createLongSoakActionExecutors({ root, store, sleepFn = sleep, nowMs = Date.now } = {}) {
  const cwd = resolve(root || process.cwd());
  return {
    ...createQualityAuditActionExecutors({ root: cwd, store }),
    soak_checkpoint: async ({ mission, action, runner }) => {
      const waitMs = Math.max(0, Number(action.waitMs) || 0);
      const heartbeatEveryMs = Math.min(waitMs || DEFAULT_HEARTBEAT_EVERY_MS, positive(action.heartbeatEveryMs, DEFAULT_HEARTBEAT_EVERY_MS));
      const startedAtMs = Number(nowMs());
      if (waitMs > 0) {
        await sleepWithHeartbeat(waitMs, {
          sleepFn,
          heartbeatEveryMs,
          heartbeat: async () => {
            runner.store.heartbeat(mission.missionId, {
              runnerId: runner.runnerId,
              ttlMs: runner.leaseTtlMs,
              nowMs: Number(nowMs()),
            });
          },
        });
      }
      const status = await runReadOnlyCommand(['git', 'status', '--short', '--untracked-files=no'], { cwd });
      const finishedAtMs = Number(nowMs());
      const statusLines = String(status.stdout || '').split('\n').filter(Boolean);
      const payload = {
        ok: status.exitCode === 0,
        kind: 'mission_soak_checkpoint',
        checkpointIndex: Number(action.checkpointIndex || 0),
        checkpointCount: Number(action.checkpointCount || 0),
        waitMs,
        heartbeatEveryMs,
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: new Date(finishedAtMs).toISOString(),
        elapsedMs: Math.max(0, finishedAtMs - startedAtMs),
        repoStatusExitCode: status.exitCode,
        repoStatusDirtyLineCount: statusLines.length,
        repoStatusPreview: statusLines.slice(0, 40).map((line) => clean(line, 300)),
      };
      const artifact = runner.store.writeArtifact(mission.missionId, action.name || `soak-checkpoint-${pad(action.checkpointIndex || 0)}.json`, payload, { nowMs: finishedAtMs });
      return {
        ok: payload.ok,
        artifactRef: artifact.ref,
        evidenceRefs: [artifact.ref],
        commandId: action.id,
        exitCode: payload.ok ? 0 : 1,
        unverified: !payload.ok,
      };
    },
    soak_final_report: async ({ mission, action, runner }) => {
      const state = runner.store.readState(mission.missionId);
      const events = runner.store.readEvents(mission.missionId, { limit: 5000 });
      const evidenceRefs = (action.evidenceRefs || []).map((ref) => clean(ref, 1000));
      const checkpointEvents = events.filter((event) => event.type === 'mission.checkpoint.written');
      const summaryEvents = events.filter((event) => event.type === 'mission.run_summary.written');
      const blockers = state.blockers || [];
      const payload = {
        ok: blockers.length === 0,
        kind: 'mission_soak_final_report',
        missionId: mission.missionId,
        objective: mission.objective,
        statusBeforeCriteria: state.status,
        currentSlice: state.current_slice,
        currentCursor: state.current_cursor,
        checkpointEvents: checkpointEvents.length,
        summaryEvents: summaryEvents.length,
        requiredEvidenceRefs: evidenceRefs,
        evidenceRefs,
        readinessRepairPlan: [
          'Review coverage-table.json for missing evidence or nonzero read-only probes.',
          'If the long soak was killed, resume with the same mission id and require mission.lease.stale_recovered evidence.',
          'Do not mark P8 complete until a real 7-8h run satisfies duration, checkpoint, summary, criteria, and reconciler gates.',
        ],
      };
      const at = Number(nowMs());
      const artifact = runner.store.writeArtifact(mission.missionId, action.name || 'final-report.json', payload, { nowMs: at });
      runner.store.updateState(mission.missionId, (current) => ({ ...current, finalReportRef: artifact.ref }), { nowMs: at });
      return { ok: payload.ok, artifactRef: artifact.ref, evidenceRefs: [artifact.ref], reportRef: artifact.ref };
    },
  };
}
