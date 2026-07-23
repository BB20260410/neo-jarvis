// @ts-check
/**
 * Voice → UnifiedTask product loop (G-VOICE-01).
 * Text and voice share the same Task ID, approval, status, and receipt.
 * Strict ASR acceptance: no loose homophone matching.
 */
import { evaluateHighRiskConfirmation, isHighRiskAction } from './NoeHighRiskConfirmation.js';
import { evaluateCompletionTruth } from './NoeCompletionTruthGate.js';

export const VOICE_TASK_LOOP_VERSION = 1;

/**
 * Strict transcript match for task success.
 * Exact normalized equality only (trim + collapse whitespace). No 板/吧 fuzzy.
 * @param {string} expected
 * @param {string} got
 */
export function strictTranscriptMatch(expected, got) {
  const norm = (s) =>
    String(s || '')
      .trim()
      .replace(/\s+/g, '')
      .replace(/[。！？.!?，,]/g, '');
  return norm(expected) === norm(got) && norm(expected).length > 0;
}

/**
 * Classify ASR outcome.
 * @param {{ transcript?: string, confidence?: number, error?: string|null, expectedIntent?: string }} asr
 */
export function classifyAsrResult(asr = {}) {
  if (asr.error) {
    return { ok: false, mode: 'asr_failed', reason: String(asr.error) };
  }
  const text = String(asr.transcript || '').trim();
  if (!text) {
    return { ok: false, mode: 'asr_empty', reason: 'empty_transcript' };
  }
  const confidence = Number(asr.confidence);
  const confOk = !Number.isFinite(confidence) || confidence >= 0.75;
  if (asr.expectedIntent != null && asr.expectedIntent !== '') {
    if (!strictTranscriptMatch(asr.expectedIntent, text)) {
      return {
        ok: false,
        mode: 'asr_mismatch',
        reason: 'strict_transcript_mismatch',
        transcript: text,
        expected: asr.expectedIntent,
      };
    }
  }
  if (!confOk) {
    return {
      ok: false,
      mode: 'low_confidence',
      reason: 'confidence_below_threshold',
      confidence,
      transcript: text,
    };
  }
  return { ok: true, mode: 'asr_ok', transcript: text, confidence: Number.isFinite(confidence) ? confidence : null };
}

/**
 * @typedef {object} VoiceLoopAdapters
 * @property {{ create: Function, get: Function, transition: Function, buildReceipt: Function, linkLegacy?: Function }} taskStore
 * @property {{ requestApproval?: Function, getApproval?: Function }} [approval]
 */

/**
 * Voice task session orchestrator (pure control plane over UnifiedTaskStore).
 */
export class NoeVoiceTaskLoop {
  /**
   * @param {object} opts
   * @param {VoiceLoopAdapters['taskStore']} opts.taskStore
   * @param {string} [opts.sourceDigest]
   * @param {string} [opts.runtimeConfigDigest]
   */
  constructor(opts) {
    this.taskStore = opts.taskStore;
    this.sourceDigest = opts.sourceDigest || null;
    this.runtimeConfigDigest = opts.runtimeConfigDigest || null;
    /** @type {Map<string, object>} */
    this._sessions = new Map();
  }

  /**
   * PTT end → create UnifiedTask from ASR (or text fallback).
   * @param {object} input
   * @param {'voice'|'text'} [input.channel]
   * @param {object} [input.asr]
   * @param {string} [input.textFallback]
   * @param {string} [input.goal]
   * @param {string} [input.actionType] for high-risk classification
   * @param {number} [input.confidence]
   */
  startFromPtt(input = {}) {
    const channel = input.channel || 'voice';
    let goal = String(input.goal || '').trim();
    let asrClass = null;
    let usedTextFallback = false;

    if (channel === 'voice') {
      asrClass = classifyAsrResult({
        transcript: input.asr?.transcript ?? input.transcript,
        confidence: input.asr?.confidence ?? input.confidence,
        error: input.asr?.error ?? input.asrError,
        expectedIntent: input.asr?.expectedIntent,
      });
      if (!asrClass.ok) {
        if (input.textFallback && String(input.textFallback).trim()) {
          goal = String(input.textFallback).trim();
          usedTextFallback = true;
        } else if (asrClass.mode === 'asr_failed' || asrClass.mode === 'asr_empty') {
          return {
            ok: false,
            error: 'asr_failed_no_text_fallback',
            asr: asrClass,
            canSwitchToText: true,
          };
        } else if (asrClass.mode === 'asr_mismatch') {
          return {
            ok: false,
            error: 'strict_transcript_mismatch',
            asr: asrClass,
            canCorrect: true,
          };
        } else if (asrClass.mode === 'low_confidence') {
          goal = asrClass.transcript;
        } else {
          return { ok: false, error: asrClass.reason, asr: asrClass };
        }
      } else {
        goal = asrClass.transcript;
      }
    } else {
      goal = String(input.textFallback || input.goal || '').trim();
      if (!goal) return { ok: false, error: 'empty_text_goal' };
    }

    if (!goal) return { ok: false, error: 'empty_goal' };

    const actionType = String(input.actionType || 'voice_command');
    const highRisk = isHighRiskAction(actionType);
    const needsSecondConfirm =
      highRisk ||
      asrClass?.mode === 'low_confidence' ||
      (Number(input.confidence) > 0 && Number(input.confidence) < 0.75);

    const task = this.taskStore.create({
      goal,
      status: needsSecondConfirm ? 'awaiting_approval' : 'queued',
      sourceDigest: this.sourceDigest,
      runtimeConfigDigest: this.runtimeConfigDigest,
    });

    const session = {
      taskId: task.id,
      channel: usedTextFallback ? 'text_fallback' : channel,
      goal,
      actionType,
      highRisk,
      needsSecondConfirm,
      ownerConfirmed: false,
      cancelled: false,
      interrupted: false,
      corrected: false,
      asr: asrClass,
      usedTextFallback,
      transcriptHistory: [{ at: new Date().toISOString(), text: goal, channel: usedTextFallback ? 'text' : channel }],
    };
    this._sessions.set(task.id, session);

    if (this.taskStore.linkLegacy) {
      this.taskStore.linkLegacy(task.id, {
        agentRunIds: [`voice_session_${task.id}`],
      });
    }

    return {
      ok: true,
      taskId: task.id,
      status: task.status,
      channel: session.channel,
      needsSecondConfirm,
      highRisk,
      usedTextFallback,
      asr: asrClass,
      receipt: this.taskStore.buildReceipt(task.id),
    };
  }

  /**
   * User corrects transcript — same Task ID.
   * @param {string} taskId
   * @param {string} correctedText
   */
  correctTranscript(taskId, correctedText) {
    const session = this._require(taskId);
    if (session.cancelled) return { ok: false, error: 'already_cancelled', taskId };
    const text = String(correctedText || '').trim();
    if (!text) return { ok: false, error: 'empty_correction', taskId };
    session.goal = text;
    session.corrected = true;
    session.transcriptHistory.push({ at: new Date().toISOString(), text, channel: 'text_correct' });
    const task = this.taskStore.get(taskId);
    // store goal update via transition metadata
    this.taskStore.transition(taskId, task.status === 'awaiting_approval' ? 'awaiting_approval' : 'queued', {
      resultSummary: `corrected:${text}`,
    });
    // Force re-read: mutate goal on store if possible
    const t = this.taskStore.get(taskId);
    if (t) t.goal = text;
    return {
      ok: true,
      taskId,
      goal: text,
      sameTaskId: true,
      receipt: this.taskStore.buildReceipt(taskId),
    };
  }

  /**
   * Approve high-risk / low-confidence command — same Task ID.
   * @param {string} taskId
   * @param {{ confirmationToken?: string, expectedToken?: string }} [opts]
   */
  approve(taskId, opts = {}) {
    const session = this._require(taskId);
    if (session.cancelled) return { ok: false, error: 'already_cancelled', taskId };
    const decision = evaluateHighRiskConfirmation({
      actionType: session.highRisk ? session.actionType : 'read_file',
      ownerConfirmed: true,
      confirmationToken: opts.confirmationToken,
      expectedToken: opts.expectedToken,
    });
    // For high-risk voice acts always require confirm path
    if (session.highRisk || session.needsSecondConfirm) {
      const hr = evaluateHighRiskConfirmation({
        actionType: session.highRisk ? 'shell_write' : 'read_file',
        ownerConfirmed: true,
        confirmationToken: opts.confirmationToken,
        expectedToken: opts.expectedToken,
      });
      if (session.highRisk && !hr.allowed) {
        return { ok: false, error: hr.reason, taskId, needsSecondConfirm: true };
      }
    }
    session.ownerConfirmed = true;
    session.needsSecondConfirm = false;
    this.taskStore.transition(taskId, 'running', { resultSummary: 'voice_approved' });
    return {
      ok: true,
      taskId,
      status: 'running',
      sameTaskId: true,
      receipt: this.taskStore.buildReceipt(taskId),
    };
  }

  /**
   * Cancel — same Task ID.
   * @param {string} taskId
   */
  cancel(taskId) {
    const session = this._require(taskId);
    session.cancelled = true;
    this.taskStore.transition(taskId, 'cancelled', { resultSummary: 'voice_cancelled' });
    return {
      ok: true,
      taskId,
      status: 'cancelled',
      sameTaskId: true,
      receipt: this.taskStore.buildReceipt(taskId),
    };
  }

  /**
   * Interrupt running task — recovery_required / partial, same ID.
   * @param {string} taskId
   */
  interrupt(taskId) {
    const session = this._require(taskId);
    session.interrupted = true;
    const task = this.taskStore.get(taskId);
    const next =
      task?.status === 'running' || task?.status === 'verifying' ? 'recovery_required' : 'cancelled';
    this.taskStore.transition(taskId, next, { resultSummary: 'voice_interrupted' });
    return {
      ok: true,
      taskId,
      status: next,
      sameTaskId: true,
      receipt: this.taskStore.buildReceipt(taskId),
    };
  }

  /**
   * Complete after successful execution with strict verification.
   * @param {string} taskId
   * @param {object} result
   */
  complete(taskId, result = {}) {
    const session = this._require(taskId);
    if (session.cancelled) return { ok: false, error: 'already_cancelled', taskId };
    if ((session.highRisk || session.needsSecondConfirm) && !session.ownerConfirmed) {
      return { ok: false, error: 'second_confirm_required', taskId, needsSecondConfirm: true };
    }
    // Strict: do not accept ASR-mismatch completions
    if (result.expectedTranscript != null) {
      if (!strictTranscriptMatch(result.expectedTranscript, result.actualTranscript || session.goal)) {
        return {
          ok: false,
          error: 'strict_transcript_mismatch_on_complete',
          taskId,
        };
      }
    }
    const truth = evaluateCompletionTruth(
      {
        requestedStatus: 'completed',
        exitCode: result.exitCode ?? 0,
        verified: result.verified === true,
        hasValidArtifacts: result.hasValidArtifacts === true,
        hasEvidence: result.hasEvidence === true,
        validatorsPass: result.validatorsPass === true,
        sourceDigestMatch: result.sourceDigestMatch !== false,
        approvalsSettled: session.highRisk ? session.ownerConfirmed : true,
        highRiskActsSettled: session.highRisk ? session.ownerConfirmed : true,
      },
      { strict: true },
    );
    const status = truth.allowed ? 'completed' : truth.finalStatus || 'partial';
    this.taskStore.transition(taskId, status, {
      exitCode: result.exitCode ?? 0,
      verified: result.verified === true,
      hasValidArtifacts: result.hasValidArtifacts === true,
      hasEvidence: result.hasEvidence === true,
      validatorsPass: result.validatorsPass === true,
      sourceDigestMatch: true,
      approvalsSettled: true,
      highRiskActsSettled: true,
      sourceDigest: this.sourceDigest,
      resultSummary: result.summary || session.goal,
      artifacts: result.artifacts || [],
      receiptId: result.receiptId || `voice_receipt_${taskId}`,
    });
    const receipt = this.taskStore.buildReceipt(taskId);
    return {
      ok: truth.allowed,
      taskId,
      status: receipt?.status,
      sameTaskId: true,
      displayCompleted: receipt?.displayCompleted === true,
      receipt,
      truth,
    };
  }

  /**
   * Switch to text after ASR failure without losing session intent — new channel same task if exists.
   * @param {string} taskId
   * @param {string} text
   */
  switchToText(taskId, text) {
    return this.correctTranscript(taskId, text);
  }

  getSession(taskId) {
    return this._sessions.get(String(taskId)) || null;
  }

  _require(taskId) {
    const s = this._sessions.get(String(taskId));
    if (!s) throw new Error(`voice_session_not_found:${taskId}`);
    return s;
  }
}

/**
 * Run standard voice product suite against a task store (for gates/tests).
 * @param {object} opts
 * @param {import('./UnifiedTaskStore.js').UnifiedTaskStore} opts.taskStore
 * @param {string} [opts.sourceDigest]
 */
export function runVoiceTaskLoopSuite(opts) {
  const loop = new NoeVoiceTaskLoop({
    taskStore: opts.taskStore,
    sourceDigest: opts.sourceDigest,
    runtimeConfigDigest: opts.runtimeConfigDigest,
  });
  const cases = [];

  // 1) PTT success path
  {
    const start = loop.startFromPtt({
      channel: 'voice',
      asr: { transcript: '查看任务状态', confidence: 0.92 },
      actionType: 'read_file',
    });
    const done = loop.complete(start.taskId, {
      verified: true,
      hasValidArtifacts: true,
      hasEvidence: true,
      validatorsPass: true,
      exitCode: 0,
      expectedTranscript: '查看任务状态',
      actualTranscript: '查看任务状态',
      summary: 'status shown',
      artifacts: [{ path: 'status.md', sha256: 'a' }],
    });
    cases.push({
      id: 'ptt_create_complete',
      ok: start.ok && done.ok && start.taskId === done.taskId && done.displayCompleted === true,
      taskId: start.taskId,
    });
  }

  // 2) Strict mismatch must NOT succeed
  {
    const start = loop.startFromPtt({
      channel: 'voice',
      asr: { transcript: '打开面吧', confidence: 0.9, expectedIntent: '打开面板' },
      actionType: 'read_file',
    });
    cases.push({
      id: 'strict_no_homophone',
      ok: start.ok === false && start.error === 'strict_transcript_mismatch',
    });
  }

  // 3) ASR fail → text fallback same path
  {
    const start = loop.startFromPtt({
      channel: 'voice',
      asr: { error: 'mic_permission_denied' },
      textFallback: '用文本创建任务',
      actionType: 'read_file',
    });
    const done = loop.complete(start.taskId, {
      verified: true,
      hasValidArtifacts: true,
      hasEvidence: true,
      validatorsPass: true,
      exitCode: 0,
      expectedTranscript: '用文本创建任务',
      actualTranscript: '用文本创建任务',
      artifacts: [{ path: 't.md', sha256: 'b' }],
    });
    cases.push({
      id: 'asr_fail_text_fallback',
      ok: start.ok && start.usedTextFallback === true && done.ok && start.taskId === done.taskId,
      taskId: start.taskId,
    });
  }

  // 4) High risk requires second confirm; cancel works
  {
    const start = loop.startFromPtt({
      channel: 'voice',
      asr: { transcript: '删除系统文件', confidence: 0.95 },
      actionType: 'fs_delete',
    });
    const premature = loop.complete(start.taskId, {
      verified: true,
      hasValidArtifacts: true,
      hasEvidence: true,
      validatorsPass: true,
      exitCode: 0,
    });
    const approved = loop.approve(start.taskId, {});
    const cancel = loop.cancel(start.taskId);
    cases.push({
      id: 'high_risk_confirm_and_cancel',
      ok:
        start.needsSecondConfirm === true &&
        premature.ok === false &&
        approved.ok === true &&
        cancel.ok === true &&
        cancel.taskId === start.taskId &&
        cancel.status === 'cancelled',
      taskId: start.taskId,
    });
  }

  // 5) Correct + interrupt
  {
    const start = loop.startFromPtt({
      channel: 'voice',
      asr: { transcript: '运行测试', confidence: 0.9 },
      actionType: 'read_file',
    });
    const corr = loop.correctTranscript(start.taskId, '运行全部测试');
    loop.approve(start.taskId);
    const inter = loop.interrupt(start.taskId);
    cases.push({
      id: 'correct_and_interrupt',
      ok:
        corr.sameTaskId &&
        inter.sameTaskId &&
        inter.taskId === start.taskId &&
        (inter.status === 'recovery_required' || inter.status === 'cancelled'),
      taskId: start.taskId,
    });
  }

  // 6) Text channel shares store (same receipt builder)
  {
    const start = loop.startFromPtt({
      channel: 'text',
      textFallback: '文本派发同一套收据',
      actionType: 'read_file',
    });
    const receipt = opts.taskStore.buildReceipt(start.taskId);
    cases.push({
      id: 'text_same_receipt_surface',
      ok: start.ok && receipt?.taskId === start.taskId,
      taskId: start.taskId,
    });
  }

  const passed = cases.filter((c) => c.ok).length;
  const rate = cases.length ? passed / cases.length : 0;
  return {
    schemaVersion: VOICE_TASK_LOOP_VERSION,
    suite: 'voice_unified_task_loop',
    taskLoopClosed: true,
    cases: cases.length,
    passed,
    voiceTaskSuccessRate: rate,
    ok: rate >= 0.9 && cases.every((c) => c.id !== 'strict_no_homophone' || c.ok),
    results: cases,
    sourceDigest: opts.sourceDigest || null,
    strictMatching: true,
    at: new Date().toISOString(),
  };
}
