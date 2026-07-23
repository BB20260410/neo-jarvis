import { describe, it, expect } from 'vitest';
import { buildKgReasoningContext } from '../../src/memory/NoeKgReasoning.js';

// 阶段二·让自我记忆图谱真正参与推理:implement/direction 前用目标查 KG 相关实体+一跳邻居,
// 格式化成推理上下文注入——让模型带着"图谱里关于这个模块的已知知识/关联"去改,不是孤立看文件。
// 纯函数(search/oneHop 注入),fail-open。

describe('buildKgReasoningContext', () => {
  it('查到相关实体+邻居 → 格式化成上下文', () => {
    const search = () => [{ id: 'e1', name: 'MemoryCore', description: '三层记忆核心' }];
    const oneHop = () => [{ id: 'e2', name: 'KnowledgeStore' }, { id: 'e3', name: 'recallFused' }];
    const ctx = buildKgReasoningContext({ query: 'MemoryCore', search, oneHop });
    expect(ctx).toContain('MemoryCore');
    expect(ctx).toContain('三层记忆核心');
    expect(ctx).toContain('KnowledgeStore'); // 邻居进上下文
    expect(ctx).toContain('关联');
  });

  it('无查询 / search 未注入 → 空串(不注入垃圾)', () => {
    expect(buildKgReasoningContext({ query: '', search: () => [] })).toBe('');
    expect(buildKgReasoningContext({ query: 'x' })).toBe('');
  });

  it('查不到实体 → 空串', () => {
    expect(buildKgReasoningContext({ query: 'x', search: () => [] })).toBe('');
  });

  it('search/oneHop 抛错 → fail-open 空串(绝不阻断 implement)', () => {
    expect(buildKgReasoningContext({ query: 'x', search: () => { throw new Error('db'); } })).toBe('');
    const search = () => [{ id: 'e1', name: 'A' }];
    const ctx = buildKgReasoningContext({ query: 'x', search, oneHop: () => { throw new Error('hop'); } });
    expect(ctx).toContain('A'); // 邻居失败不影响实体本身
  });

  it('限流:最多 maxEntities 实体、maxNeighbors 邻居(不撑爆 prompt)', () => {
    const search = () => Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, name: `E${i}` }));
    const oneHop = () => Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, name: `N${i}` }));
    const ctx = buildKgReasoningContext({ query: 'x', search, oneHop, maxEntities: 2, maxNeighbors: 3 });
    expect(ctx).toContain('E0'); expect(ctx).toContain('E1');
    expect(ctx).not.toContain('E2'); // 超 maxEntities 被截
    expect(ctx).not.toContain('N3'); // 超 maxNeighbors 被截
  });
});
