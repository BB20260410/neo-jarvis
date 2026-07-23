// @ts-check

import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';
import { ensureNoeMemoryV2Schema } from '../storage/NoeMemoryV2Schema.js';

export const STRONG_MEMORY_SOURCE_LINK_TYPES = Object.freeze([
  'source_episode',
  'source_event',
  'evidence_ref',
  'source_id',
]);

const WEAK_LEGACY_LINK_TYPES = new Set([
  'legacy_source_type',
  'merged_from_memory',
]);

function clean(value, max = 240) {
  if (value === undefined || value === null) return '';
  return redactSensitiveText(String(value).trim().slice(0, max));
}

function parseTrace(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function dayRef(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  try { return new Date(n).toISOString().slice(0, 10); } catch { return ''; }
}

function linkKey(link) {
  return `${link.memoryId}\u0000${link.type}\u0000${link.ref}`;
}

export function isStrongMemorySourceLinkType(type) {
  return STRONG_MEMORY_SOURCE_LINK_TYPES.includes(String(type || ''));
}

export function isWeakLegacyMemoryLinkType(type) {
  return WEAK_LEGACY_LINK_TYPES.has(String(type || ''));
}

export function buildMemoryGovernanceLinksForRow(row = {}) {
  const memoryId = clean(row.id, 180);
  if (!memoryId) return [];
  const links = [];
  const sourceEpisodeId = clean(row.source_episode_id, 240);
  const sourceId = clean(row.source_id, 240);
  const sourceType = clean(row.source_type, 80);
  if (sourceEpisodeId) links.push({ memoryId, type: 'source_episode', ref: sourceEpisodeId, strength: 'strong' });
  if (sourceId) links.push({ memoryId, type: 'source_id', ref: sourceId, strength: 'strong' });
  if (sourceType) links.push({ memoryId, type: 'legacy_source_type', ref: sourceType, strength: 'weak' });
  const createdDay = dayRef(row.created_at);
  if (createdDay && sourceType) {
    links.push({ memoryId, type: 'legacy_source_type', ref: `${sourceType}:${createdDay}`, strength: 'weak' });
  }
  for (const entry of parseTrace(row.merge_trace)) {
    const ids = Array.isArray(entry?.sourceIds) ? entry.sourceIds : [];
    for (const id of ids) {
      const ref = clean(id, 180);
      if (ref && ref !== memoryId) links.push({ memoryId, type: 'merged_from_memory', ref, strength: 'weak' });
    }
  }
  const out = [];
  const seen = new Set();
  for (const link of links) {
    const key = linkKey(link);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  return out;
}

export function planNoeMemoryGovernanceRepair({
  db,
  projectId = 'noe',
  includeHidden = false,
  limit = 5000,
} = {}) {
  if (!db?.prepare) throw new Error('db required');
  ensureNoeMemoryV2Schema(db);
  const pid = clean(projectId, 240) || 'noe';
  const cappedLimit = Math.max(1, Math.min(50_000, Number(limit) || 5000));
  const rows = db.prepare(`
    SELECT id, project_id, hidden, source_type, source_id, source_episode_id, merge_trace, created_at
    FROM noe_memory
    WHERE project_id = ? ${includeHidden ? '' : 'AND hidden = 0'}
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(pid, cappedLimit);
  const existing = new Set(db.prepare('SELECT memory_id, link_type, link_ref FROM noe_memory_link').all()
    .map((row) => `${row.memory_id}\u0000${row.link_type}\u0000${row.link_ref}`));
  const inserts = [];
  for (const row of rows) {
    for (const link of buildMemoryGovernanceLinksForRow(row)) {
      if (!existing.has(linkKey(link))) inserts.push(link);
    }
  }
  const strong = inserts.filter((link) => link.strength === 'strong').length;
  const weak = inserts.filter((link) => link.strength === 'weak').length;
  return {
    ok: true,
    projectId: pid,
    scanned: rows.length,
    truncated: rows.length >= cappedLimit,
    insertCount: inserts.length,
    strongInsertCount: strong,
    weakInsertCount: weak,
    inserts,
  };
}

export function applyNoeMemoryGovernanceRepair({
  db,
  now = Date.now,
  apply = false,
  ...opts
} = {}) {
  const plan = planNoeMemoryGovernanceRepair({ db, ...opts });
  if (!apply) return { ...plan, applied: false, inserted: 0 };
  if (!plan.inserts.length) return { ...plan, applied: true, inserted: 0 };
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO noe_memory_link(memory_id, link_type, link_ref, quote_hash, created_at)
    VALUES (?, ?, ?, '', ?)
  `);
  const t = now();
  let inserted = 0;
  const run = db.transaction(() => {
    for (const link of plan.inserts) {
      inserted += stmt.run(link.memoryId, link.type, link.ref, t).changes || 0;
    }
  });
  run();
  return { ...plan, applied: true, inserted };
}
