import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildPanelHealthHistoryEntry,
  writePanelHealthReport,
} from '../../src/server/services/panel-health-report.js';

describe('panel health report', () => {
  it('builds a compact history entry for long-running health audits', () => {
    const entry = buildPanelHealthHistoryEntry({
      ok: true,
      checkOnly: true,
      restartMethod: 'check',
      repair: { mode: 'repair', action: 'none', reason: 'already_healthy' },
      port: 51835,
      healthSource: 'cluster_health_api',
      health: { status: 'passed', blockers: [] },
      readinessSource: 'cluster_readiness_api',
      diagnosticsSource: 'cluster_diagnostics_api',
      diagnostics: {
        status: 'passed',
        invariants: { safeToStart: true },
        findings: [],
        recommendations: [],
        recoveryPlan: [],
      },
      diagnosticsDrillSource: 'local_cluster_diagnostics_drill',
      diagnosticsDrill: {
        ok: true,
        caseCount: 4,
        failedCaseCount: 0,
        results: [
          { id: 'healthy_cluster', ok: true },
          { id: 'config_and_concurrency_blocked', ok: true },
          { id: 'runtime_persistence_failed', ok: true },
          { id: 'stall_recovered_warn', ok: true },
        ],
      },
      resilienceDrillSource: 'local_cluster_resilience_drill',
      resilienceDrill: {
        ok: true,
        caseCount: 6,
        failedCaseCount: 0,
        results: [
          { id: 'multi_room_capacity_boundary_allows_fifth_room', ok: true },
          { id: 'sixth_room_is_blocked_before_start', ok: true },
        ],
      },
      runtimeDrillSource: 'local_cluster_runtime_drill',
      runtimeDrill: {
        ok: true,
        caseCount: 3,
        failedCaseCount: 0,
        results: [
          { id: 'concurrent_rooms_complete_on_real_dispatcher_path', ok: true },
          { id: 'quota_drop_continues_on_real_dispatcher_path', ok: true },
        ],
      },
      assuranceSource: 'local_cluster_assurance',
      assurance: {
        status: 'passed',
        ok: true,
        summary: {
          gateCount: 4,
          blockedGateCount: 0,
          warningGateCount: 0,
          failedGateIds: [],
          failedCases: [],
        },
        gates: [
          { id: 'live_diagnostics', status: 'passed' },
          { id: 'diagnostics_drill', status: 'passed' },
          { id: 'resilience_drill', status: 'passed' },
          { id: 'runtime_drill', status: 'passed' },
        ],
        recoveryPlan: [],
      },
      readiness: {
        status: 'passed',
        blockers: [],
        warnings: [],
        checks: [
          { id: 'runtime_recovery_clean', status: 'passed' },
          { id: 'multi_room_capacity', status: 'passed' },
        ],
        capabilities: {
          multiRoom: true,
          maxRunningRooms: 5,
          maxAdapterRunningRooms: 3,
        },
      },
      warnings: [],
      listeners: [{ pid: 123, cwd: '/project' }],
      healthApi: {
        json: {
          runtimeReconciliation: {
            status: 'recovered',
            recoveredRoomCount: 1,
            stalledActiveRoomCount: 1,
            cleanedActiveAbortCount: 1,
            recoveryErrorCount: 0,
            runtimePersistPending: { ok: true, pendingRooms: [{ roomId: 'pending-room' }] },
            flushError: null,
            stalledActiveRooms: [{
              roomId: 'stalled-room',
              reason: 'active_running_without_progress_timeout',
              at: '2026-06-01T00:00:00.000Z',
              resumePolicy: {
                autoResumeAllowed: false,
                nextAction: 'manual_review_required_before_resume',
              },
            }],
          },
          configAudit: { status: 'passed', blockers: [], warnings: [] },
          concurrencyBudget: { status: 'passed' },
        },
      },
    }, new Date('2026-06-01T00:00:00.000Z'));

    expect(entry).toEqual({
      at: '2026-06-01T00:00:00.000Z',
      ok: true,
      checkOnly: true,
      restartMethod: 'check',
      repairMode: 'repair',
      repairAction: 'none',
      repairReason: 'already_healthy',
      port: 51835,
      healthSource: 'cluster_health_api',
      healthStatus: 'passed',
      blockers: [],
      readinessSource: 'cluster_readiness_api',
      readinessStatus: 'passed',
      readinessBlockers: [],
      readinessWarnings: [],
      readinessCheckCount: 2,
      readinessPassedCheckCount: 2,
      readinessMultiRoom: true,
      readinessMaxRunningRooms: 5,
      readinessMaxAdapterRunningRooms: 3,
      configAuditStatus: 'passed',
      configAuditBlockers: [],
      configAuditWarnings: [],
      diagnosticsSource: 'cluster_diagnostics_api',
      diagnosticsStatus: 'passed',
      diagnosticsSafeToStart: true,
      diagnosticsFindingCount: 0,
      diagnosticsBlockerCount: 0,
      diagnosticsWarningCount: 0,
      diagnosticsRecommendationCount: 0,
      diagnosticsRecoveryActionCount: 0,
      diagnosticsBlockingRecoveryActionCount: 0,
      diagnosticsRecoveryCommands: [],
      diagnosticsRecoveryEndpoints: [],
      diagnosticsRecoveryUiEntries: [],
      diagnosticsDrillSource: 'local_cluster_diagnostics_drill',
      diagnosticsDrillOk: true,
      diagnosticsDrillCaseCount: 4,
      diagnosticsDrillFailedCaseCount: 0,
      diagnosticsDrillFailedCases: [],
      diagnosticsDrillError: null,
      resilienceDrillSource: 'local_cluster_resilience_drill',
      resilienceDrillOk: true,
      resilienceDrillCaseCount: 6,
      resilienceDrillFailedCaseCount: 0,
      resilienceDrillFailedCases: [],
      resilienceDrillError: null,
      runtimeDrillSource: 'local_cluster_runtime_drill',
      runtimeDrillOk: true,
      runtimeDrillCaseCount: 3,
      runtimeDrillFailedCaseCount: 0,
      runtimeDrillFailedCases: [],
      runtimeDrillError: null,
      assuranceSource: 'local_cluster_assurance',
      assuranceStatus: 'passed',
      assuranceOk: true,
      assuranceGateCount: 4,
      assuranceBlockedGateCount: 0,
      assuranceWarningGateCount: 0,
      assuranceFailedGates: [],
      assuranceFailedCases: [],
      assuranceRecoveryActionCount: 0,
      assuranceBlockingRecoveryActionCount: 0,
      assuranceRecoveryCommands: [],
      assuranceRecoveryEndpoints: [],
      assuranceRecoveryUiEntries: [],
      warnings: [],
      listeners: [{ pid: 123, cwd: '/project' }],
      runtimeStatus: 'recovered',
      runtimeRecoveredRoomCount: 1,
      runtimeStalledActiveRoomCount: 1,
      runtimeCleanedActiveAbortCount: 1,
      runtimeRecoveryErrorCount: 0,
      runtimePendingPersistCount: 1,
      runtimeFlushError: null,
      latestRuntimeRecoveryReason: 'active_running_without_progress_timeout',
      latestRuntimeRecoveryRoomId: 'stalled-room',
      latestRuntimeRecoveryAt: '2026-06-01T00:00:00.000Z',
      latestRuntimeAutoResumeAllowed: false,
      latestRuntimeResumeNextAction: 'manual_review_required_before_resume',
      concurrencyStatus: 'passed',
    });
  });

  it('writes latest JSON report and append-only history JSONL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-health-report-'));
    try {
      const latestPath = join(dir, 'logs', 'latest.json');
      const historyPath = join(dir, 'logs', 'history.jsonl');
      const result = {
        ok: false,
        checkOnly: false,
        restartMethod: 'launchd',
        port: 51835,
        healthSource: 'cluster_health_api',
        health: { status: 'blocked', blockers: ['runtime_flush_error_present'] },
        readiness: {
          status: 'blocked',
          blockers: ['maxRunningRooms_lt_2=1'],
          capabilities: { multiRoom: false, maxRunningRooms: 1, maxAdapterRunningRooms: 1 },
        },
        diagnostics: {
          status: 'blocked',
          invariants: { safeToStart: false },
          findings: [
            { severity: 'blocker', code: 'config_audit_blocked' },
            { severity: 'warn', code: 'readiness_warn' },
          ],
          recommendations: [{ code: 'config_audit_blocked', action: '调整配置' }],
          recoveryPlan: [
            {
              code: 'config_audit_blocked',
              severity: 'blocker',
              blocksStart: true,
              command: 'npm run check:panel',
              endpoint: '/api/cluster/readiness',
              ui: '集群协同房间 -> 并发预算/集群诊断',
            },
            {
              code: 'readiness_warn',
              severity: 'warn',
              blocksStart: false,
              command: 'npm run check:panel',
              endpoint: '/api/cluster/readiness',
              ui: '集群协同房间 -> 集群诊断',
            },
          ],
        },
        diagnosticsDrillSource: 'local_cluster_diagnostics_drill',
        diagnosticsDrill: {
          ok: false,
          caseCount: 4,
          failedCaseCount: 1,
          results: [
            { id: 'healthy_cluster', ok: true },
            { id: 'runtime_persistence_failed', ok: false },
          ],
        },
        resilienceDrillSource: 'local_cluster_resilience_drill',
        resilienceDrill: {
          ok: false,
          caseCount: 6,
          failedCaseCount: 1,
          results: [
            { id: 'single_adapter_capacity_is_blocked', ok: false },
          ],
          error: null,
        },
        runtimeDrillSource: 'local_cluster_runtime_drill',
        runtimeDrill: {
          ok: false,
          caseCount: 3,
          failedCaseCount: 1,
          results: [
            { id: 'timeout_solo_takeover_completes_on_real_dispatcher_path', ok: false },
          ],
          error: 'timeout',
        },
        assuranceSource: 'local_cluster_assurance',
        assurance: {
          status: 'blocked',
          ok: false,
          summary: {
            gateCount: 4,
            blockedGateCount: 2,
            warningGateCount: 0,
            failedGateIds: ['resilience_drill', 'runtime_drill'],
            failedCases: [
              'resilience_drill:single_adapter_capacity_is_blocked',
              'runtime_drill:timeout_solo_takeover_completes_on_real_dispatcher_path',
            ],
          },
          gates: [
            { id: 'resilience_drill', status: 'blocked' },
            { id: 'runtime_drill', status: 'blocked' },
          ],
          recoveryPlan: [
            {
              gateId: 'resilience_drill',
              severity: 'blocker',
              blocksStart: true,
              command: 'npm run cluster:stress && npm run check:panel',
              endpoint: '/api/cluster/concurrency-budget',
              ui: '集群协同房间 -> 并发预算/集群诊断',
            },
            {
              gateId: 'runtime_drill',
              severity: 'blocker',
              blocksStart: true,
              command: 'npm run cluster:runtime && npm run repair:panel && npm run check:panel',
              endpoint: '/api/cluster/diagnostics',
              ui: '集群协同房间 -> 集群诊断 -> 保证体系门禁',
            },
          ],
        },
        configAudit: {
          status: 'blocked',
          blockers: ['member_call_timeout_gte_stall_timeout=30000/30000'],
          warnings: [],
        },
        warnings: ['cluster_health_api_unavailable=503'],
        listeners: [],
      };

      const writeResult = writePanelHealthReport(result, {
        latestPath,
        historyPath,
        now: new Date('2026-06-01T00:01:00.000Z'),
      });

      expect(writeResult).toMatchObject({
        written: true,
        latestPath,
        historyPath,
        retention: { trimmed: false, lineCount: 1, maxHistoryLines: 1000 },
      });
      const latest = JSON.parse(readFileSync(latestPath, 'utf8'));
      expect(latest).toMatchObject({
        generatedAt: '2026-06-01T00:01:00.000Z',
        ok: false,
        health: { status: 'blocked' },
      });
      const historyLines = readFileSync(historyPath, 'utf8').trim().split('\n');
      expect(historyLines).toHaveLength(1);
      expect(JSON.parse(historyLines[0])).toMatchObject({
        at: '2026-06-01T00:01:00.000Z',
        healthStatus: 'blocked',
        readinessStatus: 'blocked',
        readinessBlockers: ['maxRunningRooms_lt_2=1'],
        readinessMultiRoom: false,
        readinessMaxRunningRooms: 1,
        configAuditStatus: 'blocked',
        configAuditBlockers: ['member_call_timeout_gte_stall_timeout=30000/30000'],
        diagnosticsStatus: 'blocked',
        diagnosticsSafeToStart: false,
        diagnosticsFindingCount: 2,
        diagnosticsBlockerCount: 1,
        diagnosticsWarningCount: 1,
        diagnosticsRecommendationCount: 1,
        diagnosticsRecoveryActionCount: 2,
        diagnosticsBlockingRecoveryActionCount: 1,
        diagnosticsRecoveryCommands: ['npm run check:panel'],
        diagnosticsRecoveryEndpoints: ['/api/cluster/readiness'],
        diagnosticsRecoveryUiEntries: [
          '集群协同房间 -> 并发预算/集群诊断',
          '集群协同房间 -> 集群诊断',
        ],
        diagnosticsDrillSource: 'local_cluster_diagnostics_drill',
        diagnosticsDrillOk: false,
        diagnosticsDrillCaseCount: 4,
        diagnosticsDrillFailedCaseCount: 1,
        diagnosticsDrillFailedCases: ['runtime_persistence_failed'],
        resilienceDrillSource: 'local_cluster_resilience_drill',
        resilienceDrillOk: false,
        resilienceDrillCaseCount: 6,
        resilienceDrillFailedCaseCount: 1,
        resilienceDrillFailedCases: ['single_adapter_capacity_is_blocked'],
        resilienceDrillError: null,
        runtimeDrillSource: 'local_cluster_runtime_drill',
        runtimeDrillOk: false,
        runtimeDrillCaseCount: 3,
        runtimeDrillFailedCaseCount: 1,
        runtimeDrillFailedCases: ['timeout_solo_takeover_completes_on_real_dispatcher_path'],
        runtimeDrillError: 'timeout',
        assuranceSource: 'local_cluster_assurance',
        assuranceStatus: 'blocked',
        assuranceOk: false,
        assuranceGateCount: 4,
        assuranceBlockedGateCount: 2,
        assuranceWarningGateCount: 0,
        assuranceFailedGates: ['resilience_drill', 'runtime_drill'],
        assuranceFailedCases: [
          'resilience_drill:single_adapter_capacity_is_blocked',
          'runtime_drill:timeout_solo_takeover_completes_on_real_dispatcher_path',
        ],
        assuranceRecoveryActionCount: 2,
        assuranceBlockingRecoveryActionCount: 2,
        assuranceRecoveryCommands: [
          'npm run cluster:stress && npm run check:panel',
          'npm run cluster:runtime && npm run repair:panel && npm run check:panel',
        ],
        assuranceRecoveryEndpoints: [
          '/api/cluster/concurrency-budget',
          '/api/cluster/diagnostics',
        ],
        assuranceRecoveryUiEntries: [
          '集群协同房间 -> 并发预算/集群诊断',
          '集群协同房间 -> 集群诊断 -> 保证体系门禁',
        ],
        runtimeRecoveredRoomCount: 0,
        runtimeStalledActiveRoomCount: 0,
        repairAction: null,
        blockers: ['runtime_flush_error_present'],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps health history bounded to avoid unbounded disk growth', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-health-retention-'));
    try {
      const latestPath = join(dir, 'logs', 'latest.json');
      const historyPath = join(dir, 'logs', 'history.jsonl');
      mkdirSync(join(dir, 'logs'), { recursive: true });
      writeFileSync(historyPath, [
        JSON.stringify({ at: 'old-1', healthStatus: 'blocked' }),
        JSON.stringify({ at: 'old-2', healthStatus: 'passed' }),
        JSON.stringify({ at: 'old-3', healthStatus: 'passed' }),
        '',
      ].join('\n'));

      const writeResult = writePanelHealthReport({
        ok: true,
        checkOnly: true,
        restartMethod: 'check',
        repair: { mode: 'repair', action: 'restart', reason: 'precheck_failed' },
        port: 51835,
        health: { status: 'passed', blockers: [] },
      }, {
        latestPath,
        historyPath,
        now: new Date('2026-06-01T00:02:00.000Z'),
        maxHistoryLines: 2,
      });

      expect(writeResult).toMatchObject({
        written: true,
        retention: {
          trimmed: true,
          previousLineCount: 4,
          lineCount: 2,
          maxHistoryLines: 2,
        },
      });
      const lines = readFileSync(historyPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({ at: 'old-3' });
      expect(lines[1]).toMatchObject({
        at: '2026-06-01T00:02:00.000Z',
        healthStatus: 'passed',
        repairAction: 'restart',
        repairReason: 'precheck_failed',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
