import { agentRunStore } from './AgentRunStore.js';

function safeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error || 'error'),
    code: error?.code || null,
  };
}

export class AgentRunLifecycle {
  constructor({ store = agentRunStore, logger = console } = {}) {
    this.store = store;
    this.logger = logger;
  }

  startRun({ adapter, messages = [], opts = {} } = {}) {
    if (!this.store) return null;
    if (opts.skipAgentRun) return null;

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
}

export const agentRunLifecycle = new AgentRunLifecycle();
