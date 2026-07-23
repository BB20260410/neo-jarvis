// @ts-check

// NoeMemoryDynamics — 记忆双相衰减动力学（时间维度激活因子）。
//
// 借鉴 OpenMemory（CaviraOSS/OpenMemory, Apache-2.0）的 packages/openmemory-js/src/ops/dynamics.ts
// 与 memory/decay.ts 的两个核心理念，用纯 JS（无依赖）重写：
//   ① 双相衰减（biphasic decay）：retention(t) = e^(-λ₁·t) + θ·e^(-λ₂·t)
//      —— 快遗忘项 λ₁（短时记忆迅速淡去）+ 慢巩固项 λ₂（长时痕迹缓慢留存），
//         θ 控制慢相占比，整体归一到 [0,1]（t=0 时 = 1）。
//      （借鉴 OpenMemory dynamics.ts 的「短时遗忘 + 长时巩固」双指数；λ 取值/单位见下）
//   ② hot/warm/cold 三档：不同新旧程度的记忆用不同 λ（新记忆掉得快、陈旧记忆已巩固掉得慢），
//      对应 OpenMemory memory/decay.ts 按 tier 分档 λ。
//   ③ 检索即强化（retrieval-as-reinforcement）：sal ← sal + η·(1 − sal)
//      —— 被想起就加深、且越接近上限增益越小（对应 OpenMemory「检索即强化」`sal←sal+η(1-sal)`），
//         让召回像「回忆」而非「查数据库」。
//
// 与 Neo 已有能力的边界（诚实增量，不重复造轮子）：
//   - Neo 的 NoeFusionRanker.weightedFusion 已有 salience（1-5）二级权重，但时间维度很弱
//     （仅 hit_count DESC, updated_at DESC 排序 + 静态 salience 乘子）。本模块只补「随时间演化的
//      激活能」这一维：把「距上次召回多久」真正纳入排序，作为一个可乘进 fusion 分数的因子。
//   - 不直接改 NoeFusionRanker / MemoryCore（纯新增模块）；调用方把 activationFactor 作为
//     乘子叠到已有融合分上即可（见 makeActivationScorer 与文件尾的接入示例）。
//   - 行为变化（让召回排序受时间影响）走 env 门控、默认 OFF：NOE_MEMORY_DYNAMIC_DECAY=1 才生效，
//     默认返回恒等因子 1（= 现行为不变），符合本项目「新功能 env 门控、默认 OFF」纪律。
//
// 全部为纯函数 / 注入式：时间通过 now 注入，不读时钟/网络/真模型，确定性可单测。

/** 一天的毫秒数（与 NoeMemoryCurator / NoeEpisodeSublimation 同款常量约定）。 */
export const DAY_MS = 86400000;

// 默认 λ 单位均为「每天」（per-day）：ageMs 内部换算成天数 t，使常量可读、可对照 OpenMemory。
// 值取自调研报告核实的 OpenMemory 源码：
//   - 双相衰减：λ₁=0.015（快）/ λ₂=0.002（慢）/ θ=0.5（慢相权重，OpenMemory 记为 θ）。
//   - 分档：hot=0.005 / warm=0.02 / cold=0.05（OpenMemory memory/decay.ts 三档 λ）。
// 注：OpenMemory 的分档 λ 是「单一指数」用的衰减率；本模块把它接进双相框架时，
//     令该档 λ 作为「快相 λ₁」，慢相 λ₂ 固定取一个更小的巩固率，θ 控制留存底座，
//     这样既保留「分档掉速不同」，又保留「双相（遗忘+巩固）」形状。
export const DEFAULT_BIPHASIC = Object.freeze({
  lambdaFast: 0.015, // λ₁：快遗忘（每天）
  lambdaSlow: 0.002, // λ₂：慢巩固（每天）
  theta: 0.5, // θ：慢相权重（0~1）
});

/** 三档（hot/warm/cold）→ 快相 λ₁（每天）。借鉴 OpenMemory memory/decay.ts 分档 λ。 */
export const DEFAULT_TIER_LAMBDA = Object.freeze({
  hot: 0.005, // 越新越「热」，但本就该掉得快（短时遗忘）——对应 OpenMemory hot 档
  warm: 0.02,
  cold: 0.05,
});

/** 年龄分档边界（毫秒）：< hotMaxMs 为 hot，< warmMaxMs 为 warm，其余 cold。可注入覆盖。 */
export const DEFAULT_TIER_BOUNDARIES = Object.freeze({
  hotMaxMs: 7 * DAY_MS, // 7 天内：hot
  warmMaxMs: 30 * DAY_MS, // 30 天内：warm；更老：cold
});

/** 检索即强化默认学习率 η（borrow OpenMemory `sal←sal+η(1-sal)` 的 η）。 */
export const DEFAULT_REINFORCE_ETA = 0.3;

/** 数值规整：转有限数，非有限则用 fallback。 */
function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** clamp 到 [0,1]。 */
function clamp01(value) {
  const n = num(value, 0);
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

/** 把任意「时间值」转成毫秒 epoch 数；无效返回 null。接受数字或可被 Date 解析的字符串。 */
function toEpochMs(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

/**
 * 双相衰减留存率：retention(t) = (e^(-λ₁·t) + θ·e^(-λ₂·t)) / (1 + θ)，归一到 [0,1]。
 * 借鉴 OpenMemory dynamics.ts 双指数（快遗忘 + 慢巩固）；除以 (1+θ) 使 t=0 时严格 = 1。
 * @param {number} ageMs 距今年龄（毫秒，>=0；负数按 0 处理）
 * @param {object} [opts]
 * @param {number} [opts.lambdaFast] 快相 λ₁（每天，默认 0.015）
 * @param {number} [opts.lambdaSlow] 慢相 λ₂（每天，默认 0.002）
 * @param {number} [opts.theta] 慢相权重 θ（默认 0.5）
 * @returns {number} [0,1]，单调不增
 */
export function dualPhaseRetention(ageMs, opts = {}) {
  const days = Math.max(0, num(ageMs, 0)) / DAY_MS;
  const l1 = Math.max(0, num(opts.lambdaFast, DEFAULT_BIPHASIC.lambdaFast));
  const l2 = Math.max(0, num(opts.lambdaSlow, DEFAULT_BIPHASIC.lambdaSlow));
  const theta = Math.max(0, num(opts.theta, DEFAULT_BIPHASIC.theta));
  const raw = Math.exp(-l1 * days) + theta * Math.exp(-l2 * days);
  const norm = raw / (1 + theta); // t=0 → (1+θ)/(1+θ)=1
  return clamp01(norm);
}

/**
 * 按年龄分档：'hot' | 'warm' | 'cold'。借鉴 OpenMemory memory/decay.ts 的 hot/warm/cold。
 * @param {number} ageMs 年龄（毫秒）
 * @param {object} [boundaries] 覆盖默认边界
 * @param {number} [boundaries.hotMaxMs]
 * @param {number} [boundaries.warmMaxMs]
 * @returns {'hot'|'warm'|'cold'}
 */
export function tierForAge(ageMs, boundaries = {}) {
  const age = Math.max(0, num(ageMs, 0));
  const hotMax = num(boundaries.hotMaxMs, DEFAULT_TIER_BOUNDARIES.hotMaxMs);
  const warmMax = num(boundaries.warmMaxMs, DEFAULT_TIER_BOUNDARIES.warmMaxMs);
  if (age < hotMax) return 'hot';
  if (age < warmMax) return 'warm';
  return 'cold';
}

/** 取某档的快相 λ₁（每天）。未知 tier 回落到 warm 档。可注入 tierLambda 覆盖。 */
export function lambdaForTier(tier, tierLambda = DEFAULT_TIER_LAMBDA) {
  const table = tierLambda && typeof tierLambda === 'object' ? tierLambda : DEFAULT_TIER_LAMBDA;
  const key = tier === 'hot' || tier === 'warm' || tier === 'cold' ? tier : 'warm';
  return Math.max(0, num(table[key], DEFAULT_TIER_LAMBDA[key]));
}

/**
 * 时间激活因子（本模块的头牌导出）：把年龄 → [0,1] 的激活能，给召回排序叠时间维度。
 * 形状 = 双相衰减；快相 λ₁ 由 tier 决定（hot/warm/cold 掉速不同），慢相 λ₂ 与 θ 共用双相默认（巩固底座）。
 * 借鉴 OpenMemory：双相衰减（dynamics.ts）+ 分档 λ（memory/decay.ts）合体。
 * @param {number} ageMs 年龄（毫秒）
 * @param {object} [opts]
 * @param {'hot'|'warm'|'cold'} [opts.tier] 显式档位；不给则按 ageMs + boundaries 自动判档
 * @param {object} [opts.boundaries] 自动判档边界
 * @param {object} [opts.tierLambda] 覆盖三档 λ₁ 表
 * @param {number} [opts.lambdaSlow] 慢相 λ₂（每天，默认 0.002）
 * @param {number} [opts.theta] 慢相权重 θ（默认 0.5）
 * @returns {number} [0,1]，新记忆≈1、越旧越小
 */
export function activationFactor(ageMs, opts = {}) {
  const age = Math.max(0, num(ageMs, 0));
  const tier = opts.tier === 'hot' || opts.tier === 'warm' || opts.tier === 'cold'
    ? opts.tier
    : tierForAge(age, opts.boundaries || {});
  const lambdaFast = lambdaForTier(tier, opts.tierLambda);
  return dualPhaseRetention(age, {
    lambdaFast,
    lambdaSlow: num(opts.lambdaSlow, DEFAULT_BIPHASIC.lambdaSlow),
    theta: num(opts.theta, DEFAULT_BIPHASIC.theta),
  });
}

/**
 * 检索即强化：sal' = sal + η·(1 − sal)，clamp [0,1]。借鉴 OpenMemory `sal←sal+η(1-sal)`。
 * 越接近 1 增益越小（边际递减），被反复想起的记忆趋近但不超过满激活。纯函数，调用方负责持久化。
 * @param {number} salience01 现激活/显著度，归一到 [0,1]
 * @param {object} [opts]
 * @param {number} [opts.eta] 学习率 η（默认 0.3）
 * @param {number} [opts.times] 连续强化次数（默认 1；用于一次算多步）
 * @returns {number} [0,1]
 */
export function reinforce(salience01, opts = {}) {
  let sal = clamp01(salience01);
  const eta = Math.max(0, Math.min(1, num(opts.eta, DEFAULT_REINFORCE_ETA)));
  const times = Math.max(0, Math.trunc(num(opts.times, 1)));
  for (let i = 0; i < times; i += 1) {
    sal = sal + eta * (1 - sal);
  }
  return clamp01(sal);
}

/**
 * 「距上次想起多久」：让召回像回忆——优先按上次召回时间（lastHitAt）算年龄，
 * 缺失则回落 updatedAt → createdAt。即一条老记忆只要刚被想起过，时间激活就重新变高。
 * （这是把 OpenMemory「检索即强化 + 时间衰减」落到 Neo 记忆字段上的桥接，纯函数）
 * @param {object} item 记忆对象（MemoryCore 形态：lastHitAt/updatedAt/createdAt，ms epoch 或可解析串）
 * @param {object} [opts]
 * @param {() => number} [opts.now] 注入的当前时刻（默认 Date.now）
 * @returns {number} 年龄毫秒（>=0）；无任何时间字段则视为「极老」返回 Infinity
 */
export function ageSinceLastRecall(item = {}, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now() : Date.now();
  const ref = toEpochMs(item.lastHitAt) ?? toEpochMs(item.updatedAt) ?? toEpochMs(item.createdAt);
  if (ref == null) return Infinity;
  return Math.max(0, num(now, 0) - ref);
}

/**
 * 工厂：构造一个「记忆对象 → 时间激活因子 [0,1]」的打分器，供 fusion 排序作乘子。
 * env 门控、默认 OFF：未开 NOE_MEMORY_DYNAMIC_DECAY=1 时返回恒等打分器（() => 1），
 * 调用方乘上去等于「现行为不变」，可零风险回滚（符合本项目纪律）。
 *
 * 借鉴 OpenMemory 把「时间衰减 + 分档 + 检索强化」合成一个召回时叠加的激活能；
 * Neo 这里只取「时间激活」一维，与已有 salience 乘子正交叠加，不替换、不重复。
 *
 * @param {object} [deps]
 * @param {() => number} [deps.now] 注入当前时刻（默认 Date.now）
 * @param {Record<string,string|undefined>} [deps.env] 注入环境变量（默认 process.env）
 * @param {boolean} [deps.enabled] 显式开关；给定则覆盖 env 判断（测试用）
 * @param {object} [deps.boundaries] 分档边界覆盖
 * @param {object} [deps.tierLambda] 三档 λ₁ 覆盖
 * @param {number} [deps.lambdaSlow] 慢相 λ₂
 * @param {number} [deps.theta] 慢相 θ
 * @param {number} [deps.floor] 因子下限（防把老记忆压到 0 而彻底召不回，默认 0；建议接入时给 0.05~0.1）
 * @returns {(item: object) => number} 打分器，返回 [floor,1]
 */
export function makeActivationScorer(deps = {}) {
  const env = deps.env || (typeof process !== 'undefined' ? process.env : {}) || {};
  const enabled = typeof deps.enabled === 'boolean'
    ? deps.enabled
    : env.NOE_MEMORY_DYNAMIC_DECAY === '1';
  if (!enabled) {
    // 默认 OFF：恒等因子，乘到任何分数上都不改变排序。
    return () => 1;
  }
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const floor = clamp01(num(deps.floor, 0));
  const cfg = {
    boundaries: deps.boundaries || {},
    tierLambda: deps.tierLambda || DEFAULT_TIER_LAMBDA,
    lambdaSlow: num(deps.lambdaSlow, DEFAULT_BIPHASIC.lambdaSlow),
    theta: num(deps.theta, DEFAULT_BIPHASIC.theta),
  };
  return (item) => {
    const ageMs = ageSinceLastRecall(item || {}, { now });
    if (!Number.isFinite(ageMs)) return floor; // 无时间字段当极老 → 下限
    const factor = activationFactor(ageMs, cfg);
    return Math.max(floor, factor);
  };
}

// ── 接入提示（不在本模块改任何现有文件，仅说明用法） ─────────────────────────────
// 在 NoeFusionRanker.weightedFusion 之后（或调用处）叠时间维：
//   import { makeActivationScorer } from './NoeMemoryDynamics.js';
//   const activationOf = makeActivationScorer({ now: Date.now, floor: 0.1 }); // 默认 OFF
//   ranked.forEach(r => { r.score *= activationOf(itemById.get(r.id) || {}); });
//   ranked.sort((a, b) => b.score - a.score);
// 开 NOE_MEMORY_DYNAMIC_DECAY=1 后，「距上次想起越久」的记忆激活越低、刚被召回的回升，
// 让双路召回从「相关性 + 静态 salience」升级到「+ 随时间演化的激活能」。
