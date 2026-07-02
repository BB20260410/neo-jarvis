import { describe, expect, it } from 'vitest';
import {
  planConsolidation,
  deriveSalience,
  isProtected,
  createConsolidationLoop,
} from '../../src/memory/NoeMemoryConsolidator.js';

const NOW = 1_000_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe('deriveSalience / isProtected', () => {
  it('显式 salience 优先并夹到 1-5', () => {
    expect(deriveSalience({ salience: 7 })).toBe(5);
    expect(deriveSalience({ salience: 0 })).toBe(1);
  });
  it('无 salience 时由 confidence/hitCount 估', () => {
    expect(deriveSalience({ confidence: 0.9 })).toBe(4);
    expect(deriveSalience({ confidence: 0.1 })).toBe(2);
    expect(deriveSalience({ confidence: 0.9, hitCount: 5 })).toBe(5);
  });
  it('身份级(salience=5)/protected/protected-scope 受保护', () => {
    expect(isProtected({ salience: 5 })).toBe(true);
    expect(isProtected({ protected: true })).toBe(true);
    expect(isProtected({ scope: 'identity' }, ['identity'])).toBe(true);
    expect(isProtected({ salience: 3 })).toBe(false);
  });
});

describe('planConsolidation', () => {
  it('精确/近似重复 → 合并,保 salience 最高的一条', async () => {
    const mems = [
      { id: 'a', content: '主人喜欢喝美式咖啡', salience: 3, updatedAt: NOW - 1000 },
      { id: 'b', content: '主人喜欢喝美式咖啡。', salience: 4, updatedAt: NOW - 2000 }, // 标点差异=近似
      { id: 'c', content: '完全不同的记忆', salience: 3 },
    ];
    const plan = await planConsolidation(mems, { nowMs: NOW });
    expect(plan.merges).toHaveLength(1);
    expect(plan.merges[0].keepId).toBe('b'); // salience 4 胜
    expect(plan.merges[0].dropIds).toEqual(['a']);
    expect(plan.merges[0].mergedSalience).toBe(4);
  });

  it('陈旧低价值(从未命中 + 超 30 天)→ 降级,不删', async () => {
    const mems = [
      { id: 'old', content: '一条很久没碰的记忆', salience: 3, hitCount: 0, updatedAt: NOW - 40 * DAY },
      { id: 'fresh', content: '最近的记忆', salience: 3, hitCount: 0, updatedAt: NOW - 1 * DAY },
    ];
    const plan = await planConsolidation(mems, { nowMs: NOW });
    expect(plan.downgrades).toEqual([{ id: 'old', fromSalience: 3, toSalience: 2, reason: 'stale_cold' }]);
  });

  it('过期(expiresAt 已过)→ 降级', async () => {
    const plan = await planConsolidation([{ id: 'e', content: 'x', salience: 3, expiresAt: NOW - 1 }], { nowMs: NOW });
    expect(plan.downgrades[0]).toMatchObject({ id: 'e', reason: 'expired' });
  });

  it('身份级记忆(salience=5)绝不被合并或降级', async () => {
    const mems = [
      { id: 'id1', content: '我是主人的专属伴侣', salience: 5, updatedAt: NOW - 99 * DAY, hitCount: 0 },
      { id: 'id2', content: '我是主人的专属伴侣', salience: 5 }, // 与 id1 重复但都受保护
    ];
    const plan = await planConsolidation(mems, { nowMs: NOW });
    expect(plan.merges).toHaveLength(0);     // 不合并
    expect(plan.downgrades).toHaveLength(0); // 不降级
    expect(plan.skippedProtected).toBeGreaterThan(0);
  });

  it('protected-scope(如 identity/person)受保护', async () => {
    const plan = await planConsolidation(
      [{ id: 'p', content: '老王是同事', scope: 'person', hitCount: 0, updatedAt: NOW - 99 * DAY }],
      { nowMs: NOW, protectedScopes: ['person'] },
    );
    expect(plan.downgrades).toHaveLength(0);
  });

  it('recall-heat:被≥3 个不同查询命中 → 晋升候选', async () => {
    const plan = await planConsolidation([{ id: 'hot', content: 'x', salience: 3, uniqueQueryCount: 4 }], { nowMs: NOW });
    expect(plan.promotions).toEqual([{ id: 'hot', reason: 'recall_heat', uniqueQueryCount: 4 }]);
  });

  it('LLM 钩子可追加语义去重,但绝不合并受保护记录(安全闸)', async () => {
    const mems = [
      { id: 'x', content: '主人周末爱爬山', salience: 3 },
      { id: 'y', content: '主人喜欢户外徒步登山', salience: 3 }, // 语义重复但内容不同
      { id: 'z', content: '主人的核心身份', salience: 5 },        // 受保护
    ];
    const llm = async () => [
      { keepId: 'x', dropIds: ['y'] },        // 合法
      { keepId: 'x', dropIds: ['z'] },        // 违规:试图合并受保护 z → 必须被安全闸拦掉
    ];
    const plan = await planConsolidation(mems, { nowMs: NOW, llmConsolidate: llm });
    const fromLlm = plan.merges.filter((m) => m.dropIds.includes('y') || m.dropIds.includes('z'));
    expect(fromLlm.some((m) => m.dropIds.includes('y'))).toBe(true);  // y 被合
    expect(fromLlm.some((m) => m.dropIds.includes('z'))).toBe(false); // z 受保护未被合
  });

  it('LLM 钩子抛错不影响确定性计划', async () => {
    const llm = async () => { throw new Error('M3 timeout'); };
    const plan = await planConsolidation([{ id: 'a', content: 'x' }], { nowMs: NOW, llmConsolidate: llm });
    expect(plan.scanned).toBe(1);
  });

  it('无可整合 → 空计划', async () => {
    const plan = await planConsolidation([{ id: 'a', content: 'unique', salience: 3, hitCount: 1, updatedAt: NOW }], { nowMs: NOW });
    expect(plan.merges).toHaveLength(0);
    expect(plan.downgrades).toHaveLength(0);
    expect(plan.promotions).toHaveLength(0);
  });

  it('已 hidden 的记录被忽略', async () => {
    const plan = await planConsolidation([
      { id: 'a', content: 'dup', salience: 3 },
      { id: 'b', content: 'dup', salience: 3, hidden: true },
    ], { nowMs: NOW });
    expect(plan.merges).toHaveLength(0); // b 被忽略,a 落单不合并
  });
});

describe('createConsolidationLoop(梦境调度骨架)', () => {
  it('默认 enabled=false → start() 不启动后台循环', () => {
    const loop = createConsolidationLoop({ loadCandidates: () => [], applyPlan: () => {} });
    expect(loop.isEnabled()).toBe(false);
    expect(loop.start()).toBe(false);
    expect(loop.isRunning()).toBe(false);
  });

  it('tick() 手动触发:load→plan→apply 串起来', async () => {
    let appliedPlan = null;
    const loop = createConsolidationLoop({
      loadCandidates: () => [
        { id: 'a', content: 'dup', salience: 3 },
        { id: 'b', content: 'dup', salience: 4 },
      ],
      applyPlan: (plan) => { appliedPlan = plan; return { ok: true }; },
      now: () => NOW,
    });
    const r = await loop.tick();
    expect(r.ok).toBe(true);
    expect(appliedPlan.merges).toHaveLength(1);
    expect(appliedPlan.merges[0].keepId).toBe('b');
    expect(r.applied).toEqual({ ok: true });
  });

  it('loadCandidates 抛错 → tick 安全返回 error,不崩', async () => {
    const loop = createConsolidationLoop({ loadCandidates: () => { throw new Error('db down'); }, applyPlan: () => {} });
    const r = await loop.tick();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('db down');
  });

  it('enabled=true 时 start() 返回 true(setTimeout 已 unref,不阻塞)', () => {
    const loop = createConsolidationLoop({ loadCandidates: () => [], applyPlan: () => {}, enabled: true, firstDelayMs: 999999 });
    expect(loop.start()).toBe(true);
    expect(loop.isRunning()).toBe(true);
    loop.stop();
    expect(loop.isRunning()).toBe(false);
  });
});
