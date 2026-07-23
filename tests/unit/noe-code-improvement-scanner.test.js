import { describe, it, expect } from 'vitest';
import { createCodeImprovementScanner } from '../../src/cognition/NoeCodeImprovementScanner.js';

// P2 多元真信号源：扩展飞轮"该改什么"的视野——除缺 JSDoc 外，再发现 stale_todo(TODO/FIXME)、
//   high_complexity(圈复杂度超阈值)、test_gap(导出函数文件无测试)。每种独立 signalType，纯函数+DI+fail-open。

const mkRead = (perFile) => (abs) => { if (perFile[abs] === undefined) throw new Error('ENOENT'); return perFile[abs]; };

describe('NoeCodeImprovementScanner', () => {
  it('stale_todo：扫出 TODO/FIXME 注释 → 信号(含行号+内容)', () => {
    const code = 'export function f(){\n  // TODO: 加缓存\n  return 1;\n}\n/* FIXME 处理空值 */';
    const sc = createCodeImprovementScanner({ fsReadFile: mkRead({ '/p/a.js': code }), projectRoot: '/p', hasTest: () => true });
    const r = sc.scan({ files: ['/p/a.js'], signalTypes: ['stale_todo'] });
    const todos = r.signals.filter((s) => s.type === 'stale_todo');
    expect(todos.length).toBe(2);
    expect(todos[0].line).toBe(2);
    expect(todos[0].title).toContain('TODO');
  });

  it('high_complexity：复杂函数(多分支)→ 信号、简单函数不报', () => {
    const complex = 'export function big(a,b){\n if(a){if(b){return 1;}}\n for(let i=0;i<a;i++){ if(i&&b||a){} }\n while(b){ switch(a){case 1:break;case 2:break;} }\n return a&&b||a;\n}';
    const simple = 'export function tiny(a){ return a + 1; }';
    const sc = createCodeImprovementScanner({ fsReadFile: mkRead({ '/p/c.js': complex, '/p/s.js': simple }), projectRoot: '/p', hasTest: () => true, complexityThreshold: 8 });
    const rc = sc.scan({ files: ['/p/c.js'], signalTypes: ['high_complexity'] });
    expect(rc.signals.some((s) => s.type === 'high_complexity' && s.name === 'big')).toBe(true);
    expect(rc.signals[0].complexity).toBeGreaterThanOrEqual(8);
    const rs = sc.scan({ files: ['/p/s.js'], signalTypes: ['high_complexity'] });
    expect(rs.signals.length).toBe(0);
  });

  it('test_gap：导出函数文件无测试 → 信号；有测试 → 无', () => {
    const code = 'export function foo(){}\nexport function bar(){}';
    const scNoTest = createCodeImprovementScanner({ fsReadFile: mkRead({ '/p/x.js': code }), projectRoot: '/p', hasTest: () => false });
    const r1 = scNoTest.scan({ files: ['/p/x.js'], signalTypes: ['test_gap'] });
    expect(r1.signals.some((s) => s.type === 'test_gap' && s.file === 'x.js')).toBe(true);
    const scHasTest = createCodeImprovementScanner({ fsReadFile: mkRead({ '/p/x.js': code }), projectRoot: '/p', hasTest: () => true });
    const r2 = scHasTest.scan({ files: ['/p/x.js'], signalTypes: ['test_gap'] });
    expect(r2.signals.filter((s) => s.type === 'test_gap').length).toBe(0);
  });

  it('test_gap：无导出函数的文件 → 不报(无需测试)', () => {
    const sc = createCodeImprovementScanner({ fsReadFile: mkRead({ '/p/c.js': 'const X = 1;' }), projectRoot: '/p', hasTest: () => false });
    expect(sc.scan({ files: ['/p/c.js'], signalTypes: ['test_gap'] }).signals.length).toBe(0);
  });

  it('signalTypes 过滤：只扫指定类型', () => {
    const code = 'export function f(){\n // TODO: x\n}';
    const sc = createCodeImprovementScanner({ fsReadFile: mkRead({ '/p/a.js': code }), projectRoot: '/p', hasTest: () => false });
    // 只要 stale_todo：不应混入 test_gap
    const r = sc.scan({ files: ['/p/a.js'], signalTypes: ['stale_todo'] });
    expect(r.signals.every((s) => s.type === 'stale_todo')).toBe(true);
  });

  it('多类型同扫：一次产多种信号', () => {
    const code = 'export function f(){\n // TODO: x\n}';
    const sc = createCodeImprovementScanner({ fsReadFile: mkRead({ '/p/a.js': code }), projectRoot: '/p', hasTest: () => false });
    const r = sc.scan({ files: ['/p/a.js'], signalTypes: ['stale_todo', 'test_gap'] });
    expect(r.signals.some((s) => s.type === 'stale_todo')).toBe(true);
    expect(r.signals.some((s) => s.type === 'test_gap')).toBe(true);
  });

  it('protected 文件排除', () => {
    const sc = createCodeImprovementScanner({ fsReadFile: mkRead({ '/p/a.js': '// TODO: x' }), projectRoot: '/p', isProtected: () => true, hasTest: () => false });
    const r = sc.scan({ files: ['/p/a.js'], signalTypes: ['stale_todo'] });
    expect(r.signals.length).toBe(0);
    expect(r.dropped.protected).toBe(1);
  });

  it('解析失败 → fail-open(该文件 0 信号,复杂度/test_gap 跳过,但 TODO 正则仍可扫)', () => {
    // 语法错文件:acorn 失败 → high_complexity/test_gap 跳过(依赖 AST);stale_todo 走正则不依赖 AST
    const sc = createCodeImprovementScanner({ fsReadFile: mkRead({ '/p/bad.js': 'function ((( {\n // TODO: 修语法\n' }), projectRoot: '/p', hasTest: () => false });
    const r = sc.scan({ files: ['/p/bad.js'], signalTypes: ['stale_todo', 'high_complexity', 'test_gap'] });
    expect(r.signals.some((s) => s.type === 'stale_todo')).toBe(true); // 正则不崩
    expect(r.signals.some((s) => s.type === 'high_complexity')).toBe(false); // AST 失败跳过
  });

  it('读失败 → 该文件 0 信号不崩', () => {
    const sc = createCodeImprovementScanner({ fsReadFile: mkRead({}), projectRoot: '/p', hasTest: () => false });
    expect(sc.scan({ files: ['/p/missing.js'], signalTypes: ['stale_todo'] }).signals.length).toBe(0);
  });

  it('limit 截断', () => {
    const code = '// TODO: 1\n// TODO: 2\n// TODO: 3\n// TODO: 4';
    const sc = createCodeImprovementScanner({ fsReadFile: mkRead({ '/p/a.js': code }), projectRoot: '/p', hasTest: () => true });
    const r = sc.scan({ files: ['/p/a.js'], signalTypes: ['stale_todo'], limit: 2 });
    expect(r.signals.length).toBe(2);
  });

  it('priorityTypes：优先类型不被 limit 截没(根治 test_gap 排后文件被前面 high_complexity 占满 limit)', () => {
    // a/b 有测试只产 high_complexity；z 无测试产 test_gap(排在最后)。复刻生产:前面文件塞满 limit,test_gap 在后被截。
    const cx = 'export function big(a,b){ if(a){} if(b){} return a&&b; }'; // cx≈4
    const gap = 'export function foo(){}';
    const sc = createCodeImprovementScanner({
      fsReadFile: mkRead({ '/p/a.js': cx, '/p/b.js': cx, '/p/z.js': gap }),
      projectRoot: '/p', hasTest: (rel) => rel !== 'z.js', complexityThreshold: 2,
    });
    const files = ['/p/a.js', '/p/b.js', '/p/z.js'];
    // 不带 priorityTypes(零回归):逐文件 break,前两个 high_complexity 占满 limit=2,test_gap 被截没
    const noPri = sc.scan({ files, signalTypes: ['high_complexity', 'test_gap'], limit: 2 });
    expect(noPri.signals.some((s) => s.type === 'test_gap')).toBe(false);
    // 带 priorityTypes=['test_gap']:test_gap 优先,不被 high_complexity 挤掉 + 排第一
    const withPri = sc.scan({ files, signalTypes: ['high_complexity', 'test_gap'], limit: 2, priorityTypes: ['test_gap'] });
    expect(withPri.signals.some((s) => s.type === 'test_gap')).toBe(true);
    expect(withPri.signals[0].type).toBe('test_gap');
    expect(withPri.signals.length).toBe(2); // 仍尊重 limit
  });
});

describe('P4 产能：test_gap 可测性预筛', () => {
  const bigFile = `export function f() { return 1; }\n${'// pad\n'.repeat(450)}`;
  const heavyFile = "import express from 'express';\nexport function route() { return express; }\n";
  const cleanFile = 'export function pure(a, b) { return a + b; }\n';

  function scanWith(files) {
    const scanner = createCodeImprovementScanner({
      projectRoot: '/p',
      fsReadFile: (abs) => files[abs] ?? '',
      hasTest: () => false,
      isProtected: () => false,
    });
    return scanner.scan({ files: Object.keys(files), signalTypes: ['test_gap'], limit: 50 }).signals;
  }

  it('超大文件(>400 行)不产 test_gap 信号（M3 补不动，白立目标）', () => {
    const signals = scanWith({ '/p/src/big.js': bigFile, '/p/src/clean.js': cleanFile });
    expect(signals.map((s) => s.file)).toEqual(['src/clean.js']);
  });

  it('导入重运行时依赖(express/ws/electron 等)的文件不产 test_gap 信号（单测不可行）', () => {
    const signals = scanWith({ '/p/src/heavy.js': heavyFile, '/p/src/clean.js': cleanFile });
    expect(signals.map((s) => s.file)).toEqual(['src/clean.js']);
  });
});
