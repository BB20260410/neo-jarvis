import { describe, expect, it } from 'vitest';
import {
  budgetUsageRatio,
  shouldFinalizeTurn,
  finalizeTurn,
  markHandoffSummaryAsReference,
  NOE_HANDOFF_REFERENCE_GUARD,
} from '../../src/autopilot/NoeTurnFinalizer.js';

describe('budgetUsageRatio', () => {
  it('正常 used/limit 比例', () => {
    expect(budgetUsageRatio({ used: 90, limit: 100 })).toBeCloseTo(0.9);
  });
  it('limit 缺失 / 非正 / used 非法 → 0', () => {
    expect(budgetUsageRatio({ used: 90 })).toBe(0);
    expect(budgetUsageRatio({ used: 90, limit: 0 })).toBe(0);
    expect(budgetUsageRatio({ used: -1, limit: 100 })).toBe(0);
    expect(budgetUsageRatio(undefined)).toBe(0);
  });
  it('可超过 1（超支由调用方处理）', () => {
    expect(budgetUsageRatio({ used: 150, limit: 100 })).toBeCloseTo(1.5);
  });
});

describe('shouldFinalizeTurn', () => {
  it('达阈值触发，未达不触发', () => {
    expect(shouldFinalizeTurn({ used: 90, limit: 100 }, { finalizeRatio: 0.9 })).toBe(true);
    expect(shouldFinalizeTurn({ used: 80, limit: 100 }, { finalizeRatio: 0.9 })).toBe(false);
  });
  it('默认阈值 0.9', () => {
    expect(shouldFinalizeTurn({ used: 95, limit: 100 })).toBe(true);
    expect(shouldFinalizeTurn({ used: 50, limit: 100 })).toBe(false);
  });
  it('已 finalize 过则防重不再触发', () => {
    expect(shouldFinalizeTurn({ used: 99, limit: 100 }, { alreadyFinalized: true })).toBe(false);
  });
  it('finalizeRatio=0 不触发（防误判全员濒尽）', () => {
    expect(shouldFinalizeTurn({ used: 1, limit: 100 }, { finalizeRatio: 0 })).toBe(false);
  });
  it('非法 finalizeRatio(NaN/字符串/>1) 不触发（不让 NaN 静默吃掉该总结的时刻）', () => {
    expect(shouldFinalizeTurn({ used: 99, limit: 100 }, { finalizeRatio: NaN })).toBe(false);
    expect(shouldFinalizeTurn({ used: 99, limit: 100 }, { finalizeRatio: 'x' })).toBe(false);
    expect(shouldFinalizeTurn({ used: 99, limit: 100 }, { finalizeRatio: 1.5 })).toBe(false);
  });
});

describe('finalizeTurn', () => {
  const msgs = [
    { role: 'user', content: '帮我重构网络层' },
    { role: 'assistant', content: '已抽出 ApiClient，正在迁移调用点' },
    { role: 'user', content: '继续' },
  ];

  it('注入 summarize 用其结果，标记 viaSummarizer', async () => {
    const r = await finalizeTurn(msgs, {
      budget: { used: 92, limit: 100 },
      summarize: async (list, ctx) => `交接：${list.length}条，用量${Math.round(ctx.usageRatio * 100)}%`,
    });
    expect(r.finalized).toBe(true);
    expect(r.viaSummarizer).toBe(true);
    expect(r.summary).toContain('交接：3条');
    expect(r.summary).toContain('92%');
    expect(r.summary).toContain('历史交接约束');
    expect(r.latestUserWins).toBe(true);
    expect(r.usageRatio).toBeCloseTo(0.92);
    expect(r.messageCount).toBe(3);
    expect(r.reason).toBe('budget_exhausting');
  });

  it('summarize 抛错 → 降级为确定性交接（含最近轨迹），viaSummarizer=false', async () => {
    const r = await finalizeTurn(msgs, {
      budget: { used: 100, limit: 100 },
      summarize: () => { throw new Error('llm down'); },
    });
    expect(r.viaSummarizer).toBe(false);
    expect(r.summary).toContain('死前交接');
    expect(r.summary).toContain('重构网络层');
  });

  it('summarize 返回空串 → 降级', async () => {
    const r = await finalizeTurn(msgs, { budget: { used: 100, limit: 100 }, summarize: () => '   ' });
    expect(r.viaSummarizer).toBe(false);
    expect(r.summary).toContain('死前交接');
  });

  it('无 summarize → 降级，自定义 reason 透传', async () => {
    const r = await finalizeTurn(msgs, { budget: { used: 100, limit: 100 }, reason: 'hard_stop_imminent' });
    expect(r.viaSummarizer).toBe(false);
    expect(r.reason).toBe('hard_stop_imminent');
    expect(r.summary).toContain('100%');
  });

  it('过滤 content 为空的消息后计数', async () => {
    const r = await finalizeTurn([{ role: 'user', content: 'a' }, { role: 'assistant' }, { role: 'user', content: null }], {});
    expect(r.messageCount).toBe(1);
  });

  it('超支(used>limit) 降级文案 clamp 到 100%，不出现 120%（usageRatio 字段仍保留真实超支信号）', async () => {
    const r = await finalizeTurn(msgs, { budget: { used: 120, limit: 100 } });
    expect(r.usageRatio).toBeCloseTo(1.2);
    expect(r.summary).toContain('100%');
    expect(r.summary).not.toContain('120%');
  });

  it('降级文案带 reason（复用于非 budget 触发时不误导）', async () => {
    const r = await finalizeTurn(msgs, { budget: { used: 100, limit: 100 }, reason: 'hard_stop_imminent' });
    expect(r.summary).toContain('hard_stop_imminent');
  });

  it('历史交接只作为参考，最新 user 消息胜出', () => {
    const guarded = markHandoffSummaryAsReference('历史下一步：继续做 A', {
      source: 'unit',
      latestUserInstruction: '改做 B，不要继续 A',
    });

    expect(guarded).toContain(NOE_HANDOFF_REFERENCE_GUARD);
    expect(guarded).toContain('最新 user 消息优先：改做 B，不要继续 A');
    expect(guarded).toContain('历史下一步：继续做 A');
    expect(guarded.indexOf('最新 user 消息优先')).toBeLessThan(guarded.indexOf('--- 历史交接开始 ---'));
  });

  it('历史交接 guard 不重复套娃', () => {
    const once = markHandoffSummaryAsReference('历史摘要');
    const twice = markHandoffSummaryAsReference(once);
    expect(twice).toBe(once);
  });
});
