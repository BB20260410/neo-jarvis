import { randomUUID } from 'node:crypto';
import { memoryCore as defaultMemoryCore } from './MemoryCore.js';
import * as sqliteStore from '../storage/SqliteStore.js';

const DEFAULT_PROJECT = 'default';
const MAX_TEXT = 20_000;

function nowMs() {
  return Date.now();
}

function safeString(value, max = 1000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function normalizeProject(value) {
  return safeString(value || DEFAULT_PROJECT, 240) || DEFAULT_PROJECT;
}

function rowToFocus(row = {}) {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    summary: row.summary || '',
    state: row.state || 'active',
    depth: Number(row.depth) || 0,
    hitCount: Number(row.hit_count) || 0,
    sourceType: row.source_type || 'manual',
    sourceId: row.source_id || null,
    absorbedMemoryId: row.absorbed_memory_id || null,
    compressedSummary: row.compressed_summary || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    poppedAt: row.popped_at || null,
  };
}

export class FocusStack {
  constructor({ storage = sqliteStore, memory = defaultMemoryCore } = {}) {
    this.storage = storage;
    this.memory = memory;
  }

  db() {
    return this.storage.getDb();
  }

  push(input = {}) {
    const projectId = normalizeProject(input.projectId ?? input.project_id ?? input.project);
    const title = safeString(input.title, 500);
    if (!title) throw new Error('focus title required');
    const summary = safeString(input.summary ?? input.body ?? '', MAX_TEXT);
    const now = nowMs();
    const existing = this.db().prepare(`
      SELECT * FROM noe_focus_stack
      WHERE project_id = ? AND title = ? AND state = 'active'
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(projectId, title);
    if (existing) {
      this.db().prepare(`
        UPDATE noe_focus_stack
        SET summary = ?, hit_count = hit_count + 1, updated_at = ?
        WHERE id = ?
      `).run(summary || existing.summary || '', now, existing.id);
      return this.get(existing.id);
    }

    const depth = Number.isFinite(Number(input.depth))
      ? Math.max(0, Math.trunc(Number(input.depth)))
      : this.#nextDepth(projectId);
    const id = safeString(input.id, 160) || `focus-${randomUUID()}`;
    const sourceType = safeString(input.sourceType ?? input.source_type ?? 'manual', 80) || 'manual';
    const sourceId = safeString(input.sourceId ?? input.source_id, 240) || null;
    this.db().prepare(`
      INSERT INTO noe_focus_stack(
        id, project_id, title, summary, state, depth, hit_count,
        source_type, source_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', ?, 1, ?, ?, ?, ?)
    `).run(id, projectId, title, summary, depth, sourceType, sourceId, now, now);
    return this.get(id);
  }

  #nextDepth(projectId) {
    const row = this.db().prepare(`
      SELECT COALESCE(MAX(depth), -1) + 1 AS next_depth
      FROM noe_focus_stack
      WHERE project_id = ? AND state = 'active'
    `).get(projectId);
    return Math.max(0, Number(row?.next_depth) || 0);
  }

  get(id) {
    const focusId = safeString(id, 160);
    if (!focusId) return null;
    const row = this.db().prepare('SELECT * FROM noe_focus_stack WHERE id = ?').get(focusId);
    return row ? rowToFocus(row) : null;
  }

  list({ projectId, state = 'active', limit = 100 } = {}) {
    const p = normalizeProject(projectId);
    const n = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 100)));
    const rows = this.db().prepare(`
      SELECT * FROM noe_focus_stack
      WHERE project_id = ? AND state = ?
      ORDER BY depth ASC, updated_at ASC
      LIMIT ?
    `).all(p, safeString(state, 40) || 'active', n);
    return rows.map(rowToFocus);
  }

  peek({ projectId } = {}) {
    return this.list({ projectId, limit: 1 })[0] || null;
  }

  restore({ projectId } = {}) {
    return this.list({ projectId });
  }

  pop(id, input = {}) {
    const current = this.get(id);
    if (!current || current.state !== 'active') return null;
    const summary = safeString(
      input.compressedSummary ?? input.summary ?? current.summary ?? current.title,
      MAX_TEXT
    ) || current.title;
    const now = nowMs();
    let absorbedMemoryId = null;
    if (input.absorb !== false && this.memory?.write) {
      const memory = this.memory.write({
        projectId: current.projectId,
        scope: 'focus',
        title: current.title,
        body: summary,
        sourceType: 'focus_stack',
        sourceId: current.id,
        tags: ['focus', 'absorbed'],
      });
      absorbedMemoryId = memory?.id || null;
    }
    this.db().prepare(`
      UPDATE noe_focus_stack
      SET state = 'popped',
          compressed_summary = ?,
          absorbed_memory_id = ?,
          popped_at = ?,
          updated_at = ?
      WHERE id = ? AND state = 'active'
    `).run(summary, absorbedMemoryId, now, now, current.id);
    return this.get(current.id);
  }

  depth({ projectId } = {}) {
    const row = this.db().prepare(`
      SELECT COUNT(*) AS n
      FROM noe_focus_stack
      WHERE project_id = ? AND state = 'active'
    `).get(normalizeProject(projectId));
    return Number(row?.n) || 0;
  }
}

export const focusStack = new FocusStack();
