// NoeTrajectoryCompactor — 对话轨迹滑动压缩：超预算时把早期轮次摘要、保护尾部高保真。
//
// 独立自洽的纯逻辑模块（未来长程压缩候选），让 Noe 在数小时长程自主任务中不因 token 超限被截断。
// 借鉴 Hermes context_compressor（LLM 主动重写 + 保护尾部）/ OpenClaw compact。
//
// 纯逻辑 + summarize 注入（无 summarizer 时降级为确定性占位摘要），可独立单测；接 live 路径见波次6。

/** 粗估 token：约 4 字符 ≈ 1 token。 */
export function estimateMessageTokens(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  return Math.ceil(list.reduce((n, m) => n + String(m?.content ?? '').length, 0) / 4);
}

/** 是否该压缩（超预算）。 */
export function shouldCompactTrajectory(messages = [], { budgetTokens = 8000 } = {}) {
  return estimateMessageTokens(messages) > budgetTokens;
}

/** 无 summarizer 时的降级摘要：列早期轮次角色 + 截断内容（确定性，可复现）。 */
function defaultSummary(messages) {
  return messages.slice(0, 30)
    .map((m) => `${m.role || '?'}: ${String(m.content ?? '').replace(/\s+/g, ' ').slice(0, 100)}`)
    .join('\n');
}

/**
 * 压缩对话轨迹：保留最近 keepRecent 条高保真，早期轮次合并为一条摘要 system 消息。
 *
 * @param {Array} messages 对话消息 [{role, content}]
 * @param {object} [opts]
 * @param {number} [opts.keepRecent] 尾部保护条数（默认 6）
 * @param {((early:Array)=>Promise<string>|string)|null} [opts.summarize] LLM 摘要器（注入），无则降级
 * @returns {Promise<{messages:Array, compactedCount:number, compacted:boolean}>}
 */
export async function compactTrajectory(messages, { keepRecent = 6, summarize = null } = {}) {
  const list = Array.isArray(messages) ? messages.filter((m) => m && m.content != null) : [];
  if (list.length <= keepRecent) return { messages: list, compactedCount: 0, compacted: false };

  const recent = list.slice(-keepRecent);
  const early = list.slice(0, -keepRecent);
  let summaryText = '';
  if (typeof summarize === 'function') {
    try { summaryText = String((await summarize(early)) ?? '').trim(); } catch { summaryText = ''; }
  }
  if (!summaryText) summaryText = defaultSummary(early);

  return {
    messages: [{ role: 'system', content: `[早期对话摘要 · 已压缩 ${early.length} 条]\n${summaryText}`, compacted: true }, ...recent],
    compactedCount: early.length,
    compacted: true,
  };
}
