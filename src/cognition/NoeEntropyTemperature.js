// @ts-check
// NoeEntropyTemperature — 熵驱动的生成温度调节器。
//
// 借鉴 giansha/Global-Workspace-Agents 的 entropy_drive.py「内在新奇驱动」理念：
//   归一化念头向量 → K 个聚类中心在线 EMA 更新 → 余弦相似度 → softmax(τ) 成分布
//   → 香农熵 H → 动态温度 T_gen = T_base + α·exp(−β·H)。
//   语义停滞（念头在向量空间扎堆 ⇒ 簇少 ⇒ 熵低 ⇒ exp(−βH)≈1 ⇒ 升温）就自动鼓励发散；
//   发散够了（念头分散 ⇒ 簇多 ⇒ 熵高 ⇒ exp(−βH)≈0 ⇒ 回落基准）就自动收敛。
//   给 Neo 的好奇回路 / 意识流一个「想腻了自动换角度」的内在信号，比固定 temperature 更像自发好奇。
//
// 与原 Python 的两点偏离（修正其朴素实现的退化坑，并贴 Neo 栈）：
//   1) 在线聚类用「近则并入最近中心(EMA)、远(<spawnSim)且未满 K 才新开簇」——避免 N 个相同念头
//      被塞进 N 个独立簇而误判为高熵（原朴素逐个填槽会出此 bug；本实现下 4 个相同念头 ⇒ 1 簇 ⇒ H≈0 ⇒ 升温）。
//   2) 熵按 log(簇数) 归一到 [0,1] 再进指数，使 β 在不同 K 下含义稳定。
//
// 工程纪律（与 NoeMemoryEcho.js 同款）：
//   - 纯函数 + 注入式，全部参数可注入、确定性、不碰时钟/网络/RNG/真模型；
//   - 行为变化由 env NOE_ENTROPY_TEMPERATURE 门控，默认 OFF（factory 暴露 enabled，调用方自行分支）；
//   - fail-open：向量缺失/异常/不足以判新奇时，返回 T_base 不升温（保守默认，生成照常进行）。
//   - 向量内积语义与 src/embeddings/EmbeddingProvider.js 的 cosineSim 一致（假设可归一化）；
//     本模块自带防御性归一化，因此对「是否已归一化」的输入都成立，无需耦合 Sqlite/向量库。

import { clamp } from './_mathUtils.js';

/** 点积（与 EmbeddingProvider.cosineSim 同语义：取较短长度，假设向量可 L2 归一化）。 */
function dot(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += (Number(a[i]) || 0) * (Number(b[i]) || 0);
  return s;
}

/** L2 归一化；零向量原样返回（范数兜底为 1）。 */
function l2norm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += (Number(v[i]) || 0) * (Number(v[i]) || 0);
  const inv = 1 / (Math.sqrt(s) || 1);
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = (Number(v[i]) || 0) * inv;
  return out;
}

/** 过滤出有效（非空数值数组）的念头向量并归一化。 */
function sanitize(vectors) {
  if (!Array.isArray(vectors)) return [];
  const out = [];
  for (const v of vectors) {
    if (!Array.isArray(v) || v.length === 0) continue;
    if (!v.every((x) => Number.isFinite(Number(x)))) continue;
    out.push(l2norm(v));
  }
  return out;
}

/**
 * 在线聚类（借鉴 entropy_drive 的 EMA 聚类中心）：
 *   逐个念头找最近中心；相似度 ≥ spawnSim ⇒ EMA 并入并重新归一化；
 *   否则（且簇数 < k）⇒ 以该念头新开一簇。
 * @returns {Array<number[]>} 归一化的聚类中心列表
 */
function onlineCluster(vs, { k, lambda, spawnSim }) {
  /** @type {Array<number[]>} */
  const centers = [];
  for (const v of vs) {
    let bi = -1;
    let bs = -Infinity;
    for (let i = 0; i < centers.length; i++) {
      const s = dot(v, centers[i]);
      if (s > bs) { bs = s; bi = i; }
    }
    if (bi === -1 || (bs < spawnSim && centers.length < k)) {
      centers.push(v.slice());
      continue;
    }
    const c = centers[bi];
    for (let j = 0; j < c.length; j++) c[j] = (1 - lambda) * c[j] + lambda * (v[j] || 0);
    centers[bi] = l2norm(c);
  }
  return centers;
}

/**
 * 念头向量集合的归一化香农熵 ∈ [0,1]（borrow：entropy_drive 的 softmax(τ)+Shannon H）。
 * 每个念头对各簇做 softmax 软分配 → 累加成簇上分布 → H/log(簇数)。
 * 簇数 < 2（信号不足以判新奇）返回 null。
 * @returns {{ entropy: number, clusters: number } | null}
 */
export function clusterEntropy(vectors, {
  k = 5,
  tau = 0.3,
  lambda = 0.5,
  spawnSim = 0.6,
} = {}) {
  const vs = sanitize(vectors);
  if (vs.length < 2) return null; // 0/1 个念头：无新奇信号
  const centers = onlineCluster(vs, { k, lambda, spawnSim });
  if (centers.length < 2) return { entropy: 0, clusters: centers.length }; // 全扎一簇 ⇒ 熵 0
  const tt = tau > 1e-6 ? tau : 1e-6;
  const probs = new Array(centers.length).fill(0);
  for (const v of vs) {
    const sims = centers.map((c) => dot(v, c) / tt);
    const mx = Math.max(...sims);
    const ex = sims.map((s) => Math.exp(s - mx)); // 减最大值防上溢
    const z = ex.reduce((a, b) => a + b, 0) || 1;
    for (let i = 0; i < probs.length; i++) probs[i] += ex[i] / z;
  }
  const z = probs.reduce((a, b) => a + b, 0) || 1;
  let H = 0;
  for (const p of probs) {
    const q = p / z;
    if (q > 0) H -= q * Math.log(q);
  }
  const Hn = clamp(H / Math.log(centers.length), 0, 1);
  return { entropy: Hn, clusters: centers.length };
}

/**
 * 纯函数：由近期念头向量 + 基准温度算动态生成温度。
 *   T = clamp(Tbase + α·exp(−β·H), Tmin, Tmax)
 * 新奇度低（H 低 ⇒ 想腻了）⇒ 升温；新奇度高 ⇒ 回落 Tbase。
 * fail-open：向量不足/异常 ⇒ 返回 Tbase（不升温）。
 *
 * @param {number[][]} vectors 近期念头的（可归一化）向量数组
 * @param {object} [opts]
 * @param {number} [opts.baseTemperature=0.7] 基准温度 Tbase
 * @param {number} [opts.alpha=0.4]  升温幅度上限 α（H→0 时的最大加成）
 * @param {number} [opts.beta=4]     熵敏感度 β（越大越只在「极度扎堆」才升温）
 * @param {number} [opts.minTemperature=0.1]
 * @param {number} [opts.maxTemperature=1.5]
 * @param {number} [opts.k=5] 最大簇数
 * @param {number} [opts.tau=0.3] softmax 温度（仅用于算熵，与生成温度无关）
 * @param {number} [opts.lambda=0.5] EMA 学习率
 * @param {number} [opts.spawnSim=0.6] 低于此余弦相似度才允许新开簇
 * @returns {{ temperature: number, entropy: number | null, clusters: number, boosted: boolean }}
 */
export function computeEntropyTemperature(vectors, {
  baseTemperature = 0.7,
  alpha = 0.4,
  beta = 4,
  minTemperature = 0.1,
  maxTemperature = 1.5,
  k = 5,
  tau = 0.3,
  lambda = 0.5,
  spawnSim = 0.6,
} = {}) {
  const base = clamp(Number(baseTemperature) || 0, minTemperature, maxTemperature);
  let stat = null;
  try {
    stat = clusterEntropy(vectors, { k, tau, lambda, spawnSim });
  } catch {
    stat = null; // fail-open
  }
  if (!stat) {
    return { temperature: base, entropy: null, clusters: 0, boosted: false };
  }
  const boost = alpha * Math.exp(-beta * stat.entropy);
  const temperature = clamp(base + boost, minTemperature, maxTemperature);
  return {
    temperature,
    entropy: stat.entropy,
    clusters: stat.clusters,
    boosted: temperature > base + 1e-9,
  };
}

/**
 * 注入式 factory：把熵驱动温度挂到好奇回路 / 意识流。
 * env NOE_ENTROPY_TEMPERATURE 默认 OFF；OFF 时 .temperature() 恒返回 baseTemperature（零行为变化）。
 *
 * @param {object} [deps]
 * @param {Record<string,string|undefined>} [deps.env=process.env] 注入式 env（便于测试）
 * @param {boolean} [deps.enabled] 显式开关（优先于 env，便于测试不碰 process.env）
 * @param {object} [deps.config] 透传给 computeEntropyTemperature 的默认参数
 */
export function createEntropyTemperature({
  env = process.env,
  enabled,
  config = {},
} = {}) {
  const on = typeof enabled === 'boolean'
    ? enabled
    : String(env?.NOE_ENTROPY_TEMPERATURE || '').toLowerCase() === 'true'
      || env?.NOE_ENTROPY_TEMPERATURE === '1';

  /**
   * 给定近期念头向量与（可选覆盖的）基准温度，返回动态温度详情。
   * OFF ⇒ 直接返回 base，不做任何计算。
   * @param {number[][]} vectors
   * @param {object} [overrides] 单次调用覆盖 baseTemperature/alpha/beta 等
   */
  function temperature(vectors, overrides = {}) {
    const opts = { ...config, ...overrides };
    const base = clamp(
      Number(opts.baseTemperature ?? 0.7) || 0,
      Number(opts.minTemperature ?? 0.1),
      Number(opts.maxTemperature ?? 1.5),
    );
    if (!on) return { temperature: base, entropy: null, clusters: 0, boosted: false, enabled: false };
    const r = computeEntropyTemperature(vectors, opts);
    return { ...r, enabled: true };
  }

  return { enabled: on, temperature };
}
