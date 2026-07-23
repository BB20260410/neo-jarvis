// @ts-check
// 主动澄清/求助（codex 建议·NOE_CLARIFY_PROPOSAL / clarifyEnabled）：后台复盘发现"证据不足/意图歧义/权限缺"
// 时产可审计 clarification 提案而非继续猜——强化"知道自己不知道"。clarification 不可物化(tool='')、proposalOnly。
// 确定性：注入 chat stub + 显式 now，不触网/不依赖真实时钟。
import { describe, expect, it } from 'vitest';
import { runBackgroundReview } from '../../src/runtime/NoeBackgroundReview.js';

const MSGS = [
  { role: 'user', content: '帮我弄那个项目，你看着办。'.repeat(8) },
  { role: 'assistant', content: '我理解了大概方向。'.repeat(8) },
];

describe('NoeBackgroundReview 主动澄清（clarifyEnabled）', () => {
  it('ON：chat 返 clarifications → 产 kind=clarification 提案（tool 空、proposalOnly、归 owner_intent_ambiguous）', async () => {
    const result = await runBackgroundReview({
      messages: MSGS,
      chat: async () => ({ reply: JSON.stringify({ decision: 'propose', clarifications: [{ question: '你指的是哪个项目？' }], confidence: 0.5 }) }),
      clarifyEnabled: true,
      now: () => '2026-06-14T00:00:00.000Z',
    });
    const clar = result.proposals.find((p) => p.kind === 'clarification');
    expect(clar).toBeTruthy();
    expect(clar.tool).toBe('');                 // proposalTool('clarification')='' → 不可物化
    expect(clar.proposalOnly).toBe(true);
    expect(clar.item.question).toContain('哪个项目');
    expect(clar.item.category).toBe('owner_intent_ambiguous');
  });

  it('OFF（默认 clarifyEnabled=false）：chat 返 clarifications 也不产澄清、其余提案正常（零回归）', async () => {
    const result = await runBackgroundReview({
      messages: MSGS,
      chat: async () => ({ reply: JSON.stringify({ decision: 'propose', clarifications: [{ question: 'x' }], memoryProposals: [{ text: 'remember this' }], confidence: 0.5 }) }),
      now: () => '2026-06-14T00:00:00.000Z',
    });
    expect(result.proposals.some((p) => p.kind === 'clarification')).toBe(false);
    expect(result.proposals.some((p) => p.kind === 'memory')).toBe(true);
  });
});
