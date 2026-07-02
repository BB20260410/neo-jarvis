import { describe, expect, it } from 'vitest';
import { createExpectationResolver } from '../../src/cognition/NoeExpectationResolver.js';

// rank4：预测误差 → 好奇回路。自动判证判出 outcome=0（落空）+ 惊奇 ≥ 阈值时，
// resolver 自动调 goalSystem.harvestSurprise 立「搞明白为什么没料到」研究目标。
// 此前自动判证路径从不接 harvestSurprise（24h 自驱态 source=surprise 目标恒为 0）。

function makeExp(over = {}) {
  return { id: 1, claim: '主人今晚会回消息', p: 0.9, created_at: 1000, due_at: 2000, ...over };
}

function ledgerWithSurprise(dueRows, surprise) {
  const resolved = [];
  return {
    resolved,
    due: () => dueRows,
    resolve: (id, outcome) => { resolved.push({ id, outcome }); return { id, outcome, surprise }; },
  };
}

function adapterReplying(reply) {
  return { chat: async () => ({ reply }) };
}

describe('NoeExpectationResolver — rank4 好奇回路桥接（预测误差 → 主动学习）', () => {
  it('预测落空(outcome=0) + 惊奇 → 自动 harvestSurprise 立 source=surprise 研究目标', async () => {
    const harvestCalls = [];
    const resolver = createExpectationResolver({
      ledger: ledgerWithSurprise([makeExp({ source: 'owner-pred:topic' })], 3.32),
      goalSystem: { harvestSurprise: (arg) => { harvestCalls.push(arg); return 'surprise-goal-1'; } },
      getAdapter: () => adapterReplying('FAILED'),
      evidence: () => '证据：主人整晚没回消息',
    });
    const r = await resolver.tick(5000);
    expect(r.resolved).toBe(1);
    expect(harvestCalls).toHaveLength(1);
    expect(harvestCalls[0]).toEqual({ claim: '主人今晚会回消息', surprise: 3.32, origin: 'owner_prediction' }); // P1-C 整改 F2：owner 行为预测落空据 source 推导为 owner_prediction（不再误标 action_failure）
  });

  it('预测应验(outcome=1) → 不触发好奇回路', async () => {
    const harvestCalls = [];
    const resolver = createExpectationResolver({
      ledger: ledgerWithSurprise([makeExp({ claim: '能列出 5 个念头', p: 0.7 })], 0.5),
      goalSystem: { harvestSurprise: (arg) => { harvestCalls.push(arg); } },
      getAdapter: () => adapterReplying('APPLIED'),
      evidence: () => '- [thought] 已列出 6 个原始念头',
    });
    await resolver.tick(5000);
    expect(harvestCalls).toHaveLength(0);
  });

  it('未注入 goalSystem → 向后兼容（正常结算，不立好奇目标，不崩）', async () => {
    const resolver = createExpectationResolver({
      ledger: ledgerWithSurprise([makeExp()], 3.32),
      getAdapter: () => adapterReplying('FAILED'),
      evidence: () => '证据：没发生',
    });
    const r = await resolver.tick(5000);
    expect(r.resolved).toBe(1);
  });

  it('UNKNOWN（证据不明）→ 不结算也不触发好奇（宁缺勿错判保留）', async () => {
    const harvestCalls = [];
    const resolver = createExpectationResolver({
      ledger: ledgerWithSurprise([makeExp()], 3.32),
      goalSystem: { harvestSurprise: (arg) => { harvestCalls.push(arg); } },
      getAdapter: () => adapterReplying('UNKNOWN'),
      evidence: () => '一些无关的内容',
    });
    const r = await resolver.tick(5000);
    expect(r.resolved).toBe(0);
    expect(harvestCalls).toHaveLength(0);
  });
});
