// @ts-check
import { describe, expect, it } from 'vitest';
import { createNoeFreedomReviewBrain } from '../../src/runtime/NoeFreedomReviewBrain.js';
import { NOE_REVIEW_BRAIN_MODEL } from '../../src/model/NoeLocalModelPolicy.js';

function preflight() {
  return {
    request: {
      model: NOE_REVIEW_BRAIN_MODEL,
      system: 'review brain system',
      user: { actionId: 'noe.freedom.file.write', operation: 'file.write', riskLevel: 'high' },
      temperature: 0.2,
      max_tokens: 4096,
    },
  };
}

describe('NoeFreedomReviewBrain', () => {
  it('calls the local review brain and passes through its verdict reply', async () => {
    const calls = [];
    const getAdapter = (id) => ({
      async chat(messages, opts) {
        calls.push({ id, messages, opts });
        return { reply: JSON.stringify({ verdict: 'approve', blockers: [], confidence: 0.9 }) };
      },
    });
    const reviewBrain = createNoeFreedomReviewBrain({ getAdapter });
    const out = await reviewBrain(preflight());

    expect(out.reply).toContain('"verdict":"approve"');
    // 第一档（lmstudio）就命中，用的是本地复核脑 model，绝不上云。
    expect(calls[0].id).toBe('lmstudio');
    expect(calls[0].opts.model).toBe(NOE_REVIEW_BRAIN_MODEL);
    expect(calls[0].messages[0]).toMatchObject({ role: 'system' });
    expect(calls[0].messages[1].content).toContain('noe.freedom.file.write');
  });

  it('passes through a block verdict unchanged (real review can block)', async () => {
    const getAdapter = () => ({
      async chat() {
        return { reply: JSON.stringify({ verdict: 'block', blockers: ['missing_rollback'] }) };
      },
    });
    const reviewBrain = createNoeFreedomReviewBrain({ getAdapter });
    const out = await reviewBrain(preflight());
    expect(out.reply).toContain('"verdict":"block"');
  });

  it('never routes to a cloud adapter — only the local chain is consulted', async () => {
    const consulted = [];
    const getAdapter = (id) => {
      consulted.push(id);
      // 全都没 chat 能力 → 视为不可用，但记录被问到了哪些 adapter。
      return null;
    };
    const reviewBrain = createNoeFreedomReviewBrain({ getAdapter });
    await reviewBrain(preflight());
    // 只问本地档（lmstudio/ollama），绝不出现 claude/minimax/codex 等云档。
    expect(consulted).toEqual(['lmstudio', 'ollama']);
    expect(consulted).not.toContain('claude');
  });

  it('fail-open degrades to approve when the local review brain is unavailable (owner freedom constitution)', async () => {
    const reviewBrain = createNoeFreedomReviewBrain({ getAdapter: () => null });
    const out = await reviewBrain(preflight());

    // 默认 fail-open：放行但显式带 degraded 标记，绝不静默伪装成正常 approve。
    expect(out.verdict).toBe('approve');
    expect(out.degraded).toBe(true);
    expect(out.risks).toContain('review_brain_unavailable_degraded_open');
  });

  it('falls through the chain when the first adapter throws, still degrades open if all fail', async () => {
    const getAdapter = (id) => ({
      async chat() { throw new Error(`${id} down`); },
    });
    const reviewBrain = createNoeFreedomReviewBrain({ getAdapter });
    const out = await reviewBrain(preflight());
    expect(out.verdict).toBe('approve');
    expect(out.degraded).toBe(true);
  });

  it('uses the second adapter (ollama) when the first (lmstudio) is missing', async () => {
    const getAdapter = (id) => (id === 'ollama'
      ? { async chat() { return { reply: JSON.stringify({ verdict: 'revise', blockers: ['needs_evidence'] }) }; } }
      : null);
    const reviewBrain = createNoeFreedomReviewBrain({ getAdapter });
    const out = await reviewBrain(preflight());
    expect(out.reply).toContain('"verdict":"revise"');
  });

  it('fail-closed mode throws when the local review brain is unavailable (so executor blocks)', async () => {
    const reviewBrain = createNoeFreedomReviewBrain({ getAdapter: () => null, failClosed: true });
    await expect(reviewBrain(preflight())).rejects.toThrow(/review_brain_unavailable/);
  });
});
