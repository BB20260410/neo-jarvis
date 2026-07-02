import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerNoeBootSelfCheckRoutes } from '../../../src/server/routes/noeBootSelfCheck.js';
import { requireOwnerToken } from '../../../src/server/auth/owner-token.js';

const roots = [];

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'noe-boot-self-check-routes-'));
  roots.push(root);
  for (const file of ['package.json', 'server.js', 'public/mind.html', 'public/mind.js', 'public/src/web/noe-world-earth.js']) {
    const full = join(root, file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file === 'package.json' ? '{"type":"module"}\n' : `${file}\n`);
  }
  return root;
}

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post']) app[method] = (path, ...handlers) => routes.push({ method, path, handlers });
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

function okFetch() {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, service: 'Noe', port: 51835 }),
  });
}

function ownedPanelPreflight({ root }) {
  return {
    ok: true,
    status: 'owned',
    panel: {
      port: 51835,
      safeToRestart: true,
      safeToStart: false,
      listeners: [{ pid: 111, process: { cwd: root, ps: { command: 'node server.js' } } }],
    },
    observeOnly: { port: 51735, listenerCount: 0 },
    blockers: [],
    warnings: [],
  };
}

function evalOwnedPanelPreflight() {
  return {
    ok: true,
    decision: 'restart_owned_panel',
    safeToRestart: true,
    safeToStart: false,
    pid: 111,
    cwd: '/repo/noe',
    command: 'node server.js',
    blockers: [],
    warnings: [],
    observeOnlyPort: 51735,
    observeOnlyListenerCount: 0,
    policy: { secretValuesReturned: false, actionsPerformed: false },
  };
}

function okCompanionPreflight() {
  return {
    ok: true,
    status: 'ok',
    tools: {
      openclaw: { activeVersion: '2026.6.6' },
      hermes: { activeVersion: '0.16.0' },
      clawPanel: { status: 'ok' },
    },
    warnings: [],
    blockers: [],
    policy: {
      readOnly: true,
      configFilesRead: false,
      secretValuesReturned: false,
      actionsPerformed: false,
    },
  };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('Noe boot self-check routes', () => {
  it('registers owner-token protected status, run, and repair endpoints', async () => {
    const { app, routes } = makeApp();
    registerNoeBootSelfCheckRoutes(app, {
      rootDir: makeRoot(),
      fetchImpl: okFetch,
      baseUrl: 'http://127.0.0.1:51835',
      collectPanelRuntimePreflight: ownedPanelPreflight,
      evaluatePanelRestartPreflight: evalOwnedPanelPreflight,
      collectCompanionToolPreflight: okCompanionPreflight,
    });

    for (const path of ['/api/noe/boot-self-check/status']) {
      const route = routes.find((item) => item.method === 'get' && item.path === path);
      expect(route.handlers[0]).toBe(requireOwnerToken);
    }
    for (const path of ['/api/noe/boot-self-check/run', '/api/noe/boot-self-check/repair']) {
      const route = routes.find((item) => item.method === 'post' && item.path === path);
      expect(route.handlers[0]).toBe(requireOwnerToken);
    }

    const statusRes = makeRes();
    await handler(routes, 'get', '/api/noe/boot-self-check/status')({}, statusRes);
    expect(statusRes.payload).toMatchObject({
      ok: true,
      mode: 'status',
      bootSelfCheck: {
        status: 'blocked',
        blockers: ['evidence_output_dir'],
        checks: expect.arrayContaining([
          expect.objectContaining({
            id: 'panel_runtime_preflight',
            status: 'ok',
            detail: expect.objectContaining({ safeToRestart: true, pid: 111 }),
          }),
          expect.objectContaining({
            id: 'policy_file_guard',
            status: 'ok',
            detail: expect.objectContaining({
              writeDenied: true,
              shellDenied: true,
              readOnlyAllowed: true,
              secretValuesReturned: false,
            }),
          }),
          expect.objectContaining({
            id: 'companion_tools_preflight',
            status: 'ok',
            detail: expect.objectContaining({
              tools: expect.objectContaining({
                openclaw: expect.objectContaining({ activeVersion: '2026.6.6' }),
                hermes: expect.objectContaining({ activeVersion: '0.16.0' }),
              }),
            }),
          }),
        ]),
      },
    });

    const repairRes = makeRes();
    await handler(routes, 'post', '/api/noe/boot-self-check/repair')({}, repairRes);
    expect(repairRes.payload).toMatchObject({
      ok: true,
      mode: 'repair',
      bootSelfCheck: {
        ok: true,
        reportPath: expect.stringContaining('output/noe-boot-self-check/boot-self-check-'),
        repair: {
          requested: true,
          actionsPerformed: true,
          summary: {
            attempted: 2,
            repaired: 2,
            failed: 0,
          },
        },
      },
    });
  });
});
