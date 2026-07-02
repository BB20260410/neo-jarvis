import { describe, it, expect, beforeEach } from 'vitest';
import { DebateDispatcher } from '../../../src/room/DebateDispatcher.js';
import { SoloChatDispatcher } from '../../../src/room/SoloChatDispatcher.js';
import { ArenaDispatcher } from '../../../src/room/ArenaDispatcher.js';
import { CollaborationDispatcher } from '../../../src/room/CollaborationDispatcher.js';

// 极简 stub
const stubAdapter = {
  id: 'stub',
  displayName: '🧪 Stub',
  async chat() { return { reply: 'stub-reply', tokensIn: 1, tokensOut: 1 }; },
};
const stubAdapters = new Map([['stub', stubAdapter]]);
const stubStore = {
  _rooms: new Map(),
  get(id) { return this._rooms.get(id); },
  update(id, patch) {
    const r = this._rooms.get(id);
    if (r) Object.assign(r, patch);
    return r;
  },
  save() {},
};
const stubMetrics = {
  recordTurn() {},
};
const broadcasts = [];
const stubBroadcast = (id, msg) => broadcasts.push({ id, msg });

beforeEach(() => {
  stubStore._rooms.clear();
  broadcasts.length = 0;
});

describe('4 dispatcher 实例化', () => {
  it('DebateDispatcher 可 new + 含 start/abort', () => {
    const d = new DebateDispatcher({ store: stubStore, adapters: stubAdapters, broadcast: stubBroadcast, metrics: stubMetrics });
    expect(typeof d.start).toBe('function');
    expect(typeof d.abort).toBe('function');
  });
  it('SoloChatDispatcher 可 new + 含 sendMessage', () => {
    const d = new SoloChatDispatcher({ store: stubStore, adapters: stubAdapters, broadcast: stubBroadcast, metrics: stubMetrics });
    expect(typeof d.sendMessage).toBe('function');
    expect(typeof d.abort).toBe('function');
  });
  it('ArenaDispatcher 可 new', () => {
    const d = new ArenaDispatcher({ store: stubStore, adapters: stubAdapters, broadcast: stubBroadcast, metrics: stubMetrics });
    expect(typeof d.start).toBe('function');
  });
  it('CollaborationDispatcher 可 new', () => {
    const d = new CollaborationDispatcher({ store: stubStore, adapters: stubAdapters, broadcast: stubBroadcast, metrics: stubMetrics });
    expect(typeof d.start).toBe('function');
  });
});

describe('dispatcher 错误处理（无 room）', () => {
  const d = new DebateDispatcher({ store: stubStore, adapters: stubAdapters, broadcast: stubBroadcast, metrics: stubMetrics });
  it('start 不存在 room → 抛错', async () => {
    await expect(d.start('nonexistent', 'topic')).rejects.toThrow();
  });
  it('abort 不存在 room → 不抛（noop）', () => {
    expect(() => d.abort('nonexistent')).not.toThrow();
  });
});

describe('dispatcher resume 错误', () => {
  const d = new DebateDispatcher({ store: stubStore, adapters: stubAdapters, broadcast: stubBroadcast, metrics: stubMetrics });
  it('resume 不存在 room', async () => {
    await expect(d.resume('nonexistent')).rejects.toThrow('room not found');
  });
  it('resume 已 running room', async () => {
    stubStore._rooms.set('r1', { id: 'r1', status: 'running', topic: 'x' });
    await expect(d.resume('r1')).rejects.toThrow('already running');
  });
  it('resume 无 topic room', async () => {
    stubStore._rooms.set('r2', { id: 'r2', status: 'idle', topic: '' });
    await expect(d.resume('r2')).rejects.toThrow('尚未启动过');
  });
});

describe('dispatcher agent telemetry', () => {
  it('SoloChatDispatcher writes agent profile/tag/skill metadata into metrics', async () => {
    const recorded = [];
    const metrics = { record(payload) { recorded.push(payload); } };
    stubStore._rooms.set('chat-1', {
      id: 'chat-1',
      mode: 'chat',
      name: 'Agent telemetry',
      cwd: '/tmp/noe',
      members: [{ adapterId: 'stub', displayName: 'Stub QA', role: 'qa', enabled: true }],
      conversation: [],
    });
    const d = new SoloChatDispatcher({ store: stubStore, adapters: stubAdapters, broadcast: stubBroadcast, metrics });

    await d.sendMessage('chat-1', '请测试审批和预算治理');

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      roomMode: 'chat',
      adapter: 'stub',
      agentProfileId: 'xike-verifier',
    });
    expect(recorded[0].agentDispatchTags).toEqual(expect.arrayContaining(['verification', 'governance']));
    expect(recorded[0].agentGovernance).toMatchObject({ commandGuard: 'strict' });
  });
});

describe('CollaborationDispatcher squadFinishHook（选项 C）', () => {
  it('done/paused/error 三相均触发 hook,room 数据可传递', () => {
    const d = new CollaborationDispatcher({ store: stubStore, adapters: stubAdapters, broadcast: stubBroadcast, metrics: stubMetrics });
    const calls = [];
    d.setSquadFinishHook((roomId, room, phase) => calls.push({ roomId, phase, taskN: (room.taskList || []).length, hasFinal: !!room.finalConsensus }));
    const room = { id: 'sq1', mode: 'squad', taskList: [{ id: 't1', status: 'done', attempts: [{ by: 'dev', content: '一版方案' }], reviews: [{ pass: true }] }], finalConsensus: '最终交付物 X' };
    stubStore._rooms.set('sq1', room);
    d._fireSquadFinishHook('sq1', 'done');
    d._fireSquadFinishHook('sq1', 'paused');
    d._fireSquadFinishHook('sq1', 'error');
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.phase)).toEqual(['done', 'paused', 'error']);
    expect(calls[0]).toMatchObject({ roomId: 'sq1', taskN: 1, hasFinal: true });
  });

  it('hook 抛错不阻断(吞咽 + 调用方 squad 继续)', () => {
    const d = new CollaborationDispatcher({ store: stubStore, adapters: stubAdapters, broadcast: stubBroadcast, metrics: stubMetrics });
    d.setSquadFinishHook(() => { throw new Error('hook boom'); });
    stubStore._rooms.set('sq2', { id: 'sq2', mode: 'squad', taskList: [] });
    expect(() => d._fireSquadFinishHook('sq2', 'done')).not.toThrow();
  });

  it('未注入 hook / room 不存在 → 静默 no-op', () => {
    const d = new CollaborationDispatcher({ store: stubStore, adapters: stubAdapters, broadcast: stubBroadcast, metrics: stubMetrics });
    expect(() => d._fireSquadFinishHook('nonexistent', 'done')).not.toThrow(); // 未注入
    const calls = [];
    d.setSquadFinishHook((id, _r, p) => calls.push([id, p]));
    expect(() => d._fireSquadFinishHook('not-in-store', 'done')).not.toThrow(); // room 不存在
    expect(calls).toHaveLength(0);
    d.setSquadFinishHook(null); // 清除
    stubStore._rooms.set('sq3', { id: 'sq3', mode: 'squad' });
    d._fireSquadFinishHook('sq3', 'done');
    expect(calls).toHaveLength(0);
  });
});

describe('CollaborationDispatcher _persistTaskList(SIGKILL-safe 持久化)', () => {
  it('调用 store.update + flush(SIGKILL-safe 跳过 debounce),传递 in-memory taskList 引用', () => {
    const updates = [];
    let flushCalls = 0;
    const localStore = {
      _rooms: new Map(),
      get(id) { return this._rooms.get(id); },
      update(id, patch) {
        updates.push({ id, patch });
        const r = this._rooms.get(id);
        if (r) Object.assign(r, patch);
      },
      flush() { flushCalls++; }, // 立即写盘(bypass debounce)
    };
    const d = new CollaborationDispatcher({ store: localStore, adapters: stubAdapters, broadcast: stubBroadcast, metrics: stubMetrics });
    const taskList = [{ id: 't1', status: 'in_review', attempts: [{ by: 'codex' }], reviews: [] }];
    localStore._rooms.set('sq-persist', { id: 'sq-persist', mode: 'squad', taskList });
    d._persistTaskList('sq-persist');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ id: 'sq-persist' });
    expect(updates[0].patch.taskList).toBe(taskList); // 同一引用
    expect(flushCalls).toBe(1); // flush 真被调,SIGKILL-safe
  });

  it('store 无 flush 方法 → 仅 update,no-throw 兼容老 store/mock', () => {
    const localStore = {
      _rooms: new Map([['sq-noflush', { id: 'sq-noflush', taskList: [] }]]),
      get(id) { return this._rooms.get(id); },
      update() {},
      // 无 flush 方法
    };
    const d = new CollaborationDispatcher({ store: localStore, adapters: stubAdapters, broadcast: stubBroadcast, metrics: stubMetrics });
    expect(() => d._persistTaskList('sq-noflush')).not.toThrow();
  });

  it('room 不存在 → no-op,不抛', () => {
    const d = new CollaborationDispatcher({ store: stubStore, adapters: stubAdapters, broadcast: stubBroadcast, metrics: stubMetrics });
    expect(() => d._persistTaskList('nonexistent')).not.toThrow();
  });

  it('store.update 抛错 → 仅警告,不向上抛', () => {
    const localStore = {
      get() { return { id: 'sq-x', taskList: [] }; },
      update() { throw new Error('disk full'); },
    };
    const d = new CollaborationDispatcher({ store: localStore, adapters: stubAdapters, broadcast: stubBroadcast, metrics: stubMetrics });
    expect(() => d._persistTaskList('sq-x')).not.toThrow();
  });

  it('Dev 失败时:attempts.push + status=escalated + _persistTaskList 都被调(SIGKILL-safe 集成)', async () => {
    const updates = [];
    const failingAdapter = {
      id: 'failing-dev', displayName: 'X',
      async chat() { throw new Error('codex spawn crashed'); },
    };
    const passAdapter = {
      id: 'pass-qa', displayName: 'Y',
      async chat() { return { reply: 'never called', tokensIn: 0, tokensOut: 0 }; },
    };
    const localStore = {
      _rooms: new Map(),
      get(id) { return this._rooms.get(id); },
      update(id, patch) {
        updates.push({ id, patch: { ...patch, _tasksSnapshot: (patch.taskList || []).map(t => ({ id: t.id, status: t.status, attempts: t.attempts?.length || 0 })) } });
        const r = this._rooms.get(id);
        if (r) Object.assign(r, patch);
      },
    };
    const room = {
      id: 'sq-int', mode: 'squad', cwd: '/tmp',
      members: [
        { adapterId: 'failing-dev', role: 'dev', enabled: true },
        { adapterId: 'pass-qa', role: 'qa', enabled: true },
      ],
      taskList: [],
    };
    localStore._rooms.set('sq-int', room);
    const adapters = new Map([['failing-dev', failingAdapter], ['pass-qa', passAdapter]]);
    const d = new CollaborationDispatcher({ store: localStore, adapters, broadcast: () => {}, metrics: stubMetrics });
    const task = {
      id: 't-dev-fail', title: 'Mock', desc: 'mock',
      assigneeId: 'failing-dev', reviewerId: 'pass-qa',
      attempts: [], reviews: [],
      status: 'pending', iterations: 0, maxIterations: 3,
    };
    room.taskList.push(task); // _persistTaskList 读 room.taskList,得有 task 才能验证 snapshot
    const aborter = new AbortController();
    await d._runOneTaskUntilTerminal('sq-int', task, 'topic', room.members, aborter.signal);

    // 验证:Dev 失败 → attempts 有 1 条 error,task.status=escalated,_persistTaskList 至少被调一次
    expect(task.status).toBe('escalated');
    expect(task.attempts).toHaveLength(1);
    expect(task.attempts[0].error).toBe(true);
    expect(task.attempts[0].content).toContain('dev 失败');
    // SIGKILL-safe:store.update 调到了,且最新一次状态是 escalated + attempts=1
    expect(updates.length).toBeGreaterThanOrEqual(1);
    const lastUpdate = updates[updates.length - 1];
    const snap = lastUpdate.patch._tasksSnapshot[0];
    expect(snap).toMatchObject({ status: 'escalated', attempts: 1 });
  });
});

describe('learned helper 直接调用', () => {
  it('historyTrimmer 跑通', async () => {
    const { trimHistoryByTokens } = await import('../../../src/room/historyTrimmer.js');
    const r = trimHistoryByTokens({ messages: [{ role: 'user', content: 'q' }], maxContextTokens: 10000 });
    expect(r.context.length).toBe(1);
  });
  it('consensus 跑通', async () => {
    const { detectConsensus } = await import('../../../src/room/learned/consensus-detector.js');
    const r = detectConsensus([{ speaker: 'A', content: '我同意' }, { speaker: 'B', content: '达成共识' }]);
    expect(r.consensus).toBe(true);
  });
});
