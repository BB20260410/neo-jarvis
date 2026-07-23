// @ts-check
// NoeCuriosityDecompose — 把「好奇」从单标量惊奇拆成 epistemic + pragmatic 双因子。
//
// 借鉴 pymdp (inferactively-pymdp) 主动推断的「期望自由能 EFE」理念：
//   pymdp 选策略 = 最小化 G = -epistemic_value - pragmatic_value，其中
//     · epistemic value（认识价值/好奇）= 该动作能消除多少隐状态不确定性（信息增益）；
//     · pragmatic value（实用价值）= 该动作把世界推向多贴近偏好观测（贴 owner 偏好/趋向奖励）。
//   即「好奇」与「奖励」被统一进一个目标函数——这正是 pymdp 最核心的数学形式。
//   Neo 现状只有单标量 surprise=-log2(p)（NoeExpectationLedger.js）+ 单阈值好奇回路
//   harvestSurprise（NoeGoalSystem.js，surprise≥2bit → 研究目标），没有拆 epistemic/pragmatic。
//   本模块只 borrow 这条标量公式，不引 Python/JAX，不移植离散 POMDP 控制层（与 Neo 的
//   LLM 驱动 + 开放动作空间层级错配，研究裁决已明确不可移植）。
//
// 与 Neo 的接法（本模块不改任何现有文件，只提供纯函数给 harvestSurprise 旁用）：
//   把现有单 surprise（≈ epistemicValue 的天然来源：落空越狠 = 不确定性缺口越大）当 epistemic 输入，
//   再叠一个 pragmaticValue（这条好奇研究有多贴 owner 当下偏好/目标），加权得可解释的
//   curiosityScore——「好奇」从一个阈值触发的标量，升级成「为什么值得好奇」的双因子读数。
//
// 工程纪律（与 NoeEntropyTemperature.js / NoeMemoryEcho.js 同款）：
//   - 纯函数 + 注入式：全部参数可注入、确定性、不碰时钟/网络/RNG/真模型；
//   - 行为变化由 env NOE_EFE_CURIOSITY 门控，默认 OFF（factory 暴露 enabled，调用方自行分支）；
//   - fail-open：输入缺失/异常一律退化为 0 分（保守：不凭脏数据凭空立目标）；
//   - 与 NoeExpectationLedger 的 surprise=-log2(p) 不重复——这里不算 surprise，只消费它。

import { clamp } from './_mathUtils.js';

/** 安全转有限数；非有限（NaN/Infinity/null/字符串等）一律退化为 fallback。 */
function num(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 把一个非负原始量压到 [0,1] 的饱和映射（借 EFE 里 information-gain 多为「无上界正量」的处理思路）。
 * 用 v / (v + scale)：v=0→0、v=scale→0.5、v→∞→1，单调且对量纲不敏感（scale 即「半饱和点」）。
 * Neo 的 surprise 单位是 bit（-log2(p)），默认 scale=2 → 恰好 2bit（现有好奇阈值）映射到 0.5。
 * @param {number} v 原始非负量（负值按 0 处理）
 * @param {number} scale 半饱和点（>0）
 */
function saturate(v, scale) {
  const x = Math.max(0, num(v, 0));
  const s = Math.max(1e-9, num(scale, 1));
  return x / (x + s);
}

/**
 * 信念熵 beliefEntropy：对一个信念分布算香农熵 H = -Σ p·log2(p)，并按 log2(支撑数) 归一到 [0,1]。
 *
 * 借鉴 pymdp 的「隐状态信念 qs 的不确定性」概念：Neo 的好奇本质是「想消除信念里的不确定」，
 *   熵越高 = 越拿不准 = 越有 epistemic 价值可挖。这一项 Neo 现状完全没有（ledger 只有点估计 p，
 *   无分布、无熵），是本模块相对现状的真增量，可作为 epistemicValue 的一种来源喂给 curiosityScore。
 *
 * 设计细节（贴 NoeEntropyTemperature 的归一化做法，使 H 在不同分布长度下含义稳定）：
 *   - 自动归一化（输入不必是概率，权重也行）；
 *   - 过滤掉非正项；全零/空/单点 → 返回 entropy=0（确定，无好奇价值）；
 *   - normalized = H / log2(有效支撑数)，让 2 选项与 100 选项的「满熵」都=1，可横向比较。
 *
 * @param {number[]} distribution 信念分布或权重数组
 * @returns {{ entropy: number, normalized: number, support: number }}
 *   entropy=原始香农熵(bit)；normalized=[0,1] 归一熵；support=参与计算的有效支撑数
 */
export function beliefEntropy(distribution) {
  if (!Array.isArray(distribution) || distribution.length === 0) {
    return { entropy: 0, normalized: 0, support: 0 };
  }
  // 仅保留有限且 > 0 的项（概率/权重语义下负数与 0 无意义）。
  const ps = distribution.map((x) => num(x, 0)).filter((x) => x > 0);
  const sum = ps.reduce((s, x) => s + x, 0);
  if (ps.length === 0 || sum <= 0) return { entropy: 0, normalized: 0, support: 0 };
  const support = ps.length;
  let H = 0;
  for (const x of ps) {
    const p = x / sum;
    H -= p * Math.log2(p);
  }
  // 单点分布无不确定性；归一时避免除以 log2(1)=0。
  const maxH = support > 1 ? Math.log2(support) : 0;
  const normalized = maxH > 0 ? clamp(H / maxH, 0, 1) : 0;
  // 修掉浮点把理论 0 抖成 -0 / 极小负数的情况。
  const entropy = Math.abs(H) < 1e-12 ? 0 : H;
  return { entropy, normalized, support };
}

/**
 * curiosityScore：把好奇拆成 epistemic + pragmatic 双因子并加权汇总（借 pymdp EFE 的二分解）。
 *
 * pymdp 是「最小化 G = -epistemic - pragmatic」（G 越小越选）；Neo 要的是「越值得好奇分越高」，
 *   故这里直接对 (epistemic, pragmatic) 取正向加权和当 score（= 最大化 -G 的等价形式），更贴
 *   Neo 既有「分高 → 立研究目标」的直觉。两个因子都先饱和/夹取到 [0,1]，再按权重线性组合：
 *     score = wE·epistemic + wP·pragmatic     （权重默认各 0.5；自动归一化，二者皆 0 时退化为均权）
 *
 * @param {object} args
 * @param {number} args.epistemicValue 认识价值原始量（如 surprise(bit)/信念熵/信息增益；非负，越大越好奇）
 * @param {number} args.pragmaticValue 实用价值原始量（这条好奇有多贴 owner 偏好/当前目标；建议已在 [0,1]，
 *   但本函数对越界/无上界输入也做饱和，保证鲁棒）
 * @param {{epistemic?: number, pragmatic?: number}} [args.weights] 双因子权重（默认 0.5/0.5）
 * @param {number} [args.epistemicScale=2] epistemic 饱和半点（默认 2，对齐 2bit 好奇阈值 → 0.5）
 * @param {number} [args.pragmaticScale=1] pragmatic 饱和半点（默认 1，输入若已是 [0,1] 偏好分则 0.5→0.5）
 * @param {number} [args.surfaceThreshold=0.5] 判 label 的「值得好奇」阈值（默认 0.5，对齐旧 2bit 语义）
 * @returns {{score: number, epistemic: number, pragmatic: number, label: 'epistemic'|'pragmatic'|'balanced'|'idle'}}
 *   score=[0,1] 综合好奇分；epistemic/pragmatic=各自饱和后的 [0,1] 分量；
 *   label：idle=分不过阈值（别立目标）；其余按谁主导分 epistemic/pragmatic/balanced（驱动可解释）。
 */
export function curiosityScore({
  epistemicValue = 0,
  pragmaticValue = 0,
  weights = {},
  epistemicScale = 2,
  pragmaticScale = 1,
  surfaceThreshold = 0.5,
} = {}) {
  // 两个因子各自饱和到 [0,1]——epistemic 多来自无上界的 bit 量，pragmatic 也许已归一但容错处理。
  const epistemic = saturate(epistemicValue, epistemicScale);
  const pragmatic = saturate(pragmaticValue, pragmaticScale);

  // 权重归一化；非法/全零权重退化为均权（fail-open，绝不返回 NaN）。
  let wE = num(weights?.epistemic, 0.5);
  let wP = num(weights?.pragmatic, 0.5);
  if (wE < 0) wE = 0;
  if (wP < 0) wP = 0;
  const wSum = wE + wP;
  if (wSum <= 0) { wE = 0.5; wP = 0.5; }
  else { wE /= wSum; wP /= wSum; }

  const score = clamp(wE * epistemic + wP * pragmatic, 0, 1);

  // label：先判够不够格浮现；够格再看哪个因子主导（解释「为什么好奇」给透视页/反思素材）。
  const thr = clamp(num(surfaceThreshold, 0.5), 0, 1);
  /** @type {'epistemic'|'pragmatic'|'balanced'|'idle'} */
  let label;
  if (score < thr) {
    label = 'idle';
  } else {
    const gap = epistemic - pragmatic;
    // 主导判定带一点死区（0.1），避免两因子接近时 label 抖动。
    if (gap > 0.1) label = 'epistemic';
    else if (gap < -0.1) label = 'pragmatic';
    else label = 'balanced';
  }

  return { score, epistemic, pragmatic, label };
}

/**
 * 工厂：暴露 env 门控 enabled + 绑定默认配置的 score/entropy（与 NoeEntropyTemperature.createXxx 同形）。
 * 调用方（如 NoeGoalSystem.harvestSurprise 旁路）自行按 enabled 分支：关闭时走旧单标量逻辑，行为零差异。
 * @param {object} [opts]
 * @param {boolean} [opts.enabled] 显式覆盖；缺省读 env NOE_EFE_CURIOSITY === '1'（默认 OFF）
 * @param {{epistemic?: number, pragmatic?: number}} [opts.weights]
 * @param {number} [opts.epistemicScale]
 * @param {number} [opts.pragmaticScale]
 * @param {number} [opts.surfaceThreshold]
 */
export function createCuriosityDecompose({
  enabled,
  weights,
  epistemicScale = 2,
  pragmaticScale = 1,
  surfaceThreshold = 0.5,
} = {}) {
  const on = typeof enabled === 'boolean' ? enabled : process.env.NOE_EFE_CURIOSITY === '1';
  return {
    enabled: on,
    /** 绑定默认配置的 curiosityScore；逐次调用仍可用 override 覆写。 */
    score(args = {}) {
      return curiosityScore({ weights, epistemicScale, pragmaticScale, surfaceThreshold, ...args });
    },
    /** 直通 beliefEntropy（无状态，便于调用方算 epistemicValue 来源）。 */
    entropy(distribution) {
      return beliefEntropy(distribution);
    },
  };
}
