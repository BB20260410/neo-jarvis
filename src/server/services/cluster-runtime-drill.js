import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CrossVerifyDispatcher } from '../../room/CrossVerifyDispatcher.js';

function ensureParent(filePath) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
}

function makeStore() {
  return {
    _rooms: new Map(),
    get(id) { return this._rooms.get(id); },
    list() { return [...this._rooms.values()]; },
    update(id, patch) {
      const room = this._rooms.get(id);
      if (room) Object.assign(room, patch);
      return room;
    },
    setStatus(id, status) {
      const room = this._rooms.get(id);
      if (room) room.status = status;
      return room;
    },
    flush() {},
  };
}

function makeSingleTaskList(id = 'RT1') {
  return [{
    id,
    title: '真实调度链路演练任务',
    desc: '通过真实 CrossVerifyDispatcher.start 路径验证集群协同可以启动、接管、收尾。',
    rounds: [],
    status: 'pending',
  }];
}

function makeRoom(id, members) {
  return {
    id,
    name: id,
    mode: 'cross_verify',
    cwd: '/tmp',
    members: members.map((adapterId) => ({ adapterId, enabled: true })),
    taskList: makeSingleTaskList(`${id}-task`),
  };
}

function makeAdapter(id, {
  failOnce = false,
  alwaysFail = false,
  hang = false,
  onAbort = null,
} = {}) {
  let failed = false;
  return {
    id,
    displayName: id,
    async chat(messages, opts = {}) {
      const prompt = messages[messages.length - 1]?.content || '';
      if (hang) {
        opts.abortSignal?.addEventListener?.('abort', () => {
          if (typeof onAbort === 'function') onAbort();
        }, { once: true });
        return new Promise(() => {});
      }
      if (alwaysFail) throw new Error('adapter offline');
      if (failOnce && !failed) {
        failed = true;
        throw new Error('quota 429 RESOURCE_EXHAUSTED');
      }
      if (prompt.includes('评审输出')) {
        return {
          reply: JSON.stringify({
            agree: true,
            reasoning: `${id} 同意当前交付`,
            suggestions: [],
            critical_issues: [],
          }),
          tokensIn: 1,
          tokensOut: 1,
        };
      }
      return {
        reply: `# ${id} 离线演练方案\n本任务用于验证真实调度链路,不写入项目文件。`,
        tokensIn: 1,
        tokensOut: 1,
      };
    },
  };
}

function taskConsensusMembers(room = {}) {
  return [...new Set((Array.isArray(room.taskList) ? room.taskList : [])
    .flatMap((task) => task?.consensus?.byMembers || [])
    .map((memberKey) => String(memberKey || '').split('#')[0].trim())
    .filter(Boolean))];
}

function requireRoomDone(failures, room, roomId) {
  if (room?.status !== 'done') failures.push(`${roomId}.status=${room?.status || 'missing'}, expected=done`);
  const task = room?.taskList?.[0];
  if (task?.status !== 'done') failures.push(`${roomId}.task.status=${task?.status || 'missing'}, expected=done`);
}

async function runConcurrentRoomsCase() {
  const store = makeStore();
  const broadcasts = [];
  const adapters = new Map([
    ['runtime-a', makeAdapter('runtime-a')],
    ['runtime-b', makeAdapter('runtime-b')],
    ['runtime-c', makeAdapter('runtime-c')],
  ]);
  store._rooms.set('runtime-room-1', makeRoom('runtime-room-1', ['runtime-a', 'runtime-b']));
  store._rooms.set('runtime-room-2', makeRoom('runtime-room-2', ['runtime-b', 'runtime-c']));
  const dispatcher = new CrossVerifyDispatcher({
    store,
    adapters,
    broadcast: (roomId, msg) => broadcasts.push({ roomId, ...msg }),
  });

  await Promise.all([
    dispatcher.start('runtime-room-1', '真实链路并发房间 1'),
    dispatcher.start('runtime-room-2', '真实链路并发房间 2'),
  ]);

  const room1 = store.get('runtime-room-1');
  const room2 = store.get('runtime-room-2');
  const failures = [];
  requireRoomDone(failures, room1, 'runtime-room-1');
  requireRoomDone(failures, room2, 'runtime-room-2');
  if (dispatcher.activeAborts.size !== 0) failures.push(`activeAborts.size=${dispatcher.activeAborts.size}, expected=0`);
  if (!broadcasts.some((msg) => msg.roomId === 'runtime-room-1' && msg.type === 'cross_verify_done')) {
    failures.push('missing_done_broadcast=runtime-room-1');
  }
  if (!broadcasts.some((msg) => msg.roomId === 'runtime-room-2' && msg.type === 'cross_verify_done')) {
    failures.push('missing_done_broadcast=runtime-room-2');
  }
  return {
    failures,
    evidence: {
      roomStatuses: {
        'runtime-room-1': room1?.status,
        'runtime-room-2': room2?.status,
      },
      activeAbortCount: dispatcher.activeAborts.size,
      doneBroadcasts: broadcasts.filter((msg) => msg.type === 'cross_verify_done').length,
    },
  };
}

async function runQuotaFailoverCase() {
  const store = makeStore();
  const broadcasts = [];
  const adapters = new Map([
    ['runtime-ok-a', makeAdapter('runtime-ok-a')],
    ['runtime-quota', makeAdapter('runtime-quota', { failOnce: true })],
    ['runtime-ok-c', makeAdapter('runtime-ok-c')],
  ]);
  store._rooms.set('runtime-failover', makeRoom('runtime-failover', ['runtime-ok-a', 'runtime-quota', 'runtime-ok-c']));
  const dispatcher = new CrossVerifyDispatcher({
    store,
    adapters,
    broadcast: (roomId, msg) => broadcasts.push({ roomId, ...msg }),
  });

  await dispatcher.start('runtime-failover', '真实链路额度掉线接管');

  const room = store.get('runtime-failover');
  const failures = [];
  requireRoomDone(failures, room, 'runtime-failover');
  const dropped = room?.clusterDroppedMembers || [];
  if (!dropped.some((item) => item.adapterId === 'runtime-quota')) failures.push('missing_dropped_member=runtime-quota');
  if (!broadcasts.some((msg) => msg.type === 'cv_failover_takeover' && msg.remainingMembers?.length === 2)) {
    failures.push('missing_multi_member_takeover_broadcast');
  }
  const consensus = taskConsensusMembers(room);
  if (consensus.includes('runtime-quota')) failures.push('consensus_contains_dropped_member=runtime-quota');
  return {
    failures,
    evidence: {
      status: room?.status,
      droppedMembers: dropped.map((item) => item.adapterId),
      consensusMembers: consensus,
      takeoverBroadcasts: broadcasts.filter((msg) => msg.type === 'cv_failover_takeover').length,
    },
  };
}

async function runTimeoutSoloTakeoverCase() {
  let aborted = false;
  const store = makeStore();
  const broadcasts = [];
  const adapters = new Map([
    ['runtime-hanging', makeAdapter('runtime-hanging', { hang: true, onAbort: () => { aborted = true; } })],
    ['runtime-survivor', makeAdapter('runtime-survivor')],
  ]);
  store._rooms.set('runtime-timeout', makeRoom('runtime-timeout', ['runtime-hanging', 'runtime-survivor']));
  const dispatcher = new CrossVerifyDispatcher({
    store,
    adapters,
    broadcast: (roomId, msg) => broadcasts.push({ roomId, ...msg }),
    memberCallTimeoutMs: 20,
  });

  await dispatcher.start('runtime-timeout', '真实链路超时单模型接管');

  const room = store.get('runtime-timeout');
  const failures = [];
  requireRoomDone(failures, room, 'runtime-timeout');
  if (!aborted) failures.push('hanging_member_abort_signal_not_observed');
  if (dispatcher.activeAborts.size !== 0) failures.push(`activeAborts.size=${dispatcher.activeAborts.size}, expected=0`);
  if (!broadcasts.some((msg) => msg.type === 'cluster_member_call_timeout' && msg.adapterId === 'runtime-hanging')) {
    failures.push('missing_member_timeout_broadcast');
  }
  if (!broadcasts.some((msg) => msg.type === 'cv_solo_takeover' && msg.remainingMembers?.length === 1)) {
    failures.push('missing_solo_takeover_broadcast');
  }
  const consensus = taskConsensusMembers(room);
  if (JSON.stringify(consensus) !== JSON.stringify(['runtime-survivor'])) {
    failures.push(`consensusMembers=${JSON.stringify(consensus)}, expected=["runtime-survivor"]`);
  }
  return {
    failures,
    evidence: {
      status: room?.status,
      aborted,
      activeAbortCount: dispatcher.activeAborts.size,
      consensusMembers: consensus,
      timeoutBroadcasts: broadcasts.filter((msg) => msg.type === 'cluster_member_call_timeout').length,
    },
  };
}

async function runAbortResumeRaceCase() {
  const ack = JSON.stringify({ agree: true, reasoning: '同意', suggestions: [], critical_issues: [] });
  const store = makeStore();
  const broadcasts = [];
  let resolveFirstStarted;
  let resolveOldAbortSeen;
  let releaseOldAbort;
  let resolveSecondStarted;
  let releaseSecond;
  const firstStarted = new Promise((resolve) => { resolveFirstStarted = resolve; });
  const oldAbortSeen = new Promise((resolve) => { resolveOldAbortSeen = resolve; });
  const oldAbortRelease = new Promise((resolve) => { releaseOldAbort = resolve; });
  const secondStarted = new Promise((resolve) => { resolveSecondStarted = resolve; });
  const secondRelease = new Promise((resolve) => { releaseSecond = resolve; });
  let proposalCalls = 0;
  const racingAdapter = {
    id: 'runtime-race-a',
    displayName: 'runtime-race-a',
    async chat(messages, opts = {}) {
      const prompt = messages[messages.length - 1]?.content || '';
      if (prompt.includes('评审输出')) return { reply: ack, tokensIn: 1, tokensOut: 1 };
      proposalCalls += 1;
      if (proposalCalls === 1) {
        resolveFirstStarted();
        return new Promise((_resolve, reject) => {
          opts.abortSignal?.addEventListener?.('abort', () => {
            resolveOldAbortSeen();
            oldAbortRelease.then(() => reject(new Error('old run aborted')));
          }, { once: true });
        });
      }
      resolveSecondStarted();
      await secondRelease;
      if (opts.abortSignal?.aborted) throw new Error('second run aborted');
      return { reply: '# resumed proposal\n新 run 继续完成任务。', tokensIn: 1, tokensOut: 1 };
    },
  };
  const stableAdapter = makeAdapter('runtime-race-b');
  store._rooms.set('runtime-abort-resume-race', makeRoom('runtime-abort-resume-race', [
    racingAdapter.id,
    stableAdapter.id,
  ]));
  const dispatcher = new CrossVerifyDispatcher({
    store,
    adapters: new Map([[racingAdapter.id, racingAdapter], [stableAdapter.id, stableAdapter]]),
    broadcast: (roomId, msg) => broadcasts.push({ roomId, ...msg }),
  });

  const firstRun = dispatcher.start('runtime-abort-resume-race', '真实链路快速中断后续跑').catch((error) => error);
  await firstStarted;
  const abortResult = dispatcher.abort('runtime-abort-resume-race');
  await oldAbortSeen;
  const resumeRun = dispatcher.resume('runtime-abort-resume-race');
  await secondStarted;
  const statusAfterResumeStarted = store.get('runtime-abort-resume-race')?.status;
  const activeAbortAfterResumeStarted = dispatcher.activeAborts.has('runtime-abort-resume-race');
  releaseOldAbort();
  const oldRunResult = await firstRun;
  const statusAfterOldRunFinally = store.get('runtime-abort-resume-race')?.status;
  const activeAbortAfterOldRunFinally = dispatcher.activeAborts.has('runtime-abort-resume-race');
  releaseSecond();
  await resumeRun;

  const room = store.get('runtime-abort-resume-race');
  const failures = [];
  requireRoomDone(failures, room, 'runtime-abort-resume-race');
  if (abortResult !== true) failures.push(`abortResult=${abortResult}, expected=true`);
  if (oldRunResult !== undefined) failures.push(`oldRunResult=${oldRunResult?.message || oldRunResult}, expected=undefined`);
  if (statusAfterResumeStarted !== 'running') failures.push(`statusAfterResumeStarted=${statusAfterResumeStarted}, expected=running`);
  if (!activeAbortAfterResumeStarted) failures.push('activeAbort missing after resume started');
  if (statusAfterOldRunFinally !== 'running') failures.push(`statusAfterOldRunFinally=${statusAfterOldRunFinally}, expected=running`);
  if (!activeAbortAfterOldRunFinally) failures.push('activeAbort missing after old run finally');
  if (dispatcher.activeAborts.size !== 0) failures.push(`activeAborts.size=${dispatcher.activeAborts.size}, expected=0`);
  return {
    failures,
    evidence: {
      status: room?.status,
      abortResult,
      oldRunResult: oldRunResult === undefined ? 'resolved' : 'unexpected',
      statusAfterResumeStarted,
      activeAbortAfterResumeStarted,
      statusAfterOldRunFinally,
      activeAbortAfterOldRunFinally,
      activeAbortCount: dispatcher.activeAborts.size,
      doneBroadcasts: broadcasts.filter((msg) => msg.type === 'cross_verify_done').length,
    },
  };
}

export const DEFAULT_CLUSTER_RUNTIME_DRILL_CASES = [
  { id: 'concurrent_rooms_complete_on_real_dispatcher_path', run: runConcurrentRoomsCase },
  { id: 'quota_drop_continues_on_real_dispatcher_path', run: runQuotaFailoverCase },
  { id: 'timeout_solo_takeover_completes_on_real_dispatcher_path', run: runTimeoutSoloTakeoverCase },
  { id: 'abort_resume_race_keeps_new_run_active_abort', run: runAbortResumeRaceCase },
];

async function evaluateCase(testCase) {
  try {
    const result = await testCase.run();
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
  }
}

export async function buildClusterRuntimeDrillReport({
  cases = DEFAULT_CLUSTER_RUNTIME_DRILL_CASES,
  now = new Date(),
} = {}) {
  const results = [];
  for (const testCase of cases) results.push(await evaluateCase(testCase));
  const generatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  return {
    drillVersion: 'cluster-runtime-drill-v1',
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

export function writeClusterRuntimeDrillReport(report, {
  latestPath,
  historyPath,
  maxHistoryLines = 200,
} = {}) {
  if (!latestPath || !historyPath) {
    return { written: false, error: 'cluster_runtime_drill_report_path_missing' };
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
