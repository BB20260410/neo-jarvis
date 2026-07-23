// @ts-check
/**
 * AgentRuntime — thin orchestrator only.
 *
 * Reuses (does not reimplement):
 *   Autopilot queues, ToolRegistry/MCP, ActPipeline, SafeAct/Freedom,
 *   Room, AgentRun, TaskFlow, Reportback.
 *
 * Final Task state is written only through UnifiedTaskStore.
 */
import {
  getUnifiedTaskStore,
  producerMayWriteTaskFinalState,
  readUnifiedTaskMigrationFlags,
} from './UnifiedTaskStore.js';

export const AGENT_RUNTIME_SCHEMA_VERSION = 1;

/**
 * @typedef {object} RuntimeAdapters
 * @property {{ enqueue?: Function, createJob?: Function }} [autopilot]
 * @property {{ invoke?: Function, list?: Function }} [toolRegistry]
 * @property {{ propose?: Function, execute?: Function }} [actPipeline]
 * @property {{ createRun?: Function, transition?: Function }} [agentRunStore]
 * @property {{ createRoom?: Function }} [room]
 * @property {{ createFlow?: Function }} [taskFlow]
 * @property {{ enqueue?: Function }} [reportback]
 */

export class AgentRuntime {
  /**
   * @param {object} [opts]
   * @param {RuntimeAdapters} [opts.adapters]
   * @param {import('./UnifiedTaskStore.js').UnifiedTaskStore} [opts.taskStore]
   * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [opts.env]
   * @param {() => Date} [opts.now]
   */
  constructor(opts = {}) {
    this.adapters = opts.adapters || {};
    this.taskStore = opts.taskStore || getUnifiedTaskStore({ env: opts.env });
    this.env = opts.env || process.env;
    this.now = opts.now || (() => new Date());
    /** @type {Array<object>} */
    this._log = [];
  }

  flags() {
    return readUnifiedTaskMigrationFlags(this.env);
  }

  /**
   * Architecture hard boundary probe.
   */
  assertNoProducerFinalState() {
    if (producerMayWriteTaskFinalState() !== false) {
      throw new Error('architecture_violation: producer_final_state_allowed');
    }
    return { ok: true, producerMayWriteTaskFinalState: false };
  }

  /**
   * Accept a user goal and create UnifiedTask + optional shadow AgentRun.
   * @param {{ goal: string, sourceDigest?: string, runtimeConfigDigest?: string, metadata?: object }} input
   */
  async acceptGoal(input = {}) {
    this.assertNoProducerFinalState();
    const flags = this.flags();
    const task = this.taskStore.create({
      goal: input.goal,
      status: 'queued',
      sourceDigest: input.sourceDigest,
      runtimeConfigDigest: input.runtimeConfigDigest,
      forceShadowRecord: true,
    });

    let agentRunId = null;
    if (this.adapters.agentRunStore?.createRun) {
      try {
        const run = await this.adapters.agentRunStore.createRun({
          taskId: task.id,
          goal: input.goal,
          shadow: flags.agentRuntimeShadow,
        });
        agentRunId = run?.id || run?.runId || null;
        if (agentRunId) this.taskStore.linkLegacy(task.id, { agentRunIds: [agentRunId] });
      } catch (e) {
        this._log.push({ type: 'agent_run_create_failed', error: String(e?.message || e) });
      }
    }

    this.taskStore.transition(task.id, 'running', {
      resultSummary: 'runtime_accepted_goal',
    });

    this._log.push({ type: 'accept_goal', taskId: task.id, agentRunId, at: this.now().toISOString() });
    return {
      taskId: task.id,
      status: this.taskStore.get(task.id)?.status,
      agentRunId,
      flags,
      schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
    };
  }

  /**
   * Record tool observation — never completes task by itself.
   * @param {string} taskId
   * @param {object} observation
   */
  async recordObservation(taskId, observation = {}) {
    this.assertNoProducerFinalState();
    const task = this.taskStore.get(taskId);
    if (!task) throw new Error(`task_not_found:${taskId}`);
    this._log.push({
      type: 'observation',
      taskId,
      tool: observation.tool || observation.name || null,
      ok: observation.ok !== false,
      at: this.now().toISOString(),
    });
    // stay running / verifying
    if (task.status === 'running') {
      this.taskStore.transition(taskId, 'verifying', {
        resultSummary: observation.summary || 'observation_recorded',
      });
    }
    return { taskId, status: this.taskStore.get(taskId)?.status, observationLogged: true };
  }

  /**
   * Attempt completion — only UnifiedTaskStore truth gate may accept.
   * @param {string} taskId
   * @param {object} result
   */
  async completeTask(taskId, result = {}) {
    this.assertNoProducerFinalState();
    // Explicit: AgentRuntime does not write final state itself
    const updated = this.taskStore.transition(taskId, 'completed', {
      exitCode: result.exitCode,
      verified: result.verified,
      hasValidArtifacts: result.hasValidArtifacts,
      hasEvidence: result.hasEvidence,
      validatorsPass: result.validatorsPass,
      sourceDigestMatch: result.sourceDigestMatch,
      approvalsSettled: result.approvalsSettled,
      highRiskActsSettled: result.highRiskActsSettled,
      sourceDigest: result.sourceDigest,
      runtimeConfigDigest: result.runtimeConfigDigest,
      resultSummary: result.summary,
      artifacts: result.artifacts,
      receiptId: result.receiptId,
      error: result.error,
      dryRun: result.dryRun,
    });
    const receipt = this.taskStore.buildReceipt(taskId);
    this._log.push({
      type: 'complete_attempt',
      taskId,
      finalStatus: updated?.status,
      displayCompleted: receipt?.displayCompleted,
      at: this.now().toISOString(),
    });
    return { task: updated, receipt };
  }

  /**
   * Prove runtime does not spawn shell/browser/file side effects itself.
   */
  listBuiltinSideEffectExecutors() {
    return {
      shell: false,
      filesystem: false,
      browser: false,
      secondScheduler: false,
      note: 'AgentRuntime only orchestrates adapters; side effects go through ActPipeline/SafeAct/ToolRegistry',
    };
  }

  getLog() {
    return [...this._log];
  }
}

export function createAgentRuntime(opts = {}) {
  return new AgentRuntime(opts);
}
