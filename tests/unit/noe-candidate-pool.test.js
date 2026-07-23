// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { createCandidatePool } from '../../src/cognition/NoeCandidatePool.js';

function makeStore() {
  const m = new Map();
  return {
    _m: m,
    insert: (c) => m.set(c.id, { ...c }),
    update: (id, patch) => m.set(id, { ...m.get(id), ...patch }),
    get: (id) => m.get(id) || null,
    list: (filter = {}) => [...m.values()].filter((c) => !filter.decision || c.decision === filter.decision),
  };
}

describe('NoeCandidatePool advisory frame (ROADMAP P2.1+P2.2 切片A，owner 选 advisory)', () => {
  it('缺 store → throw', () => {
    expect(() => createCandidatePool({})).toThrow(TypeError);
  });
  it('submit：候选进池 pending + 打分', () => {
    const store = makeStore();
    const pool = createCandidatePool({ store, now: () => 1 });
    const c = pool.submit({ source: 'owner', title: '研究X', baseScore: 0.6 });
    expect(c.decision).toBe('pending');
    expect(c.score).toBe(0.6); // owner 1.0 × 0.6
    expect(store.get(c.id).decision).toBe('pending');
  });
  it('decide owner 候选(权重最高) → accepted 升格目标', () => {
    const store = makeStore();
    let promoted = null;
    const pool = createCandidatePool({ store, promote: (c) => { promoted = c.title; return 'goal-1'; } });
    const c = pool.submit({ source: 'owner', title: '主人的任务' });
    const r = pool.decide(c.id);
    expect(r.decision).toBe('accepted');
    expect(r.goal_id).toBe('goal-1');
    expect(promoted).toBe('主人的任务');
  });
  it('advisory 核心：owner 权重最高几乎总采纳，低权重源 Neo 会拒并记理由(有判断，体验≈directive)', () => {
    const store = makeStore();
    const pool = createCandidatePool({ store, promote: () => 'g' });
    // 同样默认 base 0.6：owner 1.0×0.6=0.6 过；drive 0.4×0.6=0.24 不过
    expect(pool.decide(pool.submit({ source: 'owner' }).id).decision).toBe('accepted');
    const rejected = pool.decide(pool.submit({ source: 'drive' }).id);
    expect(rejected.decision).toBe('rejected');
    expect(rejected.reject_reason).toContain('< 阈值');
  });
  it('ownerOverride：推翻 rejected → accepted(你随时可坚持)', () => {
    const store = makeStore();
    const pool = createCandidatePool({ store, promote: () => 'g2' });
    const c = pool.submit({ source: 'drive', baseScore: 0.3 });
    pool.decide(c.id); // rejected
    const r = pool.ownerOverride(c.id);
    expect(r.decision).toBe('accepted');
    expect(r.overridden_by_owner).toBe(true);
  });
  it('decide 幂等：非 pending 直接返回不重复升格', () => {
    const store = makeStore();
    let promoteCount = 0;
    const pool = createCandidatePool({ store, promote: () => { promoteCount += 1; return 'g'; } });
    const c = pool.submit({ source: 'owner' });
    pool.decide(c.id); pool.decide(c.id);
    expect(promoteCount).toBe(1);
  });
  it('scoreCandidate：owner 最高 / 未知源 0.3 / baseScore 夹 0..1', () => {
    const store = makeStore();
    const pool = createCandidatePool({ store });
    expect(pool.scoreCandidate({ source: 'owner', baseScore: 1 })).toBe(1);
    expect(pool.scoreCandidate({ source: '???', baseScore: 1 })).toBe(0.3);
    expect(pool.scoreCandidate({ source: 'owner', baseScore: 5 })).toBe(1); // 夹到 1
  });
  it('反向 probe：promote 抛错 → 不崩(记日志，仍标 accepted，goal_id=null)', () => {
    const store = makeStore();
    const pool = createCandidatePool({ store, promote: () => { throw new Error('boom'); }, log: () => {} });
    const r = pool.decide(pool.submit({ source: 'owner' }).id);
    expect(r.decision).toBe('accepted');
    expect(r.goal_id).toBe(null);
  });
  it('list 按 decision 过滤', () => {
    const store = makeStore();
    const pool = createCandidatePool({ store, promote: () => 'g' });
    pool.decide(pool.submit({ source: 'owner' }).id);
    pool.submit({ source: 'drive' });
    expect(pool.list({ decision: 'accepted' }).length).toBe(1);
    expect(pool.list({ decision: 'pending' }).length).toBe(1);
  });
});
