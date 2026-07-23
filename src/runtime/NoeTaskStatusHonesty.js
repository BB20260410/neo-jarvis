// @ts-check
/**
 * Honest task/receipt status for ordinary UI.
 * Prevents "已完成" when summary/evidence shows failure (exit≠0, unknown command, etc.).
 */

/** Terminal success labels only when evidence does not contradict. */
export const ORDINARY_STATUS_LABELS = Object.freeze({
  accepted: '已接单 · 执行中',
  queued: '排队中',
  running: '执行中',
  done: '已成功',
  completed: '已成功',
  partial: '部分完成',
  failed: '已失败',
  blocked: '已阻塞',
  awaiting_approval: '等待你确认',
  need_user: '需要你介入',
  cancelled: '已取消',
  stuck: '卡住了',
});

/**
 * @param {string} [status]
 * @returns {string}
 */
export function ordinaryStatusLabel(status) {
  const s = String(status || 'running').toLowerCase();
  return ORDINARY_STATUS_LABELS[s] || ORDINARY_STATUS_LABELS.running;
}

/**
 * Evidence strings that mean "not really successful" even if status says done.
 * @param {string} text
 * @returns {boolean}
 */
export function evidenceContradictsSuccess(text) {
  const t = String(text || '');
  if (!t) return false;
  // exit=1, exit:2, Exit Code 1
  if (/\bexit\s*[=:]\s*(?!0\b)\d+/i.test(t)) return true;
  if (/\bexitCode\s*[=:]\s*(?!0\b)\d+/i.test(t)) return true;
  if (/\bUnknown command\b/i.test(t)) return true;
  if (/\bcommand not found\b/i.test(t)) return true;
  if (/\bECONNREFUSED\b|\bENOENT\b|\bETIMEDOUT\b/i.test(t)) return true;
  if (/(?:^|[^\w])failed(?:[^\w]|$)/i.test(t) && !/not failed|unfailed/i.test(t)) {
    // soft: only when paired with error-ish context
    if (/error|失败|错误|crash|exception/i.test(t)) return true;
  }
  if (/执行失败|运行失败|测试失败|门禁失败|gate failed|verify failed/i.test(t)) return true;
  return false;
}

/**
 * Normalize status for display/API ordinary surface.
 * @param {{ status?: string, summary?: string, title?: string, nextStep?: string, exitCode?: number|null, ok?: boolean }} [item]
 * @returns {{ status: string, label: string, contradicted: boolean, reason: string|null }}
 */
export function normalizeOrdinaryTaskStatus(item = {}) {
  let status = String(item.status || 'running').toLowerCase() || 'running';
  const blob = [item.title, item.summary, item.nextStep].filter(Boolean).join(' · ');
  let contradicted = false;
  let reason = null;

  if (item.ok === false && (status === 'done' || status === 'completed')) {
    status = 'failed';
    contradicted = true;
    reason = 'ok_false';
  }
  if (Number.isFinite(Number(item.exitCode)) && Number(item.exitCode) !== 0) {
    if (status === 'done' || status === 'completed' || status === 'running') {
      status = 'failed';
      contradicted = true;
      reason = `exit_${item.exitCode}`;
    }
  }
  if ((status === 'done' || status === 'completed') && evidenceContradictsSuccess(blob)) {
    status = 'failed';
    contradicted = true;
    reason = reason || 'summary_contradicts_success';
  }

  return {
    status,
    label: ordinaryStatusLabel(status),
    contradicted,
    reason,
  };
}
