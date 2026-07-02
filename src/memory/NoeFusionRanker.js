// NoeFusionRanker — 向量 × FTS 双路融合召回排序（解 MemoryCore 仅 trigram FTS 的召回质量缺口）。
//
// 来自 BaiLongma db.js 思路：并跑向量相似 + 全文检索两路，融合排序，叠加 salience 二级权重。
// 提供两种融合：① RRF（Reciprocal Rank Fusion，只看名次、无需分数可比，最稳）；
//   ② 加权归一（vectorWeight*sim + ftsWeight*ftsScore，约定"分数越大越相关"；bm25 等"越小越相关"的分数须调用方先转符号）。纯函数可独立单测；
//   实际两路检索（embeddings store + FTS）接 MemoryCore 归后续接线。

/**
 * Reciprocal Rank Fusion：对多路排名列表，按 sum(1/(k+rank)) 融合。名次驱动，跨路分数不可比时首选。
 * @param {Array<Array<{id:any} | string | number>>} rankings 多路结果，每路是 [{id}, ...] 或 [id, ...]（已按相关性降序）
 * @param {object} [opts]
 * @param {number} [opts.k] RRF 常数（默认 60，经验值，抑制头部名次过度主导）
 * @returns {Array<{id:string, score:number}>} 融合后降序
 */
export function reciprocalRankFusion(rankings, { k = 60 } = {}) {
  const scores = new Map();
  for (const ranking of Array.isArray(rankings) ? rankings : []) {
    const seenInRanking = new Set();
    (Array.isArray(ranking) ? ranking : []).forEach((item, idx) => {
      const id = item && typeof item === 'object' ? item.id : item;
      if (id == null || id === '') return;
      const key = String(id);
      if (seenInRanking.has(key)) return;  // 同一路内重复 id 只按最佳名次计一次(标准 RRF，防重复累加扭曲融合)
      seenInRanking.add(key);
      scores.set(key, (scores.get(key) || 0) + 1 / (k + idx + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

function normalizeScores(list) {
  const arr = Array.isArray(list) ? list.filter((x) => x && x.id != null) : [];
  const m = new Map();
  if (!arr.length) return m;
  const vals = arr.map((x) => Number(x.score) || 0);
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const range = max - min;
  // min-max 归一到 [0,1]：原"除以 max"在分数为负(如 SQLite FTS5 bm25 返回负值)时会反转名次并产生巨值；
  // min-max 对任意符号稳健。range 为 0(单条/全等)时统一归 1。
  // 约定：本函数假定"分数越大越相关"；bm25 等"越小越相关"的分数须由调用方先转符号再传入。
  for (const x of arr) {
    const v = Number(x.score) || 0;
    m.set(String(x.id), range > 0 ? (v - min) / range : 1);
  }
  return m;
}

/**
 * salience 1-5 → 1.0-1.4 的温和加成因子（软加权：抬升重要记忆但不淹没相关性）。
 * 抽成单一真源供 weightedFusion 与 MemoryCore.recallFused 复用，杜绝两处各写一套映射漂移。
 * 非数/缺省/<=0 → 1.0（不加成）；>=5 → 1.4。
 * @param {number} s salience（约定 1-5）
 * @returns {number} [1.0, 1.4] 的乘子
 */
export function salienceBoostFactor(s) {
  const n = Number(s) || 0;
  return 1 + Math.max(0, Math.min(5, n)) * 0.08;
}

/**
 * 加权归一融合：各路分数归一到 [0,1] 后加权相加，可叠加 salience 二级权重。
 * @param {Array<{id:string|number, score:number}>} vectorResults 向量相似结果
 * @param {Array<{id:string|number, score:number}>} ftsResults 全文检索结果
 * @param {object} [opts]
 * @param {number} [opts.vectorWeight] 默认 0.6
 * @param {number} [opts.ftsWeight] 默认 0.4
 * @param {(id:string)=>number} [opts.salience] 返回 1-5 的重要度，作二级权重（默认不加权）
 * @returns {Array<{id:string, score:number}>}
 */
export function weightedFusion(vectorResults, ftsResults, { vectorWeight = 0.6, ftsWeight = 0.4, salience } = {}) {
  const v = normalizeScores(vectorResults);
  const f = normalizeScores(ftsResults);
  const ids = new Set([...v.keys(), ...f.keys()]);
  const sal = typeof salience === 'function' ? salience : null;
  return [...ids]
    .map((id) => {
      let score = vectorWeight * (v.get(id) || 0) + ftsWeight * (f.get(id) || 0);
      if (sal) {
        // salience 1-5 → 1.0-1.4 的温和加成（复用 salienceBoostFactor 单一真源，避免淹没相关性）
        score *= salienceBoostFactor(sal(id));
      }
      return { id, score };
    })
    .sort((a, b) => b.score - a.score);
}
