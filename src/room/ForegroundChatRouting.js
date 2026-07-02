// @ts-check

// owner 2026-06-22 模型额度优先级：M3(minimax) → codex(GPT5.5) → Claude(4.8)。M3 掉线/额度不足才降级，Claude 最后兜底（最贵）。
export const DEFAULT_CLOUD_CHAT_CHAIN = Object.freeze(['minimax', 'codex', 'claude', 'gemini', 'gemini-openai', 'gemini-cli', 'litellm']);
// owner 2026-06-17：取消本地 abliterated(ollama/ollama-9b)，本地 chat 只剩 lmstudio 主脑(qwen3.6-35b，动态跟 NOE_MAIN_BRAIN)。
export const DEFAULT_LOCAL_CHAT_ADAPTERS = Object.freeze(['lmstudio']);

function clean(value) {
  return String(value || '').trim();
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

export function parseAdapterChain(value, fallback = DEFAULT_CLOUD_CHAT_CHAIN) {
  if (Array.isArray(value)) return unique(value);
  const text = clean(value);
  if (!text) return [...fallback];
  return unique(text.split(','));
}

export function parseForegroundChatRoutingEnv(env = process.env) {
  return {
    cloudOnly: !['0', 'false', 'off', 'no'].includes(clean(env.NOE_CHAT_CLOUD_ONLY || '1').toLowerCase()),
    cloudAdapterChain: parseAdapterChain(env.NOE_CHAT_CLOUD_CHAIN, DEFAULT_CLOUD_CHAT_CHAIN),
    localAdapterIds: parseAdapterChain(env.NOE_CHAT_LOCAL_ADAPTERS, DEFAULT_LOCAL_CHAT_ADAPTERS),
  };
}

export function isLocalChatAdapter(adapterId, localAdapterIds = DEFAULT_LOCAL_CHAT_ADAPTERS) {
  const id = clean(adapterId);
  return Boolean(id) && new Set(localAdapterIds.map(clean)).has(id);
}

export function resolveForegroundChatChain({
  decision = null,
  profileChain = null,
  cloudOnly = false,
  cloudAdapterChain = DEFAULT_CLOUD_CHAT_CHAIN,
  localAdapterIds = DEFAULT_LOCAL_CHAT_ADAPTERS,
} = {}) {
  const decisionChain = unique([decision?.adapterId, ...(Array.isArray(decision?.fallbacks) ? decision.fallbacks : [])]);
  const profile = Array.isArray(profileChain) && profileChain.length ? unique(profileChain) : [];
  const cloud = parseAdapterChain(cloudAdapterChain, DEFAULT_CLOUD_CHAT_CHAIN);
  const local = new Set(parseAdapterChain(localAdapterIds, DEFAULT_LOCAL_CHAT_ADAPTERS));

  if (!cloudOnly) {
    return unique([...profile, ...decisionChain, 'lmstudio']); // abliterated 卸载，本地兜底退 lmstudio 主脑
  }

  const preferredCloud = profile.filter((id) => !local.has(id));
  // cloudOnly 优先云脑，但末尾追加本地脑作【最后兜底】——云脑全挂时 Neo 用本地脑回话而非彻底哑
  //   （owner 2026-06-18：宁可本地慢回也别完全回不了话）。正常云脑可用时 localTail 在最末永远轮不到，零影响。
  const localTail = parseAdapterChain(localAdapterIds, DEFAULT_LOCAL_CHAT_ADAPTERS);
  return unique([...preferredCloud, ...cloud, ...localTail]);
}

export function firstAvailableChatAdapter(chain = [], hasAdapter = () => true) {
  return unique(chain).find((id) => {
    try { return hasAdapter(id) === true; } catch { return false; }
  }) || '';
}
