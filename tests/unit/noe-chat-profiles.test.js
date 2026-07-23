import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/server/auth/owner-token.js', () => ({
  requireOwnerToken: (_req, _res, next) => next(),
}));

vi.mock('../../src/voice/ChatModelCatalog.js', () => ({
  discoverChatModels: vi.fn(),
}));

import { registerNoeChatProfileRoutes } from '../../src/server/routes/noeChatProfiles.js';
import { discoverChatModels } from '../../src/voice/ChatModelCatalog.js';

function createFakeApp({ patchExists = true } = {}) {
  const routes = {};
  const app = {
    get(path, ...handlers) { routes[`GET ${path}`] = handlers; return app; },
    post(path, ...handlers) { routes[`POST ${path}`] = handlers; return app; },
    delete(path, ...handlers) { routes[`DELETE ${path}`] = handlers; return app; },
  };
  if (patchExists) {
    app.patch = (path, ...handlers) => { routes[`PATCH ${path}`] = handlers; return app; };
  }
  return { app, routes };
}

function createFakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function createFakeReq({ params = {}, body = {} } = {}) {
  return { params, body };
}

describe('registerNoeChatProfileRoutes', () => {
  let chatProfileStore;
  let sendError;

  beforeEach(() => {
    chatProfileStore = {
      publicList: vi.fn(() => [{ id: 'default', name: 'Default' }]),
      upsert: vi.fn((data) => ({ id: data.id || 'new-id', ...data })),
      delete: vi.fn(() => true),
    };
    sendError = vi.fn((res, e) => {
      res.statusCode = 500;
      res.body = { ok: false, error: e.message };
      return res;
    });
    discoverChatModels.mockReset();
  });

  // GET /api/noe/chat/profiles
  it('lists profiles via GET /api/noe/chat/profiles', () => {
    const { app, routes } = createFakeApp();
    registerNoeChatProfileRoutes(app, { chatProfileStore, sendError });
    const handlers = routes['GET /api/noe/chat/profiles'];
    const res = createFakeRes();
    handlers[handlers.length - 1](createFakeReq(), res);
    expect(chatProfileStore.publicList).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual({
      ok: true,
      profiles: [{ id: 'default', name: 'Default' }],
      defaultId: 'default',
    });
  });

  it('invokes sendError when listing profiles throws', () => {
    chatProfileStore.publicList.mockImplementation(() => { throw new Error('store down'); });
    const { app, routes } = createFakeApp();
    registerNoeChatProfileRoutes(app, { chatProfileStore, sendError });
    const handlers = routes['GET /api/noe/chat/profiles'];
    const res = createFakeRes();
    handlers[handlers.length - 1](createFakeReq(), res);
    expect(sendError).toHaveBeenCalledWith(res, expect.any(Error));
  });

  // GET /api/noe/chat/models
  it('discovers chat models via GET /api/noe/chat/models with injected getAdapter', async () => {
    const getAdapter = vi.fn();
    discoverChatModels.mockResolvedValue({ ok: true, models: [{ id: 'm1' }] });
    const { app, routes } = createFakeApp();
    registerNoeChatProfileRoutes(app, { chatProfileStore, sendError, getAdapter });
    const handlers = routes['GET /api/noe/chat/models'];
    const res = createFakeRes();
    await handlers[handlers.length - 1](createFakeReq(), res);
    expect(discoverChatModels).toHaveBeenCalledWith({ getAdapter });
    expect(res.body).toEqual({ ok: true, models: [{ id: 'm1' }] });
  });

  it('uses null getAdapter when none is provided', async () => {
    discoverChatModels.mockResolvedValue({ ok: true });
    const { app, routes } = createFakeApp();
    registerNoeChatProfileRoutes(app, { chatProfileStore, sendError });
    const handlers = routes['GET /api/noe/chat/models'];
    const res = createFakeRes();
    await handlers[handlers.length - 1](createFakeReq(), res);
    expect(discoverChatModels).toHaveBeenCalledWith({ getAdapter: null });
  });

  it('forwards discoverChatModels errors to sendError', async () => {
    discoverChatModels.mockRejectedValue(new Error('catalog offline'));
    const { app, routes } = createFakeApp();
    registerNoeChatProfileRoutes(app, { chatProfileStore, sendError });
    const handlers = routes['GET /api/noe/chat/models'];
    const res = createFakeRes();
    await handlers[handlers.length - 1](createFakeReq(), res);
    expect(sendError).toHaveBeenCalledWith(res, expect.any(Error));
  });

  // POST /api/noe/chat/profiles
  it('creates a profile via POST /api/noe/chat/profiles', () => {
    const { app, routes } = createFakeApp();
    registerNoeChatProfileRoutes(app, { chatProfileStore, sendError });
    const handlers = routes['POST /api/noe/chat/profiles'];
    const res = createFakeRes();
    handlers[handlers.length - 1](createFakeReq({ body: { name: 'New', prompt: 'hi' } }), res);
    expect(chatProfileStore.upsert).toHaveBeenCalledWith({ name: 'New', prompt: 'hi' });
    expect(res.statusCode).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.profiles).toEqual([{ id: 'default', name: 'Default' }]);
  });

  it('treats missing POST body as an empty object', () => {
    const { app, routes } = createFakeApp();
    registerNoeChatProfileRoutes(app, { chatProfileStore, sendError });
    const handlers = routes['POST /api/noe/chat/profiles'];
    const res = createFakeRes();
    handlers[handlers.length - 1](createFakeReq({ body: undefined }), res);
    expect(chatProfileStore.upsert).toHaveBeenCalledWith({});
  });

  it('rejects POST body larger than 10k chars with 413', () => {
    const { app, routes } = createFakeApp();
    registerNoeChatProfileRoutes(app, { chatProfileStore, sendError });
    const handlers = routes['POST /api/noe/chat/profiles'];
    const res = createFakeRes();
    handlers[handlers.length - 1](createFakeReq({ body: { name: 'x'.repeat(10_001) } }), res);
    expect(res.statusCode).toBe(413);
    expect(res.body).toEqual({ ok: false, error: 'profile body too large' });
    expect(chatProfileStore.upsert).not.toHaveBeenCalled();
  });

  it('forwards POST upsert errors to sendError', () => {
    chatProfileStore.upsert.mockImplementation(() => { throw new Error('persist fail'); });
    const { app, routes } = createFakeApp();
    registerNoeChatProfileRoutes(app, { chatProfileStore, sendError });
    const handlers = routes['POST /api/noe/chat/profiles'];
    const res = createFakeRes();
    handlers[handlers.length - 1](createFakeReq({ body: { name: 'X' } }), res);
    expect(sendError).toHaveBeenCalledWith(res, expect.any(Error));
  });

  // PATCH /api/noe/chat/profiles/:id
  it('updates a profile via PATCH /api/noe/chat/profiles/:id', () => {
    const { app, routes } = createFakeApp();
    registerNoeChatProfileRoutes(app, { chatProfileStore, sendError });
    const handlers = routes['PATCH /api/noe/chat/profiles/:id'];
    const res = createFakeRes();
    handlers[handlers.length - 1](createFakeReq({ params: { id: 'p1' }, body: { name: 'Renamed' } }), res);
    expect(chatProfileStore.upsert).toHaveBeenCalledWith({ id: 'p1', name: 'Renamed' });
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('rejects PATCH body larger than 10k chars with 413', () => {
    const { app, routes } = createFakeApp();
    registerNoeChatProfileRoutes(app, { chatProfileStore, sendError });
    const handlers = routes['PATCH /api/noe/chat/profiles/:id'];
    const res = createFakeRes();
    handlers[handlers.length - 1](createFakeReq({ params: { id: 'p1' }, body: { name: 'y'.repeat(10_001) } }), res);
    expect(res.statusCode).toBe(413);
    expect(chatProfileStore.upsert).not.toHaveBeenCalled();
  });

  it('falls back to POST when app.patch is not a function', () => {
    const { app, routes } = createFakeApp({ patchExists: false });
    registerNoeChatProfileRoutes(app, { chatProfileStore, sendError });
    expect(routes['POST /api/noe/chat/profiles/:id']).toBeDefined();
    expect(routes['PATCH /api/noe/chat/profiles/:id']).toBeUndefined();
  });

  // DELETE /api/noe/chat/profiles/:id
  it('deletes a profile via DELETE /api/noe/chat/profiles/:id', () => {
    const { app, routes } = createFakeApp();
    registerNoeChatProfileRoutes(app, { chatProfileStore, sendError });
    const handlers = routes['DELETE /api/noe/chat/profiles/:id'];
    const res = createFakeRes();
    handlers[handlers.length - 1](createFakeReq({ params: { id: 'p1' } }), res);
    expect(chatProfileStore.delete).toHaveBeenCalledWith('p1');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, profiles: [{ id: 'default', name: 'Default' }] });
  });

  it('returns 404 when deleting a missing profile', () => {
    chatProfileStore.delete.mockReturnValue(false);
    const { app, routes } = createFakeApp();
    registerNoeChatProfileRoutes(app, { chatProfileStore, sendError });
    const handlers = routes['DELETE /api/noe/chat/profiles/:id'];
    const res = createFakeRes();
    handlers[handlers.length - 1](createFakeReq({ params: { id: 'nope' } }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'profile not found' });
  });

  it('returns 400 when store rejects deletion of a built-in profile', () => {
    chatProfileStore.delete.mockImplementation(() => {
      throw new Error('Cannot delete built-in profile "default"');
    });
    const { app, routes } = createFakeApp();
    registerNoeChatProfileRoutes(app, { chatProfileStore, sendError });
    const handlers = routes['DELETE /api/noe/chat/profiles/:id'];
    const res = createFakeRes();
    handlers[handlers.length - 1](createFakeReq({ params: { id: 'default' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/built-in profile/i);
    expect(sendError).not.toHaveBeenCalled();
  });

  it('forwards non built-in DELETE errors to sendError', () => {
    chatProfileStore.delete.mockImplementation(() => { throw new Error('disk failure'); });
    const { app, routes } = createFakeApp();
    registerNoeChatProfileRoutes(app, { chatProfileStore, sendError });
    const handlers = routes['DELETE /api/noe/chat/profiles/:id'];
    const res = createFakeRes();
    handlers[handlers.length - 1](createFakeReq({ params: { id: 'p1' } }), res);
    expect(sendError).toHaveBeenCalledWith(res, expect.any(Error));
  });
});
