import { describe, expect, it } from 'vitest';
import { requireOwnerToken } from '../../../src/server/auth/owner-token.js';
import { registerNoeCommandRoutes } from '../../../src/server/routes/noeCommands.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post']) app[method] = (path, ...handlers) => routes.push({ method, path, handlers });
  return { app, routes };
}

function makeReq({ query = {}, body = {}, params = {} } = {}) {
  return { query, body, params, get: () => undefined };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
  };
}

function registerWithToolRegistry(toolRegistry) {
  const { app, routes } = makeApp();
  registerNoeCommandRoutes(app, {
    toolRegistry,
    sendError: (res, e) => res.status(500).json({ ok: false, error: e.message }),
  });
  return routes;
}

describe('Noe command routes', () => {
  it('registers discover, route, help, and dry-run behind owner-token middleware', () => {
    const routes = registerWithToolRegistry({ list: () => [] });

    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      'get /api/noe/commands/discover',
      'get /api/noe/commands/:id/help',
      'post /api/noe/commands/:id/dry-run',
      'post /api/noe/commands/route',
    ]);
    expect(routes.every((route) => route.handlers[0] === requireOwnerToken)).toBe(true);
  });

  it('serves help and dry-run schemas without invoking tools or leaking input secrets', async () => {
    const toolRegistry = {
      list: () => [{ id: 'noe.fs.search', name: '只读文件检索', description: '搜索文件', operation: 'noe.fs.search', risk_level: 'low', category: 'files' }],
      invoke: async () => { throw new Error('dry-run must not execute tools'); },
    };
    const routes = registerWithToolRegistry(toolRegistry);
    const help = routes.find((route) => route.path === '/api/noe/commands/:id/help');
    const dryRun = routes.find((route) => route.path === '/api/noe/commands/:id/dry-run');

    const helpRes = makeRes();
    await help.handlers[1](makeReq({ params: { id: 'noe.fs.search' } }), helpRes);
    expect(helpRes.payload).toMatchObject({ ok: true, commandId: 'noe.fs.search', dryRunSupported: true });
    expect(helpRes.payload.inputSchema?.type).toBe('object');

    const dryRunRes = makeRes();
    await dryRun.handlers[1](makeReq({
      params: { id: 'noe.fs.search' },
      body: { input: { query: 'README', apiKey: 'tp-unitsecret000000000000000000000000000000' } },
    }), dryRunRes);
    expect(dryRunRes.payload).toMatchObject({ ok: true, dryRun: true, wouldExecute: false, commandId: 'noe.fs.search' });
    expect(dryRunRes.payload.inputPreview.apiKey).toBe('[redacted]');
    expect(JSON.stringify(dryRunRes.payload)).not.toContain('tp-unitsecret');
  });

  it('keeps high-risk commands hidden even if request payload claims approval', async () => {
    const routes = registerWithToolRegistry({
      list: () => [{ id: 'noe.files.delete', name: '删除文件', description: '删除本地文件', operation: 'delete', risk_level: 'high', category: 'filesystem' }],
    });
    const route = routes.find((item) => item.path === '/api/noe/commands/route');
    const dryRun = routes.find((item) => item.path === '/api/noe/commands/:id/dry-run');

    const routeRes = makeRes();
    await route.handlers[1](makeReq({ body: { goal: '删除旧文件', permissionState: { userApproved: true } } }), routeRes);
    expect(routeRes.payload.hidden.map((item) => item.id)).toContain('noe.files.delete');
    expect(routeRes.payload.injected.map((item) => item.id)).not.toContain('noe.files.delete');

    const dryRunRes = makeRes();
    await dryRun.handlers[1](makeReq({ params: { id: 'noe.files.delete' }, body: { includeHidden: true, permissionState: { userApproved: true } } }), dryRunRes);
    expect(dryRunRes.statusCode).toBe(409);
    expect(dryRunRes.payload).toMatchObject({ ok: false, error: 'permission_required_before_dry_run' });
  });
});
