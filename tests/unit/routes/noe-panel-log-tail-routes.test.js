import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { requireOwnerToken } from '../../../src/server/auth/owner-token.js';
import { registerNoePanelLogTailRoutes } from '../../../src/server/routes/noePanelLogTail.js';

const roots = [];

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'noe-panel-log-tail-routes-'));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  return root;
}

function makeApp() {
  const routes = [];
  const app = {
    get: (path, ...handlers) => routes.push({ method: 'get', path, handlers }),
  };
  return { app, routes };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
  };
}

function handler(routes, method, path) {
  return routes.find((item) => item.method === method && item.path === path).handlers.at(-1);
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('Noe panel log tail route', () => {
  it('registers an owner-token protected bounded redacted tail endpoint', async () => {
    const root = makeRoot();
    const logFile = join(root, 'noe-panel-51835.log');
    writeFileSync(logFile, [
      '启动完成',
      'owner-token=secret-token-value',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
      '健康检查通过',
    ].join('\n'));
    const { app, routes } = makeApp();
    registerNoePanelLogTailRoutes(app, { defaultLogPath: () => logFile });

    const route = routes.find((item) => item.method === 'get' && item.path === '/api/noe/panel-log-tail');
    expect(route.handlers[0]).toBe(requireOwnerToken);

    const res = makeRes();
    await handler(routes, 'get', '/api/noe/panel-log-tail')({ query: { limit: '3', maxBytes: '4096' } }, res);
    const text = res.payload.panelLogTail.lines.join('\n');
    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({
      ok: true,
      panelLogTail: {
        ok: true,
        status: 'ok',
        lineCount: 3,
        secretValuesReturned: false,
        actionsPerformed: false,
      },
      policy: {
        readOnly: true,
        bounded: true,
        redacted: true,
        secretValuesReturned: false,
        actionsPerformed: false,
      },
    });
    expect(text).toContain('[redacted]');
    expect(text).not.toContain('secret-token-value');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
  });

  it('reports a missing panel log without exposing arbitrary file reads', async () => {
    const missingLog = join(makeRoot(), 'missing.log');
    const { app, routes } = makeApp();
    registerNoePanelLogTailRoutes(app, { defaultLogPath: () => missingLog });

    const res = makeRes();
    await handler(routes, 'get', '/api/noe/panel-log-tail')({ query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({
      ok: true,
      panelLogTail: {
        status: 'missing',
        lineCount: 0,
        lines: [],
        secretValuesReturned: false,
        actionsPerformed: false,
      },
    });
  });
});
