import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildClusterDiagnosticsDrillReport,
  evaluateClusterDiagnosticsDrillCase,
  writeClusterDiagnosticsDrillReport,
} from '../../src/server/services/cluster-diagnostics-drill.js';

function healthyPayload() {
  return {
    runtimeReconciliation: {
      status: 'clean',
      recoveredRoomCount: 0,
      stalledActiveRoomCount: 0,
      cleanedActiveAbortCount: 0,
      recoveryErrorCount: 0,
      runtimePersistPending: { ok: true, pendingRooms: [] },
    },
    configAudit: { status: 'passed', blockers: [], warnings: [] },
    concurrencyBudget: { status: 'passed', blockers: [], maxRunningRooms: 5 },
    health: { status: 'passed', blockers: [] },
    readiness: {
      status: 'passed',
      blockers: [],
      warnings: [],
      capabilities: { multiRoom: true, maxRunningRooms: 5, maxAdapterRunningRooms: 3 },
    },
    rooms: [],
  };
}

describe('cluster diagnostics drill', () => {
  it('proves the default diagnostic recovery scenarios still match expected contracts', () => {
    const report = buildClusterDiagnosticsDrillReport({
      now: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(report).toMatchObject({
      generatedAt: '2026-06-01T00:00:00.000Z',
      ok: true,
      caseCount: 4,
      failedCaseCount: 0,
    });
    expect(report.results.map((item) => item.id)).toEqual([
      'healthy_cluster',
      'config_and_concurrency_blocked',
      'runtime_persistence_failed',
      'stall_recovered_warn',
    ]);
    expect(report.results.every((item) => item.ok)).toBe(true);
  });

  it('fails loudly when an expected diagnostic finding disappears', () => {
    const result = evaluateClusterDiagnosticsDrillCase({
      id: 'missing-contract',
      payload: healthyPayload(),
      expect: {
        status: 'passed',
        safeToStart: true,
        codes: ['config_audit_blocked'],
      },
    });

    expect(result).toMatchObject({
      id: 'missing-contract',
      ok: false,
      failures: ['missing_finding=config_audit_blocked'],
      diagnostics: {
        status: 'passed',
        safeToStart: true,
      },
    });
  });

  it('writes latest drill report and bounded drill history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-cluster-drill-'));
    try {
      const latestPath = join(dir, 'logs', 'latest.json');
      const historyPath = join(dir, 'logs', 'history.jsonl');
      const report = buildClusterDiagnosticsDrillReport({
        now: new Date('2026-06-01T00:03:00.000Z'),
      });

      const writeResult = writeClusterDiagnosticsDrillReport(report, {
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
        generatedAt: '2026-06-01T00:03:00.000Z',
        ok: true,
        caseCount: 4,
        failedCaseCount: 0,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
