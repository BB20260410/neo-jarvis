import { describe, expect, it } from 'vitest';
import { createAISearch } from '../../src/research/AISearch.js';

describe('AISearch provider metadata', () => {
  it('tags MiniMax results with viaModel and returns top-level metadata', async () => {
    const aiSearch = createAISearch({
      webSearch: {
        search: async () => [{ title: 'T', url: 'https://example.com', snippet: 'S', source: 'minimax' }],
        fetchContent: async () => ({ ok: true }),
        status: () => ({ minimax: true, configured: true }),
      },
    });
    const out = await aiSearch.searchWithMeta('q');
    expect(out).toMatchObject({ ok: true, source: 'minimax', viaModel: 'MiniMax Search API', count: 1 });
    expect(out.results[0]).toMatchObject({ viaModel: 'MiniMax Search API' });
  });

  it('reports Codex and Claude CLI fallbacks as disabled by default', () => {
    const aiSearch = createAISearch({
      webSearch: {
        search: async () => [],
        fetchContent: async () => ({ ok: true }),
        status: () => ({ configured: true }),
      },
    });
    const status = aiSearch.status();
    expect(status.aiSearch).toBe(true);
    expect(status.providerOrder).toEqual(['minimax', 'codex', 'claude', 'searxng', 'brave']);
    expect(status.cliFallbacks.codex.enabled).toBe(false);
    expect(status.cliFallbacks.claude.enabled).toBe(false);
    expect(status.cliFallbacks.codex.reason).toMatch(/disabled_by_default/);
  });

  it('can use a deterministic managed search fixture only in test verification mode', async () => {
    const aiSearch = createAISearch({
      env: { NODE_ENV: 'test', NOE_PHASE5_RUNTIME_VERIFY: '1', NOE_AI_SEARCH_MOCK: '1' },
      webSearch: {
        searchProvider: async () => { throw new Error('real providers should not run'); },
        fetchContent: async () => ({ ok: true }),
        status: () => ({ configured: false }),
      },
    });

    const out = await aiSearch.searchWithMeta('Noe fixture query', { count: 2 });
    const status = aiSearch.status();

    expect(out).toMatchObject({ ok: true, source: 'noe_managed_fixture', viaModel: 'Managed Noe Search Fixture', count: 1 });
    expect(out.results[0]).toMatchObject({ fixture: true, viaModel: 'Managed Noe Search Fixture' });
    expect(status.mockSearch).toBe(true);
  });

  it('does not enable the managed search fixture outside test verification mode', async () => {
    const aiSearch = createAISearch({
      env: { NOE_AI_SEARCH_MOCK: '1' },
      webSearch: {
        searchProvider: async () => [],
        fetchContent: async () => ({ ok: true }),
        status: () => ({ configured: false }),
      },
    });

    await expect(aiSearch.searchWithMeta('Noe fixture query')).rejects.toThrow(/所有 AI 搜索源失败/);
    expect(aiSearch.status().mockSearch).toBe(false);
  });

  it('does not enable the managed search fixture for generic NODE_ENV=test alone', async () => {
    const aiSearch = createAISearch({
      env: { NODE_ENV: 'test', NOE_AI_SEARCH_MOCK: '1' },
      webSearch: {
        searchProvider: async () => [],
        fetchContent: async () => ({ ok: true }),
        status: () => ({ configured: false }),
      },
    });

    await expect(aiSearch.searchWithMeta('Noe fixture query')).rejects.toThrow(/所有 AI 搜索源失败/);
    expect(aiSearch.status().mockSearch).toBe(false);
  });

  it('uses an env-enabled Codex CLI fallback before SearXNG without shell execution', async () => {
    const calls = [];
    const aiSearch = createAISearch({
      env: { NOE_AI_SEARCH_CODEX_CLI: '1' },
      webSearch: {
        searchProvider: async (provider) => {
          calls.push(provider);
          if (provider === 'minimax') throw new Error('minimax down');
          if (provider === 'searxng') return [{ title: 'S', url: 'https://s.example', snippet: 'late', source: 'searxng' }];
          return [];
        },
        fetchContent: async () => ({ ok: true }),
        status: () => ({ minimax: true, searxng: true, configured: true }),
      },
      cliRunner: async ({ command, args, env, timeoutMs }) => {
        calls.push(command);
        expect(command).toBe('codex');
        expect(args.slice(0, 4)).toEqual(['--search', '--ask-for-approval', 'never', 'exec']);
        expect(args).toContain('--ephemeral');
        expect(args).toContain('read-only');
        expect(args.join(' ')).toContain('Return up to 3 results');
        expect(timeoutMs).toBe(0);
        expect(env).not.toHaveProperty('MINIMAX_API_KEY');
        return { exitCode: 0, stdout: '{"results":[{"title":"C","url":"https://c.example","snippet":"web"}]}' };
      },
    });

    const out = await aiSearch.searchWithMeta('q', { count: 3 });

    expect(calls).toEqual(['minimax', 'codex']);
    expect(out).toMatchObject({ source: 'codex', viaModel: 'Codex CLI Web Search', count: 1 });
    expect(out.results[0]).toMatchObject({ title: 'C', source: 'codex', viaModel: 'Codex CLI Web Search' });
  });

  it('parses CLI fallback JSON even when the model wraps it in think/prose/fences', async () => {
    const aiSearch = createAISearch({
      env: { NOE_AI_SEARCH_CODEX_CLI: '1' },
      webSearch: {
        searchProvider: async (provider) => (provider === 'minimax' ? [] : []),
        fetchContent: async () => ({ ok: true }),
        status: () => ({ configured: true }),
      },
      cliRunner: async () => ({
        exitCode: 0,
        stdout: [
          '<think>searching, but this should be stripped</think>',
          '找到这些：',
          '```json',
          '{"results":[{"title":"Wrapped","url":"https://wrapped.example","snippet":"hit"}]}',
          '```',
        ].join('\n'),
      }),
    });

    const out = await aiSearch.searchWithMeta('q');

    expect(out).toMatchObject({ source: 'codex', count: 1 });
    expect(out.results[0]).toMatchObject({ title: 'Wrapped', url: 'https://wrapped.example', source: 'codex' });
  });

  it('passes an explicit CLI timeout only when the operator provides one', async () => {
    const aiSearch = createAISearch({
      env: { NOE_AI_SEARCH_CODEX_CLI: '1', NOE_AI_SEARCH_CODEX_TIMEOUT_MS: '120000' },
      webSearch: {
        searchProvider: async (provider) => (provider === 'minimax' ? [] : []),
        fetchContent: async () => ({ ok: true }),
        status: () => ({ configured: true }),
      },
      cliRunner: async ({ timeoutMs }) => {
        expect(timeoutMs).toBe(120000);
        return { exitCode: 0, stdout: '{"answer":"ok"}' };
      },
    });

    const out = await aiSearch.searchWithMeta('q');

    expect(out).toMatchObject({ source: 'codex', count: 1 });
  });

  it('uses a constrained Claude WebSearch CLI fallback when explicitly enabled', async () => {
    const aiSearch = createAISearch({
      env: { NOE_AI_SEARCH_CLAUDE_CLI: '1' },
      webSearch: {
        searchProvider: async (provider) => {
          if (provider === 'minimax') return [];
          if (provider === 'codex') throw new Error('codex disabled');
          throw new Error(`${provider} should not run`);
        },
        fetchContent: async () => ({ ok: true }),
        status: () => ({ configured: true }),
      },
      cliRunner: async ({ command, args, env }) => {
        expect(command).toBe('claude');
        expect(args.slice(0, 5)).toEqual(['--print', '--permission-mode', 'dontAsk', '--allowedTools', 'WebSearch']);
        expect(args).toContain('--no-session-persistence');
        expect(args.join(' ')).toContain('Return up to 2 results');
        expect(env).not.toHaveProperty('MINIMAX_API_KEY');
        return { exitCode: 0, stdout: '{"results":[{"title":"H","url":"https://h.example","snippet":"hit"}]}' };
      },
    });

    const out = await aiSearch.searchWithMeta('q', { count: 2 });

    expect(out).toMatchObject({ source: 'claude', viaModel: 'Claude CLI WebSearch', count: 1 });
    expect(out.results[0]).toMatchObject({ title: 'H', source: 'claude', viaModel: 'Claude CLI WebSearch' });
  });
});
