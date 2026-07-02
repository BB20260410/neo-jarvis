import { describe, it, expect } from 'vitest';
import { relativeTime, EpisodicTimeline } from '../../src/memory/EpisodicTimeline.js';

// 强健加固(批3):relativeTime 对非有限 ts 不再抛 RangeError(new Date(NaN).toISOString() 会崩),
// 因消费方 narrative() 无 try/catch 且喂系统提示注入路径,坏 ts 会真崩。合法数值 ts 行为逐字不变。

const T0 = 1_780_000_000_000;

describe('relativeTime 非法时间戳强健性', () => {
  it('非有限 ts(undefined/NaN/脏字符串/对象)→降级占位,绝不抛错', () => {
    for (const bad of [undefined, NaN, 'abc', {}, [], Symbol.iterator]) {
      let out;
      expect(() => { out = relativeTime(bad, T0); }).not.toThrow();
      expect(typeof out).toBe('string');
      expect(out).toBe('某时');
    }
  });

  it('now 为非有限值时也不抛(用真实时钟兜底)', () => {
    expect(() => relativeTime(T0 - 1000, NaN)).not.toThrow();
    expect(() => relativeTime(T0 - 1000, undefined)).not.toThrow();
  });

  it('合法数值 ts 全档位逐字不变(零回归)', () => {
    expect(relativeTime(T0 - 30_000, T0)).toBe('刚刚');
    expect(relativeTime(T0 - 2 * 60_000, T0)).toBe('2 分钟前');
    expect(relativeTime(T0 - 3 * 3_600_000, T0)).toBe('3 小时前');
    expect(relativeTime(T0 - 24 * 3_600_000, T0)).toBe('昨天');
    expect(relativeTime(T0 - 3 * 86_400_000, T0)).toBe('3 天前');
    expect(relativeTime(T0 - 10 * 86_400_000, T0)).toBe('1 周前');
    expect(relativeTime(T0 - 40 * 86_400_000, T0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(relativeTime(T0 + 5000, T0)).toBe('刚刚');
    expect(relativeTime(T0, T0)).toBe('刚刚');
    // null 仍按 epoch 0(Number(null)=0,有限)处理,与加固前一致——只兜真正会抛的非有限输入
    expect(relativeTime(null, T0)).toBe('1970-01-01');
  });

  it('narrative() 遇缺失 ts 的情景不再崩,坏行被跳过、好行照常编织', () => {
    const episodes = [
      { id: 1, ts: T0 - 60_000, kind: 'noe_episode', payload: { episodeType: 'interaction', summary: '正常的一句', salience: 5 } },
      { id: 2, ts: undefined, kind: 'noe_episode', payload: { episodeType: 'interaction', summary: '缺 ts 的坏行', salience: 5 } },
    ];
    const tl = new EpisodicTimeline({
      list: () => episodes,
      now: () => T0,
    });
    let text;
    expect(() => { text = tl.narrative(); }).not.toThrow();
    expect(text).toContain('1 分钟前：正常的一句');
    // 坏行的相对时间降级为 '某时'(不抛、不污染整段)
    expect(text).toContain('某时：缺 ts 的坏行');
  });
});
