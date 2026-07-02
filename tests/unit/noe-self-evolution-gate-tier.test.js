// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { evaluateNoeSelfEvolutionGate } from '../../src/room/NoeSelfEvolutionGate.js';
import { buildNoeConsensusLedger } from '../../src/room/NoeConsensusLedger.js';

// 自进化门「P3 绿档自驱（green-tier 授权）+ 完成门（post-review / retrospective / reviewTier 渐进放松）」专项。
// 从 noe-self-evolution-gate.test.js 拆出，控制单文件 < 500 行（plan-verify 的 evolution_gate_test_under_500_lines 闸）。
// 核心 gate / capability 矩阵 / spoof / ledger-file / escape 防御仍在原文件。

function vote(model, evidenceRef, extra = {}) {
  const decision = extra.decision || 'approve_with_changes';
  const approval = decision === 'approve' || decision === 'approve_with_changes';
  return {
    model,
    decision,
    authority: model === 'm3' ? 'suggestion_only' : model === 'codex' ? 'writer_integrator' : 'advisory',
    canWrite: model === 'codex',
    firstClass: model === 'claude' ? true : undefined,
    consensusVote: approval ? 'yes' : 'abstain',
    recommendedFirstSlice: decision === 'approve_with_changes' ? ['first safe slice'] : [],
    verificationRequired: approval ? ['focused verification'] : [],
    rawOutputRef: `output/noe-multimodel/round/${model}.txt`,
    evidenceRef,
    ...extra,
  };
}

function passedLedger() {
  const evidenceRef = 'output/noe-multimodel/round/brief.md';
  return buildNoeConsensusLedger({
    roundId: 'round-a',
    goal: 'Noe self evolution gate',
    evidenceRef,
    votes: ['codex', 'claude', 'm3'].map((model) => vote(model, evidenceRef)),
    implementation: {
      writer: 'codex',
      authorizationRequired: true,
      runtimeVerificationRequired: true,
      rollbackRequired: true,
      memoryWritebackAckRequired: true,
    },
  }, { createdAt: '2026-06-07T00:00:00.000Z' });
}

function baseInput(action = 'implementation') {
  return {
    action,
    // 单测验证授权分支逻辑，不验证磁盘证据 => 走 dry-run，跳过内联 ledger / 复核 rawOutputRef 文件存在性。
    dryRun: true,
    ledger: passedLedger(),
    authorization: { userApproved: true, scope: 'consensus first slice', costClass: 'local_or_user_approved_model_calls' },
    rollback: { planRef: 'output/noe-multimodel/round/rollback.md' },
  };
}

function postReview(model, decision = 'approve', extra = {}) {
  return {
    model, decision,
    authority: model === 'm3' ? 'suggestion_only' : 'readonly_source_reviewer',
    canWrite: false,
    rawOutputRef: `output/noe-multimodel/round/${model}-post-review.txt`,
    ...extra,
  };
}

function validPostReviews({ unavailable = [], approvals = ['claude', 'm3'], extraByModel = {} } = {}) {
  const unavailableSet = new Set(unavailable);
  const approvalSet = new Set(approvals);
  return ['claude', 'm3'].map((model) => {
    const extra = extraByModel[model] || {};
    if (unavailableSet.has(model)) return postReview(model, 'unavailable', extra);
    return postReview(model, approvalSet.has(model) ? 'approve' : 'reject', extra);
  });
}

describe('Noe self evolution gate · P3 绿档自驱与完成门', () => {
  it('P3.2 green-tier autonomy replaces owner approval (consensus ledger still required)', () => {
    const input = baseInput();
    input.authorization.userApproved = false;
    input.authorization.greenTierApproved = true; // 模拟 ActGuard 从事实 patch plan 算出 green（Gate 层只读此布尔）
    const result = evaluateNoeSelfEvolutionGate(input);
    expect(result.ok).toBe(true);
    expect(result.gates.greenTierAuthorization).toBe(true);
    expect(result.gates.authorization).toBe(true);
    expect(result.errors).not.toContain('user_or_consensus_authorization_required');
  });

  it('P3.2 green-tier autonomy still requires validated consensus ledger (省 owner 但留共识)', () => {
    const input = baseInput();
    input.authorization.userApproved = false;
    input.authorization.greenTierApproved = true;
    input.ledger = undefined; // 无共识 ledger
    const result = evaluateNoeSelfEvolutionGate(input);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('validated_consensus_ledger_required');
  });

  it('P3.2 green-tier autonomy still requires rollback (硬约束保留，green 不豁免)', () => {
    const input = baseInput();
    input.authorization.userApproved = false;
    input.authorization.greenTierApproved = true;
    delete input.rollback; // 无 rollback
    const result = evaluateNoeSelfEvolutionGate(input);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('rollback_plan_required');
  });

  it('blocks completion without non-implementer post-review', () => {
    const result = evaluateNoeSelfEvolutionGate({
      ...baseInput('complete'),
      runtimeVerification: { ok: true, reportRef: 'output/noe-full-current/pass.json' },
      postReview: { ok: false, approvals: 0 },
      memoryWriteback: { userAck: true, summaryRef: 'docs/HANDOFF.md' },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('post_review_required');
    // 对齐 cycle 层后，「无真实非实施者复核」表现为必需 reviewer 全缺 + 可用模型不足
    expect(result.errors).toContain('post_review_missing_required_reviewer:claude');
    expect(result.errors).toContain('post_review_missing_required_reviewer:m3');
    expect(result.errors).toContain('post_review_insufficient_available_models:0');
  });

  it('requires a retrospective reference before marking self-evolution complete', () => {
    const result = evaluateNoeSelfEvolutionGate({
      ...baseInput('complete'),
      runtimeVerification: { ok: true, reportRef: 'output/noe-full-current/pass.json' },
      postReview: { ok: true, reviews: validPostReviews() },
      memoryWriteback: { consensusAck: true, summaryRef: 'docs/HANDOFF.md' },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('retrospective_ref_required');
    // 复核环节本身应通过，只缺 retrospective
    expect(result.gates.postReview).toBe(true);
  });

  it('allows completion after runtime verification, independent post-review quorum, retrospective, and memory ack', () => {
    const result = evaluateNoeSelfEvolutionGate({
      ...baseInput('complete'),
      runtimeVerification: { ok: true, reportRef: 'output/noe-full-current/pass.json' },
      postReview: { ok: true, reviews: validPostReviews() },
      retrospectiveRef: 'docs/Noe四模型协作复盘与改进计划_2026-06-07.md',
      memoryWriteback: { consensusAck: true, summaryRef: 'docs/HANDOFF.md' },
    });

    expect(result.ok).toBe(true);
    expect(result.gates.retrospective).toBe(true);
    expect(result.gates.postReview).toBe(true);
  });

  it('P3.1 green 后段 reviewTier.requirePostReview=false → 省 post_review（其他硬约束齐则仍 ok + warning）', () => {
    const result = evaluateNoeSelfEvolutionGate({
      ...baseInput('complete'),
      runtimeVerification: { ok: true, reportRef: 'output/noe-full-current/pass.json' },
      postReview: { ok: false, approvals: 0 }, // 故意缺复核
      retrospectiveRef: 'docs/retro.md',
      memoryWriteback: { consensusAck: true, summaryRef: 'docs/HANDOFF.md' },
      reviewTier: { tier: 'sample', requirePostReview: false }, // ActGuard 算出的 green 后段
    });
    expect(result.ok).toBe(true);
    expect(result.errors).not.toContain('post_review_required');
    expect(result.warnings.some((w) => w.startsWith('post_review_relaxed_by_tier'))).toBe(true);
  });

  it('P3.1 缺省 reviewTier（flag OFF）→ post_review 仍硬（零回归）', () => {
    const result = evaluateNoeSelfEvolutionGate({
      ...baseInput('complete'),
      runtimeVerification: { ok: true, reportRef: 'output/noe-full-current/pass.json' },
      postReview: { ok: false, approvals: 0 },
      retrospectiveRef: 'docs/retro.md',
      memoryWriteback: { consensusAck: true, summaryRef: 'docs/HANDOFF.md' },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('post_review_required');
  });

  it('P3.1 放松不连带豁免 retrospective（只放松 post_review，其余硬约束保留）', () => {
    const result = evaluateNoeSelfEvolutionGate({
      ...baseInput('complete'),
      runtimeVerification: { ok: true, reportRef: 'output/noe-full-current/pass.json' },
      postReview: { ok: false, approvals: 0 },
      memoryWriteback: { consensusAck: true, summaryRef: 'docs/HANDOFF.md' },
      reviewTier: { tier: 'sample', requirePostReview: false },
      // 缺 retrospectiveRef
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('retrospective_ref_required');
  });
});
