import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildClusterDiagnostics } from './cluster-diagnostics.js';

function ensureParent(filePath) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
}

function basePayload(overrides = {}) {
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
    rooms: [
      { id: 'cluster-running', mode: 'cross_verify', status: 'running' },
      { id: 'cluster-paused', mode: 'cross_verify', status: 'paused' },
    ],
    ...overrides,
  };
}

function codes(diagnostics) {
  return new Set((diagnostics.findings || []).map((item) => item.code));
}

function recoveryCommands(diagnostics) {
  return new Set((diagnostics.recoveryPlan || []).map((item) => item.command).filter(Boolean));
}

function recoveryEndpoints(diagnostics) {
  return new Set((diagnostics.recoveryPlan || []).map((item) => item.endpoint).filter(Boolean));
}

export const DEFAULT_CLUSTER_DIAGNOSTICS_DRILL_CASES = [
  {
    id: 'healthy_cluster',
    payload: basePayload(),
    expect: {
      status: 'passed',
      safeToStart: true,
      codes: [],
      blockingRecoveryActions: 0,
    },
  },
  {
    id: 'config_and_concurrency_blocked',
    payload: basePayload({
      configAudit: {
        status: 'blocked',
        blockers: ['member_call_timeout_gte_stall_timeout=30000/30000'],
        warnings: [],
      },
      concurrencyBudget: {
        status: 'blocked',
        blockers: ['running_rooms_gt_1'],
        maxRunningRooms: 1,
      },
      health: { status: 'blocked', blockers: ['cluster_config_blocked'] },
      readiness: {
        status: 'blocked',
        blockers: ['cluster_config=member_call_timeout_gte_stall_timeout=30000/30000'],
        warnings: [],
        capabilities: { multiRoom: false, maxRunningRooms: 1, maxAdapterRunningRooms: 1 },
      },
    }),
    expect: {
      status: 'blocked',
      safeToStart: false,
      codes: ['config_audit_blocked', 'concurrency_budget_blocked', 'readiness_blocked', 'health_blocked'],
      commands: ['npm run check:panel', 'npm run check:panel && npm run restart:panel'],
      endpoints: ['/api/cluster/readiness', '/api/cluster/concurrency-budget', '/api/cluster/health'],
      blockingRecoveryActions: 4,
    },
  },
  {
    id: 'runtime_persistence_failed',
    payload: basePayload({
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
          pendingRooms: [{ roomId: 'cluster-running' }],
        },
      },
      health: { status: 'blocked', blockers: ['runtime_recovery_errors_present'] },
      readiness: {
        status: 'blocked',
        blockers: ['persist_recovery_pending'],
        warnings: [],
        capabilities: { multiRoom: true, maxRunningRooms: 5, maxAdapterRunningRooms: 3 },
      },
    }),
    expect: {
      status: 'blocked',
      safeToStart: false,
      codes: ['runtime_recovery_not_clean', 'runtime_recovery_persist_failed', 'runtime_persist_pending', 'readiness_blocked', 'health_blocked'],
      commands: ['npm run repair:panel', 'npm run repair:panel && npm run check:panel'],
      endpoints: ['/api/cluster/diagnostics', '/api/cluster/readiness', '/api/cluster/health'],
      blockingRecoveryActions: 5,
    },
  },
  {
    id: 'stall_recovered_warn',
    payload: basePayload({
      runtimeReconciliation: {
        status: 'recovered',
        recoveredRoomCount: 0,
        stalledActiveRoomCount: 1,
        cleanedActiveAbortCount: 0,
        recoveryErrorCount: 0,
        runtimePersistPending: { ok: true, pendingRooms: [] },
      },
      readiness: {
        status: 'warn',
        blockers: [],
        warnings: ['runtime_recovered'],
        capabilities: { multiRoom: true, maxRunningRooms: 5, maxAdapterRunningRooms: 3 },
      },
    }),
    expect: {
      status: 'warn',
      safeToStart: true,
      codes: ['runtime_recovery_not_clean', 'stalled_recovered', 'readiness_warn'],
      commands: ['npm run repair:panel && npm run check:panel', 'npm run check:panel'],
      endpoints: ['/api/cluster/readiness', '/api/cluster/diagnostics'],
      blockingRecoveryActions: 0,
    },
  },
];

export function evaluateClusterDiagnosticsDrillCase(testCase) {
  const diagnostics = buildClusterDiagnostics(testCase.payload);
  const failures = [];
  if (testCase.expect.status && diagnostics.status !== testCase.expect.status) {
    failures.push(`status=${diagnostics.status}, expected=${testCase.expect.status}`);
  }
  if (typeof testCase.expect.safeToStart === 'boolean' && diagnostics.invariants?.safeToStart !== testCase.expect.safeToStart) {
    failures.push(`safeToStart=${diagnostics.invariants?.safeToStart}, expected=${testCase.expect.safeToStart}`);
  }
  const actualCodes = codes(diagnostics);
  for (const code of testCase.expect.codes || []) {
    if (!actualCodes.has(code)) failures.push(`missing_finding=${code}`);
  }
  const actualCommands = recoveryCommands(diagnostics);
  for (const command of testCase.expect.commands || []) {
    if (!actualCommands.has(command)) failures.push(`missing_command=${command}`);
  }
  const actualEndpoints = recoveryEndpoints(diagnostics);
  for (const endpoint of testCase.expect.endpoints || []) {
    if (!actualEndpoints.has(endpoint)) failures.push(`missing_endpoint=${endpoint}`);
  }
  if (typeof testCase.expect.blockingRecoveryActions === 'number') {
    const count = (diagnostics.recoveryPlan || []).filter((item) => item.blocksStart === true).length;
    if (count !== testCase.expect.blockingRecoveryActions) {
      failures.push(`blockingRecoveryActions=${count}, expected=${testCase.expect.blockingRecoveryActions}`);
    }
  }
  return {
    id: testCase.id,
    ok: failures.length === 0,
    failures,
    diagnostics: {
      status: diagnostics.status,
      safeToStart: diagnostics.invariants?.safeToStart,
      findings: (diagnostics.findings || []).map((item) => item.code),
      recoveryPlan: (diagnostics.recoveryPlan || []).map((item) => ({
        code: item.code,
        severity: item.severity,
        blocksStart: item.blocksStart,
        command: item.command,
        endpoint: item.endpoint,
        ui: item.ui,
      })),
    },
  };
}

export function buildClusterDiagnosticsDrillReport({
  cases = DEFAULT_CLUSTER_DIAGNOSTICS_DRILL_CASES,
  now = new Date(),
} = {}) {
  const results = cases.map(evaluateClusterDiagnosticsDrillCase);
  const generatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  return {
    generatedAt,
    ok: results.every((item) => item.ok),
    caseCount: results.length,
    failedCaseCount: results.filter((item) => !item.ok).length,
    results,
  };
}

function normalizeMaxHistoryLines(value, fallback = 200) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return fallback;
  return n;
}

function trimHistory(path, maxLines) {
  const n = normalizeMaxHistoryLines(maxLines);
  let raw = '';
  try { raw = readFileSync(path, 'utf8'); } catch { return { trimmed: false, lineCount: 0, maxHistoryLines: n }; }
  const lines = raw.split('\n').filter((line) => line.trim());
  if (lines.length <= n) return { trimmed: false, lineCount: lines.length, maxHistoryLines: n };
  const kept = lines.slice(-n);
  writeFileSync(path, `${kept.join('\n')}\n`, { mode: 0o600 });
  return { trimmed: true, lineCount: kept.length, previousLineCount: lines.length, maxHistoryLines: n };
}

export function writeClusterDiagnosticsDrillReport(report, {
  latestPath,
  historyPath,
  maxHistoryLines = 200,
} = {}) {
  if (!latestPath || !historyPath) {
    return { written: false, error: 'cluster_diagnostics_drill_report_path_missing' };
  }
  try {
    ensureParent(latestPath);
    ensureParent(historyPath);
    writeFileSync(latestPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    appendFileSync(historyPath, `${JSON.stringify({
      generatedAt: report.generatedAt,
      ok: report.ok,
      caseCount: report.caseCount,
      failedCaseCount: report.failedCaseCount,
    })}\n`, { mode: 0o600 });
    const retention = trimHistory(historyPath, maxHistoryLines);
    return { written: true, latestPath, historyPath, retention };
  } catch (e) {
    return {
      written: false,
      latestPath,
      historyPath,
      error: e?.message || String(e),
    };
  }
}
