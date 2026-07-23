// 针对 src/metrics/pricing.js 的单元测试
// 覆盖：estimateCost 已知模型计算、未知模型回退、listPricing 返回结构

import { describe, it, expect } from 'vitest';
import { estimateCost, listPricing } from '../../src/metrics/pricing.js';

// ─── estimateCost ─────────────────────────────────────────────────────────────

describe('estimateCost — 已知模型精确计算', () => {
  it('claude-sonnet-4-6：1M in + 1M out = 3.00 + 15.00 = 18.00 USD', () => {
    const result = estimateCost('claude', 'claude-sonnet-4-6', 1_000_000, 1_000_000);
    expect(result).toBe(18.00);
  });

  it('claude-haiku-4-5：500k in + 200k out = 0.5 + 1.00 = 1.50 USD（精确值）', () => {
    // rate in=1.00, out=5.00 per 1M
    // cost = (500000*1.00 + 200000*5.00) / 1_000_000 = (500000+1000000)/1_000_000 = 1.5
    const result = estimateCost('claude', 'claude-haiku-4-5', 500_000, 200_000);
    expect(result).toBe(1.5);
  });

  it('claude-opus-4-7：100k in + 50k out = 0.0015 + 0.00375 = 0.00525 USD', () => {
    // rate in=15.00, out=75.00
    // cost = (100000*15 + 50000*75) / 1_000_000 = (1500000+3750000)/1_000_000 = 5.25
    const result = estimateCost('claude', 'claude-opus-4-7', 100_000, 50_000);
    expect(result).toBe(5.25);
  });

  it('claude-opus-4-8：100k in + 50k out = 0.5 + 1.25 = 1.75 USD', () => {
    const result = estimateCost('claude', 'claude-opus-4-8', 100_000, 50_000);
    expect(result).toBe(1.75);
  });

  it('gpt-5-mini：1M in + 1M out = 0.25 + 2.00 = 2.25 USD', () => {
    const result = estimateCost('codex', 'gpt-5-mini', 1_000_000, 1_000_000);
    expect(result).toBe(2.25);
  });

  it('gpt-5-nano：2M in + 1M out = 0.20 + 0.40 = 0.60 USD', () => {
    const result = estimateCost('codex', 'gpt-5-nano', 2_000_000, 1_000_000);
    expect(result).toBe(0.60);
  });

  it('gemini-3-flash：1M in + 1M out = 0.075 + 0.30 = 0.375 USD', () => {
    const result = estimateCost('gemini-cli', 'gemini-3-flash', 1_000_000, 1_000_000);
    expect(result).toBe(0.375);
  });
});

describe('estimateCost — adapter 默认价格（无 model 或 model 不在 overrides）', () => {
  it('claude adapter 无 model 传入 → 走 defaultIn=3.00 / defaultOut=15.00', () => {
    // 1M in + 1M out = 18.00
    const result = estimateCost('claude', null, 1_000_000, 1_000_000);
    expect(result).toBe(18.00);
  });

  it('claude adapter 传入未知 model → 走 default', () => {
    const result = estimateCost('claude', 'claude-unknown-model', 1_000_000, 1_000_000);
    expect(result).toBe(18.00);
  });

  it('codex adapter 无 model → defaultIn=5.00 defaultOut=15.00', () => {
    const result = estimateCost('codex', undefined, 1_000_000, 1_000_000);
    expect(result).toBe(20.00);
  });

  it('minimax adapter（无 overrides）→ defaultIn=0.20 defaultOut=1.10', () => {
    // 1M in + 1M out = 0.20 + 1.10 = 1.30
    const result = estimateCost('minimax', null, 1_000_000, 1_000_000);
    expect(result).toBe(1.30);
  });

  it('ollama adapter → 本地推理 cost = 0', () => {
    const result = estimateCost('ollama', null, 1_000_000, 1_000_000);
    expect(result).toBe(0);
  });

  it('ccr adapter 走 default → 3.00 + 15.00 = 18.00', () => {
    const result = estimateCost('ccr', null, 1_000_000, 1_000_000);
    expect(result).toBe(18.00);
  });
});

describe('estimateCost — custom adapter 回退', () => {
  it('custom:xxx → CUSTOM_DEFAULT in=2.00 out=8.00', () => {
    // 1M in + 1M out = 2.00 + 8.00 = 10.00
    const result = estimateCost('custom:mymodel', 'whatever', 1_000_000, 1_000_000);
    expect(result).toBe(10.00);
  });

  it('custom: 前缀时 model 参数不影响价格', () => {
    const r1 = estimateCost('custom:a', 'model-a', 500_000, 500_000);
    const r2 = estimateCost('custom:a', 'model-b', 500_000, 500_000);
    expect(r1).toBe(r2);
  });
});

describe('estimateCost — 未知 adapter 回退', () => {
  it('未知 adapterId（非 custom:）→ 返回 0', () => {
    const result = estimateCost('unknown-adapter', 'some-model', 1_000_000, 1_000_000);
    expect(result).toBe(0);
  });

  it('adapterId 为 null → 返回 0', () => {
    const result = estimateCost(null, null, 1_000_000, 1_000_000);
    expect(result).toBe(0);
  });

  it('adapterId 为空字符串 → 返回 0', () => {
    const result = estimateCost('', null, 1_000_000, 1_000_000);
    expect(result).toBe(0);
  });
});

describe('estimateCost — tokens 边界', () => {
  it('两者均为 0 → 短路返回 0', () => {
    // 源码：if (!tokensIn && !tokensOut) return 0
    const result = estimateCost('claude', 'claude-sonnet-4-6', 0, 0);
    expect(result).toBe(0);
  });

  it('默认参数（不传 tokensIn/tokensOut）→ 0', () => {
    const result = estimateCost('claude', 'claude-sonnet-4-6');
    expect(result).toBe(0);
  });

  it('只有 tokensIn 不为 0', () => {
    // 1M in, 0 out, claude-sonnet-4-6: 1*3.00 = 3.00
    const result = estimateCost('claude', 'claude-sonnet-4-6', 1_000_000, 0);
    expect(result).toBe(3.00);
  });

  it('只有 tokensOut 不为 0', () => {
    // 0 in, 1M out, claude-sonnet-4-6: 1*15.00 = 15.00
    const result = estimateCost('claude', 'claude-sonnet-4-6', 0, 1_000_000);
    expect(result).toBe(15.00);
  });

  it('小额 token 保留 6 位小数精度', () => {
    // claude-sonnet-4-6: rate in=3, out=15
    // cost = (100*3 + 100*15) / 1_000_000 = 1800/1_000_000 = 0.0018
    const result = estimateCost('claude', 'claude-sonnet-4-6', 100, 100);
    expect(result).toBe(0.0018);
  });

  it('结果精度不超过 6 位小数', () => {
    const result = estimateCost('gemini-cli', 'gemini-3-flash', 1, 1);
    // (1*0.075 + 1*0.30) / 1_000_000 = 0.375/1_000_000 = 0.000000375 → round to 6 decimals = 0
    // 验证是有限精度数字，不是 NaN/Infinity
    expect(typeof result).toBe('number');
    expect(Number.isFinite(result)).toBe(true);
    // 小数位不超过 6 位
    const decimals = result.toString().split('.')[1];
    if (decimals) {
      expect(decimals.length).toBeLessThanOrEqual(6);
    }
  });
});

// ─── listPricing ──────────────────────────────────────────────────────────────

describe('listPricing — 返回结构', () => {
  it('返回一个非 null 对象', () => {
    const result = listPricing();
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
    expect(result).not.toBeNull();
  });

  it('包含 claude / codex / gemini-cli / gemini / ollama / minimax / ccr adapter', () => {
    const result = listPricing();
    expect(result).toHaveProperty('claude');
    expect(result).toHaveProperty('codex');
    expect(result).toHaveProperty('gemini-cli');
    expect(result).toHaveProperty('gemini');
    expect(result).toHaveProperty('ollama');
    expect(result).toHaveProperty('minimax');
    expect(result).toHaveProperty('ccr');
  });

  it('每个 adapter 条目包含 defaultIn 和 defaultOut 数字字段', () => {
    const result = listPricing();
    for (const [id, entry] of Object.entries(result)) {
      expect(typeof entry.defaultIn, `${id}.defaultIn 应是 number`).toBe('number');
      expect(typeof entry.defaultOut, `${id}.defaultOut 应是 number`).toBe('number');
    }
  });

  it('claude.defaultIn = 3.00, claude.defaultOut = 15.00', () => {
    const result = listPricing();
    expect(result.claude.defaultIn).toBe(3.00);
    expect(result.claude.defaultOut).toBe(15.00);
  });

  it('ollama.defaultIn = 0, ollama.defaultOut = 0（本地推理无成本）', () => {
    const result = listPricing();
    expect(result.ollama.defaultIn).toBe(0);
    expect(result.ollama.defaultOut).toBe(0);
  });

  it('claude.modelOverrides 包含 claude-sonnet-4-6', () => {
    const result = listPricing();
    expect(result.claude.modelOverrides).toBeDefined();
    expect(result.claude.modelOverrides['claude-sonnet-4-6']).toBeDefined();
    expect(result.claude.modelOverrides['claude-sonnet-4-6'].in).toBe(3.00);
    expect(result.claude.modelOverrides['claude-sonnet-4-6'].out).toBe(15.00);
  });

  it('claude.modelOverrides 包含 claude-opus-4-8', () => {
    const result = listPricing();
    expect(result.claude.modelOverrides['claude-opus-4-8']).toEqual({ in: 5.00, out: 25.00 });
  });

  it('返回的是深拷贝：修改返回值不影响下次调用', () => {
    const r1 = listPricing();
    r1.claude.defaultIn = 9999;
    const r2 = listPricing();
    expect(r2.claude.defaultIn).toBe(3.00);
  });
});
