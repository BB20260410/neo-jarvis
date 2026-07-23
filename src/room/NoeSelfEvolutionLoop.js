import { evaluateNoeSelfEvolutionGate } from './NoeSelfEvolutionGate.js';
import { nonImplementerApprovals } from './NoePostReviewGate.js';
import { normalizeConsensusDecision } from './NoeConsensusGate.js';
import { validateNoeImplementationExecutor } from './NoeExecutionAuthority.js';
import { evaluateNoeSelfEvolutionValueGate } from './NoeSelfEvolutionValueGate.js';
import { evaluateNoeSelfEvolutionSubstanceGate } from './NoeSelfEvolutionSubstanceGate.js';
import { describeSelfEvolutionBlocker } from './NoeSelfEvolutionHealthSnapshot.js';

// 与 cycle/gate 对齐：post-review 的「已批准数」按真实非实施者 reviewer 计，
// 排除 active executor 自评，兼容历史 numeric approvals 字段。
function loopPostReviewApprovals(input = {}) {
  const implementation = input.implementation || (input.ledger && input.ledger.implementation) || {};
  const activeExecutor = validateNoeImplementationExecutor({
    ...implementation,
    activeExecutor: implementation.activeExecutor || implementation.executor || implementation.writer || input.activeExecutor,
  }).activeExecutor || 'codex';
  const reviewApprovals = nonImplementerApprovals(input.postReview || {}, activeExecutor).length;
  return Math.max(Number(input.postReview?.approvals || 0), reviewApprovals);
}

function cleanString(value) {
  return String(value || '').trim();
}

function hasText(value) {
  return cleanString(value).length > 0;
}

function safeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  try { return JSON.parse(JSON.stringify(value)); } catch { return {}; }
}

function isDone(value) {
  if (value === true) return true;
  if (!value || typeof value !== 'object') return false;
  return value.ok === true || value.done === true || value.applied === true || value.status === 'done' || value.status === 'complete';
}

function retrospectiveRef(input = {}) {
  return cleanString(input.retrospectiveRef || input.retrospective?.ref || input.retrospective?.reportRef);
}

function memoryDone(input = {}) {
  return isDone(input.memoryWriteback);
}

// Step3 返工信号：reviewer 明确 request_changes（要求改）/ reject（终拒）。
// request_changes = 可返工（清证据携 blocker 回 implementation）；reject = 优先走 Step2 失败学习，不返工。
function postReviewDecisions(postReview = {}) {
  // FINDING1：用 normalizeConsensusDecision 统一口径（兼容本地模型输出的 Request_Changes/request-changes/REJECTED 等变体），
  //   与 gate 同一真相源——否则严格匹配会让变体 decision 静默漏判，返工/学习不触发。
  return Array.isArray(postReview.reviews)
    ? postReview.reviews.map((r) => normalizeConsensusDecision(r && r.decision))
    : [];
}
function hasRequestChangesSignal(postReview = {}) {
  return postReviewDecisions(postReview).includes('request_changes');
}
function hasRejectSignal(postReview = {}) {
  return postReviewDecisions(postReview).includes('reject');
}
// 收集 request_changes reviewer 列出的 blocker / evidence_gaps（截断防超长）。loop 纯函数不脱敏——
// 真正落库/入日志前由 trigger 层用 redactSensitiveText 脱敏（见 C 步）。
function collectReworkBlockers(postReview = {}) {
  if (!Array.isArray(postReview.reviews)) return [];
  const out = [];
  for (const r of postReview.reviews) {
    if (!r || normalizeConsensusDecision(r.decision) !== 'request_changes') continue;
    // P1-2：合并 evidence_gaps + blockers（不二选一）——reviewer 两个字段都可能列要改的点，二选一会吞掉另一个。
    const gaps = [
      ...(Array.isArray(r.evidence_gaps) ? r.evidence_gaps : []),
      ...(Array.isArray(r.blockers) ? r.blockers : []),
    ];
    for (const g of gaps) { const s = cleanString(g); if (s) out.push(s.slice(0, 200)); }
  }
  return out.slice(0, 12);
}

function gateInput(input = {}, action, extra = {}) {
  const out = {
    ...safeObject(input),
    action,
    consensus: input.consensus,
    ledger: input.ledger,
    authorization: safeObject(input.authorization),
    rollback: safeObject(input.rollback),
    runtimeVerification: safeObject(input.runtimeVerification),
    postReview: safeObject(input.postReview),
    memoryWriteback: safeObject(input.memoryWriteback),
    requestedCapabilities: Array.isArray(input.requestedCapabilities) ? [...input.requestedCapabilities] : [],
    hardVetoes: Array.isArray(input.hardVetoes) ? [...input.hardVetoes] : [],
    ...extra,
  };
  if (retrospectiveRef(input)) out.retrospectiveRef = retrospectiveRef(input);
  return out;
}

function checkGate(input, action, extra) {
  const check = evaluateNoeSelfEvolutionGate(gateInput(input, action, extra));
  return {
    action,
    ok: check.ok,
    errors: check.errors,
    warnings: check.warnings,
    gates: check.gates,
  };
}

function result({ stage, nextAction, ok = false, blocked = false, gates, errors = [], warnings = [], evidence = {} }) {
  return {
    ok,
    stage,
    nextAction,
    blocked,
    errors,
    warnings,
    evidence,
    gates,
  };
}

function attachProgressBlocker(state, input = {}) {
  return {
    ...state,
    progressBlocker: describeSelfEvolutionBlocker(state, {
      hasConsensusAutodrive: input.hasConsensusAutodrive === true,
      hasCompletionAutodrive: input.hasCompletionAutodrive === true,
      reworkEnabled: input.reworkEnabled === true,
    }),
  };
}

export function evaluateNoeSelfEvolutionLoop(input = {}) {
  return attachProgressBlocker(evaluateNoeSelfEvolutionLoopCore(input), input);
}

function evaluateNoeSelfEvolutionLoopCore(input = {}) {
  const implementationGate = checkGate(input, 'implementation');
  const warnings = [...implementationGate.warnings];
  const evidence = {
    goal: cleanString(input.goal),
    retrospectiveRef: retrospectiveRef(input),
    runtimeReportRef: cleanString(input.runtimeVerification?.reportRef),
    memorySummaryRef: cleanString(input.memoryWriteback?.summaryRef),
  };

  if (!implementationGate.gates.consensus) {
    return result({
      stage: 'consensus_blocked',
      nextAction: 'refresh_four_model_consensus',
      blocked: true,
      gates: { implementation: implementationGate },
      errors: implementationGate.errors,
      warnings,
      evidence,
    });
  }

  if (!implementationGate.ok) {
    return result({
      stage: 'implementation_blocked',
      nextAction: 'fix_implementation_gate_inputs',
      blocked: true,
      gates: { implementation: implementationGate },
      errors: implementationGate.errors,
      warnings,
      evidence,
    });
  }

  if (!isDone(input.implementation)) {
    return result({
      stage: 'implementation_ready',
      nextAction: 'codex_minimal_implementation',
      gates: { implementation: implementationGate },
      warnings,
      evidence,
    });
  }

  const runtime = input.runtimeVerification || {};
  if (runtime.ok !== true) {
    if (runtime.ok === false) {
      const selfRepairGate = checkGate(input, 'self_repair', {
        failedVerificationRef: input.failedVerificationRef || runtime.reportRef,
        repairReturnsToConsensus: input.repairReturnsToConsensus,
      });
      return result({
        stage: selfRepairGate.ok ? 'self_repair_ready' : 'self_repair_blocked',
        nextAction: selfRepairGate.ok ? 'return_to_consensus_for_repair' : 'fix_self_repair_gate_inputs',
        blocked: !selfRepairGate.ok,
        gates: { implementation: implementationGate, selfRepair: selfRepairGate },
        errors: selfRepairGate.ok ? [] : selfRepairGate.errors,
        warnings: [...warnings, ...selfRepairGate.warnings],
        evidence,
      });
    }
    return result({
      stage: 'runtime_verification_required',
      nextAction: 'run_targeted_runtime_verification',
      gates: { implementation: implementationGate },
      warnings,
      evidence,
    });
  }

  const postReview = input.postReview || {};
  if (postReview.ok !== true || loopPostReviewApprovals(input) < 1) {
    // Step3 返工（flag NOE_SELFEVO_REWORK，trigger 透传 reworkEnabled；默认 OFF）：reviewer 列 request_changes
    //   （非 reject）且返工未超限时，不卡死/不占坑——返回 rework_ready，由 trigger 清证据回 implementation 携 blocker 重做。
    //   含 reject 优先走 Step2 失败学习（不返工）；返工超限交 trigger 转 terminal。OFF / 无信号 / 超限时逐字零回归。
    const reworkRounds = Number(input.reworkRounds || 0);
    const maxReworkRounds = Number(input.maxReworkRounds || 0);
    if (
      input.reworkEnabled === true &&
      hasRequestChangesSignal(postReview) &&
      !hasRejectSignal(postReview) &&
      reworkRounds < maxReworkRounds
    ) {
      return result({
        stage: 'post_review_rework_ready',
        nextAction: 'rework_implementation_with_reviewer_blockers',
        blocked: false,
        gates: { implementation: implementationGate },
        warnings,
        evidence: {
          ...evidence,
          reworkRounds,
          maxReworkRounds,
          postReviewBlockers: collectReworkBlockers(postReview),
        },
      });
    }
    const completeGate = checkGate(input, 'complete');
    return result({
      stage: 'post_review_required',
      nextAction: 'request_non_implementer_post_review',
      blocked: true,
      gates: { implementation: implementationGate, complete: completeGate },
      errors: completeGate.errors.filter((error) => /post_review|non_implementer/.test(error)),
      warnings: [...warnings, ...completeGate.warnings],
      evidence,
    });
  }

  if (!hasText(retrospectiveRef(input))) {
    return result({
      stage: 'retrospective_required',
      nextAction: 'write_collaboration_retrospective',
      blocked: true,
      gates: { implementation: implementationGate },
      errors: ['retrospective_ref_required'],
      warnings,
      evidence,
    });
  }

  if (!memoryDone(input)) {
    const memoryGate = checkGate(input, 'memory_writeback');
    return result({
      stage: memoryGate.ok ? 'memory_writeback_ready' : 'memory_writeback_blocked',
      nextAction: memoryGate.ok ? 'write_confirmed_memory_summary' : 'fix_memory_writeback_gate_inputs',
      blocked: !memoryGate.ok,
      gates: { implementation: implementationGate, memoryWriteback: memoryGate },
      errors: memoryGate.ok ? [] : memoryGate.errors,
      warnings: [...warnings, ...memoryGate.warnings],
      evidence,
    });
  }

  // P0 第七道叠加只读价值闸（flag NOE_SELFEVO_VALUE_GATE 门控，默认 OFF）：六闸全过、即将 complete 前，
  //   只读校验改动真有价值(引用性)——堵零引用孤儿盖章 complete。不改任何已有闸/授权链；OFF 时 skipped 零回归。
  const valueGate = evaluateNoeSelfEvolutionValueGate(input, input.valueGateOptions || {});
  if (!valueGate.skipped && !valueGate.ok) {
    return result({
      stage: 'value_gate_blocked',
      nextAction: 'prove_change_value_or_reference',
      blocked: true,
      gates: { implementation: implementationGate, valueGate },
      errors: valueGate.errors,
      warnings,
      evidence,
    });
  }

  // 第八道叠加实质闸（flag NOE_SELFEVO_SUBSTANCE_GATE 默认 OFF）：盖章前堵"自指/零外部价值"——空改动 / 纯自指
  //   技能卡仪式 / 临时产物（造 ValueError 日志截图），真拦 complete。owner 拍板的假进化最小真拦，与引用性闸互补
  //   （它管 src/.js 零引用孤儿，本闸管空 touchedFiles + 纯自指文档/临时产物）。OFF 时 skipped 零回归，不改已有闸/授权链。
  const substanceGate = evaluateNoeSelfEvolutionSubstanceGate(input, input.substanceGateOptions || {});
  if (!substanceGate.skipped && !substanceGate.ok) {
    return result({
      stage: 'substance_gate_blocked',
      nextAction: 'prove_external_value_or_drop',
      blocked: true,
      gates: { implementation: implementationGate, substanceGate },
      errors: substanceGate.errors,
      warnings,
      evidence,
    });
  }

  const completeGate = checkGate(input, 'complete');
  return result({
    ok: completeGate.ok,
    stage: completeGate.ok ? 'complete' : 'complete_blocked',
    nextAction: completeGate.ok ? 'handoff_or_continue_next_goal' : 'fix_completion_gate_inputs',
    blocked: !completeGate.ok,
    gates: { implementation: implementationGate, complete: completeGate },
    errors: completeGate.ok ? [] : completeGate.errors,
    warnings: [...warnings, ...completeGate.warnings],
    evidence,
  });
}

export function buildNoeSelfEvolutionLoopPlan(input = {}) {
  const state = evaluateNoeSelfEvolutionLoop(input);
  const consensusDone = state.gates?.implementation?.gates?.consensus === true;
  const memoryReady = memoryDone(input) || state.stage === 'memory_writeback_ready';
  const steps = [
    { id: 'consensus', done: consensusDone, required: true },
    { id: 'implementation', done: isDone(input.implementation), required: true },
    { id: 'runtime_verification', done: input.runtimeVerification?.ok === true, required: true },
    { id: 'self_repair', done: input.runtimeVerification?.ok !== false, required: input.runtimeVerification?.ok === false },
    { id: 'post_review', done: input.postReview?.ok === true && loopPostReviewApprovals(input) >= 1, required: true },
    { id: 'retrospective', done: hasText(retrospectiveRef(input)), required: true },
    { id: 'memory_writeback', done: memoryDone(input), ready: memoryReady, required: true },
  ];
  return { ...state, steps };
}
