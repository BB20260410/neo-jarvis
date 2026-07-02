// @ts-check
// NoeBudgetForcing — 深思「想多深」连续旋钮（借鉴 s1: Simple test-time scaling / simplescaling/s1 的
//   budget forcing「预算强制」解码控制理念，Apache-2.0）。
//
// s1 论文的核心观察：推理时算力可以被精确控制成一个连续旋钮——
//   ① 当模型想结束思考、但还没达到「最小思考预算」时，拦截它的结束信号，
//      把已生成的思考拼回去再追加一个诱导词（s1 用 "Wait"），逼它接着想（自我怀疑/复查），
//      论文实测 AIME24 50%→57%；
//   ② 当思考超过「最大思考预算」时，注入一个收束词（如「综上，」/「Therefore」）逼它停下收尾，
//      防止本地小模型在 deep 档无限打转烧时延（对应论文的 context window 上限边界）。
//
// 本模块只「借算法、不抄依赖」：s1 原实现绑 vLLM 的 prompt 续写；这里写成
//   ① 纯函数 decideThinkingControl（零副作用、可单测的决策核心，本文件主交付物）；
//   ② resolveBudgetForcing（env 门控配置解析，镜像 NoeReflectBrain.resolveReflectBrain 的写法，
//      NOE_BUDGET_FORCING 默认 OFF——行为变化必须 owner 拍板，符合 CLAUDE.md「新功能 env 门控默认 OFF」）；
//   ③ runBudgetForcedThinking（注入式编排循环：把 generate/estimateTokens 当依赖注入进来，
//      不耦合任何具体 adapter，让 LM Studio /v1/completions 或 ollama generate(raw) 都能复用）。
//
// 与现有 NoeDeliberation/NoeReflectBrain/NoeAdaptiveRhythm 的关系：那三个管「何时深思 / 用哪个本地脑 / 多久重想一次」，
//   本模块正交补上「这一次深思在解码层想多深」——是 s1 缺失的那个连续旋钮，Neo 之前没有。
//
// 纪律：纯本地解码层、零训练、零新依赖；不设人工硬超时（跑模型纪律由调用方控制）；fail-open（解析不出就不强制）。

import { normalizeNoeAutoModel } from '../model/NoeLocalModelPolicy.js';

/** 深思深度档 → 忽略「想停」信号的次数 NUM_IGNORE（verbatim 自研究报告 §577：shallow/normal/deep = 0/1/3）。 */
export const BUDGET_FORCING_DEPTHS = Object.freeze({
  shallow: 0, // 还能反向用于「提前截断」省 token：达到 minBudget 就放它停
  normal: 1,
  deep: 3, // 高风险 / 期望账本 Brier 不确定的决策走 deep
});

/** 诱导继续思考的注入词（s1 原文 "Wait"；Neo 主脑中文，默认中文「等等，」，调用方可覆盖）。 */
export const DEFAULT_CONTINUE_INJECT = '等等，';
/** 强制收尾的注入词（预算耗尽时，逼模型从「想」切到「答」）。 */
export const DEFAULT_FINALIZE_INJECT = '综上，';

/** 估算字符串 token 数的保守默认实现（无依赖；CJK 约 1 字≈1 token，ASCII 约 4 字符≈1 token）。
 *  仅作 runBudgetForcedThinking 的 fallback；调用方应注入更准的 estimateTokens。 */
export function approxTokenCount(text) {
  const s = String(text || '');
  if (!s) return 0;
  let cjk = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) || 0;
    // CJK 统一表意文字 + 扩展A + 假名 + 谚文 + 全角标点，按 1 token/字
    if ((code >= 0x3000 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff)) cjk += 1;
  }
  const ascii = s.length - cjk;
  return cjk + Math.ceil(ascii / 4);
}

function toNonNegInt(value, fallback = 0) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * budget forcing 决策核心（纯函数，本模块主交付物，对应任务规格 decideThinkingControl）。
 *
 * 借鉴 s1 budget forcing：根据「已用思考 token / 最小预算 / 最大预算 / 模型是否想停」决定这一步怎么办。
 *   - 未达 minBudget 且模型想停 → 抑制结束、注入诱导词逼它继续想（s1 的「忽略结束 token + Wait」）；
 *   - 超过 maxBudget → 强制收尾、注入收束词逼它停下作答（s1 的 context 上限边界）；
 *   - 其余 → 顺其自然（continue / 让它停）。
 *
 * 防失控（借鉴研究报告 §577⑤「监控 Wait 注入后是否真在前进而非原地打转」）：
 *   传入 ignoresUsed/maxIgnores 后，忽略次数用尽即使没到 minBudget 也不再强制（避免无限 Wait 循环）；
 *   传入 lastDeltaTokens 且为 0（注入后这一轮没产出新 token）也判定停滞，停止强制。
 *
 * @param {object} args
 * @param {number} args.tokensUsed       已生成的思考 token 数
 * @param {number} args.minBudget        最小思考预算（未达且想停→逼继续）
 * @param {number} args.maxBudget        最大思考预算（超过→逼收尾）；<=0 视为不设上限
 * @param {boolean} [args.wantsStop]     模型这一步是否想结束思考（命中 think 结束 stop token）
 * @param {number} [args.ignoresUsed]    已经强制继续过几次（防失控计数）
 * @param {number} [args.maxIgnores]     最多允许强制继续几次（= 深度档 NUM_IGNORE）
 * @param {number} [args.lastDeltaTokens] 上一轮注入后新产出的 token 数（0=停滞）；undefined 表示不检查
 * @param {string} [args.continueInject] 诱导继续词（默认「等等，」）
 * @param {string} [args.finalizeInject] 强制收尾词（默认「综上，」）
 * @returns {{action:'continue'|'finalize'|'stop', inject:string, reason:string,
 *            remainingBudget:number, ignoresLeft:number}}
 */
export function decideThinkingControl({
  tokensUsed,
  minBudget,
  maxBudget,
  wantsStop = false,
  ignoresUsed = 0,
  maxIgnores = Number.POSITIVE_INFINITY,
  lastDeltaTokens = undefined,
  continueInject = DEFAULT_CONTINUE_INJECT,
  finalizeInject = DEFAULT_FINALIZE_INJECT,
} = {}) {
  const used = toNonNegInt(tokensUsed, 0);
  const minB = toNonNegInt(minBudget, 0);
  const rawMax = Math.trunc(Number(maxBudget));
  const hasMax = Number.isFinite(rawMax) && rawMax > 0;
  const maxB = hasMax ? rawMax : Number.POSITIVE_INFINITY;
  const usedIgnores = toNonNegInt(ignoresUsed, 0);
  const ignoreCap = Number.isFinite(Number(maxIgnores)) && Number(maxIgnores) >= 0
    ? Math.trunc(Number(maxIgnores))
    : Number.POSITIVE_INFINITY;
  const ignoresLeft = ignoreCap === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : Math.max(0, ignoreCap - usedIgnores);
  const remainingBudget = hasMax ? Math.max(0, maxB - used) : Number.POSITIVE_INFINITY;
  const cont = String(continueInject ?? DEFAULT_CONTINUE_INJECT);
  const fin = String(finalizeInject ?? DEFAULT_FINALIZE_INJECT);

  // ① 上限优先：超过最大预算一律收尾（即使模型还想继续想，也逼它停——防本地小模型无限打转）。
  if (used >= maxB) {
    return { action: 'finalize', inject: fin, reason: 'max_budget_reached', remainingBudget, ignoresLeft };
  }

  // ② 模型想停，但还没到最小预算 → s1 的核心：拦截结束、注入诱导词逼它再想一轮。
  if (wantsStop && used < minB) {
    // 防失控 a：忽略次数用尽 → 尊重模型的停（不再硬逼）。
    if (ignoresLeft <= 0) {
      return { action: 'stop', inject: '', reason: 'ignore_budget_exhausted', remainingBudget, ignoresLeft };
    }
    // 防失控 b：上一轮注入后没有任何新 token = 原地打转 → 停。
    if (lastDeltaTokens !== undefined && toNonNegInt(lastDeltaTokens, 0) <= 0) {
      return { action: 'stop', inject: '', reason: 'no_progress_after_inject', remainingBudget, ignoresLeft };
    }
    return { action: 'continue', inject: cont, reason: 'below_min_budget', remainingBudget, ignoresLeft };
  }

  // ③ 模型想停且已达最小预算 → 顺其自然，让它停（也支持 shallow 档的提前截断省 token）。
  if (wantsStop) {
    return { action: 'stop', inject: '', reason: 'wants_stop_min_met', remainingBudget, ignoresLeft };
  }

  // ④ 模型还想继续想且没超上限 → 不干预，继续（不注入额外词）。
  return { action: 'continue', inject: '', reason: 'within_budget', remainingBudget, ignoresLeft };
}

/**
 * 解析 budget forcing 配置（env 门控，镜像 NoeReflectBrain.resolveReflectBrain 的纯函数写法）。
 * 默认 OFF：未开 NOE_BUDGET_FORCING 时 enabled=false，深思保持现有行为（零行为变化）。
 *
 * env：
 *   NOE_BUDGET_FORCING=1            启用（默认 OFF）
 *   NOE_BUDGET_FORCING_DEPTH        shallow|normal|deep（默认 normal）→ numIgnore 0/1/3
 *   NOE_BUDGET_FORCING_MIN_TOKENS   最小思考预算（默认 256）
 *   NOE_BUDGET_FORCING_MAX_TOKENS   最大思考预算（默认 8192，防失控硬上限）
 *   NOE_BUDGET_FORCING_MODEL        指定本地深思模型 id（默认空=沿用调用方/深思脑选型）
 *   NOE_BUDGET_FORCING_CONTINUE     诱导继续词（默认「等等，」）
 *   NOE_BUDGET_FORCING_FINALIZE     强制收尾词（默认「综上，」）
 *
 * @param {object} [opts]
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {{warn?: (msg: string) => void}} [opts.log]
 * @returns {{enabled:boolean, depth:string, numIgnore:number, minBudget:number, maxBudget:number,
 *            continueInject:string, finalizeInject:string, model:string|null}}
 */
export function resolveBudgetForcing({ env = process.env, log = console } = {}) {
  const disabled = {
    enabled: false,
    depth: 'normal',
    numIgnore: BUDGET_FORCING_DEPTHS.normal,
    minBudget: 256,
    maxBudget: 8192,
    continueInject: DEFAULT_CONTINUE_INJECT,
    finalizeInject: DEFAULT_FINALIZE_INJECT,
    model: null,
  };
  if (env.NOE_BUDGET_FORCING !== '1') return disabled;

  let depth = String(env.NOE_BUDGET_FORCING_DEPTH || 'normal').trim().toLowerCase() || 'normal';
  if (!Object.prototype.hasOwnProperty.call(BUDGET_FORCING_DEPTHS, depth)) {
    try {
      log?.warn?.(`[noe-budget-forcing] NOE_BUDGET_FORCING_DEPTH=${depth} 非法（应为 ${Object.keys(BUDGET_FORCING_DEPTHS).join('/')}），回退 normal`);
    } catch { /* 日志失败不影响解析 */ }
    depth = 'normal';
  }
  const numIgnore = BUDGET_FORCING_DEPTHS[depth];

  const minBudget = toNonNegInt(env.NOE_BUDGET_FORCING_MIN_TOKENS, 256);
  let maxBudget = toNonNegInt(env.NOE_BUDGET_FORCING_MAX_TOKENS, 8192);
  // 防呆：max 必须 >= min，否则上限失效会让最小预算逼继续与上限收尾冲突。
  if (maxBudget < minBudget) {
    try { log?.warn?.(`[noe-budget-forcing] MAX_TOKENS(${maxBudget}) < MIN_TOKENS(${minBudget})，已抬到 min`); } catch { /* ignore */ }
    maxBudget = minBudget;
  }

  const rawModel = String(env.NOE_BUDGET_FORCING_MODEL || '').trim();
  const model = rawModel ? normalizeNoeAutoModel(rawModel, { allowEmpty: true }) || null : null;

  return {
    enabled: true,
    depth,
    numIgnore,
    minBudget,
    maxBudget,
    continueInject: String(env.NOE_BUDGET_FORCING_CONTINUE || DEFAULT_CONTINUE_INJECT),
    finalizeInject: String(env.NOE_BUDGET_FORCING_FINALIZE || DEFAULT_FINALIZE_INJECT),
    model,
  };
}

/**
 * budget forcing 编排循环（注入式；s1 解码循环的 Node 版，不耦合任何具体 adapter）。
 *
 * 调用方注入一个 generate(ctx) → {text, wantsStop}：返回这一轮新生成的思考文本，
 *   以及模型本轮是否命中「想停」的 stop（如 qwen3 的 </think> / s1 的 <|im_start|>）。
 * 本循环按 decideThinkingControl 决定：继续(拼回思考+诱导词再 generate) / 收尾 / 停。
 * 完全不发网络、不拼 chat 模板——那些细节留给注入的 generate（便于确定性单测）。
 *
 * @param {object} args
 * @param {(ctx:{prompt:string, round:number, action:string, inject:string}) => Promise<{text:string, wantsStop?:boolean}>} args.generate
 * @param {string} [args.basePrompt]    起手 prompt（已以 think 起手，调用方负责）
 * @param {number} args.minBudget
 * @param {number} args.maxBudget
 * @param {number} [args.numIgnore]     最多强制继续几次（深度档）
 * @param {string} [args.continueInject]
 * @param {string} [args.finalizeInject]
 * @param {(text:string)=>number} [args.estimateTokens] token 估算器（默认 approxTokenCount）
 * @param {number} [args.maxRounds]     生成轮数硬上限（防 generate 异常导致死循环；默认 numIgnore+8）
 * @returns {Promise<{thinking:string, rounds:number, ignoresUsed:number, tokensUsed:number,
 *            finalized:boolean, stopReason:string, steps:Array<object>}>}
 */
export async function runBudgetForcedThinking({
  generate,
  basePrompt = '',
  minBudget,
  maxBudget,
  numIgnore = 1,
  continueInject = DEFAULT_CONTINUE_INJECT,
  finalizeInject = DEFAULT_FINALIZE_INJECT,
  estimateTokens = approxTokenCount,
  maxRounds = undefined,
} = {}) {
  if (typeof generate !== 'function') throw new TypeError('runBudgetForcedThinking: generate 必须是函数');
  const est = typeof estimateTokens === 'function' ? estimateTokens : approxTokenCount;
  const ignoreCap = toNonNegInt(numIgnore, 1);
  const roundCap = toNonNegInt(maxRounds, ignoreCap + 8);

  let thinking = '';
  let tokensUsed = 0;
  let ignoresUsed = 0;
  let rounds = 0;
  let finalized = false;
  let stopReason = 'completed';
  let pendingAction = 'initial';
  let pendingInject = '';
  let lastDeltaTokens;
  const steps = [];

  while (rounds < roundCap) {
    const promptForRound = basePrompt + thinking + pendingInject;
    let out;
    try {
      out = await generate({ prompt: promptForRound, round: rounds, action: pendingAction, inject: pendingInject });
    } catch (e) {
      stopReason = 'generate_error';
      steps.push({ round: rounds, error: e?.message || String(e) });
      break; // fail-open：生成异常就用已有思考收场，不抛断整条深思链
    }
    rounds += 1;
    const delta = String(out?.text || '');
    const deltaTokens = est(delta);
    thinking += delta;
    tokensUsed += deltaTokens;
    lastDeltaTokens = deltaTokens;
    const wantsStop = out?.wantsStop === true;

    // 刚做完一次「强制继续」的注入，这一轮算一次 ignore 消耗。
    if (pendingAction === 'continue' && pendingInject) ignoresUsed += 1;

    const decision = decideThinkingControl({
      tokensUsed,
      minBudget,
      maxBudget,
      wantsStop,
      ignoresUsed,
      maxIgnores: ignoreCap,
      lastDeltaTokens,
      continueInject,
      finalizeInject,
    });
    steps.push({ round: rounds - 1, deltaTokens, tokensUsed, wantsStop, action: decision.action, reason: decision.reason });

    if (decision.action === 'finalize') {
      thinking += decision.inject;
      finalized = true;
      stopReason = decision.reason;
      break;
    }
    if (decision.action === 'stop') {
      stopReason = decision.reason;
      break;
    }
    // continue：把诱导词（可能为空）带入下一轮 prompt
    pendingAction = 'continue';
    pendingInject = decision.inject;
    // 模型不想停且无注入词时，避免空转：若也没有新产出则停（防 generate 恒返空 text）。
    if (!wantsStop && !decision.inject && deltaTokens <= 0) {
      stopReason = 'no_progress_idle';
      break;
    }
  }
  if (rounds >= roundCap && stopReason === 'completed') stopReason = 'max_rounds';

  return { thinking, rounds, ignoresUsed, tokensUsed, finalized, stopReason, steps };
}