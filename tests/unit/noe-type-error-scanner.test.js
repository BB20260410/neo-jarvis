import { describe, it, expect } from 'vitest';
import { parseTypecheckTargets, assessTypeErrorFix, countFileTypeErrors } from '../../src/cognition/NoeTypeErrorScanner.js';

// type_error_fix 域(扩展自主能力域第一个):解析 `tsc --checkJs` 输出,提取 src/ 下低 error 文件作目标。
//   验证前移已证:src/ 502文件/5213 error,低error文件多;baseline非CI绿门,价值锚必须按文件。
//   优先低 error 文件(M3 易修)+ 只 src/(域范围)+ 畸形行不崩(fail-open)。
const SAMPLE = [
  "src/agents/AgentPolicyStore.js(66,63): error TS2339: Property 'message' does not exist on type '{}'.",
  "src/cognition/NoeFocusStack.js(16,77): error TS2322: Type 'null' is not assignable to type 'fn'.",
  "src/cognition/NoeFocusStack.js(20,5): error TS2339: Property 'x' does not exist.",
  "tests/unit/workspace-manager.test.js(62,14): error TS18048: 'alpha' is possibly 'undefined'.",
  "scripts/foo.mjs(1,1): error TS2304: Cannot find name 'bar'.",
].join('\n');

describe('parseTypecheckTargets', () => {
  it('解析单行 → 文件名/行号/错误码/消息正确', () => {
    const r = parseTypecheckTargets("src/a.js(66,63): error TS2339: Property 'message' does not exist on type '{}'.");
    expect(r).toHaveLength(1);
    expect(r[0].file).toBe('src/a.js');
    expect(r[0].errorCount).toBe(1);
    expect(r[0].errors[0]).toMatchObject({ line: 66, code: 'TS2339' });
    expect(r[0].errors[0].message).toContain('Property');
  });

  it('同文件多 error 聚合为一个目标,errorCount 计数', () => {
    const r = parseTypecheckTargets(SAMPLE);
    const focus = r.find((t) => t.file === 'src/cognition/NoeFocusStack.js');
    expect(focus.errorCount).toBe(2);
  });

  it('只取 src/(域范围),排除 tests/ 和 scripts/', () => {
    const files = parseTypecheckTargets(SAMPLE).map((t) => t.file);
    expect(files).toContain('src/agents/AgentPolicyStore.js');
    expect(files.some((f) => f.startsWith('tests/'))).toBe(false);
    expect(files.some((f) => f.startsWith('scripts/'))).toBe(false);
  });

  it('按 errorCount 升序(低 error 文件优先,M3 易修)', () => {
    const r = parseTypecheckTargets(SAMPLE);
    expect(r[0].errorCount).toBeLessThanOrEqual(r[r.length - 1].errorCount);
    expect(r[0].file).toBe('src/agents/AgentPolicyStore.js'); // 1 error
  });

  it('maxErrorsPerFile 过滤掉高 error 文件', () => {
    const r = parseTypecheckTargets(SAMPLE, { maxErrorsPerFile: 1 });
    expect(r.every((t) => t.errorCount <= 1)).toBe(true);
    expect(r.find((t) => t.file === 'src/cognition/NoeFocusStack.js')).toBeUndefined();
  });

  it('空输入/畸形行 → 不崩,返回 []（fail-open）', () => {
    expect(parseTypecheckTargets('')).toEqual([]);
    expect(parseTypecheckTargets('garbage line no match\n   \n')).toEqual([]);
    expect(parseTypecheckTargets(null)).toEqual([]);
  });

  it('自定义 pathPrefix 可改域范围', () => {
    const r = parseTypecheckTargets(SAMPLE, { pathPrefix: 'tests/' });
    expect(r).toHaveLength(1);
    expect(r[0].file).toBe('tests/unit/workspace-manager.test.js');
  });
});

// 防作弊价值锚:type_error_fix 域的核心 reward hacking 防护。M3 可能用 @ts-ignore/any "消音"
//   消除 error 但没真修——必须拦。同时验证 error 真减少(非空改/反增)。
describe('assessTypeErrorFix', () => {
  it('error 减少 + 无作弊标记 → ok', () => {
    const r = assessTypeErrorFix({ patchText: 'e instanceof Error ? e.message : e', beforeErrorCount: 1, afterErrorCount: 0 });
    expect(r.ok).toBe(true);
  });

  it('error 清零 → ok', () => {
    expect(assessTypeErrorFix({ patchText: '/** @param {string} x */', beforeErrorCount: 2, afterErrorCount: 0 }).ok).toBe(true);
  });

  it('引入 @ts-ignore → 拒(作弊消音)', () => {
    const r = assessTypeErrorFix({ patchText: '// @ts-ignore\nfoo.bar()', beforeErrorCount: 1, afterErrorCount: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ts-ignore|作弊/);
  });

  it('引入 @ts-nocheck → 拒', () => {
    expect(assessTypeErrorFix({ patchText: '// @ts-nocheck', beforeErrorCount: 3, afterErrorCount: 0 }).ok).toBe(false);
  });

  it('引入 : any 类型标注 → 拒(逃避而非修)', () => {
    expect(assessTypeErrorFix({ patchText: '/** @type {any} */ const x = foo', beforeErrorCount: 1, afterErrorCount: 0 }).ok).toBe(false);
  });

  it('as any 断言 → 拒', () => {
    expect(assessTypeErrorFix({ patchText: 'return (foo as any).bar', beforeErrorCount: 1, afterErrorCount: 0 }).ok).toBe(false);
  });

  it('eslint-disable 也算作弊 → 拒', () => {
    expect(assessTypeErrorFix({ patchText: '// eslint-disable-next-line', beforeErrorCount: 1, afterErrorCount: 0 }).ok).toBe(false);
  });

  it('error 没减少(反增/持平) → 拒(没真修)', () => {
    expect(assessTypeErrorFix({ patchText: 'const x = 1', beforeErrorCount: 2, afterErrorCount: 2 }).ok).toBe(false);
    expect(assessTypeErrorFix({ patchText: 'const x = 1', beforeErrorCount: 2, afterErrorCount: 3 }).ok).toBe(false);
  });
});

// 块4 辅助:apply 后算单文件的 type error 数(after),交 assessTypeErrorFix 判是否真减少。复用 parseTypecheckTargets。
describe('countFileTypeErrors', () => {
  const OUT = [
    "src/a.js(1,1): error TS2339: foo.",
    "src/a.js(5,2): error TS2322: bar.",
    "src/b.js(1,1): error TS2339: baz.",
  ].join('\n');

  it('返回指定文件的 error 数', () => {
    expect(countFileTypeErrors(OUT, 'src/a.js')).toBe(2);
    expect(countFileTypeErrors(OUT, 'src/b.js')).toBe(1);
  });

  it('文件无 error(已修好) → 0', () => {
    expect(countFileTypeErrors(OUT, 'src/clean.js')).toBe(0);
  });

  it('空/null 输出 → 0(fail-open)', () => {
    expect(countFileTypeErrors('', 'src/a.js')).toBe(0);
    expect(countFileTypeErrors(null, 'src/a.js')).toBe(0);
  });
});

describe('P4 救域：denyCodes 排除 M3 修不动的难 error 码', () => {
  const out = [
    'src/a.js(1,1): error TS2531: Object is possibly null.',
    'src/b.js(2,2): error TS2339: Property x does not exist.',
    'src/b.js(3,3): error TS2531: Object is possibly null.',
    'src/c.js(4,4): error TS2322: Type A is not assignable to type B.',
  ].join('\n');

  it('denyCodes 命中任一 error 的文件整体排除（只留全简单 error 的文件）', () => {
    const targets = parseTypecheckTargets(out, { denyCodes: ['TS2339', 'TS2322'] });
    expect(targets.map((t) => t.file)).toEqual(['src/a.js']);
  });

  it('denyCodes 未设时行为不变（零回归）', () => {
    const targets = parseTypecheckTargets(out, {});
    expect(targets.map((t) => t.file).sort()).toEqual(['src/a.js', 'src/b.js', 'src/c.js']);
  });

  it('denyCodes 兼容不带 TS 前缀写法', () => {
    const targets = parseTypecheckTargets(out, { denyCodes: ['2339', '2322'] });
    expect(targets.map((t) => t.file)).toEqual(['src/a.js']);
  });
});
