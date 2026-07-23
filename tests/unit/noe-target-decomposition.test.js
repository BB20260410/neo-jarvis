import { describe, it, expect } from 'vitest';
import { shouldDecompose, buildDecompositionInstruction } from '../../src/loop/NoeTargetDecomposition.js';

// 阶段二·难目标分解:大改动一把梭会让本地模型编造 from(2B re-ask 治标未治本)。
// 根治=对复杂目标约束模型「只做最小的第一步」——小改动=小 from=能逐字复制。纯函数 gate + 指令,TDD。

describe('shouldDecompose（判目标是否复杂到该分解）', () => {
  it('文件长(超阈值) → 该分解', () => {
    const longFile = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n');
    expect(shouldDecompose({ objective: '重构 X', fileContent: longFile, maxLines: 60 }).decompose).toBe(true);
  });

  it('目标含多个改动子句(并/且/、/and) → 该分解', () => {
    expect(shouldDecompose({ objective: '加参数校验并且抽出常量还要补测试', fileContent: 'short' }).decompose).toBe(true);
    expect(shouldDecompose({ objective: 'add validation and extract constant and add test', fileContent: 'short' }).decompose).toBe(true);
  });

  it('短文件 + 单一目标 → 不分解(零成本直做)', () => {
    expect(shouldDecompose({ objective: '给 clamp 补 JSDoc', fileContent: 'export function clamp(){}' }).decompose).toBe(false);
  });

  it('空/非法 → 不分解(fail-open)', () => {
    expect(shouldDecompose({}).decompose).toBe(false);
    expect(shouldDecompose().decompose).toBe(false);
  });
});

describe('buildDecompositionInstruction（约束只做最小第一步的指令）', () => {
  it('生成含「最小第一步/单一/verbatim」约束的指令段', () => {
    const ins = buildDecompositionInstruction('重构大函数');
    expect(ins).toContain('最小');
    expect(ins.length).toBeGreaterThan(20);
  });
});
