// OllamaChatAdapter — 本地 Ollama 大脑（语音/主动/聊天室共用，零成本零外发）
// 用 ollama 原生 /api/chat（非 /v1）：唯一能可靠关 thinking 的端点，real-time 场景默认关 thinking。

import { RoomAdapter } from './RoomAdapter.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';
// 语音默认大脑：qwen3.5 去审查 4b（中文优于 gemma3:4b，同 3.3GB 同级速度）。可经 NOE_OLLAMA_MODEL 覆盖回滚。
const DEFAULT_MODEL = process.env.NOE_OLLAMA_MODEL || 'huihui_ai/qwen3.5-abliterated:4b';

export class OllamaChatAdapter extends RoomAdapter {
  constructor(opts = {}) {
    super({
      id: opts.id || 'ollama',
      displayName: opts.displayName || '🔵 Ollama',
      model: opts.model || DEFAULT_MODEL,
      timeout: Object.prototype.hasOwnProperty.call(opts, 'timeout') ? opts.timeout : 0,
    });
    this.baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
    this.temperature = typeof opts.temperature === 'number' ? opts.temperature : 0.4;
    this.maxTokens = typeof opts.maxTokens === 'number' ? opts.maxTokens : 8192;
  }

  async _doChat(messages, opts = {}) {
    // ollama 原生 /api/chat（非 /v1/chat/completions）：唯一能可靠关 thinking 的端点。
    const url = `${this.baseUrl.replace(/\/$/, '')}/api/chat`;
    // 直接转 messages 数组（speaker 信息塞进 content 头）
    const oaiMessages = messages.map(m => ({
      role: m.role === 'system' ? 'system' : (m.role === 'user' ? 'user' : 'assistant'),
      content: m.speaker ? `[${m.speaker}] ${m.content}` : m.content,
    }));
    const maxTokens = typeof opts.maxTokens === 'number'
      ? opts.maxTokens
      : (typeof opts.maxCompletionTokens === 'number' ? opts.maxCompletionTokens : this.maxTokens);
    const options = { temperature: typeof opts.temperature === 'number' ? opts.temperature : this.temperature };
    if (maxTokens > 0) options.num_predict = maxTokens;
    // 流式（方向三·LLM 流式）：调用方传 onDelta 回调才开 stream——边吐字边回调（语音首句早鸟 TTS 用），
    // 最终仍返回与非流式完全同形的 {reply, tokensIn, tokensOut}，resilience 壳/上层调用方零感知。
    const streaming = typeof opts.onDelta === 'function';
    const body = {
      model: opts.model || this.model,
      messages: oaiMessages,
      stream: streaming,
      options,
      // 默认关 thinking：real-time 大脑（语音/主动/聊天室）不浪费时间想，qwen3.5 默认开会拖首字节并污染语音；
      // gemma 等无 thinking 模型忽略此字段（已实测无报错）。显式要推理链才传 opts.think === true。
      think: opts.think === true,
    };

    const controller = new AbortController();
    const timer = opts.noAbort === true || this.timeout <= 0 ? null : setTimeout(() => controller.abort(), this.timeout);
    // 串联外部 abortSignal（v0.43: 保留 handler 引用以 removeEventListener 防泄漏）
    let externalAbortHandler = null;
    if (opts.abortSignal) {
      if (opts.abortSignal.aborted) {
        if (timer) clearTimeout(timer);
        throw new Error('Ollama 被中断');
      }
      externalAbortHandler = () => controller.abort();
      opts.abortSignal.addEventListener('abort', externalAbortHandler, { once: true });
    }

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ollama' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (timer) clearTimeout(timer);
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`Ollama ${resp.status}: ${errText.slice(0, 300)}`);
      }
      if (streaming) {
        // NDJSON 逐行解析：每行 {message:{content}, done}；done 行带 token 计数。
        // onDelta 回调异常不阻断生成（早鸟 TTS 是锦上添花，绝不拖垮主链）。
        let full = '';
        let tokensIn = 0;
        let tokensOut = 0;
        let buf = '';
        const decoder = new TextDecoder();
        for await (const chunk of resp.body) {
          buf += decoder.decode(chunk, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let j;
            try { j = JSON.parse(line); } catch { continue; }
            const piece = j?.message?.content || '';
            if (piece) {
              full += piece;
              try { opts.onDelta(piece); } catch { /* 回调异常不阻断生成 */ }
            }
            if (j?.done) { tokensIn = j.prompt_eval_count || 0; tokensOut = j.eval_count || 0; }
          }
        }
        const reply = full.trim();
        if (!reply) throw new Error('Ollama 响应空 reply');
        return { reply, tokensIn, tokensOut, raw: { streamed: true } };
      }
      const data = await resp.json();
      // /api/chat 原生响应：message.content（thinking 进独立 message.thinking 字段，不污染 content）+ prompt_eval_count/eval_count
      const reply = data?.message?.content?.trim() || '';
      if (!reply) throw new Error('Ollama 响应空 reply');
      return {
        reply,
        tokensIn: data?.prompt_eval_count || 0,
        tokensOut: data?.eval_count || 0,
        raw: data,
      };
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error(`Ollama 超时 ${this.timeout}ms`);
      throw e;
    } finally {
      if (externalAbortHandler && opts.abortSignal) {
        opts.abortSignal.removeEventListener('abort', externalAbortHandler);
      }
    }
  }
}
