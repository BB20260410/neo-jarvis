import { describe, expect, it } from 'vitest';
import {
  compactTrajectory,
  estimateMessageTokens,
  shouldCompactTrajectory,
} from '../../src/context/NoeTrajectoryCompactor.js';

describe('estimateMessageTokens / shouldCompactTrajectory', () => {
  it('约 4 字符 1 token，超预算判压缩', () => {
    expect(estimateMessageTokens([{ content: 'a'.repeat(40000) }])).toBe(10000);
    expect(shouldCompactTrajectory([{ content: 'a'.repeat(40000) }], { budgetTokens: 8000 })).toBe(true);
    expect(shouldCompactTrajectory([{ content: 'short' }], { budgetTokens: 8000 })).toBe(false);
  });
});

describe('compactTrajectory', () => {
  it('短轨迹不压缩', async () => {
    const r = await compactTrajectory([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], { keepRecent: 6 });
    expect(r.compacted).toBe(false);
    expect(r.messages).toHaveLength(2);
  });

  it('长轨迹压缩：早期合并为摘要，尾部高保真保留', async () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `msg${i}` }));
    const r = await compactTrajectory(msgs, { keepRecent: 3 });
    expect(r.compacted).toBe(true);
    expect(r.compactedCount).toBe(7);
    expect(r.messages).toHaveLength(4); // 1 摘要 + 3 尾部
    expect(r.messages[0].compacted).toBe(true);
    expect(r.messages[0].role).toBe('system');
    expect(r.messages[3].content).toBe('msg9'); // 尾部最新保留
  });

  it('注入 summarize 用其结果', async () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    const r = await compactTrajectory(msgs, { keepRecent: 2, summarize: async (early) => `摘要${early.length}条` });
    expect(r.messages[0].content).toContain('摘要8条');
  });

  it('summarize 抛错时降级为确定性摘要（含早期内容）', async () => {
    const msgs = Array.from({ length: 8 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    const r = await compactTrajectory(msgs, { keepRecent: 2, summarize: () => { throw new Error('llm down'); } });
    expect(r.compacted).toBe(true);
    expect(r.messages[0].content).toContain('m0');
  });
});
