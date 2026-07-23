// @ts-check
import { describe, it, expect } from 'vitest';
import { computeNextRunAtMs, errorBackoffMs, adaptiveCadenceMs, pickLearningTitle } from '../../src/loop/NoeLearningSchedule.js';

// P4 定时学习调度纯时间计算：三 schedule kind + 失败退避 + Neo 成效自适应。全确定性(固定 now,无时钟/网络)。
const NOW = 1_000_000_000_000;

describe('computeNextRunAtMs — 三 schedule kind', () => {
  it('at: 未来返回 atMs, 过期返回 null(一次性过期不再跑)', () => {
    expect(computeNextRunAtMs({ kind: 'at', atMs: NOW + 5000 }, NOW)).toBe(NOW + 5000);
    expect(computeNextRunAtMs({ kind: 'at', atMs: NOW - 5000 }, NOW)).toBe(null);
  });
  it('every: 锚点对齐, next 严格 > now(含正好到点)', () => {
    expect(computeNextRunAtMs({ kind: 'every', everyMs: 10000, anchorMs: NOW }, NOW)).toBe(NOW + 10000);
    expect(computeNextRunAtMs({ kind: 'every', everyMs: 10000, anchorMs: NOW }, NOW + 25000)).toBe(NOW + 30000);
    expect(computeNextRunAtMs({ kind: 'every', everyMs: 10000, anchorMs: NOW }, NOW + 30000)).toBe(NOW + 40000); // 正好到点也 +1
    expect(computeNextRunAtMs({ kind: 'every', everyMs: 10000, anchorMs: NOW + 50000 }, NOW)).toBe(NOW + 50000); // 未来锚点→第一次在锚点
    expect(computeNextRunAtMs({ kind: 'every', everyMs: 10000 }, NOW)).toBe(NOW + 10000); // 无锚点默认 now
  });
  it('cron: croner 解析每2小时整点', () => {
    const next = computeNextRunAtMs({ kind: 'cron', cronExpr: '0 */2 * * *' }, NOW);
    expect(next).toBeGreaterThan(NOW);
    expect(next % 3_600_000).toBe(0); // 整点
  });
  it('非法 spec → null(不崩)', () => {
    expect(computeNextRunAtMs({ kind: 'cron', cronExpr: '' }, NOW)).toBe(null);
    expect(computeNextRunAtMs({ kind: 'cron', cronExpr: 'garbage!!!' }, NOW)).toBe(null);
    expect(computeNextRunAtMs({ kind: 'every', everyMs: 0 }, NOW)).toBe(null);
  });
});

describe('errorBackoffMs — 失败退避查表(OpenClaw)', () => {
  it('30s→1h 查表 + 封顶 1h', () => {
    expect(errorBackoffMs(1)).toBe(30_000);
    expect(errorBackoffMs(2)).toBe(60_000);
    expect(errorBackoffMs(3)).toBe(300_000);
    expect(errorBackoffMs(5)).toBe(3_600_000);
    expect(errorBackoffMs(99)).toBe(3_600_000); // 封顶
  });
});

describe('adaptiveCadenceMs — Neo 成效自适应(超越 OpenClaw)', () => {
  const base = 60_000;
  it('mastery 高(学会了)→ 间隔拉长 1×→3×', () => {
    expect(adaptiveCadenceMs(base, { mastery: 0 })).toBe(base);
    expect(adaptiveCadenceMs(base, { mastery: 0.5 })).toBe(base * 2);
    expect(adaptiveCadenceMs(base, { mastery: 1 })).toBe(base * 3);
  });
  it('consecutiveIdle 高(学不动)→ 指数退避封顶 8×', () => {
    expect(adaptiveCadenceMs(base, { consecutiveIdle: 0 })).toBe(base);
    expect(adaptiveCadenceMs(base, { consecutiveIdle: 1 })).toBe(Math.round(base * 1.5));
    expect(adaptiveCadenceMs(base, { consecutiveIdle: 10 })).toBe(base * 8); // 封顶
  });
  it('quiet 夜间 → ×4', () => {
    expect(adaptiveCadenceMs(base, { quiet: true })).toBe(base * 4);
  });
  it('封顶 maxMs(各乘子叠加超上限)', () => {
    expect(adaptiveCadenceMs(1_000_000, { mastery: 1, consecutiveIdle: 10, quiet: true, maxMs: 4 * 3_600_000 })).toBe(4 * 3_600_000);
  });
  it('base≥maxMs 的稀疏任务: 以 base 为天花板(deliberate 语义,codex 复核非 bug)', () => {
    // base=6h > maxMs=4h: 即便 idle/mastery 拉满,也只返回 base(6h)——稀疏节奏已够,不退避到更久
    expect(adaptiveCadenceMs(6 * 3_600_000, { consecutiveIdle: 10, maxMs: 4 * 3_600_000 })).toBe(6 * 3_600_000);
    expect(adaptiveCadenceMs(6 * 3_600_000, { mastery: 1, maxMs: 4 * 3_600_000 })).toBe(6 * 3_600_000);
  });
});

describe('pickLearningTitle — 轮换角度防自锁(M3 serious#1)', () => {
  const topic = 'AI agent 工具';
  const bucket = 3_600_000;
  it('不同时间分桶 → 不同角度 title(避免固定 title 撞 add 去重自锁)', () => {
    const titles = [0, 1, 2, 3].map((i) => pickLearningTitle(topic, i * bucket, bucket));
    expect(new Set(titles).size).toBe(4); // 4 桶 4 个不同 title
    expect(titles[0]).toContain(topic);
  });
  it('同一时间分桶 → 同一 title(同周期重复 tick 才去重 idle)', () => {
    expect(pickLearningTitle(topic, 100, bucket)).toBe(pickLearningTitle(topic, 200, bucket));
  });
  it('4 角度循环 → 第 5 桶回到第 1 个角度(一轮回)', () => {
    expect(pickLearningTitle(topic, 0, bucket)).toBe(pickLearningTitle(topic, 4 * bucket, bucket));
  });
  it('topic 为空/角度池为空 → 不崩(降级默认池)', () => {
    expect(pickLearningTitle('', 0, bucket)).toContain('自主学习');
    expect(pickLearningTitle(topic, 0, bucket, [])).toContain(topic);
  });
});
