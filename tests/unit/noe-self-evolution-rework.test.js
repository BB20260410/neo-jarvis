// @ts-check
// Step 3 返工纯函数 helper 直接单测（从 trigger 抽出后的配套单测，三件套规范）。
import { describe, expect, it } from 'vitest';
import {
  completionRequestsChanges,
  isReworkExhausted,
  collectCompletionBlockers,
  scrubReworkBlocker,
} from '../../src/room/NoeSelfEvolutionRework.js';

const mk = (reviews) => ({ ok: false, reason: 'post_review_not_approved', reviews });

describe('completionRequestsChanges', () => {
  it('request_changes（无 reject）→ true', () => {
    expect(completionRequestsChanges(mk([{ decision: 'request_changes' }, { decision: 'approve' }]))).toBe(true);
  });
  it('FINDING1 变体 Request_Changes / request-changes → true（normalize 口径）', () => {
    expect(completionRequestsChanges(mk([{ decision: 'Request_Changes' }]))).toBe(true);
    expect(completionRequestsChanges(mk([{ decision: 'request-changes' }]))).toBe(true);
  });
  it('含 reject → false（reject 优先，不返工）', () => {
    expect(completionRequestsChanges(mk([{ decision: 'request_changes' }, { decision: 'reject' }]))).toBe(false);
  });
  it('completion.ok!==false / reason 不符 / null → false', () => {
    expect(completionRequestsChanges({ ok: true })).toBe(false);
    expect(completionRequestsChanges({ ok: false, reason: 'post_review_failed', reviews: [{ decision: 'request_changes' }] })).toBe(false);
    expect(completionRequestsChanges(null)).toBe(false);
  });
});

describe('isReworkExhausted', () => {
  const c = mk([{ decision: 'request_changes' }]);
  it('reworkEnabled ON + reworkRounds>=max>0 → true（转 terminal 学习）', () => {
    expect(isReworkExhausted(c, { reworkEnabled: true, reworkRounds: 2, maxReworkRounds: 2 })).toBe(true);
  });
  it('未超限 → false', () => {
    expect(isReworkExhausted(c, { reworkEnabled: true, reworkRounds: 1, maxReworkRounds: 2 })).toBe(false);
  });
  it('reworkEnabled OFF → false', () => {
    expect(isReworkExhausted(c, { reworkEnabled: false, reworkRounds: 5, maxReworkRounds: 2 })).toBe(false);
  });
  it('边界 max<=0 → false（返工功能关闭，不当超限学习）', () => {
    expect(isReworkExhausted(c, { reworkEnabled: true, reworkRounds: 0, maxReworkRounds: 0 })).toBe(false);
  });
  it('含 reject → false（reject 走 isTerminalPostReviewReject，不走超限）', () => {
    expect(isReworkExhausted(mk([{ decision: 'request_changes' }, { decision: 'reject' }]), { reworkEnabled: true, reworkRounds: 2, maxReworkRounds: 2 })).toBe(false);
  });
});

describe('collectCompletionBlockers（P1-2 合并）', () => {
  it('合并 errors + request_changes review 的 evidence_gaps + blockers', () => {
    const out = collectCompletionBlockers({ errors: ['整体问题'], reviews: [
      { decision: 'request_changes', evidence_gaps: ['gap1'], blockers: ['blk1'] },
      { decision: 'approve', evidence_gaps: ['不该取'] },
    ] });
    expect(out).toContain('整体问题');
    expect(out).toContain('gap1');
    expect(out).toContain('blk1');
    expect(out).not.toContain('不该取'); // 只取 request_changes review 的 gap
  });
  it('errors 空 + 只 evidence_gaps → 仍取到（P1-2 核心：不丢 reviewer 要改点）', () => {
    expect(collectCompletionBlockers({ errors: [], reviews: [{ decision: 'request_changes', evidence_gaps: ['必须补测试'] }] })).toContain('必须补测试');
  });
  it('null completion → []', () => {
    expect(collectCompletionBlockers(null)).toEqual([]);
  });
});

describe('scrubReworkBlocker（P1-4 脱敏）', () => {
  it('抹 URL query token（redactSensitiveText 不覆盖的 query 形）', () => {
    expect(scrubReworkBlocker('见 https://x.com/cb?token=secretToken1234567890&a=1')).not.toContain('secretToken1234567890');
  });
  it('抹 &api_key= query 形', () => {
    expect(scrubReworkBlocker('https://x.com?a=1&api_key=KEYabcdef123456')).not.toContain('KEYabcdef123456');
  });
  it('抹具名 GitHub token（redactSensitiveText 既有能力）', () => {
    expect(scrubReworkBlocker('token ghp_abcdefghijklmnopqrstuvwxyz0123456789')).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });
  it('普通文本不误伤 + 截断 200', () => {
    expect(scrubReworkBlocker('补一个 no-diff 回归测试')).toBe('补一个 no-diff 回归测试');
    expect(scrubReworkBlocker('x'.repeat(300)).length).toBe(200);
  });
});
