import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  buildClusterConcurrencyBudget,
  clearClusterStartReservationsForTest,
  reserveClusterStart,
} from '../routes/roomStart.js';

function ensureParent(filePath) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
}

function room(id, status, adapterIds) {
  return {
    id,
    name: id,
    mode: 'cross_verify',
    status,
    members: adapterIds.map((adapterId) => ({ adapterId, enabled: true })),
  };
}

function roomStore(rooms) {
  return { list: () => rooms };
}

function missingExpectation(failures, label, actual, expected) {
  failures.push(`${label}=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)}`);
}

function assertBudget(expect, budget) {
  const failures = [];
  for (const [key, expected] of Object.entries(expect || {})) {
    const actual = budget?.[key];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) missingExpectation(failures, key, actual, expected);
  }
  return failures;
}

function consensusAdapterIds(roomState = {}) {
  return [...new Set((Array.isArray(roomState.taskList) ? roomState.taskList : [])
    .flatMap((task) => task?.consensus?.byMembers || [])
    .map((memberKey) => String(memberKey || '').split('#')[0].trim())
    .filter(Boolean))];
}

function evaluateTakeoverContract({
  roomState,
  broadcasts,
  expectedDroppedAdapterIds = [],
  expectedRemainingAdapterIds = [],
  expectedEventType,
}) {
  const failures = [];
  const droppedIds = new Set((roomState?.clusterDroppedMembers || []).map((item) => String(item?.adapterId || '').trim()).filter(Boolean));
  const enabledSurvivors = (Array.isArray(roomState?.members) ? roomState.members : [])
    .filter((member) => member?.enabled !== false)
    .map((member) => String(member?.adapterId || '').trim())
    .filter(Boolean)
    .filter((adapterId) => !droppedIds.has(adapterId));
  for (const adapterId of expectedDroppedAdapterIds) {
    if (!droppedIds.has(adapterId)) failures.push(`missing_dropped_member=${adapterId}`);
  }
  if (JSON.stringify(enabledSurvivors.sort()) !== JSON.stringify([...expectedRemainingAdapterIds].sort())) {
    missingExpectation(failures, 'remainingMembers', enabledSurvivors.sort(), [...expectedRemainingAdapterIds].sort());
  }
  if (enabledSurvivors.length < 1) failures.push('no_surviving_member_can_continue');
  const takeoverEvent = (Array.isArray(broadcasts) ? broadcasts : []).find((item) => item?.type === expectedEventType);
  if (!takeoverEvent) failures.push(`missing_takeover_event=${expectedEventType}`);
  if (takeoverEvent && JSON.stringify((takeoverEvent.remainingMembers || []).sort()) !== JSON.stringify([...expectedRemainingAdapterIds].sort())) {
    missingExpectation(failures, 'takeoverEvent.remainingMembers', (takeoverEvent.remainingMembers || []).sort(), [...expectedRemainingAdapterIds].sort());
  }
  const consensusIds = consensusAdapterIds(roomState);
  const invalidConsensusIds = consensusIds.filter((adapterId) => !expectedRemainingAdapterIds.includes(adapterId));
  if (invalidConsensusIds.length) failures.push(`consensus_contains_dropped_members=${invalidConsensusIds.join(',')}`);
  return failures;
}

function evaluateCase(testCase) {
  clearClusterStartReservationsForTest();
  try {
    const result = testCase.run();
    return {
      id: testCase.id,
      ok: result.failures.length === 0,
      failures: result.failures,
      evidence: result.evidence || {},
    };
  } catch (e) {
    return {
      id: testCase.id,
      ok: false,
      failures: [e?.message || String(e)],
      evidence: {},
    };
  } finally {
    clearClusterStartReservationsForTest();
  }
}

export const DEFAULT_CLUSTER_RESILIENCE_DRILL_CASES = [
  {
    id: 'multi_room_capacity_boundary_allows_fifth_room',
    run() {
      const budget = buildClusterConcurrencyBudget(room('new-room', 'idle', ['claude', 'codex', 'gemini-cli']), {
        roomStore: roomStore([
          room('running-1', 'running', ['claude']),
          room('running-2', 'running', ['codex']),
          room('running-3', 'running', ['gemini-cli']),
          room('running-4', 'running', ['claude', 'codex']),
        ]),
        maxRunningRooms: 5,
        maxAdapterRunningRooms: 3,
      });
      return {
        failures: assertBudget({
          status: 'warn',
          runningRoomCount: 4,
          projectedRunningRoomCount: 5,
          maxRunningRooms: 5,
          maxAdapterRunningRooms: 3,
          blockers: [],
        }, budget),
        evidence: {
          status: budget.status,
          projectedRunningRoomCount: budget.projectedRunningRoomCount,
          warnings: budget.warnings,
        },
      };
    },
  },
  {
    id: 'sixth_room_is_blocked_before_start',
    run() {
      const budget = buildClusterConcurrencyBudget(room('new-room', 'idle', ['gemini-cli']), {
        roomStore: roomStore([
          room('running-1', 'running', ['claude']),
          room('running-2', 'running', ['codex']),
          room('running-3', 'running', ['gemini-cli']),
          room('running-4', 'running', ['claude']),
          room('running-5', 'running', ['codex']),
        ]),
        maxRunningRooms: 5,
        maxAdapterRunningRooms: 3,
      });
      return {
        failures: assertBudget({
          status: 'blocked',
          runningRoomCount: 5,
          projectedRunningRoomCount: 6,
          blockers: ['running_rooms_gt_5'],
        }, budget),
        evidence: {
          status: budget.status,
          projectedRunningRoomCount: budget.projectedRunningRoomCount,
          blockers: budget.blockers,
        },
      };
    },
  },
  {
    id: 'single_adapter_capacity_is_blocked',
    run() {
      const budget = buildClusterConcurrencyBudget(room('new-room', 'idle', ['claude']), {
        roomStore: roomStore([
          room('running-1', 'running', ['claude']),
          room('running-2', 'running', ['claude']),
          room('running-3', 'running', ['claude']),
        ]),
        maxRunningRooms: 5,
        maxAdapterRunningRooms: 3,
      });
      return {
        failures: assertBudget({
          status: 'blocked',
          projectedRunningRoomCount: 4,
          projectedAdapterLoad: { claude: 4 },
          blockers: ['adapter_running_rooms_gt_3:claude=4'],
        }, budget),
        evidence: {
          status: budget.status,
          projectedAdapterLoad: budget.projectedAdapterLoad,
          blockers: budget.blockers,
        },
      };
    },
  },
  {
    id: 'in_flight_start_reservation_counts_against_budget',
    run() {
      const reservation = reserveClusterStart(room('starting-1', 'starting', ['claude']));
      if (!reservation.ok) return { failures: [`reservation_failed=${reservation.reason}`] };
      const budget = buildClusterConcurrencyBudget(room('new-room', 'idle', ['codex']), {
        roomStore: roomStore([
          room('running-1', 'running', ['gemini-cli']),
        ]),
        maxRunningRooms: 5,
        maxAdapterRunningRooms: 3,
      });
      return {
        failures: assertBudget({
          status: 'warn',
          runningRoomCount: 1,
          startingRoomCount: 1,
          projectedRunningRoomCount: 3,
        }, budget),
        evidence: {
          status: budget.status,
          startingRooms: budget.startingRooms,
          projectedRunningRoomCount: budget.projectedRunningRoomCount,
        },
      };
    },
  },
  {
    id: 'solo_takeover_keeps_survivor_delivery_contract',
    run() {
      const roomState = {
        id: 'solo-takeover',
        mode: 'cross_verify',
        status: 'done',
        members: [
          { adapterId: 'claude', enabled: true },
          { adapterId: 'codex', enabled: true },
        ],
        clusterDroppedMembers: [
          { adapterId: 'claude', reason: '连接/运行时不可用: adapter offline' },
        ],
        taskList: [
          { consensus: { byMembers: ['codex#2'] } },
        ],
      };
      const broadcasts = [
        { type: 'cv_member_failover', adapterId: 'claude' },
        { type: 'cv_solo_takeover', remainingMembers: ['codex'] },
      ];
      return {
        failures: evaluateTakeoverContract({
          roomState,
          broadcasts,
          expectedDroppedAdapterIds: ['claude'],
          expectedRemainingAdapterIds: ['codex'],
          expectedEventType: 'cv_solo_takeover',
        }),
        evidence: {
          droppedMembers: roomState.clusterDroppedMembers,
          broadcasts,
          consensusMembers: consensusAdapterIds(roomState),
        },
      };
    },
  },
  {
    id: 'partial_drop_keeps_multi_member_takeover_contract',
    run() {
      const roomState = {
        id: 'partial-takeover',
        mode: 'cross_verify',
        status: 'done',
        members: [
          { adapterId: 'claude', enabled: true },
          { adapterId: 'codex', enabled: true },
          { adapterId: 'gemini-cli', enabled: true },
        ],
        clusterDroppedMembers: [
          { adapterId: 'gemini-cli', reason: '额度/限流: quota 429 RESOURCE_EXHAUSTED' },
        ],
        taskList: [
          { consensus: { byMembers: ['claude#1', 'codex#2'] } },
        ],
      };
      const broadcasts = [
        { type: 'cv_member_failover', adapterId: 'gemini-cli' },
        { type: 'cv_failover_takeover', remainingMembers: ['claude', 'codex'] },
      ];
      return {
        failures: evaluateTakeoverContract({
          roomState,
          broadcasts,
          expectedDroppedAdapterIds: ['gemini-cli'],
          expectedRemainingAdapterIds: ['claude', 'codex'],
          expectedEventType: 'cv_failover_takeover',
        }),
        evidence: {
          droppedMembers: roomState.clusterDroppedMembers,
          broadcasts,
          consensusMembers: consensusAdapterIds(roomState),
        },
      };
    },
  },
];

export function buildClusterResilienceDrillReport({
  cases = DEFAULT_CLUSTER_RESILIENCE_DRILL_CASES,
  now = new Date(),
} = {}) {
  const results = cases.map(evaluateCase);
  const generatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  return {
    drillVersion: 'cluster-resilience-drill-v1',
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

export function writeClusterResilienceDrillReport(report, {
  latestPath,
  historyPath,
  maxHistoryLines = 200,
} = {}) {
  if (!latestPath || !historyPath) {
    return { written: false, error: 'cluster_resilience_drill_report_path_missing' };
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
