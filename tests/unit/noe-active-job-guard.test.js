import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createActiveJobGuard,
  getGlobalActiveJobStore,
  withActiveGuard,
} from '../../src/runtime/NoeActiveJobGuard.js';

// 注入独立 Map 的守卫，保证测试确定性、不污染进程级全局单例。
function makeGuard() {
  return createActiveJobGuard({ store: new Map() });
}

// 受控 promise：可手动 resolve，用于模拟「任务正在跑」的时间窗。
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createActiveJobGuard.run', () => {
  it('正常执行 fn 并回传结果，结束后释放', async () => {
    const guard = makeGuard();
    const r = await guard.run('job', () => 'done');
    expect(r).toMatchObject({ key: 'job', started: true, skipped: false, guarded: true, result: 'done' });
    expect(guard.size()).toBe(0); // finally 已释放
    expect(guard.isActive('job')).toBe(false);
  });

  it('同 key 在跑时第二次被跳过，不执行 fn（核心去重）', async () => {
    const guard = makeGuard();
    const d = deferred();
    const inner = vi.fn(() => d.promise);
    const p1 = guard.run('evolve', inner); // 占住 'evolve'
    expect(guard.isActive('evolve')).toBe(true);

    const second = vi.fn(() => 'second');
    const r2 = await guard.run('evolve', second);
    expect(r2).toMatchObject({ key: 'evolve', started: false, skipped: true, reason: 'already-active' });
    expect(second).not.toHaveBeenCalled(); // 第二个 fn 根本没跑

    d.resolve('first');
    const r1 = await p1;
    expect(r1.result).toBe('first');
    expect(inner).toHaveBeenCalledTimes(1);
    expect(guard.size()).toBe(0);
  });

  it('不同 key 互不阻塞', async () => {
    const guard = makeGuard();
    const a = guard.run('a', () => new Promise(() => {})); // 永不结束，占住 a
    const r = await guard.run('b', () => 'b-done');
    expect(r.skipped).toBe(false);
    expect(r.result).toBe('b-done');
    expect(guard.isActive('a')).toBe(true);
    void a;
  });

  it('fn 抛错也在 finally 释放，之后同 key 可再跑', async () => {
    const guard = makeGuard();
    await expect(guard.run('job', () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(guard.size()).toBe(0); // 抛错路径也释放
    const r = await guard.run('job', () => 'ok-again');
    expect(r.result).toBe('ok-again');
  });

  it('空 / 非字符串 key 放行执行但不计入活跃集合（guarded:false）', async () => {
    const guard = makeGuard();
    const r1 = await guard.run('', () => 1);
    expect(r1).toMatchObject({ key: '', started: true, skipped: false, guarded: false, result: 1 });
    const r2 = await guard.run('   ', () => 2);
    expect(r2.guarded).toBe(false);
    const r3 = await guard.run(null, () => 3);
    expect(r3.guarded).toBe(false);
    expect(guard.size()).toBe(0);
  });

  it('key 首尾空白被 trim 后视为同一 key', async () => {
    const guard = makeGuard();
    const p = guard.run('  consensus  ', () => new Promise(() => {}));
    const r = await guard.run('consensus', () => 'x');
    expect(r.skipped).toBe(true); // 'consensus' 已被 '  consensus  ' 占住
    void p;
  });

  it('throwOnConflict 冲突时抛错而非跳过', async () => {
    const guard = makeGuard();
    const p = guard.run('job', () => new Promise(() => {}));
    await expect(guard.run('job', () => 'x', { throwOnConflict: true }))
      .rejects.toThrow('active job already running: job');
    void p;
  });

  it('throwOnConflict 与 onSkip 同时传：onSkip 也会被调用（抛错前先通知）', async () => {
    const guard = makeGuard();
    const p = guard.run('job', () => new Promise(() => {}));
    const onSkip = vi.fn();
    await expect(guard.run('job', () => 'x', { throwOnConflict: true, onSkip }))
      .rejects.toThrow('active job already running: job');
    expect(onSkip).toHaveBeenCalledWith('job'); // 冲突通知不被 throw 吞掉
    void p;
  });

  it('onSkip 回调在跳过时被调用，且回调抛错不破坏守卫', async () => {
    const guard = makeGuard();
    const p = guard.run('job', () => new Promise(() => {}));
    const onSkip = vi.fn(() => { throw new Error('回调内异常'); });
    const r = await guard.run('job', () => 'x', { onSkip });
    expect(onSkip).toHaveBeenCalledWith('job');
    expect(r.skipped).toBe(true); // 回调抛错被吞，守卫语义不变
    void p;
  });

  it('fn 不是函数时抛 TypeError', async () => {
    const guard = makeGuard();
    await expect(guard.run('job', null)).rejects.toThrow(TypeError);
  });
});

describe('createActiveJobGuard 诊断 / 兜底接口', () => {
  it('activeKeys / size 反映当前在跑集合', async () => {
    const guard = makeGuard();
    guard.run('x', () => new Promise(() => {}));
    guard.run('y', () => new Promise(() => {}));
    expect(guard.size()).toBe(2);
    expect(guard.activeKeys().sort()).toEqual(['x', 'y']);
  });

  it('release 强制释放卡死的 key', async () => {
    const guard = makeGuard();
    guard.run('stuck', () => new Promise(() => {}));
    expect(guard.isActive('stuck')).toBe(true);
    expect(guard.release('stuck')).toBe(true);
    expect(guard.isActive('stuck')).toBe(false);
    expect(guard.release('stuck')).toBe(false); // 已不在
    expect(guard.release('')).toBe(false);
  });

  it('reset 清空守卫集合', async () => {
    const guard = makeGuard();
    guard.run('a', () => new Promise(() => {}));
    guard.run('b', () => new Promise(() => {}));
    guard.reset();
    expect(guard.size()).toBe(0);
  });
});

describe('token 释放正确性（防误删他人重新 acquire 的标记）', () => {
  it('release 后第二路重新 acquire，第一路 finally 不误删新持有者标记', async () => {
    const guard = makeGuard();
    const a = deferred();
    const pA = guard.run('job', () => a.promise); // A 占住
    guard.release('job'); // 外部强制释放 A 的标记
    const b = deferred();
    const pB = guard.run('job', () => b.promise); // B 重新 acquire 成功
    expect(guard.isActive('job')).toBe(true); // B 持有

    a.resolve('A done'); // A 的 fn 现在才结束 → A 的 finally 触发
    await pA;
    // 关键断言：A 的 finally 不能把 B 的标记删掉
    expect(guard.isActive('job')).toBe(true);
    // 第三路 C 仍被正确拦截（守卫未失效）
    const rC = await guard.run('job', () => 'C');
    expect(rC.skipped).toBe(true);

    b.resolve('B done');
    await pB;
    expect(guard.isActive('job')).toBe(false); // B 自己结束才真正释放
  });

  it('reset 后第二路 acquire，旧一路 finally 不误删', async () => {
    const guard = makeGuard();
    const a = deferred();
    const pA = guard.run('job', () => a.promise);
    guard.reset();
    const pB = guard.run('job', () => new Promise(() => {})); // B 重新占住
    a.resolve();
    await pA;
    expect(guard.isActive('job')).toBe(true); // B 的标记仍在
    void pB;
  });
});

describe('全局单例语义', () => {
  afterEach(() => {
    // 清理进程级全局集合，避免跨测试泄漏。
    getGlobalActiveJobStore().clear();
  });

  it('未注入 store 的两个守卫共享同一进程级集合（Symbol.for 单例）', async () => {
    const g1 = createActiveJobGuard();
    const g2 = createActiveJobGuard();
    g1.run('shared', () => new Promise(() => {}));
    // g2 看得到 g1 标记的活跃任务
    expect(g2.isActive('shared')).toBe(true);
    const r = await g2.run('shared', () => 'should-skip');
    expect(r.skipped).toBe(true);
  });

  it('withActiveGuard 便捷入口走同一全局集合', async () => {
    const p = withActiveGuard('global-job', () => new Promise(() => {}));
    expect(getGlobalActiveJobStore().has('global-job')).toBe(true);
    const r = await withActiveGuard('global-job', () => 'x');
    expect(r.skipped).toBe(true);
    void p;
  });
});
