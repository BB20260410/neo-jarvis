import { requireOwnerToken } from '../auth/owner-token.js';
import { defaultNoeUiSignalStore } from '../../runtime/NoeUiSignalStore.js';

function parseBool(value) {
  return value === true || value === 'true' || value === '1';
}

function parseLimit(value, fallback = 20) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(100, Math.trunc(n)));
}

export function registerNoeUiSignalRoutes(app, {
  sendError,
  store = defaultNoeUiSignalStore,
} = {}) {
  app.post('/api/noe/ui-signals', requireOwnerToken, (req, res) => {
    try {
      const result = store.record(req.body || {});
      if (!result.ok) return res.status(400).json(result);
      return res.status(201).json({
        ok: true,
        signal: result.signal,
        snapshot: store.snapshot(),
      });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.get('/api/noe/ui-signals', requireOwnerToken, (req, res) => {
    try {
      return res.json({
        ok: true,
        snapshot: store.snapshot(),
        signals: store.list({
          includeConsumed: parseBool(req.query.includeConsumed),
          limit: parseLimit(req.query.limit),
        }),
      });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post('/api/noe/ui-signals/consume', requireOwnerToken, (req, res) => {
    try {
      return res.json(store.consume({ limit: parseLimit(req.body?.limit) }));
    } catch (e) {
      return sendError(res, e);
    }
  });
}
