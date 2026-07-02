// @ts-check
// B1.3 freedom 强制复核闸的生产接线：把本地 Review Brain (qwen/qwen3.6-27b) 包成
// runReviewBrainGate 期望的 reviewBrain({ request, preflight }) => verdict 函数。
//
// 设计取舍（遵 owner「开发者要自由最大权限」宪法 + 红线4「省 Claude 配额」）：
// - 只用本地 Review Brain model，本地 adapter 优先链（lmstudio → ollama），绝不路由到云端 Claude；
//   （room BrainRouter 的关键词路由会把含「审查/review」的复核文本归到 deep→claude，会烧 Claude 配额，故不复用它，直接定档本地。）
// - 模型在 → 真复核：把 preflight.request 喂给复核脑，原样回传它的 verdict（approve/block/revise 由 executor 决策）；
// - 模型不可用/出错 → 默认 fail-open 降级：回传 degraded approve（不锁死 freedom，符合自由宪法），
//   但带 degraded=true + risks 审计标记，让 owner 在 reviewBrainPreflight.verdict 里看见「这次是降级放行」；
// - 想要硬复核（模型不可用即阻断）→ failClosed:true，本函数改为抛错，由 executor 的既有 fail-closed 契约阻断。
//
// 注：executor 框架层仍是 fail-closed（reviewBrain 抛错 / verdict 解析不出 → 阻断）。本函数在「模型不可用」
//     这一具体情形下选择不抛错而降级，是 business policy（owner 宪法决定），不改 executor 的安全语义。

import {
  NOE_REVIEW_BRAIN,
  NOE_REVIEW_BRAIN_MODEL,
  NOE_REVIEW_BRAIN_SYSTEM_PROMPT,
} from '../model/NoeLocalModelPolicy.js';

// 本地复核脑 adapter 优先链：先 LM Studio（27B 复核脑常驻处），再 ollama 兜底。绝不含云端档。
export const NOE_FREEDOM_REVIEW_ADAPTER_CHAIN = Object.freeze(['lmstudio', 'ollama']);

/**
 * 构造 freedom 复核闸用的 reviewBrain 函数。
 * @param {object} opts
 * @param {(id:string)=>any} [opts.getAdapter] 按 adapterId 取 room adapter（须有 .chat(messages,opts)）
 * @param {string[]} [opts.adapterChain] 本地复核 adapter 优先链（默认 lmstudio→ollama）
 * @param {boolean} [opts.failClosed] 本地复核脑全不可用时是否抛错（true=executor fail-closed 阻断；
 *                                    默认 false=fail-open 降级放行 + 审计标记，遵 owner 自由宪法）
 * @returns {(input:{request?:object, preflight?:object})=>Promise<object>}
 */
export function createNoeFreedomReviewBrain({
  getAdapter = null,
  adapterChain = NOE_FREEDOM_REVIEW_ADAPTER_CHAIN,
  failClosed = false,
} = {}) {
  const chain = (Array.isArray(adapterChain) && adapterChain.length ? adapterChain : NOE_FREEDOM_REVIEW_ADAPTER_CHAIN)
    .map((id) => String(id || '').trim())
    .filter(Boolean);

  return async function reviewBrain({ request, preflight } = {}) {
    const req = request || preflight?.request || {};
    const messages = [
      { role: 'system', content: req.system || NOE_REVIEW_BRAIN_SYSTEM_PROMPT },
      // 只把脱敏后的结构化 preflight payload（actionId/operation/riskLevel/argsKeys/requiredChecks…）喂给复核脑，
      // preflight 构造时已不含 secret 原值（见 buildNoeReviewBrainPreflight）。
      { role: 'user', content: JSON.stringify(req.user || req || {}) },
    ];
    const chatOpts = {
      model: req.model || NOE_REVIEW_BRAIN_MODEL,
      temperature: req.temperature ?? NOE_REVIEW_BRAIN.generation?.temperature,
      top_p: req.top_p ?? NOE_REVIEW_BRAIN.generation?.top_p,
      max_tokens: req.max_tokens,
      responseFormat: req.responseFormat,
    };

    let lastErr = null;
    for (const adapterId of chain) {
      const adapter = getAdapter ? getAdapter(adapterId) : null;
      if (!adapter || typeof adapter.chat !== 'function') continue;
      try {
        // 不设超时（owner 红线：跑模型不设人工硬超时）。
        const r = await adapter.chat(messages, chatOpts);
        // 透传给 parseReviewVerdict：它能消化 { reply:'<json>' } / { verdict,... } / JSON 字符串。
        if (r && (typeof r.reply === 'string' || typeof r.verdict === 'string')) return r;
        lastErr = new Error(`adapter ${adapterId} returned no usable reply`);
      } catch (e) {
        lastErr = e;
      }
    }

    // 本地复核脑全不可用：
    if (failClosed) {
      // owner 选硬复核：抛错 → executor 的 fail-closed 契约阻断本次 real-execute。
      throw new Error(`review_brain_unavailable_local_chain: ${lastErr?.message || chain.join('→') || 'no_local_adapter'}`);
    }
    // 默认 fail-open 降级（owner 自由宪法）：放行但带 degraded 审计标记，绝不静默伪装成正常 approve。
    return {
      verdict: 'approve',
      degraded: true,
      reason: 'review_brain_unavailable_degraded_open',
      blockers: [],
      risks: ['review_brain_unavailable_degraded_open'],
      missingEvidence: [],
      confidence: 0,
    };
  };
}
