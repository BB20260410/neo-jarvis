// @ts-check
// NoeBudgetForcedDeliberation — 把 NoeBudgetForcing 控制器 + 续写能力接进真实深思的桥（接入层）。
//
// NoeBudgetForcing.js 是纯算法（决策核心 + 注入式编排循环），完全不碰网络/adapter；
// OpenAICompatCompletion.js 是底层续写通道。本模块是二者之间唯一的胶水：
//   ① 从 adapter 取 baseUrl/apiKey 建续写能力；
//   ② 造一个 runBudgetForcedThinking 需要的 generate(ctx)：每轮把 prompt 续写一段，
//      用 </think>（可配）作 stop 判定模型是否「想结束思考」(wantsStop)；
//   ③ 思考定稿后，让脑（adapter.chat）基于「强制出来的完整思考」产出最终结构化答复，
//      返回与 adapter.chat 完全同形的 {reply,...}——让 NoeDeliberation 零感知。
//
// 默认 OFF：createBudgetForcedThink 在 config.enabled=false 时返回 null（调用方据此完全不接线，
//   深思走原单次 chat，零回归）。enabled=true 才返回可用的 thinker。
// 纪律：本地深思脑、不烧付费配额、不设模型硬超时、fail-open（任何环节出问题回退普通 chat）。

import { runBudgetForcedThinking, approxTokenCount } from './NoeBudgetForcing.js';
import { createCompletionCapability } from '../room/OpenAICompatCompletion.js';

/** 思考起手与默认结束 stop（qwen3 系 </think>；s1 用别的，可经 config 覆盖）。 */
export const THINK_OPEN = '<think>\n';
export const DEFAULT_THINK_STOP = '</think>';
/** 每个 budget 步的单轮生成上限（不是总预算；总预算由 min/max + numIgnore 控）。 */
export const DEFAULT_STEP_MAX_TOKENS = 512;

function flattenForCompletionPrefix(messages) {
  // 把 system/user 拼成一段引导，再接 think 起手——RAW /completions 用整段 prompt 续写。
  const parts = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const role = m?.role === 'system' ? '系统' : (m?.role === 'assistant' ? '助手' : '用户');
    parts.push(`${role}：${String(m?.content || '')}`);
  }
  parts.push('助手：');
  return `${parts.join('\n\n')}${THINK_OPEN}`;
}

/**
 * 用一个具体 adapter + budget forcing 配置，造一个「先强制思考、再产出答复」的 thinker。
 * 仅当 config.enabled 时返回函数；否则返回 null（调用方不接线 = 零回归）。
 *
 * @param {object} args
 * @param {{chat:Function, baseUrl?:string, apiKey?:string, model?:string}} args.adapter 深思脑 adapter（LmStudio 等）
 * @param {ReturnType<import('./NoeBudgetForcing.js').resolveBudgetForcing>} args.config resolveBudgetForcing 结果
 * @param {string} [args.model] 深思模型 id（优先 config.model，再 args.model，再 adapter.model）
 * @param {typeof fetch} [args.fetchImpl]
 * @param {ReturnType<typeof createCompletionCapability>} [args.completion] 注入续写能力（单测用；否则按 adapter 自建）
 * @param {(text:string)=>number} [args.estimateTokens]
 * @param {string} [args.thinkStop] 思考结束 stop（默认 </think>）
 * @param {number} [args.stepMaxTokens] 单轮续写上限（默认 512）
 * @param {{warn?:(m:string)=>void}} [args.log]
 * @returns {null | ((input:{messages:Array<object>, maxTokens?:number, projectId?:string, taskId?:string, abortSignal?:AbortSignal}) => Promise<object>)}
 */
export function createBudgetForcedThink({
  adapter,
  config,
  model = '',
  fetchImpl = fetch,
  completion = null,
  estimateTokens = approxTokenCount,
  thinkStop = DEFAULT_THINK_STOP,
  stepMaxTokens = DEFAULT_STEP_MAX_TOKENS,
  log = console,
} = {}) {
  if (!config?.enabled) return null;
  if (!adapter?.chat) return null;
  const brainModel = String(config.model || model || adapter.model || '').trim();

  // 续写能力：注入优先（单测）；否则按 adapter 的 baseUrl/apiKey 自建。无 baseUrl 则无法续写 → 返回 null 回退。
  let cap = completion;
  if (!cap) {
    if (!adapter.baseUrl) {
      try { log?.warn?.('[noe-budget-forcing] adapter 无 baseUrl，无法续写，回退普通深思'); } catch { /* ignore */ }
      return null;
    }
    try {
      cap = createCompletionCapability({ baseUrl: adapter.baseUrl, apiKey: adapter.apiKey, fetchImpl, log });
    } catch {
      return null;
    }
  }

  /**
   * 先 budget forcing 思考，再据此产出最终结构化答复。
   * 返回 {reply, tokensIn?, tokensOut?, budgetForcing:{...}}（与 adapter.chat 同形，含一份诊断 meta）。
   * 任意环节失败 → 回退普通 adapter.chat（fail-open，绝不让深思因此挂掉）。
   */
  return async function thinkThenAnswer({ messages, maxTokens, projectId = 'noe', taskId = 'noe-deliberation-bf', abortSignal } = {}) {
    const msgs = Array.isArray(messages) ? messages : [];
    // CHAT_PREFIX 回退路径要带上原 system/user 上下文（否则模型不知道在想什么）。
    const priorMessages = msgs.map((m) => ({ role: m?.role === 'system' ? 'system' : (m?.role === 'assistant' ? 'assistant' : 'user'), content: String(m?.content || '') }));
    const basePrompt = flattenForCompletionPrefix(msgs);

    // generate(ctx)：每轮把当前 prompt 续写一段，命中 thinkStop = 模型想结束思考。
    const generate = async (ctx) => {
      const out = await cap.complete({
        prompt: ctx.prompt,
        model: brainModel,
        maxTokens: stepMaxTokens,
        stop: [thinkStop],
        priorMessages,
        abortSignal,
      });
      // hitStop（finish_reason=stop，命中 </think>）即模型想结束思考。
      return { text: String(out?.text || ''), wantsStop: out?.hitStop === true };
    };

    let forced;
    try {
      forced = await runBudgetForcedThinking({
        generate,
        basePrompt,
        minBudget: config.minBudget,
        maxBudget: config.maxBudget,
        numIgnore: config.numIgnore,
        continueInject: config.continueInject,
        finalizeInject: config.finalizeInject,
        estimateTokens,
      });
    } catch {
      // 思考阶段整体崩 → 回退普通深思（不带强制思考）。
      try { log?.warn?.('[noe-budget-forcing] 强制思考失败，回退普通深思'); } catch { /* ignore */ }
      return adapter.chat(msgs, { budgetContext: { projectId, taskId }, maxTokens, ...(brainModel ? { model: brainModel } : {}), ...(abortSignal ? { abortSignal } : {}) });
    }

    const thinking = String(forced?.thinking || '').trim();
    // 思考没产出任何内容 → 没有强制效果，回退普通深思（避免空思考反而降质）。
    if (!thinking) {
      return adapter.chat(msgs, { budgetContext: { projectId, taskId }, maxTokens, ...(brainModel ? { model: brainModel } : {}), ...(abortSignal ? { abortSignal } : {}) });
    }

    // 定稿：把「强制出来的完整思考」作为已想内容喂回去，让脑只负责按格式产出最终答复。
    const answerMessages = [
      ...msgs,
      { role: 'assistant', content: `（我已完成思考）\n${thinking.slice(0, 4000)}` },
      { role: 'user', content: '基于上面的思考，现在按要求的格式给出最终答复。' },
    ];
    const r = await adapter.chat(answerMessages, {
      budgetContext: { projectId, taskId },
      maxTokens,
      ...(brainModel ? { model: brainModel } : {}),
      ...(abortSignal ? { abortSignal } : {}),
    });
    return {
      ...r,
      budgetForcing: {
        rounds: forced.rounds,
        ignoresUsed: forced.ignoresUsed,
        tokensUsed: forced.tokensUsed,
        finalized: forced.finalized,
        stopReason: forced.stopReason,
        depth: config.depth,
        via: cap.currentMode?.(),
      },
    };
  };
}
