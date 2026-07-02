// @ts-check
// NoeFisherRaoReranker — 用 Fisher-Rao 信息几何相似度对「向量召回命中」重排（给 MemoryCore.recallFused 作 cosine 名次的可选替代）。
//
// 底层改造的接线层：NoeFisherRaoSimilarity.js 是纯几何度量；本模块负责
//   ① 把「带不确定度的嵌入」这一信号造出来——估计每条嵌入的方差（不确定度）；
//   ② 用 fisherRaoSimilarity 把一路向量命中按「均值+方差」重排，输出新的名次列表。
//
// 方差/不确定度两路信号（缺一不可时都能优雅退化）：
//   A) 嵌入维度内蕴方差 estimateVarianceFromVector：向量各维相对其自身均值的样本方差。
//      零 join、对任何 provider 都可算；几何含义=该嵌入在各维上的「散布」，越散越不笃定。
//   B) 按 hit_count / salience 估不确定度 uncertaintyToVariance：反复命中(hit_count↑)、高显著性(salience↑)
//      = 反复确认过 = 更笃定 → 方差缩小；只在调用方愿意提供这些元信号时叠加(否则退化为仅 A)。
//
// 设计：纯函数 + 注入式，不读 env、不触网/时钟/模型、确定性可单测（遵 Noe 新文件三件套）。
//   env 门控判断在调用方(MemoryCore.recallFused，看 NOE_MEMORY_FISHER_RANK)；本模块只是「加法工具」。
//   优雅退化：query/hits 为空原样返回；某条命中无向量 → 该条相似度计 0(沉底，不抛错)；
//   全部等方差 → fisherRaoSimilarity 对 ‖Δmean‖ 单调，名次≈cosine(不会比裸 cosine 更差)。

import { fisherRaoSimilarity, fisherRaoSimilarityPreparedA, toStd } from './NoeFisherRaoSimilarity.js';

/** 方差数值下限：与 NoeFisherRaoSimilarity 的 EPS 同量级，避免 0 方差导致除零。 */
const VAR_FLOOR = 1e-6;

/**
 * 估计一条嵌入向量的「方差(不确定度)」——各维相对其自身均值的样本方差。
 * 零 join、纯向量内蕴；几何含义=嵌入在各维上的散布。返回标量方差(对角各维共用)。
 * @param {ArrayLike<number>|null|undefined} vec
 * @param {object} [opts]
 * @param {number} [opts.floor] 方差下限(默认 VAR_FLOOR)
 * @param {number} [opts.scale] 方差缩放(>0，默认 1；调大=整体更不确定/更宽容)
 * @returns {number} 标量方差 ≥ floor
 */
export function estimateVarianceFromVector(vec, { floor = VAR_FLOOR, scale = 1 } = {}) {
  const f = Number.isFinite(floor) && floor > 0 ? floor : VAR_FLOOR;
  const sc = Number.isFinite(scale) && scale > 0 ? scale : 1;
  if (!vec || typeof vec.length !== 'number' || vec.length <= 1) return f;
  const n = vec.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += Number(vec[i]) || 0;
  mean /= n;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = (Number(vec[i]) || 0) - mean;
    s += d * d;
  }
  s /= n;
  return Math.max(f, s * sc);
}

/**
 * 按 hit_count / salience 把基准方差「收紧」——反复确认过的记忆更笃定(方差更小)。
 * confidence = ln(1+hitCount) + 0.2·salience；factor = clamp(1/(1+confidence), min, max)；新方差 = baseVar·factor。
 * @param {number} baseVar 基准方差(通常来自 estimateVarianceFromVector)
 * @param {object} [opts]
 * @param {number} [opts.hitCount] 命中次数 ≥0(默认 0)
 * @param {number} [opts.salience] 显著性 1..5(默认 3)
 * @param {number} [opts.min] factor 下限(默认 0.25，最多收紧到 1/4)
 * @param {number} [opts.max] factor 上限(默认 1，不放大)
 * @returns {number} 收紧后的方差 ≥ VAR_FLOOR
 */
export function uncertaintyToVariance(baseVar, { hitCount = 0, salience = 3, min = 0.25, max = 1 } = {}) {
  const base = Number.isFinite(baseVar) && baseVar > 0 ? baseVar : VAR_FLOOR;
  const hc = Math.max(0, Number(hitCount) || 0);
  const sal = Math.max(0, Math.min(5, Number(salience) || 0));
  const lo = Number.isFinite(min) && min > 0 ? min : 0.25;
  const hi = Number.isFinite(max) && max > 0 ? max : 1;
  const confidence = Math.log1p(hc) + 0.2 * sal;
  const factor = Math.max(lo, Math.min(hi, 1 / (1 + confidence)));
  return Math.max(VAR_FLOOR, base * factor);
}

/**
 * 用 Fisher-Rao 相似度对一路向量命中重排。
 * @param {object} args
 * @param {ArrayLike<number>} args.queryVector 查询嵌入(均值)
 * @param {ArrayLike<number>|number|null} [args.queryVariance] 查询方差；缺省→由 queryVector 估计
 * @param {Array<{refId?:string, vector?:ArrayLike<number>, variance?:ArrayLike<number>|number|null, [k:string]:any}>} args.hits
 *   向量命中(已含解码后的 vector，最好附 variance；缺 variance 则按各自 vector 估计)
 * @param {object} [args.opts]
 * @param {number} [args.opts.scale] 传给 fisherRaoSimilarity 的距离衰减尺度(默认 1)
 * @returns {Array} 重排后的 hits(每条附 fisherSim ∈[0,1])；输入非法/为空时原样返回
 */
export function fisherRaoRerank({ queryVector, queryVariance = null, hits, opts = {} } = {}) {
  const list = Array.isArray(hits) ? hits : [];
  if (!queryVector || typeof queryVector.length !== 'number' || queryVector.length <= 0 || !list.length) {
    return list;
  }
  const scale = Number.isFinite(opts.scale) && opts.scale > 0 ? opts.scale : 1;
  const qVar = queryVariance == null ? estimateVarianceFromVector(queryVector) : queryVariance;
  // 性能：查询侧标准差只随 (qVar, queryVector.length) 变，与候选无关 → 循环外预算一次复用，
  // 消除每个命中都重算 toStd(同一 qVar, 同一 dim) 的 Float64Array 分配 + 逐维开方
  // （召回 limit 可达 100、真实嵌入维度 768/1024，原先每次召回多算约 limit×dim 次开方）。
  // 仅当候选与查询同维时走预算版（向量检索 SQL `dim=?` 已保证；此时 dim=queryVector.length=qStd.length，
  // 结果与 fisherRaoSimilarity 逐字相同）；异维候选回退原路径，行为不变。
  const qLen = queryVector.length;
  const qStd = toStd(qVar, qLen);
  const scored = list.map((h, idx) => {
    const vec = h && h.vector;
    let sim = 0;
    if (vec && typeof vec.length === 'number' && vec.length > 0) {
      const variance = h.variance == null ? estimateVarianceFromVector(vec) : h.variance;
      sim = vec.length === qLen
        ? fisherRaoSimilarityPreparedA(queryVector, qStd, vec, variance, { scale })
        : fisherRaoSimilarity(queryVector, qVar, vec, variance, { scale });
    }
    return { hit: h, sim, idx };
  });
  // 相似度降序；并列保持原相对名次(稳定)，让无向量命中(sim=0)沉底
  scored.sort((a, b) => (b.sim - a.sim) || (a.idx - b.idx));
  return scored.map(({ hit, sim }) => ({ ...hit, fisherSim: sim }));
}

/**
 * 工厂：返回 (queryVector, hits) => 重排后 hits 的便捷函数，便于注入到 MemoryCore。
 * 不读 env、不持状态；env 门控由调用方决定是否构造并使用。
 * @param {object} [opts]
 * @param {number} [opts.scale] 见 fisherRaoRerank
 * @returns {(queryVector:ArrayLike<number>, hits:Array, queryVariance?:any)=>Array}
 */
export function makeFisherRaoReranker({ scale = 1 } = {}) {
  return (queryVector, hits, queryVariance = null) =>
    fisherRaoRerank({ queryVector, queryVariance, hits, opts: { scale } });
}
