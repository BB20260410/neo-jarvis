// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { resolveReviewTier, resolveReviewTierConfig } from '../../src/security/NoeReviewTier.js';

describe('NoeReviewTier 渐进审查梯度（P3.1）', () => {
  it('高危 red/yellow → 始终 full（即便完成数很大，高危不放松）', () => {
    expect(resolveReviewTier({ completedCount: 9999, riskTier: 'red' }).tier).toBe('full');
    expect(resolveReviewTier({ completedCount: 9999, riskTier: 'red' }).requirePostReview).toBe(true);
    expect(resolveReviewTier({ completedCount: 9999, riskTier: 'yellow' }).requirePostReview).toBe(true);
  });
  it('auto-flagged → 强制 full（即便 green + 后段）', () => {
    expect(resolveReviewTier({ completedCount: 9999, riskTier: 'green', autoFlagged: true }).tier).toBe('full');
  });
  it('首 N 次（count<5）green → full', () => {
    const r = resolveReviewTier({ completedCount: 3, riskTier: 'green' });
    expect(r.tier).toBe('full');
    expect(r.requirePostReview).toBe(true);
  });
  it('中段（5≤count<25）green → flagged_only，省 post_review', () => {
    const r = resolveReviewTier({ completedCount: 10, riskTier: 'green' });
    expect(r.tier).toBe('flagged_only');
    expect(r.requirePostReview).toBe(false);
  });
  it('后段（count≥25）抽样命中 → 审', () => {
    const r = resolveReviewTier({ completedCount: 30, riskTier: 'green', sampleIndex: 30 }); // 30%5=0
    expect(r.tier).toBe('sample');
    expect(r.requirePostReview).toBe(true);
  });
  it('后段抽样跳过 → 省 post_review', () => {
    const r = resolveReviewTier({ completedCount: 30, riskTier: 'green', sampleIndex: 31 }); // 31%5≠0
    expect(r.tier).toBe('sample');
    expect(r.requirePostReview).toBe(false);
  });
  it('反向 probe：count 负/NaN → 当 0 → full', () => {
    expect(resolveReviewTier({ completedCount: -5, riskTier: 'green' }).tier).toBe('full');
    expect(resolveReviewTier({ completedCount: NaN, riskTier: 'green' }).tier).toBe('full');
  });
  it('阈值可配：fullThreshold=1 时 count=2 green 进中段', () => {
    expect(resolveReviewTier({ completedCount: 2, riskTier: 'green' }, { fullThreshold: 1, flaggedThreshold: 10 }).tier).toBe('flagged_only');
  });
  it('resolveReviewTierConfig：env 解析 + 默认回退', () => {
    expect(resolveReviewTierConfig({ NOE_SELF_EVOLUTION_REVIEW_TIER: '1', NOE_REVIEW_TIER_FULL_N: '3' })).toMatchObject({ enabled: true, fullThreshold: 3 });
    expect(resolveReviewTierConfig({})).toMatchObject({ enabled: false, fullThreshold: 5, flaggedThreshold: 25, sampleEvery: 5 });
  });

  it('fail-closed 白名单（Claude 审）：unknown/空/未知/缺省 riskTier → full（仅 green 放松）', () => {
    expect(resolveReviewTier({ completedCount: 10, riskTier: 'unknown' }).requirePostReview).toBe(true);
    expect(resolveReviewTier({ completedCount: 10, riskTier: '' }).tier).toBe('full');
    expect(resolveReviewTier({ completedCount: 10 }).tier).toBe('full'); // riskTier 缺省
    expect(resolveReviewTier({ completedCount: 10, riskTier: 'bogus' }).tier).toBe('full');
  });

  it('config 防误配：flaggedThreshold <= fullThreshold → 自动 +1（中段不为空）', () => {
    const c = resolveReviewTierConfig({ NOE_SELF_EVOLUTION_REVIEW_TIER: '1', NOE_REVIEW_TIER_FULL_N: '30', NOE_REVIEW_TIER_FLAGGED_N: '10' });
    expect(c.flaggedThreshold).toBe(31);
  });
});
