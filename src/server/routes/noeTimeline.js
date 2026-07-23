// @ts-check
import { requireOwnerToken } from '../auth/owner-token.js';
import { buildUnifiedTimeline, voiceTurnsFromEpisodes } from '../../context/NoeUnifiedTimeline.js';

/**
 * Unified Session/Room/Voice timeline API (UX-first).
 * @param {import('express').Express} app
 * @param {object} deps
 */
export function registerNoeTimelineRoutes(app, deps = {}) {
  const {
    listSessions = () => [],
    listRooms = () => [],
    listVoiceTurns = null,
    listEpisodes = null,
    sendError = (res, e) => res.status(500).json({ ok: false, error: e?.message || String(e) }),
  } = deps;

  app.get('/api/noe/timeline', requireOwnerToken, (req, res) => {
    try {
      const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
      const sessions = typeof listSessions === 'function' ? listSessions() : [];
      const rooms = typeof listRooms === 'function' ? listRooms() : [];
      let voiceTurns = typeof listVoiceTurns === 'function' ? listVoiceTurns() : [];
      if ((!voiceTurns || !voiceTurns.length) && typeof listEpisodes === 'function') {
        voiceTurns = voiceTurnsFromEpisodes(listEpisodes());
      }
      const timeline = buildUnifiedTimeline({ sessions, rooms, voiceTurns, limit });
      res.json(timeline);
    } catch (e) {
      sendError(res, e);
    }
  });
}
