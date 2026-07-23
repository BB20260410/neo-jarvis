import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { registerNoeRoutes } from '../../../src/server/routes/noe.js';
import { requireOwnerToken } from '../../../src/server/auth/owner-token.js';
import { ChatProfileStore } from '../../../src/voice/ChatProfileStore.js';
import { OwnerGateStore } from '../../../src/voice/OwnerGateStore.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post', 'patch', 'delete']) {
    app[method] = (path, ...handlers) => routes.push({ method, path, handlers });
  }
  return { app, routes };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
  };
}

function makeReq({ query = {}, body = {}, params = {}, headers = {} } = {}) {
  return {
    query,
    body,
    params,
    get(name) {
      const lower = String(name || '').toLowerCase();
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === lower) return value;
      }
      return undefined;
    },
  };
}

describe('noe routes', () => {
  it('registers health, loop, memory, focus, and tools endpoints', async () => {
    const deps = {
      loop: {
        status: () => ({ state: 'stopped', tickCount: 0 }),
        start: () => ({ state: 'idle' }),
        stop: () => ({ state: 'stopped' }),
        pause: () => ({ state: 'paused' }),
        resume: () => ({ state: 'idle' }),
        tick: async () => ({ ok: true, event: { tickCount: 1 } }),
      },
      memory: {
        recall: () => [{ id: 'mem-1' }],
        write: () => ({ id: 'mem-2' }),
        hide: () => true,
        stats: () => ({ total: 1, visible: 1, hidden: 0, fts: true }),
      },
      focus: {
        list: () => [{ id: 'focus-1' }],
        push: () => ({ id: 'focus-2' }),
        pop: () => ({ id: 'focus-1', state: 'popped' }),
        depth: () => 1,
      },
      toolRegistry: {
        list: () => [{ id: 'tool-1', enabled: false }],
        register: () => ({ id: 'tool-2', enabled: false }),
        setEnabled: () => ({ id: 'tool-1', enabled: true }),
        invoke: async () => ({ ok: false, status: 403, error: 'tool disabled' }),
      },
      approvalStore: {
        listApprovals: () => [{ id: 'approval-1', status: 'pending' }],
      },
      actStore: {
        list: () => [{ id: 'act-1', status: 'completed' }],
        summary: () => ({ pending: 0, current: { id: 'act-1', status: 'completed' } }),
        cancel: () => ({ id: 'act-1', status: 'cancelled' }),
      },
      actPipeline: {
        propose: async () => ({ ok: true, act: { id: 'act-2', status: 'completed' } }),
      },
    };
    const { app, routes } = makeApp();
    registerNoeRoutes(app, deps);

    const health = routes.find((r) => r.method === 'get' && r.path === '/api/noe/health');
    const res = makeRes();
    await health.handlers[1](makeReq(), res);
    expect(res.payload).toMatchObject({
      ok: true,
      loop: { state: 'stopped' },
      memory: { visible: 1 },
      focus: { depth: 1 },
      approvals: { pending: 1 },
      acts: { pending: 0 },
    });

    const readiness = routes.find((r) => r.method === 'get' && r.path === '/api/noe/readiness');
    const readinessRes = makeRes();
    await readiness.handlers.at(-1)(makeReq(), readinessRes);
    expect(readinessRes.payload).toMatchObject({
      ok: true,
      readiness: { status: 'passed', blockers: [] },
      checks: { loop: 'passed', memory: 'passed', fileIndex: 'passed' },
      counts: { memoryVisible: 1, focusDepth: 1, pendingApprovals: 1, pendingActs: 0 },
    });

    expect(routes.find((r) => r.path === '/api/noe/loop/status')).toBeTruthy();
    expect(routes.find((r) => r.path === '/api/noe/memory')).toBeTruthy();
    expect(routes.find((r) => r.path === '/api/noe/focus')).toBeTruthy();
    expect(routes.find((r) => r.path === '/api/noe/tools')).toBeTruthy();
    expect(routes.find((r) => r.path === '/api/noe/tools/:id/invoke')).toBeTruthy();
    expect(routes.find((r) => r.path === '/api/noe/commands/discover')).toBeTruthy();
    expect(routes.find((r) => r.path === '/api/noe/commands/:id/help')).toBeTruthy();
    expect(routes.find((r) => r.path === '/api/noe/commands/:id/dry-run')).toBeTruthy();
    expect(routes.find((r) => r.path === '/api/noe/commands/route')).toBeTruthy();
    expect(routes.find((r) => r.path === '/api/noe/acts')).toBeTruthy();
    expect(routes.find((r) => r.path === '/api/noe/acts/propose')).toBeTruthy();
    expect(routes.find((r) => r.path === '/api/noe/acts/:id/cancel')).toBeTruthy();
    expect(routes.find((r) => r.path === '/api/noe/local-models/discover')).toBeTruthy();
    expect(routes.find((r) => r.path === '/api/noe/local-council/run')).toBeTruthy();
    expect(routes.find((r) => r.path === '/api/noe/taskflows')).toBeTruthy();
    expect(routes.find((r) => r.path === '/api/noe/taskflows/:id/steps/:stepId')).toBeTruthy();
    expect(routes.find((r) => r.path === '/api/noe/tasks/reportbacks')).toBeTruthy();
    expect(routes.find((r) => r.path === '/api/noe/tasks/reportbacks/speech-ack')).toBeTruthy();
    expect(routes.find((r) => r.path === '/api/noe/vision/status')).toBeTruthy();
    expect(routes.find((r) => r.path === '/api/noe/vision/ambient')).toBeTruthy();
    expect(routes.find((r) => r.path === '/api/noe/vision/situation')).toBeTruthy();
    expect(routes.find((r) => r.path === '/api/noe/chat/routing')).toBeTruthy();
    expect(routes.find((r) => r.path === '/api/noe/doctor')).toBeTruthy();
    expect(routes.find((r) => r.path === '/api/noe/ui-signals')).toBeTruthy();
    expect(routes.find((r) => r.path === '/api/noe/ui-signals/consume')).toBeTruthy();
    expect(['/api/noe/acui/cards', '/api/noe/acui/cards/show'].every((path) => routes.find((r) => r.path === path))).toBe(true);
    expect(routes.find((r) => r.path === '/api/noe/freedom/capabilities')).toBeTruthy();
    expect(routes.find((r) => r.path === '/api/noe/freedom/dry-run')).toBeTruthy();
    expect(routes.find((r) => r.path === '/api/noe/freedom/execute')).toBeTruthy();

    const acts = routes.find((r) => r.method === 'get' && r.path === '/api/noe/acts');
    const actsRes = makeRes();
    await acts.handlers[1](makeReq(), actsRes);
    expect(actsRes.payload).toMatchObject({ ok: true, count: 1, items: [{ id: 'act-1' }] });
  });

  it('exposes ambient vision status and explicit opt-in controls', async () => {
    const deps = {
      loop: { status: () => ({ state: 'stopped' }) },
      memory: {
        recall: () => [],
        write: () => null,
        stats: () => ({ total: 0, visible: 0, hidden: 0, fts: true }),
      },
      focus: { list: () => [], depth: () => 0 },
      toolRegistry: { list: () => [] },
      approvalStore: { listApprovals: () => [] },
      modelSettings: { setFaceEnabled: () => ({ face: { enabled: true } }) },
    };
    const { app, routes } = makeApp();
    registerNoeRoutes(app, deps);

    const status = routes.find((r) => r.method === 'get' && r.path === '/api/noe/vision/status');
    const statusRes = makeRes();
    await status.handlers[1](makeReq(), statusRes);
    expect(statusRes.payload).toMatchObject({
      ok: true,
      ambient: { enabled: false, mode: 'off', localOnly: true },
      privacy: { explicitOwnerToggleRequired: true, rawFramesPersisted: false },
    });

    const ambient = routes.find((r) => r.method === 'post' && r.path === '/api/noe/vision/ambient');
    const ambientRes = makeRes();
    await ambient.handlers[1](makeReq({ body: { enabled: true, mode: 'both', screenSampleMs: 7000, cameraFrameMs: 2000, source: 'unit' } }), ambientRes);
    expect(ambientRes.payload).toMatchObject({
      ok: true,
      ambient: {
        enabled: true,
        mode: 'both',
        requiresCameraFramePush: true,
        screenSampleMs: 7000,
        cameraFrameMs: 2000,
        source: 'unit',
      },
      privacy: { cameraRequiresBrowserPermission: true, canDisableWithModeOff: true },
    });

    const situation = routes.find((r) => r.method === 'get' && r.path === '/api/noe/vision/situation');
    const situationRes = makeRes();
    await situation.handlers[1](makeReq(), situationRes);
    expect(situationRes.payload).toMatchObject({
      ok: true,
      ambient: { enabled: true, mode: 'both' },
      situation: null,
      privacy: { rawFramesPersisted: false, localOnly: true },
    });
  });

  it('exposes foreground cloud routing without changing the background local brain', async () => {
    const adapters = {
      minimax: { id: 'minimax', model: 'MiniMax-M3', displayName: 'MiniMax M3' },
      lmstudio: { id: 'lmstudio', model: 'qwen/qwen3.6-35b-a3b', displayName: 'LM Studio Main Brain' },
    };
    const deps = {
      loop: { status: () => ({ state: 'stopped' }) },
      memory: {
        recall: () => [],
        write: () => null,
        stats: () => ({ total: 0, visible: 0, hidden: 0, fts: true }),
      },
      focus: { list: () => [], depth: () => 0 },
      toolRegistry: { list: () => [] },
      approvalStore: { listApprovals: () => [] },
      brainRouter: { route: () => ({ tierMap: { local: 'lmstudio' } }) },
      getAdapter: (id) => adapters[id] || null,
      foregroundChatRouting: {
        cloudOnly: true,
        cloudAdapterChain: ['minimax', 'claude'],
        localAdapterIds: ['ollama', 'lmstudio'],
      },
    };
    const { app, routes } = makeApp();
    registerNoeRoutes(app, deps);

    const route = routes.find((r) => r.method === 'get' && r.path === '/api/noe/chat/routing');
    const res = makeRes();
    await route.handlers[1](makeReq(), res);
    expect(res.payload).toMatchObject({
      ok: true,
      foreground: {
        mode: 'cloud_only',
        cloudOnly: true,
        cloudAdapterChain: ['minimax', 'claude'],
        availableCloudAdapters: ['minimax'],
        localAdapterIds: ['ollama', 'lmstudio'],
        localAdaptersExcluded: true,
      },
      background: {
        unchanged: true,
        localAdapterId: 'lmstudio',
        adapter: { id: 'lmstudio', available: true, model: 'qwen/qwen3.6-35b-a3b' },
      },
    });
    expect(res.payload.foreground.adapters).toEqual([
      { id: 'minimax', available: true, model: 'MiniMax-M3', displayName: 'MiniMax M3' },
      { id: 'claude', available: false, model: null, displayName: null },
    ]);
  });

  it('exposes command discovery and routing without executing or trusting payload approval', async () => {
    const deps = {
      loop: { status: () => ({ state: 'stopped' }) },
      memory: { recall: () => [], stats: () => ({ total: 0, visible: 0, hidden: 0, fts: true }) },
      focus: { list: () => [], depth: () => 0 },
      toolRegistry: {
        list: () => [
          { id: 'noe.fs.search', name: '只读文件检索', description: '搜索文件', operation: 'noe.fs.search', risk_level: 'low', category: 'readonly' },
          { id: 'noe.files.delete', name: '删除文件', description: '删除本地文件', operation: 'delete', risk_level: 'high', category: 'filesystem' },
        ],
        invoke: async () => {
          throw new Error('command discovery must not execute tools');
        },
      },
      approvalStore: { listApprovals: () => [] },
    };
    const { app, routes } = makeApp();
    registerNoeRoutes(app, deps);

    const discover = routes.find((r) => r.method === 'get' && r.path === '/api/noe/commands/discover');
    const discoverRes = makeRes();
    await discover.handlers[1](makeReq({ query: { q: '文件', includeHidden: 'true' } }), discoverRes);
    expect(discoverRes.payload.ok).toBe(true);
    expect(discoverRes.payload.visibleCommands.map((item) => item.id)).toContain('noe.find_tool');
    expect(discoverRes.payload.search.results.map((item) => item.id)).toContain('noe.fs.search');
    expect(discoverRes.payload.hiddenCommands.find((item) => item.id === 'noe.files.delete')).toMatchObject({
      hiddenReason: 'permission_required_before_injection',
      riskLevel: 'high',
    });

    const route = routes.find((r) => r.method === 'post' && r.path === '/api/noe/commands/route');
    const routeRes = makeRes();
    await route.handlers[1](makeReq({
      body: {
        goal: '删除旧文件',
        permissionState: { userApproved: true, consensusApproved: true },
        extraCommands: [{ id: 'noe.secret.value', description: 'XIAOMI_API_KEY=tp-unit-test-redaction-key-00000000000000000000', riskLevel: 'low' }],
      },
    }), routeRes);
    const injectedIds = routeRes.payload.injected.map((item) => item.id);
    expect(routeRes.payload.ok).toBe(true);
    expect(injectedIds).toContain('noe.find_tool');
    expect(injectedIds).not.toContain('noe.files.delete');
    expect(routeRes.payload.hidden.map((item) => item.id)).toContain('noe.files.delete');
    expect(JSON.stringify(routeRes.payload)).not.toContain('tp-unit-test-redaction-key');

  });

  it('keeps every Noe API route behind owner-token middleware and returns 401 before handlers', () => {
    const deps = {
      loop: { status: () => ({ state: 'stopped' }) },
      memory: { recall: () => [], stats: () => ({ total: 0, visible: 0, hidden: 0, fts: true }) },
      focus: { list: () => [], depth: () => 0 },
      toolRegistry: { list: () => [] },
      approvalStore: { listApprovals: () => [] },
    };
    const { app, routes } = makeApp();
    registerNoeRoutes(app, deps);

    expect(routes.length).toBeGreaterThan(0);
    const publicNoeRoutes = new Set([
      '/api/noe/readiness',
      // Provider webhook callbacks must stay public; their protection is provider signature/token
      // verification, covered by tests/unit/routes/noe-social-inbound-routes.test.js.
      '/api/noe/social-inbound/wechat-official',
      '/api/noe/social-inbound/wecom',
      '/api/noe/social-inbound/feishu',
    ]);
    expect(routes.filter((route) => !publicNoeRoutes.has(route.path)).every((route) => route.handlers[0] === requireOwnerToken)).toBe(true);
    expect(routes.find((route) => route.path === '/api/noe/readiness')?.handlers[0]).not.toBe(requireOwnerToken);

    const health = routes.find((route) => route.method === 'get' && route.path === '/api/noe/health');
    const res = makeRes();
    health.handlers[0](makeReq(), res, () => {
      throw new Error('owner-token middleware should stop unauthorized Noe route requests');
    });

    expect(res.statusCode).toBe(401);
    expect(res.payload).toMatchObject({ error: expect.stringContaining('owner token required') });
  });

  it('serves task reportbacks for continuous visible execution status', async () => {
    const incidents = [];
    const systemSpeech = [];
    let storedSpeechItem = { id: 'trb-1', spokenAt: null, speechFailedAt: null, systemSpeechFallbackAt: null, systemSpeechFallback: null };
    const deps = {
      loop: { status: () => ({ state: 'stopped' }) },
      memory: { recall: () => [], stats: () => ({ total: 0, visible: 0, hidden: 0, fts: true }) },
      focus: { list: () => [], depth: () => 0 },
      toolRegistry: { list: () => [] },
      approvalStore: { listApprovals: () => [] },
      taskReportbacks: {
        consume: () => [{ id: 'trb-1', goalId: 'g-1', taskId: 'g-1', title: '主人委托：排查语音', status: 'running', summary: '行动执行中' }],
        current: () => [{ id: 'trb-2', goalId: 'g-1', taskId: 'g-1', title: '主人委托：排查语音', status: 'running' }],
        markSpoken: (id, opts = {}) => {
          if (id !== 'trb-1') return null;
          storedSpeechItem = {
            ...storedSpeechItem,
            spokenAt: opts.ok === false ? null : 123,
            speechFailedAt: opts.ok === false ? 124 : null,
            speechError: opts.error || null,
            ...(opts.systemSpeechFallback ? { systemSpeechFallbackAt: 125, systemSpeechFallback: opts.systemSpeechFallback } : {}),
          };
          return { ...storedSpeechItem };
        },
      },
      incidentEscalator: { observe: (event) => incidents.push(event) },
      taskReportbackSystemSpeech: async (item, event) => { systemSpeech.push({ item, event }); return { attempted: true, command: 'afplay', provider: 'minimax' }; },
    };
    const { app, routes } = makeApp();
    registerNoeRoutes(app, deps);

    const route = routes.find((r) => r.method === 'post' && r.path === '/api/noe/tasks/reportbacks');
    const res = makeRes();
    await route.handlers[1](makeReq({ body: { consume: true, current: true } }), res);
    expect(res.payload).toMatchObject({
      ok: true,
      items: [{ id: 'trb-1', status: 'running' }],
      current: [{ id: 'trb-2', goalId: 'g-1' }],
    });

    const ack = routes.find((r) => r.method === 'post' && r.path === '/api/noe/tasks/reportbacks/speech-ack');
    const ackRes = makeRes();
    await ack.handlers[1](makeReq({ body: { id: 'trb-1', ok: true } }), ackRes);
    expect(ackRes.payload).toMatchObject({ ok: true, item: { id: 'trb-1' } });
    expect(incidents).toHaveLength(0);

    const failRes = makeRes();
    await ack.handlers[1](makeReq({ body: { id: 'trb-1', ok: false, error: 'play_failed' } }), failRes);
    expect(failRes.payload).toMatchObject({
      ok: true,
      item: { id: 'trb-1', systemSpeechFallback: { attempted: true, command: 'afplay', provider: 'minimax' } },
      systemSpeechFallback: { attempted: true, command: 'afplay', provider: 'minimax' },
    });
    expect(incidents).toHaveLength(0);
    expect(systemSpeech[0]).toMatchObject({ item: { id: 'trb-1' }, event: { error: 'play_failed' } });

    const repeatFailRes = makeRes();
    await ack.handlers[1](makeReq({ body: { id: 'trb-1', ok: false, error: 'play_failed_again' } }), repeatFailRes);
    expect(repeatFailRes.payload).toMatchObject({
      ok: true,
      deduped: true,
      systemSpeechFallback: { attempted: true, command: 'afplay', provider: 'minimax' },
    });
    expect(systemSpeech).toHaveLength(1);
    expect(incidents).toHaveLength(0);
  });

  it('does not use system speech fallback by default for browser task playback timeouts', async () => {
    let storedSpeechItem = { id: 'trb-timeout', spokenAt: null, speechFailedAt: null, systemSpeechFallbackAt: null, systemSpeechFallback: null };
    const deps = {
      loop: { status: () => ({ state: 'stopped' }) },
      memory: { recall: () => [], stats: () => ({ total: 0, visible: 0, hidden: 0, fts: true }) },
      focus: { list: () => [], depth: () => 0 },
      toolRegistry: { list: () => [] },
      approvalStore: { listApprovals: () => [] },
      taskReportbacks: {
        consume: () => [],
        current: () => [],
        markSpoken: (id, opts = {}) => {
          if (id !== 'trb-timeout') return null;
          storedSpeechItem = {
            ...storedSpeechItem,
            spokenAt: opts.ok === false ? null : 123,
            speechFailedAt: opts.ok === false ? 124 : null,
            speechError: opts.error || null,
            ...(opts.systemSpeechFallback ? { systemSpeechFallbackAt: 125, systemSpeechFallback: opts.systemSpeechFallback } : {}),
          };
          return { ...storedSpeechItem };
        },
      },
    };
    const { app, routes } = makeApp();
    registerNoeRoutes(app, deps);

    const ack = routes.find((r) => r.method === 'post' && r.path === '/api/noe/tasks/reportbacks/speech-ack');
    const res = makeRes();
    await ack.handlers[1](makeReq({ body: { id: 'trb-timeout', ok: false, error: 'play_start_timeout' } }), res);

    expect(res.payload).toMatchObject({
      ok: true,
      item: {
        id: 'trb-timeout',
        speechFailedAt: 124,
        speechError: 'play_start_timeout',
      },
      systemSpeechFallback: { attempted: false, reason: 'disabled' },
    });
    expect(res.payload.item.systemSpeechFallbackAt).toBe(125);
    expect(res.payload.item.systemSpeechFallback).toMatchObject({ attempted: false, reason: 'disabled' });
  });

  it('maps route failures to deterministic status codes', async () => {
    const deps = {
      loop: { status: () => ({ state: 'stopped' }) },
      memory: {
        recall: () => [],
        write: () => { throw new Error('memory body required'); },
        hide: () => false,
        stats: () => ({ total: 0, visible: 0, hidden: 0, fts: true }),
      },
      focus: {
        list: () => [],
        push: () => { throw new Error('focus title required'); },
        pop: () => null,
        depth: () => 0,
      },
      toolRegistry: {
        list: () => [],
        register: () => { throw new Error('invalid tool manifest'); },
        setEnabled: () => null,
      },
      approvalStore: { listApprovals: () => [] },
    };
    const { app, routes } = makeApp();
    registerNoeRoutes(app, deps);

    const postMemory = routes.find((r) => r.method === 'post' && r.path === '/api/noe/memory');
    const postMemoryRes = makeRes();
    await postMemory.handlers[1](makeReq(), postMemoryRes);
    expect(postMemoryRes.statusCode).toBe(400);
    expect(postMemoryRes.payload).toMatchObject({ ok: false, error: 'memory body required' });

    const deleteMemory = routes.find((r) => r.method === 'delete' && r.path === '/api/noe/memory/:id');
    const deleteMemoryRes = makeRes();
    await deleteMemory.handlers[1](makeReq({ params: { id: 'missing' } }), deleteMemoryRes);
    expect(deleteMemoryRes.statusCode).toBe(404);
    expect(deleteMemoryRes.payload).toMatchObject({ ok: false, error: 'memory not found' });

    const popFocus = routes.find((r) => r.method === 'post' && r.path === '/api/noe/focus/:id/pop');
    const popFocusRes = makeRes();
    await popFocus.handlers[1](makeReq({ params: { id: 'missing' } }), popFocusRes);
    expect(popFocusRes.statusCode).toBe(404);
    expect(popFocusRes.payload).toMatchObject({ ok: false, error: 'focus item not found' });

    const enableTool = routes.find((r) => r.method === 'post' && r.path === '/api/noe/tools/:id/enable');
    const enableToolRes = makeRes();
    await enableTool.handlers[1](makeReq({ params: { id: 'missing' } }), enableToolRes);
    expect(enableToolRes.statusCode).toBe(404);
    expect(enableToolRes.payload).toMatchObject({ ok: false, error: 'tool not found' });
  });

  it('forwards approval ids from invoke headers and preserves invoke status', async () => {
    let invocation;
    const deps = {
      loop: { status: () => ({ state: 'stopped' }) },
      memory: { recall: () => [], stats: () => ({ total: 0, visible: 0, hidden: 0, fts: true }) },
      focus: { list: () => [], depth: () => 0 },
      toolRegistry: {
        list: () => [],
        invoke: async (id, input) => {
          invocation = { id, input };
          return { ok: false, status: 202, error: 'approval_required', approvalId: input.approvalId };
        },
      },
      approvalStore: { listApprovals: () => [] },
    };
    const { app, routes } = makeApp();
    registerNoeRoutes(app, deps);

    const invokeTool = routes.find((r) => r.method === 'post' && r.path === '/api/noe/tools/:id/invoke');
    const res = makeRes();
    await invokeTool.handlers[1](makeReq({
      params: { id: 'local.shell' },
      body: { args: { command: 'echo ok' }, approvalId: 'body-approval' },
      headers: { 'X-Panel-Approval-Id': 'header-approval' },
    }), res);

    expect(invocation).toMatchObject({
      id: 'local.shell',
      input: {
        args: { command: 'echo ok' },
        approvalId: 'header-approval',
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.payload).toMatchObject({ ok: false, error: 'approval_required', approvalId: 'header-approval' });
  });

  it('registers chat profile routes and forwards profile mutations', async () => {
    let saved;
    let deleted;
    const chatProfileStore = {
      publicList: () => [{ id: 'default', name: '默认模式' }],
      upsert: (body) => { saved = body; return { id: body.id, name: body.name }; },
      delete: (id) => { deleted = id; return true; },
    };
    const deps = {
      loop: { status: () => ({ state: 'stopped' }) },
      memory: { recall: () => [], stats: () => ({ total: 0, visible: 0, hidden: 0, fts: true }) },
      focus: { list: () => [], depth: () => 0 },
      toolRegistry: { list: () => [] },
      approvalStore: { listApprovals: () => [] },
      chatProfileStore,
    };
    const { app, routes } = makeApp();
    registerNoeRoutes(app, deps);

    const list = routes.find((r) => r.method === 'get' && r.path === '/api/noe/chat/profiles');
    const listRes = makeRes();
    await list.handlers[1](makeReq(), listRes);
    expect(listRes.payload).toMatchObject({ ok: true, defaultId: 'default', profiles: [{ id: 'default' }] });

    const patch = routes.find((r) => r.method === 'patch' && r.path === '/api/noe/chat/profiles/:id');
    const patchRes = makeRes();
    await patch.handlers[1](makeReq({ params: { id: 'custom' }, body: { name: '正式', systemPrompt: '中文回答' } }), patchRes);
    expect(saved).toMatchObject({ id: 'custom', name: '正式', systemPrompt: '中文回答' });
    expect(patchRes.payload).toMatchObject({ ok: true, profile: { id: 'custom' } });

    const del = routes.find((r) => r.method === 'delete' && r.path === '/api/noe/chat/profiles/:id');
    const delRes = makeRes();
    await del.handlers[1](makeReq({ params: { id: 'custom' } }), delRes);
    expect(deleted).toBe('custom');
    expect(delRes.payload).toMatchObject({ ok: true });
  });

  it('serves and updates owner gate settings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-owner-gate-'));
    const file = join(dir, 'owner-gate.json');
    try {
      const ownerGateStore = new OwnerGateStore({ file, env: {} });
      const deps = {
        loop: { status: () => ({ state: 'stopped' }) },
        memory: { recall: () => [], stats: () => ({ total: 0, visible: 0, hidden: 0, fts: true }) },
        focus: { list: () => [], depth: () => 0 },
        toolRegistry: { list: () => [] },
        approvalStore: { listApprovals: () => [] },
        ownerGateStore,
      };
      const { app, routes } = makeApp();
      registerNoeRoutes(app, deps);

      const update = routes.find((r) => r.method === 'post' && r.path === '/api/noe/owner-gate');
      const updateRes = makeRes();
      await update.handlers[1](makeReq({ body: { enabled: true, wakeWords: '宝贝,贾维斯', passphrases: '主人口令' } }), updateRes);
      expect(updateRes.payload).toMatchObject({
        ok: true,
        config: {
          enabled: true,
          wakeWords: ['宝贝', '贾维斯'],
          passphrases: [],
          passphrasesConfigured: true,
          passphraseCount: 1,
          secretValuesReturned: false,
        },
      });
      expect(JSON.stringify(updateRes.payload)).not.toContain('主人口令');
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const secondUpdateRes = makeRes();
      await update.handlers[1](makeReq({ body: { enabled: true, wakeWords: '宝贝,贾维斯' } }), secondUpdateRes);
      expect(existsSync(`${file}.bak-latest`)).toBe(true);
      expect(ownerGateStore.check('随便一句').ok).toBe(false);
      expect(ownerGateStore.check('主人口令 帮我看一下').ok).toBe(true);

      const get = routes.find((r) => r.method === 'get' && r.path === '/api/noe/owner-gate');
      const getRes = makeRes();
      await get.handlers[1](makeReq(), getRes);
      expect(getRes.payload.status).toMatchObject({ enabled: true, wakeWords: 2, passphrases: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('registers owner identity voiceprint routes', async () => {
    let configured;
    let enrolled;
    const ownerIdentityStore = {
      status: () => ({ voice: { enabled: false, samples: 0, ready: false }, face: { enabled: false, samples: 0, ready: false } }),
      updateVoiceConfig: (body) => { configured = body; return { enabled: body.enabled === true, threshold: Number(body.threshold) || 0.92, samples: 0, ready: false }; },
      enrollVoiceSample: ({ audioBuffer, name }) => { enrolled = { audioBuffer, name }; return { sample: { id: 'voice-1', name }, status: { samples: 1, ready: false } }; },
      verifyVoice: () => ({ ok: true, enrolled: true, score: 0.95, threshold: 0.92 }),
      clearVoice: () => ({ enabled: false, samples: 0, ready: false }),
      updateFaceConfig: () => ({ enabled: true, threshold: 0.9, samples: 0, ready: false }),
      enrollFaceSample: ({ embedding, name }) => ({ sample: { id: 'face-1', name }, status: { samples: embedding.length ? 1 : 0, ready: false } }),
      verifyFaceEmbedding: () => ({ ok: true, enrolled: true, score: 0.94, threshold: 0.9 }),
      clearFace: () => ({ enabled: false, samples: 0, ready: false }),
    };
    const deps = {
      loop: { status: () => ({ state: 'stopped' }) },
      memory: { recall: () => [], stats: () => ({ total: 0, visible: 0, hidden: 0, fts: true }) },
      focus: { list: () => [], depth: () => 0 },
      toolRegistry: { list: () => [] },
      approvalStore: { listApprovals: () => [] },
      ownerIdentityStore,
      modelSettings: {
        status: () => ({ voice: { enabled: true, engine: 'voice-lite' }, face: { enabled: true } }),
        setFaceEnabled: () => ({ face: { enabled: true } }),
      },
    };
    const { app, routes } = makeApp();
    registerNoeRoutes(app, deps);

    const status = routes.find((r) => r.method === 'get' && r.path === '/api/noe/identity/status');
    const statusRes = makeRes();
    await status.handlers[1](makeReq(), statusRes);
    expect(statusRes.payload.status.voice.samples).toBe(0);

    const config = routes.find((r) => r.method === 'post' && r.path === '/api/noe/identity/voice/config');
    const configRes = makeRes();
    await config.handlers[1](makeReq({ body: { enabled: true, threshold: 0.9 } }), configRes);
    expect(configured).toMatchObject({ enabled: true, threshold: 0.9 });

    const enroll = routes.find((r) => r.method === 'post' && r.path === '/api/noe/identity/voice/enroll');
    const enrollRes = makeRes();
    await enroll.handlers[1](makeReq({ body: { audio: Buffer.from('wav').toString('base64'), name: '第一段' } }), enrollRes);
    expect(enrollRes.statusCode).toBe(201);
    expect(enrolled.name).toBe('第一段');
    expect(Buffer.isBuffer(enrolled.audioBuffer)).toBe(true);

    const faceEnroll = routes.find((r) => r.method === 'post' && r.path === '/api/noe/identity/face/enroll');
    const faceRes = makeRes();
    await faceEnroll.handlers[1](makeReq({ body: { embedding: [1, 0, 0, 1, 0, 1, 0, 1], name: '正脸' } }), faceRes);
    expect(faceRes.statusCode).toBe(201);
    expect(faceRes.payload.sample).toMatchObject({ id: 'face-1', name: '正脸' });
  });

  it('serves a live chat model catalog for profile selection', async () => {
    const oldFetch = globalThis.fetch;
    const oldMiniMaxKey = process.env.MINIMAX_API_KEY;
    const oldLmStudioUrl = process.env.NOE_LMSTUDIO_URL;
    const oldOllamaUrl = process.env.NOE_OLLAMA_URL;
    const oldDisabledModels = process.env.NOE_DISABLED_CHAT_MODELS;
    process.env.MINIMAX_API_KEY = 'unit-test-key';
    process.env.NOE_LMSTUDIO_URL = 'http://lm.local/v1';
    process.env.NOE_OLLAMA_URL = 'http://ollama.local';
    process.env.NOE_DISABLED_CHAT_MODELS = 'lm-beta';
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u === 'http://lm.local/v1/models') return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'lm-alpha' }, { id: 'text-embedding-nomic-embed-text-v1.5' }, { id: 'lm-beta' }] }) };
      if (u === 'http://ollama.local/api/tags') return { ok: true, status: 200, text: async () => JSON.stringify({ models: [{ name: 'ollama-alpha', capabilities: ['completion'] }, { name: 'qwen3-embedding:0.6b', capabilities: ['embedding'] }] }) };
      if (u === 'https://api.minimax.chat/v1/models') return { ok: false, status: 401, text: async () => '{"error":"invalid api key"}' };
      return { ok: false, status: 404, text: async () => '' };
    };
    try {
      const adapters = {
        claude: { id: 'claude', bin: process.execPath },
        codex: { id: 'codex', bin: process.execPath },
        lmstudio: { id: 'lmstudio', baseUrl: 'http://lm.local/v1', apiKey: 'lm-studio', model: 'lm-default' },
        ollama: { id: 'ollama', model: 'ollama-alpha' },
        'ollama-9b': { id: 'ollama-9b', model: 'ollama-9b-default' },
      };
      const deps = {
        loop: { status: () => ({ state: 'stopped' }) },
        memory: { recall: () => [], stats: () => ({ total: 0, visible: 0, hidden: 0, fts: true }) },
        focus: { list: () => [], depth: () => 0 },
        toolRegistry: { list: () => [] },
        approvalStore: { listApprovals: () => [] },
        chatProfileStore: { publicList: () => [] },
        getAdapter: (id) => adapters[id] || null,
      };
      const { app, routes } = makeApp();
      registerNoeRoutes(app, deps);

      const models = routes.find((r) => r.method === 'get' && r.path === '/api/noe/chat/models');
      const res = makeRes();
      await models.handlers[1](makeReq(), res);
      const byId = Object.fromEntries(res.payload.providers.map((p) => [p.id, p]));
      expect(res.payload.ok).toBe(true);
      expect(byId.claude.available).toBe(true);
      expect(byId.codex.available).toBe(true);
      expect(byId.minimax.available).toBe(false);
      expect(byId.minimax.models.map((m) => m.id)).toContain('MiniMax-M2.7-highspeed');
      expect(byId.lmstudio.models.map((m) => m.id)).toContain('lm-alpha');
      expect(byId.lmstudio.models.map((m) => m.id)).not.toContain('text-embedding-nomic-embed-text-v1.5');
      expect(byId.lmstudio.models.map((m) => m.id)).not.toContain('lm-beta');
      expect(byId.ollama.models.map((m) => m.id)).toContain('ollama-alpha');
      expect(byId.ollama.models.map((m) => m.id)).not.toContain('qwen3-embedding:0.6b');
    } finally {
      globalThis.fetch = oldFetch;
      if (oldMiniMaxKey === undefined) delete process.env.MINIMAX_API_KEY; else process.env.MINIMAX_API_KEY = oldMiniMaxKey;
      if (oldLmStudioUrl === undefined) delete process.env.NOE_LMSTUDIO_URL; else process.env.NOE_LMSTUDIO_URL = oldLmStudioUrl;
      if (oldOllamaUrl === undefined) delete process.env.NOE_OLLAMA_URL; else process.env.NOE_OLLAMA_URL = oldOllamaUrl;
      if (oldDisabledModels === undefined) delete process.env.NOE_DISABLED_CHAT_MODELS; else process.env.NOE_DISABLED_CHAT_MODELS = oldDisabledModels;
    }
  });

  it('persists chat profiles locally and protects built-in profiles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-chat-profile-'));
    const file = join(dir, 'chat-profiles.json');
    try {
      const store = new ChatProfileStore({ file });
      const saved = store.upsert({ id: 'custom_m3', name: '自定义 M3', adapterId: 'minimax', model: 'MiniMax-M3', mode: 'assistant', thinkingMode: 'disabled', temperature: 0.73, maxCompletionTokens: 12345, personaName: 'Noe', systemPrompt: '你是正式助理。中文回答。', noAbort: true });
      expect(saved).toMatchObject({ id: 'custom_m3', adapterId: 'minimax', thinkingMode: 'disabled', temperature: 0.73, maxCompletionTokens: 12345, noAbort: true });
      const savedCodex = store.upsert({ id: 'custom_codex', name: 'Codex 配置', adapterId: 'codex', model: 'gpt-5', mode: 'assistant', temperature: 8, maxCompletionTokens: 999999, personaName: 'Noe', systemPrompt: '你是正式助理。中文回答。', noAbort: true });
      expect(savedCodex).toMatchObject({ id: 'custom_codex', adapterId: 'codex', model: 'gpt-5', temperature: 2, maxCompletionTokens: 200000, noAbort: true });
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(existsSync(`${file}.bak-latest`)).toBe(true);

      const reloaded = new ChatProfileStore({ file });
      const resolved = reloaded.resolve('custom_m3');
      expect(resolved.thinkingMode).toBe('disabled');
      expect(resolved.temperature).toBe(0.73);
      expect(resolved.maxCompletionTokens).toBe(12345);
      expect(resolved.systemPrompt).toContain('你是正式助理');
      expect(resolved.systemPrompt).toContain('只输出中文');
      expect(() => reloaded.delete('default')).toThrow(/built-in/);

      writeFileSync(file, JSON.stringify({ version: 1, profiles: [{ id: 'default', name: '旧默认', adapterId: 'auto', mode: 'companion', personaName: '宝贝', systemPrompt: '旧提示词', noAbort: false, builtIn: true }] }));
      const staleBuiltIn = new ChatProfileStore({ file }).resolve('default');
      expect(staleBuiltIn.noAbort).toBe(true);
      expect(staleBuiltIn.systemPrompt).not.toContain('旧提示词');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
