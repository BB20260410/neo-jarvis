// Odysseus 移植模块自测：HardwareFit（量化选择算法 + 硬件探测结构）。
import { describe, it, expect } from 'vitest';
import { pickQuant, detectHardware } from '../../src/hwfit/HardwareFit.js';

describe('HardwareFit.pickQuant', () => {
  it('预算充足 → 选最高量化 Q8_0', () => {
    expect(pickQuant(7, 100)).toMatchObject({ quant: 'Q8_0', fits: true });
  });
  it('预算紧张 → 降级到能装下的量化', () => {
    const r = pickQuant(70, 50);
    expect(r.fits).toBe(true);
    expect(r.quant).toBe('Q4_K_M'); // 70B 在 50GB 预算只能到 Q4
  });
  it('预算不足 → fits:false 且仍给最小量化的需求估算', () => {
    const r = pickQuant(200, 10);
    expect(r.fits).toBe(false);
    expect(r.quant).toBe(null);
    expect(r.needGb).toBeGreaterThan(0);
  });
  it('needGb 为正数', () => {
    expect(pickQuant(30, 102).needGb).toBeGreaterThan(0);
  });
});

describe('HardwareFit.detectHardware', () => {
  it('返回结构完整且数值合法', async () => {
    const hw = await detectHardware();
    expect(hw).toHaveProperty('platform');
    expect(typeof hw.ramGb).toBe('number');
    expect(hw.gpuBudgetGb).toBeGreaterThanOrEqual(0);
    expect(hw.gpuBudgetGb).toBeLessThanOrEqual(hw.ramGb || Infinity);
  });
});
