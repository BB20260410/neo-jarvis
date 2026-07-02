// @ts-check
// NoeFisherRaoSimilarity — 对角高斯 Fisher-Rao 信息几何相似度（给 NoeFusionRanker 作 cosine 的可选替代度量）。
//
// 借鉴 SuperLocalMemory(qualixar/superlocalmemory) math/fisher.py 的 Y：
//   把嵌入当"带不确定度的对角高斯分布"而非空间里一个点，用 Atkinson-Mitchell(1981) 闭式解
//   逐维算两个一维高斯在 Fisher-Rao 度量(=上半平面双曲度量)下的测地距离，再按可加性平方求和开方：
//       单维  d_i = √2 · arccosh(1 + δ_i)
//       其中  δ_i = ((mA_i - mB_i)² + 2·(sA_i - sB_i)²) / (4 · sA_i · sB_i)   (s = 标准差)
//   多维对角高斯各维独立，Fisher-Rao 距离平方可加：d = √(Σ_i d_i²)。
//   只 borrow 这条"对带方差嵌入比裸 cosine 鲁棒"的理念；Neo 已有的 RRF/min-max 加权(NoeFusionRanker)、
//   矛盾检测(NoeMemoryConflictPolicy)、图谱扩散(NoeKnowledgeGraph) 不在此重复。
//
// 设计：纯函数 + 注入式，无副作用、不触网/时钟/模型，确定性可单测（遵 Noe 新文件三件套）。
// env 门控理念：本模块只是"加法工具"，不改任何现有文件、不动默认召回路径。
//   接线侧约定环境变量 NOE_MEMORY_FISHER_RANK=1 才在 NoeFusionRanker 里启用本度量替代 cosine，
//   默认 OFF 时 weightedFusion 行为逐字不变；回滚 = 关 env（+ 删本文件）。
//   —— 注意：env 读取与门控判断放在接线点(见 integrationHint)，本纯函数模块不读 process.env，保持可测与无副作用。

/** 数值下限：标准差/方差被钳到该值以上，避免除零与 NaN（对角高斯退化为点时的稳健化）。 */
const EPS = 1e-12;

/**
 * 数值稳定的 arccosh。
 * 借鉴 fisher.py 的"数值稳定 Taylor 展开"理念：x→1⁺ 时 arccosh(x)=√(2(x-1))·(1 - (x-1)/12 + ...)，
 * 直接 log(x+√(x²-1)) 在 x 极近 1 时 √(x²-1) 抵消会丢精度。这里对 (x-1) 很小走 Taylor，其余走标准式。
 * @param {number} x 应 ≥ 1
 * @returns {number} arccosh(x) ≥ 0
 */
export function stableArccosh(x) {
  const v = Number(x);
  if (!Number.isFinite(v) || v <= 1) return 0; // x≤1（含数值噪声略小于 1）→ 距离 0，钳到下界保稳健
  const t = v - 1;
  if (t < 1e-6) {
    // 小 t 的级数展开：arccosh(1+t) = √(2t) · (1 - t/12 + 3t²/160 - ...)
    return Math.sqrt(2 * t) * (1 - t / 12 + (3 * t * t) / 160);
  }
  return Math.log(v + Math.sqrt(v * v - 1));
}

/**
 * 把方差向量规整成长度 dim 的标准差数组（钳到 EPS 之上）。
 * @param {ArrayLike<number>|number|null|undefined} variance
 *   - 数组：逐维方差（长度不足/为空按等方差 1 回退该维）
 *   - 标量：所有维共用该方差（等方差 → 行为接近 cosine）
 *   - null/undefined：等方差 1（缺省退化路径）
 * @param {number} dim
 * @returns {Float64Array} 各维标准差 σ_i ≥ √EPS
 */
// 导出：供调用方（如 NoeFisherRaoReranker 批量重排）把「查询侧标准差数组」在循环外预算一次复用，
// 消除每个候选都重复 toStd(同一 query 方差, 同一 dim) 的冗余分配/开方（结果逐字等价，只更快）。
export function toStd(variance, dim) {
  const out = new Float64Array(dim);
  if (variance == null) {
    out.fill(1);
    return out;
  }
  if (typeof variance === 'number') {
    const s = Math.sqrt(Math.max(EPS, Number.isFinite(variance) ? variance : 1));
    out.fill(s);
    return out;
  }
  const arr = variance;
  const len = typeof arr.length === 'number' ? arr.length : 0;
  for (let i = 0; i < dim; i++) {
    const raw = i < len ? Number(arr[i]) : 1;
    const v = Number.isFinite(raw) && raw > 0 ? raw : (raw === 0 ? EPS : 1); // 0→EPS（点质量稳健化）；负/NaN→1
    out[i] = Math.sqrt(Math.max(EPS, v));
  }
  return out;
}

/**
 * 对角高斯 Fisher-Rao 测地距离（Atkinson-Mitchell 闭式解，逐维平方可加）。
 * 借鉴 fisher.py 的核心几何：嵌入 = 带不确定度的高斯，距离对"反复确认过(方差小) vs 道听途说(方差大)"区别对待。
 *
 * 性质（已数值核验）：
 *   - 同分布 → 0；关于 (A,B) 对称；恒 ≥ 0。
 *   - 等方差时对 ‖mA-mB‖ 单调（与单位向量 cosine 排序一致，故缺省/等方差路径 ≈ cosine 行为）。
 *   - 方差越大（越不确定），同样的均值差产生的距离越小（更宽容）；方差差异本身也贡献距离。
 *
 * @param {ArrayLike<number>} meanA A 的均值向量（嵌入）
 * @param {ArrayLike<number>|number|null} [varA] A 的对角方差（数组/标量/缺省，见 toStd）
 * @param {ArrayLike<number>} meanB B 的均值向量（嵌入）
 * @param {ArrayLike<number>|number|null} [varB] B 的对角方差
 * @returns {number} Fisher-Rao 距离 ∈ [0, +∞)；维度为 0 或非法输入返回 0
 */
export function fisherRaoDistance(meanA, varA, meanB, varB) {
  if (!meanA || !meanB || typeof meanA.length !== 'number' || typeof meanB.length !== 'number') return 0;
  const dim = Math.min(meanA.length, meanB.length);
  if (dim <= 0) return 0;
  return frDistanceFromStd(meanA, toStd(varA, dim), meanB, toStd(varB, dim), dim);
}

/**
 * 距离核心（逐字等价于上方内联循环，抽出供「预算标准差」路径复用，杜绝两处算术漂移）。
 * 调用方须保证 sA/sB 长度 ≥ dim（toStd 产物天然满足）。
 * @param {ArrayLike<number>} meanA
 * @param {ArrayLike<number>} sA 各维标准差（已 toStd 规整）
 * @param {ArrayLike<number>} meanB
 * @param {ArrayLike<number>} sB
 * @param {number} dim
 * @returns {number} Fisher-Rao 距离 ≥ 0
 */
function frDistanceFromStd(meanA, sA, meanB, sB, dim) {
  let sumSq = 0;
  for (let i = 0; i < dim; i++) {
    const mA = Number(meanA[i]) || 0;
    const mB = Number(meanB[i]) || 0;
    const s1 = sA[i];
    const s2 = sB[i];
    const dm = mA - mB;
    const ds = s1 - s2;
    // δ_i = ((Δm)² + 2(Δs)²) / (4 s1 s2)
    const delta = (dm * dm + 2 * ds * ds) / (4 * s1 * s2);
    const di = Math.SQRT2 * stableArccosh(1 + delta); // 单维测地距离
    sumSq += di * di;                                  // 对角可加：累加平方
  }
  return Math.sqrt(sumSq);
}

/**
 * 批量优化入口：A 侧标准差数组已在循环外预算好（toStd(varA, dimA)），对一个 B 复用。
 * 仅当 meanB.length === dimA（即 A/B 同维，向量检索 SQL `dim=?` 已保证）时调用方应走本路径；
 * 此时 dim = min(meanA.length, meanB.length) = sA.length，结果与 fisherRaoDistance(meanA, varA, meanB, varB) 逐字相同。
 * @param {ArrayLike<number>} meanA
 * @param {Float64Array} sA 预算的 A 侧标准差（长度=dimA）
 * @param {ArrayLike<number>} meanB
 * @param {ArrayLike<number>|number|null} [varB]
 * @returns {number} Fisher-Rao 距离 ≥ 0；非法/空维 → 0
 */
export function fisherRaoDistancePreparedA(meanA, sA, meanB, varB) {
  if (!meanA || !meanB || !sA || typeof meanB.length !== 'number' || typeof sA.length !== 'number') return 0;
  const dim = Math.min(sA.length, meanB.length);
  if (dim <= 0) return 0;
  return frDistanceFromStd(meanA, sA, meanB, toStd(varB, dim), dim);
}

/**
 * fisherRaoSimilarity 的「A 侧标准差预算版」（批量重排专用）：等价于
 * fisherRaoSimilarity(meanA, varA, meanB, varB, {scale})，前提 sA = toStd(varA, meanA.length) 且 A/B 同维。
 * @param {ArrayLike<number>} meanA
 * @param {Float64Array} sA
 * @param {ArrayLike<number>} meanB
 * @param {ArrayLike<number>|number|null} varB
 * @param {object} [opts]
 * @param {number} [opts.scale] 见 distanceToSimilarity
 * @returns {number} ∈ [0,1]
 */
export function fisherRaoSimilarityPreparedA(meanA, sA, meanB, varB, { scale = 1 } = {}) {
  return distanceToSimilarity(fisherRaoDistancePreparedA(meanA, sA, meanB, varB), { scale });
}

/**
 * 把 Fisher-Rao 距离映射到 [0,1] 相似度（越大越相似），供与 cosine 同向作排序分。
 * 采用 sim = 1 / (1 + d/scale)：单调递减、d=0→1、d→∞→0；scale 控制衰减尺度（默认 1）。
 * 借鉴"用数学替代 LLM 打分"的零云理念：纯解析、确定性、无外部依赖。
 *
 * @param {number} distance fisherRaoDistance 的输出（应 ≥ 0）
 * @param {object} [opts]
 * @param {number} [opts.scale] 距离衰减尺度（>0，默认 1；越大对距离越宽容、相似度衰减越慢）
 * @returns {number} 相似度 ∈ [0,1]
 */
export function distanceToSimilarity(distance, { scale = 1 } = {}) {
  const d = Number(distance);
  if (!Number.isFinite(d) || d <= 0) return 1; // 距离 0 或非法 → 完全相似（与 cosine 自相似=1 对齐）
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return 1 / (1 + d / s);
}

/**
 * 便捷组合：直接给出两个（带方差的）嵌入的 Fisher-Rao 相似度 ∈ [0,1]。
 * 这是给 NoeFusionRanker 当 cosine 替代度量的主入口（参数同 fisherRaoDistance + scale）。
 * @param {ArrayLike<number>} meanA
 * @param {ArrayLike<number>|number|null} varA
 * @param {ArrayLike<number>} meanB
 * @param {ArrayLike<number>|number|null} varB
 * @param {object} [opts]
 * @param {number} [opts.scale] 见 distanceToSimilarity
 * @returns {number} ∈ [0,1]
 */
export function fisherRaoSimilarity(meanA, varA, meanB, varB, { scale = 1 } = {}) {
  return distanceToSimilarity(fisherRaoDistance(meanA, varA, meanB, varB), { scale });
}

/**
 * 工厂：返回一个签名为 (a, b) 的相似度函数，便于注入到 NoeFusionRanker 当 cosine 的可选替代。
 * 借鉴式注入设计：不读 env、不持有状态；env 门控由调用方决定是否构造并传入本函数。
 * @param {object} [opts]
 * @param {number} [opts.scale] 见 distanceToSimilarity
 * @param {(x:any)=>{mean:ArrayLike<number>, variance?:ArrayLike<number>|number|null}} [opts.accessor]
 *   从一个候选条目里取出 {mean, variance}；默认把入参当 {mean,variance} 或直接当 mean 数组。
 * @returns {(a:any, b:any)=>number} (a,b) → 相似度 ∈ [0,1]
 */
export function makeFisherRaoSimilarity({ scale = 1, accessor = null } = {}) {
  const get = typeof accessor === 'function'
    ? accessor
    : (/** @type {any} */ x) => {
        if (x && typeof x === 'object' && !Array.isArray(x) && 'mean' in x) {
          return { mean: x.mean, variance: 'variance' in x ? x.variance : null };
        }
        return { mean: x, variance: null }; // 裸数组：当无方差 → 退化接近 cosine
      };
  return (a, b) => {
    const A = get(a);
    const B = get(b);
    return fisherRaoSimilarity(A.mean, A.variance, B.mean, B.variance, { scale });
  };
}