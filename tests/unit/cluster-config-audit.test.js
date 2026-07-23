import { describe, expect, it } from 'vitest';
import { buildClusterConfigAudit } from '../../src/server/services/cluster-config-audit.js';

describe('cluster config audit', () => {
  it('passes with safe default cluster collaboration settings', () => {
    const audit = buildClusterConfigAudit({});

    expect(audit).toMatchObject({
      auditVersion: 'cluster-config-audit-v1',
      status: 'passed',
      blockers: [],
      config: {
        maxRunningRooms: 5,
        maxAdapterRunningRooms: 3,
        memberCallTimeoutMs: 0,
        stallTimeoutMs: 1800000,
      },
    });
    expect(audit.checks.map((check) => check.id)).toEqual([
      'multi_room_capacity_config',
      'adapter_room_capacity_config',
      'member_timeout_before_stall_watchdog',
      'stall_recovery_window_covers_timeout',
      'stall_recovery_attempts_available',
    ]);
  });

  it('blocks dangerous timeout ordering that would let watchdog pause legitimate calls first', () => {
    const audit = buildClusterConfigAudit({
      PANEL_CLUSTER_MEMBER_CALL_TIMEOUT_MS: '30000',
      PANEL_CLUSTER_STALL_TIMEOUT_MS: '30000',
    });

    expect(audit.status).toBe('blocked');
    expect(audit.blockers).toEqual(expect.arrayContaining([
      'member_call_timeout_gte_stall_timeout=30000/30000',
    ]));
  });

  it('blocks recovery windows that cannot count repeated stalls reliably', () => {
    const audit = buildClusterConfigAudit({
      PANEL_CLUSTER_STALL_TIMEOUT_MS: '60000',
      PANEL_CLUSTER_STALL_RECOVERY_WINDOW_MS: '30000',
    });

    expect(audit.status).toBe('blocked');
    expect(audit.blockers).toEqual(expect.arrayContaining([
      'stall_recovery_window_lt_stall_timeout=30000/60000',
    ]));
  });

  it('warns without blocking when capacity settings are odd but still safe', () => {
    const audit = buildClusterConfigAudit({
      PANEL_CLUSTER_MAX_RUNNING_ROOMS: '2',
      PANEL_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS: '5',
      PANEL_CLUSTER_START_RESERVATION_TTL_MS: '600001',
    });

    expect(audit.status).toBe('warn');
    expect(audit.blockers).toEqual([]);
    expect(audit.warnings).toEqual(expect.arrayContaining([
      'adapter_capacity_exceeds_room_capacity=5/2',
      'start_reservation_ttl_high=600001',
    ]));
  });
});
