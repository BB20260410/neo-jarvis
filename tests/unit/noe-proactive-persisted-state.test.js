import { describe, it, expect } from 'vitest';
import { createProactiveTickHandler } from '../../src/loop/proactiveTick.js';

// 主动陪伴持久状态（意识方案 §3.4）：冷却/见过谁/上次画面跨"重启"（重建 handler）不归零。
const mkAdapter = (reply) => ({ chat: async () => ({ reply }) });

function makeStateStore(initial = null) {
  let state = initial;
  return {
    saved: () => state,
    get: () => state,
    set: (s) => { state = s; },
  };
}

describe('proactiveTick 持久状态（stateStore 注入）', () => {
  it('开口后 lastSpokeAt 落入 stateStore；重建 handler 后冷却仍然生效（跨重启不归零）', async () => {
    let clock = 100_000_000;
    const now = () => clock;
    const store = makeStateStore();
    const deps = {
      visionSession: { latest: () => ({ summary: '主人在写代码' }) },
      getAdapter: () => mkAdapter('加油哦'),
      cooldownMs: 1_000_000,
      stateStore: store,
      now,
    };
    const tick1 = createProactiveTickHandler(deps);
    expect((await tick1()).spoke).toBe(true);
    expect(store.saved().lastSpokeAt).toBe(clock);

    // "重启"：用同一 stateStore 重建 handler（模拟进程重启后 kv 水合）
    clock += 100; // 仍在冷却期内
    const tick2 = createProactiveTickHandler({ ...deps, visionSession: { latest: () => ({ summary: '主人切到了浏览器' }) } });
    const r = await tick2();
    expect(r.spoke).toBe(false);
    expect(r.reason).toBe('cooldown'); // 原版重启后冷却归零会立刻再开口；持久化后不会
  });

  it('lastVisionSummary 持久化：重启后同画面命中 no_change 不重复分析', async () => {
    let clock = 100_000_000;
    const now = () => clock;
    const store = makeStateStore();
    const deps = {
      visionSession: { latest: () => ({ summary: '主人在看文档' }) },
      getAdapter: () => mkAdapter('SILENT'),
      cooldownMs: 0,
      stateStore: store,
      now,
    };
    const tick1 = createProactiveTickHandler(deps);
    await tick1(); // 记下 lastVisionSummary
    expect(store.saved().lastVisionSummary).toBe('主人在看文档');

    clock += 10_000;
    const tick2 = createProactiveTickHandler(deps); // 重启水合
    const r = await tick2();
    expect(r.reason).toBe('no_change');
  });

  it('认人 reportedAt 持久化：重启后同一个人 personCooldown 内不再重复招呼', async () => {
    let clock = 100_000_000;
    const now = () => clock;
    const store = makeStateStore();
    const visionSession = {
      faceRecog: 'auto',
      latest: () => ({ summary: '客厅画面' }),
      recognizeWho: async () => ({ faces: [{ recognized: true, person: { id: 'p1', displayName: '小明' } }] }),
    };
    const deps = {
      visionSession,
      getAdapter: () => mkAdapter('小明来啦'),
      cooldownMs: 0,
      personCooldownMs: 1_000_000,
      stateStore: store,
      now,
    };
    const tick1 = createProactiveTickHandler(deps);
    const r1 = await tick1();
    expect(r1.spoke).toBe(true);
    expect(r1.recognized.length).toBe(1);
    expect(store.saved().reportedAt.p1).toBe(clock);

    clock += 30_000; // personCooldown 内 + 过了 recogInterval
    const tick2 = createProactiveTickHandler({ ...deps, getAdapter: () => mkAdapter('SILENT') });
    const r2 = await tick2();
    expect(r2.recognized?.length || 0).toBe(0); // 水合后没把 p1 当"新出现的熟人"
  });

  it('不注入 stateStore：行为与原版一致（纯内存）', async () => {
    let clock = 100_000_000;
    const tick = createProactiveTickHandler({
      visionSession: { latest: () => ({ summary: 'A' }) },
      getAdapter: () => mkAdapter('SILENT'),
      cooldownMs: 0,
      now: () => clock,
    });
    const r = await tick();
    expect(r.spoke).toBe(false);
  });

  it('stateStore 读写抛错不影响主动陪伴（fail-open）', async () => {
    let clock = 100_000_000;
    const tick = createProactiveTickHandler({
      visionSession: { latest: () => ({ summary: '主人在听歌' }) },
      getAdapter: () => mkAdapter('好听吗'),
      cooldownMs: 0,
      stateStore: { get: () => { throw new Error('读炸'); }, set: () => { throw new Error('写炸'); } },
      now: () => clock,
    });
    const r = await tick();
    expect(r.spoke).toBe(true);
  });
});
