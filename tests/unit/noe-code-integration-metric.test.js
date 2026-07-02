import { describe, it, expect } from 'vitest';
import {
  extractImports,
  cyclomaticComplexity,
  buildCouplingGraph,
  computeCodeIntegration,
} from '../../src/cognition/NoeCodeIntegrationMetric.js';

describe('extractImports', () => {
  it('解析 import / require / 动态 import', () => {
    const src = `
      import { a } from './A.js';
      import B from "../b/B.js";
      const c = require('./C.js');
      const d = await import('./D.js');
      import './side-effect.js';
    `;
    const imps = extractImports(src);
    expect(imps).toContain('./A.js');
    expect(imps).toContain('../b/B.js');
    expect(imps).toContain('./C.js');
    expect(imps).toContain('./D.js');
    expect(imps).toContain('./side-effect.js');
  });
  it('红队修复：恶意输入不 ReDoS（import + 5万空白 <50ms）', () => {
    const evil = `import ${' '.repeat(50000)}`;
    const t0 = Date.now();
    extractImports(evil);
    expect(Date.now() - t0).toBeLessThan(50);
    // 藏在注释/字符串里同样不挂
    const t1 = Date.now();
    extractImports(`/* import ${' '.repeat(50000)} */`);
    extractImports(`const s = "import ${' '.repeat(50000)}"`);
    expect(Date.now() - t1).toBeLessThan(50);
  });
  it('动态/多行 import 仍正确解析（4 分支重写不丢功能）', () => {
    expect(extractImports("import {\n  a, b,\n} from './multi.js';")).toContain('./multi.js');
    expect(extractImports("import * as ns from './ns.js';")).toContain('./ns.js');
    expect(extractImports("export { x } from './reexport.js';")).toContain('./reexport.js');
  });
});

describe('cyclomaticComplexity', () => {
  it('判定点 + 1；注释/字符串不误计', () => {
    const simple = 'export function f(){ return 1; }';
    expect(cyclomaticComplexity(simple)).toBe(1);
    const branchy = `
      function g(x){
        if (x) return 1;          // +1
        for (let i=0;i<x;i++){}    // +1
        return x && x>0 ? 2 : 3;   // && +1, ternary +1
      }
    `;
    expect(cyclomaticComplexity(branchy)).toBe(5); // 1 base + if + for + && + ternary
  });
  it('注释/字符串里的关键字不计', () => {
    const tricky = `
      // if for while case
      const s = "if (a && b) for while";
      const t = \`case catch ?? \`;
      function h(){ return 1; }
    `;
    expect(cyclomaticComplexity(tricky)).toBe(1);
  });
});

describe('buildCouplingGraph', () => {
  it('仅统计 set 内互相 import，算 fanIn/fanOut/density', () => {
    const files = {
      'A.js': "import './B.js'; import './C.js';",
      'B.js': "import './C.js';",
      'C.js': '// no imports',
      'D.js': "import 'node:fs';", // 外部依赖不算
    };
    const g = buildCouplingGraph(files);
    expect(g.nodes.length).toBe(4);
    expect(g.edges.length).toBe(3); // A->B, A->C, B->C
    expect(g.fanOut['A.js']).toBe(2);
    expect(g.fanIn['C.js']).toBe(2);
    expect(g.fanOut['D.js']).toBe(0); // node:fs 不在 set
    expect(g.density).toBeCloseTo(3 / (4 * 3), 4);
  });
  it('自环与重复 import 不重复计边', () => {
    const files = { 'A.js': "import './A.js'; import './B.js'; import './B.js';", 'B.js': '' };
    const g = buildCouplingGraph(files);
    expect(g.edges.length).toBe(1); // 只 A->B 一次，自环 A->A 不算
  });
});

describe('computeCodeIntegration', () => {
  it('空输入 → ok:false', () => {
    expect(computeCodeIntegration({}).ok).toBe(false);
  });
  it('综合报告：耦合 + 复杂度，可复算（同输入同输出）', () => {
    const files = {
      'GWT.js': "import './Memory.js'; export function f(x){ if(x) return 1; return 2; }",
      'Memory.js': "import './Trigger.js'; export function g(x){ return x && x>0 ? 1 : 0; }",
      'Trigger.js': 'export function h(){ return 1; }',
    };
    const r1 = computeCodeIntegration(files);
    const r2 = computeCodeIntegration(files);
    expect(r1).toEqual(r2); // 确定性可复算
    expect(r1.ok).toBe(true);
    expect(r1.moduleCount).toBe(3);
    expect(r1.coupling.edgeCount).toBe(2); // GWT->Memory, Memory->Trigger
    expect(r1.complexity.byModule['GWT.js']).toBe(2); // base1 + if
    expect(r1.complexity.max).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(r1.coupling.topHubs)).toBe(true);
    expect(Array.isArray(r1.complexity.hottest)).toBe(true);
  });
});
