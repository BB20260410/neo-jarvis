// @ts-check
// NoeVerifiableReward — 可验证奖励函数库（借鉴 huggingface/open-r1 的 src/open_r1/rewards.py
//   「可验证奖励（verifiable rewards）」理念，用纯 JS 重写）。
//
// 借鉴的是什么：open-r1 复现 DeepSeek-R1 时，用一组**客观、可程序化判定**的奖励函数
//   给推理输出打分（GRPO 强化学习的 reward 信号），把"主观好不好"换成"结构对不对/简不简洁/
//   有没有分步/重不重复"这类可验证量。Neo 自评推理质量时一直是主观的（LLM 自己说几分），
//   缺一条**不依赖模型主观、可复算**的客观反馈——这正是 self-evolution / 好奇回路 / CogCore
//   期望账本最该补的"元认知"短板（把"自我评估"从主观打分升级为可验证打分）。
//
// 与 Neo 已有的不重复：NoeExpectationLedger 的 Brier 是"对未来概率预测的校准"，度量的是
//   "下注准不准"；本模块度量的是"单条推理输出的形态质量（结构/长度/分步/重复）"，两者正交、
//   互补，不重叠。Neo 此前没有任何输出质量类 reward 函数（已 grep 确认）。
//
// 重写忠实度（对照 rewards.py 公式）：
//   - formatReward      ← format_reward：正则校验 <think>…</think><answer>…</answer> 闭合结构 → 1/0
//   - lenReward         ← len_reward（Kimi-1.5 长度惩罚）：对一批同组答案做长度归一，
//                         "对且短"得高分、"对且长"扣分、错的封顶 0（不奖励错的啰嗦）
//   - reasoningStepsReward ← reasoning_steps_reward：数分步标记（- / * / Step N / First,/Next,…），
//                         min(1, count/3)，鼓励显式分步但不无限堆步骤
//   - repetitionPenalty ← get_repetition_penalty_reward：n-gram 去重，
//                         penalty = (1 - unique/total) * maxPenalty（≤0，惩罚机械复读）
//
// 设计原则（贴合 Neo 风格）：纯函数、零依赖、零网络/时钟/模型、确定性可复算、入参非法一律返回
//   中性值（fail-safe，绝不抛错搅乱调用方）；标签名/权重/阶数全部可注入。
//
// env 门控（仅"组合 reward 用于驱动行为"时才需要；单个函数纯计算无副作用，随便调）：
//   组合接口 createVerifiableReward 默认 enabled 取 process.env.NOE_VERIFIABLE_REWARD === '1'
//   （默认 OFF）——关时 score() 返回 { enabled:false, score:null }，调用方据此跳过、行为零变化。

import { clamp } from './_mathUtils.js';

/** 安全转有限数；非法 → fallback。 */
function num(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

/** 安全取字符串。 */
function str(x) {
  return typeof x === 'string' ? x : x == null ? '' : String(x);
}

/** 正则元字符转义（标签名注入时防注入坏正则）。 */
function escapeRe(s) {
  return str(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ───────────────────────────────────────────────────────────────────────────
// 1) formatReward —— 借鉴 open-r1 format_reward：结构标签是否闭合正确
// ───────────────────────────────────────────────────────────────────────────

/**
 * 校验输出是否严格符合 <think>…</think><answer>…</answer> 结构。
 * 借鉴 open-r1 format_reward（其正则 ^<think>...</think>\s*<answer>...</answer>$，DOTALL）。
 * JS 无 s 修饰符时用 [\s\S] 等价匹配换行。命中 1，否则 0。
 *
 * @param {string} text 待评文本
 * @param {object} [opts]
 * @param {string} [opts.thinkTag='think'] 思考块标签名
 * @param {string} [opts.answerTag='answer'] 答案块标签名
 * @param {boolean} [opts.strict=true] true=必须整串严格匹配（^…$）；false=只要包含该结构即可
 * @returns {0|1}
 */
export function formatReward(text, opts = {}) {
  const t = str(text).trim();
  if (!t) return 0;
  const think = escapeRe(opts.thinkTag || 'think');
  const answer = escapeRe(opts.answerTag || 'answer');
  const strict = opts.strict !== false;
  // [\s\S]*? 等价 DOTALL 下的 .*?；i 容忍标签大小写。
  const core = `<${think}>[\\s\\S]*?</${think}>\\s*<${answer}>[\\s\\S]*?</${answer}>`;
  const re = new RegExp(strict ? `^${core}$` : core, 'i');
  return re.test(t) ? 1 : 0;
}

// ───────────────────────────────────────────────────────────────────────────
// 2) lenReward —— 借鉴 open-r1 len_reward（Kimi-1.5 长度惩罚，需"一组"答案归一）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 单条文本的长度（默认按 Unicode 码点数；可注入自定义计长，如 token 数）。
 * @param {string} text
 * @param {(t: string) => number} [measure]
 * @returns {number}
 */
function lengthOf(text, measure) {
  if (typeof measure === 'function') return Math.max(0, num(measure(text), 0));
  // [...t] 按码点切，CJK/emoji 计为 1，比 .length（UTF-16 单元）更贴近"内容长度"。
  return [...str(text)].length;
}

/**
 * 对**一组**回答做长度归一奖励。借鉴 open-r1 len_reward（Cosmos/Kimi-1.5 思路）：
 *   在同一组（同一 prompt 的多个候选）内，
 *     λ = 0.5 - (len_i - minLen) / (maxLen - minLen)        ∈ [-0.5, 0.5]
 *   对的答案 reward = λ（越短越高、越长越低，鼓励"对且简洁"）；
 *   错的答案 reward = min(0, λ)（错的最多 0，绝不因为"短"而奖励错答）。
 *   全组等长（maxLen==minLen）时退化为全 0（无可区分信号）。
 * 这是 open-r1 里少数"需要批"的 reward——单条无法归一，故接收数组。
 *
 * @param {Array<{ text: string, correct: boolean }>} items 同组候选
 * @param {object} [opts]
 * @param {(t: string) => number} [opts.measure] 计长函数（默认码点数）
 * @returns {number[]} 与 items 等长的 reward 数组（每个 ∈ [-0.5, 0.5]）
 */
export function lenReward(items, opts = {}) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const lens = items.map((it) => lengthOf(it && it.text, opts.measure));
  const minLen = Math.min(...lens);
  const maxLen = Math.max(...lens);
  // open-r1 同款保护：全等长无信号 → 全 0。
  if (maxLen === minLen) return items.map(() => 0);
  const span = maxLen - minLen;
  return items.map((it, i) => {
    const lambda = 0.5 - (lens[i] - minLen) / span; // ∈ [-0.5, 0.5]
    const correct = !!(it && it.correct);
    return correct ? lambda : Math.min(0, lambda);
  });
}

// ───────────────────────────────────────────────────────────────────────────
// 3) reasoningStepsReward —— 借鉴 open-r1 reasoning_steps_reward：是否显式分步
// ───────────────────────────────────────────────────────────────────────────

/**
 * 数文本里的"分步推理标记"，归一到 [0,1]。借鉴 open-r1 reasoning_steps_reward：
 *   匹配 行首列表符（- / *）、Step N、序数过渡词（First,/Second,/Next,/Finally,…），
 *   reward = min(1, count / stepsTarget)（默认 target=3，与 open-r1 一致）。
 *   兼顾中文场景额外认中文序号（第一步/首先/其次/接着/然后/最后）。
 *   鼓励"展开过程"但封顶——避免靠无意义堆步骤刷分。
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.stepsTarget=3] 满分所需步骤数
 * @returns {number} ∈ [0,1]
 */
export function reasoningStepsReward(text, opts = {}) {
  const t = str(text);
  if (!t) return 0;
  const target = Math.max(1, num(opts.stepsTarget, 3));
  // 英文：open-r1 原始模式（行首 -/* 列表项、Step N、序数过渡词）。
  const enList = (t.match(/(^|\n)\s*[-*]\s+/g) || []).length;
  const enStep = (t.match(/(^|\n)\s*Step\s+\d+/gi) || []).length;
  const enOrdinal = (t.match(/\b(?:First|Second|Third|Next|Then|Finally|Lastly),/gi) || []).length;
  // 中文：贴合 Neo 实际输出（序号步骤 + 过渡词）。
  const cnStep = (t.match(/第[一二三四五六七八九十0-9]+步/g) || []).length;
  const cnOrdinal = (t.match(/(?:首先|其次|然后|接着|再者|最后|最终|于是)[，,、]/g) || []).length;
  const count = enList + enStep + enOrdinal + cnStep + cnOrdinal;
  return clamp(count / target, 0, 1);
}

// ───────────────────────────────────────────────────────────────────────────
// 4) repetitionPenalty —— 借鉴 open-r1 get_repetition_penalty_reward：n-gram 复读惩罚
// ───────────────────────────────────────────────────────────────────────────

/**
 * 把文本切成 token 序列。默认：英文按空白分词、中文按单字（CJK 逐字），过滤空串。
 * 可注入自定义分词器。
 * @param {string} text
 * @param {(t: string) => string[]} [tokenize]
 * @returns {string[]}
 */
function toTokens(text, tokenize) {
  if (typeof tokenize === 'function') {
    try {
      const out = tokenize(text);
      return Array.isArray(out) ? out.map(str).filter((x) => x.length > 0) : [];
    } catch {
      return [];
    }
  }
  const t = str(text).toLowerCase();
  // 把 CJK 字符两侧加空格，使中文逐字、英文按词，统一空白切分。
  const spaced = t.replace(/([㐀-鿿豈-﫿])/g, ' $1 ');
  return spaced.split(/\s+/).filter((x) => x.length > 0);
}

/**
 * n-gram 重复惩罚（≤0，越重复越负）。借鉴 open-r1 get_repetition_penalty_reward：
 *   把 token 序列切成 n-gram，
 *     scaling = 1 - (#unique n-gram) / (#total n-gram)     ∈ [0,1]
 *     penalty = scaling * maxPenalty                        (maxPenalty<0 ⇒ ≤0)
 *   token 数不足一个 n-gram（< n）时返回 0（无重复可言，open-r1 同款保护）。
 *   维度：完全不重复 → 0；机械复读（unique→0）→ maxPenalty。
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.ngramSize=3] n-gram 阶
 * @param {number} [opts.maxPenalty=-1] 最大惩罚（必须 ≤0；传正数会被夹到 0 并视为无惩罚）
 * @param {(t: string) => string[]} [opts.tokenize] 自定义分词
 * @returns {number} ∈ [maxPenalty, 0]
 */
export function repetitionPenalty(text, opts = {}) {
  const n = Math.max(1, Math.floor(num(opts.ngramSize, 3)));
  const maxPenalty = Math.min(0, num(opts.maxPenalty, -1)); // 守 open-r1 契约：惩罚必 ≤0
  if (maxPenalty === 0) return 0;
  const tokens = toTokens(text, opts.tokenize);
  if (tokens.length < n) return 0; // 凑不齐一个 n-gram → 无重复
  const seen = new Set();
  let total = 0;
  for (let i = 0; i + n <= tokens.length; i++) {
    total += 1;
    seen.add(tokens.slice(i, i + n).join('')); //  作分隔，避免 token 内容歧义
  }
  if (total === 0) return 0;
  const scaling = 1 - seen.size / total; // 0=全唯一，→1=全重复
  // scaling=0（完全不重复）时 0 * 负数 = JS 的 -0；+ 0 规范化为 +0（数学上 -0≡0，
  // 避免 Object.is(-0,+0)=false 让"完全不重复→0"这类等值判定踩 IEEE 754 怪癖）。
  return scaling * maxPenalty + 0;
}

// ───────────────────────────────────────────────────────────────────────────
// 组合接口 —— 把四个可验证 reward 加权汇成一个客观自评分（行为变化处用，env 门控默认 OFF）
// ───────────────────────────────────────────────────────────────────────────

/** 默认权重：结构/分步为正向加分，重复为负向扣分；长度需成组故默认不进单条聚合。 */
export const DEFAULT_REWARD_WEIGHTS = Object.freeze({
  format: 1.0,
  reasoningSteps: 1.0,
  repetition: 1.0, // 作用于 repetitionPenalty（其本身 ≤0），权重越大扣得越狠
});

/**
 * 工厂：返回一个对**单条**推理输出做可验证打分的 score()。
 * 借鉴 open-r1「多个可验证 reward 线性组合成训练信号」的范式，在 Neo 侧作为
 *   self-evolution / 好奇回路 / CogCore 的**客观自评**（非 RL 训练，仅打分用于排序/筛选/记账）。
 *
 * env 门控：enabled 默认取 NOE_VERIFIABLE_REWARD === '1'（默认 OFF）。
 *   关时 score() 恒返回 { enabled:false, score:null, parts:null }——调用方据此完全跳过，
 *   现有行为零变化（符合"涉行为变化设计成可被 env 门控、默认 OFF"约束）。
 *
 * @param {object} [opts]
 * @param {Record<string, string|undefined>} [opts.env] 环境（注入可测）
 * @param {boolean} [opts.enabled] 显式开关（优先于 env）
 * @param {{format?: number, reasoningSteps?: number, repetition?: number}} [opts.weights]
 * @param {object} [opts.format] 透传给 formatReward 的选项
 * @param {object} [opts.steps] 透传给 reasoningStepsReward 的选项
 * @param {object} [opts.repetition] 透传给 repetitionPenalty 的选项
 */
export function createVerifiableReward(opts = {}) {
  const env = opts.env || process.env;
  const enabled =
    typeof opts.enabled === 'boolean' ? opts.enabled : env.NOE_VERIFIABLE_REWARD === '1';
  const w = { ...DEFAULT_REWARD_WEIGHTS, ...(opts.weights || {}) };
  const fmtOpts = opts.format || {};
  const stepOpts = opts.steps || {};
  const repOpts = opts.repetition || {};

  /**
   * 对单条文本打可验证分。
   * @param {string} text
   * @returns {{enabled: boolean, score: number|null, parts: {format:number,reasoningSteps:number,repetition:number}|null}}
   */
  function score(text) {
    if (!enabled) return { enabled: false, score: null, parts: null };
    const parts = {
      format: formatReward(text, fmtOpts),
      reasoningSteps: reasoningStepsReward(text, stepOpts),
      repetition: repetitionPenalty(text, repOpts), // ≤0
    };
    const total =
      w.format * parts.format +
      w.reasoningSteps * parts.reasoningSteps +
      w.repetition * parts.repetition; // 加上一个 ≤0 项 = 扣分
    return { enabled: true, score: total, parts };
  }

  return { enabled, weights: w, score };
}
