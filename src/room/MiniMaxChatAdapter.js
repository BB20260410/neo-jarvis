// MiniMaxChatAdapter — MiniMax chat completion API 实现（聊天室成员版）
// 跟 src/watcher/MiniMaxAdapter.js 区分：那个只实现 judge() 给 watcher 用；
// 这个实现 chat() 给 Room dispatcher 用。

import { RoomAdapter } from './RoomAdapter.js';
import { completionStatusForFinishReason } from './finishReason.js';

const DEFAULT_BASE_URL = 'https://api.minimax.chat/v1';
const DEFAULT_MODEL = 'MiniMax-M3';

export function normalizeMiniMaxThinking(value) {
  if (value === 'disabled') return { type: 'disabled' };
  if (value === 'adaptive' || value === 'enabled') return { type: 'adaptive' };
  if (value === 'default' || value === '' || value == null) return undefined;
  return value;
}

export class MiniMaxChatAdapter extends RoomAdapter {
  constructor(opts = {}) {
    super({
      id: opts.id || 'minimax',
      displayName: opts.displayName || '🟡 MiniMax',
      model: opts.model || DEFAULT_MODEL,
      timeout: Object.prototype.hasOwnProperty.call(opts, 'timeout') ? opts.timeout : 0,
    });
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
    // MiniMax OpenAI 兼容接口使用 max_completion_tokens；0 = 不传，让服务端决定。
    this.maxCompletionTokens = typeof opts.maxCompletionTokens === 'number'
      ? opts.maxCompletionTokens
      : (typeof opts.maxTokens === 'number' ? opts.maxTokens : 32768);
    this.reasoningSplit = opts.reasoningSplit !== false;
    this.thinking = Object.prototype.hasOwnProperty.call(opts, 'thinking') ? opts.thinking : undefined;
    this.serviceTier = typeof opts.serviceTier === 'string' ? opts.serviceTier : '';
  }

  async _doChat(messages, opts = {}) {
    if (!this.apiKey) throw new Error('MiniMax 缺少 apiKey');
    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const oaiMessages = messages.map(m => ({
      role: m.role === 'system' ? 'system' : (m.role === 'user' ? 'user' : 'assistant'),
      content: m.speaker ? `[${m.speaker}] ${m.content}` : m.content,
    }));
    const model = opts.model || this.model;
    const body = {
      model,
      messages: oaiMessages,
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.4,
    };
    const maxCompletionTokens = typeof opts.maxCompletionTokens === 'number'
      ? opts.maxCompletionTokens
      : (typeof opts.maxTokens === 'number' ? opts.maxTokens : this.maxCompletionTokens);
    if (maxCompletionTokens > 0) body.max_completion_tokens = maxCompletionTokens;
    const reasoningSplit = Object.prototype.hasOwnProperty.call(opts, 'reasoningSplit') ? opts.reasoningSplit : this.reasoningSplit;
    if (typeof reasoningSplit === 'boolean') body.reasoning_split = reasoningSplit;
    const serviceTier = typeof opts.serviceTier === 'string' ? opts.serviceTier : this.serviceTier;
    if (serviceTier) body.service_tier = serviceTier;
    const rawThinking = Object.prototype.hasOwnProperty.call(opts, 'thinkingMode')
      ? opts.thinkingMode
      : (Object.prototype.hasOwnProperty.call(opts, 'thinking') ? opts.thinking : this.thinking);
    const thinking = normalizeMiniMaxThinking(rawThinking);
    if (thinking !== undefined && /MiniMax-M3/i.test(model)) body.thinking = thinking;

    const controller = new AbortController();
    const timer = opts.noAbort === true || this.timeout <= 0 ? null : setTimeout(() => controller.abort(), this.timeout);
    let externalAbortHandler = null;
    if (opts.abortSignal) {
      externalAbortHandler = () => controller.abort();
      opts.abortSignal.addEventListener('abort', externalAbortHandler, { once: true });
    }

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (timer) clearTimeout(timer);
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        const err = new Error(`MiniMax ${resp.status}: ${errText.slice(0, 300)}`);
        if (resp.status === 422 && /new_sensitive|unprocessable_entity/i.test(errText)) {
          err.code = 'PROVIDER_INPUT_REJECTED';
          err.providerCode = 'MINIMAX_NEW_SENSITIVE';
        }
        throw err;
      }
      const data = await resp.json();
      const choice = data?.choices?.[0] || {};
      const reply = choice?.message?.content?.trim() || '';
      const usage = data?.usage || {};
      // finish_reason='length' 时正文是半截被截断输出；映射成与 OpenAICompat 一致的截断字段，
      // 让 SoloChatDispatcher.isIncompleteChatResult() 能识别，不把半句模型回复当完整结果落账。
      const completion = completionStatusForFinishReason(choice?.finish_reason || data?.finish_reason || '');
      if (!reply && !completion.incomplete) throw new Error('MiniMax 响应空 reply（可能 plan 无 chat completion 权限）');
      return {
        reply,
        tokensIn: usage.prompt_tokens || 0,
        tokensOut: usage.completion_tokens || 0,
        ...completion,
        raw: { ...data, ...completion },
      };
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error(`MiniMax 超时 ${this.timeout}ms`);
      throw e;
    } finally {
      if (externalAbortHandler && opts.abortSignal) {
        opts.abortSignal.removeEventListener('abort', externalAbortHandler);
      }
    }
  }
}
