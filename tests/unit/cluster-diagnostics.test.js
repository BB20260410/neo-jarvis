import { describe, expect, it } from 'vitest';
import { buildClusterDiagnostics } from '../../src/server/services/cluster-diagnostics.js';

function healthyPayload(overrides = {}) {
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
    readiness: { status: 'passed', blockers: [], warnings: [], capabilities: { multiRoom: true } },
    rooms: [
      { id: 'r1', mode: 'cross_verify', status: 'running' },
      { id: 'r2', mode: 'cross_verify', status: 'paused' },
      { id: 'chat', mode: 'chat', status: 'running' },
    ],
    ...overrides,
  };
}

describe('cluster diagnostics', () => {
  it('builds a passing machine-readable diagnostics summary for healthy cluster collaboration', () => {
    const diagnostics = buildClusterDiagnostics(healthyPayload());

    expect(diagnostics).toMatchObject({
      diagnosticsVersion: 'cluster-diagnostics-v1',
      status: 'passed',
      summary: {
        healthStatus: 'passed',
        healthTrendStatus: 'unknown',
        resourceGuardStatus: 'unknown',
        opsGuardStatus: 'unknown',
        capabilityGuardStatus: 'unknown',
        readinessStatus: 'passed',
        runtimeStatus: 'clean',
        configStatus: 'passed',
        concurrencyStatus: 'passed',
        blockerCount: 0,
        warningCount: 0,
        roomSummary: {
          total: 2,
          running: 1,
          paused: 1,
        },
      },
      invariants: {
        safeToStart: true,
        multiRoomEnabled: true,
        runtimeRecoveryClean: true,
        configSafe: true,
        concurrencyAvailable: true,
        noPendingPersistence: true,
        healthTrendHealthy: true,
        resourceGuardHealthy: true,
        opsGuardHealthy: true,
        capabilityGuardHealthy: true,
      },
      findings: [],
      recommendations: [],
      recoveryPlan: [],
    });
  });

  it('blocks when ops guard detects an exception storm or room backlog', () => {
    const diagnostics = buildClusterDiagnostics(healthyPayload({
      opsGuard: {
        status: 'blocked',
        ok: false,
        blockers: ['consecutive_ops_failures=2'],
        warnings: [],
      },
    }));

    expect(diagnostics.status).toBe('blocked');
    expect(diagnostics.invariants.safeToStart).toBe(false);
    expect(diagnostics.invariants.opsGuardHealthy).toBe(false);
    expect(diagnostics.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'ops_guard_blocked',
        severity: 'blocker',
        evidence: ['consecutive_ops_failures=2'],
      }),
    ]));
    expect(diagnostics.recoveryPlan).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'ops_guard_blocked',
        command: 'npm run repair:panel && npm run check:panel',
        endpoint: '/api/cluster/ops-guard',
      }),
    ]));
  });

  it('blocks when capability guard detects member or plugin bridge drift', () => {
    const diagnostics = buildClusterDiagnostics(healthyPayload({
      capabilityGuard: {
        status: 'blocked',
        ok: false,
        blockers: ['native_member_shared_bridge:room-1:claude#0'],
        warnings: [],
      },
    }));

    expect(diagnostics.status).toBe('blocked');
    expect(diagnostics.invariants.safeToStart).toBe(false);
    expect(diagnostics.invariants.capabilityGuardHealthy).toBe(false);
    expect(diagnostics.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'capability_guard_blocked',
        severity: 'blocker',
        evidence: ['native_member_shared_bridge:room-1:claude#0'],
      }),
    ]));
    expect(diagnostics.recoveryPlan).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'capability_guard_blocked',
        command: 'npm run repair:panel && npm run check:panel',
        endpoint: '/api/cluster/capability-guard',
      }),
    ]));
  });

  it('blocks when resource guard crosses hard limits', () => {
    const diagnostics = buildClusterDiagnostics(healthyPayload({
      resourceGuard: {
        status: 'blocked',
        ok: false,
        blockers: ['active_handles_gte_200'],
        warnings: [],
      },
    }));

    expect(diagnostics.status).toBe('blocked');
    expect(diagnostics.invariants.safeToStart).toBe(false);
    expect(diagnostics.invariants.resourceGuardHealthy).toBe(false);
    expect(diagnostics.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'resource_guard_blocked',
        severity: 'blocker',
        evidence: ['active_handles_gte_200'],
      }),
    ]));
    expect(diagnostics.recoveryPlan).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'resource_guard_blocked',
        command: 'npm run repair:panel && npm run check:panel',
        endpoint: '/api/cluster/resource-guard',
      }),
    ]));
  });

  it('blocks when long-term health trend is blocked', () => {
    const diagnostics = buildClusterDiagnostics(healthyPayload({
      healthTrend: {
        status: 'blocked',
        ok: false,
        blockers: ['consecutive_cluster_health_failures=2'],
        warnings: [],
      },
    }));

    expect(diagnostics.status).toBe('blocked');
    expect(diagnostics.invariants.safeToStart).toBe(false);
    expect(diagnostics.invariants.healthTrendHealthy).toBe(false);
    expect(diagnostics.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'health_trend_blocked',
        severity: 'blocker',
        evidence: ['consecutive_cluster_health_failures=2'],
      }),
    ]));
    expect(diagnostics.recoveryPlan).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'health_trend_blocked',
        blocksStart: true,
      }),
    ]));
  });

  it('blocks when readiness/config/concurrency expose hard blockers', () => {
    const diagnostics = buildClusterDiagnostics(healthyPayload({
      configAudit: { status: 'blocked', blockers: ['member_call_timeout_gte_stall_timeout=30000/30000'], warnings: [] },
      concurrencyBudget: { status: 'blocked', blockers: ['max_running_rooms_reached'], maxRunningRooms: 1 },
      health: { status: 'blocked', blockers: ['cluster_config_blocked'] },
      readiness: { status: 'blocked', blockers: ['cluster_config=member_call_timeout_gte_stall_timeout=30000/30000'], warnings: [] },
    }));

    expect(diagnostics.status).toBe('blocked');
    expect(diagnostics.invariants.safeToStart).toBe(false);
    expect(diagnostics.findings.map((item) => item.code)).toEqual(expect.arrayContaining([
      'config_audit_blocked',
      'concurrency_budget_blocked',
      'readiness_blocked',
      'health_blocked',
    ]));
    expect(diagnostics.recommendations.some((item) => item.action.includes('PANEL_CLUSTER_*'))).toBe(true);
    expect(diagnostics.recoveryPlan).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'config_audit_blocked',
        blocksStart: true,
        command: 'npm run check:panel',
        endpoint: '/api/cluster/readiness',
      }),
      expect.objectContaining({
        code: 'health_blocked',
        blocksStart: true,
        command: 'npm run check:panel && npm run restart:panel',
      }),
    ]));
  });

  it('warns when watchdog recovered stalled rooms but no blocker remains', () => {
    const diagnostics = buildClusterDiagnostics(healthyPayload({
      runtimeReconciliation: {
        status: 'recovered',
        recoveredRoomCount: 0,
        stalledActiveRoomCount: 1,
        cleanedActiveAbortCount: 0,
        recoveryErrorCount: 0,
        runtimePersistPending: { ok: true, pendingRooms: [] },
      },
      health: { status: 'passed', blockers: [] },
      readiness: { status: 'warn', blockers: [], warnings: ['runtime_recovered'] },
    }));

    expect(diagnostics.status).toBe('warn');
    expect(diagnostics.findings.map((item) => item.code)).toEqual(expect.arrayContaining([
      'runtime_recovery_not_clean',
      'stalled_recovered',
      'readiness_warn',
    ]));
    expect(diagnostics.recommendations.some((item) => item.action.includes('续跑策略'))).toBe(true);
    expect(diagnostics.recoveryPlan).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'stalled_recovered',
        blocksStart: false,
        ui: '房间摘要 -> 运行心跳/续跑策略',
      }),
    ]));
  });

  it('includes executable recovery plan entries for persistence failures', () => {
    const diagnostics = buildClusterDiagnostics(healthyPayload({
      runtimeReconciliation: {
        status: 'recovery_failed',
        recoveredRoomCount: 0,
        stalledActiveRoomCount: 0,
        cleanedActiveAbortCount: 0,
        recoveryErrorCount: 1,
        flushError: 'disk full',
        runtimePersistPending: {
          ok: false,
          status: 'pending',
          pendingRooms: [{ roomId: 'r1' }],
        },
      },
      health: { status: 'blocked', blockers: ['runtime_recovery_errors_present'] },
      readiness: { status: 'blocked', blockers: ['persist_recovery_pending'], warnings: [] },
    }));

    expect(diagnostics.status).toBe('blocked');
    expect(diagnostics.invariants.safeToStart).toBe(false);
    expect(diagnostics.findings.map((item) => item.code)).toEqual(expect.arrayContaining([
      'runtime_recovery_persist_failed',
      'runtime_persist_pending',
    ]));
    expect(diagnostics.recoveryPlan).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'runtime_recovery_persist_failed',
        blocksStart: true,
        command: 'npm run repair:panel',
        endpoint: '/api/cluster/diagnostics',
      }),
      expect.objectContaining({
        code: 'runtime_persist_pending',
        blocksStart: true,
        command: 'npm run repair:panel',
      }),
    ]));
  });
});
