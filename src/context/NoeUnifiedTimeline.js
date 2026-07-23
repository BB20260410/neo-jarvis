// @ts-check
/**
 * Unified Session / Room / Voice timeline aggregation (UX-first).
 * Thin adapters over existing stores — no schema merge.
 */

import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

function clean(v, max = 500) {
  return redactSensitiveText(String(v ?? '').trim()).slice(0, max);
}

function tsOf(item, keys = ['createdAt', 'updatedAt', 'ts', 'at', 'timestamp']) {
  for (const k of keys) {
    const v = item?.[k];
    if (v == null) continue;
    const n = typeof v === 'number' ? v : Date.parse(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/**
 * Normalize heterogeneous sources into timeline rows.
 * @param {object} [input]
 * @param {Array} [input.sessions]
 * @param {Array} [input.rooms]
 * @param {Array} [input.voiceTurns]
 * @param {number} [input.limit]
 */
export function buildUnifiedTimeline({
  sessions = [],
  rooms = [],
  voiceTurns = [],
  limit = 50,
} = {}) {
  const rows = [];

  for (const s of Array.isArray(sessions) ? sessions : []) {
    rows.push({
      id: `session:${s.id || s.sessionId || s.sid || 'unknown'}`,
      kind: 'session',
      title: clean(s.title || s.name || s.id || 'session', 200),
      preview: clean(s.lastMessage || s.preview || s.summary || '', 400),
      status: clean(s.status || 'active', 40),
      ts: tsOf(s, ['updatedAt', 'lastActiveAt', 'createdAt', 'ts']),
      href: s.id ? `/#session=${encodeURIComponent(s.id)}` : null,
      sourceRef: s.id || s.sessionId || null,
    });
  }

  for (const r of Array.isArray(rooms) ? rooms : []) {
    rows.push({
      id: `room:${r.id || r.roomId || 'unknown'}`,
      kind: 'room',
      title: clean(r.name || r.topic || r.id || 'room', 200),
      preview: clean(r.topic || r.objective || r.mode || '', 400),
      status: clean(r.status || 'idle', 40),
      mode: clean(r.mode || '', 40),
      ts: tsOf(r, ['updatedAt', 'createdAt', 'ts']),
      href: r.id ? `/#room=${encodeURIComponent(r.id)}` : null,
      sourceRef: r.id || r.roomId || null,
    });
  }

  for (const v of Array.isArray(voiceTurns) ? voiceTurns : []) {
    rows.push({
      id: `voice:${v.id || v.turnId || `${v.ts || ''}-${rows.length}`}`,
      kind: 'voice',
      title: clean(v.title || 'voice turn', 200),
      preview: clean(v.transcript || v.text || v.reply || v.preview || '', 400),
      status: clean(v.status || 'done', 40),
      ts: tsOf(v, ['ts', 'createdAt', 'at', 'updatedAt']),
      href: '/#voice',
      sourceRef: v.id || v.sessionKey || null,
    });
  }

  rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  return {
    ok: true,
    count: Math.min(rows.length, lim),
    total: rows.length,
    items: rows.slice(0, lim),
  };
}

/**
 * Extract lightweight voice turns from episodic-like events.
 * @param {Array} episodes
 */
export function voiceTurnsFromEpisodes(episodes = []) {
  const out = [];
  for (const e of Array.isArray(episodes) ? episodes : []) {
    const kind = String(e.kind || e.type || e.payload?.kind || '');
    if (!/voice|speech|stt|tts/i.test(kind) && e.channel !== 'voice' && e.modality !== 'voice') continue;
    out.push({
      id: e.id || e.eventId,
      ts: e.ts || e.createdAt || e.at,
      transcript: e.transcript || e.payload?.transcript || e.text || '',
      reply: e.reply || e.payload?.reply || '',
      sessionKey: e.sessionKey || e.payload?.sessionKey,
      status: e.status || 'done',
    });
  }
  return out;
}
