import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrefetchStore } from '../../src/prefetch/NoePrefetchStore.js';
import { createSleepTimeCompute } from '../../src/cognition/NoeSleepTimeCompute.js';

const T0 = 1_780_000_000_000;

// 推进式注入时钟（确定性，不依赖真实时间/真实时钟）
function makeClock(start = T0) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; return t; };
  return now;
}
// 假 open 预测：模拟 NoeOwnerBehaviorPredictor.openOwnerPredictions() 的输出形状
function topicPred(topic, p = 0.55) { return { claim: `owner 接下来还会再提到/谈论「${topic}」[owner-pred:topic:${topic}]`, p }; }
const followupPred = { claim: 'owner 交办后…[owner-pred:followup]', p: 0.7 };

let store;
let now;
beforeEach(() => { store = createPrefetchStore(); now = makeClock(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('createSleepTimeCompute — idle 触发预计算', () => {
  it('空闲时为「owner 下一问」主题预算候选，写入预取池（带 source + TTL）', async () => {
    const precompute = vi.fn(async (q) => `检索到关于 ${q} 的 3 条记忆`);
    const sc = createSleepTimeCompute({
      prefetchStore: store,
      openPredictions: () => [topicPred('息刻'), followupPred],
      precompute,
      isIdle: () => true,
      now,
    });
    const r = await sc.tick();
    expect(r.ran).toBe(true);
    expect(r.topics).toContain('息刻');
    expect(r.written).toBe(1);
    expect(precompute).toHaveBeenCalledTimes(1); // followup 不是 topic → 不预算

    // 写入项带 TTL（30min 默认）：未过期可命中，过期后消失
    const fresh = store.get('sleeptime:息刻', now() + 60_000);
    expect(fresh).toBeTruthy();
    expect(store.get('sleeptime:息刻', now() + 31 * 60_000)).toBeNull(); // TTL 过期
  });

  it('precompute 收到 AbortSignal（可取消的凭据）+ 写池用注入 now 当 fetchedAt', async () => {
    let seenSignal = null;
    const sc = createSleepTimeCompute({
      prefetchStore: store, isIdle: () => true, now,
      openPredictions: () => [topicPred('卡牌')],
      precompute: async (_q, { signal }) => { seenSignal = signal; return 'x'; },
    });
    await sc.tick();
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    // fetchedAt = now()：用 now() 当下查应在 TTL 窗内新鲜
    expect(store.get('sleeptime:卡牌', now())).toBeTruthy();
  });

  it('限流 maxTopicsPerTick：一跳最多预算 N 个主题', async () => {
    const precompute = vi.fn(async (q) => `r:${q}`);
    const sc = createSleepTimeCompute({
      prefetchStore: store, isIdle: () => true, now, maxTopicsPerTick: 2,
      openPredictions: () => [topicPred('a1'), topicPred('b2'), topicPred('c3')],
      precompute,
    });
    const r = await sc.tick();
    expect(r.written).toBe(2);
    expect(precompute).toHaveBeenCalledTimes(2);
  });

  it('池中已有该主题候选 → 跳过不重复花预算', async () => {
    store.set('sleeptime:息刻', '[空闲预判候选…]\n旧的', 30 * 60_000, now());
    const precompute = vi.fn(async () => 'new');
    const sc = createSleepTimeCompute({
      prefetchStore: store, isIdle: () => true, now,
      openPredictions: () => [topicPred('息刻')], precompute,
    });
    const r = await sc.tick();
    expect(precompute).not.toHaveBeenCalled();
    expect(r.skipped).toBe('no_candidates');
  });
});

describe('createSleepTimeCompute — owner 来了立即取消在途预计算', () => {
  it('cancel() abort 在途 → 该主题结果被丢弃，不写池（不污染上下文）', async () => {
    let release;
    const gate = new Promise((res) => { release = res; });
    const sc = createSleepTimeCompute({
      prefetchStore: store, isIdle: () => true, now,
      openPredictions: () => [topicPred('息刻')],
      // 预算挂起到我们手动放行（模拟本地模型慢档在跑）
      precompute: async (_q, { signal }) => { await gate; return signal.aborted ? null : '本不该写入'; },
    });
    const p = sc.tick();
    // owner 此刻发来消息 → 立即取消
    const had = sc.cancel('owner_active');
    expect(had).toBe(true);
    release('go');
    const r = await p;
    expect(r.cancelled).toBe(true);
    expect(r.written).toBe(0);
    expect(store.get('sleeptime:息刻', now())).toBeNull(); // 在途结果绝不落池
  });

  it('多主题：取消后停止处理后续主题', async () => {
    let firstStarted; const firstGate = new Promise((res) => { firstStarted = res; });
    let release; const hold = new Promise((res) => { release = res; });
    const precompute = vi.fn(async (q, { signal }) => {
      if (q === 't1') { firstStarted(); await hold; return signal.aborted ? null : 'r1'; }
      return 'r2';
    });
    const sc = createSleepTimeCompute({
      prefetchStore: store, isIdle: () => true, now, maxTopicsPerTick: 5,
      openPredictions: () => [topicPred('t1'), topicPred('t2'), topicPred('t3')],
      precompute,
    });
    const p = sc.tick();
    await firstGate;          // 确保已进入第一个主题的预算
    sc.cancel();
    release('go');
    const r = await p;
    expect(r.cancelled).toBe(true);
    expect(precompute).toHaveBeenCalledTimes(1); // t2/t3 不再启动
    expect(r.written).toBe(0);
  });
});

describe('createSleepTimeCompute — prefetch 是带 source 的候选，不是答案', () => {
  it('写入 value 带显式来源标记 + 「非结论」措辞（候选凭据）', async () => {
    const sc = createSleepTimeCompute({
      prefetchStore: store, isIdle: () => true, now,
      openPredictions: () => [topicPred('登录')],
      precompute: async () => '登录崩溃的历史记录若干',
    });
    await sc.tick();
    const v = store.get('sleeptime:登录', now());
    expect(v).toContain('sleep-time-compute'); // source 标记
    expect(v).toContain('主题:登录');
    expect(v).toContain('非结论');             // 显式声明是候选参考非答案
    // 经 toContextBlock 注入：作 <prefetched-items> 参考块（不是直接答案输出）
    const block = store.toContextBlock(now());
    expect(block).toContain('<prefetched-items>');
    expect(block).toContain('[sleeptime:登录]');
  });

  it('precompute 返回空/null → 不写入空候选（不污染池）', async () => {
    const sc = createSleepTimeCompute({
      prefetchStore: store, isIdle: () => true, now,
      openPredictions: () => [topicPred('空主题')],
      precompute: async () => null,
    });
    const r = await sc.tick();
    expect(r.written).toBe(0);
    expect(store.size()).toBe(0);
  });
});

describe('createSleepTimeCompute — fail-open / 不空闲零动作（OFF 语义对齐）', () => {
  it('不空闲 → skip，不调 precompute（绝不抢正在进行的对话）', async () => {
    const precompute = vi.fn(async () => 'x');
    const sc = createSleepTimeCompute({
      prefetchStore: store, isIdle: () => false, now,
      openPredictions: () => [topicPred('息刻')], precompute,
    });
    const r = await sc.tick();
    expect(r.skipped).toBe('not_idle');
    expect(precompute).not.toHaveBeenCalled();
  });

  it('isIdle 抛错 → 保守按「不空闲」处理，不跑', async () => {
    const precompute = vi.fn(async () => 'x');
    const sc = createSleepTimeCompute({
      prefetchStore: store, now, isIdle: () => { throw new Error('boom'); },
      openPredictions: () => [topicPred('息刻')], precompute,
    });
    expect((await sc.tick()).skipped).toBe('not_idle');
    expect(precompute).not.toHaveBeenCalled();
  });

  it('依赖缺失 → unwired skip，不抛错（OFF/未接线零回归语义）', async () => {
    expect((await createSleepTimeCompute({ prefetchStore: null }).tick()).skipped).toBe('unwired');
    expect((await createSleepTimeCompute({ prefetchStore: store, openPredictions: null }).tick()).skipped).toBe('unwired');
  });

  it('openPredictions 抛错 → 静默无候选，不抛错', async () => {
    const sc = createSleepTimeCompute({
      prefetchStore: store, isIdle: () => true, now,
      openPredictions: () => { throw new Error('boom'); },
      precompute: async () => 'x',
    });
    const r = await sc.tick();
    expect(r.skipped).toBe('no_candidates');
  });

  it('precompute 抛错 → 该主题跳过，不阻断其余主题', async () => {
    const sc = createSleepTimeCompute({
      prefetchStore: store, isIdle: () => true, now, maxTopicsPerTick: 2,
      openPredictions: () => [topicPred('炸的'), topicPred('好的')],
      precompute: async (q) => { if (q === '炸的') throw new Error('model down'); return 'ok'; },
    });
    const r = await sc.tick();
    expect(r.written).toBe(1); // 好的 写入，炸的 跳过
    expect(store.get('sleeptime:好的', now())).toBeTruthy();
    expect(store.get('sleeptime:炸的', now())).toBeNull();
  });

  it('已在运行 → 第二次 tick 返回 already_running（串行，不并发交叠）', async () => {
    let release; const gate = new Promise((res) => { release = res; });
    const sc = createSleepTimeCompute({
      prefetchStore: store, isIdle: () => true, now,
      openPredictions: () => [topicPred('息刻')],
      precompute: async () => { await gate; return 'x'; },
    });
    const p1 = sc.tick();
    const r2 = await sc.tick(); // 第一跳还卡在 precompute
    expect(r2.skipped).toBe('already_running');
    release('go');
    await p1;
  });
});
