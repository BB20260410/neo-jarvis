// @ts-check
// finishReason — 把各家 LLM 的 finish_reason / finishReason 统一映射成
// 截断判定字段。单一真相源：OpenAICompat / Gemini / MiniMax 三个 adapter 共用，
// 杜绝各写一份导致 SoloChatDispatcher.isIncompleteChatResult() 漏判。
//
// 兼容取值（统一 lowercase 后比较）：
//   - OpenAI 兼容：'length'
//   - 部分服务：'max_tokens'
//   - Gemini 原生：'MAX_TOKENS'（lowercase 后 = 'max_tokens'，自动命中）

/**
 * @param {string} [finishReason]
 * @returns {{finishReason:string, truncated:boolean, incomplete:boolean, continuationRequired:boolean, completionStatus:('complete'|'incomplete_length')}}
 */
export function completionStatusForFinishReason(finishReason = '') {
  const reason = String(finishReason || '').trim().toLowerCase();
  const truncated = reason === 'length' || reason === 'max_tokens';
  return {
    finishReason: reason || '',
    truncated,
    incomplete: truncated,
    continuationRequired: truncated,
    completionStatus: truncated ? 'incomplete_length' : 'complete',
  };
}
