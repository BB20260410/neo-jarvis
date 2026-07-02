// createBrainChat — 把 BrainRouter + adapter 池封装成一个 chat(messages, opts) => ({reply}) 函数。
// 供 research / skillExtract 等内部能力复用：默认按 BrainRouter 选档(闲聊压本地省 token)，
// 主 adapter 失败按 fallback 链兜底；遵守"跑模型不设超时"——绝不 abort LLM 调用。
export function createBrainChat({ getAdapter = null, brainRouter = null, taskId = 'noe-internal' } = {}) {
  return async (messages, opts = {}) => {
    const text = messages?.[messages.length - 1]?.content || '';
    // owner 2026-06-17：取消本地 abliterated，默认 adapter 与兜底链退 lmstudio 主脑(qwen3.6-35b，不再 ollama)。
    const decision = brainRouter ? brainRouter.route({ text }) : { adapterId: 'lmstudio', fallbacks: [] };
    const chain = [...new Set([decision.adapterId, ...(Array.isArray(decision.fallbacks) ? decision.fallbacks : []), 'lmstudio'])];
    let lastErr = null;
    for (const aid of chain) {
      const a = getAdapter ? getAdapter(aid) : null;
      if (!a || typeof a.chat !== 'function') continue;
      try { const r = await a.chat(messages, { ...opts, budgetContext: { taskId } }); if (r?.reply) return r; } catch (e) { lastErr = e; }
    }
    throw new Error(`大脑不可用(${taskId}): ${lastErr?.message || chain.join('→')}`);
  };
}
