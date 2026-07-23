import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/server/auth/owner-token.js', () => ({
  requireOwnerToken: (req, res, next) => next(),
}));

import { registerSkillsRoutes } from '../../src/server/routes/skills.js';

function createMockApp() {
  const routes = {};
  const make = (method) => (path, ...handlers) => {
    routes[`${method} ${path}`] = handlers;
  };
  return {
    routes,
    get: make('GET'),
    post: make('POST'),
    put: make('PUT'),
    delete: make('DELETE'),
  };
}

function createMockRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { res.statusCode = code; return res; },
    json(data) { res.body = data; return res; },
  };
  return res;
}

describe('registerSkillsRoutes', () => {
  let app;
  let skillStore;

  beforeEach(() => {
    app = createMockApp();
    skillStore = {
      list: vi.fn(),
      get: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      reload: vi.fn(),
    };
    registerSkillsRoutes(app, { skillStore });
  });

  it('GET /api/skills returns the skill list', () => {
    skillStore.list.mockReturnValue([{ name: 'a' }, { name: 'b' }]);
    const [handler] = app.routes['GET /api/skills'];
    const res = createMockRes();
    handler({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, skills: [{ name: 'a' }, { name: 'b' }] });
  });

  it('GET /api/skills returns 500 when list throws', () => {
    skillStore.list.mockImplementation(() => { throw new Error('boom'); });
    const [handler] = app.routes['GET /api/skills'];
    const res = createMockRes();
    handler({}, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'boom' });
  });

  it('GET /api/skills/:name returns the skill when present', () => {
    skillStore.get.mockReturnValue({ name: 'foo', content: 'x' });
    const [handler] = app.routes['GET /api/skills/:name'];
    const res = createMockRes();
    handler({ params: { name: 'foo' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, skill: { name: 'foo', content: 'x' } });
  });

  it('GET /api/skills/:name returns 404 when missing', () => {
    skillStore.get.mockReturnValue(null);
    const [handler] = app.routes['GET /api/skills/:name'];
    const res = createMockRes();
    handler({ params: { name: 'missing' } }, res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'not found' });
  });

  it('GET /api/skills/:name returns 500 when get throws', () => {
    skillStore.get.mockImplementation(() => { throw new Error('oops'); });
    const [handler] = app.routes['GET /api/skills/:name'];
    const res = createMockRes();
    handler({ params: { name: 'foo' } }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'oops' });
  });

  it('POST /api/skills creates a skill', () => {
    skillStore.upsert.mockReturnValue({ name: 'new' });
    const [, handler] = app.routes['POST /api/skills'];
    const res = createMockRes();
    handler({ body: { name: 'new', content: 'c' } }, res);
    expect(skillStore.upsert).toHaveBeenCalledWith({ name: 'new', content: 'c' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, skill: { name: 'new' } });
  });

  it('POST /api/skills returns 413 when body is too large', () => {
    const big = 'x'.repeat(300 * 1024);
    const [, handler] = app.routes['POST /api/skills'];
    const res = createMockRes();
    handler({ body: { content: big } }, res);
    expect(res.statusCode).toBe(413);
    expect(res.body).toEqual({ error: 'body 过大' });
    expect(skillStore.upsert).not.toHaveBeenCalled();
  });

  it('POST /api/skills returns 400 when upsert throws', () => {
    skillStore.upsert.mockImplementation(() => { throw new Error('bad'); });
    const [, handler] = app.routes['POST /api/skills'];
    const res = createMockRes();
    handler({ body: { name: 'x' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'bad' });
  });

  it('POST /api/skills treats missing body as empty object', () => {
    skillStore.upsert.mockReturnValue({ name: 'x' });
    const [, handler] = app.routes['POST /api/skills'];
    const res = createMockRes();
    handler({}, res);
    expect(skillStore.upsert).toHaveBeenCalledWith({});
  });

  it('PUT /api/skills/:name uses name from params', () => {
    skillStore.upsert.mockReturnValue({ name: 'foo' });
    const [, handler] = app.routes['PUT /api/skills/:name'];
    const res = createMockRes();
    handler({ params: { name: 'foo' }, body: { content: 'c' } }, res);
    expect(skillStore.upsert).toHaveBeenCalledWith({ content: 'c', name: 'foo' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, skill: { name: 'foo' } });
  });

  it('PUT /api/skills/:name returns 413 on oversize body', () => {
    const big = 'x'.repeat(300 * 1024);
    const [, handler] = app.routes['PUT /api/skills/:name'];
    const res = createMockRes();
    handler({ params: { name: 'foo' }, body: { content: big } }, res);
    expect(res.statusCode).toBe(413);
    expect(res.body).toEqual({ error: 'body 过大' });
  });

  it('PUT /api/skills/:name returns 400 when upsert throws', () => {
    skillStore.upsert.mockImplementation(() => { throw new Error('nope'); });
    const [, handler] = app.routes['PUT /api/skills/:name'];
    const res = createMockRes();
    handler({ params: { name: 'foo' }, body: { content: 'c' } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('DELETE /api/skills/:name returns 200 on success', () => {
    skillStore.delete.mockReturnValue(true);
    const [, handler] = app.routes['DELETE /api/skills/:name'];
    const res = createMockRes();
    handler({ params: { name: 'foo' } }, res);
    expect(skillStore.delete).toHaveBeenCalledWith('foo');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('DELETE /api/skills/:name returns 404 when not found', () => {
    skillStore.delete.mockReturnValue(false);
    const [, handler] = app.routes['DELETE /api/skills/:name'];
    const res = createMockRes();
    handler({ params: { name: 'missing' } }, res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'not found' });
  });

  it('DELETE /api/skills/:name returns 500 on throw', () => {
    skillStore.delete.mockImplementation(() => { throw new Error('explode'); });
    const [, handler] = app.routes['DELETE /api/skills/:name'];
    const res = createMockRes();
    handler({ params: { name: 'foo' } }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'explode' });
  });

  it('POST /api/skills/reload returns count', () => {
    skillStore.list.mockReturnValue([{}, {}, {}]);
    const [, handler] = app.routes['POST /api/skills/reload'];
    const res = createMockRes();
    handler({}, res);
    expect(skillStore.reload).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, count: 3 });
  });

  it('POST /api/skills/reload returns 500 on throw', () => {
    skillStore.reload.mockImplementation(() => { throw new Error('reload-fail'); });
    const [, handler] = app.routes['POST /api/skills/reload'];
    const res = createMockRes();
    handler({}, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'reload-fail' });
  });

  it('registers owner-token middleware on mutating routes', () => {
    expect(app.routes['POST /api/skills'][0]).toBeDefined();
    expect(app.routes['PUT /api/skills/:name'][0]).toBeDefined();
    expect(app.routes['DELETE /api/skills/:name'][0]).toBeDefined();
    expect(app.routes['POST /api/skills/reload'][0]).toBeDefined();
  });
});
