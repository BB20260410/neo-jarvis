import { requireOwnerToken } from '../auth/owner-token.js';
import { defaultNoeAcuiCardStore } from '../../runtime/NoeAcuiCardStore.js';

function parseBool(value) {
  return value === true || value === 'true' || value === '1';
}

function parseLimit(value, fallback = 20) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(100, Math.trunc(n)));
}

function sendCardResult(res, result) {
  if (!result.ok) return res.status(400).json(result);
  return res.status(200).json(result);
}

export function registerNoeAcuiCardRoutes(app, {
  sendError,
  store = defaultNoeAcuiCardStore,
} = {}) {
  app.get('/api/noe/acui/cards', requireOwnerToken, (req, res) => {
    try {
      return res.json({
        ok: true,
        snapshot: store.snapshot(),
        cards: store.list({
          includeHidden: parseBool(req.query?.includeHidden),
          limit: parseLimit(req.query?.limit),
        }),
      });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.get('/api/noe/acui/cards/context', requireOwnerToken, (req, res) => {
    try {
      return res.json({ ok: true, contextBlock: store.contextBlock({ limit: parseLimit(req.query?.limit, 8) }) });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post('/api/noe/acui/cards/show', requireOwnerToken, (req, res) => {
    try { return sendCardResult(res, store.show(req.body || {})); } catch (e) { return sendError(res, e); }
  });

  app.post('/api/noe/acui/cards/update', requireOwnerToken, (req, res) => {
    try { return sendCardResult(res, store.update(req.body || {})); } catch (e) { return sendError(res, e); }
  });

  app.post('/api/noe/acui/cards/patch', requireOwnerToken, (req, res) => {
    try { return sendCardResult(res, store.patch(req.body || {})); } catch (e) { return sendError(res, e); }
  });

  app.post('/api/noe/acui/cards/hide', requireOwnerToken, (req, res) => {
    try { return sendCardResult(res, store.hide(req.body || {})); } catch (e) { return sendError(res, e); }
  });
}
