import { describe, it, expect } from 'vitest';
import { createCodeQualitySignalScanner } from '../../src/cognition/NoeCodeQualitySignalScanner.js';

// 路 2 真信号源第一个扫描器：扫"非 protected 文件里缺 JSDoc 的导出函数" → 产含 src 路径的信号。
//   DI：fsReadFile / projectRoot / isProtected / now 全注入，纯函数可测、fail-open。

const mk = (fileMap, opts = {}) => createCodeQualitySignalScanner({
  fsReadFile: (abs) => {
    const rel = abs.replace('/proj/', '');
    if (!(rel in fileMap)) throw new Error('ENOENT');
    return fileMap[rel];
  },
  projectRoot: '/proj',
  isProtected: opts.isProtected || (() => false),
  now: () => 1000,
});

describe('NoeCodeQualitySignalScanner', () => {
  it('缺 JSDoc 的 export function → 1 信号（含 file/line/name）', () => {
    const s = mk({ 'src/a.js': 'export function foo() {\n  return 1;\n}\n' });
    const r = s.scan({ files: ['/proj/src/a.js'], limit: 10 });
    expect(r.signals.length).toBe(1);
    expect(r.signals[0]).toMatchObject({ type: 'missing_jsdoc', file: 'src/a.js', name: 'foo', line: 1 });
  });

  it('有 JSDoc(/** */) 的 export function → 0 信号', () => {
    const s = mk({ 'src/a.js': '/**\n * 文档。\n */\nexport function foo() {}\n' });
    expect(s.scan({ files: ['/proj/src/a.js'] }).signals.length).toBe(0);
  });

  it('只有行注释(// 非 JSDoc) 的 export function → 仍算缺 JSDoc → 1 信号', () => {
    const s = mk({ 'src/a.js': '// 普通注释\nexport function foo() {}\n' });
    expect(s.scan({ files: ['/proj/src/a.js'] }).signals.length).toBe(1);
  });

  it('非 export 的 function → 0 信号（只扫导出）', () => {
    const s = mk({ 'src/a.js': 'function foo() {}\nconst bar = () => {};\n' });
    expect(s.scan({ files: ['/proj/src/a.js'] }).signals.length).toBe(0);
  });

  it('export const 箭头/函数表达式也扫', () => {
    const s = mk({ 'src/a.js': 'export const bar = () => {};\n' });
    const r = s.scan({ files: ['/proj/src/a.js'] });
    expect(r.signals.length).toBe(1);
    expect(r.signals[0].name).toBe('bar');
  });

  it('protected 文件 → 计入 dropped.protected、0 信号', () => {
    const s = mk({ 'src/a.js': 'export function foo() {}' }, { isProtected: () => true });
    const r = s.scan({ files: ['/proj/src/a.js'] });
    expect(r.signals.length).toBe(0);
    expect(r.dropped.protected).toBe(1);
  });

  it('同 {file:line:name} 去重（重复传同文件）', () => {
    const s = mk({ 'src/a.js': 'export function foo() {}' });
    const r = s.scan({ files: ['/proj/src/a.js', '/proj/src/a.js'] });
    expect(r.signals.length).toBe(1);
  });

  it('parse 失败 → fail-open（不抛、该文件 0 信号）', () => {
    const s = mk({ 'src/a.js': 'export function {{{ 语法错' });
    expect(() => s.scan({ files: ['/proj/src/a.js'] })).not.toThrow();
    expect(s.scan({ files: ['/proj/src/a.js'] }).signals.length).toBe(0);
  });

  it('读文件失败 → fail-open（跳过该文件，不崩）', () => {
    const s = mk({ 'src/a.js': 'export function foo() {}' });
    const r = s.scan({ files: ['/proj/src/missing.js', '/proj/src/a.js'] });
    expect(r.signals.length).toBe(1); // missing 跳过，a.js 正常
  });

  it('signal.title 含 src 路径 + 函数名（让 implementer readTargetFileContext 提取真实代码）', () => {
    const s = mk({ 'src/a.js': 'export function foo() {}' });
    const sig = s.scan({ files: ['/proj/src/a.js'] }).signals[0];
    expect(sig.title).toContain('src/a.js');
    expect(sig.title).toContain('foo');
  });

  it('limit 截断信号数', () => {
    const s = mk({ 'src/a.js': 'export function a(){}\nexport function b(){}\nexport function c(){}\n' });
    const r = s.scan({ files: ['/proj/src/a.js'], limit: 2 });
    expect(r.signals.length).toBe(2);
  });
});
