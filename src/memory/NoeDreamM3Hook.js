// NoeDreamM3Hook — 用 M3 当"记忆整合大脑"的 llmConsolidate 实现(语义去重)。
//
// 注入 NoeDreamConsolidation 的 createMemoryDreamLoop({ llmConsolidate }) 即让梦境整合具备语义去重。
// chat 可注入(测试用 fake,不烧 M3);默认用 MiniMaxChatAdapter(烧 M3 额度——已获 owner 永久授权)。
// 安全:只产合并建议,真正落地仍走 NoeMemoryConsolidator 的安全闸(不碰受保护)+ MemoryCore 软删(可恢复)。
// Adapted from BaiLongma (MIT) src/memory/consolidator.js 的整合器提示词。
import { MiniMaxChatAdapter } from '../room/MiniMaxChatAdapter.js';
import { OllamaChatAdapter } from '../room/OllamaChatAdapter.js';
import { OpenAICompatChatAdapter } from '../room/OpenAICompatChatAdapter.js';
import { parseNoeLlmJsonValue } from '../runtime/NoeLlmJsonExtractor.js';
import { resolveNoeProviderSecret } from '../secrets/NoeProviderSecrets.js';
import { normalizeForDedup } from './NoeMemoryDedup.js';

const CONSOLIDATOR_PROMPT = [
  '你是记忆整合器。只从下面的记忆里找出【语义重复】(说同一件事的不同表述)的组。',
  '不要新建记忆、不要改写内容、不要合并互相矛盾的记忆(矛盾是信号不是噪声)。拿不准就不合并。',
  '只输出一个 JSON 数组,每项形如 {"keepId":"措辞最好那条的id","keepQuote":"keep那条开头的原文摘抄(至少6个字,逐字照抄)",',
  '"dropIds":["被并入的id"],"dropQuotes":["每条drop开头的原文摘抄,与dropIds一一对应"],"reason":"为什么是重复"}。',
  'keepQuote/dropQuotes 必须逐字摘自对应 id 那条记忆的原文——抄错会导致该条建议被整组丢弃。',
  '没有可合并的就输出 []。除 JSON 外不要任何文字。',
].join('\n');

/** quote 自证：摘抄(归一化后≥4字符)必须出现在该 id 的记忆原文里——模型把 UUID 抄错位时,
 *  语义正确的摘抄对不上错位 id 的内容,该合并即被拒。 */
function quoteMatches(contentById, id, quote) {
  const body = normalizeForDedup(contentById.get(String(id)) || '');
  const q = normalizeForDedup(quote || '');
  return q.length >= 4 && body.includes(q);
}

/**
 * 从模型回复里稳健解析合并建议(复用 LLM JSON parser;过滤非法/越界 id)。纯函数,可测。
 * 传 contentById(id→原文 Map)时启用 quote 自证(2026-06-11 实损修复:M3 批量 JSON 输出把
 * keepId 抄错位,两条夜反思 insight 被并进毫不相干的 fact/proactive 记忆——validIds 防编造
 * 防不了错位;词面相似度闸又会误杀"词面不同语义同"的合法合并,故要求模型摘抄原文自证)。
 */
export function parseMerges(reply, validIds = null, contentById = null) {
  if (!reply) return [];
  const arr = parseNoeLlmJsonValue(reply, null);
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) {
    if (!x || x.keepId == null || !Array.isArray(x.dropIds)) continue;
    const keepId = String(x.keepId);
    if (validIds && !validIds.has(keepId)) continue;
    if (contentById && !quoteMatches(contentById, keepId, x.keepQuote)) continue; // keep 自证失败 → 整组拒
    let dropIds = x.dropIds.map(String).filter((id) => id !== keepId && (!validIds || validIds.has(id)));
    if (contentById) {
      const quotes = Array.isArray(x.dropQuotes) ? x.dropQuotes : [];
      const rawDrops = x.dropIds.map(String);
      dropIds = dropIds.filter((id) => quoteMatches(contentById, id, quotes[rawDrops.indexOf(id)])); // 单条 drop 自证失败 → 只剔该条
    }
    if (dropIds.length) out.push({ keepId, dropIds, reason: String(x.reason || 'llm_semantic_duplicate').slice(0, 200) });
  }
  return out;
}

/**
 * 建一个 llmConsolidate(candidates)=>merges[] 钩子。
 * @param {object} [opts]
 * @param {(prompt:string)=>Promise<string>} [opts.chat] 注入式聊天(测试用);默认走 M3。
 * @param {number} [opts.maxItems] 单次最多喂多少条(控成本/上下文)。
 */
// 解析模型规格 "provider:model"(model 可含冒号,如 ollama:qwen3.5:2b)。'none'/空 → null(纯确定性不调 LLM)。
export function parseModelSpec(spec) {
  const s = String(spec ?? '').trim();
  if (!s || s.toLowerCase() === 'none') return null;
  const i = s.indexOf(':');
  return i < 0 ? { provider: s, model: '' } : { provider: s.slice(0, i), model: s.slice(i + 1) };
}

// 按 provider 造一个 (prompt)=>Promise<reply>。本地 Ollama 免配额(默认 think:false 适合杂活);
// minimax=M3,xiaomi=MiMo。密钥缺失时返回空串(→ 上层回退纯确定性)。
// export:梦境升华(NoeEpisodeSublimation)复用同一 provider 通道,不另造聊天轮子。
export function buildChat(provider, model, baseUrl) {
  const p = String(provider || 'minimax').toLowerCase();
  if (p === 'ollama' || p === 'local' || p === 'lmstudio') {
    const adapter = new OllamaChatAdapter({ baseUrl: baseUrl || process.env.OLLAMA_BASE_URL, model: model || undefined });
    return async (prompt) => {
      const r = await adapter._doChat([{ role: 'user', content: prompt }], { think: false, model: model || undefined });
      return r?.reply || '';
    };
  }
  if (p === 'xiaomi' || p === 'mimo' || p === 'openai-compat') {
    const s = resolveNoeProviderSecret('xiaomi');
    if (!s?.value) return async () => '';
    const adapter = new OpenAICompatChatAdapter({ id: 'xiaomi-mimo', displayName: 'Xiaomi MiMo', apiKey: s.value, baseUrl: baseUrl || process.env.XIAOMI_BASE_URL || 'https://token-plan-cn.xiaomimimo.com/v1', model: model || 'mimo-v2.5-pro', timeout: 0, maxTokens: 4096 });
    return async (prompt) => {
      const r = await adapter._doChat([{ role: 'user', content: prompt }], { noAbort: true, model: model || 'mimo-v2.5-pro', maxTokens: 4096 });
      return r?.reply || '';
    };
  }
  // 默认 minimax(M3)
  const s = resolveNoeProviderSecret('minimax');
  if (!s?.value) return async () => '';
  const adapter = new MiniMaxChatAdapter({ apiKey: s.value, baseUrl: baseUrl || process.env.MINIMAX_BASE_URL, model: model || 'MiniMax-M3' });
  return async (prompt) => {
    const r = await adapter._doChat([{ role: 'user', content: prompt }], { noAbort: true });
    return r?.reply || '';
  };
}

/**
 * 建一个 llmConsolidate(candidates)=>merges[] 钩子,模型可选。
 * @param {object} [opts]
 * @param {string} [opts.provider] 'minimax'(M3) | 'ollama'(本地免配额) | 'xiaomi'(MiMo)
 * @param {string} [opts.model]    具体模型名(ollama 如 'qwen3.5:2b';minimax 如 'MiniMax-M3')
 * @param {(prompt:string)=>Promise<string>} [opts.chat] 注入式(测试用,覆盖 provider)
 */
export function createConsolidateHook({ provider = 'minimax', model = '', baseUrl = '', chat = null, maxItems = 40 } = {}) {
  const callChat = chat || buildChat(provider, model, baseUrl);
  return async function llmConsolidate(candidates = []) {
    const items = (Array.isArray(candidates) ? candidates : []).slice(0, maxItems);
    if (items.length < 2) return [];
    const list = items.map((c) => `id=${c.id} | ${String(c.content || c.title || '').slice(0, 200)}`).join('\n');
    let reply = '';
    try { reply = await callChat(`${CONSOLIDATOR_PROMPT}\n\n记忆列表:\n${list}`); } catch { return []; }
    const contentById = new Map(items.map((c) => [String(c.id), String(c.content || c.title || '')]));
    return parseMerges(reply, new Set(items.map((c) => String(c.id))), contentById);
  };
}

/** 向后兼容:M3 专用钩子 = createConsolidateHook({provider:'minimax'})。 */
export function createM3ConsolidateHook(opts = {}) {
  return createConsolidateHook({ ...opts, provider: 'minimax', model: opts.model || 'MiniMax-M3' });
}
