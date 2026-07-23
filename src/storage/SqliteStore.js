// panel v2.0 Task 4.1 — SQLite 数据底座
// 替代散落的 jsonl 文件，提供：
//   - 流式追加表（mcp_calls / metrics / archive / autopilot_log / licenses_issued）
//   - KV 通用键值表
//   - 简单查询（按 ts / room / tag 等过滤）
//   - 向量列保留（v2.0 Task 4.2 接入）

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensureNoeMemoryV2Schema } from './NoeMemoryV2Schema.js';
import { autoRecoverDb } from './NoeDbSelfCheck.js';

// 默认路径走 ~/.noe-panel/panel.db；环境变量 PANEL_DB_PATH 优先级最高,
// 让 e2e / 调试脚本能强制隔离 db 而不需要改 HOME(隔离 HOME 在 Linux 还会丢 npm 全局缓存等副作用)。
function resolveDefaultDbPath() {
  const env = process.env.PANEL_DB_PATH;
  if (env && env.trim()) return env.trim();
  return path.join(os.homedir(), '.noe-panel', 'panel.db');
}

let _db = null;
let _dbPath = null;
// VCP 吸收 H2：记录本次启动是否发生坏库自动回滚，供 server.js 启动后 broadcast health_warning。
let _dbAutoRecovered = null;
export function getDbAutoRecoveryEvent() { return _dbAutoRecovered; }

export function initSqlite(dbPath) {
  // 无参语义=「确保有库可用」：已有连接时一律沿用，绝不静默切回默认库。
  // （2026-06-10 修复：测试以自定义路径初始化后，VectorIndex 等模块的 initSqlite() 无参调用
  //   曾把单例切回默认库，导致测试数据写进真实 ~/.noe-panel/panel.db。显式传路径仍按原语义切库。）
  if (_db && dbPath === undefined) return _db;
  if (dbPath === undefined) dbPath = resolveDefaultDbPath();
  if (_db && _dbPath === dbPath) return _db;
  // 审计 §3.3 P1②：显式切到不同库前先 close 旧连接，让 WAL 及时 checkpoint、释放 fd（否则旧连接泄漏）
  if (_db) { try { _db.close(); } catch { /* 已关闭忽略 */ } _db = null; _dbPath = null; }
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // VCP 吸收 H2：启动自检 + 坏库自动回滚（NOE_DB_AUTORECOVER=1 启用，默认 OFF 零回归）。
  // quick_check 失败/库无法打开 → 隔离损坏库 + 从最新每日备份恢复，再正常打开恢复后的库。
  try {
    const rec = autoRecoverDb(dbPath, { log: (m) => { try { console.warn(m); } catch {} } });
    if (rec && rec.recovered) _dbAutoRecovered = rec;
  } catch (e) { try { console.warn('[db-selfcheck] autoRecover 异常(忽略,继续启动): ' + ((e && e.message) || e)); } catch {} }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  // 连接级性能 PRAGMA（5 项目研究 SQLite high）：30+ 模块共用一个 db 文件，此前只设了上面 3 行。
  // busy_timeout 最关键——WAL checkpoint / 备份撞写时等待而非直接抛 SQLITE_BUSY（全仓 0 处理）。
  db.pragma('busy_timeout = 5000');   // 撞锁等 5s 再报错，给 checkpoint/备份让路
  db.pragma('cache_size = -65536');   // 64MB page cache（负数=KB），减少磁盘 IO
  db.pragma('temp_store = MEMORY');   // 临时表/排序走内存
  db.pragma('mmap_size = 268435456'); // 256MB mmap，减少 read syscall（panel.db 已 1.3GB）

  // 通用流式事件表（含 mcp_calls / metrics / archive / autopilot_log / licenses_issued / webhook_events / activity）
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      room_id TEXT,
      session_id TEXT,
      tag TEXT,
      entity_type TEXT,
      entity_id TEXT,
      task_id TEXT,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    CREATE INDEX IF NOT EXISTS idx_events_kind_ts ON events(kind, ts);
    CREATE INDEX IF NOT EXISTS idx_events_room_kind ON events(room_id, kind);

    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS room_summary (
      room_id TEXT PRIMARY KEY,
      mode TEXT,
      topic TEXT,
      status TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      cost_cents INTEGER DEFAULT 0,
      msg_count INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_room_status ON room_summary(status, updated_at);

    -- v2.0 Task 4.2 — 向量索引（暂留空 BLOB 列，4.2 接入 embedding）
    CREATE TABLE IF NOT EXISTS embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      text TEXT NOT NULL,
      vector BLOB,
      dim INTEGER,
      model TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      UNIQUE(kind, ref_id)
    );
    CREATE INDEX IF NOT EXISTS idx_embeddings_kind ON embeddings(kind);
    -- 高性能:(dim, kind) 复合索引服务 semanticSearch 的 WHERE dim=? 与 WHERE dim=? AND kind=? 两种形态
    -- (leading dim 同时覆盖无 kind 与带 kind 路径),index seek 取代全表扫,跳过异维 stale 行不解码;
    -- WHERE 子句不变故命中集与排序逐字等价;kind-only 查询仍走 idx_embeddings_kind。
    CREATE INDEX IF NOT EXISTS idx_embeddings_dim_kind ON embeddings(dim, kind);

    CREATE TABLE IF NOT EXISTS budget_policies (
      id TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      metric TEXT NOT NULL DEFAULT 'usd',
      window_kind TEXT NOT NULL DEFAULT 'monthly',
      amount REAL NOT NULL,
      warn_percent REAL NOT NULL DEFAULT 0.8,
      hard_stop_enabled INTEGER NOT NULL DEFAULT 1,
      notify_enabled INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      note TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(scope_type, scope_id, metric, window_kind)
    );
    CREATE INDEX IF NOT EXISTS idx_budget_policies_scope ON budget_policies(scope_type, scope_id, metric, is_active);

    CREATE TABLE IF NOT EXISTS budget_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      amount REAL NOT NULL,
      source TEXT,
      room_id TEXT,
      session_id TEXT,
      task_id TEXT,
      adapter_id TEXT,
      project_id TEXT,
      payload TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_budget_usage_scope_ts ON budget_usage(scope_type, scope_id, metric, ts);
    CREATE INDEX IF NOT EXISTS idx_budget_usage_room_ts ON budget_usage(room_id, ts);

    CREATE TABLE IF NOT EXISTS budget_incidents (
      id TEXT PRIMARY KEY,
      policy_id TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      window_kind TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      threshold_type TEXT NOT NULL,
      observed_amount REAL NOT NULL,
      limit_amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      activity_id INTEGER,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_budget_incidents_policy_status ON budget_incidents(policy_id, status, window_start);
    CREATE INDEX IF NOT EXISTS idx_budget_incidents_scope_status ON budget_incidents(scope_type, scope_id, status);

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requester_type TEXT,
      requester_id TEXT,
      dedupe_key TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      decision_by TEXT,
      decision_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      decided_at INTEGER,
      expires_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_status_type ON approvals(status, type, created_at);
    CREATE INDEX IF NOT EXISTS idx_approvals_requester ON approvals(requester_type, requester_id, status);
    CREATE INDEX IF NOT EXISTS idx_approvals_dedupe ON approvals(dedupe_key, status);

    CREATE TABLE IF NOT EXISTS approval_comments (
      id TEXT PRIMARY KEY,
      approval_id TEXT NOT NULL,
      actor_type TEXT,
      actor_id TEXT,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_approval_comments_approval ON approval_comments(approval_id, created_at);

    CREATE TABLE IF NOT EXISTS autopilot_schedules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      schedule_kind TEXT NOT NULL DEFAULT 'interval',
      interval_ms INTEGER,
      next_run_at INTEGER,
      last_run_at INTEGER,
      action TEXT NOT NULL DEFAULT 'notify',
      target_type TEXT,
      target_id TEXT,
      room_id TEXT,
      session_id TEXT,
      task_id TEXT,
      project_id TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      max_retries INTEGER NOT NULL DEFAULT 2,
      retry_backoff_ms INTEGER NOT NULL DEFAULT 60000,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_autopilot_schedules_due ON autopilot_schedules(status, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_autopilot_schedules_target ON autopilot_schedules(target_type, target_id);

    CREATE TABLE IF NOT EXISTS autopilot_jobs (
      id TEXT PRIMARY KEY,
      schedule_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      room_id TEXT,
      session_id TEXT,
      task_id TEXT,
      project_id TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      run_after INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      retry_backoff_ms INTEGER NOT NULL DEFAULT 60000,
      locked_by TEXT,
      locked_at INTEGER,
      dedupe_key TEXT UNIQUE,
      payload TEXT NOT NULL DEFAULT '{}',
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_autopilot_jobs_status_due ON autopilot_jobs(status, run_after, priority);
    CREATE INDEX IF NOT EXISTS idx_autopilot_jobs_schedule ON autopilot_jobs(schedule_id, status);
    CREATE INDEX IF NOT EXISTS idx_autopilot_jobs_room ON autopilot_jobs(room_id, status);

    CREATE TABLE IF NOT EXISTS autopilot_runs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      schedule_id TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      worker_id TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      duration_ms INTEGER,
      result TEXT NOT NULL DEFAULT '{}',
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_autopilot_runs_job ON autopilot_runs(job_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_autopilot_runs_schedule ON autopilot_runs(schedule_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_autopilot_runs_status ON autopilot_runs(status, started_at);

    CREATE TABLE IF NOT EXISTS delegations (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'queued',
      source_room_id TEXT NOT NULL,
      source_task_id TEXT,
      target_room_id TEXT,
      target_mode TEXT NOT NULL DEFAULT 'debate',
      title TEXT NOT NULL,
      instructions TEXT NOT NULL,
      objective_id TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      executed_at INTEGER,
      cancelled_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_delegations_source ON delegations(source_room_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_delegations_target ON delegations(target_room_id, status);
    CREATE INDEX IF NOT EXISTS idx_delegations_status ON delegations(status, updated_at);

    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'queued',
      room_id TEXT,
      session_id TEXT,
      task_id TEXT,
      agent_profile_id TEXT,
      agent_profile_title TEXT,
      adapter_id TEXT,
      model_id TEXT,
      turn_id TEXT,
      source_type TEXT,
      source_id TEXT,
      defer_reason TEXT,
      approval_id TEXT,
      budget_incident_id TEXT,
      delegation_id TEXT,
      related_activity_ids TEXT NOT NULL DEFAULT '[]',
      skills TEXT NOT NULL DEFAULT '[]',
      dispatch_tags TEXT NOT NULL DEFAULT '[]',
      governance TEXT NOT NULL DEFAULT '{}',
      details TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      started_at INTEGER,
      finished_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'message',
      role TEXT NOT NULL DEFAULT 'system',
      status TEXT,
      summary TEXT,
      content TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      FOREIGN KEY(run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_agent_messages_run ON agent_messages(run_id, created_at);

    CREATE TABLE IF NOT EXISTS agent_tool_results (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'done',
      input_summary TEXT,
      output_summary TEXT,
      cost_usd REAL DEFAULT 0,
      approval_id TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      FOREIGN KEY(run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_agent_tool_results_run ON agent_tool_results(run_id, created_at);

    CREATE TABLE IF NOT EXISTS governance_queue_items (
      id TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      title TEXT,
      severity TEXT,
      queue_state TEXT NOT NULL DEFAULT 'pending_review',
      note TEXT,
      dedupe_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_governance_queue_dedupe ON governance_queue_items(dedupe_key);
    CREATE INDEX IF NOT EXISTS idx_governance_queue_state ON governance_queue_items(queue_state, updated_at);
  `);
  ensureEventsSchema(db);
  ensureAgentRunSchema(db);
  runMigrations(db, dbPath);
  fs.chmodSync(dbPath, 0o600);
  _db = db;
  _dbPath = dbPath;
  return db;
}

export function getDb() {
  return _db || initSqlite();
}

export function close() {
  if (_db) { try { _db.close(); } catch {} _db = null; _dbPath = null; }
}

// ===== Schema 迁移框架（P8/D3）=====
// 基线 schema 仍由上面的 CREATE TABLE IF NOT EXISTS + ensure*Schema（幂等列补齐）负责；
// 本框架负责「版本化、有序、一次性」的前向迁移——新 schema 变更走这里，按版本号顺序执行，
// 每条迁移在独立事务内完成并推进 schema_version（kv），有待执行迁移且库已有数据时先一次性备份。
export const SCHEMA_MIGRATIONS = [
  {
    version: 1,
    name: 'agent_runs_status_updated_index',
    up(db) {
      db.exec('CREATE INDEX IF NOT EXISTS idx_agent_runs_status_updated ON agent_runs(status, updated_at)');
    },
  },
  {
    version: 2,
    name: 'noe_core_memory_focus_tools',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS noe_memory (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL DEFAULT 'default',
          scope TEXT NOT NULL DEFAULT 'project',
          title TEXT NOT NULL DEFAULT '',
          body TEXT NOT NULL,
          source_type TEXT NOT NULL DEFAULT 'manual',
          source_id TEXT,
          tags TEXT NOT NULL DEFAULT '[]',
          hidden INTEGER NOT NULL DEFAULT 0,
          hit_count INTEGER NOT NULL DEFAULT 0,
          last_hit_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_noe_memory_project_hidden_updated
          ON noe_memory(project_id, hidden, updated_at);
        CREATE INDEX IF NOT EXISTS idx_noe_memory_scope_project
          ON noe_memory(scope, project_id, hidden);

        CREATE TABLE IF NOT EXISTS noe_focus_stack (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL DEFAULT 'default',
          title TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          state TEXT NOT NULL DEFAULT 'active',
          depth INTEGER NOT NULL DEFAULT 0,
          hit_count INTEGER NOT NULL DEFAULT 1,
          source_type TEXT NOT NULL DEFAULT 'manual',
          source_id TEXT,
          absorbed_memory_id TEXT,
          compressed_summary TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          popped_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_noe_focus_project_state_depth
          ON noe_focus_stack(project_id, state, depth);
        CREATE INDEX IF NOT EXISTS idx_noe_focus_project_title_state
          ON noe_focus_stack(project_id, title, state);

        CREATE TABLE IF NOT EXISTS noe_tools (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          version TEXT NOT NULL DEFAULT '0.0.0',
          category TEXT NOT NULL DEFAULT 'local',
          risk_level TEXT NOT NULL DEFAULT 'medium',
          enabled INTEGER NOT NULL DEFAULT 0,
          manifest TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_noe_tools_enabled_risk
          ON noe_tools(enabled, risk_level);
      `);

      try {
        db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS noe_memory_fts
          USING fts5(title, body, tags, content='noe_memory', content_rowid='rowid', tokenize='trigram');
        `);
      } catch {
        db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS noe_memory_fts
          USING fts5(title, body, tags, content='noe_memory', content_rowid='rowid');
        `);
      }

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS noe_memory_ai
        AFTER INSERT ON noe_memory
        WHEN new.hidden = 0
        BEGIN
          INSERT INTO noe_memory_fts(rowid, title, body, tags)
          VALUES (new.rowid, new.title, new.body, new.tags);
        END;

        CREATE TRIGGER IF NOT EXISTS noe_memory_ad
        AFTER DELETE ON noe_memory
        WHEN old.hidden = 0
        BEGIN
          INSERT INTO noe_memory_fts(noe_memory_fts, rowid, title, body, tags)
          VALUES ('delete', old.rowid, old.title, old.body, old.tags);
        END;

        CREATE TRIGGER IF NOT EXISTS noe_memory_au
        AFTER UPDATE ON noe_memory
        BEGIN
          INSERT INTO noe_memory_fts(noe_memory_fts, rowid, title, body, tags)
          SELECT 'delete', old.rowid, old.title, old.body, old.tags
          WHERE old.hidden = 0;
          INSERT INTO noe_memory_fts(rowid, title, body, tags)
          SELECT new.rowid, new.title, new.body, new.tags
          WHERE new.hidden = 0;
        END;
      `);
    },
  },
  {
    version: 3,
    name: 'noe_act_pipeline',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS noe_acts (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL DEFAULT 'noe',
          title TEXT NOT NULL,
          action TEXT NOT NULL,
          risk_level TEXT NOT NULL DEFAULT 'low',
          status TEXT NOT NULL DEFAULT 'queued',
          approval_id TEXT,
          budget_state TEXT NOT NULL DEFAULT 'pending',
          permission_state TEXT NOT NULL DEFAULT 'pending',
          failure_reason TEXT NOT NULL DEFAULT '',
          evidence_event_id INTEGER,
          log_ref TEXT NOT NULL DEFAULT '',
          cost_estimate_usd REAL NOT NULL DEFAULT 0,
          payload TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_noe_acts_project_status_updated
          ON noe_acts(project_id, status, updated_at);
        CREATE INDEX IF NOT EXISTS idx_noe_acts_approval
          ON noe_acts(approval_id);
      `);
    },
  },
  {
    version: 4,
    name: 'noe_memory_m1_metadata',
    up(db) {
      const cols = new Set(db.prepare("PRAGMA table_info(noe_memory)").all().map((row) => row.name));
      const addColumn = (name, ddl) => {
        if (!cols.has(name)) {
          db.exec(`ALTER TABLE noe_memory ADD COLUMN ${ddl}`);
          cols.add(name);
        }
      };
      addColumn('confidence', 'confidence REAL NOT NULL DEFAULT 1');
      addColumn('ttl_ms', 'ttl_ms INTEGER');
      addColumn('expires_at', 'expires_at INTEGER');
      addColumn('merge_trace', "merge_trace TEXT NOT NULL DEFAULT '[]'");
      addColumn('hidden_reason', 'hidden_reason TEXT');
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_noe_memory_expiry
          ON noe_memory(project_id, hidden, expires_at);
        CREATE INDEX IF NOT EXISTS idx_noe_memory_confidence
          ON noe_memory(project_id, hidden, confidence, updated_at);
      `);
    },
  },
  {
    version: 5,
    name: 'noe_memory_salience',
    up(db) {
      // 梦境/睡眠整合:salience(1-5 显著性) — 身份级=5 受保护、陈旧可降级。增量、非破坏。
      const cols = new Set(db.prepare("PRAGMA table_info(noe_memory)").all().map((row) => row.name));
      if (!cols.has('salience')) {
        db.exec('ALTER TABLE noe_memory ADD COLUMN salience INTEGER NOT NULL DEFAULT 3');
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_noe_memory_salience
          ON noe_memory(project_id, hidden, salience, updated_at);
      `);
    },
  },
  {
    version: 6,
    name: 'noe_memory_fts_au_trigger_guard',
    up(db) {
      // 审计 §3.3 P0-4：原 noe_memory_au UPDATE trigger 无条件重建 FTS（delete old + insert new），
      // 连 bumpHit（只改 hit_count/last_hit_at/updated_at）都触发 FTS title/body/tags 双写。
      // 改为仅在 hidden 切换或 title/body/tags 实际变化时同步 FTS（覆盖 hidden 转换 × 内容变化全组合）：
      //   - 删 old：old 在 FTS 里(old.hidden=0) 且 [将隐藏(new.hidden=1) 或 内容变了]
      //   - 插 new：new 应在 FTS 里(new.hidden=0) 且 [之前不在(old.hidden=1，unhide) 或 内容变了]
      // hidden=0→0 且内容未变（bumpHit 典型）时两条 INSERT 的 WHERE 均为假，彻底跳过 FTS 双写。
      // IFNULL 包裹防 NULL 比较陷阱（NULL<>NULL=NULL 会漏触发，导致 FTS 与主表不一致）。
      db.exec('DROP TRIGGER IF EXISTS noe_memory_au;');
      db.exec(`
        CREATE TRIGGER noe_memory_au
        AFTER UPDATE ON noe_memory
        BEGIN
          INSERT INTO noe_memory_fts(noe_memory_fts, rowid, title, body, tags)
          SELECT 'delete', old.rowid, old.title, old.body, old.tags
          WHERE old.hidden = 0
            AND (new.hidden = 1
                 OR IFNULL(old.title,'') <> IFNULL(new.title,'')
                 OR IFNULL(old.body,'')  <> IFNULL(new.body,'')
                 OR IFNULL(old.tags,'')  <> IFNULL(new.tags,''));
          INSERT INTO noe_memory_fts(rowid, title, body, tags)
          SELECT new.rowid, new.title, new.body, new.tags
          WHERE new.hidden = 0
            AND (old.hidden = 1
                 OR IFNULL(old.title,'') <> IFNULL(new.title,'')
                 OR IFNULL(old.body,'')  <> IFNULL(new.body,'')
                 OR IFNULL(old.tags,'')  <> IFNULL(new.tags,''));
        END;
      `);
    },
  },
  {
    version: 7,
    name: 'noe_cognition_core',
    up(db) {
      // 认知内核持久层（设计文档《AI自我意识实现方案》）：心跳台账/节奏游标/情感快照/期望账本/目标库。
      // 五张表一次建齐（同一特性族；建表惰性无副作用——各特性 env 门控默认 OFF 时表闲置零成本）。
      db.exec(`
        CREATE TABLE IF NOT EXISTS noe_ticks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          due_at INTEGER NOT NULL,
          started_at INTEGER,
          finished_at INTEGER,
          status TEXT NOT NULL DEFAULT 'pending',
          lease_until INTEGER,
          intent TEXT,
          outcome TEXT,
          error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_noe_ticks_status_due ON noe_ticks(status, due_at);
        CREATE INDEX IF NOT EXISTS idx_noe_ticks_kind_id ON noe_ticks(kind, id);

        CREATE TABLE IF NOT EXISTS noe_tick_cursor (
          kind TEXT PRIMARY KEY,
          next_due INTEGER NOT NULL,
          cadence_ms INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS noe_affect (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          v REAL NOT NULL,
          a REAL NOT NULL,
          d REAL NOT NULL,
          mood_v REAL NOT NULL,
          mood_a REAL NOT NULL,
          mood_d REAL NOT NULL,
          cause TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_noe_affect_ts ON noe_affect(ts);

        CREATE TABLE IF NOT EXISTS noe_expectations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at INTEGER NOT NULL,
          source TEXT NOT NULL DEFAULT 'conversation',
          claim TEXT NOT NULL,
          p REAL NOT NULL,
          due_at INTEGER,
          resolved_at INTEGER,
          outcome INTEGER,
          surprise REAL
        );
        CREATE INDEX IF NOT EXISTS idx_noe_expectations_open ON noe_expectations(resolved_at, due_at);

        CREATE TABLE IF NOT EXISTS noe_goals (
          id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          source TEXT NOT NULL DEFAULT 'drive',
          title TEXT NOT NULL,
          why TEXT,
          priority REAL NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'open',
          plan TEXT,
          budget TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_noe_goals_status_priority ON noe_goals(status, priority);
      `);
    },
  },
  {
    version: 8,
    name: 'noe_memory_temporal_facts',
    up(db) {
      const cols = new Set(db.prepare("PRAGMA table_info(noe_memory)").all().map((row) => row.name));
      const addColumn = (name, ddl) => {
        if (!cols.has(name)) {
          db.exec(`ALTER TABLE noe_memory ADD COLUMN ${ddl}`);
          cols.add(name);
        }
      };
      addColumn('valid_from', 'valid_from INTEGER');
      addColumn('valid_to', 'valid_to INTEGER');
      addColumn('source_episode_id', 'source_episode_id TEXT');
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_noe_memory_valid_window
          ON noe_memory(project_id, hidden, scope, valid_from, valid_to);
        CREATE INDEX IF NOT EXISTS idx_noe_memory_source_episode
          ON noe_memory(source_episode_id);
      `);
    },
  },
  {
    version: 9,
    name: 'noe_goal_checkpoints',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS noe_goal_checkpoints (
          id TEXT PRIMARY KEY,
          ts INTEGER NOT NULL,
          goal_id TEXT NOT NULL,
          step_index INTEGER NOT NULL,
          phase TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT '',
          kind TEXT NOT NULL DEFAULT '',
          action TEXT NOT NULL DEFAULT '',
          step TEXT NOT NULL DEFAULT '',
          note TEXT NOT NULL DEFAULT '',
          evidence_ref TEXT NOT NULL DEFAULT '',
          payload TEXT,
          replay_safe INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_noe_goal_checkpoints_goal_step_ts
          ON noe_goal_checkpoints(goal_id, step_index, ts);
        CREATE INDEX IF NOT EXISTS idx_noe_goal_checkpoints_phase_ts
          ON noe_goal_checkpoints(phase, ts);
      `);
    },
  },
  {
    version: 10,
    name: 'noe_memory_v2_governance',
    up(db) {
      ensureNoeMemoryV2Schema(db);
    },
  },
  {
    version: 11,
    name: 'noe_self_evolution_cycles',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS noe_self_evolution_cycles (
          cycle_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL DEFAULT 'noe',
          goal_id TEXT NOT NULL DEFAULT '',
          stage TEXT NOT NULL DEFAULT 'draft',
          cycle_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_noe_self_evolution_cycles_goal
          ON noe_self_evolution_cycles(goal_id, updated_at);
        CREATE INDEX IF NOT EXISTS idx_noe_self_evolution_cycles_project_stage
          ON noe_self_evolution_cycles(project_id, stage, updated_at);
      `);
    },
  },
  {
    // 好奇二分解接入（NoeCuriosityDecompose）：给 noe_goals 加 meta 列承载可解释元信息
    //   （如 meta.curiosity = {score, epistemic, pragmatic, label}）。默认 NULL → 完全向后兼容，
    //   只有 NOE_EFE_CURIOSITY=1 的 harvestSurprise 路径才写入。幂等 ALTER（同 v8 noe_memory 做法）。
    version: 12,
    name: 'noe_goals_meta',
    up(db) {
      const cols = new Set(db.prepare("PRAGMA table_info(noe_goals)").all().map((row) => row.name));
      if (!cols.has('meta')) db.exec('ALTER TABLE noe_goals ADD COLUMN meta TEXT');
    },
  },
  {
    version: 13,
    name: 'noe_expectations_resolved_by',
    up(db) {
      // P2-F2 整改：区分自评（auto=AUTORESOLVE 本地脑自判）vs owner holdout 裁决，
      // 让校准看板能诚实分层、不把全自评 Brier 当客观校准（防 Goodhart 自欺，路线 §4.2）。
      const cols = new Set(db.prepare("PRAGMA table_info(noe_expectations)").all().map((row) => row.name));
      if (!cols.has('resolved_by')) db.exec('ALTER TABLE noe_expectations ADD COLUMN resolved_by TEXT');
    },
  },
  {
    version: 14,
    name: 'noe_expectations_verifiable_attempts',
    up(db) {
      // 多模型安全方案步骤3+5：verifiable=可检验性（只有行为预测能被外部证据判生死，纯情绪内省标 0）；
      //   judge_attempts/last_judged_at=跨多跳持久判证计数（防单次 no_evidence 误判 FAILED）。供步骤5 安全转 FAILED 的护栏列。
      //   旧库无列时读取处已 PRAGMA 退化（NULL/0），零破坏。
      const cols = new Set(db.prepare("PRAGMA table_info(noe_expectations)").all().map((row) => row.name));
      if (!cols.has('verifiable')) db.exec('ALTER TABLE noe_expectations ADD COLUMN verifiable INTEGER DEFAULT NULL');
      if (!cols.has('judge_attempts')) db.exec('ALTER TABLE noe_expectations ADD COLUMN judge_attempts INTEGER DEFAULT 0');
      if (!cols.has('last_judged_at')) db.exec('ALTER TABLE noe_expectations ADD COLUMN last_judged_at INTEGER');
    },
  },
  {
    version: 15,
    name: 'noe_learning_jobs',
    up(db) {
      // P4 定时学习调度器（复刻 OpenClaw cron 引擎）：动态学习任务表。kind=at/every/cron；
      //   next_run_at_ms 持久化(重启续相位)；running_at_ms=运行锁(崩溃恢复 recoverStuck)；consecutive_errors=失败退避计数；
      //   consecutive_idle/mastery=Neo 成效自适应(学不动退避/学会了少看)。
      db.exec(`
        CREATE TABLE IF NOT EXISTS noe_learning_jobs (
          id TEXT PRIMARY KEY,
          topic TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'every',
          every_ms INTEGER, anchor_ms INTEGER, at_ms INTEGER, cron_expr TEXT, tz TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          priority REAL NOT NULL DEFAULT 0.5,
          next_run_at_ms INTEGER,
          running_at_ms INTEGER,
          last_run_at_ms INTEGER, last_status TEXT, last_error TEXT,
          consecutive_errors INTEGER NOT NULL DEFAULT 0,
          consecutive_idle INTEGER NOT NULL DEFAULT 0,
          mastery REAL NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_noe_learning_jobs_due ON noe_learning_jobs(enabled, next_run_at_ms)');
    },
  },
  {
    version: 16,
    name: 'noe_goal_candidates',
    up(db) {
      // P2 切片A：owner-seed/多源候选先进池打分（advisory frame），过阈才升格 noe_goals。
      //   decision=pending|accepted|rejected；risk_tier/risk_json 为 P3.2 风险门预留（owner-seed 路径留空）。
      db.exec(`
        CREATE TABLE IF NOT EXISTS noe_goal_candidates (
          id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          decided_at INTEGER,
          source TEXT NOT NULL DEFAULT 'unknown',
          title TEXT NOT NULL DEFAULT '',
          why TEXT NOT NULL DEFAULT '',
          base_score REAL,
          score REAL NOT NULL DEFAULT 0,
          decision TEXT NOT NULL DEFAULT 'pending',
          reject_reason TEXT NOT NULL DEFAULT '',
          risk_tier TEXT NOT NULL DEFAULT '',
          risk_json TEXT,
          goal_id TEXT,
          overridden_by_owner INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_noe_goal_candidates_decision
          ON noe_goal_candidates(decision, created_at);
      `);
    },
  },
];

function getSchemaVersion(db) {
  try {
    const row = db.prepare("SELECT v FROM kv WHERE k = 'schema_version'").get();
    const v = row ? Number(row.v) : 0;
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch { return 0; }
}

function setSchemaVersion(db, version) {
  db.prepare(`
    INSERT INTO kv(k, v, updated_at) VALUES ('schema_version', ?, strftime('%s','now'))
    ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at
  `).run(String(version));
}

function dbHasData(db) {
  try {
    const row = db.prepare('SELECT (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM agent_runs) AS n').get();
    return Number(row?.n) > 0;
  } catch { return false; }
}

// WAL 模式下裸 copyFileSync(.db) 会丢掉 -wal 里尚未 checkpoint 的数据（journal_mode=WAL +
// synchronous=NORMAL 时写入先落 -wal，主 .db 可能长期不含这些行）。修复：迁移前用活连接做一次
// wal_checkpoint(TRUNCATE) 把 WAL 全量刷进主库并清空 WAL，再 copy 主 .db（此时自洽、单文件）；
// checkpoint 不可用/失败时退化为「连 -wal/-shm 一起 copy」兜底，确保备份始终可恢复。
export function backupDbOnce(dbPath, db = null) {
  try {
    if (!dbPath || !fs.existsSync(dbPath) || fs.statSync(dbPath).size <= 0) return;
    const bak = `${dbPath}.bak`;
    let checkpointed = false;
    if (db && typeof db.pragma === 'function') {
      try {
        // TRUNCATE：把 WAL 全部内容 checkpoint 进主库后清零 WAL；之后主 .db 即完整快照。
        // codex post-review 返工：必须检查返回值 [{busy,log,checkpointed}]——busy!=0 表示有 reader
        // 持有、WAL 未全部刷入主库，此时主 .db 不自洽，当作未 checkpoint 走下方 -wal/-shm 兜底复制。
        const res = db.pragma('wal_checkpoint(TRUNCATE)');
        const row = Array.isArray(res) ? res[0] : res;
        checkpointed = !!row && Number(row.busy) === 0;
      } catch { /* checkpoint 失败走下方 -wal/-shm 兜底 */ }
    }
    fs.copyFileSync(dbPath, bak);
    try { fs.chmodSync(bak, 0o600); } catch {}
    // 兜底：若没能 checkpoint，把仍残留的 -wal/-shm 一并复制，保证备份可被还原（不丢 WAL 数据）。
    // 成功 TRUNCATE 后 WAL 已空，无需复制——备份保持自洽单文件，且清掉旧的 .bak-wal/.bak-shm。
    for (const ext of ['-wal', '-shm']) {
      const src = `${dbPath}${ext}`;
      const dst = `${bak}${ext}`;
      if (!checkpointed && fs.existsSync(src) && fs.statSync(src).size > 0) {
        try { fs.copyFileSync(src, dst); fs.chmodSync(dst, 0o600); } catch {}
      } else if (fs.existsSync(dst)) {
        try { fs.rmSync(dst, { force: true }); } catch {}
      }
    }
  } catch { /* 备份失败不阻断启动 */ }
}

function runMigrations(db, dbPath) {
  const latest = SCHEMA_MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);
  if (latest <= 0) return;
  const current = getSchemaVersion(db);
  const pending = SCHEMA_MIGRATIONS
    .filter((mg) => mg.version > current)
    .sort((a, b) => a.version - b.version);
  if (!pending.length) return;
  // 仅在升级既有数据库（已有数据）时一次性备份，避免给全新空库也产 .bak
  // 传入活连接 db：WAL 模式下先 checkpoint 把 -wal 刷进主库再 copy，否则备份会丢未 checkpoint 的数据。
  if (dbHasData(db)) backupDbOnce(dbPath, db);
  for (const mg of pending) {
    db.transaction(() => {
      mg.up(db);
      setSchemaVersion(db, mg.version);
    })();
  }
}

// ===== Events API（替代 jsonl 流式追加） =====
// 审计 §3.3 P2②：缓存 prepared statement，按 db 实例失效（切库后旧 statement 随旧连接失效则重建），
// 避免每次 appendEvent 都 prepare（事件写入是高频路径）。
let _insertEventStmt = null;
let _insertEventDb = null;
function _insertEvent() {
  const db = getDb();
  if (_insertEventDb !== db) {
    _insertEventStmt = db.prepare(`
      INSERT INTO events(ts, kind, room_id, session_id, tag, entity_type, entity_id, task_id, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    _insertEventDb = db;
  }
  return _insertEventStmt;
}

export function appendEvent({
  kind,
  ts = Date.now(),
  roomId = null,
  sessionId = null,
  tag = null,
  entityType = null,
  entityId = null,
  taskId = null,
  ...payload
}) {
  if (!kind) throw new Error('kind required');
  return _insertEvent().run(
    normalizeTs(ts),
    kind,
    nullableString(roomId),
    nullableString(sessionId),
    nullableString(tag),
    nullableString(entityType),
    nullableString(entityId),
    nullableString(taskId),
    JSON.stringify(payload)
  ).lastInsertRowid;
}

/**
 * events 表保留期清理（强健补遗 A，2026-06-10）：表此前只进不出（metrics/审计/tick 全往里写）。
 * 默认删 180 天前的行——足够保守（审计回看半年绰绰有余）；audit 类如需更长由调用方调大 retentionDays。
 *
 * 例外：kind='noe_episode'（EpisodicTimeline 自传体情景时间线，见 EpisodicTimeline.EPISODE_KIND）是 Noe 的连续记忆
 * 脊椎，绝不能随普通审计事件 180 天硬删（升华抢救 NOE_DREAM_EPISODES 默认 OFF，否则到期=无声丢失自传记忆）。
 * 故情景单独用明显更长的保留期 episodeRetentionDays（默认 3650 天=10 年，远超任何升华/反刍窗口）；仍保留清理
 * 天花板而非永不删，避免自传表无界增长。SQL 用字面量 'noe_episode' 而非 import 常量以免与 EpisodicTimeline
 * 形成模块环（对齐 noeMind.js / NoeMemoryProvenanceBackfill.js 既有写法）。
 * @returns {number} 删除行数（普通事件 + 超期情景之和）
 */
export function pruneEvents({ retentionDays = 180, episodeRetentionDays = 3650, now = Date.now() } = {}) {
  const days = Number(retentionDays);
  if (!Number.isFinite(days) || days < 7) throw new Error('retentionDays 必须 >= 7（防误传小值清空审计）');
  const epiDays = Number(episodeRetentionDays);
  if (!Number.isFinite(epiDays) || epiDays < days) throw new Error('episodeRetentionDays 必须 >= retentionDays（防把自传记忆配得比普通事件更快删）');
  const cutoff = now - days * 86400000;
  const epiCutoff = now - epiDays * 86400000;
  const db = getDb();
  // 普通事件按 retentionDays 清，但放过自传情景（noe_episode 由下一句用更长的 episodeRetentionDays 单独处理）。
  const generic = db.prepare("DELETE FROM events WHERE ts < ? AND kind != 'noe_episode'").run(cutoff).changes;
  const episodes = db.prepare("DELETE FROM events WHERE ts < ? AND kind = 'noe_episode'").run(epiCutoff).changes;
  return generic + episodes;
}

/**
 * SQLite-2 审计大表保留期：清理 noe_ticks（心跳台账，每拍一行，噪音大）+ agent_runs（agent 运行审计）旧行。
 * panel.db 1.3GB 的大头是 noe_ticks(~60万)/agent_runs(~31万)。删 agent_runs 经 ON DELETE CASCADE 自动级联删
 * agent_messages/agent_tool_results（外键确认仅此两表引用、均 CASCADE，无孤儿）；noe_ticks 无外键引用。
 *
 * 安全：两路保留期各自带 minDays 下限护栏（默认 7，仿 pruneEvents，防误传小值清空审计）。【不碰】记忆库
 *   noe_memory / 目标 noe_goals·noe_goal_candidates / 自改 noe_self_evolution_cycles / 语义 embeddings / 自传
 *   events.noe_episode（这些是 Neo 的认知资产，非审计噪音）。只删纯审计噪音表。
 * @returns {{ ticks:number, runs:number }} 各表删除行数（runs 不含级联子表行）
 */
export function pruneAuditTables({ tickRetentionDays = 14, agentRunRetentionDays = 30, minDays = 7, now = Date.now() } = {}) {
  const floor = Number.isFinite(Number(minDays)) && Number(minDays) >= 7 ? Number(minDays) : 7; // 护栏下限不低于 7
  const tDays = Number(tickRetentionDays);
  const aDays = Number(agentRunRetentionDays);
  if (!Number.isFinite(tDays) || tDays < floor) throw new Error(`tickRetentionDays 必须 >= ${floor}（防误传小值清空审计）`);
  if (!Number.isFinite(aDays) || aDays < floor) throw new Error(`agentRunRetentionDays 必须 >= ${floor}（防误传小值清空审计）`);
  const db = getDb();
  const tickCutoff = now - tDays * 86400000;
  const runCutoff = now - aDays * 86400000;
  // noe_ticks：用 COALESCE(finished_at, started_at, due_at) 取最晚已知时间，旧拍清理（含过期未跑的）。
  const ticks = db.prepare('DELETE FROM noe_ticks WHERE COALESCE(finished_at, started_at, due_at) < ?').run(tickCutoff).changes;
  // agent_runs（codex 审加固）：
  //   ① 只删【已完成】run（finished_at 非空且 < cutoff）——活跃/卡住的 run（finished_at=null，含 30 天前
  //      创建但仍 running/queued）绝不删，防误删活跃任务 + 级联丢消息/工具结果。
  //   ② 删前验证本库对 agent_messages/agent_tool_results 真有 ON DELETE CASCADE（CREATE IF NOT EXISTS 不给
  //      既有 production 旧表补外键）——不满足则跳过 agent_runs（防 orphan 子表 / 外键删失败），只清 noe_ticks。
  const cascadeOk = ['agent_messages', 'agent_tool_results'].every((t) => {
    try {
      return db.prepare(`PRAGMA foreign_key_list(${t})`).all()
        .some((fk) => fk.table === 'agent_runs' && String(fk.on_delete).toUpperCase() === 'CASCADE');
    } catch { return false; }
  });
  let runs = 0;
  if (cascadeOk) {
    runs = db.prepare('DELETE FROM agent_runs WHERE finished_at IS NOT NULL AND finished_at < ?').run(runCutoff).changes;
  }
  return { ticks, runs, agentRunsSkipped: !cascadeOk };
}

export function listEvents({
  kind,
  roomId,
  sessionId,
  tag,
  entityType,
  entityId,
  taskId,
  sinceTs,
  untilTs,
  limit = 200,
  order = 'DESC',
} = {}) {
  const where = [];
  const args = [];
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (roomId) { where.push('room_id = ?'); args.push(roomId); }
  if (sessionId) { where.push('session_id = ?'); args.push(sessionId); }
  if (tag) { where.push('tag = ?'); args.push(tag); }
  if (entityType) { where.push('entity_type = ?'); args.push(entityType); }
  if (entityId) { where.push('entity_id = ?'); args.push(entityId); }
  if (taskId) { where.push('task_id = ?'); args.push(taskId); }
  if (sinceTs !== undefined && sinceTs !== null) { where.push('ts >= ?'); args.push(normalizeTs(sinceTs)); }
  if (untilTs !== undefined && untilTs !== null) { where.push('ts <= ?'); args.push(normalizeTs(untilTs)); }
  const sql = `SELECT id, ts, kind, room_id, session_id, tag, entity_type, entity_id, task_id, payload FROM events
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ts ${order === 'ASC' ? 'ASC' : 'DESC'} LIMIT ?`;
  args.push(Math.min(limit, 10000));
  const rows = getDb().prepare(sql).all(...args);
  return rows.map(r => ({
    ...r,
    roomId: r.room_id,
    sessionId: r.session_id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    taskId: r.task_id,
    payload: tryParseJson(r.payload),
  }));
}

export function countEvents({ kind, roomId, sessionId, entityType, entityId, taskId, sinceTs, untilTs } = {}) {
  const where = [];
  const args = [];
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (roomId) { where.push('room_id = ?'); args.push(roomId); }
  if (sessionId) { where.push('session_id = ?'); args.push(sessionId); }
  if (entityType) { where.push('entity_type = ?'); args.push(entityType); }
  if (entityId) { where.push('entity_id = ?'); args.push(entityId); }
  if (taskId) { where.push('task_id = ?'); args.push(taskId); }
  if (sinceTs !== undefined && sinceTs !== null) { where.push('ts >= ?'); args.push(normalizeTs(sinceTs)); }
  if (untilTs !== undefined && untilTs !== null) { where.push('ts <= ?'); args.push(normalizeTs(untilTs)); }
  const sql = `SELECT COUNT(*) as c FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  return getDb().prepare(sql).get(...args).c;
}

// ===== KV API =====
export function kvGet(k) {
  const r = getDb().prepare('SELECT v FROM kv WHERE k = ?').get(k);
  return r ? tryParseJson(r.v) : null;
}

export function kvSet(k, v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return getDb().prepare(`
    INSERT INTO kv(k, v, updated_at) VALUES (?, ?, strftime('%s','now'))
    ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at
  `).run(k, s).changes;
}

export function kvDelete(k) {
  return getDb().prepare('DELETE FROM kv WHERE k = ?').run(k).changes;
}

// ===== Room summary API =====
export function upsertRoomSummary(summary) {
  return getDb().prepare(`
    INSERT INTO room_summary(room_id, mode, topic, status, started_at, ended_at, cost_cents, msg_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
    ON CONFLICT(room_id) DO UPDATE SET
      mode = excluded.mode, topic = excluded.topic, status = excluded.status,
      started_at = excluded.started_at, ended_at = excluded.ended_at,
      cost_cents = excluded.cost_cents, msg_count = excluded.msg_count,
      updated_at = excluded.updated_at
  `).run(
    summary.roomId, summary.mode, summary.topic, summary.status,
    summary.startedAt || null, summary.endedAt || null,
    summary.costCents || 0, summary.msgCount || 0
  ).changes;
}

export function listRoomSummary({ status, limit = 200 } = {}) {
  const where = status ? 'WHERE status = ?' : '';
  const args = status ? [status] : [];
  args.push(limit);
  return getDb().prepare(`SELECT * FROM room_summary ${where} ORDER BY updated_at DESC LIMIT ?`).all(...args);
}

// ===== 工具 =====
function tryParseJson(s) {
  if (!s || typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return s; }
}

function nullableString(v) {
  if (v === undefined || v === null || v === '') return null;
  return String(v).slice(0, 512);
}

function normalizeTs(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) return Math.trunc(ts);
  if (typeof ts === 'string') {
    const n = Number(ts);
    if (Number.isFinite(n)) return Math.trunc(n);
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function ensureEventsSchema(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(events)').all().map((c) => c.name));
  const addColumn = (name, definition) => {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE events ADD COLUMN ${name} ${definition}`);
      columns.add(name);
    }
  };
  addColumn('session_id', 'TEXT');
  addColumn('entity_type', 'TEXT');
  addColumn('entity_id', 'TEXT');
  addColumn('task_id', 'TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_session_kind ON events(session_id, kind);
    CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);
  `);
}

// ===== 健康/统计 =====
export function getStats() {
  const db = getDb();
  return {
    dbPath: _dbPath,
    sizeBytes: fs.existsSync(_dbPath) ? fs.statSync(_dbPath).size : 0,
    counts: {
      events: db.prepare('SELECT COUNT(*) as c FROM events').get().c,
      kv: db.prepare('SELECT COUNT(*) as c FROM kv').get().c,
      room_summary: db.prepare('SELECT COUNT(*) as c FROM room_summary').get().c,
      embeddings: db.prepare('SELECT COUNT(*) as c FROM embeddings').get().c,
      budget_policies: db.prepare('SELECT COUNT(*) as c FROM budget_policies').get().c,
      budget_usage: db.prepare('SELECT COUNT(*) as c FROM budget_usage').get().c,
      budget_incidents: db.prepare('SELECT COUNT(*) as c FROM budget_incidents').get().c,
      approvals: db.prepare('SELECT COUNT(*) as c FROM approvals').get().c,
      approval_comments: db.prepare('SELECT COUNT(*) as c FROM approval_comments').get().c,
      autopilot_schedules: db.prepare('SELECT COUNT(*) as c FROM autopilot_schedules').get().c,
      autopilot_jobs: db.prepare('SELECT COUNT(*) as c FROM autopilot_jobs').get().c,
      autopilot_runs: db.prepare('SELECT COUNT(*) as c FROM autopilot_runs').get().c,
      delegations: db.prepare('SELECT COUNT(*) as c FROM delegations').get().c,
      agent_runs: db.prepare('SELECT COUNT(*) as c FROM agent_runs').get().c,
      agent_messages: db.prepare('SELECT COUNT(*) as c FROM agent_messages').get().c,
      agent_tool_results: db.prepare('SELECT COUNT(*) as c FROM agent_tool_results').get().c,
    },
  };
}

function ensureAgentRunSchema(db) {
  const tableNames = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  if (!tableNames.has('agent_runs')) return;
  const columns = new Set(db.prepare('PRAGMA table_info(agent_runs)').all().map((c) => c.name));
  const addColumn = (name, definition) => {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE agent_runs ADD COLUMN ${name} ${definition}`);
      columns.add(name);
    }
  };
  addColumn('turn_id', 'TEXT');
  addColumn('source_type', 'TEXT');
  addColumn('source_id', 'TEXT');
  addColumn('defer_reason', 'TEXT');
  addColumn('approval_id', 'TEXT');
  addColumn('budget_incident_id', 'TEXT');
  addColumn('delegation_id', 'TEXT');
  addColumn('related_activity_ids', "TEXT NOT NULL DEFAULT '[]'");
  addColumn('governance', "TEXT NOT NULL DEFAULT '{}'");
  addColumn('details', "TEXT NOT NULL DEFAULT '{}'");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_runs_room_status ON agent_runs(room_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_profile_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_source ON agent_runs(source_type, source_id);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_delegation ON agent_runs(delegation_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_approval ON agent_runs(approval_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_run ON agent_messages(run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_tool_results_run ON agent_tool_results(run_id, created_at);
  `);
}
