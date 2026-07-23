// @ts-check

import { createHash } from 'node:crypto';
import * as sqliteStore from '../storage/SqliteStore.js';
import { ensureNoeMemoryV2Schema } from '../storage/NoeMemoryV2Schema.js';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

function clean(value, max = 1000) {
  if (value === undefined || value === null) return '';
  return redactSensitiveText(String(value).trim().slice(0, max));
}

function asJson(value, fallback) {
  try { return JSON.stringify(value ?? fallback); } catch { return JSON.stringify(fallback); }
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || '');
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function rowToCandidate(row = {}) {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    scope: row.scope,
    title: row.title || '',
    body: row.body || '',
    sourceType: row.source_type || '',
    sourceId: row.source_id || null,
    sourceEpisodeId: row.source_episode_id || null,
    sourceEventIds: parseJson(row.source_event_ids, []),
    evidenceRefs: parseJson(row.evidence_refs, []),
    tags: parseJson(row.tags, []),
    actor: row.actor || '',
    privacy: row.privacy || 'private',
    confidence: Number(row.confidence) || 0,
    salience: Number(row.salience) || 0,
    risk: row.risk || '',
    writeMode: row.write_mode || '',
    decision: row.decision || '',
    decisionReason: row.decision_reason || '',
    targetMemoryId: row.target_memory_id || null,
    candidate: parseJson(row.candidate_json, {}),
    createdAt: Number(row.created_at) || null,
    decidedAt: Number(row.decided_at) || null,
  };
}

export function hashMemoryQuery(query) {
  return createHash('sha256').update(String(query || '').slice(0, 4000)).digest('hex').slice(0, 24);
}

export class NoeMemoryAuditLog {
  constructor({ storage = sqliteStore, db = null, now = Date.now } = {}) {
    this.storage = storage;
    this.dbRef = db;
    this.now = now;
  }

  db() {
    const db = typeof this.dbRef === 'function' ? this.dbRef() : this.dbRef;
    const got = db || this.storage.getDb();
    ensureNoeMemoryV2Schema(got);
    return got;
  }

  recordCandidate(candidate, decision = {}) {
    if (!candidate?.id) return null;
    const t = this.now();
    const decidedAt = decision.decision && decision.decision !== 'pending' ? t : null;
    this.db().prepare(`
      INSERT INTO noe_memory_candidate(
        id, project_id, kind, scope, title, body, source_type, source_id, source_episode_id,
        source_event_ids, evidence_refs, tags, actor, privacy, confidence, salience, risk, write_mode,
        decision, decision_reason, target_memory_id, candidate_json, created_at, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        decision = excluded.decision,
        decision_reason = excluded.decision_reason,
        target_memory_id = excluded.target_memory_id,
        candidate_json = excluded.candidate_json,
        decided_at = excluded.decided_at
    `).run(
      clean(candidate.id, 180),
      clean(candidate.projectId || 'noe', 240) || 'noe',
      clean(candidate.kind || 'fact', 80) || 'fact',
      clean(candidate.scope || 'project', 80) || 'project',
      clean(candidate.title, 500),
      clean(candidate.body, 20_000),
      clean(candidate.sourceType || 'unknown', 80) || 'unknown',
      clean(candidate.sourceId, 240) || null,
      clean(candidate.sourceEpisodeId, 240) || null,
      asJson(candidate.sourceEventIds, []),
      asJson(candidate.evidenceRefs, []),
      asJson(candidate.tags, []),
      clean(candidate.actor || 'unknown', 80) || 'unknown',
      clean(candidate.privacy || 'private', 40) || 'private',
      Number(candidate.confidence) || 0,
      Number(candidate.salience) || 3,
      clean(candidate.risk || 'low', 40) || 'low',
      clean(candidate.writeMode || 'auto', 40) || 'auto',
      clean(decision.decision || 'pending', 60) || 'pending',
      clean(decision.reason || decision.decisionReason || '', 500),
      clean(decision.targetMemoryId, 180) || null,
      asJson(candidate, {}),
      Number(candidate.createdAt) || t,
      decidedAt,
    );
    return { id: candidate.id, decision: decision.decision || 'pending' };
  }

  linkMemory(memoryId, links = []) {
    const id = clean(memoryId, 180);
    if (!id || !Array.isArray(links) || !links.length) return 0;
    const stmt = this.db().prepare(`
      INSERT OR IGNORE INTO noe_memory_link(memory_id, link_type, link_ref, quote_hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    let changes = 0;
    const t = this.now();
    for (const link of links) {
      const type = clean(link?.type || link?.linkType, 80);
      const ref = clean(link?.ref || link?.linkRef, 240);
      const quoteHash = clean(link?.quoteHash || link?.quote_hash, 80);
      if (!type || !ref) continue;
      changes += stmt.run(id, type, ref, quoteHash, t).changes || 0;
    }
    return changes;
  }

  linksForMemory(memoryId) {
    const id = clean(memoryId, 180);
    if (!id) return [];
    return this.db().prepare(`
      SELECT link_type AS type, link_ref AS ref, quote_hash AS quoteHash, created_at AS createdAt
      FROM noe_memory_link WHERE memory_id = ? ORDER BY id ASC
    `).all(id);
  }

  listCandidates({ projectId = 'noe', decision = null, limit = 50 } = {}) {
    const where = ['project_id = ?'];
    /** @type {Array<string | number>} */
    const args = [clean(projectId, 240) || 'noe'];
    if (decision) {
      where.push('decision = ?');
      args.push(clean(decision, 60));
    }
    args.push(Math.max(1, Math.min(500, Number(limit) || 50)));
    return this.db().prepare(`
      SELECT * FROM noe_memory_candidate
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(decided_at, created_at) DESC
      LIMIT ?
    `).all(...args).map(rowToCandidate);
  }

  getCandidate(id) {
    const candidateId = clean(id, 180);
    if (!candidateId) return null;
    const row = this.db().prepare('SELECT * FROM noe_memory_candidate WHERE id = ?').get(candidateId);
    return row ? rowToCandidate(row) : null;
  }

  replayCandidate(id) {
    const candidate = this.getCandidate(id);
    if (!candidate) return { ok: false, reason: 'candidate_not_found' };
    return {
      ok: true,
      candidateId: candidate.id,
      decision: candidate.decision,
      decisionReason: candidate.decisionReason,
      targetMemoryId: candidate.targetMemoryId,
      candidate: candidate.candidate,
      links: candidate.targetMemoryId ? this.linksForMemory(candidate.targetMemoryId) : [],
    };
  }

  recordRetrieval({
    turnId = null,
    projectId = 'noe',
    routeType = '',
    query = '',
    channels = {},
    hitIds = [],
    selectedIds = [],
    droppedReasons = [],
  } = {}) {
    this.db().prepare(`
      INSERT INTO noe_memory_retrieval_log(
        ts, turn_id, project_id, route_type, query_hash, channel_summary, hit_ids, selected_ids, dropped_reasons
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.now(),
      clean(turnId, 160) || null,
      clean(projectId || 'noe', 240) || 'noe',
      clean(routeType, 80),
      hashMemoryQuery(query),
      asJson(channels, {}),
      asJson(hitIds, []),
      asJson(selectedIds, []),
      asJson(droppedReasons, []),
    );
    return true;
  }

  candidateStats({ projectId = 'noe' } = {}) {
    const rows = this.db().prepare(`
      SELECT decision, COUNT(*) AS c
      FROM noe_memory_candidate WHERE project_id = ?
      GROUP BY decision
    `).all(clean(projectId, 240) || 'noe');
    const byDecision = Object.fromEntries(rows.map((r) => [r.decision || 'unknown', Number(r.c) || 0]));
    return {
      total: rows.reduce((sum, row) => sum + (Number(row.c) || 0), 0),
      byDecision,
      quarantineCount: Number(byDecision.quarantined || 0),
      needsReview: Number(byDecision.needs_review || 0),
    };
  }

  retrievalStats({ projectId = 'noe', limit = 200 } = {}) {
    const rows = this.db().prepare(`
      SELECT hit_ids, selected_ids FROM noe_memory_retrieval_log
      WHERE project_id = ? ORDER BY ts DESC LIMIT ?
    `).all(clean(projectId, 240) || 'noe', Math.max(1, Math.min(1000, Number(limit) || 200)));
    if (!rows.length) return { logs: 0, hitRate: null };
    let _hit = 0;
    let selected = 0;
    for (const row of rows) {
      const hits = parseJson(row.hit_ids, []);
      const sel = parseJson(row.selected_ids, []);
      if (Array.isArray(hits) && hits.length) _hit += 1;
      if (Array.isArray(sel) && sel.length) selected += 1;
    }
    return { logs: rows.length, hitRate: rows.length ? Math.round((selected / rows.length) * 100) / 100 : null };
  }
}
