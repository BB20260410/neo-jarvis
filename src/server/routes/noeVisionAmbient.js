// @ts-check

import { requireOwnerToken } from '../auth/owner-token.js';

function ambientPayload(visionSession) {
  const status = visionSession?.ambientStatus?.() || {
    enabled: false,
    mode: 'off',
    localOnly: true,
    screenCaptureAvailable: false,
    requiresCameraFramePush: false,
    cameraFrameReady: false,
    cameraFrameAgeMs: null,
    latest: null,
  };
  return {
    ok: true,
    ambient: status,
    situation: status?.situation || status?.latest?.situation || null,
    privacy: {
      explicitOwnerToggleRequired: true,
      rawFramesPersisted: false,
      localOnly: true,
      cameraRequiresBrowserPermission: true,
      canDisableWithModeOff: true,
    },
  };
}

export function registerNoeVisionAmbientRoutes(app, { visionSession, modelSettings, sendError } = {}) {
  app.get('/api/noe/vision/status', requireOwnerToken, (_req, res) => {
    try {
      return res.json(ambientPayload(visionSession));
    } catch (e) { return sendError(res, e); }
  });

  app.get('/api/noe/vision/situation', requireOwnerToken, (_req, res) => {
    try {
      const payload = ambientPayload(visionSession);
      return res.json({ ok: true, situation: payload.situation, ambient: payload.ambient, privacy: payload.privacy });
    } catch (e) { return sendError(res, e); }
  });

  app.post('/api/noe/vision/ambient', requireOwnerToken, (req, res) => {
    try {
      const body = req.body || {};
      const ambient = visionSession.configureAmbient({
        enabled: body.enabled !== false,
        mode: body.mode,
        screenSampleMs: body.screenSampleMs,
        cameraFrameMs: body.cameraFrameMs,
        source: body.source || 'api',
      });
      modelSettings?.setFaceEnabled?.(ambient.enabled);
      return res.json(ambientPayload(visionSession));
    } catch (e) { return sendError(res, e); }
  });
}
