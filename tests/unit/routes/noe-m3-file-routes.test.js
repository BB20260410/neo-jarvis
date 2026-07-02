import { describe, expect, it } from 'vitest';
import { registerNoeRoutes } from '../../../src/server/routes/noe.js';

function makeApp() {
  const routes = {
    get: new Map(),
    post: new Map(),
    delete: new Map(),
  };
  const app = {
    routes,
  };
  for (const method of ['get', 'post', 'delete']) {
    app[method] = (path, ...handlers) => {
      routes[method].set(path, handlers.at(-1));
    };
  }
  return app;
}

function makeDeps() {
  return {
    loop: { status: () => ({ running: true }) },
    memory: {
      recall: () => [],
      write: (item) => item,
      hide: () => true,
      merge: () => ({ id: 'merged' }),
      stats: () => ({ total: 0 }),
    },
    focus: {
      list: () => [],
      depth: () => 0,
      push: (item) => item,
      pop: () => null,
    },
    toolRegistry: {
      list: () => [],
      register: (tool) => tool,
      setEnabled: () => null,
      invoke: async () => ({ ok: true }),
    },
    fileIndex: {
      stats: () => ({ readOnly: true, count: 0 }),
      indexPath: () => ({ readOnly: true, count: 1 }),
      search: () => [{ relativePath: 'README.md', score: 1 }],
    },
  };
}

function makeRes() {
  return {
    code: 200,
    body: null,
    status(code) {
      this.code = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

describe('Noe M3 and file index routes', () => {
  it('registers internal M3 suggestion and read-only file index endpoints', () => {
    const app = makeApp();
    registerNoeRoutes(app, makeDeps());

    expect(app.routes.post.has('/api/noe/m3/suggest')).toBe(true);
    expect(app.routes.get.has('/api/noe/files/index')).toBe(true);
    expect(app.routes.post.has('/api/noe/files/index')).toBe(true);
    expect(app.routes.get.has('/api/noe/files/search')).toBe(true);
  });

  it('uses the injected read-only file index for index and search routes', () => {
    const app = makeApp();
    registerNoeRoutes(app, makeDeps());

    const indexRes = makeRes();
    app.routes.post.get('/api/noe/files/index')({ body: { root: '/tmp/noe' } }, indexRes);
    expect(indexRes.body).toEqual({ ok: true, index: { readOnly: true, count: 1 } });

    const searchRes = makeRes();
    app.routes.get.get('/api/noe/files/search')({ query: { q: 'readme' } }, searchRes);
    expect(searchRes.body.results[0].relativePath).toBe('README.md');
  });
});
