import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { buildNoeWorkMapSnapshot, writeNoeWorkMapSnapshot } from '../../src/runtime/NoeWorkMapSnapshot.js';

function writeJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fakeDbReader() {
  return {
    all(sql) {
      if (sql.includes('FROM noe_goals')) {
        return [
          {
            id: 'goal-live',
            source: 'self_learning',
            status: 'open',
            priority: 0.8,
            title: '自主学习 OPENAI_API_KEY=unit-secret-value',
            created_at: 1781310000000,
            updated_at: 1781310100000,
          },
          {
            id: 'goal-done',
            source: 'reflection',
            status: 'done',
            priority: 0.2,
            title: '完成目标',
            created_at: 1781300000000,
            updated_at: 1781300100000,
          },
        ];
      }
      if (sql.includes('FROM noe_goal_checkpoints')) {
        return [
          { goal_id: 'goal-live', count: 2 },
        ];
      }
      if (sql.includes('FROM delegations')) return [];
      if (sql.includes('FROM autopilot_jobs')) {
        return [
          {
            id: 'apj-live',
            status: 'queued',
            action: 'start_noe_delegate',
            target_type: 'noe_delegate',
            target_id: 'room-1',
            room_id: 'room-1',
            session_id: null,
            task_id: 'task-1',
            attempts: 0,
            max_attempts: 3,
            last_error: '',
            updated_at: 1781310200000,
          },
        ];
      }
      return [];
    },
  };
}

describe('NoeWorkMapSnapshot', () => {
  it('builds a redacted read-only map across local work sources', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-work-map-root-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'noe-work-map-data-'));
    try {
      writeJson(join(dataDir, 'data.json'), [
        { id: 'session-1', name: '前台会话', mainGoal: '继续任务', runState: 'running', busy: true, messages: [{ text: 'sk-should-not-leak-000000000000000000000' }] },
      ]);
      writeJson(join(dataDir, 'rooms.json'), {
        rooms: [
          {
            id: 'room-1',
            name: '派活房',
            mode: 'chat',
            status: 'idle',
            topic: 'room topic',
            conversation: [{ content: 'token=do-not-leak' }],
            taskList: [],
            createdAt: '2026-06-13T01:00:00.000Z',
          },
        ],
      });
      writeJson(join(dataDir, 'rooms-archive.json'), { rooms: [] });
      writeJson(join(dataDir, 'task-reportbacks.json'), {
        items: [
          {
            id: 'trb-1',
            taskId: 'task-r',
            title: '系统自修复 sk-unitsecret000000000000000000000',
            status: 'running',
            source: 'workspace',
            summary: '仍在执行 token=unit-secret-value',
            updatedAt: 1781308800000,
          },
        ],
      });
      writeJson(join(root, 'output/noe-missions/mission-1/mission.json'), {
        missionId: 'mission-1',
        objective: 'Attach active self-learning to Mission Runtime',
      });
      writeJson(join(root, 'output/noe-missions/mission-1/state.json'), {
        missionId: 'mission-1',
        status: 'recovering',
        current_slice: 2,
        recovery_attempts: 1,
        evidenceRefs: ['output/noe-missions/mission-1/artifacts/proof.json'],
        updatedAt: '2026-06-13T01:05:00.000Z',
      });
      writeJson(join(root, 'output/noe-missions/mission-stale-running/mission.json'), {
        missionId: 'mission-stale-running',
        objective: 'Closed mission whose state was not updated',
      });
      writeJson(join(root, 'output/noe-missions/mission-stale-running/state.json'), {
        missionId: 'mission-stale-running',
        status: 'running',
        current_slice: 0,
        recovery_attempts: 0,
        evidenceRefs: ['output/noe-missions/mission-stale-running/artifacts/final-report.json'],
        updatedAt: '2026-06-13T01:07:00.000Z',
      });
      writeJson(join(root, 'output/noe-missions/mission-stale-running/artifacts/final-report.json'), {
        ok: true,
        summary: 'completed even though state stayed running',
      });
      writeJson(join(root, 'output/noe-observation-status/latest.json'), {
        ok: true,
        generatedAt: '2026-06-13T01:06:00.000Z',
        expectationCalibration: { naturalLiveResolved: 10, required: 20 },
        soakSnapshot: { soak: { activeDays: 4, requiredDays: 7 } },
        hermesBackgroundAudit: { observedHours: 8.45, windowHours: 24, categories: { patch_apply_chain: { count: 1 } } },
        p8DailyObservation: {
          available: true,
          status: 'collect_daily_observation_snapshot',
          baselineId: 'p8-long-soak-real-20260613T012533',
          observationDayIndex: 1,
          minObservationDays: 7,
          maxObservationDays: 10,
          observationDays: 0.42,
          daysRemaining: 6.58,
          progressPct: 6,
          earliestNextStageAt: '2026-06-20T00:45:39.145Z',
          doNotStartNextStage: true,
          allowedWork: ['daily observation snapshot', 'do not start P9-A0/P9-D0/P9-G0/R line from this gate'],
          forbiddenWork: ['P9-A0', 'P9-D0', 'P9-G0', 'research/R line'],
          evidenceRefs: ['output/noe-p8-observation-gate/latest.json', 'output/noe-soak-daily/latest.json'],
        },
        decision: {
          status: 'wait_for_expectation_due',
          blockers: ['expectation_calibration_pending', 'insufficient_observation_window:8.45/24'],
          nextAction: 'wait_until_next_expectation_due_then_rerun_observation_status',
          nextCheckAt: '2026-06-13T04:29:28.708Z',
          readyForNextStageReview: false,
        },
      });
      writeJson(join(root, 'output/noe-long-task-followup/latest.json'), {
        ok: true,
        generatedAt: '2026-06-13T01:08:00.000Z',
        status: 'waiting_for_natural_judgement',
        action: 'observe_next_natural_judgement_then_rerun_observation_status',
        nextCommand: 'npm run verify:noe:long-task-followup',
        nextCheckAt: '2026-06-13T04:29:28.708Z',
        nextCheckAtLocal: '2026-06-13T12:29:28+08:00',
        nextCheckDue: true,
        currentDueWindow: true,
        minutesUntilNextCheck: 200,
        completionGate: {
          canMarkComplete: false,
          readyForNextStageReview: false,
          remaining: { naturalExpectation: 10, soakDays: 3, hermesHours: 15.55 },
        },
        resumeProtocol: {
          safeToResumeFromNextWindow: true,
          canRunNow: false,
          waitingForNaturalJudgement: true,
          requiresManualInspection: false,
          waitUntilLocal: '2026-06-13T12:29:28+08:00',
          nextCommand: 'npm run verify:noe:long-task-followup',
          completionAllowed: false,
        },
        scheduler: {
          available: true,
          state: 'not running',
          runs: 1,
          lastExitCode: 0,
          runIntervalSeconds: 900,
          logs: {
            stdout: { exists: true, bytes: 123, mtimeAt: '2026-06-13T04:00:00.000Z' },
            stderr: { exists: true, bytes: 0, mtimeAt: '2026-06-13T04:00:00.000Z' },
          },
        },
        schedulerExpectation: {
          basis: 'launchd_log_mtime',
          lastEvidenceAtLocal: '2026-06-13T12:00:00+08:00',
          expectedNextRunAtLocal: '2026-06-13T12:15:00+08:00',
          staleIfNoRunAfterLocal: '2026-06-13T12:30:00+08:00',
        },
        refs: {
          followupMarkdown: 'output/noe-long-task-followup/latest.md',
          runLog: 'output/noe-long-task-followup/runs.jsonl',
        },
        observation: {
          nextCheckAt: '2026-06-13T04:29:20.000Z',
          nextCheckDue: false,
        },
      });

      const out = buildNoeWorkMapSnapshot({
        rootDir: root,
        dataDir,
        dbReader: fakeDbReader(),
        now: () => Date.parse('2026-06-13T01:10:00.000Z'),
      });

      expect(out.ok).toBe(true);
      expect(out.policy).toMatchObject({ readOnly: true, noMessageBodiesIncluded: true });
      expect(out.counts.sessions.busy).toBe(1);
      expect(out.counts.rooms.activeCount).toBe(1);
      expect(out.counts.goals.active).toBe(1);
      expect(out.counts.goals.hygiene).toMatchObject({
        checkpointBacked: 1,
        withoutCheckpoints: 0,
        reflectionOpenWithoutCheckpoints: 0,
      });
      expect(out.counts.missions.active).toBe(1);
      expect(out.counts.missions.statusCounts.succeeded).toBe(1);
      expect(out.counts.reportbacks.active).toBe(1);
      expect(out.counts.reportbacks.staleActive).toBe(1);
      expect(out.counts.reportbacks.staleItems[0]).toMatchObject({
        id: 'task-r',
        status: 'running',
        nextAction: 'confirm_progress_or_mark_blocked',
      });
      expect(out.counts.observationStatus).toMatchObject({
        available: true,
        status: 'wait_for_expectation_due',
        blockerCount: 2,
        readyForNextStageReview: false,
        p8DailyObservation: {
          available: true,
          observationDayIndex: 1,
          minObservationDays: 7,
          daysRemaining: 6.58,
          doNotStartNextStage: true,
          forbiddenWork: ['P9-A0', 'P9-D0', 'P9-G0', 'research/R line'],
        },
      });
      expect(out.counts.observationStatus.followup).toMatchObject({
        available: true,
        status: 'waiting_for_natural_judgement',
        nextCommand: 'npm run verify:noe:long-task-followup',
        nextCheckAt: '2026-06-13T04:29:28.708Z',
        nextCheckAtLocal: '2026-06-13T12:29:28+08:00',
        nextCheckDue: true,
        currentDueWindow: true,
        minutesUntilNextCheck: 200,
        completionGate: {
          canMarkComplete: false,
          readyForNextStageReview: false,
          remaining: { naturalExpectation: 10, soakDays: 3, hermesHours: 15.55 },
        },
        resumeProtocol: {
          safeToResumeFromNextWindow: true,
          canRunNow: false,
          waitingForNaturalJudgement: true,
          requiresManualInspection: false,
          waitUntilLocal: '2026-06-13T12:29:28+08:00',
          nextCommand: 'npm run verify:noe:long-task-followup',
          completionAllowed: false,
        },
        scheduler: {
          available: true,
          state: 'not running',
          runs: 1,
          lastExitCode: 0,
          runIntervalSeconds: 900,
          logs: {
            stdout: { exists: true, bytes: 123, mtimeAt: '2026-06-13T04:00:00.000Z' },
            stderr: { exists: true, bytes: 0, mtimeAt: '2026-06-13T04:00:00.000Z' },
          },
        },
        schedulerExpectation: {
          basis: 'launchd_log_mtime',
          lastEvidenceAtLocal: '2026-06-13T12:00:00+08:00',
          expectedNextRunAtLocal: '2026-06-13T12:15:00+08:00',
          staleIfNoRunAfterLocal: '2026-06-13T12:30:00+08:00',
        },
        ref: 'output/noe-long-task-followup/latest.json',
        handoffRef: 'output/noe-long-task-followup/latest.md',
        runLogRef: 'output/noe-long-task-followup/runs.jsonl',
      });
      expect(out.counts.observationStatus.hermes.categories).toContain('patch_apply_chain');
      expect(out.workItems.map((item) => item.kind)).toEqual(expect.arrayContaining(['session', 'goal', 'mission', 'reportback', 'autopilot', 'observation']));
      expect(out.workItems.find((item) => item.id === 'goal-live')).toMatchObject({
        evidenceCount: 2,
        detail: 'checkpoints 2',
      });
      expect(out.workItems.find((item) => item.kind === 'observation')).toMatchObject({
        tone: 'blocked',
        ref: 'output/noe-observation-status/latest.json',
      });
      expect(out.workItems.find((item) => item.kind === 'observation').detail).toContain('follow-up waiting');
      expect(out.workItems.find((item) => item.kind === 'observation').detail).toContain('p8 day 1/7');
      expect(out.workItems.find((item) => item.kind === 'observation').detail).toContain('remaining 6.58d');
      expect(out.workItems.find((item) => item.id === 'mission-stale-running')).toMatchObject({
        tone: 'done',
        status: 'succeeded',
        ref: 'output/noe-missions/mission-stale-running/artifacts/final-report.json',
      });
      expect(out.workItems.find((item) => item.id === 'mission-stale-running').detail).toContain('state running -> final report');
      expect(out.workItems.find((item) => item.id === 'task-r')).toMatchObject({
        tone: 'blocked',
        stale: true,
        nextAction: 'confirm_progress_or_mark_blocked',
      });
      const serialized = JSON.stringify(out);
      expect(serialized).not.toContain('unit-secret-value');
      expect(serialized).not.toContain('do-not-leak');
      expect(serialized).not.toContain('should-not-leak');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('writes timestamped and latest snapshot files', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-work-map-write-'));
    try {
      const snapshot = buildNoeWorkMapSnapshot({
        rootDir: root,
        dataDir: join(root, 'missing-data'),
        now: () => Date.parse('2026-06-13T02:00:00.000Z'),
      });
      const written = writeNoeWorkMapSnapshot(snapshot, { rootDir: root });
      const latest = JSON.parse(readFileSync(join(root, 'output/noe-work-map/latest.json'), 'utf8'));

      expect(written.reportPath).toContain('output/noe-work-map/2026-06-13T02-00-00-000Z/snapshot.json');
      expect(written.latestPath).toBe('output/noe-work-map/latest.json');
      expect(latest.generatedAt).toBe('2026-06-13T02:00:00.000Z');
      expect(latest.policy.skippedFiles).toContain('room-adapters.json');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
