// @ts-check
/**
 * Ordinary-mode task receipt surface (S5 product front door piece).
 * Expert mode reads the same UnifiedTask truth — no parallel status.
 */
import { getUnifiedTaskStore } from './UnifiedTaskStore.js';
import { describeRuntimeMode } from './NoeBaiLongmaRuntimeMode.js';
import { normalizeOrdinaryTaskStatus } from './NoeTaskStatusHonesty.js';

export const TASK_RECEIPT_VIEW_VERSION = 1;

/** Five ordinary-mode entry points (IA contract). */
export const ORDINARY_FRONT_DOOR_ENTRIES = Object.freeze([
  { id: 'chat', title: '对话执行', description: '一句话派任务并看收据' },
  { id: 'tasks', title: '任务', description: '进行中/完成/失败与恢复' },
  { id: 'memory', title: '记忆', description: '可纠错/删除/导出的记忆' },
  { id: 'doctor', title: 'Doctor', description: '首启检查与健康' },
  { id: 'settings', title: '设置', description: '权限、模型、更新' },
]);

/**
 * @param {object} [opts]
 * @param {import('./UnifiedTaskStore.js').UnifiedTaskStore} [opts.taskStore]
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [opts.env]
 * @param {string} [opts.sourceDigest] optional frozen digest for visibility (no secrets)
 */
export function buildFrontDoorManifest(opts = {}) {
  const env = opts.env || process.env;
  const mode = describeRuntimeMode(env);
  return {
    version: TASK_RECEIPT_VIEW_VERSION,
    brand: 'Neo 贾维斯',
    internalRuntimeName: 'Noe',
    ordinaryEntries: ORDINARY_FRONT_DOOR_ENTRIES,
    expertMode: {
      enabled: true,
      sameTaskTruth: true,
      note: 'Expert views read UnifiedTaskStore receipts; no parallel ledger',
    },
    doctorEntry: 'doctor',
    firstTaskSlaMinutes: 10,
    /** Memory/state visibility invent: mode + digest summary on front door (not a parallel ledger). */
    runtimeVisibility: {
      modeId: mode.modeId,
      bailongmaStyle: mode.bailongmaStyle === true || mode.bailongmaStyle === false ? mode.bailongmaStyle : false,
      topologyClass: mode.topologyClaim?.topologyClass || null,
      isFullyCloud: mode.topologyClaim?.isFullyCloud === true,
      proactiveTickMs: mode.effectiveEnv?.NOE_PROACTIVE_TICK_MS || null,
      sourceDigestPrefix: typeof opts.sourceDigest === 'string' && opts.sourceDigest
        ? String(opts.sourceDigest).slice(0, 19)
        : null,
    },
  };
}

/**
 * @param {string} taskId
 * @param {object} [opts]
 */
export function renderOrdinaryReceipt(taskId, opts = {}) {
  const store = opts.taskStore || getUnifiedTaskStore();
  const receipt = store.buildReceipt(taskId);
  if (!receipt) {
    return {
      ok: false,
      error: 'task_not_found',
      ordinary: null,
    };
  }
  // Ordinary UI: no raw stderr, quorum, MCP dumps.
  // Honesty: never surface "completed" when summary/evidence contradicts success.
  const honest = normalizeOrdinaryTaskStatus({
    status: receipt.status,
    summary: receipt.resultSummary,
    title: receipt.goal,
    ok: receipt.displayCompleted === true ? undefined : (receipt.status === 'failed' ? false : undefined),
  });
  const ordinaryStatus = honest.status === 'done' ? 'completed' : honest.status;
  return {
    ok: true,
    ordinary: {
      taskId: receipt.taskId,
      status: ordinaryStatus,
      label: honest.label,
      goal: receipt.goal,
      summary: receipt.resultSummary,
      artifactCount: (receipt.artifacts || []).length,
      canRetry: ordinaryStatus === 'failed' || ordinaryStatus === 'partial' || ordinaryStatus === 'recovery_required',
      canCancel: !['completed', 'cancelled', 'done'].includes(ordinaryStatus),
      completed: ordinaryStatus === 'completed' || ordinaryStatus === 'done',
      statusContradicted: honest.contradicted === true,
      receiptId: receipt.receiptId,
    },
    expert: {
      sourceDigest: receipt.sourceDigest,
      revision: receipt.revision,
      legacyRefs: receipt.legacyRefs,
      verification: receipt.verification,
      artifacts: receipt.artifacts,
    },
    sameTruth: true,
  };
}
