// @ts-check

function columns(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  } catch {
    return new Set();
  }
}

function ensureColumn(db, table, name, ddl) {
  const cols = columns(db, table);
  if (!cols.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export function ensureNoeMemoryV2Schema(db) {
  if (!db?.exec) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS noe_memory_candidate (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'noe',
      kind TEXT NOT NULL DEFAULT 'fact',
      scope TEXT NOT NULL DEFAULT 'project',
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL DEFAULT 'unknown',
      source_id TEXT,
      source_episode_id TEXT,
      source_event_ids TEXT NOT NULL DEFAULT '[]',
      evidence_refs TEXT NOT NULL DEFAULT '[]',
      tags TEXT NOT NULL DEFAULT '[]',
      actor TEXT NOT NULL DEFAULT 'unknown',
      privacy TEXT NOT NULL DEFAULT 'private',
      confidence REAL NOT NULL DEFAULT 0,
      salience INTEGER NOT NULL DEFAULT 3,
      risk TEXT NOT NULL DEFAULT 'low',
      write_mode TEXT NOT NULL DEFAULT 'auto',
      decision TEXT NOT NULL DEFAULT 'pending',
      decision_reason TEXT NOT NULL DEFAULT '',
      target_memory_id TEXT,
      candidate_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      decided_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_noe_memory_candidate_project_decision
      ON noe_memory_candidate(project_id, decision, created_at);
    CREATE INDEX IF NOT EXISTS idx_noe_memory_candidate_source_episode
      ON noe_memory_candidate(source_episode_id);
    CREATE INDEX IF NOT EXISTS idx_noe_memory_candidate_target
      ON noe_memory_candidate(target_memory_id);

    CREATE TABLE IF NOT EXISTS noe_memory_link (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL,
      link_type TEXT NOT NULL,
      link_ref TEXT NOT NULL,
      quote_hash TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      UNIQUE(memory_id, link_type, link_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_noe_memory_link_memory
      ON noe_memory_link(memory_id);
    CREATE INDEX IF NOT EXISTS idx_noe_memory_link_ref
      ON noe_memory_link(link_type, link_ref);

    CREATE TABLE IF NOT EXISTS noe_memory_retrieval_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      turn_id TEXT,
      project_id TEXT NOT NULL DEFAULT 'noe',
      route_type TEXT NOT NULL DEFAULT '',
      query_hash TEXT NOT NULL,
      channel_summary TEXT NOT NULL DEFAULT '{}',
      hit_ids TEXT NOT NULL DEFAULT '[]',
      selected_ids TEXT NOT NULL DEFAULT '[]',
      dropped_reasons TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_noe_memory_retrieval_project_ts
      ON noe_memory_retrieval_log(project_id, ts);
  `);
  ensureColumn(db, 'noe_memory_candidate', 'privacy', "privacy TEXT NOT NULL DEFAULT 'private'");
  ensureColumn(db, 'noe_memory_link', 'quote_hash', "quote_hash TEXT NOT NULL DEFAULT ''");
}
