// @ts-check
import { describe, it, expect, afterEach } from 'vitest';
import { createWorkspace } from '../../src/cognition/NoeWorkspace.js';

// S0.7 显著度四权重抽注入式参数：
//  · 默认（不传 salienceWeights、不设 env）→ 打分逐字 = 原硬编码 owner0.35/urgency0.25/novelty0.2/affect0.2（零回归）。
//  · 注入 opts.salienceWeights 逐项覆盖 → 真生效（证明开了不是恒等假融入）。
//  · 部分覆盖 → 未给的项回落默认。
// 全确定性：固定 now、关 novelty（不注 textSimilarity → novelty 恒 1）、不注 affectProbe（arousal 恒 0.35）、
//   不读 process.env、不触网。仅取单候选避免排序耦合。

const T0 = 1_780_000_000_000;

// 只放一个 percept 候选（SOURCE_BASE.percept = owner0.6/urgency0.2/affect0.3），其余源全空。
function onePerceptDeps(over = {}) {
  return {
    timeline: { recent: () => [] },
    peekVision: () => ({ summary: '主人在写代码' }),
    appendJournal: () => {},
    now: () => T0,
    ...over,
  };
}

// 复算公式（与实现一致）：novelty=1（无 textSimilarity）、arousal=0.35（无 affectProbe）。
function expectedPerceptScore(w) {
  const base = { owner: 0.6, urgency: 0.2, affect: 0.3 };
  const n = 1;
  const arousal = 0.35;
  const s = w.owner * base.owner + w.urgency * base.urgency + w.novelty * n + w.affect * base.affect * (0.5 + arousal / 2);
  return Math.round(s * 1000) / 1000;
}

const DEFAULTS = { owner: 0.35, urgency: 0.25, novelty: 0.2, affect: 0.2 };

describe('NoeWorkspace 显著度权重 — 默认零回归', () => {
  it('不传 salienceWeights → 打分 = 原硬编码四权重算出的值（逐字不变）', () => {
    const ws = createWorkspace(onePerceptDeps());
    const r = ws.step();
    expect(r.winner.source).toBe('percept');
    expect(r.winner.score).toBe(expectedPerceptScore(DEFAULTS));
  });

  it('显式传 salienceWeights=null 与不传等价（默认链兜底）', () => {
    const ws = createWorkspace(onePerceptDeps({ salienceWeights: null }));
    expect(ws.step().winner.score).toBe(expectedPerceptScore(DEFAULTS));
  });

  it('传与默认逐字相同的对象 → 分数不变（恒等）', () => {
    const ws = createWorkspace(onePerceptDeps({ salienceWeights: { ...DEFAULTS } }));
    expect(ws.step().winner.score).toBe(expectedPerceptScore(DEFAULTS));
  });
});

describe('NoeWorkspace 显著度权重 — 注入覆盖真生效', () => {
  it('全量覆盖四权重 → 分数随新权重变化，且 = 复算值', () => {
    const custom = { owner: 0.5, urgency: 0.1, novelty: 0.3, affect: 0.4 };
    const ws = createWorkspace(onePerceptDeps({ salienceWeights: custom }));
    const r = ws.step();
    expect(r.winner.source).toBe('percept');
    expect(r.winner.score).toBe(expectedPerceptScore(custom));
    // 与默认分数不同 → 证明覆盖确实改变了行为（非 OFF 假融入）
    expect(r.winner.score).not.toBe(expectedPerceptScore(DEFAULTS));
  });

  it('调高 owner 权重 → percept(owner0.6) 分数升高', () => {
    const lo = createWorkspace(onePerceptDeps({ salienceWeights: { owner: 0.1 } }));
    const hi = createWorkspace(onePerceptDeps({ salienceWeights: { owner: 0.9 } }));
    expect(hi.step().winner.score).toBeGreaterThan(lo.step().winner.score);
  });

  it('部分覆盖（只给 owner）→ 其余三项回落默认', () => {
    const ws = createWorkspace(onePerceptDeps({ salienceWeights: { owner: 0.5 } }));
    const merged = { ...DEFAULTS, owner: 0.5 };
    expect(ws.step().winner.score).toBe(expectedPerceptScore(merged));
  });

  it('非法值（NaN/字符串）逐项回落默认', () => {
    // @ts-expect-error 故意传非法类型测回落
    const ws = createWorkspace(onePerceptDeps({ salienceWeights: { owner: 'x', urgency: NaN } }));
    expect(ws.step().winner.score).toBe(expectedPerceptScore(DEFAULTS));
  });
});

// GEPA 三层缺省链的【中间层 env】专项（GEPA 确认任务核心）：opts→env NOE_WS_SALIENCE_*→默认。
// 既有用例覆盖 opts 层与默认层；这里钉死 env 层：不传 opts 时 env 真生效、env 与 opts 共存时 opts 优先、env 非法回落默认。
describe('NoeWorkspace 显著度权重 — env 中间层（GEPA 可优化对象注入位）', () => {
  const ENV_KEYS = ['NOE_WS_SALIENCE_OWNER', 'NOE_WS_SALIENCE_URGENCY', 'NOE_WS_SALIENCE_NOVELTY', 'NOE_WS_SALIENCE_AFFECT'];
  const snapshot = {};
  for (const k of ENV_KEYS) snapshot[k] = process.env[k];
  afterEach(() => {
    // 还原 env，绝不污染其他测试（这些是进程级全局键）。
    for (const k of ENV_KEYS) { if (snapshot[k] === undefined) delete process.env[k]; else process.env[k] = snapshot[k]; }
  });

  it('不传 salienceWeights、设 env → env 值真生效（= 复算值，且 ≠ 默认）', () => {
    process.env.NOE_WS_SALIENCE_OWNER = '0.5';
    process.env.NOE_WS_SALIENCE_URGENCY = '0.1';
    process.env.NOE_WS_SALIENCE_NOVELTY = '0.3';
    process.env.NOE_WS_SALIENCE_AFFECT = '0.4';
    const ws = createWorkspace(onePerceptDeps()); // 注意：不传 salienceWeights，强制走 env 层
    const envWeights = { owner: 0.5, urgency: 0.1, novelty: 0.3, affect: 0.4 };
    expect(ws.step().winner.score).toBe(expectedPerceptScore(envWeights));
    expect(ws.step().winner.score).not.toBe(expectedPerceptScore(DEFAULTS)); // 证明 env 真改了行为（非假融入）
  });

  it('opts.salienceWeights 优先于 env（opts 覆盖 env 覆盖默认）', () => {
    process.env.NOE_WS_SALIENCE_OWNER = '0.9'; // env 设 0.9
    const ws = createWorkspace(onePerceptDeps({ salienceWeights: { owner: 0.5 } })); // 但 opts 给 0.5
    const merged = { ...DEFAULTS, owner: 0.5 }; // 应取 opts 的 0.5，不是 env 的 0.9
    expect(ws.step().winner.score).toBe(expectedPerceptScore(merged));
  });

  it('env 非法（空串/非数字）→ 该项回落默认（零回归底线）', () => {
    process.env.NOE_WS_SALIENCE_OWNER = '';        // 空串 → 回落默认 0.35
    process.env.NOE_WS_SALIENCE_URGENCY = 'abc';   // 非数字 → 回落默认 0.25
    const ws = createWorkspace(onePerceptDeps());
    expect(ws.step().winner.score).toBe(expectedPerceptScore(DEFAULTS));
  });

  it('全部 env 未设 + 不传 opts → 逐字默认（零回归）', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const ws = createWorkspace(onePerceptDeps());
    expect(ws.step().winner.score).toBe(expectedPerceptScore(DEFAULTS));
  });

  it('env 显式 "0" → 采纳为权重 0（合法数字不被空串修复误伤）', () => {
    process.env.NOE_WS_SALIENCE_OWNER = '0'; // 显式清零 owner 维度（与空串区分）
    const ws = createWorkspace(onePerceptDeps());
    expect(ws.step().winner.score).toBe(expectedPerceptScore({ ...DEFAULTS, owner: 0 }));
  });
});
