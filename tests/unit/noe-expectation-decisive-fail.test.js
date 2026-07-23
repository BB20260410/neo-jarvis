// @ts-check
import { describe, it, expect } from 'vitest';
import { createExpectationResolver } from '../../src/cognition/NoeExpectationResolver.js';

// 步骤5（多模型安全方案）：承诺类(owner_pred)预测到期反复判不出 → 决定性判 FAILED。
//   最高风险分量动作。本测以「忠实模拟真 ledger 语义的 mock」黑盒测 tick 四重护栏：
//   ① source 白名单(严格排除 reflection/thought) ② verifiable=1 ③ judge_attempts≥阈值(绝不单次定生死)
//   ④ 逾期≥宽限。任一不满足 → 绝不转 FAILED。外加 OFF 零回归 + 硬下限(配 1 也至少 2 次) + 系统故障不累加。

const T = 100_000_000_000;
const GRACE = 3600_000; // = maybeDecisiveFail 的硬下限 1h（传更小会被 Math.max 顶到 1h）

/** 忠实模拟真 NoeExpectationLedger 的 due/resolve/bumpAttempts 语义（resolved_at IS NULL 门同款）。 */
function makeLedger(rows) {
  const byId = new Map(rows.map((r) => [r.id, { judge_attempts: 0, resolved_at: null, p: 0.7, ...r }]));
  const resolved = [];
  return {
    resolved,
    due: (t) => [...byId.values()].filter((r) => r.resolved_at == null && r.due_at != null && r.due_at <= t),
    resolve: (id, outcome, t, by) => {
      const r = byId.get(id);
      if (!r || r.resolved_at != null) return null;
      const resolvedBy = by === 'owner' ? 'owner' : 'auto'; // 忠实真 ledger：resolved_by 只认 owner/auto
      r.resolved_at = t; r.outcome = outcome; r.resolved_by = resolvedBy;
      const surprise = outcome === 0 ? -Math.log2(Math.max(0.001, 1 - r.p)) : 0;
      resolved.push({ id, outcome, t, by: resolvedBy });
      return { ...r, surprise };
    },
    bumpAttempts: (id, t) => {
      const r = byId.get(id);
      if (!r || r.resolved_at != null) return null;
      r.judge_attempts = (r.judge_attempts || 0) + 1;
      r.last_judged_at = t;
      return r.judge_attempts;
    },
    get: (id) => byId.get(id),
  };
}

/** no_evidence 路径：evidence 返回空 → judgeOne 在调 adapter 前就 return no_evidence（GENUINE_UNDECIDED）。 */
function makeResolver(ledger, over = {}) {
  const harvested = [];
  const resolver = createExpectationResolver({
    ledger,
    getAdapter: () => ({ chat: async () => ({ reply: 'UNKNOWN' }) }),
    evidence: () => '', // → no_evidence
    goalSystem: { harvestSurprise: (x) => { harvested.push(x); return 1; } },
    decisiveFail: true,
    decisiveFailMinAttempts: 3,
    decisiveFailGraceMs: GRACE,
    unresolvedCooldownMs: 0, // 关 cooldown，允许连续 tick 判同一项
    now: () => T,
    ...over,
  });
  return { resolver, harvested };
}

describe('步骤5 决定性判 FAILED — 四重护栏全过 → 转 FAILED', () => {
  it('owner_pred + verifiable=1 + 逾期2h + 判 3 次 → FAILED + harvestSurprise(owner_prediction 过门)', async () => {
    const ledger = makeLedger([{ id: 1, claim: '主人今晚会回消息', source: 'owner_pred', verifiable: 1, due_at: T - 7200_000 }]);
    const { resolver, harvested } = makeResolver(ledger);
    await resolver.tick(T); // attempts→1
    await resolver.tick(T); // attempts→2
    expect(ledger.resolved.length).toBe(0); // <3 次，绝不靠单次/双次定生死
    const r3 = await resolver.tick(T); // attempts→3 → 转 FAILED
    expect(ledger.resolved).toEqual([{ id: 1, outcome: 0, t: T, by: 'auto' }]); // 决定性判 FAILED = 系统自评(auto)
    expect(ledger.get(1).judge_attempts).toBe(3);
    expect(harvested.length).toBe(1);
    expect(harvested[0].origin).toBe('owner_prediction'); // 过 Goodhart 门 → 真触发学习
    expect(r3.judged.find((j) => j.id === 1)?.reason).toBe('decisive_fail_overdue');
  });
});

describe('步骤5 反向 probe — 任一护栏不满足 → 绝不转 FAILED', () => {
  it('红线：source=reflection（非白名单）即便 verifiable=1+逾期+判 5 次也绝不判 FAILED', async () => {
    const ledger = makeLedger([{ id: 1, claim: '深思虚构任务', source: 'reflection', verifiable: 1, due_at: T - 7200_000 }]);
    const { resolver, harvested } = makeResolver(ledger);
    for (let i = 0; i < 5; i++) await resolver.tick(T);
    expect(ledger.resolved.length).toBe(0); // reflection 绝不被判 FAILED（防刷假学习）
    expect(harvested.length).toBe(0);
  });

  it('红线：source=thought 同样绝不判 FAILED', async () => {
    const ledger = makeLedger([{ id: 1, source: 'thought', verifiable: 1, due_at: T - 7200_000 }]);
    const { resolver } = makeResolver(ledger);
    for (let i = 0; i < 5; i++) await resolver.tick(T);
    expect(ledger.resolved.length).toBe(0);
  });

  it('verifiable=0（话题类弱信号）不判 FAILED', async () => {
    const ledger = makeLedger([{ id: 1, source: 'owner_pred', verifiable: 0, due_at: T - 7200_000 }]);
    const { resolver } = makeResolver(ledger);
    for (let i = 0; i < 5; i++) await resolver.tick(T);
    expect(ledger.resolved.length).toBe(0);
  });

  it('judge_attempts<阈值（只判 2 次）不判 FAILED', async () => {
    const ledger = makeLedger([{ id: 1, source: 'owner_pred', verifiable: 1, due_at: T - 7200_000 }]);
    const { resolver } = makeResolver(ledger);
    await resolver.tick(T);
    await resolver.tick(T);
    expect(ledger.resolved.length).toBe(0);
    expect(ledger.get(1).judge_attempts).toBe(2);
  });

  it('逾期<宽限（逾期 30min < 1h）不判 FAILED', async () => {
    const ledger = makeLedger([{ id: 1, source: 'owner_pred', verifiable: 1, due_at: T - 1800_000 }]);
    const { resolver } = makeResolver(ledger);
    for (let i = 0; i < 5; i++) await resolver.tick(T);
    expect(ledger.resolved.length).toBe(0);
  });

  it('系统故障(brain_error)不算"判过"：不累加 attempts、不判 FAILED', async () => {
    const ledger = makeLedger([{ id: 1, source: 'owner_pred', verifiable: 1, due_at: T - 7200_000 }]);
    const { resolver } = makeResolver(ledger, {
      getAdapter: () => ({ chat: async () => { throw new Error('boom'); } }),
      evidence: () => '有证据文本但模型炸了', // 非空 → 过 no_evidence → 进 chat → throw → brain_error
    });
    for (let i = 0; i < 5; i++) await resolver.tick(T);
    expect(ledger.resolved.length).toBe(0);
    expect(ledger.get(1).judge_attempts).toBe(0); // 系统故障绝不累加
  });
});

describe('步骤5 开关与硬下限', () => {
  it('decisiveFail OFF（默认）：全护栏满足也零回归不判 FAILED', async () => {
    const ledger = makeLedger([{ id: 1, source: 'owner_pred', verifiable: 1, due_at: T - 7200_000 }]);
    const { resolver } = makeResolver(ledger, { decisiveFail: false });
    for (let i = 0; i < 5; i++) await resolver.tick(T);
    expect(ledger.resolved.length).toBe(0);
  });

  it('硬下限：decisiveFailMinAttempts 配 1 也被顶到 2（绝不允许单次判证定生死）', async () => {
    const ledger = makeLedger([{ id: 1, source: 'owner_pred', verifiable: 1, due_at: T - 7200_000 }]);
    const { resolver } = makeResolver(ledger, { decisiveFailMinAttempts: 1 });
    await resolver.tick(T); // attempts=1 < 2，不判
    expect(ledger.resolved.length).toBe(0);
    await resolver.tick(T); // attempts=2 ≥ 2，判
    expect(ledger.resolved.length).toBe(1);
  });
});
