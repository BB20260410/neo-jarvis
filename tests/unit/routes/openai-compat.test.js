// @ts-check
// openai-compat 路由 characterization 单测：钉住当前 /v1 OpenAI 兼容网关的真实 Express 契约。
import { describe, it, expect, vi } from 'vitest';
import { registerOpenaiCompatRoutes } from '../../../src/server/routes/openai-compat.js';
import { requireOwnerToken } from '../../../src/server/auth/owner-token.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post', 'patch', 'delete']) {
    app[method] = (path, ...handlers) => routes.push({ method, path, handlers });
  }
  app.use = (path, ...handlers) => routes.push({ method: 'use', path, handlers });
  return { app, routes };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: undefined,
    headers: {},
    ended: false,
    body: '',
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    write(chunk) { this.body += String(chunk); return true; },
    end() { this.ended = true; return this; },
    flushHeaders() {},
  };
}

function makeReq({ body = {}, path = '', query = {}, method = 'GET' } = {}) {
  return {
    body,
    path,
    query,
    method,
    on() {},
  };
}

const find = (routes, method, path) => routes.find((route) => route.method === method && route.path === path);
const handlerOf = (route) => route.handlers[route.handlers.length - 1];

function setup(deps = {}) {
  const { app, routes } = makeApp();
  const guard = deps.requireOwnerToken || ((_req, _res, next) => next?.());
  registerOpenaiCompatRoutes(app, {
    roomAdapterPool: Object.hasOwn(deps, 'roomAdapterPool') ? deps.roomAdapterPool : new Map(),
    metricsStore: Object.hasOwn(deps, 'metricsStore') ? deps.metricsStore : { record: () => {} },
    requireOwnerToken: guard,
    DEBUG_ERRORS: deps.DEBUG_ERRORS ?? false,
  });
  return { routes, guard };
}

describe('openai-compat routes', () => {
  it('注册当前真实路由，并只保护会消耗模型配额的 POST 端点', () => {
    const { routes } = setup({ requireOwnerToken });
    expect(find(routes, 'get', '/v1/models')).toBeTruthy();
    expect(find(routes, 'post', '/v1/chat/completions')).toBeTruthy();
    expect(find(routes, 'use', '/v1')).toBeTruthy();

    expect(find(routes, 'get', '/v1/models').handlers).toHaveLength(1);
    expect(find(routes, 'post', '/v1/chat/completions').handlers[0]).toBe(requireOwnerToken);
  });

  it('GET /v1/models 从已注册 adapter 映射 OpenAI list 格式', async () => {
    const roomAdapterPool = new Map([
      ['claude', {}],
      ['custom-adapter', {}],
    ]);
    const { routes } = setup({ roomAdapterPool });
    const res = makeRes();

    await handlerOf(find(routes, 'get', '/v1/models'))(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.payload.object).toBe('list');
    expect(res.payload.data).toEqual(expect.arrayContaining([
      { id: 'claude:claude-opus-4-8', object: 'model', created: 0, owned_by: 'noe' },
      { id: 'claude:sonnet', object: 'model', created: 0, owned_by: 'noe' },
      { id: 'custom-adapter', object: 'model', created: 0, owned_by: 'noe' },
    ]));
  });

  it('GET /v1/models 在依赖异常时返回 panel_internal_error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { routes } = setup({ roomAdapterPool: null, DEBUG_ERRORS: true });
      const res = makeRes();

      await handlerOf(find(routes, 'get', '/v1/models'))(makeReq(), res);

      expect(res.statusCode).toBe(500);
      expect(res.payload.error.type).toBe('panel_internal_error');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('POST 缺 model 或 messages 时返回 OpenAI 风格 invalid_request_error', async () => {
    const { routes } = setup();
    const post = handlerOf(find(routes, 'post', '/v1/chat/completions'));

    const noModel = makeRes();
    await post(makeReq({ body: { messages: [{ role: 'user', content: 'hi' }] } }), noModel);
    expect(noModel.statusCode).toBe(400);
    expect(noModel.payload.error).toMatchObject({ type: 'invalid_request_error', message: 'model is required' });

    const noMessages = makeRes();
    await post(makeReq({ body: { model: 'claude:sonnet' } }), noMessages);
    expect(noMessages.statusCode).toBe(400);
    expect(noMessages.payload.error.type).toBe('invalid_request_error');
    expect(noMessages.payload.error.message).toContain('messages');
  });

  it('POST 未注册 adapter 返回 404，并标明 model 参数错误', async () => {
    const { routes } = setup({ roomAdapterPool: new Map() });
    const res = makeRes();

    await handlerOf(find(routes, 'post', '/v1/chat/completions'))(
      makeReq({ body: { model: 'missing:sonnet', messages: [{ role: 'user', content: 'hi' }] } }),
      res,
    );

    expect(res.statusCode).toBe(404);
    expect(res.payload.error).toMatchObject({ type: 'invalid_request_error', param: 'model' });
    expect(res.payload.error.message).toContain('missing');
  });

  it('POST 会过滤非法 messages，并把 adapterId/modelName 传给 adapter.chat', async () => {
    const chat = vi.fn(async () => ({ reply: 'hello there', tokensIn: 3, tokensOut: 2 }));
    const record = vi.fn();
    const roomAdapterPool = new Map([['test-adapter', { chat }]]);
    const { routes } = setup({ roomAdapterPool, metricsStore: { record } });
    const res = makeRes();

    await handlerOf(find(routes, 'post', '/v1/chat/completions'))(
      makeReq({
        body: {
          model: 'test-adapter:model-a',
          messages: [
            { role: 'system', content: 'be concise' },
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: [{ text: 'legacy array content is ignored' }] },
          ],
        },
      }),
      res,
    );

    expect(chat).toHaveBeenCalledWith(
      [
        { role: 'system', content: 'be concise' },
        { role: 'user', content: 'hi' },
      ],
      expect.objectContaining({
        model: 'model-a',
        budgetContext: { projectId: expect.any(String), adapterId: 'test-adapter' },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({
      object: 'chat.completion',
      model: 'test-adapter:model-a',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello there' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      roomMode: 'openai-api',
      adapter: 'test-adapter',
      model: 'model-a',
      success: true,
    }));
  });

  it('POST 过滤后没有有效 message 时返回 400', async () => {
    const roomAdapterPool = new Map([['test-adapter', { chat: vi.fn() }]]);
    const { routes } = setup({ roomAdapterPool });
    const res = makeRes();

    await handlerOf(find(routes, 'post', '/v1/chat/completions'))(
      makeReq({ body: { model: 'test-adapter:model-a', messages: [{ role: 'user', content: [{ text: 'ignored' }] }] } }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.payload.error.message).toContain('no valid messages');
  });

  it('POST adapter.chat 抛错时映射为 502 upstream_error', async () => {
    const roomAdapterPool = new Map([['test-adapter', { chat: vi.fn(async () => { throw new Error('adapter down'); }) }]]);
    const { routes } = setup({ roomAdapterPool });
    const res = makeRes();

    await handlerOf(find(routes, 'post', '/v1/chat/completions'))(
      makeReq({ body: { model: 'test-adapter:model-a', messages: [{ role: 'user', content: 'hi' }] } }),
      res,
    );

    expect(res.statusCode).toBe(502);
    expect(res.payload.error).toMatchObject({ type: 'upstream_error' });
    expect(res.payload.error.message).toContain('adapter down');
  });

  it('POST stream=true 输出 SSE chunk 和 [DONE]', async () => {
    const roomAdapterPool = new Map([[
      'test-adapter',
      {
        chat: vi.fn(async (_messages, opts) => {
          opts.onProgress('hel');
          opts.onProgress('lo');
          return { reply: 'hello!', tokensIn: 4, tokensOut: 3 };
        }),
      },
    ]]);
    const { routes } = setup({ roomAdapterPool });
    const res = makeRes();

    await handlerOf(find(routes, 'post', '/v1/chat/completions'))(
      makeReq({ body: { model: 'test-adapter:model-a', stream: true, messages: [{ role: 'user', content: 'hi' }] } }),
      res,
    );

    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.body).toContain('"role":"assistant"');
    expect(res.body).toContain('"content":"hel"');
    expect(res.body).toContain('"content":"lo"');
    expect(res.body).toContain('"content":"!"');
    expect(res.body).toContain('data: [DONE]');
    expect(res.ended).toBe(true);
  });

  it('POST stream=true 在 adapter.chat 抛错时输出 upstream_error SSE 并结束响应', async () => {
    const roomAdapterPool = new Map([[
      'test-adapter',
      {
        chat: vi.fn(async () => { throw new Error('stream adapter down'); }),
      },
    ]]);
    const { routes } = setup({ roomAdapterPool });
    const res = makeRes();

    await handlerOf(find(routes, 'post', '/v1/chat/completions'))(
      makeReq({ body: { model: 'test-adapter:model-a', stream: true, messages: [{ role: 'user', content: 'hi' }] } }),
      res,
    );

    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.body).toContain('"role":"assistant"');
    expect(res.body).toContain('"type":"upstream_error"');
    expect(res.body).toContain('stream adapter down');
    expect(res.ended).toBe(true);
  });

  it('未知 /v1 端点返回 404 invalid_request_error', () => {
    const { routes } = setup();
    const res = makeRes();

    handlerOf(find(routes, 'use', '/v1'))(makeReq({ method: 'POST', path: '/responses' }), res);

    expect(res.statusCode).toBe(404);
    expect(res.payload.error).toMatchObject({
      type: 'invalid_request_error',
      message: 'unknown endpoint: POST /responses',
    });
  });
});
