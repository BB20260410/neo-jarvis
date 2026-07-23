import { describe, it, expect } from 'vitest';
import { weekLabelOf, weekBucketOf, groupEpisodesByWeek } from '../../src/memory/NoeEpisodeSublimation.js';

// 强健加固(批3):weekLabelOf 是导出纯函数,被直接以非有限 bucket(NaN/undefined/Infinity)调用时
// 原 new Date(NaN).toISOString() 会抛 RangeError。加固=降级占位。合法数值 bucket 逐字不变。
// (内部 groupEpisodesByWeek 已 guard 坏 ts,此为导出面 defense-in-depth。)

const WEEK_MS = 7 * 86_400_000;

describe('weekLabelOf 非法桶号强健性', () => {
  it('非有限 bucket(NaN/undefined/字符串/Infinity)→降级占位,绝不抛错', () => {
    for (const bad of [NaN, undefined, 'x', Infinity, -Infinity, {}]) {
      let out;
      expect(() => { out = weekLabelOf(bad); }).not.toThrow();
      expect(out).toBe('某一周');
    }
  });

  it('合法数值 bucket 逐字不变(零回归)', () => {
    for (const b of [0, 2900, 2950, -10, 3000]) {
      expect(weekLabelOf(b)).toBe(`${new Date(b * WEEK_MS).toISOString().slice(0, 10)} 那一周`);
    }
    expect(weekLabelOf(weekBucketOf(1_780_000_000_000))).toMatch(/^\d{4}-\d{2}-\d{2} 那一周$/);
  });

  it('groupEpisodesByWeek 标签仍由 weekLabelOf 生成,坏 ts 行被内部 guard 跳过(零回归)', () => {
    const T0 = 1_780_000_000_000;
    const groups = groupEpisodesByWeek([
      { ts: T0, summary: '本周一件事' },
      { ts: undefined, summary: '坏 ts 行' },
      { ts: T0 - 8 * 86_400_000, summary: '上上周一件事' },
    ]);
    expect(groups.length).toBe(2); // 坏 ts 行被剔除
    for (const g of groups) {
      expect(g.label).toBe(weekLabelOf(g.bucket));
      expect(g.label).toMatch(/ 那一周$/);
    }
  });
});
