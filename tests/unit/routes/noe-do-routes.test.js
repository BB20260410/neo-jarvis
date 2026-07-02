import { describe, expect, it } from 'vitest';
import { registerNoeDoRoute } from '../../../src/server/routes/noeDo.js';

function makeApp() {
  const routes = [];
  const app = {
    post(path, ...handlers) {
      routes.push({ method: 'post', path, handlers });
    },
  };
  return { app, routes };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
  };
}

function handlerFor(routes, path) {
  return routes.find((route) => route.method === 'post' && route.path === path).handlers[1];
}

describe('/api/noe/do intent route', () => {
  it('routes explicit localWiki requests to the LLM Wiki before web search', async () => {
    let searchCalled = false;
    const { app, routes } = makeApp();
    registerNoeDoRoute(app, {
      llmWiki: {
        lookup: async (query, opts) => ({
          query,
          count: 1,
          hits: [{ title: 'Karpathy', file: 'wiki/k.md', snippet: 'compiled wiki' }],
          citations: [{ index: 1, title: 'Karpathy', file: 'wiki/k.md' }],
          reply: `wiki:${query}:${opts.topK}`,
        }),
      },
      webSearch: { searchWithMeta: async () => { searchCalled = true; return { results: [] }; } },
      getMcpClient: () => ({ callTool: async () => { throw new Error('should not call mcp'); } }),
    });

    const res = makeRes();
    await handlerFor(routes, '/api/noe/do')({ body: { text: 'Obsidian MCP 要不要接', localWiki: true, topK: 2 } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({
      ok: true,
      matched: true,
      intent: 'llm_wiki',
      mode: 'local',
      kind: '本地知识库',
      count: 1,
      reply: 'wiki:Obsidian MCP 要不要接:2',
    });
    expect(searchCalled).toBe(false);
  });

  it('answers known knowledge-method questions from the LLM Wiki by default', async () => {
    const { app, routes } = makeApp();
    registerNoeDoRoute(app, {
      llmWiki: {
        lookup: async (query) => ({ query, count: 1, hits: [], citations: [], reply: `local:${query}` }),
      },
      getMcpClient: () => ({ callTool: async () => { throw new Error('should not call mcp'); } }),
    });

    const res = makeRes();
    await handlerFor(routes, '/api/noe/do')({ body: { text: '我们之前对 Karpathy 知识库的结论是什么' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({ intent: 'llm_wiki' });
    expect(res.payload.reply).toContain('Karpathy 知识库');
  });

  it('routes web-search intent to AISearch metadata without touching MCP', async () => {
    let mcpCalled = false;
    const { app, routes } = makeApp();
    registerNoeDoRoute(app, {
      webSearch: {
        searchWithMeta: async (query, opts) => ({
          ok: true,
          query,
          source: 'minimax',
          viaModel: 'MiniMax Search API',
          count: opts.count,
          results: [{ title: 'News', url: 'https://example.com/news', snippet: 'Fresh', source: 'minimax' }],
        }),
      },
      getMcpClient: () => ({ callTool: async () => { mcpCalled = true; } }),
    });

    const res = makeRes();
    await handlerFor(routes, '/api/noe/do')({ body: { text: '帮我查最新 AI 新闻', count: 2 } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({
      ok: true,
      matched: true,
      intent: 'research',
      mode: 'search',
      source: 'minimax',
      viaModel: 'MiniMax Search API',
      count: 1,
    });
    expect(res.payload.reply).toContain('News');
    expect(mcpCalled).toBe(false);
  });

  it('keeps explicit latest/web-search requests on the AISearch path', async () => {
    const { app, routes } = makeApp();
    registerNoeDoRoute(app, {
      llmWiki: { lookup: async () => { throw new Error('should not call wiki'); } },
      webSearch: {
        searchWithMeta: async (query) => ({
          ok: true,
          query,
          source: 'minimax',
          results: [{ title: 'Latest', url: 'https://example.com/latest', snippet: 'fresh', source: 'minimax' }],
        }),
      },
      getMcpClient: () => ({ callTool: async () => { throw new Error('should not call mcp'); } }),
    });

    const res = makeRes();
    await handlerFor(routes, '/api/noe/do')({ body: { text: '上网查最新 Obsidian MCP' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({ intent: 'research', mode: 'search', source: 'minimax', count: 1 });
  });


  it('routes deep-research intent to the injected researcher', async () => {
    const { app, routes } = makeApp();
    registerNoeDoRoute(app, {
      researcher: {
        research: async (query, opts) => ({
          query,
          report: '# 深度报告',
          rounds: opts.maxRounds,
          sources: [{ title: 'S', url: 'https://example.com/s' }],
        }),
      },
      getMcpClient: () => ({ callTool: async () => { throw new Error('should not call mcp'); } }),
    });

    const res = makeRes();
    await handlerFor(routes, '/api/noe/do')({ body: { text: '研究一下 Noe 上网搜索', maxRounds: 1 } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({
      ok: true,
      matched: true,
      intent: 'research',
      mode: 'deep',
      query: 'Noe 上网搜索',
      report: '# 深度报告',
      rounds: 1,
    });
    expect(res.payload.reply).toContain('# 深度报告');
    expect(res.payload.reply).toContain('https://example.com/s');
  });

  it('executes confirmed organize plans and best-effort syncs the file index', async () => {
    const calls = [];
    const { app, routes } = makeApp();
    registerNoeDoRoute(app, {
      getMcpClient: () => ({
        callTool: async (_server, toolName, args) => {
          calls.push({ toolName, args });
          if (toolName === 'fs_organize_nl') {
            return { content: [{ text: JSON.stringify({ plan: { operations: [{ from: '/tmp/a.png', to: '/tmp/Pictures/a.png' }] } }) }] };
          }
          if (toolName === 'fs_organize_execute') {
            return { content: [{ text: JSON.stringify({ move: { batchId: 'batch-1' } }) }] };
          }
          if (toolName === 'fs_organize_sync') {
            return { content: [{ text: JSON.stringify({ synced: true }) }] };
          }
          throw new Error(`unexpected tool ${toolName}`);
        },
      }),
    });

    const res = makeRes();
    await handlerFor(routes, '/api/noe/do')({ body: { text: '把桌面截图归一起', confirm: true } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({
      ok: true,
      executed: true,
      moved: 1,
      batchId: 'batch-1',
      sync: { attempted: true, ok: true },
    });
    expect(calls.map((c) => c.toolName)).toEqual(['fs_organize_nl', 'fs_organize_execute', 'fs_organize_sync']);
    expect(calls[2].args).toMatchObject({ batch_id: 'batch-1', reason: 'execute' });
  });

  it('does not fail confirmed organize execution when sync is unavailable', async () => {
    const { app, routes } = makeApp();
    registerNoeDoRoute(app, {
      getMcpClient: () => ({
        callTool: async (_server, toolName) => {
          if (toolName === 'fs_organize_nl') return { content: [{ text: JSON.stringify({ plan: { operations: [{ from: 'a', to: 'b' }] } }) }] };
          if (toolName === 'fs_organize_execute') return { content: [{ text: JSON.stringify({ move: { batchId: 'batch-2' } }) }] };
          if (toolName === 'fs_organize_sync') throw new Error('tool not found');
          throw new Error(`unexpected tool ${toolName}`);
        },
      }),
    });

    const res = makeRes();
    await handlerFor(routes, '/api/noe/do')({ body: { text: '整理桌面文件', confirm: true } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({
      ok: true,
      executed: true,
      batchId: 'batch-2',
      sync: { attempted: true, ok: false, error: 'tool not found' },
    });
  });

  it('syncs the file index after undoing the last organize batch', async () => {
    const calls = [];
    const { app, routes } = makeApp();
    registerNoeDoRoute(app, {
      getMcpClient: () => ({
        callTool: async (_server, toolName, args) => {
          calls.push({ toolName, args });
          if (toolName === 'fs_organize_nl') return { content: [{ text: JSON.stringify({ plan: { operations: [{ from: 'a', to: 'b' }] } }) }] };
          if (toolName === 'fs_organize_execute') return { content: [{ text: JSON.stringify({ move: { batchId: 'batch-3' } }) }] };
          if (toolName === 'fs_organize_undo') return { content: [{ text: 'undone' }] };
          if (toolName === 'fs_organize_sync') return { content: [{ text: 'synced' }] };
          throw new Error(`unexpected tool ${toolName}`);
        },
      }),
    });

    await handlerFor(routes, '/api/noe/do')({ body: { text: '整理桌面文件', confirm: true } }, makeRes());
    const undoRes = makeRes();
    await handlerFor(routes, '/api/noe/do')({ body: { text: '撤销' } }, undoRes);

    expect(undoRes.statusCode).toBe(200);
    expect(undoRes.payload).toMatchObject({
      ok: true,
      undone: true,
      batchId: 'batch-3',
      sync: { attempted: true, ok: true },
    });
    expect(calls.at(-1)).toMatchObject({ toolName: 'fs_organize_sync', args: { batch_id: 'batch-3', reason: 'undo' } });
  });

  it('routes delegation intent to a confirm-only plan with the Noe confirm endpoint', async () => {
    const { app, routes } = makeApp();
    registerNoeDoRoute(app, {
      getMcpClient: () => ({ callTool: async () => { throw new Error('should not call mcp'); } }),
    });

    const res = makeRes();
    await handlerFor(routes, '/api/noe/do')({ body: { text: '让 Codex 帮我修复登录页 bug' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({
      ok: true,
      matched: true,
      intent: 'delegate_task',
      approvalRequired: true,
      dryRunOnly: true,
      confirmEndpoint: '/api/noe/delegate/confirm',
      plan: { targetAdapter: 'codex', targetMode: 'chat' },
    });
    expect(res.payload.reply).toContain('未启动 CLI');
  });
});
