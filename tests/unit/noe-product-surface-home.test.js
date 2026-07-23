// @ts-check
import { describe, expect, it } from 'vitest';
import { buildVoiceReadiness, voiceReadinessFromProductLoop } from '../../src/runtime/NoeVoiceReadiness.js';
import {
  buildHomeShellNavigation,
  buildHomeStatusChips,
  validateHomeShellNavigation,
} from '../../src/runtime/NoeHomeShell.js';
import { buildMemoryVisualModel } from '../../src/runtime/NoeMemoryVisual.js';
import { buildProductSurfaceSnapshot } from '../../src/runtime/NoeProductSurface.js';
import { fromThrown, toPublicError } from '../../src/runtime/NoeErrorEnvelope.js';
import express from 'express';
import { createUnifiedTasksRouter } from '../../src/server/routes/unifiedTasks.js';
import { UnifiedTaskStore, resetUnifiedTaskStoreForTests } from '../../src/runtime/UnifiedTaskStore.js';
import { registerVersionRoutes } from '../../src/server/routes/version.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('voice readiness honesty', () => {
  it('missing findings is external_blocked not ok', () => {
    const v = buildVoiceReadiness({});
    expect(v.ready).toBe(false);
    expect(v.status).toBe('external_blocked');
    expect(v.fakeGreen).toBe(false);
  });

  it('error severity is external_blocked', () => {
    const v = buildVoiceReadiness({
      findings: [{ checkId: 'voice.companions', severity: 'error', message: 'whisper 没起' }],
    });
    expect(v.status).toBe('external_blocked');
    expect(v.ready).toBe(false);
  });

  it('maps product loop result', () => {
    const v = voiceReadinessFromProductLoop({
      loop: 'voice',
      doctorVoiceSeverity: 'info',
      doctorVoiceMessage: 'companions idle',
      sttOk: null,
    });
    expect(v.kind).toBe('neo.voice.readiness.v1');
  });
});

describe('home shell IA', () => {
  it('main + settings without expert leak on main', () => {
    const nav = buildHomeShellNavigation();
    const v = validateHomeShellNavigation(nav);
    expect(v.ok).toBe(true);
    expect(nav.main.some((i) => i.id === 'chat')).toBe(true);
    expect(nav.expertReachable.length).toBeGreaterThan(0);
  });

  it('status chips carry mode + voice', () => {
    const chips = buildHomeStatusChips({
      runtimeMode: {
        modeId: 'bailongma_style',
        label: '白龙马式',
        bailongmaStyle: true,
        effectiveEnv: { NOE_PROACTIVE_TICK_MS: '120000' },
      },
      voice: { status: 'external_blocked', ready: false, uiHint: 'x' },
    });
    expect(chips.runtimeMode.bailongmaStyle).toBe(true);
    expect(chips.runtimeMode.proactiveTickMs).toBe('120000');
    expect(chips.voice.ready).toBe(false);
  });
});

describe('memory visual SSOT transform', () => {
  it('empty honest', () => {
    const m = buildMemoryVisualModel([]);
    expect(m.empty).toBe(true);
    expect(m.emptyHint).toMatch(/没有/);
  });

  it('builds timeline and clusters from records', () => {
    const m = buildMemoryVisualModel([
      { id: '1', title: '时区', body: 'Asia/Shanghai', tags: ['profile'], updatedAt: 200, scope: 'user' },
      { id: '2', title: '端口', body: '51835', tags: ['profile', 'neo'], updatedAt: 300, scope: 'project' },
      { id: '3', hidden: true, title: 'hidden', body: 'no' },
    ]);
    expect(m.empty).toBe(false);
    expect(m.nodeCount).toBe(2);
    expect(m.timeline[0].id).toBe('2');
    expect(m.clusters.some((c) => c.label === 'profile')).toBe(true);
    expect(m.edges.length).toBeGreaterThan(0);
  });
});

describe('product surface snapshot', () => {
  it('composes mode + voice + nav + memory', () => {
    const s = buildProductSurfaceSnapshot({
      env: { NOE_RUNTIME_MODE: 'bailongma_style', NOE_PROACTIVE_TICK_MS: '120000' },
      doctorFindings: [{ checkId: 'voice.companions', severity: 'error', message: 'down' }],
      memories: [{ id: 'a', title: 't', body: 'b', tags: ['x'], updatedAt: 1 }],
    });
    expect(s.runtimeMode.modeId).toBe('bailongma_style');
    expect(s.voice.status).toBe('external_blocked');
    expect(s.memoryVisual.nodeCount).toBe(1);
    expect(s.navigation.main.length).toBeGreaterThan(0);
  });
});

describe('write boundary error envelope', () => {
  it('POST unified-tasks disabled returns public envelope', async () => {
    resetUnifiedTaskStoreForTests();
    const store = new UnifiedTaskStore({ env: {} });
    const app = express();
    app.use(express.json());
    app.use(createUnifiedTasksRouter({
      env: { NOE_UNIFIED_TASK_WRITE: '0' },
      taskStore: store,
    }));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address();
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/noe/unified-tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal: 'x' }),
      });
      expect(r.status).toBe(403);
      const j = await r.json();
      expect(j.errorEnvelope.kind).toBe('neo.error.envelope.v1');
      const pub = toPublicError(fromThrown(new Error('secret'), { code: 'x', category: 'internal' }));
      expect(pub).not.toHaveProperty('cause');
    } finally {
      await new Promise((r) => server.close(() => r(null)));
    }
  });
});

describe('version exposes runtimeMode + voice for UI', () => {
  it('GET /api/version includes statusChips', async () => {
    const app = express();
    registerVersionRoutes(app, {
      rootDir,
      getVoiceFindings: () => [{ checkId: 'voice.companions', severity: 'error', message: '没起' }],
    });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address();
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/version`);
      const j = await r.json();
      expect(j.ok).toBe(true);
      expect(j.runtimeMode).toBeTruthy();
      expect(j.voiceReadiness.status).toBe('external_blocked');
      expect(j.statusChips.voice.ready).toBe(false);
    } finally {
      await new Promise((r) => server.close(() => r(null)));
    }
  });

  it('production getVoiceFindings info severity can yield ready ok', async () => {
    const app = express();
    registerVersionRoutes(app, {
      rootDir,
      getVoiceFindings: async () => [
        { checkId: 'voice.companions', severity: 'info', message: '伴生语音服务全部在线' },
      ],
    });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address();
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/version`);
      const j = await r.json();
      expect(j.voiceReadiness.ready).toBe(true);
      expect(j.voiceReadiness.status).toBe('ok');
      expect(j.voiceReadiness.fakeGreen).toBe(false);
    } finally {
      await new Promise((r) => server.close(() => r(null)));
    }
  });
});

describe('panel owner token bootstrap + memory path', () => {
  it('extracts t= and builds X-Panel-Owner-Token headers', async () => {
    const {
      extractOwnerTokenFromSearch,
      bootstrapOwnerTokenFromSearch,
      resolvePanelOwnerToken,
      ownerAuthHeaders,
      redirectPathPreservingQuery,
      PANEL_OWNER_TOKEN_STORAGE_KEY,
    } = await import('../../src/runtime/NoePanelOwnerToken.js');

    const token = 'a'.repeat(32);
    expect(extractOwnerTokenFromSearch(`?t=${token}&electron=1`)).toBe(token);
    expect(redirectPathPreservingQuery(`/?t=${token}&electron=1`, '/home.html')).toBe(
      `/home.html?t=${token}&electron=1`,
    );

    const store = new Map();
    const sessionStore = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => { store.set(k, v); },
    };
    const boot = bootstrapOwnerTokenFromSearch(`?t=${token}&electron=1`, sessionStore, sessionStore);
    expect(boot.bootstrapped).toBe(true);
    expect(boot.token).toBe(token);
    expect(boot.searchWithoutToken).toBe('?electron=1');
    expect(resolvePanelOwnerToken(sessionStore, sessionStore)).toBe(token);
    expect(ownerAuthHeaders(token)['X-Panel-Owner-Token']).toBe(token);
    expect(PANEL_OWNER_TOKEN_STORAGE_KEY).toBe('panel-owner-token');
  });

  it('memory/search with correct token feeds buildMemoryVisualModel (integration)', async () => {
    const { ownerAuthHeaders } = await import('../../src/runtime/NoePanelOwnerToken.js');
    const token = 'b'.repeat(32);
    const memories = [
      { id: 'm1', title: '时区', body: 'Asia/Shanghai', tags: ['profile'], updatedAt: 100 },
      { id: 'm2', title: '端口', body: '51835', tags: ['profile'], updatedAt: 200 },
    ];
    const app = express();
    app.get('/api/noe/mind/memory/search', (req, res) => {
      const provided = (req.get('X-Panel-Owner-Token') || '').trim();
      if (provided !== token) return res.status(401).json({ error: 'owner token required' });
      res.json({ ok: true, enabled: true, items: memories });
    });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address();
    try {
      const bad = await fetch(`http://127.0.0.1:${port}/api/noe/mind/memory/search?q=&limit=40`);
      expect(bad.status).toBe(401);

      const good = await fetch(`http://127.0.0.1:${port}/api/noe/mind/memory/search?q=&limit=40`, {
        headers: ownerAuthHeaders(token),
      });
      expect(good.status).toBe(200);
      const j = await good.json();
      const model = buildMemoryVisualModel(j.items);
      expect(model.empty).toBe(false);
      expect(model.nodeCount).toBe(2);
      expect(model.timeline[0].id).toBe('m2');
    } finally {
      await new Promise((r) => server.close(() => r(null)));
    }
  });
});

describe('root redirect preserves query', () => {
  it('redirectPathPreservingQuery keeps t and electron', async () => {
    const { redirectPathPreservingQuery } = await import('../../src/runtime/NoePanelOwnerToken.js');
    const token = 'c'.repeat(40);
    expect(redirectPathPreservingQuery(`/?t=${token}&electron=1`, '/home.html')).toBe(
      `/home.html?t=${token}&electron=1`,
    );
    expect(redirectPathPreservingQuery('/', '/home.html')).toBe('/home.html');
  });
});
