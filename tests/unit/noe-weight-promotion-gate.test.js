import { describe, it, expect } from 'vitest';
import { personaConsistencyScore, decideWeightPromotion } from '../../src/weights/NoeWeightPromotionGate.js';

describe('personaConsistencyScore', () => {
  it('答案与期望一致 → 高分；漂走 → 低分', () => {
    expect(personaConsistencyScore([{ expected: '我会简洁直接地回答', actual: '我会简洁直接地回答' }]).score).toBe(1);
    const low = personaConsistencyScore([{ expected: '简洁直接温暖', actual: '完全无关的官腔套话' }]);
    expect(low.score).toBeLessThan(0.3);
  });
  it('空 → ok:false', () => {
    expect(personaConsistencyScore([]).ok).toBe(false);
  });
});

describe('decideWeightPromotion（Shadow Mode + 自动 revert）', () => {
  it('连续 N 次候选≥基线 → promote', () => {
    const runs = [{ baseline: 0.8, candidate: 0.82 }, { baseline: 0.8, candidate: 0.81 }, { baseline: 0.8, candidate: 0.83 }];
    expect(decideWeightPromotion({ shadowRuns: runs, minConsecutiveWins: 3 })).toMatchObject({ decision: 'promote', consecutiveWins: 3 });
  });
  it('连胜不足 → hold', () => {
    const runs = [{ baseline: 0.8, candidate: 0.82 }, { baseline: 0.8, candidate: 0.83 }];
    expect(decideWeightPromotion({ shadowRuns: runs, minConsecutiveWins: 3 })).toMatchObject({ decision: 'hold', consecutiveWins: 2 });
  });
  it('掉点超阈值 → revert（人格漂移/退化）', () => {
    const runs = [{ baseline: 0.8, candidate: 0.82 }, { baseline: 0.8, candidate: 0.7 }]; // 掉 0.1 > 0.05
    expect(decideWeightPromotion({ shadowRuns: runs, minConsecutiveWins: 3, maxDropThreshold: 0.05 })).toMatchObject({ decision: 'revert' });
  });
  it('中途断胜（candidate<baseline 但未超掉点阈值）→ 连胜清零 hold', () => {
    const runs = [{ baseline: 0.8, candidate: 0.82 }, { baseline: 0.8, candidate: 0.79 }, { baseline: 0.8, candidate: 0.82 }];
    // 最近一次赢，但前一次输（0.79<0.8，掉0.01<阈值不revert），从最近往前数连胜=1
    const r = decideWeightPromotion({ shadowRuns: runs, minConsecutiveWins: 3, maxDropThreshold: 0.05 });
    expect(r.decision).toBe('hold');
    expect(r.consecutiveWins).toBe(1);
  });
  it('无 shadow run → hold（禁裸热更）', () => {
    expect(decideWeightPromotion({ shadowRuns: [] }).decision).toBe('hold');
  });
  it('minConsecutiveWins=0/负数被钳到 1（防无胜也 promote）', () => {
    // 候选<基线（输）+ minConsecutiveWins=0 → 旧实现会误 promote；钳到 1 后 consecutiveWins=0 < 1 → hold
    const runs = [{ baseline: 0.8, candidate: 0.78 }];
    expect(decideWeightPromotion({ shadowRuns: runs, minConsecutiveWins: 0 }).decision).toBe('hold');
    expect(decideWeightPromotion({ shadowRuns: runs, minConsecutiveWins: -5 }).decision).toBe('hold');
  });
  it('故意训坏（一致性大跌）→ 被检出 revert（满足 P5-2 完成判定）', () => {
    const runs = [{ baseline: 0.85, candidate: 0.4 }];
    expect(decideWeightPromotion({ shadowRuns: runs }).decision).toBe('revert');
  });
});
