import { describe, expect, it } from 'vitest';
import { registerNoeComputerSearchRoutes } from '../../../src/server/routes/noeComputerSearch.js';

function makeApp() {
  const routes = [];
  return {
    app: { post: (path, ...handlers) => routes.push({ method: 'post', path, handlers }) },
    routes,
  };
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

describe('/api/noe/computer/search', () => {
  it('runs silent structured web search and returns TTS audio', async () => {
    const calls = [];
    let ttsText = '';
    const { app, routes } = makeApp();
    registerNoeComputerSearchRoutes(app, {
      webSearch: {
        searchWithMeta: async (query, opts) => {
          calls.push(['web', query, opts.count]);
          return { source: 'minimax', viaModel: 'MiniMax Search API', results: [{ title: 'Structured result', url: 'https://example.com', snippet: 'fresh' }] };
        },
      },
      summarizeSearch: async () => ({ reply: '主人，结论是：AI 新闻有更新，不需要逐条复读。' }),
      ttsClient: { synthesize: async (text) => { ttsText = text; return { audioBuffer: Buffer.from('audio'), format: 'mp3' }; } },
    });

    const res = makeRes();
    await handlerFor(routes, '/api/noe/computer/search')({ body: { text: '用电脑搜索一下 最新 AI 新闻', voice: true, count: 4 } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({
      ok: true,
      intent: 'computer_search',
      mode: 'silent',
      kind: '后台搜索',
      returnToNoe: false,
      closeAfterMs: 0,
      source: 'minimax',
      viaModel: 'MiniMax Search API',
      count: 1,
      audioFormat: 'mp3',
    });
    expect(res.payload.query).toBe('最新 AI 新闻');
    expect(res.payload.reply).toContain('Structured result');
    expect(res.payload.spokenReply).toContain('结论是');
    expect(ttsText).toContain('结论是');
    expect(res.payload.audioBase64).toBeTruthy();
    expect(res.payload.visible).toBe(null);
    expect(calls).toEqual([['web', '最新 AI 新闻', 4]]);
  });

  it('does not fall back to visible browser results when structured search is unavailable', async () => {
    const { app, routes } = makeApp();
    registerNoeComputerSearchRoutes(app, {
      webSearch: { searchWithMeta: async () => { throw new Error('web down'); } },
      ttsClient: { synthesize: async () => { throw new Error('should not synthesize'); } },
    });

    const res = makeRes();
    await handlerFor(routes, '/api/noe/computer/search')({ body: { query: 'Noe 搜索后台', voice: false } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({ ok: true, searchError: 'web down', count: 0, mode: 'silent', visible: null });
    expect(res.payload.reply).toContain('没有搜到');
    expect(res.payload.audioBase64).toBe(null);
  });
});
