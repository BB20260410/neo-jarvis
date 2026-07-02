// @ts-check
import { describe, expect, it } from 'vitest';
import { calibrationCurve } from '../../src/cognition/NoeCalibrationCurve.js';

// P2 觉醒看板·期望校准曲线。验收门：与 scikit-learn 逐位一致（<1e-9）。
// Oracle 数据集（手算 = sklearn.calibration.calibration_curve(strategy='uniform',n_bins=10)
//   + sklearn.metrics.brier_score_loss 的精确解析值）：
//   bin0: p=0.1 ×3 → outcome {0,0,1}      → prob_pred=0.1,  prob_true=1/3
//   bin3: p=0.35 ×2 → outcome {0,1}        → prob_pred=0.35, prob_true=0.5
//   bin8: p=0.9 ×2 → outcome {1,1}         → prob_pred=0.9,  prob_true=1.0
const ORACLE = [
  { p: 0.1, outcome: 0 }, { p: 0.1, outcome: 0 }, { p: 0.1, outcome: 1 },
  { p: 0.35, outcome: 0 }, { p: 0.35, outcome: 1 },
  { p: 0.9, outcome: 1 }, { p: 0.9, outcome: 1 },
];

describe('calibrationCurve（P2，sklearn 逐位一致）', () => {
  it('Brier ≡ brier_score_loss（解析值 1.395/7）', () => {
    const r = calibrationCurve(ORACLE);
    expect(r.n).toBe(7);
    // (2*0.01 + 0.81 + 0.1225 + 0.4225 + 2*0.01)/7
    expect(r.brier).toBeCloseTo(1.395 / 7, 12);
  });

  it('reliability bins ≡ calibration_curve（prob_pred / prob_true 逐位）', () => {
    const r = calibrationCurve(ORACLE);
    expect(r.bins).toHaveLength(3); // 只出非空 bin
    const [b0, b3, b8] = r.bins;
    // bin0
    expect(b0.lo).toBeCloseTo(0, 12); expect(b0.hi).toBeCloseTo(0.1, 12);
    expect(b0.count).toBe(3);
    expect(b0.avgPredicted).toBeCloseTo(0.1, 12); // prob_pred
    expect(b0.observedRate).toBeCloseTo(1 / 3, 12); // prob_true
    // bin3
    expect(b3.lo).toBeCloseTo(0.3, 12);
    expect(b3.count).toBe(2);
    expect(b3.avgPredicted).toBeCloseTo(0.35, 12);
    expect(b3.observedRate).toBeCloseTo(0.5, 12);
    // bin8
    expect(b8.lo).toBeCloseTo(0.8, 12);
    expect(b8.count).toBe(2);
    expect(b8.avgPredicted).toBeCloseTo(0.9, 12);
    expect(b8.observedRate).toBeCloseTo(1.0, 12);
  });

  it('ECE / MCE ≡ 标准定义（解析值）', () => {
    const r = calibrationCurve(ORACLE);
    // ECE = Σ(count/N)·|obs-avgP|
    const ece = (3 / 7) * Math.abs(1 / 3 - 0.1) + (2 / 7) * 0.15 + (2 / 7) * 0.1;
    expect(r.ece).toBeCloseTo(ece, 12);
    // MCE = max gap = bin0 |1/3-0.1|
    expect(r.mce).toBeCloseTo(Math.abs(1 / 3 - 0.1), 12);
  });

  it('反向 probe：完美校准 → Brier=0 / ECE=0 / MCE=0', () => {
    const r = calibrationCurve([{ p: 1, outcome: 1 }, { p: 0, outcome: 0 }]);
    expect(r.brier).toBe(0);
    expect(r.ece).toBe(0);
    expect(r.mce).toBe(0);
  });

  it('反向 probe：全瞎猜 p=0.5 → Brier=0.25（瞎猜基线）', () => {
    const r = calibrationCurve([{ p: 0.5, outcome: 1 }, { p: 0.5, outcome: 0 }]);
    expect(r.brier).toBeCloseTo(0.25, 12);
  });

  it('边界归桶 ≡ numpy.searchsorted(side=left)：p=0.1→bin0、p=0.2→bin1、p=1.0→末 bin', () => {
    // p=0.1 落 bin0（边界归左），p=0.2 落 bin1（非 bin0/2）
    const a = calibrationCurve([{ p: 0.1, outcome: 1 }]);
    expect(a.bins[0].lo).toBeCloseTo(0, 12); // bin0
    const b = calibrationCurve([{ p: 0.2, outcome: 1 }]);
    expect(b.bins[0].lo).toBeCloseTo(0.1, 12); // bin1 = [0.1,0.2)
    const c = calibrationCurve([{ p: 1.0, outcome: 1 }]);
    expect(c.bins[0].lo).toBeCloseTo(0.9, 12); // bin9
  });

  it('binCount 参数：n_bins=5 改变桶宽', () => {
    const r = calibrationCurve([{ p: 0.25, outcome: 1 }], { binCount: 5 });
    // edges=[0.2,0.4,0.6,0.8]，0.25→bin1=[0.2,0.4)
    expect(r.bins[0].lo).toBeCloseTo(0.2, 12);
    expect(r.bins[0].hi).toBeCloseTo(0.4, 12);
  });

  it('脏行剔除：p 越界 / outcome 非 0|1 / NaN 全不计', () => {
    const r = calibrationCurve([
      { p: 0.5, outcome: 1 },
      { p: 1.5, outcome: 1 }, // 越界
      { p: 0.5, outcome: 2 }, // outcome 非 0|1
      { p: NaN, outcome: 0 }, // NaN
      { p: -0.1, outcome: 0 }, // 越界
      null, // 脏
    ]);
    expect(r.n).toBe(1);
  });

  it('空 / 全脏 → null 字段（不抛）', () => {
    expect(calibrationCurve([]).brier).toBeNull();
    expect(calibrationCurve(null).n).toBe(0);
    expect(calibrationCurve([{ p: 2, outcome: 9 }]).ece).toBeNull();
  });

  it('F5：boolean outcome 归一为 0/1（与 ledger.brier/resolve 同口径，不被静默剔除）', () => {
    const r = calibrationCurve([{ p: 1, outcome: true }, { p: 0, outcome: false }]);
    expect(r.n).toBe(2); // true/false 归一后保留，非剔除
    expect(r.brier).toBe(0); // true→1, false→0，完美校准
  });
});
