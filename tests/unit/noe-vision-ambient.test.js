import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/server/auth/owner-token.js', () => ({
  requireOwnerToken: (_req, _res, next) => next(),
}));

import { registerNoeVisionAmbientRoutes } from '../../src/server/routes/noeVisionAmbient.js';

function createApp() {
  const routes = {};
  return {
    routes,
    get(path, ...handlers) {
      if (!routes[path]) routes[path] = [];
      routes[path].push(...handlers);
    },
    post(path, ...handlers) {
      if (!routes[path]) routes[path] = [];
      routes[path].push(...handlers);
    },
  };
}

function runHandlers(handlers, req, res) {
  let i = 0;
  const next = () => {
    const handler = handlers[i++];
    if (!handler) return;
    handler(req, res, next);
  };
  next();
}

function createRes() {
  const res = { statusCode: 200, body: undefined };
  res.json = vi.fn((value) => {
    res.body = value;
    return res;
  });
  res.status = vi.fn((code) => {
    res.statusCode = code;
    return res;
  });
  return res;
}

describe('registerNoeVisionAmbientRoutes', () => {
  /** @type {any} */
  let visionSession;
  /** @type {any} */
  let modelSettings;
  /** @type {any} */
  let sendError;

  beforeEach(() => {
    visionSession = {
      ambientStatus: vi.fn(() => ({
        enabled: true,
        mode: 'on',
        localOnly: true,
        screenCaptureAvailable: true,
        requiresCameraFramePush: false,
        cameraFrameReady: true,
        cameraFrameAgeMs: 120,
        latest: { situation: 'from-latest', kind: 'note' },
        situation: 'from-status',
      })),
      configureAmbient: vi.fn((opts) => ({
        enabled: opts.enabled !== false,
        mode: opts.mode ?? 'on',
        screenSampleMs: opts.screenSampleMs,
        cameraFrameMs: opts.cameraFrameMs,
        source: opts.source || 'api',
      })),
    };
    modelSettings = { setFaceEnabled: vi.fn() };
    sendError = vi.fn((res, err) => {
      res.statusCode = 500;
      res.body = { ok: false, error: err.message };
      return res;
    });
  });

  it('registers the three vision routes with middleware + handler each', () => {
    const app = createApp();
    registerNoeVisionAmbientRoutes(app, { visionSession, modelSettings, sendError });
    expect(app.routes['/api/noe/vision/status']).toHaveLength(2);
    expect(app.routes['/api/noe/vision/situation']).toHaveLength(2);
    expect(app.routes['/api/noe/vision/ambient']).toHaveLength(2);
  });

  it('works when invoked with no options object', () => {
    const app = createApp();
    expect(() => registerNoeVisionAmbientRoutes(app)).not.toThrow();
    expect(app.routes['/api/noe/vision/status']).toBeDefined();
    expect(app.routes['/api/noe/vision/situation']).toBeDefined();
    expect(app.routes['/api/noe/vision/ambient']).toBeDefined();
  });

  it('GET /api/noe/vision/status returns ambient payload with situation and privacy', () => {
    const app = createApp();
    registerNoeVisionAmbientRoutes(app, { visionSession, modelSettings, sendError });
    const res = createRes();
    runHandlers(app.routes['/api/noe/vision/status'], {}, res);
    expect(res.json).toHaveBeenCalledTimes(1);
    const body = res.json.mock.calls[0][0];
    expect(body).toMatchObject({
      ok: true,
      situation: 'from-status',
      privacy: {
        explicitOwnerToggleRequired: true,
        rawFramesPersisted: false,
        localOnly: true,
        cameraRequiresBrowserPermission: true,
        canDisableWithModeOff: true,
      },
    });
    expect(body.ambient).toMatchObject({ enabled: true, mode: 'on', localOnly: true });
  });

  it('GET /api/noe/vision/status prefers status.situation over status.latest.situation', () => {
    const app = createApp();
    registerNoeVisionAmbientRoutes(app, { visionSession, modelSettings, sendError });
    const res = createRes();
    runHandlers(app.routes['/api/noe/vision/status'], {}, res);
    expect(res.json.mock.calls[0][0].situation).toBe('from-status');
  });

  it('GET /api/noe/vision/status falls back to latest.situation when status.situation missing', () => {
    visionSession.ambientStatus = vi.fn(() => ({
      enabled: false,
      mode: 'off',
      latest: { situation: 'derived-from-latest' },
    }));
    const app = createApp();
    registerNoeVisionAmbientRoutes(app, { visionSession, modelSettings, sendError });
    const res = createRes();
    runHandlers(app.routes['/api/noe/vision/status'], {}, res);
    expect(res.json.mock.calls[0][0].situation).toBe('derived-from-latest');
  });

  it('GET /api/noe/vision/status uses hardcoded defaults when ambientStatus is unavailable', () => {
    const app = createApp();
    registerNoeVisionAmbientRoutes(app, {
      visionSession: {},
      modelSettings,
      sendError,
    });
    const res = createRes();
    runHandlers(app.routes['/api/noe/vision/status'], {}, res);
    const body = res.json.mock.calls[0][0];
    expect(body.ambient).toEqual({
      enabled: false,
      mode: 'off',
      localOnly: true,
      screenCaptureAvailable: false,
      requiresCameraFramePush: false,
      cameraFrameReady: false,
      cameraFrameAgeMs: null,
      latest: null,
    });
    expect(body.situation).toBeNull();
  });

  it('GET /api/noe/vision/situation returns situation block alongside ambient + privacy', () => {
    const app = createApp();
    registerNoeVisionAmbientRoutes(app, { visionSession, modelSettings, sendError });
    const res = createRes();
    runHandlers(app.routes['/api/noe/vision/situation'], {}, res);
    const body = res.json.mock.calls[0][0];
    expect(body).toMatchObject({
      ok: true,
      situation: 'from-status',
      privacy: { localOnly: true },
    });
    expect(body.ambient).toBeDefined();
  });

  it('POST /api/noe/vision/ambient forwards the request to configureAmbient and propagates the face flag', () => {
    const app = createApp();
    registerNoeVisionAmbientRoutes(app, { visionSession, modelSettings, sendError });
    const res = createRes();
    const req = {
      body: {
        enabled: true,
        mode: 'on',
        screenSampleMs: 1000,
        cameraFrameMs: 2000,
        source: 'cli',
      },
    };
    runHandlers(app.routes['/api/noe/vision/ambient'], req, res);
    expect(visionSession.configureAmbient).toHaveBeenCalledWith({
      enabled: true,
      mode: 'on',
      screenSampleMs: 1000,
      cameraFrameMs: 2000,
      source: 'cli',
    });
    expect(modelSettings.setFaceEnabled).toHaveBeenCalledWith(true);
    expect(res.json).toHaveBeenCalledTimes(1);
  });

  it('POST /api/noe/vision/ambient defaults enabled to true and source to "api"', () => {
    const app = createApp();
    registerNoeVisionAmbientRoutes(app, { visionSession, modelSettings, sendError });
    const res = createRes();
    runHandlers(app.routes['/api/noe/vision/ambient'], { body: {} }, res);
    expect(visionSession.configureAmbient).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, source: 'api' })
    );
    expect(modelSettings.setFaceEnabled).toHaveBeenCalledWith(true);
  });

  it('POST /api/noe/vision/ambient honours explicit enabled=false', () => {
    const app = createApp();
    registerNoeVisionAmbientRoutes(app, { visionSession, modelSettings, sendError });
    const res = createRes();
    runHandlers(app.routes['/api/noe/vision/ambient'], { body: { enabled: false } }, res);
    expect(visionSession.configureAmbient).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
    expect(modelSettings.setFaceEnabled).toHaveBeenCalledWith(false);
  });

  it('POST /api/noe/vision/ambient handles missing req.body', () => {
    const app = createApp();
    registerNoeVisionAmbientRoutes(app, { visionSession, modelSettings, sendError });
    const res = createRes();
    expect(() => runHandlers(app.routes['/api/noe/vision/ambient'], {}, res)).not.toThrow();
    expect(visionSession.configureAmbient).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'api', enabled: true })
    );
  });

  it('POST /api/noe/vision/ambient does not crash when modelSettings is absent', () => {
    const app = createApp();
    expect(() =>
      registerNoeVisionAmbientRoutes(app, { visionSession, sendError })
    ).not.toThrow();
    const res = createRes();
    expect(() =>
      runHandlers(app.routes['/api/noe/vision/ambient'], { body: { enabled: true } }, res)
    ).not.toThrow();
  });

  it('forwards status-route exceptions to sendError', () => {
    const app = createApp();
    visionSession.ambientStatus = vi.fn(() => {
      throw new Error('status boom');
    });
    registerNoeVisionAmbientRoutes(app, { visionSession, modelSettings, sendError });
    const res = createRes();
    runHandlers(app.routes['/api/noe/vision/status'], {}, res);
    expect(sendError).toHaveBeenCalledWith(res, expect.any(Error));
  });

  it('forwards ambient-route exceptions to sendError', () => {
    const app = createApp();
    visionSession.configureAmbient = vi.fn(() => {
      throw new Error('config boom');
    });
    registerNoeVisionAmbientRoutes(app, { visionSession, modelSettings, sendError });
    const res = createRes();
    runHandlers(app.routes['/api/noe/vision/ambient'], { body: {} }, res);
    expect(sendError).toHaveBeenCalledWith(res, expect.any(Error));
  });
});
