import { describe, it, expect } from 'vitest';
import { createHeartbeat } from '../../src/loop/NoeHeartbeat.js';
import { createActiveJobGuard } from '../../src/runtime/NoeActiveJobGuard.js';

// 内存版 store：忠实模拟 NoeHeartbeatStore 的语义（游标/台账/恢复），单测快/纯/可控。
function makeStore() {
  const cursors = new Map();
  const ticks = [];
  let id = 0;
  return {
    cursors,
    ticks,
    ensureCursor(kind, cadenceMs, now) {
      if (!cursors.has(kind)) cursors.set(kind, { kind, next_due: now + cadenceMs, cadence_ms: cadenceMs });
      else if (cursors.get(kind).cadence_ms !== cadenceMs) {
        const c = cursors.get(kind);
        c.next_due = Math.min(c.next_due, now + cadenceMs);
        c.cadence_ms = cadenceMs;
      }
      return cursors.get(kind);
    },
    cursor(kind) { return cursors.get(kind) || null; },
    allCursors() { return [...cursors.values()]; },
    dueCursors(now) { return [...cursors.values()].filter((c) => c.next_due <= now); },
    advanceCursor(kind, nextDue) { const c = cursors.get(kind); if (c) c.next_due = nextDue; },
    beginTick(kind, now, lease, intent) { ticks.push({ id: ++id, kind, status: 'running', intent }); return id; },
    finishTick(tid, outcome) { const t = ticks.find((x) => x.id === tid); if (t) { t.status = 'done'; t.outcome = outcome; } },
    failTick(tid, error) { const t = ticks.find((x) => x.id === tid); if (t) { t.status = 'failed'; t.error = error; } },
    interruptTick(tid, reason) {
      const t = ticks.find((x) => x.id === tid && x.status === 'running');
      if (!t) return 0;
      t.status = 'interrupted';
      t.error = reason;
      return 1;
    },
    markCoalesced(kind, missed) { ticks.push({ id: ++id, kind, status: 'coalesced', missed }); },
    recoverDeadTicks() { return 0; },
    bootLagMs(now) {
      const lags = [...cursors.values()].map((c) => now - c.next_due).filter((x) => x > 0);
      return lags.length ? Math.max(...lags) : 0;
    },
  };
}

const noopTimer = { setTimer: () => ({ unref() {} }), clearTimer: () => {} };

describe('NoeHeartbeat 持久心跳调度器', () => {
  it('start 播种游标：首跑在 now+cadence，不在启动瞬间扎堆', async () => {
    let t = 1_000_000;
    const store = makeStore();
    const ran = [];
    const hb = createHeartbeat({ store, now: () => t, ...noopTimer });
    hb.register('meso', { cadenceMs: 1000, run: () => ran.push(t) });
    hb.start();
    expect(store.cursor('meso').next_due).toBe(1_001_000);
    await hb.pumpOnce();
    expect(ran.length).toBe(0); // 未到期不跑
    t = 1_001_000;
    await hb.pumpOnce();
    expect(ran.length).toBe(1); // 到期跑一次
    expect(store.cursor('meso').next_due).toBe(t + 1000); // 从现在起推进下一拍
    hb.stop();
  });

  it('catchUp=once（默认）：错过 5 个周期只补跑 1 次', async () => {
    let t = 1_000_000;
    const store = makeStore();
    const ran = [];
    const hb = createHeartbeat({ store, now: () => t, ...noopTimer });
    hb.register('meso', { cadenceMs: 1000, run: () => ran.push(1) });
    hb.start();
    t += 6_000; // 错过 5 个周期
    await hb.pumpOnce();
    expect(ran.length).toBe(1);
    hb.stop();
  });

  it('catchUp=all + maxCatchUp=2：补跑到上限', async () => {
    let t = 1_000_000;
    const store = makeStore();
    const ran = [];
    const hb = createHeartbeat({ store, now: () => t, ...noopTimer });
    hb.register('macro', { cadenceMs: 1000, catchUp: 'all', maxCatchUp: 2, run: () => ran.push(1) });
    hb.start();
    t += 10_000;
    await hb.pumpOnce();
    expect(ran.length).toBe(2);
    hb.stop();
  });

  it('catchUp=drop：欠账只留 coalesced 痕迹，仍跑当下这 1 次', async () => {
    let t = 1_000_000;
    const store = makeStore();
    const ran = [];
    const hb = createHeartbeat({ store, now: () => t, ...noopTimer });
    hb.register('proactive', { cadenceMs: 1000, catchUp: 'drop', run: () => ran.push(1) });
    hb.start();
    t += 5_000;
    await hb.pumpOnce();
    expect(ran.length).toBe(1);
    const co = store.ticks.find((x) => x.status === 'coalesced');
    expect(co).toBeTruthy();
    expect(co.missed).toBe(4);
    hb.stop();
  });

  it('job 抛错 → 台账 failed，心跳不死，其它 kind 照跑', async () => {
    let t = 1_000_000;
    const store = makeStore();
    const ran = [];
    const hb = createHeartbeat({ store, now: () => t, ...noopTimer });
    hb.register('bad', { cadenceMs: 1000, run: () => { throw new Error('boom'); } });
    hb.register('good', { cadenceMs: 1000, run: () => ran.push(1) });
    hb.start();
    t += 1_000;
    await hb.pumpOnce();
    expect(ran.length).toBe(1);
    const bad = store.ticks.find((x) => x.kind === 'bad');
    expect(bad.status).toBe('failed');
    expect(bad.error).toContain('boom');
    const good = store.ticks.find((x) => x.kind === 'good');
    expect(good.status).toBe('done');
    hb.stop();
  });

  it('受控停机可把本进程正在跑的 tick 标记为 interrupted，且不被后续返回覆盖', async () => {
    let t = 1_000_000;
    const store = makeStore();
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const hb = createHeartbeat({ store, now: () => t, ...noopTimer });
    hb.register('proactive', { cadenceMs: 1000, run: () => pending });
    hb.start();
    t += 1000;
    const pump = hb.pumpOnce();
    await Promise.resolve();
    const tick = store.ticks.find((x) => x.kind === 'proactive');
    expect(tick.status).toBe('running');
    hb.stop({ interruptRunning: true, reason: 'shutdown:SIGTERM' });
    expect(tick.status).toBe('interrupted');
    expect(tick.error).toBe('shutdown:SIGTERM');
    release({ ok: true });
    await pump;
    expect(tick.status).toBe('interrupted');
  });

  it('onRecovery：启动检测到游标长滞后（上次停机）回调一次；短滞后不回调', () => {
    const store = makeStore();
    const t0 = 10_000_000;
    // 预置一个滞后 2 小时的游标（模拟停机前的库）
    store.cursors.set('meso', { kind: 'meso', next_due: t0 - 2 * 3600_000, cadence_ms: 1000 });
    const lags = [];
    const hb = createHeartbeat({ store, now: () => t0, ...noopTimer, recoveryThresholdMs: 10 * 60_000, onRecovery: (l) => lags.push(l) });
    hb.register('meso', { cadenceMs: 1000, run: () => {} });
    hb.start();
    expect(lags.length).toBe(1);
    expect(lags[0]).toBe(2 * 3600_000);
    hb.stop();

    // 短滞后（5 分钟）不算"断过"
    const store2 = makeStore();
    store2.cursors.set('meso', { kind: 'meso', next_due: t0 - 5 * 60_000, cadence_ms: 1000 });
    const lags2 = [];
    const hb2 = createHeartbeat({ store: store2, now: () => t0, ...noopTimer, recoveryThresholdMs: 10 * 60_000, onRecovery: (l) => lags2.push(l) });
    hb2.register('meso', { cadenceMs: 1000, run: () => {} });
    hb2.start();
    expect(lags2.length).toBe(0);
    hb2.stop();
  });

  it('库里有游标但本进程未注册该 kind（开关半开）：跳过不推进', async () => {
    let t = 1_000_000;
    const store = makeStore();
    store.cursors.set('ghost', { kind: 'ghost', next_due: t - 1000, cadence_ms: 1000 });
    const hb = createHeartbeat({ store, now: () => t, ...noopTimer });
    hb.start();
    await hb.pumpOnce();
    expect(store.cursor('ghost').next_due).toBe(t - 1000); // 原地不动
    expect(store.ticks.length).toBe(0);
    hb.stop();
  });

  it('串行：同一轮泵内多个到期 kind 按序 await（不并发）', async () => {
    let t = 1_000_000;
    const store = makeStore();
    const order = [];
    const hb = createHeartbeat({ store, now: () => t, ...noopTimer });
    hb.register('a', { cadenceMs: 1000, run: async () => { order.push('a-in'); await Promise.resolve(); order.push('a-out'); } });
    hb.register('b', { cadenceMs: 1000, run: () => { order.push('b'); } });
    hb.start();
    t += 1000;
    await hb.pumpOnce();
    expect(order).toEqual(['a-in', 'a-out', 'b']);
    hb.stop();
  });

  it('同类心跳作业运行中：手动踩同一 kind 只写跳过台账，不并发执行', async () => {
    let t = 1_000_000;
    const store = makeStore();
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const activeJobGuard = createActiveJobGuard({ store: new Map() });
    let calls = 0;
    const hb = createHeartbeat({ store, now: () => t, ...noopTimer, activeJobGuard });
    hb.register('innerReflect', {
      cadenceMs: 1000,
      run: async () => {
        calls += 1;
        return pending;
      },
    });

    hb.start();
    t += 1000;
    const scheduled = hb.pumpOnce();
    await Promise.resolve();

    expect(calls).toBe(1);
    expect(hb.status().activeJobKeys).toEqual(['heartbeat:innerReflect']);

    const manual = await hb.runNow('innerReflect');
    expect(manual).toMatchObject({ ok: true, skipped: true, reason: 'active_job_already_running' });
    expect(calls).toBe(1);

    const skipped = store.ticks.find((x) => x.kind === 'innerReflect' && x.outcome?.skipped);
    expect(skipped).toBeTruthy();
    expect(skipped.status).toBe('done');
    expect(skipped.outcome).toMatchObject({
      skipped: true,
      reason: 'active_job_already_running',
      activeJobKey: 'heartbeat:innerReflect',
    });

    release({ ok: true });
    await scheduled;
    expect(calls).toBe(1);
    expect(hb.status().activeJobKeys).toEqual([]);
    hb.stop();
  });

  it('maintenance kind 可独立运行，不依赖 innerReflect 注册', async () => {
    let t = 1_000_000;
    const store = makeStore();
    const ran = [];
    const hb = createHeartbeat({ store, now: () => t, ...noopTimer });
    hb.register('maintenance', { cadenceMs: 1000, catchUp: 'drop', run: () => { ran.push('maintenance'); return { nightlyReflection: true }; } });
    hb.start();
    expect(hb.status().kinds).toEqual(['maintenance']);
    expect(hb.status().kinds).not.toContain('innerReflect');
    t += 1000;
    await hb.pumpOnce();
    expect(ran).toEqual(['maintenance']);
    const tick = store.ticks.find((x) => x.kind === 'maintenance');
    expect(tick.status).toBe('done');
    expect(tick.outcome).toEqual({ nightlyReflection: true });
    hb.stop();
  });

  it('detached job 可在快速返回后回填同一条 tick outcome', async () => {
    let t = 1_000_000;
    const store = makeStore();
    let completeBackground;
    const hb = createHeartbeat({ store, now: () => t, ...noopTimer });
    hb.register('expectation', {
      cadenceMs: 1000,
      run: ({ updateOutcome }) => {
        completeBackground = () => updateOutcome({
          detached: true,
          reason: 'background_completed',
          previousResult: {
            ok: true,
            checked: 1,
            resolved: 0,
            judged: [{ id: 1, outcome: null, reason: 'llm_unknown' }],
          },
        });
        return { detached: true, reason: 'started_background' };
      },
    });
    hb.start();
    t += 1000;
    await hb.pumpOnce();

    const tick = store.ticks.find((x) => x.kind === 'expectation');
    expect(tick.status).toBe('done');
    expect(tick.outcome).toEqual({ detached: true, reason: 'started_background' });

    t += 250;
    expect(completeBackground()).toBe(true);
    expect(tick.status).toBe('done');
    expect(tick.outcome).toMatchObject({
      detached: true,
      reason: 'background_completed',
      previousResult: { ok: true, checked: 1, resolved: 0 },
    });
    hb.stop();
  });

  it('stop 后不再续排 timer；register 非法 job 抛错', () => {
    const store = makeStore();
    const hb = createHeartbeat({ store, now: () => 0, ...noopTimer });
    hb.register('meso', { cadenceMs: 1000, run: () => {} });
    expect(() => hb.register('bad', { cadenceMs: 0, run: () => {} })).toThrow();
    expect(() => hb.register('bad2', {})).toThrow();
    hb.start();
    hb.stop();
    expect(hb.status().running).toBe(false);
  });

  it('ensureCursor 同步 cadence 变化：变快收紧 next_due', () => {
    const store = makeStore();
    const t = 1_000_000;
    store.ensureCursor('meso', 10_000, t);
    expect(store.cursor('meso').next_due).toBe(t + 10_000);
    store.ensureCursor('meso', 2_000, t + 1000);
    expect(store.cursor('meso').next_due).toBe(t + 3_000); // min(原 next_due, now+新节奏)
    expect(store.cursor('meso').cadence_ms).toBe(2_000);
  });
});

describe('P7 心跳隔离（NOE_HEARTBEAT_ISOLATE / isolatePump）：单 job 挂起不饿死全泵', () => {
  it('隔离开启：永不 resolve 的 job 超过租约耐心后，泵继续跑其余 kind + onOverdue 告警', async () => {
    let t = 1_000_000;
    const store = makeStore();
    const ran = [];
    const overdue = [];
    const hb = createHeartbeat({
      store,
      now: () => t,
      ...noopTimer,
      isolatePump: true,
      leaseMs: 10, // 真实计时器 10ms 耐心（不杀 job，只停止等待）
      onOverdue: (kind) => overdue.push(kind),
    });
    hb.register('hang', { cadenceMs: 1000, run: () => new Promise(() => {}) }); // 永挂
    hb.register('alive', { cadenceMs: 1000, run: () => ran.push('alive') });
    hb.start();
    t = 1_001_000;
    await hb.pumpOnce(); // 串行顺序里 hang 在前也不能拖死 alive
    expect(ran).toContain('alive');
    expect(overdue).toContain('hang');
  });

  it('隔离关闭（默认）：行为保持串行 await（永挂 job 会阻塞后续——现状口径,用会 resolve 的 job 验证顺序不变）', async () => {
    let t = 1_000_000;
    const store = makeStore();
    const ran = [];
    const hb = createHeartbeat({ store, now: () => t, ...noopTimer });
    hb.register('a', { cadenceMs: 1000, run: async () => { ran.push('a'); } });
    hb.register('b', { cadenceMs: 1000, run: async () => { ran.push('b'); } });
    hb.start();
    t = 1_001_000;
    await hb.pumpOnce();
    expect(ran).toEqual(['a', 'b']);
  });

  it('隔离开启：挂起 kind 在后续泵轮被 active-guard 跳过（不重复触发），完成后台账仍能收口', async () => {
    let t = 1_000_000;
    const store = makeStore();
    let release;
    const hb = createHeartbeat({
      store,
      now: () => t,
      ...noopTimer,
      isolatePump: true,
      leaseMs: 10,
    });
    hb.register('slow', { cadenceMs: 1000, run: () => new Promise((res) => { release = res; }) });
    hb.start();
    t = 1_001_000;
    await hb.pumpOnce(); // slow 超耐心，泵放行
    t = 1_002_000;
    await hb.pumpOnce(); // 第二轮：slow 仍在跑 → active-guard 跳过
    const running = store.ticks.filter((x) => x.kind === 'slow' && x.status === 'running');
    expect(running.length).toBe(1); // 只有第一轮的 tick 真在跑
    release('done');
    await new Promise((r) => setTimeout(r, 5));
    expect(store.ticks.find((x) => x.kind === 'slow' && x.status === 'done')).toBeTruthy(); // 完成后仍收口
  });
});
