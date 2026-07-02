// 完整新测试文件。覆盖 NoeBackgroundReviewHook（对话收尾接线）：
//   1) ON 端到端：注入假 chat 的真 NoeBackgroundReviewRunner + tmp root → afterConversation 后
//      listNoeProposalInbox 能查到 source=background_review 的 proposal（证「对话收尾→产 proposal→进 inbox」）。
//   2) OFF（enabled:false / runner 缺失）：runner.run 永不被调、inbox 仍空、返回 skipped（零触发零回归）。
//   3) proposal-only：写出的报告 directWrites=[] / applySupported=false / proposalOnly=true（无执行副作用）。
//   4) 对话过短：不触发 runner。
//   5) 错误隔离：chat 抛错时 afterConversation 不 throw、返回 ok:false（不破坏对话收尾主路径）。
// 确定性：不触网（chat 注入假实现）、now 显式注入、用 mkdtempSync 隔离 tmp，不依赖真实时钟/真实模型。
import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNoeBackgroundReviewHook } from '../../src/runtime/NoeBackgroundReviewHook.js';
import { NoeBackgroundReviewRunner } from '../../src/runtime/NoeBackgroundReview.js';
import { listNoeProposalInbox } from '../../src/runtime/NoeProposalInbox.js';

const LONG_CONVERSATION = [
  { role: 'user', content: '把我们这轮多模型协作的经验固化成技能，方便以后复用。'.repeat(6) },
  { role: 'assistant', content: '好的，我已经整理出可复用的要点和一条记忆候选。'.repeat(6) },
];

function proposeChat() {
  return async () => ({
    reply: JSON.stringify({
      decision: 'propose',
      memoryProposals: [{ text: '对话收尾后台复盘只产候选，不直接写长期记忆。' }],
      skillProposals: [{ name: 'council-replay' }],
      risks: [],
      confidence: 0.82,
    }),
  });
}

describe('NoeBackgroundReviewHook（对话收尾接线）', () => {
  it('ON：对话收尾触发 runner，产 proposal 落 inbox 目录并被 NoeProposalInbox 收到', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-bg-review-hook-on-'));
    try {
      const runner = new NoeBackgroundReviewRunner({
        root,
        now: () => '2026-06-14T00:00:00.000Z',
        chat: proposeChat(),
      });
      const hook = createNoeBackgroundReviewHook({ enabled: true, runner });
      expect(hook.enabled).toBe(true);

      const result = await hook.afterConversation({
        messages: LONG_CONVERSATION,
        context: { projectId: 'noe', reason: 'room_rotate', roomId: 'room-1' },
      });
      expect(result.ok).toBe(true);
      expect(result.triggered).toBe(true);
      expect(result.reportRef).toMatch(/^output\/noe-background-review\//);
      expect(existsSync(join(root, result.reportRef))).toBe(true);

      // 下游 inbox 自动收为 background_review 源（端到端：对话收尾 → proposal 进 inbox）
      const inbox = listNoeProposalInbox({ root, source: 'background_review' });
      expect(inbox.ok).toBe(true);
      expect(inbox.proposals.length).toBeGreaterThanOrEqual(1);
      expect(inbox.proposals.every((p) => p.source === 'background_review')).toBe(true);
      // proposal-only：进 inbox 的提案均为待审批、不可直接 apply
      expect(inbox.proposals.every((p) => p.proposalOnly === true && p.applySupported === false)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('proposal-only：写出的报告无任何直接执行副作用（directWrites=[] / applySupported=false）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-bg-review-hook-proposalonly-'));
    try {
      const runner = new NoeBackgroundReviewRunner({ root, now: () => '2026-06-14T00:00:00.000Z', chat: proposeChat() });
      const hook = createNoeBackgroundReviewHook({ enabled: true, runner });
      const result = await hook.afterConversation({ messages: LONG_CONVERSATION });
      const report = JSON.parse(readFileSync(join(root, result.reportRef), 'utf8'));
      expect(report.proposalOnly).toBe(true);
      expect(report.applySupported).toBe(false);
      expect(report.directWrites).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('OFF（enabled:false）：runner.run 永不被调、inbox 仍空、返回 skipped（零回归）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-bg-review-hook-off-'));
    try {
      const run = vi.fn();
      const hook = createNoeBackgroundReviewHook({ enabled: false, runner: { run } });
      expect(hook.enabled).toBe(false);

      const result = await hook.afterConversation({ messages: LONG_CONVERSATION });
      expect(result).toMatchObject({ ok: true, skipped: true, reason: 'background_review_off' });
      expect(run).not.toHaveBeenCalled();

      const inbox = listNoeProposalInbox({ root, source: 'background_review' });
      expect(inbox.proposals).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('OFF（runner 缺失）：hook.enabled=false 且 afterConversation no-op', async () => {
    const hook = createNoeBackgroundReviewHook({ enabled: true, runner: null });
    expect(hook.enabled).toBe(false);
    const result = await hook.afterConversation({ messages: LONG_CONVERSATION });
    expect(result).toMatchObject({ ok: true, skipped: true, reason: 'background_review_off' });
  });

  it('对话过短：不触发 runner（避免无意义复盘）', async () => {
    const run = vi.fn();
    const hook = createNoeBackgroundReviewHook({ enabled: true, runner: { run } });
    const result = await hook.afterConversation({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result).toMatchObject({ ok: true, skipped: true, reason: 'background_review_conversation_too_short' });
    expect(run).not.toHaveBeenCalled();
  });

  it('错误隔离：chat/runner 抛错时 afterConversation 不 throw、返回 ok:false（不破坏对话收尾）', async () => {
    const hook = createNoeBackgroundReviewHook({
      enabled: true,
      runner: { run: async () => { throw new Error('brain_unavailable'); } },
    });
    await expect(hook.afterConversation({ messages: LONG_CONVERSATION })).resolves.toMatchObject({
      ok: false,
      error: 'brain_unavailable',
    });
  });
});
