// @ts-check
// OpenAICompatCompletion — 「从半截续写」底层能力（Neo 现状只有 chat completions 无法从思考中途续推）。
//
// 背景：s1 budget forcing 的本质是「拦住模型想结束的信号 → 把已生成的思考拼回去 → 让它接着往下写」。
//   这需要一条 *续写* 通道：给定一段 prefix（已有思考 + 诱导词），让模型从那段文本的末尾继续生成。
//   OpenAI chat/completions 做不到（它只接受成对消息、自己重起一段 assistant 回复）。本模块补上这条通道：
//     ① 首选 /v1/completions（text completion，原生支持 prompt 续写）——LM Studio / vLLM / 多数本地服务都有；
//     ② 探测不到/报错则回退 chat + 末尾 assistant 消息（OpenAI 规范的 assistant-prefix 续写约定，
//        LM Studio 对多数模型也认；不认就当普通 chat，至少不报错）。
//
// 设计：注入式（DI）纯模块，不继承 RoomAdapter、不碰断路器/限流（深思是内部本地作业，
//   budget forcing 自己控轮数，不该再被 chat() 的 resilience 包一层）。无新依赖；不设模型硬超时
//   （遵循 feedback_no_model_timeout，仅探测给一个短的可选超时，且失败即回退不阻断）。
//   不打印 secret（apiKey 只进 Authorization 头，绝不进任何 console/返回值）。
//
// 与 NoeBudgetForcing.runBudgetForcedThinking 的关系：本模块提供 complete()，bridge
//   (NoeBudgetForcedDeliberation) 把它包成 runBudgetForcedThinking 需要的 generate(ctx)。

/** /v1/completions 探测结果缓存值。 */
export const COMPLETION_MODE = Object.freeze({
  RAW: 'raw_completions', // /v1/completions 可用：真·prefix 续写
  CHAT_PREFIX: 'chat_prefix', // 回退：chat + 末尾 assistant 消息续写
  UNKNOWN: 'unknown', // 尚未探测
});

function trimBase(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

function stopList(stop) {
  if (stop == null) return [];
  const arr = Array.isArray(stop) ? stop : [stop];
  return arr.map((s) => String(s)).filter((s) => s.length > 0).slice(0, 4); // OpenAI 上限 4
}

/**
 * 创建续写能力。注入 baseUrl/apiKey/fetchImpl 便于单测（不发真网络）。
 *
 * @param {object} args
 * @param {string} args.baseUrl   形如 http://127.0.0.1:1234/v1
 * @param {string} [args.apiKey] Bearer（默认 lm-studio；绝不打印）
 * @param {string} [args.completionsPath] 续写端点（默认 /completions）
 * @param {string} [args.chatPath] 回退 chat 端点（默认 /chat/completions）
 * @param {typeof fetch} [args.fetchImpl]
 * @param {{warn?:(m:string)=>void}} [args.log]
 * @param {number} [args.probeTimeoutMs] 仅探测用的短超时（默认 4000；生成不设超时）
 */
export function createCompletionCapability({
  baseUrl,
  apiKey = 'lm-studio',
  completionsPath = '/completions',
  chatPath = '/chat/completions',
  fetchImpl = fetch,
  log = console,
  probeTimeoutMs = 4000,
} = {}) {
  const base = trimBase(baseUrl);
  if (!base) throw new Error('createCompletionCapability: 缺少 baseUrl');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  let mode = COMPLETION_MODE.UNKNOWN;
  let probing = null; // 同一能力实例并发只探测一次

  /** 探测 /v1/completions 是否可用：发一个 1 token 的极小请求看是否被服务端接受。
   *  非 404/不存在端点 → 认为可用（RAW）；明确不支持 → 回退 CHAT_PREFIX。fail→CHAT_PREFIX（保守可用）。 */
  async function probe() {
    if (mode !== COMPLETION_MODE.UNKNOWN) return mode;
    if (probing) return probing;
    probing = (async () => {
      const ctrl = new AbortController();
      const t = probeTimeoutMs > 0 ? setTimeout(() => ctrl.abort(), probeTimeoutMs) : null;
      try {
        const resp = await fetchImpl(`${base}${completionsPath}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: 'probe', prompt: ' ', max_tokens: 1, temperature: 0 }),
          signal: ctrl.signal,
        });
        // 404 / 405 / 501 = 该服务没有 text completions 端点 → 回退。
        if (resp.status === 404 || resp.status === 405 || resp.status === 501) {
          mode = COMPLETION_MODE.CHAT_PREFIX;
        } else {
          // 其余（200 / 400 模型名非法 / 401 等）都说明端点 *存在*，续写时用真模型名即可。
          mode = COMPLETION_MODE.RAW;
        }
      } catch {
        // 探测超时/网络层失败：保守回退 chat-prefix（绝不因探测失败阻断深思）。
        mode = COMPLETION_MODE.CHAT_PREFIX;
      } finally {
        if (t) clearTimeout(t);
      }
      return mode;
    })();
    try { return await probing; } finally { probing = null; }
  }

  /** 强制设定模式（单测/调用方已知端点时跳过探测）。 */
  function setMode(m) { if (Object.values(COMPLETION_MODE).includes(m)) mode = m; return mode; }
  function currentMode() { return mode; }

  function parseRawText(data) {
    const choice = data?.choices?.[0] || {};
    const text = choice?.text ?? choice?.message?.content ?? '';
    const finish = choice?.finish_reason || data?.finish_reason || '';
    const usage = data?.usage || {};
    return { text: String(text || ''), finishReason: String(finish || ''), tokensOut: usage.completion_tokens || 0 };
  }

  /**
   * 从 prefix 续写一段文本。
   * @param {object} a
   * @param {string} a.prompt      要续写的完整 prefix（含 think 起手 + 已有思考 + 诱导词）
   * @param {string} a.model
   * @param {number} [a.maxTokens] 本轮生成上限（一次 budget 步的产出，不是总预算）
   * @param {number} [a.temperature]
   * @param {(string|string[])} [a.stop] 停止符（如 ['</think>']）——命中即本轮停
   * @param {AbortSignal} [a.abortSignal] 外部中断（不设硬超时）
   * @param {Array<{role:string,content:string}>} [a.priorMessages] CHAT_PREFIX 回退时拼在前面的上下文
   * @returns {Promise<{text:string, finishReason:string, hitStop:boolean, tokensOut:number, via:string}>}
   */
  async function complete({ prompt, model, maxTokens, temperature, stop, abortSignal, priorMessages = [] } = {}) {
    if (!model) throw new Error('completion.complete: 缺少 model');
    const m = await probe();
    const stops = stopList(stop);
    const body = {
      model,
      max_tokens: typeof maxTokens === 'number' && maxTokens > 0 ? Math.floor(maxTokens) : undefined,
      ...(typeof temperature === 'number' ? { temperature } : {}),
      ...(stops.length ? { stop: stops } : {}),
    };

    if (m === COMPLETION_MODE.RAW) {
      try {
        const resp = await fetchImpl(`${base}${completionsPath}`, {
          method: 'POST', headers, signal: abortSignal,
          body: JSON.stringify({ ...body, prompt: String(prompt || '') }),
        });
        if (resp.ok) {
          const data = await resp.json();
          const out = parseRawText(data);
          return { ...out, hitStop: out.finishReason === 'stop', via: COMPLETION_MODE.RAW };
        }
        // 运行期 RAW 端点失效（如模型不支持续写）→ 降级到 chat-prefix，并把模式记成回退避免反复打。
        mode = COMPLETION_MODE.CHAT_PREFIX;
        try { log?.warn?.(`[noe-completion] /completions 运行期回退 chat-prefix（status=${resp.status}）`); } catch { /* ignore */ }
      } catch (e) {
        if (abortSignal?.aborted) throw e;
        mode = COMPLETION_MODE.CHAT_PREFIX;
        try { log?.warn?.('[noe-completion] /completions 运行期异常，回退 chat-prefix'); } catch { /* ignore */ }
      }
    }

    // CHAT_PREFIX 回退：把 prefix 作为末尾 assistant 消息，让服务端从它后面继续（OpenAI assistant-prefix 约定）。
    const messages = [
      ...(Array.isArray(priorMessages) ? priorMessages : []),
      { role: 'assistant', content: String(prompt || '') },
    ];
    const resp = await fetchImpl(`${base}${chatPath}`, {
      method: 'POST', headers, signal: abortSignal,
      body: JSON.stringify({ ...body, messages }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`completion(chat-prefix) ${resp.status}: ${String(errText).slice(0, 200)}`);
    }
    const data = await resp.json();
    const choice = data?.choices?.[0] || {};
    const text = String(choice?.message?.content ?? choice?.text ?? '');
    const finishReason = String(choice?.finish_reason || '');
    return {
      text,
      finishReason,
      // chat 回退下，命中我们传入的 stop 也表现为 finish_reason='stop'。
      hitStop: finishReason === 'stop',
      tokensOut: data?.usage?.completion_tokens || 0,
      via: COMPLETION_MODE.CHAT_PREFIX,
    };
  }

  return { probe, complete, setMode, currentMode };
}
