import { describe, it, expect } from 'vitest';
import { findFuzzyMatch } from '../../src/runtime/mission/NoeFuzzyPatchMatcher.js';

const FILE = `function a() {
  const x = 1;
  return x + 2;
}

function b() {
  const y = 10;
  doStuff(y);
  return y;
}
`;

describe('findFuzzyMatch（P4-4 内容相似度容漂移）', () => {
  it('行号漂移（同内容移位）→ 高相似命中', () => {
    // from 是 b() 的块（在文件后半，行号"漂移"了），内容一致
    const from = `function b() {
  const y = 10;
  doStuff(y);
  return y;
}`;
    const r = findFuzzyMatch(FILE, from, { minSimilarity: 0.9 });
    expect(r.matched).toBe(true);
    expect(r.similarity).toBeGreaterThanOrEqual(0.9);
    expect(r.block).toContain('doStuff(y)');
  });

  it('极小编辑（一行微改）→ 仍高相似命中', () => {
    const from = `function a() {
  const x = 1;
  return x + 3;
}`; // return x+3 vs 文件里 x+2，一行不同
    const r = findFuzzyMatch(FILE, from, { minSimilarity: 0.7 });
    expect(r.matched).toBe(true);
    expect(r.block).toContain('const x = 1');
  });

  it('相似度低于阈值 → 拒（below_threshold）', () => {
    const r = findFuzzyMatch(FILE, 'function totallyDifferent() {\n  unrelated();\n  nope();\n}', { minSimilarity: 0.9 });
    expect(r.matched).toBe(false);
    expect(r.reason).toBe('below_threshold');
  });

  it('多个等相似不相干块 → 拒（ambiguous，防改错地方）', () => {
    const dup = `repeat() {
  step();
}
filler1();
repeat() {
  step();
}`;
    const r = findFuzzyMatch(dup, 'repeat() {\n  step();\n}', { minSimilarity: 0.8 });
    expect(r.matched).toBe(false);
    expect(r.reason).toBe('ambiguous_multiple_matches');
  });

  it('空 from / 空内容 / 超大文件 → 安全拒', () => {
    expect(findFuzzyMatch(FILE, '   ').matched).toBe(false);
    expect(findFuzzyMatch('', 'x').matched).toBe(false);
    expect(findFuzzyMatch('a\n'.repeat(30000), 'a', { maxFileLines: 20000 }).reason).toBe('file_too_large');
  });

  it('唯一精确块 → 命中且非歧义', () => {
    const r = findFuzzyMatch(FILE, '  const y = 10;\n  doStuff(y);', { minSimilarity: 0.9 });
    expect(r.matched).toBe(true);
    expect(r.reason).toBe('fuzzy_matched');
  });
});
