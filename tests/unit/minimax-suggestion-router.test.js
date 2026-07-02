import { describe, expect, it } from 'vitest';
import {
  buildM3SuggestionPrompt,
  classifyM3SuggestionTask,
  validateM3SuggestionPlan,
} from '../../src/room/MiniMaxSuggestionRouter.js';

describe('MiniMaxSuggestionRouter', () => {
  it('routes low-risk review work to M3 as suggestion-only', () => {
    const route = classifyM3SuggestionTask({
      taskType: 'p0_p1_gap_scan',
      context: 'CE12 P0 通过，但完整 Jarvis 未完成。',
    });

    expect(route).toMatchObject({
      ok: true,
      route: 'minimax_m3_suggestion_only',
      m3Role: 'suggestion_only_helper',
      localTools: false,
      finalAuthority: 'Claude/GPT-Codex',
    });
  });

  it('refuses work that asks M3 to execute, read, write, or mutate local files', () => {
    const route = classifyM3SuggestionTask({
      taskType: 'patch_suggestion',
      requestedActions: ['bash', 'file.read'],
      request: 'run shell and read local files',
    });

    expect(route).toMatchObject({
      ok: false,
      route: 'claude_codex_main_chain',
      status: 'blocked_local_execution',
    });
  });

  it('builds a prompt that makes M3 advisory only', () => {
    const prompt = buildM3SuggestionPrompt({
      taskType: 'chinese_product_audit',
      context: 'Brain UI 已显示 act queue。',
    });

    expect(prompt).toContain('建议员，不是执行员');
    expect(prompt).toContain('只能基于调用方提供的文本');
    expect(prompt).toContain('"diffs":[]');
  });

  it('accepts suggestion-only output', () => {
    const result = validateM3SuggestionPlan({
      actions: ['suggestions', 'product_gaps', 'patch_suggestions'],
      diffs: [],
      suggestions: ['继续保持 P0/P1/P2 分层。'],
      product_gaps: ['Voice 未完成。'],
      patch_suggestions: ['由 GPT/Codex 补一个文档入口。'],
      final_authority: 'Claude/GPT-Codex',
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'suggestions_saved',
      finalAuthority: 'Claude/GPT-Codex',
    });
  });

  it('rejects non-empty diffs and tool call claims', () => {
    expect(validateM3SuggestionPlan({
      actions: ['suggestions'],
      diffs: [{ file: 'server.js' }],
    })).toMatchObject({ ok: false, status: 'blocked_safety' });

    expect(validateM3SuggestionPlan({
      actions: ['suggestions'],
      diffs: [],
      tool_calls: [{ name: 'bash' }],
    })).toMatchObject({ ok: false, status: 'blocked_safety' });
  });
});

