// @ts-check
/**
 * UnifiedTaskStore — sole writer of Task final-state for Neo.
 *
 * Room / AgentRun / Act / TaskFlow / Reportback / Goal are producers or projections.
 * They must not independently declare Task completed.
 *
 * Migration switches (contract):
 *   NOE_UNIFIED_TASK_WRITE=0|1   shadow or real writes
 *   NOE_UNIFIED_TASK_READ=0|1    prefer unified read path
 *   NOE_LEGACY_TASK_WRITES=1|0   allow legacy writers (default 1 during migration)
 *   NOE_AGENT_RUNTIME_SHADOW=0|1
 */
import { randomUUID } from 'node:crypto';
import { evaluateCompletionTruth, normalizeTerminalStatus } from './NoeCompletionTruthGate.js';

export const UNIFIED_TASK_SCHEMA_VERSION = 1;

export const UNIFIED_TASK_STATUSES = Object.freeze([
  'planned',
  'queued',
  'running',
  'awaiting_approval',
  'verifying',
  'completed',
  'partial',
  'failed',
  'blocked',
  'cancelled',
  'recovery_required',
]);

const ACTIVE = new Set(['planned', 'queued', 'running', 'awaiting_approval', 'verifying', 'recovery_required']);
const TERMINAL = new Set(['completed', 'partial', 'failed', 'blocked', 'cancelled']);

/**
 * @param {string} status
 */
export function isUnifiedTaskStatus(status) {
  return UNIFIED_TASK_STATUSES.includes(/** @type {any} */ (status));
}

/**
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [env]
 */
export function readUnifiedTaskMigrationFlags(env = process.env) {
  const on = (k, d = '0') => String(env?.[k] ?? d) === '1';
  return {
    unifiedTaskWrite: on('NOE_UNIFIED_TASK_WRITE', '0'),
    unifiedTaskRead: on('NOE_UNIFIED_TASK_READ', '0'),
    legacyTaskWrites: String(env?.NOE_LEGACY_TASK_WRITES ?? '1') !== '0',
    agentRuntimeShadow: on('NOE_AGENT_RUNTIME_SHADOW', '0'),
  };
}

/**
 * In-memory / injectable store. Production can wrap Sqlite later without changing API.
 */
export class UnifiedTaskStore {
  /**
   * @param {{ now?: () => Date, env?: NodeJS.ProcessEnv|Record<string,string|undefined> }} [opts]
   */
  constructor(opts = {}) {
    /** @type {Map<string, object>} */
    this._tasks = new Map();
    /** @type {Array<object>} */
    this._events = [];
    this._now = opts.now || (() => new Date());
    this._env = opts.env || process.env;
    this._revision = 0;
  }

  flags() {
    return readUnifiedTaskMigrationFlags(this._env);
  }

  /**
   * @param {object} input
   */
  create(input = {}) {
    const flags = this.flags();
    const id = String(input.id || `task_${randomUUID().replace(/-/g, '').slice(0, 16)}`);
    if (this._tasks.has(id)) throw new Error(`unified_task_exists:${id}`);
    const now = this._now().toISOString();
    const task = {
      id,
      schemaVersion: UNIFIED_TASK_SCHEMA_VERSION,
      status: isUnifiedTaskStatus(input.status) ? input.status : 'planned',
      goal: String(input.goal || input.title || '').slice(0, 4000),
      parentTaskId: input.parentTaskId || null,
      revision: 1,
      generation: 1,
      sourceDigest: input.sourceDigest || null,
      runtimeConfigDigest: input.runtimeConfigDigest || null,
      legacyRefs: {
        agentRunIds: [],
        actIds: [],
        roomIds: [],
        taskFlowIds: [],
        reportbackIds: [],
        ...(input.legacyRefs || {}),
      },
      resultSummary: null,
      verification: null,
      artifacts: [],
      receiptId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      writeMode: flags.unifiedTaskWrite ? 'live' : 'shadow_disabled',
    };
    if (!flags.unifiedTaskWrite && input.forceShadowRecord !== true) {
      // Still allow create in memory for tests/canary when forceShadowRecord
      // Default: record as shadow when write flag off but caller uses store API for canary
    }
    this._tasks.set(id, task);
    this._emit(id, 'created', { status: task.status });
    return { ...task };
  }

  /**
   * @param {string} id
   */
  get(id) {
    const t = this._tasks.get(String(id));
    return t ? { ...t, legacyRefs: { ...t.legacyRefs } } : null;
  }

  list({ status, limit = 100 } = {}) {
    let rows = [...this._tasks.values()];
    if (status) rows = rows.filter((t) => t.status === status);
    rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return rows.slice(0, Math.max(1, Math.min(1000, Number(limit) || 100))).map((t) => ({ ...t }));
  }

  /**
   * Attach legacy producer ids (AgentRun/Act/Room...) — not final-state.
   * @param {string} id
   * @param {object} refs
   */
  linkLegacy(id, refs = {}) {
    const task = this._require(id);
    const lr = task.legacyRefs || {};
    for (const key of ['agentRunIds', 'actIds', 'roomIds', 'taskFlowIds', 'reportbackIds']) {
      if (Array.isArray(refs[key])) {
        lr[key] = [...new Set([...(lr[key] || []), ...refs[key].map(String)])];
      }
    }
    task.legacyRefs = lr;
    task.updatedAt = this._now().toISOString();
    task.revision += 1;
    this._emit(id, 'legacy_linked', { legacyRefs: lr });
    return this.get(id);
  }

  /**
   * Transition status. Only this store may set completed — and only via truth gate.
   * @param {string} id
   * @param {string} status
   * @param {object} [details]
   */
  transition(id, status, details = {}) {
    const task = this._require(id);
    let next = normalizeTerminalStatus(status);
    // map agent-run vocab
    if (next === 'succeeded' || next === 'success') next = 'completed';
    if (!isUnifiedTaskStatus(next)) {
      throw new Error(`invalid_unified_task_status:${status}`);
    }

    // Terminal re-entry guard
    if (TERMINAL.has(task.status) && task.status !== next) {
      const fromPartialOrFailed = task.status === 'failed' || task.status === 'partial';
      const allowedRetry =
        fromPartialOrFailed
        && (next === 'recovery_required' || next === 'running' || next === 'verifying' || next === 'completed' || next === 'partial' || next === 'failed');
      // completed/cancelled stay hard-locked
      if (task.status === 'completed' || task.status === 'cancelled') {
        throw new Error(`unified_task_terminal_locked:${task.status}`);
      }
      if (!allowedRetry && task.status !== next) {
        throw new Error(`unified_task_terminal_locked:${task.status}`);
      }
    }

    if (next === 'completed') {
      const decision = evaluateCompletionTruth({
        requestedStatus: 'completed',
        exitCode: details.exitCode,
        verified: details.verified,
        hasValidArtifacts: details.hasValidArtifacts,
        hasEvidence: details.hasEvidence,
        validatorsPass: details.validatorsPass,
        sourceDigestMatch: details.sourceDigestMatch !== false
          && (!task.sourceDigest || !details.sourceDigest || task.sourceDigest === details.sourceDigest),
        approvalsSettled: details.approvalsSettled,
        highRiskActsSettled: details.highRiskActsSettled,
        error: details.error,
        dryRun: details.dryRun,
      }, { strict: true });

      if (!decision.allowed) {
        next = decision.finalStatus === 'failed' ? 'failed' : 'partial';
        details = {
          ...details,
          completionTruthDenied: true,
          completionTruthBlockers: decision.blockers,
          completionTruthRequested: 'completed',
        };
      } else {
        details = {
          ...details,
          completionTruthAllowed: true,
        };
      }
    }

    task.status = next;
    task.updatedAt = this._now().toISOString();
    task.revision += 1;
    if (details.sourceDigest) task.sourceDigest = details.sourceDigest;
    if (details.runtimeConfigDigest) task.runtimeConfigDigest = details.runtimeConfigDigest;
    if (details.resultSummary) task.resultSummary = String(details.resultSummary).slice(0, 8000);
    if (details.verification) task.verification = details.verification;
    if (Array.isArray(details.artifacts)) task.artifacts = details.artifacts.slice(0, 50);
    if (details.receiptId) task.receiptId = details.receiptId;
    if (details.error) task.error = String(details.error).slice(0, 4000);
    if (details.completionTruthDenied) {
      task.verification = {
        ...(task.verification || {}),
        completionTruthDenied: true,
        blockers: details.completionTruthBlockers,
      };
    }
    if (TERMINAL.has(next)) {
      task.finishedAt = task.updatedAt;
    }
    this._emit(id, 'transitioned', { status: next, details: summarizeDetails(details) });
    return this.get(id);
  }

  /**
   * Build a user-facing task receipt (ordinary UI shape).
   * @param {string} id
   */
  buildReceipt(id) {
    const task = this.get(id);
    if (!task) return null;
    return {
      taskId: task.id,
      status: task.status,
      goal: task.goal,
      resultSummary: task.resultSummary,
      artifacts: task.artifacts || [],
      verification: task.verification,
      sourceDigest: task.sourceDigest,
      runtimeConfigDigest: task.runtimeConfigDigest,
      revision: task.revision,
      legacyRefs: task.legacyRefs,
      finishedAt: task.finishedAt,
      receiptId: task.receiptId || `receipt_${task.id}_${task.revision}`,
      displayCompleted: task.status === 'completed',
      note: task.status === 'completed'
        ? 'completed_only_via_UnifiedTaskStore_truth_gate'
        : 'not_completed',
    };
  }

  events(taskId) {
    return this._events.filter((e) => e.taskId === String(taskId));
  }

  _require(id) {
    const t = this._tasks.get(String(id));
    if (!t) throw new Error(`unified_task_not_found:${id}`);
    return t;
  }

  _emit(taskId, type, payload) {
    this._revision += 1;
    this._events.push({
      id: `evt_${this._revision}`,
      taskId: String(taskId),
      type,
      payload,
      at: this._now().toISOString(),
    });
  }
}

function summarizeDetails(details = {}) {
  return {
    exitCode: details.exitCode,
    verified: details.verified,
    hasValidArtifacts: details.hasValidArtifacts,
    hasEvidence: details.hasEvidence,
    completionTruthDenied: details.completionTruthDenied || false,
    blockers: details.completionTruthBlockers || null,
  };
}

/** @type {UnifiedTaskStore|null} */
let _singleton = null;

export function getUnifiedTaskStore(opts = {}) {
  if (!_singleton) _singleton = new UnifiedTaskStore(opts);
  return _singleton;
}

export function resetUnifiedTaskStoreForTests() {
  _singleton = null;
}

/**
 * Policy helper: may a non-UnifiedTask producer claim task complete?
 * Always false — architectural hard boundary.
 */
export function producerMayWriteTaskFinalState() {
  return false;
}
