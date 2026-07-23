import { describe, expect, it } from 'vitest';
import { assessPanelClusterHealth, buildPanelClusterReadiness } from '../../src/server/services/panel-health.js';

function healthyBudget(overrides = {}) {
  return {
    statusCode: 200,
    json: {
      ok: true,
      runtimeReconciliation: { status: 'clean', recoveryErrorCount: 0, runtimePersistPending: [] },
      concurrencyBudget: { status: 'passed', blockers: [], warnings: [], maxRunningRooms: 5, maxAdapterRunningRooms: 3 },
      ...overrides,
    },
  };
}

describe('panel cluster health assessment', () => {
  it('passes only when budget API, runtime recovery, and concurrency budget are clean', () => {
    expect(assessPanelClusterHealth(healthyBudget())).toMatchObject({
      status: 'passed',
      blockers: [],
      checks: [
        { name: 'budget_api', status: 'passed' },
        { name: 'runtime_reconciliation', status: 'passed', value: 'clean' },
        { name: 'concurrency_budget', status: 'passed', value: 'passed' },
        { name: 'cluster_config', status: 'passed', value: 'passed' },
      ],
    });
  });

  it('blocks when runtime recovery is not clean or still has pending persistence', () => {
    const result = assessPanelClusterHealth(healthyBudget({
      runtimeReconciliation: {
        status: 'pending_failed',
        recoveryErrorCount: 1,
        flushError: 'disk full',
        runtimePersistPending: { ok: false, pendingRooms: [{ roomId: 'r1' }] },
      },
    }));

    expect(result.status).toBe('blocked');
    expect(result.blockers).toEqual(expect.arrayContaining([
      'runtime_status=pending_failed',
      'runtime_recovery_errors_present',
      'runtime_flush_error_present',
      'runtime_persist_pending_present',
    ]));
  });

  it('blocks when concurrency budget is blocked even if the HTTP request itself succeeded', () => {
    const result = assessPanelClusterHealth(healthyBudget({
      concurrencyBudget: {
        status: 'blocked',
        blockers: ['adapter:claude=max_running_rooms'],
      },
    }));

    expect(result.status).toBe('blocked');
    expect(result.blockers).toEqual(expect.arrayContaining([
      'concurrency_status=blocked',
      'concurrency_blockers_present',
    ]));
  });

  it('blocks unreachable or malformed budget responses instead of treating missing fields as healthy', () => {
    expect(assessPanelClusterHealth({ error: 'ECONNREFUSED' }).blockers).toEqual(expect.arrayContaining([
      'budget_status_code=missing',
      'budget_ok_not_true',
      'runtime_status=missing',
      'concurrency_status=missing',
    ]));
  });

  it('blocks health when cluster config is dangerous', () => {
    const result = assessPanelClusterHealth(healthyBudget({
      configAudit: {
        status: 'blocked',
        blockers: ['member_call_timeout_gte_stall_timeout=30000/30000'],
      },
    }));

    expect(result.status).toBe('blocked');
    expect(result.blockers).toEqual(expect.arrayContaining([
      'cluster_config_blocked',
      'cluster_config=member_call_timeout_gte_stall_timeout=30000/30000',
    ]));
  });

  it('builds a machine-readable readiness audit for healthy cluster collaboration', () => {
    const result = buildPanelClusterReadiness(healthyBudget().json);

    expect(result).toMatchObject({
      readinessVersion: 'cluster-readiness-v1',
      status: 'passed',
      blockers: [],
      capabilities: {
        mode: 'cross_verify',
        multiRoom: true,
        maxRunningRooms: 5,
        maxAdapterRunningRooms: 3,
        runtimeWatchdog: true,
        persistRecoveryMarker: true,
        degradedTakeover: true,
        goalMode: true,
        configAudit: { status: 'passed' },
      },
    });
    expect(result.checks.map((check) => check.id)).toEqual([
      'runtime_recovery_clean',
      'persist_recovery_clean',
      'concurrency_budget_available',
      'multi_room_capacity',
      'adapter_room_capacity',
      'cluster_config_safe',
    ]);
  });

  it('blocks readiness when runtime persistence or multi-room capacity is not safe', () => {
    const result = buildPanelClusterReadiness(healthyBudget({
      runtimeReconciliation: {
        status: 'clean',
        runtimePersistPending: { ok: false, pendingRooms: [{ roomId: 'r1' }] },
      },
      concurrencyBudget: {
        status: 'passed',
        blockers: [],
        warnings: [],
        maxRunningRooms: 1,
        maxAdapterRunningRooms: 0,
      },
    }).json);

    expect(result.status).toBe('blocked');
    expect(result.blockers).toEqual(expect.arrayContaining([
      'pending_rooms=1',
      'runtime_persist_pending_failed',
      'maxRunningRooms_lt_2=1',
      'maxAdapterRunningRooms_lt_1=0',
    ]));
  });

  it('blocks readiness when cluster config audit is blocked', () => {
    const result = buildPanelClusterReadiness(healthyBudget({
      configAudit: {
        status: 'blocked',
        blockers: ['stall_recovery_window_lt_stall_timeout=1000/30000'],
        warnings: [],
        checks: [{ id: 'stall_recovery_window_covers_timeout', status: 'blocked' }],
      },
    }).json);

    expect(result.status).toBe('blocked');
    expect(result.blockers).toEqual(expect.arrayContaining([
      'cluster_config=stall_recovery_window_lt_stall_timeout=1000/30000',
    ]));
  });
});
