// OpenAICompatChatAdapter — 通用 OpenAI Chat Completions 协议
// 用于：
//   - gemini-openai（Gemini 的 OpenAI 兼容端点 / 第三方代理）
//   - custom:<id>（用户自填 OpenRouter / Groq / DeepSeek / 本地 vLLM 等）

import { RoomAdapter } from './RoomAdapter.js';
import { completionStatusForFinishReason } from './finishReason.js';
import { resolveCircuitBreakerConfig, getSharedCircuitBreaker } from './NoeModelCircuitBreaker.js';

const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

function normalizeReasoningEffort(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const normalized = raw === 'max' || raw === 'maximum' ? 'xhigh' : raw;
  return REASONING_EFFORTS.has(normalized) ? normalized : '';
}

// 空 reply / 瞬时传输故障重试（治语音真耳验收里 ~20% long round 偶发 len=0 / `fetch failed`）。
// 标记在 error 上而非 throw 即返，便于上层（VoiceSession）区分"模型真返回空" vs"网络/adapter 故障返空"。
const EMPTY_REPLY_ERROR = 'OPENAI_COMPAT_EMPTY_REPLY';
const TRANSIENT_TRANSPORT_RE = /fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|socket hang ?up|other side closed|terminated|UND_ERR|network|connection (?:reset|closed|refused)/i;

// 瞬时传输错误（连接被对端重置/关闭、socket 挂断等）——可安全重试（非业务语义错误）。
// 注意：这里只判"传输层"，不碰 4xx/5xx（那些已被 _doChatOnce 转成带 HTTP 状态的 Error 文本，
// 不命中本正则，不重试，保持原语义）。
function isTransientTransportError(err) {
  if (!err) return false;
  if (err.code === EMPTY_REPLY_ERROR) return false; // 空 reply 单独判
  if (err.name === 'AbortError') return false;       // 主动/超时中断不重试
  const msg = `${err?.message || ''} ${err?.cause?.message || ''} ${err?.cause?.code || ''} ${err?.code || ''}`;
  return TRANSIENT_TRANSPORT_RE.test(msg);
}

// 解析 env 重试次数：默认 2 次（共最多 3 次尝试）。NOE_LLM_EMPTY_RETRY=0 可完全关闭（回旧行为）。
// 只在「空 reply」或「瞬时传输故障」时触发，happy path 零额外开销/零额外请求。
// ⚠️ owner 待审：碰 adapter 核心(影响所有模型调用)+ 云模型失败重试有少量烧配额(红线4)。owner 偏好「正确性照修+辅助配额
//   尽管烧」倾向默认开；若担心付费云模型失败重试烧配额，可改默认 OFF(return 0)。voice-ear 验收的脚本→面板层 fetch
//   failed 由 noe-voice-ear-acceptance.mjs 的脚本层 transport-retry 兜底(非生产,默认开)，不依赖本 adapter flag。
function resolveEmptyRetries(env = process.env) {
  const raw = env?.NOE_LLM_EMPTY_RETRY;
  if (raw === undefined || raw === null || raw === '') return 2;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 2;
  return Math.min(5, Math.floor(n));
}

export class OpenAICompatChatAdapter extends RoomAdapter {
  constructor(opts = {}) {
    super({
      id: opts.id || 'openai-compat',
      displayName: opts.displayName || '🟦 OpenAI 兼容',
      model: opts.model || '',
      timeout: Object.prototype.hasOwnProperty.call(opts, 'timeout') ? opts.timeout : 0,
    });
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl;
    // 部分代理需要不同 path（默认 /chat/completions），保留扩展位
    this.chatPath = opts.chatPath || '/chat/completions';
    // 部分服务（如 Groq）支持但 max_tokens 字段名不同——这里走标准 OpenAI 字段
    this.temperature = typeof opts.temperature === 'number' ? opts.temperature : 0.75;
    this.topP = typeof opts.topP === 'number' ? opts.topP : (typeof opts.top_p === 'number' ? opts.top_p : null);
    // v0.52 0=不传让服务端决定；正数=cap。默认 16384（覆盖多数 OpenAI 兼容服务上限）
    this.maxTokens = typeof opts.maxTokens === 'number' ? opts.maxTokens : 16384;
    this.reasoningEffort = normalizeReasoningEffort(opts.reasoningEffort ?? opts.reasoning_effort);
    // xAI grok-4.5 等不支持 presence/frequency penalty → omitPenalties=true 时不传
    this.omitPenalties = opts.omitPenalties === true;
    this.frequencyPenalty = typeof opts.frequencyPenalty === 'number' ? opts.frequencyPenalty : 0.85;
    this.presencePenalty = typeof opts.presencePenalty === 'number' ? opts.presencePenalty : 0.7;
  }

  async _doChat(messages, opts = {}) {
    // 空 reply / 瞬时传输故障自动重试（不加 AbortSignal 超时——owner 红线；只重发请求）。
    // 流式（onDelta）一旦开始吐字就可能已有部分早鸟 TTS 副作用，且重试会重复回调，
    // 故流式分支不重试（交由上层 VoiceSession 的 adapter 链兜底）。
    const retries = (opts.onDelta || opts._noRetry) ? 0 : resolveEmptyRetries();
    // 熔断器（flag NOE_MODEL_CIRCUIT_BREAKER=1 默认 OFF，cb=null 时整段零回归）：连续 transient 失败达阈值后
    //   短期跳过调用、快速失败，减少不可用 quorum 模型每轮 retry 的噪音/往返；不改 quorum 语义——短路仍抛错，
    //   上层按 unavailable 处理（与 retry 耗尽一致），冷却期满放行半开试探（仍动态探测，非永久写死）。
    const cb = resolveCircuitBreakerConfig().enabled ? getSharedCircuitBreaker() : null;
    const cbId = this.id || 'openai-compat';
    if (cb && cb.shouldShortCircuit(cbId)) {
      const err = new Error(`circuit_breaker_open(${cbId}): cooling down, skip call`);
      // @ts-ignore — 自定义错误码供上层识别（按 unavailable 处理）
      err.code = 'MODEL_CIRCUIT_OPEN';
      throw err;
    }
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const r = await this._doChatOnce(messages, opts);
        if (cb) cb.recordSuccess(cbId);
        return r;
      } catch (e) {
        lastErr = e;
        const isEmpty = e?.code === EMPTY_REPLY_ERROR;
        const isTransient = isTransientTransportError(e);
        // 空 reply 与传输故障都计入熔断：owner 目标是压制"不可用模型刷请求/刷日志"，持续空 reply 同样是刷请求；
        //   4xx/鉴权/业务错误不命中 isTransient/isEmpty，自然不计入（那是配置/语义问题，熔断会掩盖）。
        if (cb && (isTransient || isEmpty)) cb.recordFailure(cbId);
        if (attempt < retries && (isEmpty || isTransient)) {
          // 熔断刚因本次失败打开 → 中止剩余 retry：端点已判定不可用，继续 retry 只会再失败、徒增往返
          //   （治 threshold=1 时首次调用仍发满 retries+1 次 fetch 的问题；flag OFF 时 cb=null 不触发，零回归）。
          if (cb && cb.isOpen(cbId)) throw e;
          // 错误归因日志：区分"模型真返回空" vs "传输/网络故障返空"，便于事后定位是哪一层。
          const reason = isEmpty ? 'empty_reply(model_returned_blank)' : 'transient_transport(network_or_adapter_fault)';
          console.warn(`[${this.id || 'openai-compat'}] retry ${attempt + 1}/${retries} reason=${reason} msg=${String(e?.message || e).slice(0, 160)}`);
          continue;
        }
        throw e;
      }
    }
    throw lastErr; // 不可达（循环内必 return 或 throw），仅为类型完备
  }

  async _doChatOnce(messages, opts = {}) {
    if (!this.apiKey) throw new Error(`${this.displayName} 缺少 apiKey`);
    if (!this.baseUrl) throw new Error(`${this.displayName} 缺少 baseUrl`);
    const model = opts.model || this.model;
    if (!model) throw new Error(`${this.displayName} 缺少 model`);
    const url = `${this.baseUrl.replace(/\/$/, '')}${this.chatPath}`;

    const oaiMessages = messages.map(m => ({
      role: m.role === 'system' ? 'system' : (m.role === 'assistant' ? 'assistant' : 'user'),
      content: m.speaker ? `[${m.speaker}] ${m.content}` : m.content,
    }));

    const temperature = typeof opts.temperature === 'number' ? opts.temperature : this.temperature;
    const topP = typeof opts.topP === 'number' ? opts.topP : (typeof opts.top_p === 'number' ? opts.top_p : this.topP);
    const reasoningEffort = normalizeReasoningEffort(opts.reasoningEffort ?? opts.reasoning_effort ?? this.reasoningEffort);
    const maxTokens = typeof opts.maxTokens === 'number'
      ? opts.maxTokens
      : (typeof opts.maxCompletionTokens === 'number' ? opts.maxCompletionTokens : this.maxTokens);
    // 流式（方向三·LLM 流式）：调用方传 onDelta 回调才开 SSE stream——边吐字边回调（语音首句早鸟 TTS 用），
    // 最终仍返回与非流式完全同形的 {reply, tokensIn, tokensOut}，上层零感知。LmStudio 子类自动继承。
    const streaming = typeof opts.onDelta === 'function';
    const body = {
      model,
      messages: oaiMessages,
      temperature,
    };
    // 默认抗复读；omitPenalties 时跳过（xAI Grok 4.5 拒 presencePenalty）
    if (!this.omitPenalties) {
      body.frequency_penalty = this.frequencyPenalty;  // 强力抗逐字复读
      body.presence_penalty = this.presencePenalty;    // 强力鼓励说新内容
    }
    if (typeof topP === 'number') body.top_p = topP;
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;
    if (opts.response_format && typeof opts.response_format === 'object') body.response_format = opts.response_format;
    else if (opts.responseFormat && typeof opts.responseFormat === 'object') body.response_format = opts.responseFormat;
    if (maxTokens > 0) body.max_tokens = maxTokens;   // v0.52 0=不传
    if (streaming) {
      body.stream = true;
      body.stream_options = { include_usage: true };  // OpenAI 规范：末尾 chunk 带 usage（不支持的服务忽略，token 记 0）
    }

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
        throw new Error(`${this.displayName} ${resp.status}: ${errText.slice(0, 300)}`);
      }
      if (streaming) {
        // SSE 逐行解析：`data: {...}`，终止符 `data: [DONE]`；onDelta 回调异常不阻断生成。
        let full = '';
        let tokensIn = 0;
        let tokensOut = 0;
        let buf = '';
        let finishReason = '';
        const decoder = new TextDecoder();
        for await (const chunk of resp.body) {
          buf += decoder.decode(chunk, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let j;
            try { j = JSON.parse(payload); } catch { continue; }
            const piece = j?.choices?.[0]?.delta?.content || '';
            if (piece) {
              full += piece;
              try { opts.onDelta(piece); } catch { /* 回调异常不阻断生成 */ }
            }
            if (j?.usage) { tokensIn = j.usage.prompt_tokens || 0; tokensOut = j.usage.completion_tokens || 0; }
            if (j?.choices?.[0]?.finish_reason) finishReason = j.choices[0].finish_reason;
          }
        }
        const reply = full.trim();
        const completion = completionStatusForFinishReason(finishReason);
        if (!reply && !completion.incomplete) {
          const err = new Error(`${this.displayName} 响应空 reply`);
          err.code = EMPTY_REPLY_ERROR;
          throw err;
        }
        return { reply, tokensIn, tokensOut, ...completion, raw: { streamed: true, finish_reason: finishReason, ...completion } };
      }
      const data = await resp.json();
      const choice = data?.choices?.[0] || {};
      const reply = choice?.message?.content?.trim() || '';
      const usage = data?.usage || {};
      const completion = completionStatusForFinishReason(choice?.finish_reason || data?.finish_reason || '');
      if (!reply && !completion.incomplete) {
        const err = new Error(`${this.displayName} 响应空 reply`);
        err.code = EMPTY_REPLY_ERROR;
        throw err;
      }
      return {
        reply,
        tokensIn: usage.prompt_tokens || 0,
        tokensOut: usage.completion_tokens || 0,
        ...completion,
        raw: { ...data, ...completion },
      };
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error(`${this.displayName} 超时 ${this.timeout}ms`);
      throw e;
    } finally {
      if (externalAbortHandler && opts.abortSignal) {
        opts.abortSignal.removeEventListener('abort', externalAbortHandler);
      }
    }
  }
}
