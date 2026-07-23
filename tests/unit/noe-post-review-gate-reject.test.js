import { describe, expect, it } from 'vitest';
import { validateNoePostReview } from '../../src/room/NoePostReviewGate.js';

// P3 复核复活（2026-07-02）：reject 此前只减 approve 票数——3 reviewer quorum 阈值 2 时
//   local×2 approve + m3 reject 照样放行（实测 26 次 m3 reject 全被共识淹没、失败学习闭环饿死）。
//   现 reject 一票即阻断（错误串带 reviewer_rejects），由 trigger 的 terminal-reject 分支学习+释放。
describe('validateNoePostReview reject 一票阻断', () => {
  const reviews3 = (m3Decision) => [
    { model: 'local-qwen', decision: 'approve', rawOutputRef: 'x/q.txt' },
    { model: 'local-gemma', decision: 'approve', rawOutputRef: 'x/g.txt' },
    { model: 'm3', decision: m3Decision, rawOutputRef: 'x/m3.txt' },
  ];

  it('必需 reviewer reject → 即使 quorum 满足也阻断（reviewer_rejects:m3）', () => {
    const errors = [];
    validateNoePostReview(errors, {
      postReview: { ok: true, reviews: reviews3('reject') },
      requireFile: false,
      activeExecutor: 'codex',
      requiredReviewers: ['local-qwen', 'local-gemma', 'm3'],
      prefix: 'post_review',
    });
    expect(errors.some((e) => e.includes('reviewer_rejects:m3'))).toBe(true);
  });

  it('必需集之外的 advisory reviewer reject 同样阻断（advisory_reviewer_rejects）', () => {
    const errors = [];
    validateNoePostReview(errors, {
      postReview: { ok: true, reviews: reviews3('reject') },
      requireFile: false,
      activeExecutor: 'codex',
      requiredReviewers: ['local-qwen', 'local-gemma'],
      prefix: 'post_review',
    });
    expect(errors.some((e) => e.includes('reviewer_rejects:m3'))).toBe(true);
  });

  it('abstain 不阻断（quorum 由两本地 approve 满足照常通过）', () => {
    const errors = [];
    const r = validateNoePostReview(errors, {
      postReview: { ok: true, reviews: reviews3('abstain') },
      requireFile: false,
      activeExecutor: 'codex',
      requiredReviewers: ['local-qwen', 'local-gemma', 'm3'],
      prefix: 'post_review',
    });
    expect(errors.filter((e) => e.includes('reject'))).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('unavailable 不阻断也不计 quorum（现状保持）', () => {
    const errors = [];
    const r = validateNoePostReview(errors, {
      postReview: { ok: true, reviews: reviews3('unavailable') },
      requireFile: false,
      activeExecutor: 'codex',
      requiredReviewers: ['local-qwen', 'local-gemma', 'm3'],
      prefix: 'post_review',
    });
    expect(errors.filter((e) => e.includes('reject'))).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
