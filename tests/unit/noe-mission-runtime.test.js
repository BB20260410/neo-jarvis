import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { NoeMissionStore } from '../../src/runtime/mission/NoeMissionStore.js';
import { NoeMissionCriteriaEngine } from '../../src/runtime/mission/NoeMissionCriteriaEngine.js';
import { NoeMissionReconciler } from '../../src/runtime/mission/NoeMissionReconciler.js';
import { NoeMissionRunner, buildMissionContext } from '../../src/runtime/mission/NoeMissionRunner.js';
import {
  createQualityAuditActionExecutors,
  createQualityAuditMissionContract,
} from '../../src/runtime/mission/NoeMissionQualityAudit.js';
import {
  createLongSoakActionExecutors,
  createLongSoakMissionContract,
} from '../../src/runtime/mission/NoeMissionLongSoak.js';

function missionContract(missionId = 'mission-test') {
  const proofRef = `output/noe-missions/${missionId}/artifacts/proof.json`;
  const observationRef = `output/noe-missions/${missionId}/artifacts/self-observation.json`;
  const reportRef = `output/noe-missions/${missionId}/artifacts/final-report.json`;
  return {
    missionId,
    objective: 'finish a long mission only after evidence is reconciled',
    scope: ['output/noe-missions/**'],
    forbidden: ['.env', '51735', 'games/cartoon-apocalypse/**'],
    completionCriteria: [
      { id: 'proof-readable', type: 'evidence_ref_exists', ref: proofRef },
      { id: 'self-observation-readable', type: 'evidence_ref_exists', ref: observationRef },
      { id: 'report-traces-evidence', type: 'final_report_traces_evidence', evidenceRefs: [proofRef, observationRef] },
      { id: 'no-blockers', type: 'no_unresolved_blockers' },
      { id: 'no-truncation', type: 'no_truncated_results' },
    ],
    evidenceRequirements: [
      { id: 'proof', ref: proofRef, required: true },
      { id: 'self-observation', ref: observationRef, required: true },
    ],
    rollbackPlan: ['remove output/noe-missions/<missionId> if the smoke output is not needed'],
    autonomyLevel: 'local_write',
    reviewPolicy: { ownerGate: ['external_write', 'live_write', 'delete'] },
    expectedArtifacts: [{ id: 'final_report', type: 'final_report', ref: reportRef }],
    plan: [
      { id: 'write-proof', type: 'write_artifact', name: 'proof.json', content: { ok: true } },
      { id: 'observe-thinking', type: 'self_observation', name: 'self-observation.json' },
      { id: 'write-report', type: 'final_report', name: 'final-report.json', evidenceRefs: [proofRef, observationRef] },
    ],
  };
}

async function withTempRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'noe-mission-runtime-'));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('Noe Mission Runtime', () => {
  it('creates a mission contract, durable state, events, and redacted files', () => withTempRoot((root) => {
    const store = new NoeMissionStore({ root });
    const secret = 'sk-unitsecret000000000000000000000000';
    const created = store.createMission({
      ...missionContract('store-redaction'),
      objective: `do not leak ${secret}`,
      metadata: { apiKey: secret },
    });

    expect(created.state).toMatchObject({
      missionId: 'store-redaction',
      status: 'running',
      current_cursor: 0,
      current_slice: 0,
      recovery_attempts: 0,
    });
    expect(existsSync(join(root, created.refs.mission))).toBe(true);
    expect(existsSync(join(root, created.refs.state))).toBe(true);
    expect(existsSync(join(root, created.refs.events))).toBe(true);
    const raw = readFileSync(join(root, created.refs.mission), 'utf8');
    expect(raw).not.toContain(secret);
    expect(raw).toContain('[redacted-openai-key]');
    expect(store.readEvents('store-redaction')[0].type).toBe('mission.created');
  }));

  it('refuses succeeded until required evidence and final report traceability exist', () => withTempRoot((root) => {
    const store = new NoeMissionStore({ root });
    store.createMission(missionContract('criteria'));
    const engine = new NoeMissionCriteriaEngine({ root });
    let mission = store.readMission('criteria');
    let state = store.readState('criteria');
    let events = store.readEvents('criteria');

    expect(engine.evaluate({ mission, state, events, root }).ok).toBe(false);

    const proof = store.writeArtifact('criteria', 'proof.json', { ok: true });
    const observation = store.writeArtifact('criteria', 'self-observation.json', { ok: true, kind: 'mission_self_observation' });
    const report = store.writeArtifact('criteria', 'final-report.json', {
      evidenceRefs: [proof.ref, observation.ref],
    });
    store.updateState('criteria', (current) => ({ ...current, finalReportRef: report.ref }));
    mission = store.readMission('criteria');
    state = store.readState('criteria');
    events = store.readEvents('criteria');

    expect(engine.evaluate({ mission, state, events, root })).toMatchObject({ ok: true, status: 'succeeded' });
  }));

  it('runs multiple slices until criteria and reconciliation allow succeeded', async () => withTempRoot(async (root) => {
    const store = new NoeMissionStore({ root });
    store.createMission(missionContract('runner'));
    const runner = new NoeMissionRunner({ root, store, runnerId: 'test-runner' });

    const result = await runner.runUntilTerminal('runner', { maxActions: 1, maxSlices: 10 });
    const state = store.readState('runner');
    const events = store.readEvents('runner', { limit: 200 });
    const report = readFileSync(join(root, state.finalReportRef), 'utf8');

    expect(result).toMatchObject({ ok: true, status: 'succeeded' });
    expect(result.slices.length).toBeGreaterThanOrEqual(3);
    expect(state).toMatchObject({ status: 'succeeded', current_cursor: 3 });
    expect(state.finalizationRef).toContain('finalization-');
    const finalization = JSON.parse(readFileSync(join(root, state.finalizationRef), 'utf8'));
    expect(finalization).toMatchObject({
      kind: 'mission_finalization',
      status: 'succeeded',
      completed: true,
      reason: 'criteria_and_reconciliation_ok',
    });
    expect(events.some((event) => event.type === 'mission.self_observation')).toBe(true);
    expect(events.some((event) => event.type === 'mission.finalization.written')).toBe(true);
    expect(report).toContain('self-observation.json');
  }));

  it('writes an explicit finalization artifact when caller slice limit pauses a mission', async () => withTempRoot(async (root) => {
    const store = new NoeMissionStore({ root });
    store.createMission(missionContract('slice-limit'));
    const runner = new NoeMissionRunner({ root, store, runnerId: 'slice-limit-runner' });

    const result = await runner.runUntilTerminal('slice-limit', { maxActions: 1, maxSlices: 1 });
    const state = store.readState('slice-limit');
    const events = store.readEvents('slice-limit', { limit: 200 });
    const finalization = JSON.parse(readFileSync(join(root, state.finalizationRef), 'utf8'));

    expect(result).toMatchObject({ ok: false, status: 'paused', reason: 'max_slices_reached_by_caller' });
    expect(state).toMatchObject({ status: 'paused', phase: 'paused', pauseReason: 'max_slices_reached_by_caller' });
    expect(finalization).toMatchObject({
      kind: 'mission_finalization',
      status: 'paused',
      completed: false,
      reason: 'max_slices_reached_by_caller',
      trigger: 'caller_slice_limit',
    });
    expect(finalization.blockers.length).toBeGreaterThan(0);
    expect(events.some((event) => event.type === 'mission.paused_by_caller_limit')).toBe(true);
    expect(events.some((event) => event.type === 'mission.finalization.written')).toBe(true);
  }));

  it('detects a stale lease and resumes from current cursor instead of restarting', async () => withTempRoot(async (root) => {
    const store = new NoeMissionStore({ root });
    store.createMission(missionContract('resume'));
    const acquired = store.acquireLease('resume', { runnerId: 'old-runner', ttlMs: 1, nowMs: 1000 });
    expect(acquired.ok).toBe(true);
    const runner = new NoeMissionRunner({ root, store, runnerId: 'new-runner', nowMs: () => 5000 });

    const result = await runner.runSlice('resume', { maxActions: 1 });
    const state = store.readState('resume');
    const events = store.readEvents('resume', { limit: 100 });

    expect(result.status).toBe('running');
    expect(state.current_cursor).toBe(1);
    expect(events.some((event) => event.type === 'mission.lease.stale_recovered')).toBe(true);
  }));

  it('writes elapsed time summaries across runner restarts instead of process uptime', async () => withTempRoot(async (root) => {
    const clock = { value: Date.parse('2026-06-13T00:00:00.000Z') };
    const nowMs = () => clock.value;
    const store = new NoeMissionStore({ root });
    store.createMission(missionContract('summary-catchup'), { nowMs: nowMs() });
    clock.value += 60 * 60 * 1000 + 1;
    const runner = new NoeMissionRunner({ root, store, runnerId: 'summary-catchup-runner', nowMs });

    const result = await runner.runUntilTerminal('summary-catchup', { maxActions: 1, maxSlices: 1, summaryEveryMs: 60 * 60 * 1000 });
    const events = store.readEvents('summary-catchup', { limit: 200 });
    const summaries = events.filter((event) => event.type === 'mission.run_summary.written');

    expect(result).toMatchObject({ ok: false, status: 'paused', reason: 'max_slices_reached_by_caller' });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ trigger: 'time_catchup', sliceCount: 0 });
  }));

  it('recovers an unexpired lease when the recorded runner process is gone', async () => withTempRoot(async (root) => {
    const store = new NoeMissionStore({ root });
    store.createMission(missionContract('dead-runner-lease'), { nowMs: 1000 });
    const acquired = store.acquireLease('dead-runner-lease', {
      runnerId: 'mission-runner-99999999',
      ttlMs: 60 * 60 * 1000,
      nowMs: 2000,
    });
    expect(acquired.ok).toBe(true);

    const resumed = store.acquireLease('dead-runner-lease', {
      runnerId: 'new-runner',
      ttlMs: 60 * 60 * 1000,
      nowMs: 3000,
    });
    const state = store.readState('dead-runner-lease');
    const events = store.readEvents('dead-runner-lease', { limit: 100 });

    expect(resumed.ok).toBe(true);
    expect(state).toMatchObject({ status: 'recovering', phase: 'recovering', recovery_attempts: 1 });
    expect(events.some((event) => event.type === 'mission.lease.stale_recovered' && event.reason === 'runner_process_dead')).toBe(true);
  }));

  it('moves repeated action errors to blocked instead of pretending done', async () => withTempRoot(async (root) => {
    const store = new NoeMissionStore({ root });
    store.createMission({ ...missionContract('blocked'), plan: [{ id: 'fail-a', type: 'fail', error: 'same-error' }] });
    const runner = new NoeMissionRunner({ root, store, runnerId: 'test-runner', repeatedErrorBlockAfter: 2 });

    await runner.runSlice('blocked', { maxActions: 1 });
    const second = await runner.runSlice('blocked', { maxActions: 1 });
    const state = store.readState('blocked');

    expect(second.status).toBe('blocked');
    expect(state.status).toBe('blocked');
    expect(state.blockers[0].reason).toContain('repeated_error:same-error');
  }));

  it('keeps truncated, unavailable, unverified, and no-output results in recovering', async () => withTempRoot(async (root) => {
    for (const [missionId, action] of [
      ['truncated', { id: 'a', type: 'record_truncated' }],
      ['unavailable', { id: 'a', type: 'record_unavailable', provider: 'unit-provider' }],
      ['unverified', { id: 'a', type: 'record_unverified' }],
      ['no-output', { id: 'a', type: 'record_no_output_watchdog' }],
    ]) {
      const store = new NoeMissionStore({ root });
      store.createMission({ ...missionContract(missionId), plan: [action] });
      const runner = new NoeMissionRunner({ root, store, runnerId: `runner-${missionId}` });
      const result = await runner.runSlice(missionId, { maxActions: 1 });
      const state = store.readState(missionId);
      const events = store.readEvents(missionId, { limit: 100 });

      expect(result.status).toBe('recovering');
      expect(state).toMatchObject({ status: 'recovering', phase: 'recovering', current_cursor: 0 });
      expect(events.some((event) => event.type === 'mission.action.recovering')).toBe(true);
    }
  }));

  it('routes high-risk actions to waiting_approval before side effects', async () => withTempRoot(async (root) => {
    const store = new NoeMissionStore({ root });
    store.createMission({
      ...missionContract('approval'),
      autonomyLevel: 'read_only',
      reviewPolicy: { ownerGate: ['external_write'], reviewBrain: ['identity_memory_write'] },
      plan: [
        {
          id: 'publish-external',
          type: 'write_artifact',
          autonomyLevel: 'external_write',
          risks: ['external_write'],
          name: 'should-not-run.json',
          content: { ok: true },
        },
      ],
    });
    const runner = new NoeMissionRunner({ root, store, runnerId: 'approval-runner' });

    const result = await runner.runUntilTerminal('approval', { maxActions: 1, maxSlices: 3 });
    const state = store.readState('approval');
    const events = store.readEvents('approval', { limit: 100 });

    expect(result).toMatchObject({ ok: false, status: 'waiting_approval' });
    expect(state).toMatchObject({ status: 'waiting_approval', phase: 'waiting_approval', current_cursor: 0, current_slice: 1 });
    expect(state.waitingApproval.reasons.join(' ')).toContain('owner_gate_required:external_write');
    expect(existsSync(join(root, `output/noe-missions/approval/artifacts/should-not-run.json`))).toBe(false);
    expect(events.some((event) => event.type === 'mission.action.waiting_approval')).toBe(true);
  }));

  it('uses owner approval to resume the exact gated action', async () => withTempRoot(async (root) => {
    const store = new NoeMissionStore({ root });
    store.createMission({
      ...missionContract('approval-resume'),
      reviewPolicy: { ownerGate: ['external_write'] },
      plan: [
        {
          id: 'publish-proof',
          type: 'write_artifact',
          autonomyLevel: 'external_write',
          risks: ['external_write'],
          name: 'proof.json',
          content: { ok: true },
        },
      ],
    });
    const runner = new NoeMissionRunner({ root, store, runnerId: 'approval-runner' });
    await runner.runSlice('approval-resume', { maxActions: 1 });
    const waiting = store.readState('approval-resume').waitingApproval;

    store.updateState('approval-resume', (state) => ({
      ...state,
      status: 'running',
      phase: 'running',
      waitingApproval: null,
      reviewApprovals: {
        [waiting.actionId]: {
          decision: 'approved',
          actionId: waiting.actionId,
          reasons: waiting.reasons,
          risks: waiting.risks,
          decidedAt: '2026-06-13T00:00:00.000Z',
        },
      },
    }));
    const resumed = await runner.runSlice('approval-resume', { maxActions: 1 });
    const state = store.readState('approval-resume');
    const events = store.readEvents('approval-resume', { limit: 100 });

    expect(resumed.executed[0]).toMatchObject({ actionId: 'publish-proof', status: 'completed' });
    expect(state.current_cursor).toBe(1);
    expect(existsSync(join(root, 'output/noe-missions/approval-resume/artifacts/proof.json'))).toBe(true);
    expect(events.some((event) => event.type === 'mission.action.review_approval_used')).toBe(true);
  }));

  it('reconciles final report evidence refs and keeps mission context compact', async () => withTempRoot(async (root) => {
    const store = new NoeMissionStore({ root });
    store.createMission(missionContract('reconcile'));
    const runner = new NoeMissionRunner({ root, store, runnerId: 'test-runner' });
    await runner.runUntilTerminal('reconcile', { maxActions: 1, maxSlices: 10 });
    const mission = store.readMission('reconcile');
    const state = store.readState('reconcile');
    const events = store.readEvents('reconcile', { limit: 500 });
    const reconciliation = new NoeMissionReconciler({ root }).reconcile({ mission, state, events, root });
    const context = buildMissionContext({ mission, state });

    expect(reconciliation.ok).toBe(true);
    expect(reconciliation.coverage.requiredEvidence.every((item) => item.linked && item.readable && item.inFinalReport)).toBe(true);
    expect(context).not.toHaveProperty('events');
    expect(context.selfObservation).toMatchObject({ confidence: 'grounded' });
  }));

  it('mission context can carry compact runtime vision situation when runner injects it', async () => withTempRoot(async (root) => {
    const store = new NoeMissionStore({ root });
    store.createMission(missionContract('runtime-context'));
    const runner = new NoeMissionRunner({
      root,
      store,
      runnerId: 'runtime-context-runner',
      runtimeContextProvider: () => ({
        vision: {
          summary: '主人在多个窗口之间频繁切换任务',
          mode: 'screen',
          at: 123,
          situation: { activity: 'task_switching', attention: 'distracted', possibleNeed: 'task_refocus', shouldInterrupt: true, confidence: 0.81 },
        },
      }),
    });
    await runner.runSlice('runtime-context', { maxActions: 1 });
    const checkpoint = JSON.parse(readFileSync(join(root, 'output/noe-missions/runtime-context/checkpoints/000001.json'), 'utf8'));
    expect(checkpoint.missionContext.runtimeContext.vision.situation).toMatchObject({
      activity: 'task_switching',
      possibleNeed: 'task_refocus',
      shouldInterrupt: true,
    });
  }));

  it('defines a read-only quality audit mission with real command criteria', () => {
    const contract = createQualityAuditMissionContract({ missionId: 'quality-contract' });

    expect(contract.autonomyLevel).toBe('read_only');
    expect(contract.forbidden).toContain('51735');
    expect(contract.plan.filter((action) => action.type === 'run_command').length).toBeGreaterThanOrEqual(5);
    expect(contract.completionCriteria.some((criterion) => criterion.type === 'command_exit_zero')).toBe(true);
    expect(contract.expectedArtifacts.some((artifact) => artifact.type === 'coverage_table')).toBe(true);
  });

  it('runs command evidence, periodic summaries, coverage table, and final report as a mission', async () => withTempRoot(async (root) => {
    const missionId = 'quality-unit';
    const cmdRef = `output/noe-missions/${missionId}/artifacts/cmd-ok.json`;
    const observationRef = `output/noe-missions/${missionId}/artifacts/self-observation.json`;
    const coverageRef = `output/noe-missions/${missionId}/artifacts/coverage-table.json`;
    const reportRef = `output/noe-missions/${missionId}/artifacts/final-report.json`;
    const contract = {
      ...missionContract(missionId),
      autonomyLevel: 'read_only',
      evidenceRequirements: [
        { id: 'cmd', ref: cmdRef, required: true },
        { id: 'observation', ref: observationRef, required: true },
        { id: 'coverage', ref: coverageRef, required: true },
      ],
      completionCriteria: [
        { id: 'cmd-readable', type: 'evidence_ref_exists', ref: cmdRef },
        { id: 'observation-readable', type: 'evidence_ref_exists', ref: observationRef },
        { id: 'coverage-readable', type: 'evidence_ref_exists', ref: coverageRef },
        { id: 'cmd-exit-zero', type: 'command_exit_zero', commandId: 'cmd-ok' },
        { id: 'report-traces', type: 'final_report_traces_evidence', reportRef, evidenceRefs: [cmdRef, observationRef, coverageRef] },
        { id: 'no-blockers', type: 'no_unresolved_blockers' },
        { id: 'no-truncation', type: 'no_truncated_results' },
      ],
      expectedArtifacts: [
        { id: 'coverage_table', type: 'coverage_table', ref: coverageRef },
        { id: 'final_report', type: 'final_report', ref: reportRef },
      ],
      plan: [
        { id: 'cmd-ok', type: 'run_command', name: 'cmd-ok.json', command: [process.execPath, '-e', 'console.log("mission-ok")'] },
        { id: 'observe-thinking', type: 'self_observation', name: 'self-observation.json' },
        { id: 'coverage-table', type: 'coverage_table', name: 'coverage-table.json' },
        { id: 'final-report', type: 'final_report', name: 'final-report.json', evidenceRefs: [cmdRef, observationRef, coverageRef] },
      ],
    };
    const store = new NoeMissionStore({ root });
    store.createMission(contract);
    const runner = new NoeMissionRunner({
      root,
      store,
      runnerId: 'quality-runner',
      actionExecutors: createQualityAuditActionExecutors({ root, store }),
    });

    const result = await runner.runUntilTerminal(missionId, { maxActions: 1, maxSlices: 10, summaryEverySlices: 1 });
    const state = store.readState(missionId);
    const command = JSON.parse(readFileSync(join(root, cmdRef), 'utf8'));
    const coverage = JSON.parse(readFileSync(join(root, coverageRef), 'utf8'));

    expect(result).toMatchObject({ ok: true, status: 'succeeded' });
    expect(state.evidenceRefs.some((ref) => ref.includes('run-summary-'))).toBe(true);
    expect(command).toMatchObject({ ok: true, exitCode: 0 });
    expect(command.stdout).toContain('mission-ok');
    expect(coverage.ok).toBe(true);
    expect(coverage.requiredEvidence.every((item) => item.linked && item.readable)).toBe(true);
  }));

  it('defines a 7h long-soak mission with 15m checkpoints and 60m summaries by default', () => {
    const contract = createLongSoakMissionContract({ missionId: 'long-soak-contract' });
    const checkpoints = contract.plan.filter((action) => action.type === 'soak_checkpoint');

    expect(contract.autonomyLevel).toBe('read_only');
    expect(contract.forbidden).toContain('51735');
    expect(contract.metadata).toMatchObject({
      kind: 'p8_long_soak',
      durationMs: 7 * 60 * 60 * 1000,
      checkpointEveryMs: 15 * 60 * 1000,
      summaryEveryMs: 60 * 60 * 1000,
      heartbeatEveryMs: 60 * 1000,
      checkpointCount: 28,
    });
    expect(checkpoints).toHaveLength(28);
    expect(checkpoints.every((checkpoint) => checkpoint.heartbeatEveryMs === 60 * 1000)).toBe(true);
    expect(contract.completionCriteria.some((criterion) => criterion.type === 'mission_elapsed_at_least_ms')).toBe(true);
    expect(contract.completionCriteria.some((criterion) => criterion.type === 'event_type_count_at_least' && criterion.eventType === 'mission.run_summary.written')).toBe(true);
  });

  it('runs a short long-soak mission through elapsed, checkpoint, summary, coverage, and report gates', async () => withTempRoot(async (root) => {
    const missionId = 'long-soak-unit';
    const clock = { value: Date.parse('2026-06-13T00:00:00.000Z') };
    const nowMs = () => clock.value;
    const sleepFn = async (ms) => { clock.value += Number(ms) || 0; };
    const store = new NoeMissionStore({ root });
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    const contract = createLongSoakMissionContract({
      missionId,
      durationMs: 30,
      checkpointEveryMs: 10,
      summaryEveryMs: 10,
    });
    for (const action of contract.plan.filter((item) => item.type === 'soak_checkpoint')) delete action.heartbeatEveryMs;
    store.createMission(contract, { nowMs: nowMs() });
    const runner = new NoeMissionRunner({
      root,
      store,
      runnerId: 'long-soak-runner',
      nowMs,
      actionExecutors: createLongSoakActionExecutors({ root, store, sleepFn, nowMs }),
    });

    const result = await runner.runUntilTerminal(missionId, { maxActions: 1, maxSlices: 20, summaryEveryMs: 10 });
    const mission = store.readMission(missionId);
    const state = store.readState(missionId);
    const events = store.readEvents(missionId, { limit: 500 });
    const criteria = new NoeMissionCriteriaEngine({ root }).evaluate({ mission, state, events, root });
    const reconciliation = new NoeMissionReconciler({ root }).reconcile({ mission, state, events, root });
    const coverage = JSON.parse(readFileSync(join(root, `output/noe-missions/${missionId}/artifacts/coverage-table.json`), 'utf8'));
    const checkpoint = JSON.parse(readFileSync(join(root, `output/noe-missions/${missionId}/artifacts/soak-checkpoint-0001.json`), 'utf8'));
    const report = readFileSync(join(root, state.finalReportRef), 'utf8');
    const checkpointStartIndex = events.findIndex((event) => event.type === 'mission.action.started' && event.actionId === 'soak-checkpoint-0001');
    const checkpointCompleteIndex = events.findIndex((event) => event.type === 'mission.action.completed' && event.actionId === 'soak-checkpoint-0001');
    const heartbeatDuringCheckpoint = events.slice(checkpointStartIndex + 1, checkpointCompleteIndex)
      .filter((event) => event.type === 'mission.heartbeat');

    expect(result).toMatchObject({ ok: true, status: 'succeeded' });
    expect(checkpoint.heartbeatEveryMs).toBe(10);
    expect(heartbeatDuringCheckpoint.length).toBeGreaterThanOrEqual(1);
    expect(events.filter((event) => event.type === 'mission.run_summary.written').length).toBeGreaterThanOrEqual(3);
    expect(events.filter((event) => event.type === 'mission.checkpoint.written').length).toBeGreaterThanOrEqual(3);
    expect(criteria.ok).toBe(true);
    expect(reconciliation.ok).toBe(true);
    expect(coverage.ok).toBe(true);
    expect(report).toContain('soak-checkpoint-0003.json');
  }));
});
