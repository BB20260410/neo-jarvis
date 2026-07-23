// @ts-check
// XaiChatAdapter — OpenAI 兼容 + 每次调用前解析 xAI OAuth/API Key
// 用于 Neo 主脑全量切换到 grok-4.5(high)（会员池 OAuth 优先）。

import { OpenAICompatChatAdapter } from './OpenAICompatChatAdapter.js';
import { resolveXaiAccessToken } from './NoeXaiAuth.js';

export class XaiChatAdapter extends OpenAICompatChatAdapter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.id]
   * @param {string} [opts.displayName]
   * @param {string} [opts.baseUrl]
   * @param {string} [opts.model]
   * @param {number} [opts.maxTokens]
   * @param {number} [opts.temperature]
   * @param {string} [opts.reasoningEffort]
   * @param {number} [opts.timeout]
   * @param {(env?: NodeJS.ProcessEnv) => Promise<string>} [opts.resolveApiKey]
   */
  constructor(opts = {}) {
    super({
      id: opts.id || 'xai',
      displayName: opts.displayName || '🟣 xAI Grok',
      baseUrl: opts.baseUrl || process.env.XAI_BASE_URL || 'https://api.x.ai/v1',
      // 占位；真正 token 在 _doChat 前 resolve
      apiKey: opts.apiKey || 'pending-xai-token',
      model: opts.model || process.env.NOE_XAI_MODEL || 'grok-4.5',
      maxTokens: typeof opts.maxTokens === 'number' ? opts.maxTokens : (Number(process.env.NOE_LMSTUDIO_MAX_TOKENS) || 16384),
      temperature: opts.temperature,
      reasoningEffort: opts.reasoningEffort ?? process.env.NOE_XAI_REASONING_EFFORT ?? 'high',
      timeout: opts.timeout,
      // grok-4.5 拒 presence/frequency penalty
      omitPenalties: opts.omitPenalties !== false,
    });
    this._resolveApiKey = opts.resolveApiKey || ((env) => resolveXaiAccessToken(env));
  }

  async _doChat(messages, opts = {}) {
    this.apiKey = await this._resolveApiKey(process.env);
    // 调用方可临时覆盖 effort；默认沿用构造时 high
    const nextOpts = {
      ...opts,
      reasoningEffort: opts.reasoningEffort ?? opts.reasoning_effort ?? this.reasoningEffort,
    };
    return super._doChat(messages, nextOpts);
  }
}
