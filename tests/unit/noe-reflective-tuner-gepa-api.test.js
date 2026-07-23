// @ts-check
import { describe, it, expect, vi } from 'vitest';
import { createReflectiveTuner } from '../../src/cognition/NoeReflectiveTuner.js';

// GEPA 命名 API（spec 契约）：proposeCandidates → evaluateCandidate(scoreFn) → selectPareto → toArchiveRecord → tick。
// 全确定性：固定 now、注入 stub scoreFn（不触网/不依赖时钟）。核心安全断言：enabled=false → tick() 返回 []、零盘写。

const T0 = 1_780_000_000_000;
const BASE = { owner: 0.35, urgency: 0.25, novelty: 0.2, affect: 0.2 };
// stub 标量评测尺子：owner 权重越高分越高（确定性、可断言方向）。
const ownerScoreFn = (w) => w.owner;

describe('proposeCandidates — 确定性扰动产候选变体（零 LLM）', () => {
  it('产 N 个已归一化、偏离基线、互不相同的候选权重', () => {
    const t = createReflectiveTuner({ baselineWeights: BASE, now: () => T0 });
    const cands = t.proposeCandidates(BASE, { maxCandidates: 4 });
    expect(cands.length).toBe(4);
    const fps = new Set(cands.map((c) => Object.values(c).join('|')));
    expect(fps.size).toBe(4); // 去重
    for (const c of cands) for (const v of Object.values(c)) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
  });
  it('确定性：同输入两次产出逐字一致', () => {
    const t = createReflectiveTuner({ baselineWeights: BASE, now: () => T0 });
    expect(t.proposeCandidates(BASE)).toEqual(t.proposeCandidates(BASE));
  });
});

describe('evaluateCandidate — 注入 stub scoreFn 标量打分（fail-open）', () => {
  it('scoreFn 给候选/基线打分，holdoutDelta=候选分-基线分', async () => {
    const t = createReflectiveTuner({ baselineWeights: BASE, scoreFn: ownerScoreFn, now: () => T0 });
    const r = await t.evaluateCandidate({ owner: 0.6, urgency: 0.2, novelty: 0.1, affect: 0.1 });
    expect(r.ok).toBe(true);
    expect(r.candidateScore).toBe(0.6);
    expect(r.baselineScore).toBe(0.35);
    expect(r.holdoutDelta).toBeCloseTo(0.25, 6);
  });
  it('opts.scoreFn 覆盖工厂级 scoreFn', async () => {
    const t = createReflectiveTuner({ baselineWeights: BASE, scoreFn: () => 0, now: () => T0 });
    const r = await t.evaluateCandidate(BASE, { scoreFn: (w) => w.urgency });
    expect(r.candidateScore).toBe(0.25);
  });
  it('fail-open：scoreFn 抛错 → 评测降级 evalError，不锁死', async () => {
    const t = createReflectiveTuner({ baselineWeights: BASE, scoreFn: () => { throw new Error('embed down'); }, now: () => T0 });
    const r = await t.evaluateCandidate({ owner: 0.5, urgency: 0.2, novelty: 0.1, affect: 0.1 });
    expect(r.ok).toBe(false);
    expect(r.evalError).toContain('down');
  });
});

describe('selectPareto / toArchiveRecord — 选优 + 纯对象归档记录', () => {
  it('selectPareto 剔除被全维支配的候选', () => {
    const t = createReflectiveTuner({ baselineWeights: BASE, now: () => T0 });
    const scored = [
      { candidateId: 'a', objectives: { holdoutDelta: 0.5, semanticMean: 0.5, minimalChange: 0.1 } },
      { candidateId: 'b', objectives: { holdoutDelta: 0.1, semanticMean: 0.1, minimalChange: 0.3 } }, // 被 a 全维支配
    ];
    const front = t.selectPareto(scored);
    expect(front.map((x) => x.candidateId)).toEqual(['a']);
  });
  it('toArchiveRecord 产 shadow + manual_only + ts 的纯对象（无 fs 副作用）', () => {
    const t = createReflectiveTuner({ baselineWeights: BASE, now: () => T0 });
    const evaluated = [{ candidateId: 'a', weights: BASE, objectives: { holdoutDelta: 0.1 } }];
    const rec = t.toArchiveRecord({ ts: T0, source: 'grid', evaluated, front: evaluated });
    expect(rec.shadow).toBe(true);
    expect(rec.adoption).toBe('observe_only'); // 采纳门默认 OFF=纯观察
    expect(rec.adopted).toBe(false);
    expect(rec.ts).toBe(T0);
    expect(rec.baselineWeights).toEqual(BASE);
    expect(rec.candidates[0].paretoOptimal).toBe(true);
  });
});

describe('tick — 编排入口 + enabled 开关契约', () => {
  it('enabled=true：tick() 返回候选 archive 记录数组', async () => {
    const archive = [];
    const t = createReflectiveTuner({
      baselineWeights: BASE, scoreFn: ownerScoreFn, enabled: true,
      appendArchive: (d, o) => archive.push({ d, o }), now: () => T0,
    });
    const recs = await t.tick({ traces: [] });
    expect(Array.isArray(recs)).toBe(true);
    expect(recs.length).toBeGreaterThan(0);
    expect(recs[0]).toHaveProperty('weights');
    expect(recs[0]).toHaveProperty('evaluation');
    expect(archive.length).toBe(1); // 唯一盘写 = 注入的 appendArchive
  });

  it('【安全核心】enabled=false：tick() 返回 []、零 propose/evaluate/archive、零副作用', async () => {
    const archive = [];
    const scoreFn = vi.fn(() => 1);
    const t = createReflectiveTuner({
      baselineWeights: BASE, scoreFn, enabled: false,
      appendArchive: (d, o) => archive.push({ d, o }), now: () => T0,
    });
    const recs = await t.tick({ traces: [] });
    expect(recs).toEqual([]); // spec 契约：空数组
    expect(scoreFn).not.toHaveBeenCalled(); // 不评测
    expect(archive.length).toBe(0); // 零盘写
    expect(t.enabled).toBe(false);
  });

  it('enabled 默认 true（被构造即用；env 默认 OFF 由 server 接线层强制不构造）', () => {
    expect(createReflectiveTuner({ baselineWeights: BASE }).enabled).toBe(true);
  });
});
