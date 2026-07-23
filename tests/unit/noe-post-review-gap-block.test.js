// @ts-check
// P0 判据②：reviewer 明列硬 gap 的 approve_with_changes 不算 clean approve。
// flag NOE_POSTREVIEW_GAP_BLOCK 门控，默认 OFF（逐字零回归）。堵"m3 列 6 个 evidence_gap 仍被算通过盖章 complete"。
import { describe, expect, it } from 'vitest';
import { validateNoePostReview } from '../../src/room/NoePostReviewGate.js';

function mkReview(model, decision, gaps = []) {
  return {
    model,
    decision,
    authority: model === 'm3' ? 'suggestion_only' : 'readonly_source_reviewer',
    canWrite: false,
    rawOutputRef: `output/r/${model}.txt`,
    evidence_gaps: gaps,
  };
}
// claude clean approve + m3 approve_with_changes(带可配 gap)
function pr(m3Gaps) {
  return { ok: true, reviews: [mkReview('claude', 'approve', []), mkReview('m3', 'approve_with_changes', m3Gaps)] };
}
function run(postReview, gapBlock) {
  const errors = [];
  const r = validateNoePostReview(errors, { postReview, requiredReviewers: ['claude', 'm3'], gapBlock });
  return { errors, ...r };
}

describe('P0 判据②evidence_gap 阻断（NOE_POSTREVIEW_GAP_BLOCK）', () => {
  it('flag ON + approve_with_changes 带硬 gap(Tests array empty)→ 不计入 approvalCount', () => {
    const r = run(pr(['Tests array is empty — no test added', 'No actual diff content included']), true);
    expect(r.approvalCount).toBe(1); // 只 claude clean approve 算，m3 因硬 gap 被剔除
  });

  it('flag OFF（默认）+ 同样带硬 gap → 仍计入（逐字零回归）', () => {
    const r = run(pr(['Tests array is empty']), false);
    expect(r.approvalCount).toBe(2);
  });

  it('flag ON + approve_with_changes 无 gap → 正常计入', () => {
    const r = run(pr([]), true);
    expect(r.approvalCount).toBe(2);
  });

  it('flag ON + 仅软 gap(非硬阻断词) → 不误伤，正常计入', () => {
    const r = run(pr(['minor naming nit', '建议补一句注释']), true);
    expect(r.approvalCount).toBe(2);
  });

  // 总验收子代理审 P1：clean approve(decision=approve)+硬 gap 也是矛盾（批准却明列硬缺口），同样不算 clean approve——
  //   堵 finding5 的 decision=approve 变体绕过（reviewer 给 approve 顺手列 Tests empty，REAL_APPLY 下真改代码盖章）。
  it('clean approve(decision=approve) 带硬 gap → 也被 gap 闸剔除（防"批准但明列硬缺口"盖章）', () => {
    const errors = [];
    const pra = { ok: true, reviews: [mkReview('claude', 'approve', ['Tests array is empty']), mkReview('m3', 'approve', [])] };
    const r = validateNoePostReview(errors, { postReview: pra, requiredReviewers: ['claude', 'm3'], gapBlock: true });
    expect(r.approvalCount).toBe(1); // claude 虽 approve 但列硬 gap → 剔除（无论 decision，明列硬缺口不算 clean approve）
  });
  it('clean approve 带软 gap(非硬 gap 词) → 不误伤，正常计入', () => {
    const errors = [];
    const pra = { ok: true, reviews: [mkReview('claude', 'approve', ['minor naming nit']), mkReview('m3', 'approve', [])] };
    const r = validateNoePostReview(errors, { postReview: pra, requiredReviewers: ['claude', 'm3'], gapBlock: true });
    expect(r.approvalCount).toBe(2);
  });

  // finding5（#17 评估多模型发现的真 bug）：硬 gap 写在 reviewer 的 blockers 字段（非 evidence_gaps）时，gap 闸漏扫 → 绕过。
  it('finding5：approve_with_changes 硬 gap 写在 blockers 字段 + flag ON → 也不计入 approval（gap 闸须扫 blockers）', () => {
    const errors = [];
    const pr = { ok: true, reviews: [
      mkReview('claude', 'approve', []),
      { model: 'm3', decision: 'approve_with_changes', authority: 'suggestion_only', canWrite: false, rawOutputRef: 'output/r/m3.txt', blockers: ['Tests array is empty — no actual diff'] },
    ] };
    const r = validateNoePostReview(errors, { postReview: pr, requiredReviewers: ['claude', 'm3'], gapBlock: true });
    expect(r.approvalCount).toBe(1); // m3 因 blockers 里的硬 gap 被剔除（修复前漏扫 blockers→2）
  });
  it('finding5 反向：软 blocker(非硬 gap 词) → 不误伤，正常计入', () => {
    const errors = [];
    const pr = { ok: true, reviews: [
      mkReview('claude', 'approve', []),
      { model: 'm3', decision: 'approve_with_changes', authority: 'suggestion_only', canWrite: false, rawOutputRef: 'output/r/m3.txt', blockers: ['建议补一句注释'] },
    ] };
    const r = validateNoePostReview(errors, { postReview: pr, requiredReviewers: ['claude', 'm3'], gapBlock: true });
    expect(r.approvalCount).toBe(2);
  });

  // 总验收多模型审 P1：resolved 正则误判否定形——"not resolved: <硬gap>" 含 "resolved" 被当已解决而漏。
  it('总验收P1：blockers 含 "not resolved: <硬gap>" → 仍算未解决硬 gap（resolved 正则不误判否定形）', () => {
    const errors = [];
    const pr = { ok: true, reviews: [
      mkReview('claude', 'approve', []),
      { model: 'm3', decision: 'approve_with_changes', authority: 'suggestion_only', canWrite: false, rawOutputRef: 'output/r/m3.txt', blockers: ['not resolved: Tests array is empty'] },
    ] };
    const r = validateNoePostReview(errors, { postReview: pr, requiredReviewers: ['claude', 'm3'], gapBlock: true });
    expect(r.approvalCount).toBe(1); // "not resolved" 不该被当已解决，m3 仍因硬 gap 被剔除
  });
  it('总验收P1 反向：blockers 含 "resolved: <硬gap>（真已解决）" → 不算硬 gap，正常计入', () => {
    const errors = [];
    const pr = { ok: true, reviews: [
      mkReview('claude', 'approve', []),
      { model: 'm3', decision: 'approve_with_changes', authority: 'suggestion_only', canWrite: false, rawOutputRef: 'output/r/m3.txt', blockers: ['Tests array is empty — resolved by adding 3 tests'] },
    ] };
    const r = validateNoePostReview(errors, { postReview: pr, requiredReviewers: ['claude', 'm3'], gapBlock: true });
    expect(r.approvalCount).toBe(2); // 真已解决（resolved 非否定形）→ 不剔除
  });
});

// Step3 前置：request_changes 是 reviewer prompt 允许的裁决（NoeCompletionPostReview），
// 但 gate 旧 KNOWN_REVIEW_DECISIONS 不认 → 误判 unknown_decision。修契约：认作已知但不计 approval。
describe('post_review request_changes 裁决契约（Step3 返工前置）', () => {
  it('request_changes 是已知裁决 → 不产 unknown_decision，但不计入 approval（仍不放行 complete）', () => {
    const errors = [];
    const pr = { ok: true, reviews: [mkReview('claude', 'approve', []), mkReview('m3', 'request_changes', [])] };
    const r = validateNoePostReview(errors, { postReview: pr, requiredReviewers: ['claude', 'm3'] });
    expect(errors.some((e) => e.includes('unknown_decision'))).toBe(false);
    expect(r.approvalCount).toBe(1); // 只 claude clean approve 算；request_changes 不是 approval
  });

  it('反向 probe：未知词(deny)仍被判 unknown_decision（request_changes 不污染未知词识别）', () => {
    const errors = [];
    const pr = { ok: true, reviews: [mkReview('claude', 'approve', []), mkReview('m3', 'deny', [])] };
    validateNoePostReview(errors, { postReview: pr, requiredReviewers: ['claude', 'm3'] });
    expect(errors.some((e) => e.includes('unknown_decision:m3:deny'))).toBe(true);
  });

  // P1-1（两路审交叉 + 主线亲核）：request_changes 必须显式阻断 complete，不能被其他 reviewer 的 approve 在 quorum 满足时盖过。
  //   3 reviewer 时 quorum threshold=max(2,ceil(3*2/3))=2，approve,approve,request_changes → approvals 2≥2，若不显式阻断会 ok=true 盖章。
  it('P1-1：3 reviewer 中 1 个 request_changes（其余 approve 满足 quorum）→ 仍 ok=false（显式阻断，不被 approve 盖过）', () => {
    const errors = [];
    const pr = { ok: true, reviews: [mkReview('claude', 'approve', []), mkReview('gemini', 'approve', []), mkReview('m3', 'request_changes', [])] };
    const r = validateNoePostReview(errors, { postReview: pr, requiredReviewers: ['claude', 'gemini', 'm3'] });
    expect(r.ok).toBe(false);
    expect(errors.some((e) => e.includes('reviewer_requests_changes'))).toBe(true);
  });

  it('P1-1 反向：纯 approve 满足 quorum（无 request_changes）→ ok=true（不误伤正常通过）', () => {
    const errors = [];
    const pr = { ok: true, reviews: [mkReview('claude', 'approve', []), mkReview('gemini', 'approve', []), mkReview('m3', 'approve', [])] };
    const r = validateNoePostReview(errors, { postReview: pr, requiredReviewers: ['claude', 'gemini', 'm3'] });
    expect(r.ok).toBe(true);
  });
});
