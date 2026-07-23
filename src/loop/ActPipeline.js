import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendEvent } from '../storage/SqliteStore.js';
import { ActStore } from './ActStore.js';
import { evaluateNoeSelfEvolutionActGuard } from './NoeSelfEvolutionActGuard.js';
import { evaluateNoeContextSufficiency } from '../context/NoeContextSufficiencyGatherer.js';
import { buildNoeActionEvidence } from '../runtime/NoeActionEvidence.js';
import { normalizeRisk, nowMs, safeObject, semanticContextFromFocusItems, str, titleFromContext } from './ActPipelineHelpers.js';
import { budgetPreflight, contextSufficiencyPreflight, permissionPreflight } from './ActPipelinePreflight.js';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

export const DEFAULT_NOE_SELF_EVOLUTION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// M3 修复：executor 的 stdout/stderr 可能含 secret（curl 响应体 / 脚本打印的 env/token）；写入持久事件
// 日志、acts.payload 与 WS 广播前先脱敏（证据路径 buildNoeActionEvidence 内部已脱敏，此处补齐另两条出口）。
function redactedExecutorResult(value) {
  try { return JSON.parse(redactSensitiveText(JSON.stringify(value))); }
  catch { return safeObject(value); }
}

export class ActPipeline {
  constructor({
    projectId = 'noe',
    store = new ActStore({ projectId }),
    budget = null,
    permission = null,
    approvalStore = null,
    executors = {},
    selfEvolutionGate = evaluateNoeSelfEvolutionActGuard,
    selfEvolutionRoot = DEFAULT_NOE_SELF_EVOLUTION_ROOT,
    contextSufficiency = evaluateNoeContextSufficiency,
    actionEvidenceBuilder = buildNoeActionEvidence,
    audit = null,
    execPolicy = null,
    policyAudit = null,
    broadcast = null,
    hangAlert = null,
    autoExecuteLowRisk = false,
    logger = console,
  } = {}) {
    this.projectId = str(projectId, 160) || 'noe';
    this.store = store;
    this.budget = budget;
    this.permission = permission;
    this.approvalStore = approvalStore;
    this.executors = executors instanceof Map ? executors : new Map(Object.entries(executors || {}));
    this.hangAlert = hangAlert; // NoeHangAlert（波次6 接线）：executor 运行登记心跳，NoeLoop 巡检超时告警非杀
    this.selfEvolutionGate = typeof selfEvolutionGate === 'function' ? selfEvolutionGate : evaluateNoeSelfEvolutionActGuard;
    this.selfEvolutionRoot = str(selfEvolutionRoot, 1000) || DEFAULT_NOE_SELF_EVOLUTION_ROOT;
    this.contextSufficiency = typeof contextSufficiency === 'function' ? contextSufficiency : evaluateNoeContextSufficiency;
    this.actionEvidenceBuilder = typeof actionEvidenceBuilder === 'function' ? actionEvidenceBuilder : buildNoeActionEvidence;
    this.audit = audit;
    this.execPolicy = execPolicy && typeof execPolicy.evaluate === 'function' ? execPolicy : null;
    this.policyAudit = policyAudit && typeof policyAudit.recordSafe === 'function' ? policyAudit : null;
    this.broadcast = typeof broadcast === 'function' ? broadcast : null;
    this.autoExecuteLowRisk = autoExecuteLowRisk === true;
    this.logger = logger;
  }

  asHandler() { return async (context = {}) => this.tick(context); }

  async tick(context = {}) { return this.propose(this.planFromLoopContext(context)); }

  planFromLoopContext({ focusItems = [], memoryStats = null } = {}) {
    const semanticContext = semanticContextFromFocusItems({ focusItems });
    return {
      title: titleFromContext({ focusItems }),
      action: 'noe.focus.review',
      riskLevel: 'low',
      payload: {
        source: 'noe_loop_tick',
        focusItemIds: (Array.isArray(focusItems) ? focusItems : []).map((item) => item.id).filter(Boolean).slice(0, 10),
        memoryVisible: memoryStats?.visible ?? null,
        ...semanticContext,
      },
    };
  }

  async propose(input = {}) {
    const action = str(input.action || 'noe.focus.review', 160) || 'noe.focus.review';
    const riskLevel = normalizeRisk(input.riskLevel || input.risk_level, action);
    const payload = {
      ...safeObject(input.payload),
      proposedBy: input.proposedBy || 'noe-loop',
    };
    const selfEvolution = safeObject(input.selfEvolution || input.self_evolution);
    if (Object.keys(selfEvolution).length) payload.selfEvolution = selfEvolution;
    const act = this.store.create({
      projectId: input.projectId || this.projectId,
      title: input.title || action,
      action,
      riskLevel,
      status: 'queued',
      payload,
      costEstimateUsd: Math.max(0, Number(input.costEstimateUsd || input.estimateUSD) || 0),
    });
    this.#broadcast({ type: 'noe_act_created', act });
    return this.process(act.id, input);
  }

  async process(actId, input = {}) {
    let act = this.store.update(actId, { status: 'planning' });
    this.#broadcast({ type: 'noe_act_updated', act });
    act = this.store.update(actId, { status: 'proposed' });
    this.#broadcast({ type: 'noe_act_updated', act });

    const budgetResult = budgetPreflight(this, act, input);
    if (!budgetResult.ok) {
      act = this.store.update(actId, {
        status: 'failed',
        budgetState: 'blocked',
        failureReason: budgetResult.error,
        payload: { budget: budgetResult },
      });
      this.#recordAudit('noe.act.failed', act, { reason: budgetResult.error });
      this.#broadcast({ type: 'noe_act_updated', act });
      return { ok: false, act, error: budgetResult.error };
    }
    act = this.store.update(actId, {
      status: 'budget_checked',
      budgetState: budgetResult.warnings?.length ? 'warn' : 'ok',
      payload: { budget: budgetResult },
    });
    this.#broadcast({ type: 'noe_act_updated', act });

    const permissionResult = permissionPreflight(this, act, input);
    if (permissionResult.blockedSafety) {
      act = this.store.update(actId, {
        status: 'blocked_safety',
        permissionState: 'blocked_safety',
        failureReason: permissionResult.reason,
        payload: { permission: permissionResult },
      });
      this.#recordAudit('noe.act.blocked_safety', act, { reason: permissionResult.reason });
      this.#broadcast({ type: 'noe_act_updated', act });
      return { ok: false, act, error: 'blocked_safety' };
    }
    if (permissionResult.requiresApproval) {
      act = this.store.update(actId, {
        status: 'awaiting_approval',
        approvalId: permissionResult.approval?.id || null,
        permissionState: 'approval_required',
        failureReason: permissionResult.reason,
        payload: { permission: permissionResult },
      });
      this.#recordAudit('noe.act.awaiting_approval', act, { approvalId: act.approvalId, reason: permissionResult.reason });
      this.#broadcast({ type: 'noe_act_updated', act });
      return { ok: true, act, approvalRequired: true };
    }

    act = this.store.update(actId, {
      status: 'permission_checked',
      permissionState: permissionResult.decision || 'allow',
      payload: { permission: permissionResult },
    });
    this.#broadcast({ type: 'noe_act_updated', act });

    const selfEvolutionResult = this.selfEvolutionGate({
      act,
      input,
      permissionResult,
      budgetResult,
      root: this.selfEvolutionRoot,
    });
    if (selfEvolutionResult.applies && !selfEvolutionResult.ok) {
      act = this.store.update(actId, {
        status: 'blocked_safety',
        permissionState: 'blocked_safety',
        failureReason: selfEvolutionResult.error,
        payload: { selfEvolutionGate: selfEvolutionResult.gate },
      });
      this.#recordAudit('noe.act.self_evolution_blocked', act, { gate: selfEvolutionResult.gate });
      this.#broadcast({ type: 'noe_act_updated', act });
      return { ok: false, act, error: 'self_evolution_gate_blocked', selfEvolutionGate: selfEvolutionResult.gate };
    }
    if (selfEvolutionResult.applies) {
      act = this.store.update(actId, {
        payload: { selfEvolutionGate: selfEvolutionResult.gate },
      });
      this.#recordAudit('noe.act.self_evolution_checked', act, { gate: selfEvolutionResult.gate });
      this.#broadcast({ type: 'noe_act_updated', act });
    }

    const contextSufficiencyResult = contextSufficiencyPreflight(this, act, input);
    if (contextSufficiencyResult && (!contextSufficiencyResult.ok || !contextSufficiencyResult.sufficient)) {
      act = this.store.update(actId, {
        status: 'blocked_safety',
        permissionState: 'blocked_safety',
        failureReason: contextSufficiencyResult.blockers?.join(', ') || 'context_sufficiency_not_met',
        payload: { contextSufficiency: contextSufficiencyResult },
      });
      this.#recordAudit('noe.act.context_sufficiency_blocked', act, { contextSufficiency: contextSufficiencyResult });
      this.#broadcast({ type: 'noe_act_updated', act });
      return { ok: false, act, error: 'context_sufficiency_not_met', contextSufficiency: contextSufficiencyResult };
    }
    if (contextSufficiencyResult) {
      act = this.store.update(actId, {
        payload: { contextSufficiency: contextSufficiencyResult },
      });
      this.#recordAudit('noe.act.context_sufficiency_checked', act, { contextSufficiency: contextSufficiencyResult });
      this.#broadcast({ type: 'noe_act_updated', act });
    }

    // 信任档放行（viaPolicy allow）等同于授权真实执行：解 L2「默认 dry_run」枷锁。
    const policyAllowsRealExec = permissionResult?.viaPolicy === true && permissionResult?.decision === 'allow';
    const autoExecuteRegisteredLowRisk = this.autoExecuteLowRisk
      && act.riskLevel === 'low'
      && this.executors.has(act.action);
    if (input.realExecute === true || input.real_execute === true || input.execute === true || policyAllowsRealExec || autoExecuteRegisteredLowRisk) {
      return this.#executeReal(actId, act, input, { budgetResult, permissionResult, selfEvolutionResult, contextSufficiencyResult });
    }

    act = this.store.update(actId, {
      status: 'dry_run',
      logRef: `sqlite:events/noe_act_dry_run/${actId}`,
      payload: { dryRunOnly: true },
    });
    this.#broadcast({ type: 'noe_act_updated', act });

    const eventId = appendEvent({
      kind: 'noe_act_dry_run',
      ts: nowMs(),
      tag: 'noe.act.dry_run',
      entityType: 'noe_act',
      entityId: actId,
      projectId: act.projectId,
      action: act.action,
      title: act.title,
      riskLevel: act.riskLevel,
      dryRunOnly: true,
      note: 'P0 Act Pipeline records reproducible dry-run evidence only; no external send, delete, bulk move, or shell execution is performed.',
    });
    const dryRunLogRef = `sqlite:events/${Number(eventId)}`;
    const actionEvidence = this.actionEvidenceBuilder({
      act,
      input,
      budgetResult,
      permissionResult,
      contextSufficiency: contextSufficiencyResult,
      selfEvolutionGate: selfEvolutionResult.gate,
      dryRunOnly: true,
      evidenceEventId: Number(eventId),
      logRef: dryRunLogRef,
      refs: input.evidenceRefs || input.evidence_refs || {},
      notes: 'Noe Act dry-run evidence generated before real execution.',
    });
    act = this.store.update(actId, {
      status: 'completed',
      evidenceEventId: Number(eventId),
      logRef: dryRunLogRef,
      payload: { completedAt: nowMs(), dryRunOnly: true, actionEvidence },
    });
    this.#recordAudit('noe.act.completed', act, { evidenceEventId: Number(eventId), dryRunOnly: true });
    this.#broadcast({ type: 'noe_act_updated', act });
    return { ok: true, act };
  }

  async #executeReal(actId, act, input = {}, evidenceContext = {}) {
    const executor = this.executors.get(act.action);
    if (typeof executor !== 'function') {
      const blocked = this.store.update(actId, {
        status: 'blocked_safety',
        permissionState: 'blocked_safety',
        failureReason: `real executor not registered for ${act.action}`,
        payload: { realExecuteRequested: true, dryRunOnly: false },
      });
      this.#recordAudit('noe.act.blocked_safety', blocked, { reason: blocked.failureReason });
      this.#broadcast({ type: 'noe_act_updated', act: blocked });
      return { ok: false, act: blocked, error: 'executor_not_registered' };
    }

    // R2-P2：真实执行标 'executing'（非 'dry_run'）。executor 卡死/进程重启后 act 停在 executing，
    //   retry() 可识别并恢复（旧 dry_run 不在可重试集，真失败被永久吞掉）。
    let running = this.store.update(actId, {
      status: 'executing',
      logRef: `sqlite:events/noe_act_execute/${actId}`,
      payload: { realExecuteRequested: true, dryRunOnly: false },
    });
    this.#broadcast({ type: 'noe_act_updated', act: running });
    let executorResult;
    this.hangAlert?.start?.(actId, { action: running.action });   // 登记长跑（波次6）：超阈值由 NoeLoop 告警非杀
    try {
      executorResult = await executor({ act: running, input: safeObject(input) });
    } catch (e) {
      this.hangAlert?.done?.(actId);
      const failed = this.store.update(actId, {
        status: 'failed',
        failureReason: e?.message || String(e),
        payload: { realExecuteRequested: true, dryRunOnly: false, executorError: e?.message || String(e) },
      });
      this.#recordAudit('noe.act.failed', failed, { reason: failed.failureReason });
      this.#broadcast({ type: 'noe_act_updated', act: failed });
      // 保留 executor 抛错时挂在 e.selfEvolution 的结构化路由字段，透传给调用方（self-evolution trigger）——否则只剩
      //   error message，verify 失败无法路由到 self_repair_ready，cycle 永卡 implementation_ready 反复重试（complete 控制链 Finding 3）。
      // **白名单透传**（多模型审 defense-in-depth）：只放已知安全的 ref/布尔/code 字段，不整体回传 e.selfEvolution——
      //   selfEvolutionError 本就保证无 secret（secretValuesReturned:false），白名单是纵深第二道，防未来某 executor 误把
      //   token/diff 挂上去被回写进 cycle / 落日志。非自改 executor 抛普通 Error 时 e.selfEvolution 缺失 → 不加该字段，零行为变化。
      const SE = (e && e.selfEvolution && typeof e.selfEvolution === 'object' && !Array.isArray(e.selfEvolution)) ? e.selfEvolution : null;
      let selfEvolution = null;
      if (SE) {
        selfEvolution = {};
        // A2 失败证据回灌(2026-07-03)：verifyReason（verify 失败原因短文本，executor 已 clean 截断）加入白名单——
        //   trigger 据此存 cycle.repairHints 让 self_repair 不再盲重试（实证 359 次 needs_consensus 全烧在盲猜上）。
        for (const k of ['code', 'needsSelfRepair', 'needsConsensus', 'applyReportRef', 'runtimeReportRef', 'rollbackReportRef', 'priorApplyReportRef', 'priorRollbackRef', 'rolledBack', 'skipped', 'verifyReason', 'improveSignal']) {
          if (SE[k] !== undefined) selfEvolution[k] = SE[k];
        }
      }
      return { ok: false, act: failed, error: failed.failureReason, ...(selfEvolution ? { selfEvolution } : {}) };
    }
    this.hangAlert?.done?.(actId);

    const eventId = appendEvent({
      kind: 'noe_act_executed',
      ts: nowMs(),
      tag: 'noe.act.executed',
      entityType: 'noe_act',
      entityId: actId,
      projectId: running.projectId,
      action: running.action,
      title: running.title,
      riskLevel: running.riskLevel,
      dryRunOnly: false,
      executorResult: redactedExecutorResult(executorResult),
    });
    const executeLogRef = `sqlite:events/${Number(eventId)}`;
    const actionEvidence = this.actionEvidenceBuilder({
      act: running,
      input,
      budgetResult: evidenceContext.budgetResult,
      permissionResult: evidenceContext.permissionResult,
      contextSufficiency: evidenceContext.contextSufficiencyResult,
      selfEvolutionGate: evidenceContext.selfEvolutionResult?.gate,
      dryRunOnly: false,
      executorResult,
      evidenceEventId: Number(eventId),
      logRef: executeLogRef,
      refs: input.evidenceRefs || input.evidence_refs || {},
      notes: 'Noe Act real execution evidence generated after executor completion.',
    });
    // codex 第三轮 F2 防御：executor 约定「失败抛错」(browser assertBrowserDomResult/shell exitCode≠0 都 throw)，
    //   ActPipeline 原无条件记 completed——若未来某 executor 返回 {ok:false} 软失败而不抛错，会被当成功吞掉
    //   (act 供给端漏判真失败→好奇回路缺料)。显式判 ok===false → failed。当前 executor 无此形态，零行为变化。
    const executorReportedFailure = executorResult && typeof executorResult === 'object' && executorResult.ok === false;
    const f2FailureReason = executorReportedFailure ? String(executorResult.error || executorResult.reason || 'executor reported ok:false').slice(0, 200) : '';
    running = this.store.update(actId, {
      status: executorReportedFailure ? 'failed' : 'completed',
      evidenceEventId: Number(eventId),
      logRef: executeLogRef,
      ...(executorReportedFailure ? { failureReason: f2FailureReason } : {}),
      payload: { completedAt: nowMs(), dryRunOnly: false, executorResult: redactedExecutorResult(executorResult), actionEvidence },
    });
    this.#recordAudit(executorReportedFailure ? 'noe.act.failed' : 'noe.act.completed', running, { evidenceEventId: Number(eventId), dryRunOnly: false });
    this.#broadcast({ type: 'noe_act_updated', act: running });
    return { ok: !executorReportedFailure, act: running, executorResult, ...(executorReportedFailure ? { error: f2FailureReason } : {}) };
  }

  async retry(actId, input = {}) {
    const current = this.store.get(actId);
    if (!current) return { ok: false, status: 404, error: 'act not found', act: null };
    const approvedExecuteRetry = current.status === 'awaiting_approval'
      && (input.realExecute === true || input.real_execute === true || input.execute === true)
      && (input.approvalId || input.approval_id || current.approvalId);
    // R2-P2：'executing' 进可重试集——真实执行中进程重启/卡死后遗留的 act，人工或系统可 retry 恢复
    //   （同进程内正常执行是 await 串行的，不会并发 retry；跨重启的 executing 就是卡住的，retry 安全）。
    if (!approvedExecuteRetry && !['failed', 'cancelled', 'blocked_safety', 'executing'].includes(current.status)) {
      return { ok: false, status: 409, error: `act is not retryable from status ${current.status}`, act: current };
    }
    const retryCount = Math.max(0, Number(current.payload?.retryCount) || 0) + 1;
    const act = this.store.update(actId, {
      status: 'retrying',
      failureReason: '',
      payload: {
        retryCount,
        retriedAt: nowMs(),
        retryReason: str(input.reason || 'manual_retry', 240),
      },
    });
    this.#recordAudit('noe.act.retrying', act, { retryCount });
    this.#broadcast({ type: 'noe_act_updated', act });
    return this.process(actId, {
      ...safeObject(current.payload),
      ...safeObject(input),
      approvalId: input.approvalId || input.approval_id || current.approvalId,
      title: current.title,
      action: current.action,
      riskLevel: current.riskLevel,
      costEstimateUsd: current.costEstimateUsd,
    });
  }

  #recordAudit(action, act, details = {}) {
    this.audit?.recordSafe?.({
      action,
      actorType: 'system',
      entityType: 'noe_act',
      entityId: act?.id || null,
      status: act?.status || 'unknown',
      severity: action.includes('blocked') || action.includes('failed') ? 'warn' : 'info',
      details: { act, ...details },
    });
  }

  #broadcast(message) {
    try { this.broadcast?.(message); } catch (e) { this.logger?.warn?.('[noe-act] broadcast failed:', e?.message || e); }
  }
}
