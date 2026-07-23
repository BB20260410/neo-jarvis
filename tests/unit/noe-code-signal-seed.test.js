import { describe, it, expect, vi } from 'vitest';
import { createNoeCodeSignalSeed } from '../../src/room/NoeCodeSignalSeed.js';

// 路 2 真信号立项 wiring：扫缺 JSDoc → 去重 → goalSystem.add（source=self_evolution + 带 steps[feasible 杠杆] + meta.signal）。
//   自带单坑位（已有 meta.signal 的 open 真信号 goal 则本轮不立），但不挡诗性 inner thoughts（守人格）。

const mkScanner = (signals) => ({ scan: () => ({ signals, dropped: { protected: 0, duplicate: 0 } }) });
const mkGoalSystem = (opts = {}) => {
  const added = [];
  return {
    added,
    list: vi.fn(({ status }) => (opts.openGoals || []).filter((g) => g.status === status)),
    add: vi.fn((g) => { if (opts.addReturnsNull) return null; added.push(g); return `goal-${added.length}`; }),
  };
};
const SIG = { type: 'missing_jsdoc', file: 'src/a.js', line: 3, name: 'foo', title: '为 src/a.js:3 的 foo() 补 JSDoc 注释' };

describe('NoeCodeSignalSeed', () => {
  it('正常：scan 产信号 → add 立项（source=self_evolution + steps[feasible] + meta.signal + title 含路径）', () => {
    const gs = mkGoalSystem();
    const seed = createNoeCodeSignalSeed({ scanner: mkScanner([SIG]), goalSystem: gs, listSourceFiles: () => ['/p/src/a.js'], now: () => 1000 });
    const r = seed.runOnce();
    expect(r.ok).toBe(true);
    expect(gs.add).toHaveBeenCalledOnce();
    const g = gs.added[0];
    expect(g.source).toBe('self_evolution');
    expect(Array.isArray(g.steps) && g.steps.length).toBeTruthy(); // feasible 杠杆：带 steps
    expect(g.meta.signal).toBe('missing_jsdoc');
    expect(g.title).toContain('src/a.js');
  });

  it('单坑位：已有 meta.signal 的 open 真信号 goal → skip 不 add', () => {
    const gs = mkGoalSystem({ openGoals: [{ status: 'open', source: 'self_evolution', meta: { signal: 'missing_jsdoc' } }] });
    const seed = createNoeCodeSignalSeed({ scanner: mkScanner([SIG]), goalSystem: gs, listSourceFiles: () => ['/p/src/a.js'] });
    const r = seed.runOnce();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('signal_goal_in_flight');
    expect(gs.add).not.toHaveBeenCalled();
  });

  it('守人格：已有诗性 inner thoughts goal(无 meta.signal) → 真信号照立（并存，不被诗性挡）', () => {
    const gs = mkGoalSystem({ openGoals: [{ status: 'open', source: 'self_evolution', meta: null }] });
    const seed = createNoeCodeSignalSeed({ scanner: mkScanner([SIG]), goalSystem: gs, listSourceFiles: () => ['/p/src/a.js'] });
    expect(seed.runOnce().ok).toBe(true);
    expect(gs.add).toHaveBeenCalledOnce();
  });

  it('去重：signal.title 近重复被拒 lesson → skip 该信号（不 add）', () => {
    const gs = mkGoalSystem();
    const seed = createNoeCodeSignalSeed({ scanner: mkScanner([SIG]), goalSystem: gs, listSourceFiles: () => ['/p/src/a.js'], recallRejectLessons: () => ({ similar: true }) });
    expect(seed.runOnce().ok).toBe(false);
    expect(gs.add).not.toHaveBeenCalled();
  });

  it('无信号：scan 空 → no_signal', () => {
    const gs = mkGoalSystem();
    const seed = createNoeCodeSignalSeed({ scanner: mkScanner([]), goalSystem: gs, listSourceFiles: () => [] });
    expect(seed.runOnce().reason).toBe('no_signal');
  });

  it('add 同名去重返 null → add_rejected', () => {
    const gs = mkGoalSystem({ addReturnsNull: true });
    const seed = createNoeCodeSignalSeed({ scanner: mkScanner([SIG]), goalSystem: gs, listSourceFiles: () => ['/p/src/a.js'] });
    expect(seed.runOnce().reason).toBe('add_rejected');
  });

  it('recallRejectLessons 抛错 → fail-open（不挡立项）', () => {
    const gs = mkGoalSystem();
    const seed = createNoeCodeSignalSeed({ scanner: mkScanner([SIG]), goalSystem: gs, listSourceFiles: () => ['/p/src/a.js'], recallRejectLessons: () => { throw new Error('recall down'); } });
    expect(seed.runOnce().ok).toBe(true);
  });

  it('引用性过滤：孤儿(referenced:false)跳过，选被引用的文件', () => {
    const gs = mkGoalSystem();
    const seed = createNoeCodeSignalSeed({
      scanner: mkScanner([{ ...SIG, file: 'src/orphan.js' }, { ...SIG, file: 'src/used.js', title: '为 src/used.js:3 的 foo() 补 JSDoc 注释' }]),
      goalSystem: gs, listSourceFiles: () => ['/p/src/orphan.js', '/p/src/used.js'],
      referenceProbe: (rel) => ({ referenced: rel === 'src/used.js' }),
    });
    expect(seed.runOnce().ok).toBe(true);
    expect(gs.added[0].meta.file).toBe('src/used.js'); // 跳过孤儿，选被引用
  });

  it('引用性探针异常 → fail-open（不跳过，照立交 value gate 兜底）', () => {
    const gs = mkGoalSystem();
    const seed = createNoeCodeSignalSeed({ scanner: mkScanner([SIG]), goalSystem: gs, listSourceFiles: () => ['/p/src/a.js'], referenceProbe: () => { throw new Error('grep down'); } });
    expect(seed.runOnce().ok).toBe(true);
  });

  it('全是孤儿 → 全跳过（no chosen）', () => {
    const gs = mkGoalSystem();
    const seed = createNoeCodeSignalSeed({ scanner: mkScanner([SIG]), goalSystem: gs, listSourceFiles: () => ['/p/src/a.js'], referenceProbe: () => ({ referenced: false }) });
    expect(seed.runOnce().ok).toBe(false);
    expect(gs.add).not.toHaveBeenCalled();
  });

  it('文件级聚合：同文件多信号 → 一目标补多函数（title 紧凑多行 + meta.functions + aggregated）', () => {
    const gs = mkGoalSystem();
    const seed = createNoeCodeSignalSeed({
      scanner: mkScanner([
        { type: 'missing_jsdoc', file: 'src/a.js', line: 75, name: 'f1', title: 't1' },
        { type: 'missing_jsdoc', file: 'src/a.js', line: 208, name: 'f2', title: 't2' },
        { type: 'missing_jsdoc', file: 'src/b.js', line: 5, name: 'g', title: 't3' },
      ]),
      goalSystem: gs, listSourceFiles: () => ['/p/src/a.js'],
    });
    const r = seed.runOnce();
    expect(r.ok).toBe(true);
    expect(r.aggregated).toBe(2); // src/a.js 的 2 函数聚合（src/b.js 不同文件不并入）
    expect(gs.added[0].title).toContain('src/a.js:75,208');
    expect(gs.added[0].meta.functions.length).toBe(2);
  });

  it('单函数文件 → 不聚合（aggregated 1，title 不变）', () => {
    const gs = mkGoalSystem();
    const seed = createNoeCodeSignalSeed({ scanner: mkScanner([SIG]), goalSystem: gs, listSourceFiles: () => ['/p/src/a.js'] });
    const r = seed.runOnce();
    expect(r.aggregated).toBe(1);
    expect(gs.added[0].title).toBe(SIG.title);
  });
});
