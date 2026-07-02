// @ts-check
// ActPipeline 的 preflight/policy/approval 检查组 —— 2026-06-11 从 ActPipeline.js 外提（500 行门），行为逐字不变。
// 各函数以 pipeline（ActPipeline 实例）为首参，仅通过其公开字段（budget/permission/approvalStore/execPolicy/
// policyAudit/logger/projectId/selfEvolutionRoot/contextSufficiency）工作；类内调用点形如 budgetPreflight(this, act, input)。
import { BudgetLimitExceededError } from '../budget/BudgetPolicyStore.js';
import { hasNoeSelfEvolutionConsensusAuthorization, extractNoeSelfEvolutionActContext } from './NoeSelfEvolutionActGuard.js';
import { DESTRUCTIVE_ACTIONS, riskNeedsApproval, safeObject, str } from './ActPipelineHelpers.js';

export function budgetPreflight(pipeline, act, input = {}) {
  try {
    const result = pipeline.budget?.preflight?.({
      projectId: act.projectId || pipeline.projectId,
      adapterId: 'noe-act-pipeline',
      taskId: act.id,
      estimateCalls: 1,
      estimateUSD: Math.max(0, Number(input.estimateUSD || act.costEstimateUsd) || 0),
      estimateTokens: Math.max(0, Number(input.estimateTokens) || 0),
    }) || { ok: true, warnings: [], blocked: [] };
    const blocked = Array.isArray(result.blocked) ? result.blocked : [];
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    if (blocked.length > 0 || result.ok === false) {
      return {
        ok: false,
        error: result.error || `budget blocked: ${blocked.map((item) => item?.metric || item?.id || 'policy').join(', ')}`,
        warnings,
        blocked,
      };
    }
    return { ok: true, warnings, blocked };
  } catch (e) {
    if (e instanceof BudgetLimitExceededError || e?.code === 'BUDGET_LIMIT_EXCEEDED') {
      return { ok: false, error: e.message || 'budget blocked', blocked: e.blocked || [] };
    }
    return { ok: false, error: e?.message || String(e) };
  }
}

export function permissionPreflight(pipeline, act, input = {}) {
  const target = {
    actId: act.id,
    title: act.title,
    action: act.action,
    dryRunOnly: true,
    ...(safeObject(input.target)),
  };
  const consensusAuthorizedSelfEvolution = hasNoeSelfEvolutionConsensusAuthorization({
    act,
    input,
    root: pipeline.selfEvolutionRoot,
  });
  // self_evolution act(自改自身代码)有专门的 self-evolution gate(ActPipeline 在 permission 之后调用)做
  // 完整授权裁决:user / consensus / standing grant + rollback / runtime / system_level / hardVetoes。permission
  // preflight 不重复拦截——识别为 self_evolution act 即放行,交给 gate(比 permission 更严,伪造/未授权/缺回滚都被 gate 拦)。
  // 否则 P0-1 高危化后这类 act 会被下方 riskNeedsApproval 卡在 approval,永远到不了 self-evolution gate。
  // codex post-review: 放行条件必须与 NoeSelfEvolutionActGuard 的 gate 适用条件同源(extractNoeSelfEvolutionActContext)，
  // 否则像 custom.self_evolution_proxy 这种 regex 命中但 ActGuard 不映射的 action 会双重绕过(过 permission 又跳 gate)。
  if (extractNoeSelfEvolutionActContext({ act, input }) !== null) {
    return {
      decision: 'allow',
      reason: 'self-evolution act deferred to dedicated self-evolution gate for authorization',
      target: { ...target, deferredToSelfEvolutionGate: true, consensusAuthorizedSelfEvolution },
    };
  }
  if (DESTRUCTIVE_ACTIONS.has(act.action) || input.destructive === true) {
    if (consensusAuthorizedSelfEvolution) {
      return {
        decision: 'allow',
        reason: 'dynamic model quorum authorized high-risk self-evolution act; self-evolution gate must still pass before execution',
        target: { ...target, consensusAuthorizedSelfEvolution: true },
      };
    }
    // capability 信任档解 L1 枷锁：显式 developer/unrestricted/yolo/.noetrust 才放行；
    //   default 档返回 defer → 落到下方原 blocked_safety（不配置时行为完全不变）。
    //   owner 已撤销旧的永久 deny，developer/unrestricted 可放行改安全栈/读密钥内容/外网出境。
    const policyDecision = evalExecPolicy(pipeline, act, input, target);
    if (policyDecision?.decision === 'allow') {
      return {
        decision: 'allow',
        viaPolicy: true,
        capability: policyDecision.capability,
        reason: policyDecision.reason,
        target: { ...target, execPolicy: policyDecision },
      };
    }
    if (policyDecision?.decision === 'ask') {
      return askWithApproval(pipeline, act, input, target, policyDecision.reason || 'capability policy requires confirmation', { execPolicy: policyDecision });
    }
    if (policyDecision?.decision === 'deny') {
      return { blockedSafety: true, decision: 'deny', viaPolicy: true, reason: policyDecision.reason, target: { ...target, execPolicy: policyDecision } };
    }
    return {
      blockedSafety: true,
      reason: `${act.action} is blocked in CE12 P0 dry-run pipeline`,
      target,
    };
  }
  if (riskNeedsApproval(act.riskLevel)) {
    if (consensusAuthorizedSelfEvolution) {
      return {
        decision: 'allow',
        reason: 'dynamic model quorum authorized sensitive self-evolution act; self-evolution gate must still pass before execution',
        target: { ...target, consensusAuthorizedSelfEvolution: true },
      };
    }
    const policyDecision = evalExecPolicy(pipeline, act, input, target);
    if (policyDecision?.decision === 'allow') {
      return {
        decision: 'allow',
        viaPolicy: true,
        capability: policyDecision.capability,
        reason: policyDecision.reason,
        target: { ...target, execPolicy: policyDecision },
      };
    }
    if (policyDecision?.decision === 'ask') {
      return askWithApproval(pipeline, act, input, target, policyDecision.reason || 'capability policy requires confirmation', { execPolicy: policyDecision });
    }
    if (policyDecision?.decision === 'deny') {
      return { blockedSafety: true, decision: 'deny', viaPolicy: true, reason: policyDecision.reason, target: { ...target, execPolicy: policyDecision } };
    }
    return askWithApproval(pipeline, act, input, target, 'sensitive act requires owner approval before any real execution');
  }
  const decision = pipeline.permission?.evaluatePermission?.({
    action: 'noe.act.dry_run',
    target,
    risk: 'low',
    actorType: 'system',
    actorId: 'noe-act-pipeline',
    details: { originalAction: act.action, p0DryRunOnly: true },
  });
  if (decision?.decision === 'deny') {
    return { blockedSafety: true, decision: 'deny', reason: decision.reason || 'permission denied', target, permissionDecision: decision };
  }
  if (decision?.decision === 'ask') {
    return { requiresApproval: true, decision: 'ask', approval: decision.approval || null, reason: decision.reason || 'approval required', target, permissionDecision: decision };
  }
  return { decision: decision?.decision || 'allow', reason: decision?.reason || 'dry-run act allowed', target, permissionDecision: decision || null };
}

export function contextSufficiencyPreflight(pipeline, act, input = {}) {
  const config = safeObject(input.contextSufficiency || input.context_sufficiency);
  const requiredContext = config.requiredContext || config.required_context || input.requiredContext || input.required_context || [];
  if (!Array.isArray(requiredContext) || requiredContext.length === 0) return null;
  if (config.result && typeof config.result === 'object') return safeObject(config.result);
  return pipeline.contextSufficiency({
    goal: input.goal || act.title,
    action: act.action,
    riskLevel: act.riskLevel,
    contextBundle: config.contextBundle || config.context_bundle || input.contextBundle || input.context_bundle || {},
    requiredContext,
    allowedSources: config.allowedSources || config.allowed_sources || input.allowedSources || input.allowed_sources || [],
    maxRounds: config.maxRounds || config.max_rounds || input.maxGatherRounds || input.max_gather_rounds || (act.riskLevel === 'low' ? 1 : 2),
    roundsUsed: config.roundsUsed || config.rounds_used || 0,
    gatheredEvidenceRefs: config.gatheredEvidenceRefs || config.gathered_evidence_refs || input.gatheredEvidenceRefs || input.gathered_evidence_refs || [],
  });
}

function approvedPermission(pipeline, act, input = {}, target = {}) {
  const approvalId = str(input.approvalId || input.approval_id || act.approvalId, 160);
  if (!approvalId) return null;
  const approval = pipeline.approvalStore?.getApproval?.(approvalId);
  if (!approval) {
    return { blockedSafety: true, decision: 'deny', reason: `approval not found: ${approvalId}`, target: { ...target, approvalId } };
  }
  if (approval.status !== 'approved') {
    return { requiresApproval: true, decision: 'ask', approval, reason: `approval is ${approval.status}`, target: { ...target, approvalId } };
  }
  const payloadAction = approval.payload?.action;
  if (payloadAction && payloadAction !== act.action) {
    return { blockedSafety: true, decision: 'deny', reason: `approval action mismatch: ${payloadAction} != ${act.action}`, target: { ...target, approvalId } };
  }
  return { decision: 'allow', reason: `approved by ${approvalId}`, approval, target: { ...target, approvalId } };
}

function askWithApproval(pipeline, act, input = {}, target = {}, reason = 'approval required', extra = {}) {
  const approved = approvedPermission(pipeline, act, input, target);
  if (approved) return approved;
  const approval = pipeline.approvalStore?.createApproval?.({
    type: 'manual',
    requesterType: 'system',
    requesterId: 'noe-act-pipeline',
    dedupeKey: `noe-act:${act.action}:${act.title}:${act.riskLevel}`,
    payload: {
      title: `Noe Act approval: ${act.title}`,
      action: act.action,
      target,
      risk: act.riskLevel,
      reason: 'Sensitive acts require owner approval; real execution also requires approvalId + realExecute:true.',
    },
  }) || null;
  return { requiresApproval: true, decision: 'ask', approval, reason, target: { ...target, ...extra } };
}

// 查 capability 信任档：无 execPolicy 时返回 null（调用方走原逻辑）。顺带写审计。
function evalExecPolicy(pipeline, act, input = {}, target = {}) {
  if (!pipeline.execPolicy) return null;
  let decision = null;
  try {
    decision = pipeline.execPolicy.evaluate({
      action: act.action,
      capability: input.capability || act.payload?.capability,
      target: input.target || act.payload || target,
      cwd: input.cwd || act.payload?.cwd || process.cwd(),
      sessionId: input.sessionId || act.payload?.sessionId,
    });
  } catch (e) {
    pipeline.logger?.warn?.('[noe-act] exec policy eval failed:', e?.message || e);
    return null;
  }
  recordPolicyAudit(pipeline, act, decision, target);
  return decision;
}

function recordPolicyAudit(pipeline, act, decision, target) {
  pipeline.policyAudit?.recordSafe?.({
    event: 'noe.act.policy',
    action: act.action,
    decision: decision?.decision,
    capability: decision?.capability,
    source: decision?.source,
    trustLevel: decision?.trustLevel,
    target,
    reason: decision?.reason,
    actor: 'noe-act-pipeline',
  });
}
