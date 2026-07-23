import { describe, expect, it } from 'vitest';
import {
  buildM3ColdReviewInput,
  buildStageSuggestionInput,
  checkpointForColdReview,
  checkpointForStage,
  createM3SuggestionTask,
  runM3SuggestionTask,
} from '../../src/room/MiniMaxSuggestionPipeline.js';
import { MiniMaxChatAdapter } from '../../src/room/MiniMaxChatAdapter.js';
import { breakers } from '../../src/safety/CircuitBreaker.js';

function validPlan() {
  return JSON.stringify({
    actions: ['suggestions'],
    diffs: [],
    suggestions: ['继续保留 stage_status/product_status 双口径。'],
    risk_notes: [],
    product_gaps: [],
    evidence_gaps: [],
    patch_suggestions: [],
    do_not_block_reason: '建议不阻塞主链。',
    final_authority: 'Claude/GPT-Codex',
  });
}

describe('MiniMaxSuggestionPipeline', () => {
  it('maps high-value CE stages to M3 suggestion checkpoints', () => {
    expect(checkpointForStage('CE03')).toMatchObject({ taskType: 'p0_p1_gap_scan' });
    expect(checkpointForStage('CE08')).toMatchObject({ taskType: 'chinese_product_audit' });
    expect(buildStageSuggestionInput('CE10', '验收上下文')).toMatchObject({
      taskType: 'p0_p1_gap_scan',
      context: '验收上下文',
    });
  });

  it('builds fixed cold-review checkpoint inputs for search, voice, identity, and execution', () => {
    expect(checkpointForColdReview('search')).toMatchObject({ taskType: 'chinese_product_audit' });
    expect(checkpointForColdReview('voice')).toMatchObject({ label: '语音交互冷审查' });
    expect(checkpointForColdReview('identity')).toMatchObject({ taskType: 'evidence_review' });
    expect(checkpointForColdReview('execution')).toMatchObject({ taskType: 'evidence_review' });
    const input = buildM3ColdReviewInput('search', 'spokenReply 不应包含 URL');
    expect(input).toMatchObject({ taskType: 'chinese_product_audit', reviewArea: 'search' });
    expect(input.context).toContain('TTS 不读 URL/HTML/img/src/href');
    expect(input.context).toContain('不读取本地文件');
  });

  it('creates API-only suggestion tasks with Claude/GPT final authority', () => {
    const task = createM3SuggestionTask({
      taskType: 'evidence_review',
      context: 'verify:p0 7/7 pass',
    });

    expect(task.route).toMatchObject({
      ok: true,
      route: 'minimax_m3_suggestion_only',
      localTools: false,
    });
    expect(task.finalAuthority).toBe('Claude/GPT-Codex');
    expect(task.prompt).toContain('建议员，不是执行员');
  });

  it('runs a suggestion task through a caller-provided runner', async () => {
    const result = await runM3SuggestionTask({
      taskType: 'retrospective',
      context: '阶段完成不等于产品完成。',
    }, {
      runner: async () => validPlan(),
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'suggestions_saved',
      finalAuthority: 'Claude/GPT-Codex',
    });
  });

  it('refuses local execution tasks before calling M3', async () => {
    const result = await runM3SuggestionTask({
      taskType: 'patch_suggestion',
      requestedActions: ['shell.exec'],
      context: '请运行命令。',
    }, {
      runner: async () => {
        throw new Error('runner should not be called');
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked_local_execution',
    });
  });

  it('uses MiniMax M3 OpenAI-compatible request parameters', async () => {
    const oldFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, req) => {
      calls.push({ url, headers: req.headers, body: JSON.parse(req.body) });
      return new Response(JSON.stringify({
        choices: [{ message: { content: validPlan() } }],
        usage: { prompt_tokens: 3, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
      const adapter = new MiniMaxChatAdapter({ apiKey: 'test-key', maxCompletionTokens: 123 });
      const result = await adapter._doChat([{ role: 'user', content: '请审计。' }], { noAbort: true });
      expect(result.tokensOut).toBe(5);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://api.minimax.chat/v1/chat/completions');
      expect(calls[0].headers.Authorization).toBe('Bearer test-key');
      expect(calls[0].body).toMatchObject({
        model: 'MiniMax-M3',
        max_completion_tokens: 123,
        reasoning_split: true,
      });
      expect(calls[0].body.max_tokens).toBeUndefined();
      expect(calls[0].body.thinking).toBeUndefined();
      await adapter._doChat([{ role: 'user', content: '快速回复。' }], { noAbort: true, thinkingMode: 'disabled' });
      expect(calls[1].body.thinking).toEqual({ type: 'disabled' });
      await adapter._doChat([{ role: 'user', content: '极速回复。' }], { noAbort: true, model: 'MiniMax-M2.7-highspeed', thinkingMode: 'disabled' });
      expect(calls[2].body.model).toBe('MiniMax-M2.7-highspeed');
      expect(calls[2].body.thinking).toBeUndefined();
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it('does not set a default MiniMax model timeout', () => {
    const adapter = new MiniMaxChatAdapter({ apiKey: 'test-key' });
    expect(adapter.timeout).toBe(0);
  });

  it('does not open the minimax circuit for input-sensitive 422 errors', async () => {
    const oldFetch = globalThis.fetch;
    breakers.reset('minimax');
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls <= 6) {
        return new Response(JSON.stringify({
          type: 'error',
          error: { type: 'unprocessable_entity_error', message: 'input new_sensitive (1026)' },
        }), { status: 422, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '可用' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
      const adapter = new MiniMaxChatAdapter({ apiKey: 'test-key' });
      for (let i = 0; i < 6; i++) {
        await expect(adapter.chat([{ role: 'user', content: 'x' }], { noAbort: true, skipBudget: true }))
          .rejects.toMatchObject({ code: 'PROVIDER_INPUT_REJECTED' });
      }
      const ok = await adapter.chat([{ role: 'user', content: 'safe' }], { noAbort: true, skipBudget: true });
      expect(ok.reply).toBe('可用');
      expect(calls).toBe(7);
    } finally {
      globalThis.fetch = oldFetch;
      breakers.reset('minimax');
    }
  });

  it('passes noAbort to the default M3 suggestion adapter call', async () => {
    let seenOpts = null;
    const result = await runM3SuggestionTask({
      taskType: 'evidence_review',
      context: 'verify:p0 60/60 pass',
    }, {
      apiKey: 'test-key',
      adapter: { _doChat: async (_messages, opts) => { seenOpts = opts; return { reply: validPlan() }; } },
    });

    expect(result.ok).toBe(true);
    expect(seenOpts).toMatchObject({
      model: 'MiniMax-M3',
      noAbort: true,
      reasoningSplit: true,
    });
  });

  it('resolves the M3 API key through the persistent provider secret resolver when env is absent', async () => {
    let resolverCalled = false;
    let seenOpts = null;
    const result = await runM3SuggestionTask({
      taskType: 'evidence_review',
      context: 'verify:p0 key resolver pass',
    }, {
      secretResolver: (provider) => {
        resolverCalled = provider === 'minimax';
        return { ok: true, value: 'keychain-m3-key', source: 'keychain', sourceRef: 'MINIMAX_API_KEY' };
      },
      adapter: { _doChat: async (_messages, opts) => { seenOpts = opts; return { reply: validPlan() }; } },
    });

    expect(result.ok).toBe(true);
    expect(resolverCalled).toBe(true);
    expect(seenOpts).toMatchObject({ model: 'MiniMax-M3', noAbort: true });
    expect(JSON.stringify(result)).not.toContain('keychain-m3-key');
  });
});
