import { describe, expect, it } from 'vitest';
import { registerResearchRoutes } from '../../../src/server/routes/research.js';

// 内在世界（记录覆盖扩展）：深研究完成 → 自传体时间线 type:'observation' salience 4。
// 三断言纪律：注入时形状正确 / 未注入零调用零影响 / record 抛错 fail-open 不破坏原返回。
// 全部注入 fake（webSearch/researcher/timeline），绝不连真库。

function makeApp() {
  const routes = [];
  const app = {
    post(path, ...handlers) { routes.push({ method: 'post', path, handlers }); },
    get(path, ...handlers) { routes.push({ method: 'get', path, handlers }); },
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

function makeFakeTimeline({ throwOnRecord = false } = {}) {
  const calls = [];
  return {
    calls,
    record(episode) {
      if (throwOnRecord) throw new Error('timeline down');
      calls.push(episode);
      return calls.length;
    },
  };
}

const fakeWebSearch = {
  searchWithMeta: async () => ({ results: [] }),
  fetchContent: async () => ({ ok: false }),
  status: () => ({ configured: true, providerOrder: ['test'] }),
};

const fakeResearcher = {
  research: async (question, opts) => {
    opts.onProgress({ phase: 'search', round: 1, queries: [question] });
    return { question, report: '# mock report', rounds: 2, sources: [] };
  },
};

describe('research deep 路由 × EpisodicTimeline（内在世界·记录覆盖扩展）', () => {
  it('注入 timeline：深研究完成记一条 observation salience 4，summary 含问题截断与轮数', async () => {
    const timeline = makeFakeTimeline();
    const { app, routes } = makeApp();
    registerResearchRoutes(app, { webSearch: fakeWebSearch, researcher: fakeResearcher, episodicTimeline: timeline });

    const res = makeSseRes();
    const longQ = '研究'.repeat(50);   // 100 字，验证截 40
    await handlerFor(routes, 'post', '/api/noe/research/deep')({ body: { question: longQ, maxRounds: 2 } }, res);

    expect(timeline.calls).toHaveLength(1);
    expect(timeline.calls[0]).toEqual({
      type: 'observation',
      summary: `我深入研究了"${longQ.slice(0, 40)}"（2 轮）`,
      salience: 4,
    });
    expect(res.ended).toBe(true);
  });

  it('未注入 timeline：零调用，SSE 流行为与既有完全一致', async () => {
    const bystander = makeFakeTimeline();   // 造了但不注入，断言零调用
    const { app, routes } = makeApp();
    registerResearchRoutes(app, { webSearch: fakeWebSearch, researcher: fakeResearcher });

    const res = makeSseRes();
    await handlerFor(routes, 'post', '/api/noe/research/deep')({ body: { question: '不注入也照常研究' } }, res);

    expect(bystander.calls).toHaveLength(0);
    const stream = res.chunks.join('');
    expect(stream).toContain('event: result');
    expect(stream).toContain('event: done');
    expect(stream).toContain('# mock report');
    expect(res.ended).toBe(true);
  });

  it('record 抛错：fail-open，SSE result/done 照常、流正常收尾', async () => {
    const { app, routes } = makeApp();
    registerResearchRoutes(app, {
      webSearch: fakeWebSearch,
      researcher: fakeResearcher,
      episodicTimeline: makeFakeTimeline({ throwOnRecord: true }),
    });

    const res = makeSseRes();
    await handlerFor(routes, 'post', '/api/noe/research/deep')({ body: { question: '时间线挂了也不影响研究' } }, res);

    const stream = res.chunks.join('');
    expect(stream).toContain('event: result');
    expect(stream).toContain('event: done');
    expect(stream).not.toContain('event: error');
    expect(res.ended).toBe(true);
  });

  it('单次搜索不记时间线（只记深研究，避免噪声）', async () => {
    const timeline = makeFakeTimeline();
    const { app, routes } = makeApp();
    registerResearchRoutes(app, { webSearch: fakeWebSearch, researcher: fakeResearcher, episodicTimeline: timeline });

    const res = makeSseRes();
    await handlerFor(routes, 'post', '/api/noe/research/search')({ body: { query: '随手一搜' } }, res);

    expect(timeline.calls).toHaveLength(0);
  });
});
