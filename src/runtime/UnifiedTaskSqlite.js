// @ts-check
/**
 * Sqlite persistence for UnifiedTaskStore.
 * Uses injected better-sqlite3 Database — callers must pass isolation DB for tests.
 * Does NOT open live panel.db unless explicitly given that path.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { UnifiedTaskStore, UNIFIED_TASK_SCHEMA_VERSION } from './UnifiedTaskStore.js';

const DDL = `
CREATE TABLE IF NOT EXISTS unified_tasks (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  goal TEXT,
  parent_task_id TEXT,
  revision INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  source_digest TEXT,
  runtime_config_digest TEXT,
  legacy_refs TEXT NOT NULL,
  result_summary TEXT,
  verification TEXT,
  artifacts TEXT NOT NULL,
  receipt_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  write_mode TEXT,
  schema_version INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_unified_tasks_status ON unified_tasks(status);
CREATE INDEX IF NOT EXISTS idx_unified_tasks_updated ON unified_tasks(updated_at);
CREATE TABLE IF NOT EXISTS unified_task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_unified_task_events_task ON unified_task_events(task_id);
`;

/**
 * @param {string} dbPath
 */
export function openUnifiedTaskDb(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(DDL);
  return db;
}

/**
 * Persistable store wrapping UnifiedTaskStore memory API with sqlite write-through.
 */
export class UnifiedTaskSqliteStore extends UnifiedTaskStore {
  /**
   * @param {object} opts
   * @param {import('better-sqlite3').Database} opts.db
   * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [opts.env]
   * @param {() => Date} [opts.now]
   */
  constructor(opts) {
    super({ env: opts.env, now: opts.now });
    this._db = opts.db;
    this._db.exec(DDL);
    this._loadAll();
  }

  _loadAll() {
    const rows = this._db.prepare('SELECT payload FROM unified_tasks').all();
    for (const row of rows) {
      try {
        const task = JSON.parse(row.payload);
        this._tasks.set(task.id, task);
      } catch {
        // skip corrupt
      }
    }
    const events = this._db.prepare('SELECT id, task_id, type, payload, at FROM unified_task_events ORDER BY at ASC').all();
    this._events = events.map((e) => ({
      id: e.id,
      taskId: e.task_id,
      type: e.type,
      payload: safeJson(e.payload, {}),
      at: e.at,
    }));
  }

  /**
   * @param {object} input
   */
  create(input = {}) {
    const task = super.create(input);
    this._upsert(task);
    this._persistEvents(task.id);
    return task;
  }

  linkLegacy(id, refs = {}) {
    const task = super.linkLegacy(id, refs);
    this._upsert(task);
    this._persistEvents(id);
    return task;
  }

  transition(id, status, details = {}) {
    const task = super.transition(id, status, details);
    this._upsert(task);
    this._persistEvents(id);
    return task;
  }

  _upsert(task) {
    if (!task) return;
    this._db.prepare(`
      INSERT INTO unified_tasks (
        id, status, goal, parent_task_id, revision, generation,
        source_digest, runtime_config_digest, legacy_refs, result_summary,
        verification, artifacts, receipt_id, error, created_at, updated_at,
        finished_at, write_mode, schema_version, payload
      ) VALUES (
        @id, @status, @goal, @parent_task_id, @revision, @generation,
        @source_digest, @runtime_config_digest, @legacy_refs, @result_summary,
        @verification, @artifacts, @receipt_id, @error, @created_at, @updated_at,
        @finished_at, @write_mode, @schema_version, @payload
      )
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status,
        goal=excluded.goal,
        parent_task_id=excluded.parent_task_id,
        revision=excluded.revision,
        generation=excluded.generation,
        source_digest=excluded.source_digest,
        runtime_config_digest=excluded.runtime_config_digest,
        legacy_refs=excluded.legacy_refs,
        result_summary=excluded.result_summary,
        verification=excluded.verification,
        artifacts=excluded.artifacts,
        receipt_id=excluded.receipt_id,
        error=excluded.error,
        updated_at=excluded.updated_at,
        finished_at=excluded.finished_at,
        write_mode=excluded.write_mode,
        schema_version=excluded.schema_version,
        payload=excluded.payload
    `).run({
      id: task.id,
      status: task.status,
      goal: task.goal,
      parent_task_id: task.parentTaskId,
      revision: task.revision,
      generation: task.generation,
      source_digest: task.sourceDigest,
      runtime_config_digest: task.runtimeConfigDigest,
      legacy_refs: JSON.stringify(task.legacyRefs || {}),
      result_summary: task.resultSummary,
      verification: JSON.stringify(task.verification || null),
      artifacts: JSON.stringify(task.artifacts || []),
      receipt_id: task.receiptId,
      error: task.error,
      created_at: task.createdAt,
      updated_at: task.updatedAt,
      finished_at: task.finishedAt,
      write_mode: task.writeMode,
      schema_version: UNIFIED_TASK_SCHEMA_VERSION,
      payload: JSON.stringify(task),
    });
  }

  _persistEvents(taskId) {
    const events = this._events.filter((e) => e.taskId === String(taskId));
    const ins = this._db.prepare(`
      INSERT OR REPLACE INTO unified_task_events (id, task_id, type, payload, at)
      VALUES (@id, @task_id, @type, @payload, @at)
    `);
    const tx = this._db.transaction((rows) => {
      for (const e of rows) {
        ins.run({
          id: e.id,
          task_id: e.taskId,
          type: e.type,
          payload: JSON.stringify(e.payload || {}),
          at: e.at,
        });
      }
    });
    tx(events);
  }
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * Re-open store from same db path (restart recovery).
 * @param {string} dbPath
 * @param {object} [opts]
 */
export function reopenUnifiedTaskSqliteStore(dbPath, opts = {}) {
  const db = openUnifiedTaskDb(dbPath);
  return new UnifiedTaskSqliteStore({ db, env: opts.env, now: opts.now });
}
