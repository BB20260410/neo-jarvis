import { describe, expect, it } from 'vitest';
import {
  NoeBackgroundReviewRunner,
  buildBackgroundReviewMessages,
  runBackgroundReview,
  shouldRunBackgroundReview,
  validateBackgroundReviewToolCalls,
} from '../../src/runtime/NoeBackgroundReview.js';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('NoeBackgroundReview', () => {
  it('skips low-signal conversations', () => {
    expect(shouldRunBackgroundReview([{ role: 'user', content: 'hi' }])).toBe(false);
  });

  it('builds proposal-only prompts with redacted recent messages', () => {
    const messages = buildBackgroundReviewMessages([
      { role: 'user', content: 'XIAOMI_API_KEY=tp-unit-test-redaction-key-00000000000000000000' },
      { role: 'assistant', content: 'done' },
    ], { projectId: 'noe' });

    expect(messages[0].content).toContain('只能提出 proposal');
    expect(messages[1].content).not.toContain('tp-unit-test-redaction-key');
    expect(messages[1].content).toContain('requiresConsensusBeforeWrite');
    expect(messages[1].content).toContain('memory_candidate');
  });

  it('turns model output into write-gated proposals', async () => {
    const result = await runBackgroundReview({
      messages: [
        { role: 'user', content: '请把这个多模型经验固化成技能。'.repeat(10) },
        { role: 'assistant', content: '已经完成并总结。'.repeat(10) },
      ],
      chat: async () => ({ reply: JSON.stringify({ decision: 'propose', memoryProposals: [{ text: 'remember this' }], skillProposals: [{ name: 'council' }], risks: [], confidence: 0.8 }) }),
      now: () => '2026-06-07T00:00:00.000Z',
    });

    expect(result.ok).toBe(true);
    expect(result.proposals).toHaveLength(2);
    expect(result.proposals.every((item) => item.proposalOnly && item.requiresConsensusBeforeWrite)).toBe(true);
    expect(result.proposals.map((item) => item.tool)).toEqual(['memory_candidate', 'skill_draft']);
  });

  it('parses proposal JSON from think blocks, fences, and surrounding prose', async () => {
    const result = await runBackgroundReview({
      messages: [
        { role: 'user', content: '请把这个后台复盘经验固化。'.repeat(10) },
        { role: 'assistant', content: '我已经整理成候选。'.repeat(10) },
      ],
      chat: async () => ({
        reply: [
          '<think>这里的推理不能进入持久化候选。</think>',
          '先说明一下：',
          '```json',
          '{"decision":"propose","memoryProposals":[{"text":"后台复盘只写候选，不直接写长期记忆。"}],"skillProposals":[],"risks":["note with brace } in text"],"confidence":0.82}',
          '```',
          '结束。',
        ].join('\n'),
      }),
      now: () => '2026-06-13T00:00:00.000Z',
    });

    expect(result.ok).toBe(true);
    expect(result.decision).toBe('propose');
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].item.text).toBe('后台复盘只写候选，不直接写长期记忆。');
    expect(result.risks).toEqual(['note with brace } in text']);
  });

  it('denies non-whitelisted background tools before parsing proposals', async () => {
    const validation = validateBackgroundReviewToolCalls({
      toolCalls: [{ function: { name: 'terminal' } }, { function: { name: 'memory_candidate' } }],
    });
    expect(validation).toMatchObject({ ok: false, deniedTools: ['terminal'] });

    const result = await runBackgroundReview({
      messages: [
        { role: 'user', content: '请把这个工作流固化。'.repeat(10) },
        { role: 'assistant', content: '已经总结出候选。'.repeat(10) },
      ],
      chat: async () => ({
        toolCalls: [{ function: { name: 'terminal' } }],
        reply: JSON.stringify({ decision: 'propose', memoryProposals: [{ text: 'x' }], confidence: 0.9 }),
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'background_review_denied_non_whitelisted_tool',
      deniedTools: ['terminal'],
      proposals: [],
    });
  });

  it('persists proposal reports only under output/noe-background-review', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-background-review-'));
    try {
      const runner = new NoeBackgroundReviewRunner({
        root,
        now: () => '2026-06-13T00:00:00.000Z',
        chat: async () => ({ reply: JSON.stringify({ decision: 'propose', memoryProposals: [{ text: 'remember' }], skillProposals: [{ name: 'review' }], actionProposals: [{ title: 'audit' }], confidence: 0.8 }) }),
      });

      const result = await runner.run({
        messages: [
          { role: 'user', content: '这个经验以后要复用。'.repeat(10) },
          { role: 'assistant', content: '已形成候选复盘。'.repeat(10) },
        ],
        context: { evidenceRefs: ['output/noe-missions/x/artifacts/report.json'] },
      });
      const reportPath = join(root, result.reportRef);
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));

      expect(result.ok).toBe(true);
      expect(result.reportRef).toMatch(/^output\/noe-background-review\//);
      expect(existsSync(reportPath)).toBe(true);
      expect(report.proposalOnly).toBe(true);
      expect(report.directWrites).toEqual([]);
      expect(report.proposals.map((item) => item.tool)).toEqual(['memory_candidate', 'skill_draft', 'review_report']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects report output paths outside the background review boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-background-review-escape-'));
    try {
      expect(() => new NoeBackgroundReviewRunner({ root, outputDir: 'output/elsewhere', chat: async () => ({ reply: '{}' }) }))
        .toThrow(/background_review_output_dir_must_be_under_output_noe_background_review/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
