import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerNoeLocalCouncilRoutes } from '../../../src/server/routes/noeLocalCouncil.js';
import { requireOwnerToken } from '../../../src/server/auth/owner-token.js';
import { NoeUiSignalStore } from '../../../src/runtime/NoeUiSignalStore.js';
import { DEFAULT_LOCAL_COUNCIL_ROOT } from '../../../src/room/NoeLocalModelCouncil.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post']) app[method] = (path, ...handlers) => routes.push({ method, path, handlers });
  return { app, routes };
}

function makeReq({ body = {}, query = {}, headers = {} } = {}) {
  return {
    body,
    query,
    get(name) {
      const lower = String(name || '').toLowerCase();
      return Object.entries(headers).find(([k]) => k.toLowerCase() === lower)?.[1];
    },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
  };
}

describe('Noe local council routes', () => {
  it('registers discover and run endpoints behind owner-token middleware', () => {
    const { app, routes } = makeApp();
    registerNoeLocalCouncilRoutes(app, { sendError: (res, e) => res.status(500).json({ ok: false, error: e.message }) });

    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'get /api/noe/local-models/discover',
      'post /api/noe/local-council/run',
    ]);
    expect(routes.every((r) => r.handlers[0] === requireOwnerToken)).toBe(true);
  });

  it('serves provider discovery through injected discovery implementation', async () => {
    const { app, routes } = makeApp();
    registerNoeLocalCouncilRoutes(app, {
      sendError: (res, e) => res.status(500).json({ ok: false, error: e.message }),
      discover: async () => ({ ok: true, providers: [{ id: 'lmstudio', available: true }], models: [{ id: 'qwen' }] }),
    });
    const route = routes.find((r) => r.path === '/api/noe/local-models/discover');
    const res = makeRes();
    await route.handlers[1](makeReq(), res);

    expect(res.payload).toMatchObject({ ok: true, providers: [{ id: 'lmstudio', available: true }] });
  });

  it('runs a local council and returns ledger path from injected runner', async () => {
    const { app, routes } = makeApp();
    let seenInput = null;
    registerNoeLocalCouncilRoutes(app, {
      sendError: (res, e) => res.status(500).json({ ok: false, error: e.message }),
      runCouncil: async (input) => {
        seenInput = input;
        return { ok: true, finalAnswer: 'done', participants: [], ledgerPath: 'output/noe-local-council/x/ledger.json', blockers: [] };
      },
    });
    const route = routes.find((r) => r.path === '/api/noe/local-council/run');
    const res = makeRes();
    await route.handlers[1](makeReq({ body: { goal: '本地多模型讨论', maxParticipants: 9, reviewRounds: 99 } }), res);

    expect(res.statusCode).toBe(200);
    expect(seenInput.goal).toBe('本地多模型讨论');
    expect(seenInput.maxParticipants).toBe(8);
    expect(seenInput.reviewRounds).toBe(3);
    expect(res.payload.ledgerPath).toBe('output/noe-local-council/x/ledger.json');
  });

  it('uses module-derived root by default instead of caller cwd', async () => {
    const { app, routes } = makeApp();
    const oldCwd = process.cwd();
    const tmp = mkdtempSync(join(tmpdir(), 'noe-local-council-route-cwd-'));
    let seenOpts = null;
    try {
      process.chdir(tmp);
      registerNoeLocalCouncilRoutes(app, {
        sendError: (res, e) => res.status(500).json({ ok: false, error: e.message }),
        runCouncil: async (_input, opts) => {
          seenOpts = opts;
          return { ok: true, finalAnswer: 'done', participants: [], ledgerPath: 'output/noe-local-council/x/ledger.json', blockers: [] };
        },
      });
      const route = routes.find((r) => r.path === '/api/noe/local-council/run');
      const res = makeRes();
      await route.handlers[1](makeReq({ body: { goal: 'root check' } }), res);

      expect(seenOpts.root).toBe(DEFAULT_LOCAL_COUNCIL_ROOT);
      expect(seenOpts.root).not.toBe(tmp);
    } finally {
      process.chdir(oldCwd);
    }
  });

  it('injects consumed UI signal context into council evidence without leaking secrets', async () => {
    const { app, routes } = makeApp();
    const uiSignalStore = new NoeUiSignalStore();
    uiSignalStore.record({
      event: 'card.action',
      component: 'LocalCouncilPanel',
      action: 'open-ledger',
      payload: { apiKey: 'tp-fake-secret-value-for-redaction' },
    });
    let seenInput = null;
    registerNoeLocalCouncilRoutes(app, {
      uiSignalStore,
      sendError: (res, e) => res.status(500).json({ ok: false, error: e.message }),
      runCouncil: async (input) => {
        seenInput = input;
        return { ok: true, finalAnswer: 'done', participants: [], ledgerPath: 'output/noe-local-council/x/ledger.json', blockers: [] };
      },
    });
    const route = routes.find((r) => r.path === '/api/noe/local-council/run');
    const res = makeRes();
    await route.handlers[1](makeReq({ body: { goal: '本地多模型讨论', evidenceText: '用户问题上下文' } }), res);

    expect(res.payload.uiSignalsConsumed).toBe(1);
    expect(seenInput.evidenceText).toContain('用户问题上下文');
    expect(seenInput.evidenceText).toContain('<noe-ui-signals');
    expect(seenInput.evidenceText).toContain('context-only');
    expect(seenInput.evidenceText).toContain('open-ledger');
    expect(seenInput.evidenceText).not.toContain('tp-fake-secret-value-for-redaction');
    expect(uiSignalStore.snapshot().unconsumed).toBe(0);
  });

  it('rejects run requests without a goal', async () => {
    const { app, routes } = makeApp();
    registerNoeLocalCouncilRoutes(app, { sendError: (res, e) => res.status(500).json({ ok: false, error: e.message }) });
    const route = routes.find((r) => r.path === '/api/noe/local-council/run');
    const res = makeRes();
    await route.handlers[1](makeReq({ body: {} }), res);

    expect(res.statusCode).toBe(400);
    expect(res.payload.error).toBe('goal required');
  });
});
