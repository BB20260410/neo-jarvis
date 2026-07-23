import { describe, expect, it } from 'vitest';
import {
  buildNoeSelfEvolutionLoopPlan,
  evaluateNoeSelfEvolutionLoop,
} from '../../src/room/NoeSelfEvolutionLoop.js';
import { buildNoeConsensusLedger } from '../../src/room/NoeConsensusLedger.js';

function vote(model, evidenceRef) {
  return {
    model,
    decision: 'approve_with_changes',
    authority: model === 'm3' ? 'suggestion_only' : model === 'codex' ? 'writer_integrator' : 'advisory',
    canWrite: model === 'codex',
    firstClass: model === 'claude' ? true : undefined,
    consensusVote: 'yes',
    recommendedFirstSlice: ['first safe slice'],
    verificationRequired: ['focused verification'],
    rawOutputRef: `output/noe-multimodel/round/${model}.txt`,
    evidenceRef,
  };
}

function passedLedger() {
  const evidenceRef = 'output/noe-multimodel/round/brief.md';
  return buildNoeConsensusLedger({
    roundId: 'round-a',
    goal: 'Noe self evolution loop',
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

// codex 是 active executor，必需非实施者 reviewer = claude/m3。
// 默认 claude+m3 approve = 动态 quorum 2/2 通过。
function postReviews({ unavailable = [], approvals = ['claude', 'm3'] } = {}) {
  const unavailableSet = new Set(unavailable);
  const approvalSet = new Set(approvals);
  return ['claude', 'm3'].map((model) => ({
    model,
    decision: unavailableSet.has(model) ? 'unavailable' : approvalSet.has(model) ? 'approve' : 'reject',
    authority: model === 'm3' ? 'suggestion_only' : 'readonly_source_reviewer',
    canWrite: false,
    rawOutputRef: `output/noe-multimodel/round/${model}-post-review.txt`,
  }));
}

function passingPostReview() {
  return { ok: true, reviews: postReviews() };
}

function baseLoop(overrides = {}) {
  return {
    goal: 'Noe self-evolution loop',
    // 单测验证 loop 阶段路由逻辑，不验证磁盘证据 => dry-run 跳过内联 ledger / 复核 rawOutputRef 文件存在性。
    dryRun: true,
    ledger: passedLedger(),
    authorization: {
      userApproved: true,
      scope: 'closed-loop slice',
      costClass: 'local_or_user_approved_model_calls',
    },
    rollback: { planRef: 'output/noe-multimodel/round/rollback.md' },
    ...overrides,
  };
}

describe('Noe self-evolution loop', () => {
  it('returns implementation_ready after consensus, authorization, and rollback pass', () => {
    const result = evaluateNoeSelfEvolutionLoop(baseLoop());

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('implementation_ready');
    expect(result.nextAction).toBe('codex_minimal_implementation');
    expect(result.gates.implementation.ok).toBe(true);
  });

  it('blocks spoofed consensus before implementation can start', () => {
    const result = evaluateNoeSelfEvolutionLoop(baseLoop({
      ledger: undefined,
      consensus: { ok: true, errors: [], warnings: [], consensus: { approvedCount: 3, threshold: 2 } },
      authorization: {
        userApproved: false,
        consensusApproved: true,
        scope: 'spoofed consensus',
        costClass: 'local_or_user_approved_model_calls',
      },
    }));

    expect(result.stage).toBe('implementation_blocked');
    expect(result.blocked).toBe(true);
    expect(result.errors).toContain('user_or_consensus_authorization_required');
  });

  it('routes failed runtime verification into a repair gate that must return to consensus', () => {
    const result = evaluateNoeSelfEvolutionLoop(baseLoop({
      implementation: { done: true },
      runtimeVerification: { ok: false, reportRef: 'output/noe-full-current/failed.json' },
      failedVerificationRef: 'output/noe-full-current/failed.json',
      repairReturnsToConsensus: true,
    }));

    expect(result.stage).toBe('self_repair_ready');
    expect(result.nextAction).toBe('return_to_consensus_for_repair');
    expect(result.gates.selfRepair.ok).toBe(true);
  });

  it('requires runtime verification before post-review and memory writeback', () => {
    const result = evaluateNoeSelfEvolutionLoop(baseLoop({
      implementation: { done: true },
    }));

    expect(result.stage).toBe('runtime_verification_required');
    expect(result.nextAction).toBe('run_targeted_runtime_verification');
  });

  it('requires non-implementer post-review after runtime verification passes', () => {
    const result = evaluateNoeSelfEvolutionLoop(baseLoop({
      implementation: { done: true },
      runtimeVerification: { ok: true, reportRef: 'output/noe-full-current/pass.json' },
    }));

    expect(result.stage).toBe('post_review_required');
    expect(result.blocked).toBe(true);
    expect(result.errors).toContain('post_review_required');
    // 对齐 cycle 层后，缺真实非实施者复核表现为必需 reviewer 缺失
    expect(result.errors).toContain('post_review_missing_required_reviewer:claude');
  });

  it('requires a retrospective reference before memory writeback can complete the loop', () => {
    const result = evaluateNoeSelfEvolutionLoop(baseLoop({
      implementation: { done: true },
      runtimeVerification: { ok: true, reportRef: 'output/noe-full-current/pass.json' },
      postReview: passingPostReview(),
    }));

    expect(result.stage).toBe('retrospective_required');
    expect(result.errors).toContain('retrospective_ref_required');
  });

  it('marks memory writeback ready when ack and summary exist but writeback is not done', () => {
    const result = evaluateNoeSelfEvolutionLoop(baseLoop({
      implementation: { done: true },
      runtimeVerification: { ok: true, reportRef: 'output/noe-full-current/pass.json' },
      postReview: passingPostReview(),
      retrospectiveRef: 'docs/Noe四模型协作复盘与改进计划_2026-06-07.md',
      memoryWriteback: {
        consensusAck: true,
        summaryRef: 'docs/HANDOFF_2026-06-06_codex交接.md',
      },
    }));

    expect(result.stage).toBe('memory_writeback_ready');
    expect(result.nextAction).toBe('write_confirmed_memory_summary');
    expect(result.gates.memoryWriteback.ok).toBe(true);
  });

  it('reaches complete only after post-review, retrospective, and memory writeback are done', () => {
    const result = evaluateNoeSelfEvolutionLoop(baseLoop({
      implementation: { done: true },
      runtimeVerification: { ok: true, reportRef: 'output/noe-full-current/pass.json' },
      postReview: passingPostReview(),
      retrospectiveRef: 'docs/Noe四模型协作复盘与改进计划_2026-06-07.md',
      memoryWriteback: {
        done: true,
        consensusAck: true,
        summaryRef: 'docs/HANDOFF_2026-06-06_codex交接.md',
      },
    }));

    expect(result.ok).toBe(true);
    expect(result.stage).toBe('complete');
    expect(result.gates.complete.ok).toBe(true);
  });

  it('builds a checklist that exposes incomplete loop stages', () => {
    const plan = buildNoeSelfEvolutionLoopPlan(baseLoop({
      implementation: { done: true },
      runtimeVerification: { ok: true, reportRef: 'output/noe-full-current/pass.json' },
      postReview: passingPostReview(),
      retrospectiveRef: 'docs/Noe四模型协作复盘与改进计划_2026-06-07.md',
      memoryWriteback: {
        consensusAck: true,
        summaryRef: 'docs/HANDOFF_2026-06-06_codex交接.md',
      },
    }));

    expect(plan.stage).toBe('memory_writeback_ready');
    expect(plan.steps.find((step) => step.id === 'memory_writeback')).toMatchObject({
      done: false,
      ready: true,
      required: true,
    });
  });

  it('does not mark memory writeback ready when consensus is not backed by a ledger', () => {
    const plan = buildNoeSelfEvolutionLoopPlan(baseLoop({
      ledger: undefined,
      consensus: { ok: true, errors: [], warnings: [], consensus: { approvedCount: 3, threshold: 2 } },
      implementation: { done: true },
      runtimeVerification: { ok: true, reportRef: 'output/noe-full-current/pass.json' },
      postReview: passingPostReview(),
      retrospectiveRef: 'docs/Noe四模型协作复盘与改进计划_2026-06-07.md',
      memoryWriteback: {
        consensusAck: true,
        summaryRef: 'docs/HANDOFF_2026-06-06_codex交接.md',
      },
    }));

    expect(plan.stage).toBe('implementation_blocked');
    expect(plan.errors).toContain('validated_consensus_ledger_required');
    expect(plan.steps.find((step) => step.id === 'memory_writeback')).toMatchObject({
      done: false,
      ready: false,
      required: true,
    });
  });

  // P0 真实价值闸（第七道叠加只读闸）——flag NOE_SELFEVO_VALUE_GATE 门控，默认 OFF；只读、只判定。
  it('价值闸 ON + 改动是零引用孤儿 → value_gate_blocked（堵孤儿走完 complete）', () => {
    const r = evaluateNoeSelfEvolutionLoop(baseLoop({
      implementation: { done: true, touchedFiles: ['src/util/NoeEvolutionMilestone.js'] },
      runtimeVerification: { ok: true, reportRef: 'output/noe-full-current/pass.json' },
      postReview: passingPostReview(),
      retrospectiveRef: 'docs/Noe四模型协作复盘与改进计划_2026-06-07.md',
      memoryWriteback: { done: true, consensusAck: true, summaryRef: 'docs/HANDOFF_2026-06-06_codex交接.md' },
      valueGateOptions: { enabled: true, referenceProbe: () => ({ referenced: false }) },
    }));
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('value_gate_blocked');
    expect(r.errors.some((e) => String(e).startsWith('orphan_no_reference'))).toBe(true);
  });

  it('价值闸 ON + 改动被全仓引用（真改进）→ 仍可 complete', () => {
    const r = evaluateNoeSelfEvolutionLoop(baseLoop({
      implementation: { done: true, touchedFiles: ['src/util/RealHelper.js'] },
      runtimeVerification: { ok: true, reportRef: 'output/noe-full-current/pass.json' },
      postReview: passingPostReview(),
      retrospectiveRef: 'docs/Noe四模型协作复盘与改进计划_2026-06-07.md',
      memoryWriteback: { done: true, consensusAck: true, summaryRef: 'docs/HANDOFF_2026-06-06_codex交接.md' },
      valueGateOptions: { enabled: true, referenceProbe: () => ({ referenced: true }) },
    }));
    expect(r.ok).toBe(true);
    expect(r.stage).toBe('complete');
  });

  it('价值闸 OFF（默认）→ 不介入，complete 行为逐字零回归', () => {
    const r = evaluateNoeSelfEvolutionLoop(baseLoop({
      implementation: { done: true, touchedFiles: ['src/util/NoeEvolutionMilestone.js'] },
      runtimeVerification: { ok: true, reportRef: 'output/noe-full-current/pass.json' },
      postReview: passingPostReview(),
      retrospectiveRef: 'docs/Noe四模型协作复盘与改进计划_2026-06-07.md',
      memoryWriteback: { done: true, consensusAck: true, summaryRef: 'docs/HANDOFF_2026-06-06_codex交接.md' },
      valueGateOptions: { enabled: false, referenceProbe: () => ({ referenced: false }) },
    }));
    expect(r.stage).toBe('complete');
  });

  // 第八道叠加实质闸（flag NOE_SELFEVO_SUBSTANCE_GATE 默认 OFF）——owner 拍板的假进化最小真拦：盖章前堵
  //   "自指/零外部价值"（空改动 / 纯自指技能卡 / 临时产物）。与引用性闸互补，显式关 value gate 隔离测本闸。
  const substanceBase = {
    runtimeVerification: { ok: true, reportRef: 'output/noe-full-current/pass.json' },
    postReview: passingPostReview(),
    retrospectiveRef: 'docs/Noe四模型协作复盘与改进计划_2026-06-07.md',
    memoryWriteback: { done: true, consensusAck: true, summaryRef: 'docs/HANDOFF_2026-06-06_codex交接.md' },
    valueGateOptions: { enabled: false },
  };

  it('实质闸 ON + 纯 docs/skill-cards 技能卡（生产实锤）→ substance_gate_blocked', () => {
    const r = evaluateNoeSelfEvolutionLoop(baseLoop({
      ...substanceBase,
      implementation: { done: true, touchedFiles: ['docs/skill-cards/voice-link-self-repair.md'] },
      substanceGateOptions: { enabled: true },
    }));
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('substance_gate_blocked');
    expect(r.errors.some((e) => String(e).startsWith('self_referential_only'))).toBe(true);
  });

  it('实质闸 ON + 空 touchedFiles（啥没改还想盖章）→ substance_gate_blocked', () => {
    const r = evaluateNoeSelfEvolutionLoop(baseLoop({
      ...substanceBase,
      implementation: { done: true, touchedFiles: [] },
      substanceGateOptions: { enabled: true },
    }));
    expect(r.stage).toBe('substance_gate_blocked');
    expect(r.errors.some((e) => String(e).includes('no_substantive_change'))).toBe(true);
  });

  it('实质闸 ON + 真实 src/.js 功能改动 → 仍可 complete（不误伤真进化）', () => {
    const r = evaluateNoeSelfEvolutionLoop(baseLoop({
      ...substanceBase,
      implementation: { done: true, touchedFiles: ['src/runtime/NoeContentRedaction.js'] },
      substanceGateOptions: { enabled: true },
    }));
    expect(r.ok).toBe(true);
    expect(r.stage).toBe('complete');
  });

  it('实质闸 OFF（默认）→ 不介入，纯技能卡也照样 complete（逐字零回归）', () => {
    const r = evaluateNoeSelfEvolutionLoop(baseLoop({
      ...substanceBase,
      implementation: { done: true, touchedFiles: ['docs/skill-cards/voice-link-self-repair.md'] },
      substanceGateOptions: { enabled: false },
    }));
    expect(r.stage).toBe('complete');
  });
});

// Step3 返工：post_review 列 request_changes（非 reject）时，flag ON 下不卡死/不占坑，
// 返回 post_review_rework_ready（blocked:false）让 trigger 清证据回 implementation 携 blocker 重做。
// flag OFF 逐字零回归；含 reject 优先走 Step2 学习；返工超限交 trigger 转 terminal。
describe('Step3 post_review request_changes → 返工 ready（NOE_SELFEVO_REWORK）', () => {
  function reworkBase(overrides = {}) {
    return baseLoop({
      implementation: { done: true },
      runtimeVerification: { ok: true, reportRef: 'output/noe-full-current/pass.json' },
      postReview: {
        ok: false,
        reviews: [
          { model: 'm3', decision: 'request_changes', authority: 'suggestion_only', canWrite: false, rawOutputRef: 'output/r/m3.txt' },
          { model: 'claude', decision: 'approve', authority: 'readonly_source_reviewer', canWrite: false, rawOutputRef: 'output/r/claude.txt' },
        ],
      },
      ...overrides,
    });
  }

  it('flag ON + request_changes + 未超限 → post_review_rework_ready（不 blocked）', () => {
    const r = evaluateNoeSelfEvolutionLoop(reworkBase({ reworkEnabled: true, reworkRounds: 0, maxReworkRounds: 2 }));
    expect(r.stage).toBe('post_review_rework_ready');
    expect(r.blocked).toBe(false);
    expect(r.nextAction).toBe('rework_implementation_with_reviewer_blockers');
  });

  it('反向：flag OFF（默认）+ request_changes → 仍 post_review_required（逐字零回归）', () => {
    const r = evaluateNoeSelfEvolutionLoop(reworkBase({ reworkRounds: 0, maxReworkRounds: 2 }));
    expect(r.stage).toBe('post_review_required');
    expect(r.blocked).toBe(true);
  });

  it('反向：flag ON + 含 reject（即便也有 request_changes）→ 不返工（reject 优先 Step2 学习）', () => {
    const r = evaluateNoeSelfEvolutionLoop(reworkBase({
      reworkEnabled: true, reworkRounds: 0, maxReworkRounds: 2,
      postReview: { ok: false, reviews: [
        { model: 'm3', decision: 'reject', authority: 'suggestion_only', canWrite: false, rawOutputRef: 'output/r/m3.txt' },
        { model: 'claude', decision: 'request_changes', authority: 'readonly_source_reviewer', canWrite: false, rawOutputRef: 'output/r/claude.txt' },
      ] },
    }));
    expect(r.stage).toBe('post_review_required');
  });

  it('反向：flag ON + request_changes + 返工已达上限(rounds>=max) → 不返工（交 trigger 转 terminal）', () => {
    const r = evaluateNoeSelfEvolutionLoop(reworkBase({ reworkEnabled: true, reworkRounds: 2, maxReworkRounds: 2 }));
    expect(r.stage).toBe('post_review_required');
  });

  it('反向：flag ON + 无 request_changes（abstain 致 approval 不足）→ 不返工', () => {
    const r = evaluateNoeSelfEvolutionLoop(reworkBase({
      reworkEnabled: true, reworkRounds: 0, maxReworkRounds: 2,
      postReview: { ok: false, reviews: [
        { model: 'm3', decision: 'abstain', authority: 'suggestion_only', canWrite: false, rawOutputRef: 'output/r/m3.txt' },
        { model: 'claude', decision: 'abstain', authority: 'readonly_source_reviewer', canWrite: false, rawOutputRef: 'output/r/claude.txt' },
      ] },
    }));
    expect(r.stage).toBe('post_review_required');
  });

  it('FINDING1：request_changes 连字符变体(request-changes) → 仍算 rework_ready（normalize 口径，不因本地模型大小写/连字符变体静默失效）', () => {
    const r = evaluateNoeSelfEvolutionLoop(reworkBase({
      reworkEnabled: true, reworkRounds: 0, maxReworkRounds: 2,
      postReview: { ok: false, reviews: [
        { model: 'm3', decision: 'request-changes', authority: 'suggestion_only', canWrite: false, rawOutputRef: 'output/r/m3.txt' },
        { model: 'claude', decision: 'approve', authority: 'readonly_source_reviewer', canWrite: false, rawOutputRef: 'output/r/claude.txt' },
      ] },
    }));
    expect(r.stage).toBe('post_review_rework_ready');
  });

  it('FINDING1：reject 大写变体(REJECT) 同时存在 → 优先不返工（normalize 后 reject 仍被识别，走学习路径）', () => {
    const r = evaluateNoeSelfEvolutionLoop(reworkBase({
      reworkEnabled: true, reworkRounds: 0, maxReworkRounds: 2,
      postReview: { ok: false, reviews: [
        { model: 'm3', decision: 'REJECT', authority: 'suggestion_only', canWrite: false, rawOutputRef: 'output/r/m3.txt' },
        { model: 'claude', decision: 'request_changes', authority: 'readonly_source_reviewer', canWrite: false, rawOutputRef: 'output/r/claude.txt' },
      ] },
    }));
    expect(r.stage).toBe('post_review_required'); // 有 reject（变体）→ 不返工
  });
});
