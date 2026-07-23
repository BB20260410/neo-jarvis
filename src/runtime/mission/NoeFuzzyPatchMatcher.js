// @ts-check
// NoeFuzzyPatchMatcher（P4-4）——自改 patch 的「容漂移」匹配层：当精确 from 因行号漂移/极小编辑未命中时，
// 按**内容相似度**（非行号）在文件里找最匹配块。审计裁定「P0-P5 期间禁纯行号漂移模糊 patch」——本模块用
// 内容相似度 + 高阈值门 + 唯一性判定，是合规的安全版（非按行号盲移）。
//
// 硬约束（审计 MEDIUM-3）：① 相似度 < 阈值（默认 0.9）拒；② 多个等高相似块（歧义）拒（同精确 from occ>1）；
// ③ 命中只返回「文件内逐字块」供调用方做精确 replace + 强制 npm test verify + 失败自动 rollback（复用既有
// applyAndVerify，本模块不写盘）。**opt-in**：默认不接入已验证的精确 from 链路（保自改核心完整），作可选 fallback。

function lines(s) { return String(s ?? '').split('\n'); }

// 行级 Dice 相似度（多重集交集 ×2 / 两边行数和）；对「同内容漂移」=1.0，对极小编辑高但 <1。
function diceLineSimilarity(aLines, bLines) {
  if (aLines.length === 0 && bLines.length === 0) return 1;
  if (aLines.length === 0 || bLines.length === 0) return 0;
  const norm = (x) => x.trim();
  const bag = new Map();
  for (const l of aLines) { const k = norm(l); bag.set(k, (bag.get(k) || 0) + 1); }
  let common = 0;
  for (const l of bLines) {
    const k = norm(l);
    const c = bag.get(k) || 0;
    if (c > 0) { common += 1; bag.set(k, c - 1); }
  }
  return (2 * common) / (aLines.length + bLines.length);
}

/**
 * 在 content 中按内容相似度找 fromSnippet 的最佳匹配块。
 * @param {string} content 文件全文
 * @param {string} fromSnippet 目标片段
 * @param {{ minSimilarity?: number, maxWindowDelta?: number, maxFileLines?: number, ambiguityMargin?: number }} [opts]
 * @returns {{matched:boolean, reason:string, block?:string, similarity?:number, startLine?:number}}
 */
export function findFuzzyMatch(content, fromSnippet, opts = {}) {
  const minSimilarity = Number.isFinite(opts.minSimilarity) ? opts.minSimilarity : 0.9;
  const maxWindowDelta = Number.isFinite(opts.maxWindowDelta) ? Math.max(0, Math.trunc(opts.maxWindowDelta)) : 2;
  const maxFileLines = Number.isFinite(opts.maxFileLines) ? opts.maxFileLines : 20000;
  const ambiguityMargin = Number.isFinite(opts.ambiguityMargin) ? opts.ambiguityMargin : 0.03;

  const fromLines = lines(fromSnippet);
  const contentLines = lines(content);
  const n = fromLines.length;
  if (!String(fromSnippet ?? '').trim()) return { matched: false, reason: 'empty_from' };
  if (n === 0 || contentLines.length === 0) return { matched: false, reason: 'empty_content' };
  if (contentLines.length > maxFileLines) return { matched: false, reason: 'file_too_large' };

  const sizes = [];
  for (let d = -maxWindowDelta; d <= maxWindowDelta; d += 1) { const sz = n + d; if (sz >= 1) sizes.push(sz); }
  // 第一遍：找全局最佳窗口。
  let best = { sim: -1, start: -1, size: 0 };
  for (const size of sizes) {
    for (let start = 0; start + size <= contentLines.length; start += 1) {
      const sim = diceLineSimilarity(contentLines.slice(start, start + size), fromLines);
      if (sim > best.sim) best = { sim, start, size };
    }
  }
  if (best.sim < minSimilarity) return { matched: false, reason: 'below_threshold', similarity: Number(Math.max(0, best.sim).toFixed(4)) };
  // 第二遍：找与 best **不重叠**区域的最高相似 rival（重叠的同区域不同窗口大小不算歧义）。
  const bestEnd = best.start + best.size;
  let rivalSim = -1;
  for (const size of sizes) {
    for (let start = 0; start + size <= contentLines.length; start += 1) {
      const overlaps = !(start >= bestEnd || start + size <= best.start);
      if (overlaps) continue;
      const sim = diceLineSimilarity(contentLines.slice(start, start + size), fromLines);
      if (sim > rivalSim) rivalSim = sim;
    }
  }
  // 真歧义：另一个不相干区域相似度逼近 best（差 < margin）→ 拒（防改错地方，同精确 from occ>1）。
  if (rivalSim >= 0 && best.sim - rivalSim < ambiguityMargin) {
    return { matched: false, reason: 'ambiguous_multiple_matches', similarity: Number(best.sim.toFixed(4)), rivalSimilarity: Number(rivalSim.toFixed(4)) };
  }
  const block = contentLines.slice(best.start, best.start + best.size).join('\n');
  return { matched: true, reason: 'fuzzy_matched', block, similarity: Number(best.sim.toFixed(4)), startLine: best.start + 1 };
}
