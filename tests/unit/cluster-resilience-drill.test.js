import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildClusterResilienceDrillReport,
  writeClusterResilienceDrillReport,
} from '../../src/server/services/cluster-resilience-drill.js';

describe('cluster resilience drill', () => {
  it('proves multi-room capacity and failover takeover contracts', () => {
    const report = buildClusterResilienceDrillReport({
      now: new Date('2026-06-01T00:10:00.000Z'),
    });

    expect(report).toMatchObject({
      drillVersion: 'cluster-resilience-drill-v1',
      generatedAt: '2026-06-01T00:10:00.000Z',
      ok: true,
      caseCount: 6,
      failedCaseCount: 0,
    });
    expect(report.results.map((item) => item.id)).toEqual([
      'multi_room_capacity_boundary_allows_fifth_room',
      'sixth_room_is_blocked_before_start',
      'single_adapter_capacity_is_blocked',
      'in_flight_start_reservation_counts_against_budget',
      'solo_takeover_keeps_survivor_delivery_contract',
      'partial_drop_keeps_multi_member_takeover_contract',
    ]);
    expect(report.results.every((item) => item.ok)).toBe(true);
    expect(report.results.find((item) => item.id === 'sixth_room_is_blocked_before_start')?.evidence).toMatchObject({
      status: 'blocked',
      projectedRunningRoomCount: 6,
      blockers: ['running_rooms_gt_5'],
    });
    expect(report.results.find((item) => item.id === 'solo_takeover_keeps_survivor_delivery_contract')?.evidence).toMatchObject({
      consensusMembers: ['codex'],
    });
  });

  it('writes latest resilience drill report and bounded history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-cluster-resilience-'));
    try {
      const latestPath = join(dir, 'logs', 'latest.json');
      const historyPath = join(dir, 'logs', 'history.jsonl');
      const report = buildClusterResilienceDrillReport({
        now: new Date('2026-06-01T00:11:00.000Z'),
      });

      const writeResult = writeClusterResilienceDrillReport(report, {
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
        caseCount: 6,
      });
      expect(JSON.parse(readFileSync(historyPath, 'utf8').trim())).toEqual({
        generatedAt: '2026-06-01T00:11:00.000Z',
        ok: true,
        caseCount: 6,
        failedCaseCount: 0,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
