import { describe, expect, it } from 'vitest';
import {
  MiniMaxSpawnAdapter,
  extractSessionId,
  normalizeSessionDiffs,
  proposalFromMessagesOutput,
  validatePatchOnlyPlan,
} from '../../src/room/MiniMaxSpawnAdapter.js';

describe('MiniMaxSpawnAdapter patch-only guard', () => {
  it('accepts patch-only plans only when diffs is empty', () => {
    const result = validatePatchOnlyPlan({
      actions: ['session_new', 'messages', 'diff'],
      diffs: [],
      proposal: '建议在代码阶段由 Codex 修改，MiniMax 只做中文审计。',
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'proposal_saved',
      diffs: [],
    });
  });

  it('blocks non-empty diffs in CE12 P0', () => {
    const result = validatePatchOnlyPlan({
      actions: ['session_new', 'messages', 'diff'],
      diffs: [{ file: 'server.js', patch: '--- a/server.js' }],
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked_safety',
    });
    expect(result.error).toContain('diffs=[]');
  });

  it('blocks shell/read/write/delete/move/apply_patch/tool_calls actions', () => {
    for (const action of ['shell.exec', 'bash', 'file.read', 'file.write', 'file.delete', 'file.move', 'apply_patch', 'tool_calls']) {
      const result = validatePatchOnlyPlan({ actions: [action], diffs: [] });
      expect(result).toMatchObject({ ok: false, status: 'blocked_safety' });
    }
  });

  it('does not treat negative safety wording as forbidden intent', () => {
    const result = validatePatchOnlyPlan({
      actions: ['session_new', 'messages', 'diff'],
      diffs: [],
      proposal: 'No hard blockers. Do not request shell/write/delete/move/apply_patch; keep MiniMax patch-only.',
    });

    expect(result).toMatchObject({ ok: true, status: 'proposal_saved' });
  });

  it('blocks proposal text that asks for real shell or file mutation', () => {
    const result = validatePatchOnlyPlan({
      actions: ['session_new', 'messages', 'diff'],
      diffs: [],
      proposal: 'Please run shell command and write files directly.',
    });

    expect(result).toMatchObject({ ok: false, status: 'blocked_safety' });
  });

  it('extracts Mavis session id from common session new outputs', () => {
    expect(extractSessionId({ session: { id: 'mvs_abc123456789' } })).toBe('mvs_abc123456789');
    expect(extractSessionId('created session mvs_27e04f463657489db3a519de78978917')).toBe('mvs_27e04f463657489db3a519de78978917');
  });

  it('normalizes session diff output and treats non-empty diff as blocking input', () => {
    expect(normalizeSessionDiffs('[]')).toEqual([]);
    expect(normalizeSessionDiffs({ diffs: [] })).toEqual([]);
    expect(normalizeSessionDiffs({ diffs: [{ file: 'server.js' }] })).toEqual([{ file: 'server.js' }]);

    const result = validatePatchOnlyPlan({
      actions: ['session_new', 'messages', 'diff'],
      diffs: normalizeSessionDiffs({ diffs: [{ file: 'server.js' }] }),
    });
    expect(result).toMatchObject({ ok: false, status: 'blocked_safety' });
  });

  it('extracts latest assistant proposal from messages output', () => {
    const proposal = proposalFromMessagesOutput({
      messages: [
        { role: 'user', content: '请审计' },
        { role: 'assistant', content: '{"actions":["session_new","messages","diff"],"diffs":[],"proposal":"没有硬风险。"}' },
      ],
    });

    expect(proposal).toContain('没有硬风险');
  });

  it('does not treat user-only message echoes as assistant proposals', () => {
    const proposal = proposalFromMessagesOutput({
      messages: [
        { role: 'user', content: '请审计' },
        { msg_type: 3, msg_content: '{"eventType":"communication.message"}' },
      ],
    });

    expect(proposal).toBe('');
  });

  it('returns blocked_safety when CLI output is not parseable JSON', async () => {
    const adapter = new MiniMaxSpawnAdapter({
      bin: '',
      runner: async () => '普通自然语言，不是 JSON',
    });

    const result = await adapter._doChat([{ role: 'user', content: '审计一下' }], { skipBudget: true });

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked_safety',
      error: 'MiniMaxSpawnAdapter requires parseable JSON patch-only plan',
    });
  });

  it('saves parseable patch-only JSON proposal', async () => {
    const adapter = new MiniMaxSpawnAdapter({
      bin: '',
      runner: async () => JSON.stringify({
        actions: ['session_new', 'messages', 'diff'],
        diffs: [],
        proposal: '无硬风险，建议继续由 Codex 落地。',
      }),
    });

    const result = await adapter._doChat([{ role: 'user', content: '审计一下' }], { skipBudget: true });

    expect(result).toMatchObject({
      ok: true,
      status: 'proposal_saved',
      reply: '无硬风险，建议继续由 Codex 落地。',
    });
  });

  it('does not start Mavis/OpenCode local executor by default', async () => {
    const adapter = new MiniMaxSpawnAdapter({ bin: 'placeholder-minimax' });

    const result = await adapter._doChat([{ role: 'user', content: '根据日志提出优化建议' }], { skipBudget: true });

    expect(result).toMatchObject({
      ok: true,
      status: 'suggestions_saved',
    });
    expect(result.reply).toContain('Mavis/OpenCode local executor is disabled');
  });

  it('keeps M3 suggestion-only even when legacy executor env or opts are set', async () => {
    const previous = process.env.MINIMAX_ALLOW_MAVIS_EXECUTOR;
    process.env.MINIMAX_ALLOW_MAVIS_EXECUTOR = '1';
    try {
      const adapter = new MiniMaxSpawnAdapter({ bin: 'placeholder-minimax' });
      const result = await adapter._doChat([{ role: 'user', content: '启动本地 executor 直接改文件' }], {
        allowMavisExecutor: true,
        skipBudget: true,
      });
      const caps = adapter.getNativeCapabilities();

      expect(result).toMatchObject({
        ok: true,
        status: 'suggestions_saved',
      });
      expect(result.reply).toContain('Mavis/OpenCode local executor is disabled');
      expect(caps.tools.join(' ')).not.toContain('MINIMAX_ALLOW_MAVIS_EXECUTOR');
    } finally {
      if (previous === undefined) delete process.env.MINIMAX_ALLOW_MAVIS_EXECUTOR;
      else process.env.MINIMAX_ALLOW_MAVIS_EXECUTOR = previous;
    }
  });
});
