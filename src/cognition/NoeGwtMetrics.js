// @ts-check
// NoeGwtMetrics（P2-2）——全局工作区（GWT）竞争/广播的**可观测指标**，证明 GWT 不是空跑。
//
// 计划 P2-2：赢家 coalition / 广播半径 / 注意力切换频率 落 mind.html，随输入变化（非恒定）。
// 设计：进程内滚动窗口（默认 200 次广播），每次广播 record({winner, candidateCount}）；snapshot() 出：
//   - broadcastCount / switchCount / switchRate（注意力切换频率：相邻广播赢家变更占比）
//   - winnerDistribution + coalitionEntropy（赢家分布香农熵，越高=注意力越分散、不被单一焦点垄断）
//   - avgCandidatePool（竞争广度=每次广播的候选数均值，广播半径代理）
//   - topWinners（最常赢的焦点源）
// 纯内存、只读快照、零付费依赖；read-only 可观测面默认常开（owner 偏好可观测）。

function shannonEntropyBits(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let h = 0;
  for (const c of counts) { if (c > 0) { const p = c / total; h -= p * Math.log2(p); } }
  return h;
}

function clean(v, max = 80) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * @param {{ windowSize?: number, now?: () => number }} deps
 */
export function createGwtMetrics({ windowSize = 200, now = () => Date.now() } = {}) {
  const cap = Math.max(10, Math.min(5000, Math.trunc(Number(windowSize) || 200)));
  const ring = []; // { winner, candidateCount, ts }
  let lastWinner = null;

  function record({ winner = '', candidateCount = 0 } = {}) {
    const w = clean(winner, 80) || 'unknown';
    const entry = { winner: w, candidateCount: Math.max(0, Math.trunc(Number(candidateCount) || 0)), ts: Number(typeof now === 'function' ? now() : now) || 0 };
    // switch：与上一次广播赢家不同 = 一次注意力切换
    entry.switched = lastWinner !== null && lastWinner !== w;
    lastWinner = w;
    ring.push(entry);
    if (ring.length > cap) ring.shift();
    return entry;
  }

  function snapshot() {
    const broadcastCount = ring.length;
    if (broadcastCount === 0) {
      return { ok: true, broadcastCount: 0, switchCount: 0, switchRate: 0, coalitionEntropy: 0, avgCandidatePool: 0, winnerDistribution: {}, topWinners: [] };
    }
    const dist = {};
    let switchCount = 0;
    let poolSum = 0;
    for (const e of ring) {
      dist[e.winner] = (dist[e.winner] || 0) + 1;
      if (e.switched) switchCount += 1;
      poolSum += e.candidateCount;
    }
    const denomSwitch = Math.max(1, broadcastCount - 1); // 切换以相邻对计
    const topWinners = Object.entries(dist).map(([winner, count]) => ({ winner, count }))
      .sort((a, b) => b.count - a.count).slice(0, 5);
    return {
      ok: true,
      broadcastCount,
      switchCount,
      switchRate: Number((switchCount / denomSwitch).toFixed(4)),
      coalitionEntropy: Number(shannonEntropyBits(Object.values(dist)).toFixed(4)),
      avgCandidatePool: Number((poolSum / broadcastCount).toFixed(2)),
      winnerDistribution: dist,
      topWinners,
    };
  }

  function reset() { ring.length = 0; lastWinner = null; }

  return { record, snapshot, reset };
}
