import { describe, expect, it } from 'vitest';
import { classifyNoeVisionSituation } from '../../src/vision/NoeVisionSituation.js';

describe('NoeVisionSituation', () => {
  it('把写代码报错识别为需要调试帮助且允许轻触提醒', () => {
    const r = classifyNoeVisionSituation({
      summary: '用户正在编辑器里写代码，终端显示测试失败和报错，看起来有点卡住。',
      mode: 'screen',
      at: 1000,
      now: 2000,
    });
    expect(r).toMatchObject({
      activity: 'coding',
      attention: 'stuck',
      possibleNeed: 'debug_help',
      shouldInterrupt: true,
      stale: false,
      mode: 'screen',
    });
    expect(r.confidence).toBeGreaterThan(0.5);
    expect(r.evidence).toContain('signal:coding');
  });

  it('过期视觉证据不建议打扰且置信度降级', () => {
    const r = classifyNoeVisionSituation({
      summary: '用户在阅读文档。',
      mode: 'screen',
      at: 1000,
      now: 200_000,
    });
    expect(r.stale).toBe(true);
    expect(r.shouldInterrupt).toBe(false);
    expect(r.confidence).toBeLessThanOrEqual(0.35);
    expect(r.evidence).toContain('policy:stale_no_interrupt');
  });
});
