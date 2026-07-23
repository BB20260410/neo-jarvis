import { agentRunStore } from './AgentRunStore.js';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'deferred']);

function safeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error || 'error'),
    code: error?.code || null,
  };
}

/**
 * Whether adapter_chat should open an agent_runs row.
 * - skipAgentRun / agentRunLifecycle===false → never
 * - NOE_AGENT_RUN_ADAPTER_CHAT=0|off → never
 * - sample | sample:N → record ~1/N (default N=10)
 * - default / 1 / all → always
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [env]
 */
export function shouldRecordAdapterChatRun(opts = {}, env = process.env) {
  if (opts.skipAgentRun === true) return false;
  if (opts.agentRunLifecycle === false) return false;
  if (opts.forceAgentRun === true) return true;
  const raw = String(env.NOE_AGENT_RUN_ADAPTER_CHAT ?? '1').trim().toLowerCase();
  if (!raw || raw === '1' || raw === 'all' || raw === 'true' || raw === 'on') return true;
  if (raw === '0' || raw === 'off' || raw === 'false' || raw === 'none') return false;
  if (raw === 'sample' || raw.startsWith('sample:')) {
    const n = Math.max(1, Number(raw.includes(':') ? raw.split(':')[1] : 10) || 10);
    return Math.random() < (1 / n);
  }
  // unknown → fail-open record (preserve observability)
  return true;
}

export class AgentRunLifecycle {
  constructor({ store = agentRunStore, logger = console } = {}) {
    this.store = store;
    this.logger = logger;
  }

  startRun({ adapter, messages = [], opts = {} } = {}) {
    if (!this.store) return null;
    if (!shouldRecordAdapterChatRun(opts)) return null;

    const budget = opts.budgetContext || {};
    const runId = opts.agentRunId;
    const adapterId = this._resolveAdapterId(budget, adapter);
    const modelId = this._resolveModelId(opts, adapter);
    const sourceId = this._buildSourceId(budget, modelId, adapterId);

    const run = this.store.create({
      id: runId,
      status: 'running',
      roomId: budget.roomId,
      sessionId: budget.sessionId,
      taskId: budget.taskId,
      agentProfileId: budget.agentProfileId,
      adapterId,
      modelId,
      sourceType: 'adapter_chat',
      sourceId,
      details: this._buildRunDetails(opts, adapter, messages),
    });

    opts.agentRunId = run.id;
    return run;
  }

  _resolveAdapterId(budget, adapter) {
    return budget.adapterId || adapter?.id;
  }

  _resolveModelId(opts, adapter) {
    return opts.model || adapter?.model;
  }

  _buildSourceId(budget, modelId, adapterId) {
    return `${budget.roomId || 'room'}:${budget.taskId || modelId || adapterId || 'turn'}`;
  }

  _buildRunDetails(opts, adapter, messages) {
    return {
      cwd: opts.cwd || null,
      messageCount: Array.isArray(messages) ? messages.length : 0,
      estimateTokens: typeof adapter?._countTokens === 'function' ? adapter._countTokens(messages) : 0,
    };
  }

  appendDecision(runId, payload = {}) {
    if (!runId || !this.store) return null;
    return this.store.appendMessage(runId, {
      kind: 'decision',
      role: 'system',
      summary: payload.summary || 'Agent run context prepared.',
      payload,
    });
  }

  deferRun(runId, reason, payload = {}) {
    if (!runId || !this.store) return null;
    return this.store.transition(runId, 'deferred', { deferReason: reason, reason, ...payload });
  }

  finishRun(runId, result = {}) {
    if (!runId || !this.store) return null;
    return this.store.transition(runId, 'succeeded', {
      tokensIn: result?.tokensIn || 0,
      tokensOut: result?.tokensOut || 0,
      replyLength: typeof result?.reply === 'string' ? result.reply.length : 0,
    });
  }

  failRun(runId, error, payload = {}) {
    if (!runId || !this.store) return null;
    return this.store.transition(runId, 'failed', { ...safeError(error), ...payload });
  }

  cancelRun(runId, error, payload = {}) {
    if (!runId || !this.store) return null;
    return this.store.transition(runId, 'cancelled', { ...safeError(error), ...payload });
  }

  /**
   * Idempotent settle: no-op if already terminal (succeeded/failed/cancelled/deferred).
   * Used by RoomAdapter finally so breaker/rate-limit/bulkhead early exits cannot leave zombies.
   * @param {string} runId
   * @param {{ outcome?: 'succeeded'|'failed'|'cancelled'|'deferred', error?: any, result?: object, reason?: string, payload?: object }} [spec]
   */
  ensureSettled(runId, spec = {}) {
    if (!runId || !this.store) return null;
    let run = null;
    try { run = this.store.get(runId); } catch { return null; }
    if (!run) return null;
    if (TERMINAL_STATUSES.has(String(run.status || ''))) return run;

    const outcome = String(spec.outcome || 'failed');
    try {
      if (outcome === 'succeeded') return this.finishRun(runId, spec.result || {});
      if (outcome === 'cancelled') return this.cancelRun(runId, spec.error || new Error(spec.reason || 'cancelled'), spec.payload || {});
      if (outcome === 'deferred') return this.deferRun(runId, spec.reason || 'deferred', { ...(spec.payload || {}), error: spec.error?.message || spec.error });
      return this.failRun(runId, spec.error || new Error(spec.reason || 'failed'), {
        ...(spec.payload || {}),
        ensureSettled: true,
        ensureSettledReason: spec.reason || 'ensure_settled',
      });
    } catch (e) {
      try { this.logger?.warn?.('[agent-runs] ensureSettled failed:', e?.message || e); } catch { /* ignore */ }
      return this.store.get?.(runId) || run;
    }
  }
}

export const agentRunLifecycle = new AgentRunLifecycle();
