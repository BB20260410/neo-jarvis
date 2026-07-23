import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildNoeMemorySemanticRecallQualityAudit,
  renderMarkdown,
  vectorToBuf,
} from '../../scripts/noe-memory-semantic-recall-quality-audit.mjs';

describe('noe-memory-semantic-recall-quality-audit', () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function createDb() {
    dir = mkdtempSync(join(tmpdir(), 'noe-memory-semantic-recall-quality-'));
    const dbPath = join(dir, 'panel.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        text TEXT NOT NULL,
        vector BLOB,
        dim INTEGER,
        model TEXT,
        created_at INTEGER NOT NULL DEFAULT 0,
        UNIQUE(kind, ref_id)
      );
      CREATE TABLE noe_memory (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL DEFAULT 'noe',
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
        updated_at INTEGER NOT NULL,
        confidence REAL NOT NULL DEFAULT 1,
        ttl_ms INTEGER,
        expires_at INTEGER,
        merge_trace TEXT NOT NULL DEFAULT '[]',
        hidden_reason TEXT,
        salience INTEGER NOT NULL DEFAULT 3,
        valid_from INTEGER,
        valid_to INTEGER,
        source_episode_id TEXT
      );
      CREATE TABLE noe_memory_retrieval_log (
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
    `);
    db.prepare(`
      INSERT INTO noe_memory(id, scope, title, body, source_type, hidden, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, 1, 1)
    `).run('mem-project', 'project', 'SECRET TITLE SHOULD NOT LEAK', 'SECRET MEMORY BODY SHOULD NOT LEAK', 'manual');
    db.prepare(`
      INSERT INTO noe_memory(id, scope, title, body, source_type, hidden, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, 1, 1)
    `).run('mem-fact', 'fact', 'another title', 'another body', 'fact_extract');
    db.prepare(`
      INSERT INTO embeddings(kind, ref_id, text, vector, dim, model)
      VALUES ('noe_memory', ?, ?, ?, 3, 'qwen3-embedding:0.6b')
    `).run('mem-project', 'SECRET EMBEDDING TEXT SHOULD NOT LEAK', vectorToBuf([1, 0, 0]));
    db.prepare(`
      INSERT INTO embeddings(kind, ref_id, text, vector, dim, model)
      VALUES ('noe_memory', ?, ?, ?, 3, 'qwen3-embedding:0.6b')
    `).run('mem-fact', 'fact text', vectorToBuf([0, 1, 0]));
    db.prepare(`
      INSERT INTO noe_memory_retrieval_log(ts, turn_id, project_id, route_type, query_hash, hit_ids, selected_ids)
      VALUES (100, 'turn-1', 'noe', 'chat', 'hash', ?, ?)
    `).run(JSON.stringify(['mem-project', 'mem-fact']), JSON.stringify(['mem-project']));
    db.close();
    return dbPath;
  }

  it('audits semantic recall quality without exporting memory text', async () => {
    const dbPath = createDb();
    const report = await buildNoeMemorySemanticRecallQualityAudit({
      dbPath,
      env: {},
      queries: [{ id: 'project', q: 'project memory', routeType: 'mission' }],
      embedText: async () => ({
        vector: new Float32Array([1, 0, 0]),
        provider: 'ollama',
        model: 'qwen3-embedding:0.6b',
      }),
      now: new Date('2026-06-15T00:00:00.000Z'),
    });
    const raw = JSON.stringify(report);
    const md = renderMarkdown(report, join(dir, 'audit.json'));

    expect(report.ok).toBe(true);
    expect(report.quality.status).toBe('recall_quality_probe_passed');
    expect(report.storedSemantic).toMatchObject({ entries: 2, refs: 2, visibleRefs: 2 });
    expect(report.retrievalLogCoverage).toMatchObject({
      logs: 1,
      logsWithSelected: 1,
      distinctSelectedIds: 1,
      selectedIdsVisible: 1,
      selectedIdsWithCurrentEmbedding: 1,
      selectedVisibleCoverage: 1,
      selectedEmbeddingCoverage: 1,
    });
    expect(report.queryProbe.rows[0]).toMatchObject({
      ok: true,
      hitCount: 1,
      topScore: 1,
    });
    expect(report.queryProbe.rows[0].hits[0]).toMatchObject({
      scope: 'project',
      sourceType: 'manual',
      model: 'qwen3-embedding:0.6b',
      score: 1,
    });
    expect(raw).not.toContain('SECRET TITLE');
    expect(raw).not.toContain('SECRET MEMORY BODY');
    expect(raw).not.toContain('SECRET EMBEDDING TEXT');
    expect(md).not.toContain('SECRET');
  });

  it('reports blockers when query probes return no semantic hits', async () => {
    const dbPath = createDb();
    const report = await buildNoeMemorySemanticRecallQualityAudit({
      dbPath,
      env: {},
      queries: [{ id: 'miss', q: 'no match', routeType: 'chat' }],
      minScore: 0.9,
      embedText: async () => ({
        vector: new Float32Array([0, 0, 1]),
        provider: 'ollama',
        model: 'qwen3-embedding:0.6b',
      }),
      now: new Date('2026-06-15T00:00:00.000Z'),
    });

    expect(report.ok).toBe(false);
    expect(report.quality.status).toBe('needs_attention');
    expect(report.quality.blockers).toContain('semantic_query_probe_empty_hits');
  });

  it('excludes legitimately-cleaned selected ids from coverage denominator (no false blocker)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noe-memory-semantic-recall-quality-cleaned-'));
    const dbPath = join(dir, 'panel.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref_id TEXT NOT NULL,
        text TEXT NOT NULL, vector BLOB, dim INTEGER, model TEXT,
        created_at INTEGER NOT NULL DEFAULT 0, UNIQUE(kind, ref_id)
      );
      CREATE TABLE noe_memory (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT 'noe', scope TEXT NOT NULL DEFAULT 'project',
        title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, source_type TEXT NOT NULL DEFAULT 'manual',
        source_id TEXT, tags TEXT NOT NULL DEFAULT '[]', hidden INTEGER NOT NULL DEFAULT 0,
        hit_count INTEGER NOT NULL DEFAULT 0, last_hit_at INTEGER, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, confidence REAL NOT NULL DEFAULT 1, ttl_ms INTEGER, expires_at INTEGER,
        merge_trace TEXT NOT NULL DEFAULT '[]', hidden_reason TEXT, salience INTEGER NOT NULL DEFAULT 3,
        valid_from INTEGER, valid_to INTEGER, source_episode_id TEXT
      );
      CREATE TABLE noe_memory_retrieval_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, turn_id TEXT,
        project_id TEXT NOT NULL DEFAULT 'noe', route_type TEXT NOT NULL DEFAULT '', query_hash TEXT NOT NULL,
        channel_summary TEXT NOT NULL DEFAULT '{}', hit_ids TEXT NOT NULL DEFAULT '[]',
        selected_ids TEXT NOT NULL DEFAULT '[]', dropped_reasons TEXT NOT NULL DEFAULT '[]'
      );
    `);
    // 一条仍可见 + embedding 在的好卡。
    db.prepare("INSERT INTO noe_memory(id, scope, title, body, source_type, hidden, created_at, updated_at) VALUES (?, 'project', 't', 'b', 'manual', 0, 1, 1)").run('mem-good');
    // 一条被 P5 污染清理软删（hidden=1, reason 含 poison）—— 应从 coverage 分母剔除，不算 miss。
    db.prepare("INSERT INTO noe_memory(id, scope, title, body, source_type, hidden, hidden_reason, created_at, updated_at) VALUES (?, 'project', 't', 'b', 'skill_distill', 1, 'p5_distill_poison_cleanup', 1, 1)").run('mem-cleaned');
    // 一条被 merge 去重软删 —— 同样剔除。
    db.prepare("INSERT INTO noe_memory(id, scope, title, body, source_type, hidden, hidden_reason, created_at, updated_at) VALUES (?, 'project', 't', 'b', 'fact_extract', 1, 'merged_into:mem-good', 1, 1)").run('mem-merged');
    db.prepare("INSERT INTO embeddings(kind, ref_id, text, vector, dim, model) VALUES ('noe_memory', ?, 't', ?, 3, 'qwen3-embedding:0.6b')").run('mem-good', vectorToBuf([1, 0, 0]));
    // 被清理的卡 embedding 行尚未 GC（模拟真实库）—— 不该让 embedding coverage 越过 1.0。
    db.prepare("INSERT INTO embeddings(kind, ref_id, text, vector, dim, model) VALUES ('noe_memory', ?, 't', ?, 3, 'qwen3-embedding:0.6b')").run('mem-cleaned', vectorToBuf([1, 0, 0]));
    db.prepare("INSERT INTO noe_memory_retrieval_log(ts, turn_id, project_id, route_type, query_hash, hit_ids, selected_ids) VALUES (100, 'turn-1', 'noe', 'chat', 'hash', ?, ?)")
      .run(JSON.stringify(['mem-good', 'mem-cleaned', 'mem-merged']), JSON.stringify(['mem-good', 'mem-cleaned', 'mem-merged']));
    db.close();

    const report = await buildNoeMemorySemanticRecallQualityAudit({
      dbPath,
      env: {},
      queries: [{ id: 'good', q: 'good', routeType: 'mission' }],
      embedText: async () => ({ vector: new Float32Array([1, 0, 0]), provider: 'ollama', model: 'qwen3-embedding:0.6b' }),
      now: new Date('2026-06-15T00:00:00.000Z'),
    });

    // 3 个 selected，2 个被合理清理 → 分母=1，剩下的 mem-good 可见且有 embedding → coverage 全 1.0，无假失败。
    expect(report.retrievalLogCoverage).toMatchObject({
      distinctSelectedIds: 3,
      selectedIdsCleaned: 2,
      selectedIdsCoverageDenominator: 1,
      selectedIdsVisible: 1,
      selectedIdsWithCurrentEmbedding: 1,
      selectedVisibleCoverage: 1,
      selectedEmbeddingCoverage: 1,
    });
    expect(report.quality.blockers).not.toContain('retrieval_selected_visible_coverage_low');
    expect(report.quality.blockers).not.toContain('retrieval_selected_embedding_coverage_low');
  });

  it('still counts unexplained vanished selected ids as a coverage miss', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noe-memory-semantic-recall-quality-miss-'));
    const dbPath = join(dir, 'panel.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref_id TEXT NOT NULL,
        text TEXT NOT NULL, vector BLOB, dim INTEGER, model TEXT,
        created_at INTEGER NOT NULL DEFAULT 0, UNIQUE(kind, ref_id)
      );
      CREATE TABLE noe_memory (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT 'noe', scope TEXT NOT NULL DEFAULT 'project',
        title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, source_type TEXT NOT NULL DEFAULT 'manual',
        source_id TEXT, tags TEXT NOT NULL DEFAULT '[]', hidden INTEGER NOT NULL DEFAULT 0,
        hit_count INTEGER NOT NULL DEFAULT 0, last_hit_at INTEGER, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, confidence REAL NOT NULL DEFAULT 1, ttl_ms INTEGER, expires_at INTEGER,
        merge_trace TEXT NOT NULL DEFAULT '[]', hidden_reason TEXT, salience INTEGER NOT NULL DEFAULT 3,
        valid_from INTEGER, valid_to INTEGER, source_episode_id TEXT
      );
      CREATE TABLE noe_memory_retrieval_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, turn_id TEXT,
        project_id TEXT NOT NULL DEFAULT 'noe', route_type TEXT NOT NULL DEFAULT '', query_hash TEXT NOT NULL,
        channel_summary TEXT NOT NULL DEFAULT '{}', hit_ids TEXT NOT NULL DEFAULT '[]',
        selected_ids TEXT NOT NULL DEFAULT '[]', dropped_reasons TEXT NOT NULL DEFAULT '[]'
      );
    `);
    db.prepare("INSERT INTO noe_memory(id, scope, title, body, source_type, hidden, created_at, updated_at) VALUES (?, 'project', 't', 'b', 'manual', 0, 1, 1)").run('mem-good');
    // hidden=1 但 reason 不属合理清理白名单（例如人工误删/未知）—— 必须仍算 miss，别把所有软删都当合理。
    db.prepare("INSERT INTO noe_memory(id, scope, title, body, source_type, hidden, hidden_reason, created_at, updated_at) VALUES (?, 'project', 't', 'b', 'manual', 1, 'manual_hide_unknown', 1, 1)").run('mem-vanished');
    db.prepare("INSERT INTO embeddings(kind, ref_id, text, vector, dim, model) VALUES ('noe_memory', ?, 't', ?, 3, 'qwen3-embedding:0.6b')").run('mem-good', vectorToBuf([1, 0, 0]));
    db.prepare("INSERT INTO noe_memory_retrieval_log(ts, turn_id, project_id, route_type, query_hash, hit_ids, selected_ids) VALUES (100, 'turn-1', 'noe', 'chat', 'hash', ?, ?)")
      .run(JSON.stringify(['mem-good', 'mem-vanished']), JSON.stringify(['mem-good', 'mem-vanished']));
    db.close();

    const report = await buildNoeMemorySemanticRecallQualityAudit({
      dbPath,
      env: {},
      queries: [{ id: 'good', q: 'good', routeType: 'mission' }],
      embedText: async () => ({ vector: new Float32Array([1, 0, 0]), provider: 'ollama', model: 'qwen3-embedding:0.6b' }),
      now: new Date('2026-06-15T00:00:00.000Z'),
    });

    // 2 selected，0 合理清理 → 分母=2，只有 1 个可见 → coverage 0.5 < 0.8 → 真 blocker 仍报。
    expect(report.retrievalLogCoverage).toMatchObject({
      distinctSelectedIds: 2,
      selectedIdsCleaned: 0,
      selectedIdsCoverageDenominator: 2,
      selectedIdsVisible: 1,
      selectedVisibleCoverage: 0.5,
    });
    expect(report.quality.blockers).toContain('retrieval_selected_visible_coverage_low');
  });

  function createCoverageDb(rows, selectedIds, hitIds = selectedIds) {
    dir = mkdtempSync(join(tmpdir(), 'noe-memory-semantic-recall-quality-cov-'));
    const dbPath = join(dir, 'panel.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref_id TEXT NOT NULL,
        text TEXT NOT NULL, vector BLOB, dim INTEGER, model TEXT,
        created_at INTEGER NOT NULL DEFAULT 0, UNIQUE(kind, ref_id)
      );
      CREATE TABLE noe_memory (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT 'noe', scope TEXT NOT NULL DEFAULT 'project',
        title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, source_type TEXT NOT NULL DEFAULT 'manual',
        source_id TEXT, tags TEXT NOT NULL DEFAULT '[]', hidden INTEGER NOT NULL DEFAULT 0,
        hit_count INTEGER NOT NULL DEFAULT 0, last_hit_at INTEGER, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, confidence REAL NOT NULL DEFAULT 1, ttl_ms INTEGER, expires_at INTEGER,
        merge_trace TEXT NOT NULL DEFAULT '[]', hidden_reason TEXT, salience INTEGER NOT NULL DEFAULT 3,
        valid_from INTEGER, valid_to INTEGER, source_episode_id TEXT
      );
      CREATE TABLE noe_memory_retrieval_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, turn_id TEXT,
        project_id TEXT NOT NULL DEFAULT 'noe', route_type TEXT NOT NULL DEFAULT '', query_hash TEXT NOT NULL,
        channel_summary TEXT NOT NULL DEFAULT '{}', hit_ids TEXT NOT NULL DEFAULT '[]',
        selected_ids TEXT NOT NULL DEFAULT '[]', dropped_reasons TEXT NOT NULL DEFAULT '[]'
      );
    `);
    const insMem = db.prepare(
      'INSERT INTO noe_memory(id, scope, title, body, source_type, hidden, hidden_reason, created_at, updated_at) VALUES (?, \'project\', \'t\', \'b\', ?, ?, ?, 1, 1)',
    );
    const insEmb = db.prepare(
      "INSERT INTO embeddings(kind, ref_id, text, vector, dim, model) VALUES ('noe_memory', ?, 't', ?, 3, 'qwen3-embedding:0.6b')",
    );
    for (const r of rows) {
      insMem.run(r.id, r.sourceType || 'manual', r.hidden ? 1 : 0, r.hiddenReason ?? null);
      if (r.embedding !== false) insEmb.run(r.id, vectorToBuf([1, 0, 0]));
    }
    db.prepare(
      "INSERT INTO noe_memory_retrieval_log(ts, turn_id, project_id, route_type, query_hash, hit_ids, selected_ids) VALUES (100, 'turn-1', 'noe', 'chat', 'hash', ?, ?)",
    ).run(JSON.stringify(hitIds), JSON.stringify(selectedIds));
    db.close();
    return dbPath;
  }

  it('skips coverage blocker entirely when every selected id was legitimately cleaned (denominator=0)', async () => {
    // 全部 selected 都是合理清理软删（merge / P5 污染）→ 分母=0、coverage=null →
    //   没有「本应可见却消失」的样本可判，绝不能报 retrieval_selected_*_coverage_low 假失败。
    const dbPath = createCoverageDb(
      [
        { id: 'mem-merged', hidden: true, hiddenReason: 'merged_into:mem-x', sourceType: 'fact_extract' },
        { id: 'mem-poison', hidden: true, hiddenReason: 'p5_distill_poison_cleanup', sourceType: 'skill_distill' },
      ],
      ['mem-merged', 'mem-poison'],
    );
    const report = await buildNoeMemorySemanticRecallQualityAudit({
      dbPath,
      env: {},
      queries: [{ id: 'q', q: 'q', routeType: 'mission' }],
      embedText: async () => ({ vector: new Float32Array([1, 0, 0]), provider: 'ollama', model: 'qwen3-embedding:0.6b' }),
      now: new Date('2026-06-15T00:00:00.000Z'),
    });

    expect(report.retrievalLogCoverage).toMatchObject({
      distinctSelectedIds: 2,
      selectedIdsCleaned: 2,
      selectedIdsCoverageDenominator: 0,
      selectedVisibleCoverage: null,
      selectedEmbeddingCoverage: null,
    });
    expect(report.quality.blockers).not.toContain('retrieval_selected_visible_coverage_low');
    expect(report.quality.blockers).not.toContain('retrieval_selected_embedding_coverage_low');
  });

  it('does NOT exclude non-whitelist "cleanup"/"merged" reasons (e.g. cleanup_failed) — still counts as miss', async () => {
    // reason 含 'cleanup' / 'merged' 字样但不属合理清理白名单（失败/误删/部分匹配）—— 宽 LIKE 会误剔，
    //   锚定白名单必须仍把它们计入分母并算 miss，否则掩盖真失败。
    const dbPath = createCoverageDb(
      [
        { id: 'mem-good', hidden: false },
        // 'cleanup_failed' 被旧 LIKE '%cleanup%' 误当合理清理；白名单不收 → 仍算消失的 miss。
        { id: 'mem-cleanup-failed', hidden: true, hiddenReason: 'cleanup_failed' },
        // 'manual_cleanup_mistake' 同理（人工误删）。
        { id: 'mem-cleanup-mistake', hidden: true, hiddenReason: 'manual_cleanup_mistake' },
        // 'merged' 但非 'merged_into:' 前缀（如残留/异常写入）—— 白名单只认 merged_into: 前缀，仍算 miss。
        { id: 'mem-merged-stray', hidden: true, hiddenReason: 'merged' },
      ],
      ['mem-good', 'mem-cleanup-failed', 'mem-cleanup-mistake', 'mem-merged-stray'],
    );
    const report = await buildNoeMemorySemanticRecallQualityAudit({
      dbPath,
      env: {},
      queries: [{ id: 'q', q: 'q', routeType: 'mission' }],
      embedText: async () => ({ vector: new Float32Array([1, 0, 0]), provider: 'ollama', model: 'qwen3-embedding:0.6b' }),
      now: new Date('2026-06-15T00:00:00.000Z'),
    });

    // 4 selected，0 合理清理（白名单一个都不命中）→ 分母=4，仅 1 可见 → coverage 0.25 < 0.8 → 真 blocker 报。
    expect(report.retrievalLogCoverage).toMatchObject({
      distinctSelectedIds: 4,
      selectedIdsCleaned: 0,
      selectedIdsCoverageDenominator: 4,
      selectedIdsVisible: 1,
      selectedVisibleCoverage: 0.25,
    });
    expect(report.quality.blockers).toContain('retrieval_selected_visible_coverage_low');
  });
});
