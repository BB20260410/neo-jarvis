import { describe, it, expect } from 'vitest';
import { createEvolutionReviewTick } from '../../src/loop/NoeEvolutionReviewTick.js';

// Step1:自我复盘挂 Neo 心跳——每天(cadence)读 panel.db 建仪表盘快照 append 到 history.jsonl,
// 让「每天更强」的趋势曲线自动累积、循环自转。DI 全可注入,纯逻辑可测。

describe('createEvolutionReviewTick', () => {
  it('读数据→建快照→append(趋势序列自动累积)', () => {
    const appended = [];
    const tick = createEvolutionReviewTick({
      queryOutcomes: () => [
        { verdict: 'logic_changed', applied: 1, reason: 'kept' },
        { verdict: 'logic_changed', applied: 0, reason: 'verify_not_green' },
      ],
      queryGoals: () => [{ signal: 'test_gap', status: 'dropped' }],
      queryLessonCount: () => 186,
      appendSnapshot: (s) => appended.push(s),
      now: () => 1751500000000,
    });
    const r = tick();
    expect(r.ok).toBe(true);
    expect(appended).toHaveLength(1);
    expect(appended[0].outcomes.realProgress).toBe(1);          // 真进步率数据进快照
    expect(appended[0].outcomes.realProgressRate).toBeCloseTo(0.5);
    expect(appended[0].goals.bySignal.test_gap.dropped).toBe(1);
    expect(appended[0].lessonCount).toBe(186);
    expect(appended[0].at).toBeTruthy();
    expect(r.realProgressRate).toBeCloseTo(0.5);                 // 返回北极星供心跳日志
  });

  it('查询抛错 → fail-open 不崩(绝不阻断心跳)', () => {
    const tick = createEvolutionReviewTick({
      queryOutcomes: () => { throw new Error('db locked'); },
      queryGoals: () => [],
      queryLessonCount: () => 0,
      appendSnapshot: () => {},
      now: () => 1,
    });
    const r = tick();
    expect(r.ok).toBe(false);
    expect(r.skipped || r.error).toBeTruthy();
  });

  it('append 抛错 → 不崩(快照没落成也不阻断)', () => {
    const tick = createEvolutionReviewTick({
      queryOutcomes: () => [],
      queryGoals: () => [],
      queryLessonCount: () => 0,
      appendSnapshot: () => { throw new Error('disk full'); },
      now: () => 1,
    });
    expect(() => tick()).not.toThrow();
  });
});
