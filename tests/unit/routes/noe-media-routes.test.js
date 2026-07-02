import { describe, expect, it } from 'vitest';
import { registerNoeMediaRoutes } from '../../../src/server/routes/noeMedia.js';
import { requireOwnerToken } from '../../../src/server/auth/owner-token.js';

// /api/noe/media/* 路由测试：假 app 收集 handler、假 studio 注入，不真调不烧额度。

function makeApp() {
  const routes = new Map();   // 业务 handler（链尾），现有用例用
  const chains = new Map();   // 完整 handler 链，鉴权结构测试用
  const app = {};
  for (const method of ['get', 'post']) {
    app[method] = (path, ...handlers) => {
      routes.set(`${method} ${path}`, handlers[handlers.length - 1]);
      chains.set(`${method} ${path}`, handlers);
    };
  }
  return { app, routes, chains };
}

const ALL_ENDPOINTS = ['post /api/noe/media/image', 'post /api/noe/media/music', 'post /api/noe/media/video', 'get /api/noe/media/video/:taskId'];

function makeRes() {
  return {
    statusCode: 200,
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
  };
}

const sendError = (res, e) => res.status(500).json({ ok: false, error: e?.message || String(e) });

function setup(studio) {
  const { app, routes } = makeApp();
  registerNoeMediaRoutes(app, { studio, sendError });
  return routes;
}

describe('noe media routes', () => {
  it('每个端点第一个 handler 都是 requireOwnerToken（鉴权约束不可漏，结构级防回归）', () => {
    const { app, chains } = makeApp();
    registerNoeMediaRoutes(app, { studio: { configured: () => true }, sendError });
    for (const key of ALL_ENDPOINTS) {
      expect(chains.get(key), key).toBeDefined();
      expect(chains.get(key)[0], key).toBe(requireOwnerToken);
    }
  });

  it('key 未配置：四个端点全部 501', async () => {
    const routes = setup({ configured: () => false });
    for (const key of ['post /api/noe/media/image', 'post /api/noe/media/music', 'post /api/noe/media/video', 'get /api/noe/media/video/:taskId']) {
      const res = makeRes();
      await routes.get(key)({ body: { prompt: '猫' }, params: { taskId: 't-1' } }, res);
      expect(res.statusCode, key).toBe(501);
    }
  });

  it('image：缺 prompt 400；正常调 studio.image 带白名单 opts', async () => {
    let seen = null;
    const routes = setup({ configured: () => true, image: async (prompt, opts) => { seen = { prompt, opts }; return { ok: true, kind: 'image', files: ['/p.png'], id: null }; } });
    const bad = makeRes();
    await routes.get('post /api/noe/media/image')({ body: {} }, bad);
    expect(bad.statusCode).toBe(400);

    const res = makeRes();
    await routes.get('post /api/noe/media/image')({ body: { prompt: ' 一只猫 ', aspectRatio: '16:9', n: 2, evil: 'x' } }, res);
    expect(res.payload.ok).toBe(true);
    expect(seen.prompt).toBe('一只猫');
    expect(seen.opts.aspectRatio).toBe('16:9');
    expect(seen.opts.n).toBe(2);
    expect('evil' in seen.opts).toBe(false);
  });

  it('image：超长 prompt 拒收 400', async () => {
    const routes = setup({ configured: () => true });
    const res = makeRes();
    await routes.get('post /api/noe/media/image')({ body: { prompt: 'x'.repeat(2001) } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('music：lyrics 超长 400；outputFormat 只认 wav', async () => {
    let seen = null;
    const routes = setup({ configured: () => true, music: async (prompt, opts) => { seen = opts; return { ok: true }; } });
    const bad = makeRes();
    await routes.get('post /api/noe/media/music')({ body: { prompt: '钢琴', lyrics: 'x'.repeat(3501) } }, bad);
    expect(bad.statusCode).toBe(400);

    const res = makeRes();
    await routes.get('post /api/noe/media/music')({ body: { prompt: '钢琴', instrumental: true, outputFormat: 'exe' } }, res);
    expect(seen.instrumental).toBe(true);
    expect(seen.outputFormat).toBeUndefined();
  });

  it('video：firstFrameImage 过大 413；正常返回 taskId', async () => {
    const routes = setup({ configured: () => true, videoCreate: async () => ({ ok: true, taskId: 't-9' }) });
    const big = makeRes();
    await routes.get('post /api/noe/media/video')({ body: { prompt: '猫', firstFrameImage: 'x'.repeat(10_000_001) } }, big);
    expect(big.statusCode).toBe(413);

    const res = makeRes();
    await routes.get('post /api/noe/media/video')({ body: { prompt: '猫' } }, res);
    expect(res.payload.taskId).toBe('t-9');
  });

  it('video 轮询：非法 taskId 400；合法走 studio.videoPoll', async () => {
    const routes = setup({ configured: () => true, videoPoll: async (id) => ({ ok: true, status: 'pending', taskId: id }) });
    const bad = makeRes();
    await routes.get('get /api/noe/media/video/:taskId')({ params: { taskId: '../etc' } }, bad);
    expect(bad.statusCode).toBe(400);

    const res = makeRes();
    await routes.get('get /api/noe/media/video/:taskId')({ params: { taskId: 'task_01-ab' } }, res);
    expect(res.payload.status).toBe('pending');
  });

  it('studio 抛错走 sendError 不裸奔', async () => {
    const routes = setup({ configured: () => true, image: async () => { throw new Error('MiniMax 图像错误(1004)'); } });
    const res = makeRes();
    await routes.get('post /api/noe/media/image')({ body: { prompt: '猫' } }, res);
    expect(res.statusCode).toBe(500);
    expect(res.payload.error).toContain('1004');
  });
});
