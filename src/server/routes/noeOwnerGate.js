import { requireOwnerToken } from '../auth/owner-token.js';

export function registerNoeOwnerGateRoutes(app, { ownerGateStore, sendError } = {}) {
  app.get('/api/noe/owner-gate', requireOwnerToken, (_req, res) => {
    try {
      return res.json({ ok: true, config: ownerGateStore.publicConfig(), status: ownerGateStore.status() });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post('/api/noe/owner-gate', requireOwnerToken, (req, res) => {
    try {
      return res.json({ ok: true, config: ownerGateStore.update(req.body || {}), status: ownerGateStore.status() });
    } catch (e) {
      return sendError(res, e);
    }
  });
}
