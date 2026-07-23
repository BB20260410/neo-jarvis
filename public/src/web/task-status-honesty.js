// @ts-check
/**
 * Browser copy of honest task status (keep in sync with src/runtime/NoeTaskStatusHonesty.js).
 * Used by cognitive.html / home-shell to avoid "已完成" with exit≠0 evidence.
 */

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

export function ordinaryStatusLabel(status) {
  const s = String(status || 'running').toLowerCase();
  return ORDINARY_STATUS_LABELS[s] || ORDINARY_STATUS_LABELS.running;
}

export function evidenceContradictsSuccess(text) {
  const t = String(text || '');
  if (!t) return false;
  if (/\bexit\s*[=:]\s*(?!0\b)\d+/i.test(t)) return true;
  if (/\bexitCode\s*[=:]\s*(?!0\b)\d+/i.test(t)) return true;
  if (/\bUnknown command\b/i.test(t)) return true;
  if (/\bcommand not found\b/i.test(t)) return true;
  if (/\bECONNREFUSED\b|\bENOENT\b|\bETIMEDOUT\b/i.test(t)) return true;
  if (/(?:^|[^\w])failed(?:[^\w]|$)/i.test(t) && /error|失败|错误|crash|exception/i.test(t)) return true;
  if (/执行失败|运行失败|测试失败|门禁失败|gate failed|verify failed/i.test(t)) return true;
  return false;
}

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
