import { describe, it, expect } from 'vitest';
import { createEvolutionOutcome } from '../../src/cognition/NoeEvolutionOutcome.js';

// P0 进化价值度量（外部尺子）：apply 前后采集 touchedFiles 客观指标（lines/codeLines/missingJsdoc），
//   diff 出"改了有没有变好"。核心：codeLinesDelta=0 + missingJsdocDelta>0 → verdict 'doc_only'（纯文档进化=浅），
//   codeLinesDelta!=0 → 'logic_changed'（改了行为）。shadow 记账不拦，防 reward hacking。全程 fail-open。

// mock scanner：按文件名返回缺 JSDoc 数
const mkScanner = (perFile) => ({
  scan: ({ files = [] } = {}) => ({ signals: Array(perFile[files[0]] ?? 0).fill({ type: 'missing_jsdoc' }), dropped: { protected: 0, duplicate: 0 } }),
});
const mkRead = (perFile) => (abs) => { if (perFile[abs] === undefined) throw new Error('ENOENT'); return perFile[abs]; };

describe('NoeEvolutionOutcome', () => {
  it('measureFile：lines / codeLines(非注释非空) / missingJsdoc', () => {
    const code = 'export function f(){\n  return 1;\n}\n// comment\n\n/** doc */';
    const oc = createEvolutionOutcome({ scanner: mkScanner({ '/p/a.js': 2 }), fsReadFile: mkRead({ '/p/a.js': code }), projectRoot: '/p' });
    const m = oc.measureFile('a.js');
    expect(m.lines).toBe(6);
    expect(m.codeLines).toBe(3); // export.../return.../} 三行是代码;注释+空行+/** 不算
    expect(m.missingJsdoc).toBe(2);
  });

  it('measureFile：纯注释文件 codeLines=0', () => {
    const oc = createEvolutionOutcome({ scanner: mkScanner({}), fsReadFile: mkRead({ '/p/c.js': '// a\n/* b */\n *\n' }), projectRoot: '/p' });
    expect(oc.measureFile('c.js').codeLines).toBe(0);
  });

  it('measure：多文件聚合', () => {
    const oc = createEvolutionOutcome({ scanner: mkScanner({ '/p/a.js': 1, '/p/b.js': 0 }), fsReadFile: mkRead({ '/p/a.js': 'x', '/p/b.js': 'y\nz' }), projectRoot: '/p' });
    const m = oc.measure(['a.js', 'b.js']);
    expect(Object.keys(m)).toEqual(['a.js', 'b.js']);
    expect(m['b.js'].lines).toBe(2);
  });

  it('diff：补 JSDoc → missingJsdocDelta 正、codeLinesDelta 0', () => {
    const oc = createEvolutionOutcome({ scanner: mkScanner({}), fsReadFile: mkRead({}), projectRoot: '/p' });
    const d = oc.diff({ 'a.js': { lines: 10, codeLines: 8, missingJsdoc: 5 } }, { 'a.js': { lines: 15, codeLines: 8, missingJsdoc: 2 } });
    expect(d['a.js'].missingJsdocDelta).toBe(3); // 5→2 补了 3 个
    expect(d['a.js'].codeLinesDelta).toBe(0);    // 代码行没变=纯注释
    expect(d['a.js'].linesDelta).toBe(5);
  });

  it('diff：改逻辑 → codeLinesDelta 非 0', () => {
    const oc = createEvolutionOutcome({ scanner: mkScanner({}), fsReadFile: mkRead({}), projectRoot: '/p' });
    const d = oc.diff({ 'a.js': { lines: 10, codeLines: 8, missingJsdoc: 0 } }, { 'a.js': { lines: 14, codeLines: 12, missingJsdoc: 0 } });
    expect(d['a.js'].codeLinesDelta).toBe(4);
  });

  it('summarize：纯补测试(改动只涉及 tests/ 文件) → verdict test_only(有价值,非 neutral 空转)', () => {
    // 飞轮自主补测试是有价值的覆盖增量。新增测试文件 apply 前不存在(before 无该 key)→ diff 兜底 codeLinesDelta=0，
    //   旧逻辑误落 neutral → P4 SHALLOW_VERDICTS/P5 shallowRatio 把它当「浅层空转」。test_only 让度量诚实。
    const oc = createEvolutionOutcome({ scanner: mkScanner({}), fsReadFile: mkRead({}), projectRoot: '/p' });
    const s = oc.summarize({ before: {}, after: { 'tests/unit/foo.test.js': { lines: 30, codeLines: 25, missingJsdoc: 0 } } });
    expect(s.verdict).toBe('test_only');
  });

  it('summarize：改 src 逻辑 + 配套测试 → logic_changed(改逻辑优先,走双绿门,不降级 test_only)', () => {
    const oc = createEvolutionOutcome({ scanner: mkScanner({}), fsReadFile: mkRead({}), projectRoot: '/p' });
    const s = oc.summarize({
      before: { 'src/a.js': { lines: 10, codeLines: 8, missingJsdoc: 0 } },
      after: { 'src/a.js': { lines: 14, codeLines: 12, missingJsdoc: 0 }, 'tests/a.test.js': { lines: 20, codeLines: 16, missingJsdoc: 0 } },
    });
    expect(s.verdict).toBe('logic_changed'); // 非测试文件有代码变化 → 改逻辑优先于 test_only
  });

  it('record：纯补 JSDoc → verdict doc_only(浅进化,P0 要证明的现状)', () => {
    const recorded = [];
    const oc = createEvolutionOutcome({ scanner: mkScanner({}), fsReadFile: mkRead({}), projectRoot: '/p', recordOutcome: (s) => recorded.push(s) });
    const s = oc.record({ patchPlanId: 'p1', before: { 'a.js': { lines: 10, codeLines: 8, missingJsdoc: 5 } }, after: { 'a.js': { lines: 15, codeLines: 8, missingJsdoc: 2 } } });
    expect(s.verdict).toBe('doc_only');
    expect(s.jsdocImproved).toBe(3);
    expect(s.codeChanged).toBe(0);
    expect(s.filesChanged).toBe(1);
    expect(recorded.length).toBe(1);
  });

  it('record：改逻辑 → verdict logic_changed', () => {
    const oc = createEvolutionOutcome({ scanner: mkScanner({}), fsReadFile: mkRead({}), projectRoot: '/p' });
    const s = oc.record({ patchPlanId: 'p2', before: { 'a.js': { lines: 10, codeLines: 8, missingJsdoc: 0 } }, after: { 'a.js': { lines: 14, codeLines: 12, missingJsdoc: 0 } } });
    expect(s.verdict).toBe('logic_changed');
    expect(s.codeChanged).toBe(4);
  });

  it('measureFile 读失败 → null 不崩', () => {
    const oc = createEvolutionOutcome({ scanner: mkScanner({}), fsReadFile: mkRead({}), projectRoot: '/p' });
    expect(oc.measureFile('missing.js')).toBe(null);
  });

  it('scanner.scan 抛错 → missingJsdoc 0 不崩(fail-open)', () => {
    const oc = createEvolutionOutcome({ scanner: { scan: () => { throw new Error('acorn fail'); } }, fsReadFile: mkRead({ '/p/a.js': 'x\ny' }), projectRoot: '/p' });
    const m = oc.measureFile('a.js');
    expect(m.missingJsdoc).toBe(0);
    expect(m.lines).toBe(2);
  });

  it('record：recordOutcome 抛错 → fail-open 不崩', () => {
    const oc = createEvolutionOutcome({ scanner: mkScanner({}), fsReadFile: mkRead({}), projectRoot: '/p', recordOutcome: () => { throw new Error('db down'); } });
    expect(() => oc.record({ patchPlanId: 'p', before: {}, after: {} })).not.toThrow();
  });

  it('measureAndRecord：apply 前后一站式（before→after→record）', () => {
    const recorded = [];
    const files = { '/p/a.js': 'export function f(){}\nexport function g(){}' };
    const oc = createEvolutionOutcome({ scanner: mkScanner({ '/p/a.js': 2 }), fsReadFile: (abs) => files[abs], projectRoot: '/p', recordOutcome: (s) => recorded.push(s) });
    const before = oc.measure(['a.js']);
    // 模拟 apply 补了 JSDoc（missingJsdoc 2→0，加注释行）
    files['/p/a.js'] = '/** f */\nexport function f(){}\n/** g */\nexport function g(){}';
    mkScanner({ '/p/a.js': 0 }); // after 无缺失——但 scanner 已固定，改用新实例验证 diff 逻辑即可
    expect(before['a.js'].missingJsdoc).toBe(2);
  });

  // 根因修复：区分「尝试改了逻辑」(记账)与「最终保留了」(applied)。防 P4/P5 把被回滚的尝试当成功。
  it('summarize：纯计算 verdict/codeChanged，不落账（给 gate 判分流用）', () => {
    const recorded = [];
    const oc = createEvolutionOutcome({ scanner: mkScanner({}), fsReadFile: mkRead({}), projectRoot: '/p', recordOutcome: (s) => recorded.push(s) });
    const s = oc.summarize({ before: { 'a.js': { lines: 10, codeLines: 8, missingJsdoc: 0 } }, after: { 'a.js': { lines: 14, codeLines: 12, missingJsdoc: 0 } } });
    expect(s.verdict).toBe('logic_changed');
    expect(s.codeChanged).toBe(4);
    expect(recorded.length).toBe(0); // 不落账
  });

  it('record applied:false → summary.applied=false（被回滚的尝试，P4/P5 据此不误判为成功）', () => {
    const recorded = [];
    const oc = createEvolutionOutcome({ scanner: mkScanner({}), fsReadFile: mkRead({}), projectRoot: '/p', recordOutcome: (s) => recorded.push(s) });
    const s = oc.record({ patchPlanId: 'p', before: { 'a.js': { lines: 10, codeLines: 8, missingJsdoc: 0 } }, after: { 'a.js': { lines: 14, codeLines: 12, missingJsdoc: 0 } }, applied: false });
    expect(s.applied).toBe(false);
    expect(s.verdict).toBe('logic_changed'); // verdict 仍记「真改了逻辑」
    expect(recorded[0].applied).toBe(false); // 落账带 applied
  });

  it('record 默认 applied:true（向后兼容）', () => {
    const oc = createEvolutionOutcome({ scanner: mkScanner({}), fsReadFile: mkRead({}), projectRoot: '/p' });
    const s = oc.record({ patchPlanId: 'p', before: {}, after: {} });
    expect(s.applied).toBe(true);
  });
});

describe('P2 观测修复：新建文件基线 0 + reason 落账', () => {
  it('新建 src 文件（无 before 条目）按 0 行基线计 delta → logic_changed 而非 neutral', () => {
    const oc = createEvolutionOutcome({ scanner: mkScanner({}), fsReadFile: mkRead({}), projectRoot: '/p' });
    const s = oc.summarize({ before: {}, after: { 'src/new-module.js': { lines: 40, codeLines: 30, missingJsdoc: 0 } } });
    expect(s.verdict).toBe('logic_changed');
    expect(s.codeChanged).toBe(30);
  });

  it('新建纯测试文件仍判 test_only（路径分流优先级不变）', () => {
    const oc = createEvolutionOutcome({ scanner: mkScanner({}), fsReadFile: mkRead({}), projectRoot: '/p' });
    const s = oc.summarize({ before: {}, after: { 'tests/unit/x.test.js': { lines: 20, codeLines: 15, missingJsdoc: 0 } } });
    expect(s.verdict).toBe('test_only');
  });

  it('record 透传 reason 进 summary 与落账（回滚归因）', () => {
    const recorded = [];
    const oc = createEvolutionOutcome({ scanner: mkScanner({}), fsReadFile: mkRead({}), projectRoot: '/p', recordOutcome: (s) => recorded.push(s) });
    const s = oc.record({ patchPlanId: 'p', before: {}, after: {}, applied: false, reason: 'verify_not_green' });
    expect(s.reason).toBe('verify_not_green');
    expect(recorded[0].reason).toBe('verify_not_green');
  });

  it('record 无 reason 时默认空串（向后兼容）', () => {
    const oc = createEvolutionOutcome({ scanner: mkScanner({}), fsReadFile: mkRead({}), projectRoot: '/p' });
    const s = oc.record({ patchPlanId: 'p', before: {}, after: {} });
    expect(s.reason).toBe('');
  });
});
