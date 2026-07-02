// LmStudioChatAdapter — 在通用 OpenAI 兼容 adapter 基础上，调用前"自助确保目标模型已加载"。
// 这样 Noe 会先把调用方显式选择的模型或 adapter 配置默认模型 load 进 LM Studio 再发请求，
// 不再依赖"恰好已加载"。线上模型(minimax/litellm 等)走各自 adapter，不受影响、直连。

import { OpenAICompatChatAdapter } from './OpenAICompatChatAdapter.js';
import { ensureLmStudioModel, currentLoadedChatModel } from './LmStudioLoader.js';
import { NOE_MAIN_BRAIN, normalizeNoeAutoModel } from '../model/NoeLocalModelPolicy.js';

export class LmStudioChatAdapter extends OpenAICompatChatAdapter {
  constructor(opts = {}) {
    super({
      ...opts,
      temperature: typeof opts.temperature === 'number' ? opts.temperature : NOE_MAIN_BRAIN.generation.temperature,
      top_p: typeof opts.top_p === 'number' ? opts.top_p : (typeof opts.topP === 'number' ? opts.topP : NOE_MAIN_BRAIN.generation.top_p),
      maxTokens: typeof opts.maxTokens === 'number' ? opts.maxTokens : NOE_MAIN_BRAIN.generation.max_tokens,
      reasoningEffort: opts.reasoningEffort ?? opts.reasoning_effort ?? NOE_MAIN_BRAIN.generation.reasoning_effort,
    });
    this._ensureModel = opts.ensureModel || ensureLmStudioModel;   // 可注入便于单测
    this._currentLoaded = opts.currentLoaded || currentLoadedChatModel; // 查 LM Studio 当前加载的模型
    this._loadTtlSeconds = opts.loadTtlSeconds;                    // 可选:空闲自动卸载省内存
    this._loadContextLength = opts.loadContextLength;              // 可选:lms load --context-length
    this._loadParallel = opts.loadParallel;                        // 可选:lms load --parallel
    this._loadIdentifier = opts.loadIdentifier;                    // 可选:lms load --identifier
    this._lastEnsure = null;                                       // 最近一次加载结果，便于诊断
  }

  async _doChat(messages, opts = {}) {
    const hasExplicitModel = opts.model !== undefined && opts.model !== null && String(opts.model).trim() !== '';
    let model = hasExplicitModel
      ? normalizeNoeAutoModel(opts.model, { allowEmpty: true })
      : normalizeNoeAutoModel(this.model);
    // 三角色模型策略下，自动链路不能在 opts.model 缺省时跟随 LM Studio 当前 loaded 模型，
    // 否则后台心跳/反刍/判证可能漂到手动加载的实验模型。旧 Q35 mlx/8bit 别名也要归一，
    // 避免历史状态把 Main Brain 误加载成手动 benchmark 模型。
    if (model) {
      try {
        this._lastEnsure = await this._ensureModel(model, {
          baseUrl: this.baseUrl,
          ttlSeconds: this._loadTtlSeconds,
          contextLength: this._loadContextLength,
          parallel: this._loadParallel,
          identifier: this._loadIdentifier,
        });
      }
      catch (e) { this._lastEnsure = { ok: false, error: e?.message || String(e) }; }
    }
    return super._doChat(messages, { ...opts, model });
  }
}
