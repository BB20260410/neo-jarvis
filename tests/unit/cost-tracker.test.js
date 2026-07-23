// 单元测试：src/cost/CostTracker.js
// 覆盖：estimateUsdFromUsage 分级计价 / 前缀匹配 / 关键词回退
//       CostTracker.windowUSD 时间窗（fake timers）/ record 边界 / snapshot

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { estimateUsdFromUsage, CostTracker } from '../../src/cost/CostTracker.js';

// ────────────────────────────────────────────────────────────────
// estimateUsdFromUsage
// ────────────────────────────────────────────────────────────────
describe('estimateUsdFromUsage', () => {
  // 定价常量快照，防止源码改价后测试静默通过
  // input:3, cache_read:0.3, cache_write:3.75, output:15  (sonnet-4-6 / default)
  // input:5, cache_read:0.5, cache_write:6.25, output:25 (opus-4-8)
  // input:15, cache_read:1.5, cache_write:18.75, output:75 (opus-4-7)
  // input:1, cache_read:0.1, cache_write:1.25, output:5   (haiku-4-5)

  it('null usage 返回 0', () => {
    expect(estimateUsdFromUsage(null, 'claude-sonnet-4-6')).toBe(0);
  });

  it('undefined usage 返回 0', () => {
    expect(estimateUsdFromUsage(undefined, 'claude-sonnet-4-6')).toBe(0);
  });

  it('精确模型：claude-sonnet-4-6 仅 output_tokens', () => {
    // 1_000_000 output tokens × 15.0 / 1e6 = 15 USD
    const usd = estimateUsdFromUsage({ output_tokens: 1_000_000 }, 'claude-sonnet-4-6');
    expect(usd).toBeCloseTo(15.0, 6);
  });

  it('精确模型：claude-opus-4-7 仅 input_tokens', () => {
    // 1_000_000 input × 15.0 / 1e6 = 15 USD
    const usd = estimateUsdFromUsage({ input_tokens: 1_000_000 }, 'claude-opus-4-7');
    expect(usd).toBeCloseTo(15.0, 6);
  });

  it('精确模型：claude-opus-4-8 仅 output_tokens', () => {
    const usd = estimateUsdFromUsage({ output_tokens: 1_000_000 }, 'claude-opus-4-8');
    expect(usd).toBeCloseTo(25.0, 6);
  });

  it('精确模型：claude-haiku-4-5 仅 output_tokens', () => {
    // 1_000_000 × 5.0 / 1e6 = 5 USD
    const usd = estimateUsdFromUsage({ output_tokens: 1_000_000 }, 'claude-haiku-4-5');
    expect(usd).toBeCloseTo(5.0, 6);
  });

  it('四类 token 分级计价（sonnet-4-6）', () => {
    // input:100k × 3/M + cache_read:200k × 0.3/M + cache_write:50k × 3.75/M + output:80k × 15/M
    // = 0.3 + 0.06 + 0.1875 + 1.2 = 1.7475
    const usd = estimateUsdFromUsage({
      input_tokens: 100_000,
      cache_read_input_tokens: 200_000,
      cache_creation_input_tokens: 50_000,
      output_tokens: 80_000,
    }, 'claude-sonnet-4-6');
    expect(usd).toBeCloseTo(1.7475, 6);
  });

  it('前缀匹配：带日期后缀的模型名应命中前缀', () => {
    // "claude-opus-4-8-20260528" -> prefix "claude-opus-4-8"
    const usdPrefix = estimateUsdFromUsage({ output_tokens: 1_000_000 }, 'claude-opus-4-8-20260528');
    const usdExact  = estimateUsdFromUsage({ output_tokens: 1_000_000 }, 'claude-opus-4-8');
    expect(usdPrefix).toBeCloseTo(usdExact, 8);
  });

  it('关键词回退：含 "opus" 的未知模型走 opus 定价', () => {
    const usd = estimateUsdFromUsage({ output_tokens: 1_000_000 }, 'my-opus-custom-model');
    // latest opus output = 25/M
    expect(usd).toBeCloseTo(25.0, 6);
  });

  it('关键词回退：含 "haiku" 的未知模型走 haiku 定价', () => {
    const usd = estimateUsdFromUsage({ output_tokens: 1_000_000 }, 'super-haiku-v2');
    // haiku output = 5/M
    expect(usd).toBeCloseTo(5.0, 6);
  });

  it('关键词回退：含 "sonnet" 的未知模型走 sonnet-4-6 定价', () => {
    const usd = estimateUsdFromUsage({ output_tokens: 1_000_000 }, 'experimental-sonnet-xyz');
    expect(usd).toBeCloseTo(15.0, 6);
  });

  it('完全未知模型走 default 定价（等同 sonnet-4-6）', () => {
    const usdDefault = estimateUsdFromUsage({ output_tokens: 1_000_000 }, 'totally-unknown-model');
    const usdSonnet  = estimateUsdFromUsage({ output_tokens: 1_000_000 }, 'claude-sonnet-4-6');
    expect(usdDefault).toBeCloseTo(usdSonnet, 8);
  });

  it('null/undefined model 走 default 定价', () => {
    const usd = estimateUsdFromUsage({ output_tokens: 1_000_000 }, null);
    expect(usd).toBeCloseTo(15.0, 6);
  });

  it('缺少 token 字段时当 0 处理，不会 NaN', () => {
    const usd = estimateUsdFromUsage({}, 'claude-sonnet-4-6');
    expect(usd).toBe(0);
  });

  it('NaN token 值被安全截断为 0', () => {
    const usd = estimateUsdFromUsage({ output_tokens: NaN, input_tokens: NaN }, 'claude-sonnet-4-6');
    expect(usd).toBe(0);
  });

  it('Infinity token 值被安全截断为 0', () => {
    const usd = estimateUsdFromUsage({ output_tokens: Infinity }, 'claude-sonnet-4-6');
    expect(usd).toBe(0);
  });

  it('负数 token 值被安全截断为 0', () => {
    const usd = estimateUsdFromUsage({ output_tokens: -500 }, 'claude-sonnet-4-6');
    expect(usd).toBe(0);
  });

  it('cache_write 比 input 贵（opus）', () => {
    const usdInput      = estimateUsdFromUsage({ input_tokens: 1_000_000 }, 'claude-opus-4-7');
    const usdCacheWrite = estimateUsdFromUsage({ cache_creation_input_tokens: 1_000_000 }, 'claude-opus-4-7');
    // opus cache_write=18.75 > input=15
    expect(usdCacheWrite).toBeGreaterThan(usdInput);
  });

  it('cache_read 比 input 便宜（sonnet）', () => {
    const usdInput     = estimateUsdFromUsage({ input_tokens: 1_000_000 }, 'claude-sonnet-4-6');
    const usdCacheRead = estimateUsdFromUsage({ cache_read_input_tokens: 1_000_000 }, 'claude-sonnet-4-6');
    // sonnet input=3 > cache_read=0.3
    expect(usdCacheRead).toBeLessThan(usdInput);
  });
});

// ────────────────────────────────────────────────────────────────
// CostTracker
// ────────────────────────────────────────────────────────────────
describe('CostTracker', () => {
  let tracker;

  beforeEach(() => {
    tracker = new CostTracker();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── record / totalUSD ──────────────────────────────────────────
  it('初始 totalUSD 为 0', () => {
    expect(tracker.totalUSD()).toBe(0);
  });

  it('record 后 totalUSD 累加', () => {
    tracker.record(0.01);
    tracker.record(0.02);
    expect(tracker.totalUSD()).toBeCloseTo(0.03, 8);
  });

  it('record NaN 被忽略', () => {
    tracker.record(NaN);
    expect(tracker.totalUSD()).toBe(0);
    expect(tracker.snapshot().sampleCount).toBe(0);
  });

  it('record Infinity 被忽略', () => {
    tracker.record(Infinity);
    expect(tracker.totalUSD()).toBe(0);
  });

  it('record 0 被忽略（usd <= 0）', () => {
    tracker.record(0);
    expect(tracker.totalUSD()).toBe(0);
    expect(tracker.snapshot().sampleCount).toBe(0);
  });

  it('record 负数被忽略', () => {
    tracker.record(-0.01);
    expect(tracker.totalUSD()).toBe(0);
  });

  // ── windowUSD 时间窗（fake timers）────────────────────────────
  it('windowUSD：窗口内的 sample 被累计', () => {
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
    tracker.record(0.05);

    // 30 秒后
    vi.setSystemTime(new Date('2024-01-01T00:00:30Z'));
    tracker.record(0.03);

    // 查 60 秒窗口，两条都在窗口内
    expect(tracker.windowUSD(60_000)).toBeCloseTo(0.08, 8);
  });

  it('windowUSD：超出窗口的 sample 被排除', () => {
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
    tracker.record(0.10); // 这条在 10 秒窗口外

    vi.setSystemTime(new Date('2024-01-01T00:00:20Z'));
    tracker.record(0.04); // 这条在窗口内

    // 查 15 秒窗口（只包含后一条）
    expect(tracker.windowUSD(15_000)).toBeCloseTo(0.04, 8);
  });

  it('windowUSD：空窗口返回 0', () => {
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
    tracker.record(0.05);

    // 移动到 2 分钟后，查 30 秒窗口
    vi.setSystemTime(new Date('2024-01-01T00:02:00Z'));
    expect(tracker.windowUSD(30_000)).toBe(0);
  });

  it('windowUSD：恰好在边界上的 sample 被包含', () => {
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
    tracker.record(0.07);

    // 向前推进恰好等于窗口大小（at >= cutoff，边界包含）
    vi.setSystemTime(new Date('2024-01-01T00:01:00Z'));
    // 60_000ms 窗口：cutoff = now - 60000 = at，边界包含
    expect(tracker.windowUSD(60_000)).toBeCloseTo(0.07, 8);
  });

  it('windowUSD：边界外 1ms 被排除', () => {
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
    tracker.record(0.07);

    vi.setSystemTime(new Date('2024-01-01T00:01:00.001Z')); // 60001ms 后
    expect(tracker.windowUSD(60_000)).toBe(0);
  });

  // ── ratePerMinute ──────────────────────────────────────────────
  it('ratePerMinute：5min 内总 USD 除以 5', () => {
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
    tracker.record(0.5);

    vi.setSystemTime(new Date('2024-01-01T00:02:00Z'));
    tracker.record(0.5);

    // 总 1.0 USD 在 5min 窗口内，rate = 1.0 / 5 = 0.2
    expect(tracker.ratePerMinute()).toBeCloseTo(0.2, 8);
  });

  it('ratePerMinute：5min 外的 sample 不计入', () => {
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
    tracker.record(999); // 超出 5min 窗口

    vi.setSystemTime(new Date('2024-01-01T00:10:00Z'));
    tracker.record(0.5);

    expect(tracker.ratePerMinute()).toBeCloseTo(0.5 / 5, 8);
  });

  // ── snapshot ───────────────────────────────────────────────────
  it('snapshot 字段完整', () => {
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
    tracker.record(0.1, 1000, 'claude-sonnet-4-6');

    const snap = tracker.snapshot();
    expect(snap).toHaveProperty('totalUSD');
    expect(snap).toHaveProperty('sampleCount');
    expect(snap).toHaveProperty('last5MinUSD');
    expect(snap).toHaveProperty('ratePerMinute');
    expect(snap.sampleCount).toBe(1);
    expect(snap.totalUSD).toBeCloseTo(0.1, 8);
  });

  // ── 内存上限 1000 条 ───────────────────────────────────────────
  it('超过 1000 条 record 时 samples 长度被截断到 1000', () => {
    for (let i = 0; i < 1050; i++) {
      tracker.record(0.001);
    }
    expect(tracker.snapshot().sampleCount).toBe(1000);
  });

  it('超过 1000 条后 totalUSD 仍然是真实累计（不因截断丢失）', () => {
    for (let i = 0; i < 1050; i++) {
      tracker.record(0.001);
    }
    expect(tracker.totalUSD()).toBeCloseTo(1050 * 0.001, 6);
  });
});
