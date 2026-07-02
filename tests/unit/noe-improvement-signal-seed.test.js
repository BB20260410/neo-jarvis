import { describe, it, expect } from 'vitest';
import { createImprovementSignalSeed } from '../../src/room/NoeImprovementSignalSeed.js';

// P2 多元信号立项：把 NoeCodeImprovementScanner 的 stale_todo/high_complexity/test_gap 信号 → self_evolution goal。
//   仿 NoeCodeSignalSeed：单坑位(自己的信号类型)防刷屏、引用性过滤跳孤儿、近重复去重、feasible 杠杆(带 steps)、fail-open。

const mkScanner = (signals) => ({ scan: () => ({ signals, dropped: { protected: 0, duplicate: 0 } }) });
const mkGoalSystem = (opts = {}) => {
  const added = [];
  return {
    added,
    add: (g) => { if (opts.addReturnsNull) return null; added.push(g); return `goal-${added.length}`; },
    list: ({ status }) => (opts.openGoals || []).filter((g) => g.status === status),
  };
};
const SIG = { type: 'stale_todo', file: 'src/a.js', line: 5, title: '处理 src/a.js:5 的 TODO：加缓存' };

const withFlag = (fn) => {
  const old = process.env.NOE_CODE_IMPROVEMENT_SIGNALS;
  process.env.NOE_CODE_IMPROVEMENT_SIGNALS = '1';
  try { return fn(); } finally {
    if (old === undefined) delete process.env.NOE_CODE_IMPROVEMENT_SIGNALS; else process.env.NOE_CODE_IMPROVEMENT_SIGNALS = old;
  }
};

describe('NoeImprovementSignalSeed', () => {
  it('flag OFF → skipped:flag_off', () => {
    const old = process.env.NOE_CODE_IMPROVEMENT_SIGNALS; delete process.env.NOE_CODE_IMPROVEMENT_SIGNALS;
    const r = createImprovementSignalSeed({ scanner: mkScanner([SIG]), goalSystem: mkGoalSystem(), listSourceFiles: () => ['/p/src/a.js'] }).runOnce();
    expect(r.skipped).toBe('flag_off');
    if (old !== undefined) process.env.NOE_CODE_IMPROVEMENT_SIGNALS = old;
  });

  it('正常：scan 产信号 → 立项(source=self_evolution, meta.signal=type, 带 steps)', () => withFlag(() => {
    const gs = mkGoalSystem();
    const r = createImprovementSignalSeed({ scanner: mkScanner([SIG]), goalSystem: gs, listSourceFiles: () => ['/p/src/a.js'], now: () => 1000 }).runOnce();
    expect(r.ok).toBe(true);
    expect(gs.added[0].source).toBe('self_evolution');
    expect(gs.added[0].meta.signal).toBe('stale_todo');
    expect(gs.added[0].meta.file).toBe('src/a.js');
    expect(Array.isArray(gs.added[0].steps) && gs.added[0].steps.length).toBeTruthy();
    expect(gs.added[0].title).toContain('TODO');
  }));

  it('单坑位：已有 improvement 信号 goal 在飞 → 不立(不挡 missing_jsdoc/诗性)', () => withFlag(() => {
    const gs = mkGoalSystem({ openGoals: [{ status: 'open', source: 'self_evolution', meta: { signal: 'high_complexity' } }] });
    const r = createImprovementSignalSeed({ scanner: mkScanner([SIG]), goalSystem: gs, listSourceFiles: () => ['/p/src/a.js'] }).runOnce();
    expect(r.reason).toBe('signal_goal_in_flight');
  }));

  it('不挡其他信号：已有 missing_jsdoc goal → improvement 照立', () => withFlag(() => {
    const gs = mkGoalSystem({ openGoals: [{ status: 'open', source: 'self_evolution', meta: { signal: 'missing_jsdoc' } }] });
    const r = createImprovementSignalSeed({ scanner: mkScanner([SIG]), goalSystem: gs, listSourceFiles: () => ['/p/src/a.js'] }).runOnce();
    expect(r.ok).toBe(true);
  }));

  it('无信号 → no_signal', () => withFlag(() => {
    const r = createImprovementSignalSeed({ scanner: mkScanner([]), goalSystem: mkGoalSystem(), listSourceFiles: () => [] }).runOnce();
    expect(r.reason).toBe('no_signal');
  }));

  it('引用性过滤：孤儿(referenced:false)跳过，选被引用的', () => withFlag(() => {
    const gs = mkGoalSystem();
    const r = createImprovementSignalSeed({
      scanner: mkScanner([{ ...SIG, file: 'src/orphan.js' }, { ...SIG, file: 'src/used.js' }]),
      goalSystem: gs, listSourceFiles: () => ['/p/src/orphan.js', '/p/src/used.js'],
      referenceProbe: (rel) => ({ referenced: rel === 'src/used.js' }),
    }).runOnce();
    expect(r.ok).toBe(true);
    expect(gs.added[0].meta.file).toBe('src/used.js');
  }));

  it('近重复被拒 → 跳过', () => withFlag(() => {
    const gs = mkGoalSystem();
    const r = createImprovementSignalSeed({ scanner: mkScanner([SIG]), goalSystem: gs, listSourceFiles: () => ['/p/src/a.js'], recallRejectLessons: () => ({ similar: true }) }).runOnce();
    expect(r.ok).toBe(false);
    expect(gs.added.length).toBe(0);
  }));

  it('add 返 null → add_rejected', () => withFlag(() => {
    const r = createImprovementSignalSeed({ scanner: mkScanner([SIG]), goalSystem: mkGoalSystem({ addReturnsNull: true }), listSourceFiles: () => ['/p/src/a.js'] }).runOnce();
    expect(r.reason).toBe('add_rejected');
  }));

  it('scan 抛错 → scan_failed 不崩', () => withFlag(() => {
    const r = createImprovementSignalSeed({ scanner: { scan: () => { throw new Error('x'); } }, goalSystem: mkGoalSystem(), listSourceFiles: () => ['/p/src/a.js'] }).runOnce();
    expect(r.reason).toBe('scan_failed');
  }));

  it('同信号同文件冷却中 → 跳过,选下一个(防反复撞改不动的目标)', () => withFlag(() => {
    const gs = mkGoalSystem();
    const r = createImprovementSignalSeed({
      scanner: mkScanner([{ ...SIG, file: 'src/cooling.js' }, { ...SIG, file: 'src/fresh.js' }]),
      goalSystem: gs, listSourceFiles: () => ['/p/src/cooling.js', '/p/src/fresh.js'],
      recentlyAttempted: (type, file) => file === 'src/cooling.js',
    }).runOnce();
    expect(r.ok).toBe(true);
    expect(gs.added[0].meta.file).toBe('src/fresh.js');
  }));

  it('全部冷却中 → all_filtered(不重复立项)', () => withFlag(() => {
    const gs = mkGoalSystem();
    const r = createImprovementSignalSeed({
      scanner: mkScanner([SIG]), goalSystem: gs, listSourceFiles: () => ['/p/src/a.js'],
      recentlyAttempted: () => true,
    }).runOnce();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('all_filtered');
    expect(gs.added.length).toBe(0);
  }));

  it('跳过复杂度过高(>maxComplexity,M3也难一次改对)的 high_complexity,选改得动的', () => withFlag(() => {
    const gs = mkGoalSystem();
    const r = createImprovementSignalSeed({
      scanner: mkScanner([
        { type: 'high_complexity', file: 'src/hard.js', line: 1, complexity: 35, title: '重构 src/hard.js cx35' },
        { type: 'high_complexity', file: 'src/ok.js', line: 1, complexity: 18, title: '重构 src/ok.js cx18' },
      ]),
      goalSystem: gs, listSourceFiles: () => ['/p/src/hard.js', '/p/src/ok.js'],
      maxComplexity: 25,
    }).runOnce();
    expect(r.ok).toBe(true);
    expect(gs.added[0].meta.file).toBe('src/ok.js'); // 跳过 cx35,选 cx18(M3 改得动的低垂果实)
  }));

  it('全部 high_complexity 都超 maxComplexity → all_filtered(不硬塞改不动的给 M3)', () => withFlag(() => {
    const gs = mkGoalSystem();
    const r = createImprovementSignalSeed({
      scanner: mkScanner([{ type: 'high_complexity', file: 'src/hard.js', line: 1, complexity: 40, title: '重构 cx40' }]),
      goalSystem: gs, listSourceFiles: () => ['/p/src/hard.js'],
      maxComplexity: 25,
    }).runOnce();
    expect(r.ok).toBe(false);
    expect(gs.added.length).toBe(0);
  }));

  it('signalPriority 让 test_gap 优先(A2红利:补测试覆盖,不被 high_complexity 占满)', () => withFlag(() => {
    const gs = mkGoalSystem();
    const r = createImprovementSignalSeed({
      scanner: mkScanner([
        { type: 'high_complexity', file: 'src/a.js', line: 1, complexity: 15, title: '重构 a cx15' },
        { type: 'test_gap', file: 'src/b.js', title: '为 src/b.js 补测试' },
      ]),
      goalSystem: gs, listSourceFiles: () => ['/p/src/a.js', '/p/src/b.js'],
    }).runOnce({ signalPriority: ['test_gap', 'high_complexity'] });
    expect(r.ok).toBe(true);
    expect(gs.added[0].meta.signal).toBe('test_gap'); // test_gap 排在 high_complexity 前被选
  }));

  it('signalPriority 缺省 → 保持扫描顺序(零回归)', () => withFlag(() => {
    const gs = mkGoalSystem();
    createImprovementSignalSeed({
      scanner: mkScanner([
        { type: 'high_complexity', file: 'src/a.js', line: 1, complexity: 15, title: '重构 a' },
        { type: 'test_gap', file: 'src/b.js', title: '补测试 b' },
      ]),
      goalSystem: gs, listSourceFiles: () => ['/p/src/a.js', '/p/src/b.js'],
    }).runOnce();
    expect(gs.added[0].meta.signal).toBe('high_complexity'); // 无 priority:第一个(扫描顺序)
  }));

  it('signalPriority 透传给 scanner.scan(让 limit 截断也尊重优先级,根治 test_gap 被前面 high_complexity 截没)', () => withFlag(() => {
    let captured = null;
    const scanner = { scan: (args) => { captured = args; return { signals: [{ type: 'test_gap', file: 'src/b.js', title: 't' }], dropped: {} }; } };
    createImprovementSignalSeed({ scanner, goalSystem: mkGoalSystem(), listSourceFiles: () => ['/p/src/b.js'] })
      .runOnce({ signalPriority: ['test_gap', 'high_complexity'] });
    expect(captured.priorityTypes).toEqual(['test_gap', 'high_complexity']); // 透传:截断在 scanner 层就按优先级,非只在 seed 结果上排序
  }));
});
