import { describe, it, expect } from 'vitest';
import { integrationMetric } from '../../src/cognition/NoeIntegrationMetric.js';

// 强健加固(批3):integrationMetric 此前以 rows[0].length 定 nodes 却不校验各行等宽,
// 异宽行致边际熵(按 nodes 读 r[j],短行缺位当 0)与联合熵(按各行自身宽度拼 key)口径错位,
// 静默算出误导性整合度。加固=剔除与首行不等宽的行。等宽输入(采样器已预过滤、现有全部用例)逐字不变。

describe('integrationMetric 异宽行强健性', () => {
  it('异宽行被剔除:结果只反映等宽的有效样本(不再口径错位)', () => {
    const ragged = [[1, 1, 1, 1], [0, 0, 0, 0], [1, 1], [0, 0, 0, 0]]; // 第3行只有2列
    const r = integrationMetric(ragged);
    expect(r.ok).toBe(true);
    expect(r.nodes).toBe(4);      // 由首个有效行确定
    expect(r.samples).toBe(3);    // 2列的坏行被剔除,只剩 3 行参与
    // 与「显式只传 3 行等宽样本」结果一致——证明坏行确实被干净剔除而非混算
    const clean = integrationMetric([[1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]]);
    expect(r.integration).toBeCloseTo(clean.integration, 10);
    expect(r.totalCorrelation).toBeCloseTo(clean.totalCorrelation, 10);
  });

  it('剔除异宽行后样本不足 2 → ok:false(不硬崩)', () => {
    expect(integrationMetric([[1, 1, 1], [0, 0]]).ok).toBe(false); // 只有 1 行等宽
  });

  it('等宽输入逐字零回归(覆盖整合/独立/部分耦合/不足档)', () => {
    const full = integrationMetric([[1, 1, 1, 1], [0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0]]);
    expect(full.ok).toBe(true);
    expect(full.integration).toBeGreaterThan(0.9);
    expect(full.totalCorrelation).toBeCloseTo(3, 5);

    const indep = integrationMetric([[0, 0], [0, 1], [1, 0], [1, 1]]);
    expect(indep.totalCorrelation).toBeCloseTo(0, 5);
    expect(indep.integration).toBeCloseTo(0, 5);

    const partial = integrationMetric([[1, 1], [1, 1], [0, 0], [0, 1]]);
    expect(partial.integration).toBeGreaterThan(0);
    expect(partial.integration).toBeLessThan(0.9);

    expect(integrationMetric([]).ok).toBe(false);
    expect(integrationMetric([[1, 1]]).ok).toBe(false);
    expect(integrationMetric([[1], [0]]).ok).toBe(false);
    expect(integrationMetric('garbage').ok).toBe(false);
  });
});
