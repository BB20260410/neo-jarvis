// @ts-check
// rank7 结构化输出封装：把「LLM 调用 → 解析 → 校验」做成稳健的一步，治认知路径脆弱 JSON.parse/正则吞数据
//   （诊断点名：insights=0 是解析吞洞察、VAD/期望结算/记忆抽取靠裸 parse）。
// 三档降级：json_schema（最强约束）→ json_object（JSON 模式）→ text（纯文本 + parseNoeLlmJson 兜底）；
//   每档解析后用 zod schema 校验，失败自动降级重试。本地模型不支持 json_schema 时优雅退化，绝不硬崩。
// 全注入式（adapter 注入），不设硬超时（跑模型纪律）。

import { parseNoeLlmJson } from './NoeLlmJsonExtractor.js';

const TIERS = Object.freeze(['json_schema', 'json_object', 'text']);

/**
 * 构造 OpenAI 风格的 response_format 参数。
 * - 当 tier 为 'json_schema' 且提供 jsonSchema 对象时，返回带 strict: true 的 json_schema 格式，强制模型输出严格符合 Schema 的 JSON。
 * - 当 tier 为 'json_object' 时，返回 { type: 'json_object' }，要求模型输出合法 JSON 对象。
 * - 当 tier 为 'text' 或条件不满足时，返回 null，表示不指定 response_format，由模型自由输出文本（后续由 parseNoeLlmJson 兜底解析）。
 *
 * @param {string} tier - 降级档位：'json_schema' | 'json_object' | 'text'
 * @param {object} [options] - 配置项
 * @param {object|null} [options.jsonSchema=null] - JSON Schema 对象，仅在 tier='json_schema' 时生效
 * @param {string} [options.name='noe_structured'] - json_schema 的名称标识
 * @returns {{type:'json_schema',json_schema:{name:string,schema:object,strict:boolean}}|{type:'json_object'}|null}
 */
export function buildNoeResponseFormat(tier, { jsonSchema = null, name = 'noe_structured' } = {}) {
  if (tier === 'json_schema' && jsonSchema && typeof jsonSchema === 'object') {
    return { type: 'json_schema', json_schema: { name, schema: jsonSchema, strict: true } };
  }
  if (tier === 'json_object') return { type: 'json_object' };
  return null;
}

/**
 * 稳健结构化调用：adapter.chat → parseNoeLlmJson → zod 校验，失败按 json_schema→json_object→text 降级重试。
 * @param {{adapter:any, messages:any[], zodSchema?:any, jsonSchema?:object|null, opts?:object, name?:string, startTier?:string}} args
 * @returns {Promise<{ok:boolean, value:any, tier?:string, attempts:number, error?:string}>}
 */
export async function noeStructuredCall({
  adapter,
  messages,
  zodSchema = null,   // zod schema：校验解析结果（可空=只解析不校验）
  jsonSchema = null,  // JSON Schema：json_schema 档传给模型（可空=从 json_object 起降级）
  opts = {},
  name = 'noe_structured',
  startTier = jsonSchema ? 'json_schema' : 'json_object',
  // Instructor re-ask：本档解析/校验失败时把错误回喂模型重试同档（默认从 env，0=OFF 行为同原）。硬上限 3 防死循环。
  maxReask = Number(process.env.NOE_STRUCTURED_REASK) || 0,
} = {}) {
  if (!adapter || typeof adapter.chat !== 'function') {
    return { ok: false, value: null, attempts: 0, error: 'adapter_unavailable' };
  }
  const startIdx = Math.max(0, TIERS.indexOf(startTier));
  const reaskCap = Math.max(0, Math.min(3, Number.isFinite(+maxReask) ? Math.floor(+maxReask) : 0)); // 硬上限 3 防死循环
  let lastError = 'no_attempt';
  let attempts = 0;
  for (let i = startIdx; i < TIERS.length; i += 1) {
    const tier = TIERS[i];
    const responseFormat = buildNoeResponseFormat(tier, { jsonSchema, name });
    // Instructor re-ask 内循环：本档失败把错误回喂模型重试，最多 reaskCap 次（reaskCap=0 时仅 1 轮，行为同原）。
    let reaskMessages = messages;
    for (let attempt = 0; attempt <= reaskCap; attempt += 1) {
      attempts += 1;
      let text = '';
      try {
        // 不设硬超时（跑模型纪律）；response_format 仅在 json_schema/json_object 档传，本地模型不支持时下一档退化。
        const reply = await adapter.chat(reaskMessages, { ...opts, ...(responseFormat ? { response_format: responseFormat } : {}) });
        if (reply?.incomplete) { lastError = `incomplete:${reply.finishReason || 'length'}`; break; } // incomplete 不 re-ask，降级下一档
        text = String(reply?.reply ?? reply?.content ?? reply?.text ?? reply ?? '');
      } catch (e) {
        lastError = `adapter_error:${e?.message || e}`;
        break; // 调用异常不 re-ask，降级下一档
      }
      // 显式空响应检测：empty/whitespace-only content 不 re-ask（再问也是空），降级下一档
      if (!text || !String(text).trim()) {
        lastError = `empty_response:${tier}`;
        break;
      }
      const parsed = parseNoeLlmJson(text);
      if (!parsed.ok) {
        // 包装 SyntaxError（含原始片段）：原 JSON.parse 抛出被 parseNoeLlmJson 捕获，这里把错误信息与文本片段串入 lastError 便于诊断
        const snippet = String(text).slice(0, 200).replace(/\s+/g, ' ').trim();
        const errDetail = parsed.error ? String(parsed.error).slice(0, 200) : 'unknown';
        lastError = `parse_failed:${tier}:${errDetail}:${snippet}`;
        if (attempt < reaskCap) { reaskMessages = [...messages, { role: 'assistant', content: text.slice(0, 4000) }, { role: 'user', content: '上面的输出无法解析为合法 JSON。请只返回符合要求的 JSON，不要任何解释或 markdown 围栏。' }]; continue; }
        break;
      }
      if (zodSchema && typeof zodSchema.safeParse === 'function') {
        const validated = zodSchema.safeParse(parsed.value);
        if (!validated.success) {
          lastError = `schema_invalid:${tier}`;
          if (attempt < reaskCap) {
            const errText = String(validated.error?.message || validated.error || 'schema validation failed').slice(0, 1000);
            reaskMessages = [...messages, { role: 'assistant', content: text.slice(0, 4000) }, { role: 'user', content: `上面的输出校验失败：${errText}。请修正后只返回符合要求的 JSON。` }];
            continue;
          }
          break;
        }
        return { ok: true, value: validated.data, tier, attempts };
      }
      return { ok: true, value: parsed.value, tier, attempts };
    }
  }
  return { ok: false, value: null, attempts, error: lastError };
}
