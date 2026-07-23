import { describe, it, expect } from 'vitest';
import { createEvolutionRetrospect } from '../../src/loop/NoeEvolutionRetrospect.js';

// P4 学改闭环（复盘→回流）：用 P0 outcome 的 verdict + applied 分流——
//   logic_changed + applied:true（真保留的受控重构）→ 蒸馏「成功模式」learning_lesson；
//   logic_changed + applied:false（尝试改逻辑但被拦/回滚）→「失败教训」回流 P1（学这类改动为何做不成）；
//   连续 doc_only/neutral 且无任何改逻辑尝试 → 「太浅」教训回流 P1。
//   根因修复后：被回滚的尝试绝不当成功（防度量层自欺）。游标防重复。flag 默认 OFF。纯 DI + fail-open。

const mkOutcome = (verdict, at, applied = true) => ({ patchPlanId: `p-${at}`, verdict, at, applied });

const withFlag = (fn) => {
  const old = process.env.NOE_EVOLUTION_RETROSPECT;
  process.env.NOE_EVOLUTION_RETROSPECT = '1';
  try { return fn(); } finally {
    if (old === undefined) delete process.env.NOE_EVOLUTION_RETROSPECT; else process.env.NOE_EVOLUTION_RETROSPECT = old;
  }
};

function mkDeps(outcomes, opts = {}) {
  const lessons = [];
  let cursor = opts.cursor || 0;
  return {
    lessons,
    cursorRef: () => cursor,
    deps: {
      listNewOutcomes: opts.listThrows ? () => { throw new Error('x'); } : ({ since }) => outcomes.filter((o) => o.at > since),
      getCursor: opts.getCursorThrows ? () => { throw new Error('x'); } : () => cursor,
      setCursor: (at) => { cursor = at; },
      writeLesson: opts.writeThrows ? () => { throw new Error('x'); } : (l) => { lessons.push(l); return { ok: true }; },
      shallowThreshold: opts.shallowThreshold || 3,
    },
  };
}

describe('NoeEvolutionRetrospect', () => {
  it('flag OFF → skipped:flag_off', () => {
    const { deps } = mkDeps([mkOutcome('logic_changed', 10)]);
    expect(createEvolutionRetrospect(deps).runOnce().skipped).toBe('flag_off');
  });

  it('logic_changed + applied:true → 蒸馏成功模式 lesson + 推进游标', () => withFlag(() => {
    const h = mkDeps([mkOutcome('logic_changed', 100, true)]);
    const r = createEvolutionRetrospect(h.deps).runOnce();
    expect(r.ok).toBe(true);
    expect(r.realLogic).toBe(1);
    expect(h.lessons.length).toBe(1);
    expect(h.lessons[0].tags).toContain('success');
    expect(h.cursorRef()).toBe(100);
  }));

  it('test_only + applied:true → 蒸馏补测试成功模式(认可加能力,非空转)', () => withFlag(() => {
    const h = mkDeps([mkOutcome('test_only', 100, true)]);
    const r = createEvolutionRetrospect(h.deps).runOnce();
    expect(r.ok).toBe(true);
    expect(r.testOnly).toBe(1);
    expect(h.lessons.length).toBe(1);
    expect(h.lessons[0].tags).toContain('success');
    expect(h.lessons[0].tags).toContain('test_increment');
  }));

  it('有 test_only 补测试 → 即使 shallow 达阈值也不触发「太浅」(补测试是有价值进化)', () => withFlag(() => {
    const h = mkDeps([
      mkOutcome('test_only', 100, true),
      mkOutcome('neutral', 101, true), mkOutcome('neutral', 102, true), mkOutcome('neutral', 103, true),
    ], { shallowThreshold: 3 });
    const r = createEvolutionRetrospect(h.deps).runOnce();
    expect(r.shallow).toBe(3);
    expect(r.testOnly).toBe(1);
    expect(h.lessons.some((l) => l.tags.includes('too_shallow'))).toBe(false); // 有补测试=有价值,不催「推进真改逻辑」
    expect(h.lessons.some((l) => l.tags.includes('test_increment'))).toBe(true);
  }));

  it('logic_changed + applied:false → 失败教训(非成功模式)，回流 P1', () => withFlag(() => {
    const h = mkDeps([mkOutcome('logic_changed', 100, false)]);
    const r = createEvolutionRetrospect(h.deps).runOnce();
    expect(r.ok).toBe(true);
    expect(r.realLogic).toBe(0);
    expect(r.failedLogic).toBe(1);
    expect(h.lessons.length).toBe(1);
    expect(h.lessons[0].tags).toContain('failed');
    expect(h.lessons[0].tags).not.toContain('success'); // 绝不当成功
  }));

  it('被回滚的 logic_changed 绝不蒸馏成功模式(根因修复核心)', () => withFlag(() => {
    const h = mkDeps([mkOutcome('logic_changed', 10, false), mkOutcome('logic_changed', 20, false), mkOutcome('logic_changed', 30, false)]);
    const r = createEvolutionRetrospect(h.deps).runOnce();
    expect(r.realLogic).toBe(0);
    expect(h.lessons.every((l) => !l.tags.includes('success'))).toBe(true);
  }));

  it('连续 shallow + 无任何改逻辑尝试 → 太浅 lesson', () => withFlag(() => {
    const h = mkDeps([mkOutcome('doc_only', 10), mkOutcome('neutral', 20), mkOutcome('doc_only', 30)], { shallowThreshold: 3 });
    const r = createEvolutionRetrospect(h.deps).runOnce();
    expect(r.shallow).toBe(3);
    expect(h.lessons.some((l) => l.tags.includes('too_shallow'))).toBe(true);
  }));

  it('有 failedLogic（在尝试改逻辑）→ 不算"太浅"(只写失败教训)', () => withFlag(() => {
    const h = mkDeps([mkOutcome('doc_only', 10), mkOutcome('doc_only', 20), mkOutcome('doc_only', 30), mkOutcome('logic_changed', 40, false)], { shallowThreshold: 3 });
    createEvolutionRetrospect(h.deps).runOnce();
    expect(h.lessons.some((l) => l.tags.includes('too_shallow'))).toBe(false); // 在尝试改逻辑≠太浅
    expect(h.lessons.some((l) => l.tags.includes('failed'))).toBe(true);
  }));

  it('有 realLogic 又 shallow → 写成功模式,不写太浅', () => withFlag(() => {
    const h = mkDeps([mkOutcome('doc_only', 10), mkOutcome('doc_only', 20), mkOutcome('doc_only', 30), mkOutcome('logic_changed', 40, true)], { shallowThreshold: 3 });
    createEvolutionRetrospect(h.deps).runOnce();
    expect(h.lessons.some((l) => l.tags.includes('success'))).toBe(true);
    expect(h.lessons.some((l) => l.tags.includes('too_shallow'))).toBe(false);
  }));

  it('无新 outcome → no_new', () => withFlag(() => {
    const h = mkDeps([mkOutcome('logic_changed', 10, true)], { cursor: 100 });
    expect(createEvolutionRetrospect(h.deps).runOnce().reason).toBe('no_new');
  }));

  it('游标只取新 outcome(>cursor)', () => withFlag(() => {
    const h = mkDeps([mkOutcome('logic_changed', 50, true), mkOutcome('logic_changed', 150, true)], { cursor: 100 });
    const r = createEvolutionRetrospect(h.deps).runOnce();
    expect(r.realLogic).toBe(1);
    expect(h.cursorRef()).toBe(150);
  }));

  it('writeLesson 抛错 → fail-open 不崩，仍推进游标', () => withFlag(() => {
    const h = mkDeps([mkOutcome('logic_changed', 100, true)], { writeThrows: true });
    const r = createEvolutionRetrospect(h.deps).runOnce();
    expect(r.ok).toBe(true);
    expect(h.cursorRef()).toBe(100);
  }));

  it('listNewOutcomes 抛错 → list_failed', () => withFlag(() => {
    const h = mkDeps([], { listThrows: true });
    expect(createEvolutionRetrospect(h.deps).runOnce().reason).toBe('list_failed');
  }));

  it('getCursor 抛错 → since=0 fail-open', () => withFlag(() => {
    const h = mkDeps([mkOutcome('logic_changed', 100, true)], { getCursorThrows: true });
    expect(createEvolutionRetrospect(h.deps).runOnce().ok).toBe(true);
  }));
});
