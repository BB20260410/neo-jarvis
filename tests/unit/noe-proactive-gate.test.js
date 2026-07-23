import { describe, it, expect } from 'vitest';
import { shouldSpeakProactively } from '../../src/loop/NoeProactiveGate.js';

// 第三阶段·更智能的活动陪伴:懂什么时候该安静。超越「时钟静默」——还看主人是否正在专注工作、有没有真值得说的。
// 纯函数,fail-open(判不出就倾向安静,不打扰)。

describe('shouldSpeakProactively', () => {
  it('紧急事永远开口(压过一切)', () => {
    expect(shouldSpeakProactively({ isQuiet: true, msSinceOwnerActivity: 0, hasGenuineReason: false, urgent: true }).speak).toBe(true);
  });

  it('静默时段 → 不开口', () => {
    expect(shouldSpeakProactively({ isQuiet: true, hasGenuineReason: true }).speak).toBe(false);
  });

  it('主人刚刚还在活动(专注窗口内) → 不打断(即使白天)', () => {
    const r = shouldSpeakProactively({ isQuiet: false, msSinceOwnerActivity: 30_000, focusWindowMs: 300_000, hasGenuineReason: true });
    expect(r.speak).toBe(false);
    expect(r.reason).toBe('owner_focused');
  });

  it('没真值得说的 → 不闲聊(懂克制)', () => {
    expect(shouldSpeakProactively({ isQuiet: false, msSinceOwnerActivity: 999_999, hasGenuineReason: false }).speak).toBe(false);
  });

  it('非静默 + 主人已离开一阵 + 有真话要说 → 好时机,开口', () => {
    const r = shouldSpeakProactively({ isQuiet: false, msSinceOwnerActivity: 999_999, focusWindowMs: 300_000, hasGenuineReason: true });
    expect(r.speak).toBe(true);
    expect(r.reason).toBe('good_moment');
  });

  it('缺省参数 fail-open 倾向安静(判不出不打扰)', () => {
    // 无 owner 活动信息(Infinity)+ 无真理由默认 → 不该硬开口
    expect(shouldSpeakProactively({ hasGenuineReason: false }).speak).toBe(false);
  });
});
