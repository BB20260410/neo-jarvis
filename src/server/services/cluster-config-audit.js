const DEFAULT_CLUSTER_MAX_RUNNING_ROOMS = 5;
const DEFAULT_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS = 3;
const DEFAULT_CLUSTER_START_RESERVATION_TTL_MS = 60_000;
const DEFAULT_CLUSTER_STALL_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_CLUSTER_STALL_RECOVERY_WINDOW_MS = 2 * 60 * 60_000;
const DEFAULT_CLUSTER_MAX_STALL_RECOVERIES = 3;

function positiveIntFromEnv(env, name, fallback) {
  const raw = env?.[name];
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return fallback;
  return n;
}

function nonNegativeIntFromEnv(env, name, fallback) {
  const raw = env?.[name];
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return fallback;
  return n;
}

function auditCheck(id, label, passed, {
  value = null,
  evidence = [],
  blockers = [],
  warnings = [],
} = {}) {
  return {
    id,
    label,
    status: passed ? 'passed' : 'blocked',
    value,
    evidence,
    blockers: passed ? [] : blockers,
    warnings,
  };
}

export function buildClusterConfigAudit(env = process.env) {
  const config = {
    maxRunningRooms: positiveIntFromEnv(env, 'PANEL_CLUSTER_MAX_RUNNING_ROOMS', DEFAULT_CLUSTER_MAX_RUNNING_ROOMS),
    maxAdapterRunningRooms: positiveIntFromEnv(env, 'PANEL_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS', DEFAULT_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS),
    startReservationTtlMs: positiveIntFromEnv(env, 'PANEL_CLUSTER_START_RESERVATION_TTL_MS', DEFAULT_CLUSTER_START_RESERVATION_TTL_MS),
    stallTimeoutMs: positiveIntFromEnv(env, 'PANEL_CLUSTER_STALL_TIMEOUT_MS', DEFAULT_CLUSTER_STALL_TIMEOUT_MS),
    stallRecoveryWindowMs: positiveIntFromEnv(env, 'PANEL_CLUSTER_STALL_RECOVERY_WINDOW_MS', DEFAULT_CLUSTER_STALL_RECOVERY_WINDOW_MS),
    maxStallRecoveries: positiveIntFromEnv(env, 'PANEL_CLUSTER_MAX_STALL_RECOVERIES', DEFAULT_CLUSTER_MAX_STALL_RECOVERIES),
    memberCallTimeoutMs: nonNegativeIntFromEnv(env, 'PANEL_CLUSTER_MEMBER_CALL_TIMEOUT_MS', 0),
  };

  const checks = [
    auditCheck(
      'multi_room_capacity_config',
      '多房间并发配置可用',
      config.maxRunningRooms >= 2,
      {
        value: config.maxRunningRooms,
        evidence: [`PANEL_CLUSTER_MAX_RUNNING_ROOMS=${config.maxRunningRooms}`],
        blockers: [`PANEL_CLUSTER_MAX_RUNNING_ROOMS_lt_2=${config.maxRunningRooms}`],
      },
    ),
    auditCheck(
      'adapter_room_capacity_config',
      '单适配器并发配置可用',
      config.maxAdapterRunningRooms >= 1,
      {
        value: config.maxAdapterRunningRooms,
        evidence: [`PANEL_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS=${config.maxAdapterRunningRooms}`],
        blockers: [`PANEL_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS_lt_1=${config.maxAdapterRunningRooms}`],
      },
    ),
    auditCheck(
      'member_timeout_before_stall_watchdog',
      '成员调用无默认硬超时或早于停滞 watchdog',
      config.memberCallTimeoutMs === 0 || config.memberCallTimeoutMs < config.stallTimeoutMs,
      {
        value: `${config.memberCallTimeoutMs}/${config.stallTimeoutMs}`,
        evidence: [
          `PANEL_CLUSTER_MEMBER_CALL_TIMEOUT_MS=${config.memberCallTimeoutMs || '0(no_hard_timeout)'}`,
          `PANEL_CLUSTER_STALL_TIMEOUT_MS=${config.stallTimeoutMs}`,
        ],
        blockers: [`member_call_timeout_gte_stall_timeout=${config.memberCallTimeoutMs}/${config.stallTimeoutMs}`],
      },
    ),
    auditCheck(
      'stall_recovery_window_covers_timeout',
      '停滞恢复统计窗口覆盖停滞阈值',
      config.stallRecoveryWindowMs >= config.stallTimeoutMs,
      {
        value: `${config.stallRecoveryWindowMs}/${config.stallTimeoutMs}`,
        evidence: [
          `PANEL_CLUSTER_STALL_RECOVERY_WINDOW_MS=${config.stallRecoveryWindowMs}`,
          `PANEL_CLUSTER_STALL_TIMEOUT_MS=${config.stallTimeoutMs}`,
        ],
        blockers: [`stall_recovery_window_lt_stall_timeout=${config.stallRecoveryWindowMs}/${config.stallTimeoutMs}`],
      },
    ),
    auditCheck(
      'stall_recovery_attempts_available',
      '停滞恢复限流次数可用',
      config.maxStallRecoveries >= 1,
      {
        value: config.maxStallRecoveries,
        evidence: [`PANEL_CLUSTER_MAX_STALL_RECOVERIES=${config.maxStallRecoveries}`],
        blockers: [`PANEL_CLUSTER_MAX_STALL_RECOVERIES_lt_1=${config.maxStallRecoveries}`],
      },
    ),
  ];

  const warnings = [];
  if (config.startReservationTtlMs > 5 * 60_000) {
    warnings.push(`start_reservation_ttl_high=${config.startReservationTtlMs}`);
  }
  if (config.maxAdapterRunningRooms > config.maxRunningRooms) {
    warnings.push(`adapter_capacity_exceeds_room_capacity=${config.maxAdapterRunningRooms}/${config.maxRunningRooms}`);
  }

  const blockers = checks.flatMap((check) => check.blockers || []);
  return {
    auditVersion: 'cluster-config-audit-v1',
    status: blockers.length ? 'blocked' : warnings.length ? 'warn' : 'passed',
    generatedAt: new Date().toISOString(),
    config,
    checks,
    blockers,
    warnings,
  };
}
