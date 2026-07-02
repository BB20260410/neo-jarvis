// @ts-check
import { requireOwnerToken } from '../auth/owner-token.js';
import { getDb } from '../../storage/SqliteStore.js';
import { buildNoeWorkMapSnapshot } from '../../runtime/NoeWorkMapSnapshot.js';

function capLimit(value, fallback = 80, max = 200) {
  return Math.max(1, Math.min(max, Number(value) || fallback));
}

function sendError(res, error) {
  const status = Number(error?.statusCode || error?.status || 500);
  return res.status(status >= 400 && status < 600 ? status : 500).json({ ok: false, error: error?.message || String(error) });
}

export function registerNoeWorkMapRoutes(app, {
  rootDir,
  dataDir,
  sessions = null,
  roomStore = null,
  db = null,
  dbProvider = getDb,
  now = Date.now,
} = {}) {
  app.get('/api/noe/work-map', requireOwnerToken, (req, res) => {
    try {
      let resolvedDb = db;
      let dbError = '';
      if (!resolvedDb && dbProvider) {
        try { resolvedDb = dbProvider(); } catch (error) { dbError = error?.message || String(error); }
      }
      return res.json(buildNoeWorkMapSnapshot({
        rootDir,
        dataDir,
        sessions,
        roomStore,
        db: resolvedDb,
        dbError,
        itemLimit: capLimit(req.query?.limit, 80, 200),
        now,
      }));
    } catch (error) {
      return sendError(res, error);
    }
  });
}
