// @ts-check
// NoeCalibrationCurve — 期望校准曲线（Brier + ECE + MCE + n-bin reliability），P2 觉醒看板。
//
// 为什么：NoeExpectationLedger.brier() 只给单个 Brier 标量，看不出「我说 60% 的事里实际几成
//   应验」的逐档对齐。本模块补 reliability 曲线——觉醒候选信号之一「自知之明可量化」。
//
// 纪律：纯函数、注入式（吃 [{p,outcome}] 行，零 IO/零依赖/不触库不触网），可确定性单测。
//   与 scikit-learn 逐位对齐（验收门 <1e-9），杜绝「自造校准口径，数字好看但不可信」：
//   - brier      ≡ sklearn.metrics.brier_score_loss        = mean((p - outcome)^2)
//   - reliability ≡ sklearn.calibration.calibration_curve(strategy='uniform', n_bins=N)
//       bins = linspace(0,1,N+1)；binId = searchsorted(bins[1:-1], p, side='left')（边界归左 bin）；
//       只对非空 bin 出点；prob_pred=bin 内 p 均值，prob_true=bin 内 outcome 均值。
//   - ece = Σ(binCount/N)·|observed - avgPredicted|（标准 Expected Calibration Error）
//   - mce = max|observed - avgPredicted|（最坏单 bin 偏差）

/**
 * numpy.searchsorted side='left' 复刻：升序 arr 中 v 的插入位（v == 边界值时归左，与 sklearn 一致）。
 * @param {number[]} arr 升序内部边界
 * @param {number} v
 * @returns {number} 0..arr.length
 */
function searchSortedLeft(arr, v) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 算校准曲线。脏行（p 非有限 / 越界 / outcome 非 0|1）静默剔除，不抛。
 * @param {Array<{p:number, outcome:number}>} rows  p∈[0,1] 预测概率，outcome∈{0,1} 实际
 * @param {{ binCount?: number }} [opts]
 * @returns {{
 *   n: number,
 *   brier: number|null,
 *   ece: number|null,
 *   mce: number|null,
 *   bins: Array<{ lo:number, hi:number, count:number, avgPredicted:number, observedRate:number, gap:number }>
 * }}
 */
export function calibrationCurve(rows, { binCount = 10 } = {}) {
  // P2-F5：boolean outcome 归一为 0/1，与 NoeExpectationLedger.brier/resolve 同口径（防上游传 true/false 被静默吞）。
  const clean = Array.isArray(rows)
    ? rows.map((r) => (r && (r.outcome === true || r.outcome === false) ? { ...r, outcome: r.outcome ? 1 : 0 } : r))
      .filter((r) => r
        && Number.isFinite(r.p) && r.p >= 0 && r.p <= 1
        && (r.outcome === 0 || r.outcome === 1))
    : [];
  const n = clean.length;
  if (!n) return { n: 0, brier: null, ece: null, mce: null, bins: [] };

  const nBins = Math.max(2, Math.min(50, Math.round(Number(binCount)) || 10));

  // Brier ≡ brier_score_loss
  const brier = clean.reduce((s, r) => s + (r.p - r.outcome) ** 2, 0) / n;

  // 内部边界 bins[1:-1] = [1/N, 2/N, …, (N-1)/N]（共 N-1 个），searchsorted 归桶。
  const edges = [];
  for (let i = 1; i < nBins; i += 1) edges.push(i / nBins);

  const sumP = new Array(nBins).fill(0);
  const sumTrue = new Array(nBins).fill(0);
  const total = new Array(nBins).fill(0);
  for (const r of clean) {
    const b = searchSortedLeft(edges, r.p); // 0..nBins-1
    sumP[b] += r.p;
    sumTrue[b] += r.outcome;
    total[b] += 1;
  }

  const bins = [];
  let ece = 0;
  let mce = 0;
  for (let i = 0; i < nBins; i += 1) {
    if (total[i] === 0) continue; // sklearn 只出非空 bin
    const avgPredicted = sumP[i] / total[i];
    const observedRate = sumTrue[i] / total[i];
    const gap = Math.abs(observedRate - avgPredicted);
    ece += (total[i] / n) * gap;
    if (gap > mce) mce = gap;
    bins.push({ lo: i / nBins, hi: (i + 1) / nBins, count: total[i], avgPredicted, observedRate, gap });
  }

  return { n, brier, ece, mce, bins };
}
