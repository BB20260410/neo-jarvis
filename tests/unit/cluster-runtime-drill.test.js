import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildClusterRuntimeDrillReport,
  writeClusterRuntimeDrillReport,
} from '../../src/server/services/cluster-runtime-drill.js';

describe('cluster runtime drill', () => {
  it('runs real CrossVerifyDispatcher paths for concurrency and failover', async () => {
    const oldTimeout = process.env.PANEL_CLUSTER_MEMBER_CALL_TIMEOUT_MS;
    process.env.PANEL_CLUSTER_MEMBER_CALL_TIMEOUT_MS = '9999';
    try {
      const report = await buildClusterRuntimeDrillReport({
        now: new Date('2026-06-01T00:20:00.000Z'),
      });

      expect(process.env.PANEL_CLUSTER_MEMBER_CALL_TIMEOUT_MS).toBe('9999');
      expect(report).toMatchObject({
        drillVersion: 'cluster-runtime-drill-v1',
        generatedAt: '2026-06-01T00:20:00.000Z',
        ok: true,
        caseCount: 4,
        failedCaseCount: 0,
      });
      expect(report.results.map((item) => item.id)).toEqual([
        'concurrent_rooms_complete_on_real_dispatcher_path',
        'quota_drop_continues_on_real_dispatcher_path',
        'timeout_solo_takeover_completes_on_real_dispatcher_path',
        'abort_resume_race_keeps_new_run_active_abort',
      ]);
      expect(report.results.find((item) => item.id === 'concurrent_rooms_complete_on_real_dispatcher_path')?.evidence).toMatchObject({
        roomStatuses: {
          'runtime-room-1': 'done',
          'runtime-room-2': 'done',
        },
        activeAbortCount: 0,
        doneBroadcasts: 2,
      });
      expect(report.results.find((item) => item.id === 'timeout_solo_takeover_completes_on_real_dispatcher_path')?.evidence).toMatchObject({
        status: 'done',
        aborted: true,
        activeAbortCount: 0,
        consensusMembers: ['runtime-survivor'],
      });
      expect(report.results.find((item) => item.id === 'abort_resume_race_keeps_new_run_active_abort')?.evidence).toMatchObject({
        status: 'done',
        abortResult: true,
        oldRunResult: 'resolved',
        statusAfterResumeStarted: 'running',
        activeAbortAfterResumeStarted: true,
        statusAfterOldRunFinally: 'running',
        activeAbortAfterOldRunFinally: true,
        activeAbortCount: 0,
      });
    } finally {
      if (oldTimeout === undefined) delete process.env.PANEL_CLUSTER_MEMBER_CALL_TIMEOUT_MS;
      else process.env.PANEL_CLUSTER_MEMBER_CALL_TIMEOUT_MS = oldTimeout;
    }
  });

  it('writes latest runtime drill report and bounded history', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-cluster-runtime-'));
    try {
      const latestPath = join(dir, 'logs', 'latest.json');
      const historyPath = join(dir, 'logs', 'history.jsonl');
      const report = await buildClusterRuntimeDrillReport({
        now: new Date('2026-06-01T00:21:00.000Z'),
      });

      const writeResult = writeClusterRuntimeDrillReport(report, {
        latestPath,
        historyPath,
        maxHistoryLines: 1,
      });

      expect(writeResult).toMatchObject({
        written: true,
        latestPath,
        historyPath,
        retention: { trimmed: false, lineCount: 1, maxHistoryLines: 1 },
      });
      expect(JSON.parse(readFileSync(latestPath, 'utf8'))).toMatchObject({
        ok: true,
        caseCount: 4,
      });
      expect(JSON.parse(readFileSync(historyPath, 'utf8').trim())).toEqual({
        generatedAt: '2026-06-01T00:21:00.000Z',
        ok: true,
        caseCount: 4,
        failedCaseCount: 0,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
