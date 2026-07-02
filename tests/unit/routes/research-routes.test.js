import { describe, expect, it, vi } from 'vitest';
import { registerResearchRoutes } from '../../../src/server/routes/research.js';

function makeApp() {
  const routes = [];
  const app = {
    post(path, ...handlers) {
      routes.push({ method: 'post', path, handlers });
    },
    get(path, ...handlers) {
      routes.push({ method: 'get', path, handlers });
    },
  };
  return { app, routes };
}

function handlerFor(routes, method, path) {
  return routes.find((route) => route.method === method && route.path === path).handlers[1];
}

function makeSseRes() {
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    ended: false,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
    write(chunk) { this.chunks.push(String(chunk)); },
    end() { this.ended = true; },
  };
}

describe('/api/noe/research routes', () => {
  it('streams deep research start/progress/result/done events with injected researcher', async () => {
    const { app, routes } = makeApp();
    registerResearchRoutes(app, {
      webSearch: {
        searchWithMeta: async () => ({ results: [] }),
        fetchContent: async () => ({ ok: false }),
        status: () => ({ configured: true, providerOrder: ['test'] }),
      },
      researcher: {
        research: async (question, opts) => {
          opts.onProgress({ phase: 'search', round: 1, queries: [question] });
          return {
            question,
            report: '# mock report',
            rounds: 1,
            sources: [{ title: 'Mock', url: 'https://example.com/mock' }],
          };
        },
      },
    });

    const res = makeSseRes();
    await handlerFor(routes, 'post', '/api/noe/research/deep')({ body: { question: '研究 Noe 搜索', maxRounds: 1 } }, res);

    const stream = res.chunks.join('');
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/event-stream');
    expect(stream).toContain('event: start');
    expect(stream).toContain('event: progress');
    expect(stream).toContain('event: result');
    expect(stream).toContain('event: done');
    expect(stream).toContain('# mock report');
    expect(res.ended).toBe(true);
  });

  it('sends still-working progress while deep research keeps waiting', async () => {
    vi.useFakeTimers();
    try {
      const { app, routes } = makeApp();
      let releaseResearch;
      let researchOpts;
      registerResearchRoutes(app, {
        webSearch: {
          searchWithMeta: async () => ({ results: [] }),
          fetchContent: async () => ({ ok: false }),
          status: () => ({ configured: true, providerOrder: ['test'] }),
        },
        researcher: {
          research: async (question, opts) => {
            researchOpts = opts;
            opts.onProgress({ phase: 'synthesize', round: 1 });
            await new Promise((resolve) => { releaseResearch = resolve; });
            return { question, report: '# complete report', rounds: 1, sources: [] };
          },
        },
      });

      const res = makeSseRes();
      const run = handlerFor(routes, 'post', '/api/noe/research/deep')({ body: { question: '慢模型研究', maxRounds: 1 } }, res);
      await Promise.resolve();
      vi.advanceTimersByTime(15_000);

      const streamBeforeDone = res.chunks.join('');
      expect(streamBeforeDone).toContain('"phase":"synthesize"');
      expect(streamBeforeDone).toContain('"stillWorking":true');
      expect(Object.prototype.hasOwnProperty.call(researchOpts, 'abortSignal')).toBe(false);

      releaseResearch();
      await run;
      expect(res.chunks.join('')).toContain('# complete report');
      expect(res.ended).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
