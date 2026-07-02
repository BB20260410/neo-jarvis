// @ts-check
/**
 * NoeKnowledgeGraphTemporal 双时态策略层的单元测试。
 *
 * 关注点：
 *  - 单值关系白名单的语义边界（isSingleValuedRel / SINGLE_VALUED_REL_TYPES）
 *  - 窗口级 id 的确定性 + eventStartAt 必须参与（防 lives_in 成都→上海→成都 撞 id）
 *  - ensureTemporalColumns 在「v2 表」和「v1 表带 UNIQUE」两种形态下的幂等/重建行为
 *  - COALESCE 回填不覆盖已显式设置的双时态值
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

import {
  TEMPORAL_COLUMNS,
  SINGLE_VALUED_REL_TYPES,
  isSingleValuedRel,
  windowRelationId,
  ensureTemporalColumns,
} from '../../src/memory/NoeKnowledgeGraphTemporal.js';

/** 全新 v2 关系表（无 UNIQUE，与双时态「同三元组多窗口」兼容），用于测幂等补列分支。 */
function createV2RelationTable(db) {
  db.exec(`
    CREATE TABLE noe_kg_relation (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'noe',
      src TEXT NOT NULL,
      dst TEXT NOT NULL,
      rel_type TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      refs TEXT NOT NULL DEFAULT '[]',
      strength INTEGER NOT NULL DEFAULT 5,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_noe_kg_relation_src ON noe_kg_relation(project_id, src);
    CREATE INDEX idx_noe_kg_relation_dst ON noe_kg_relation(project_id, dst);
  `);
}

/** 老 v1 关系表（带 UNIQUE，双时态旧版），用于测整表重建分支。 */
function createV1RelationTable(db) {
  db.exec(`
    CREATE TABLE noe_kg_relation (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'noe',
      src TEXT NOT NULL,
      dst TEXT NOT NULL,
      rel_type TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      refs TEXT NOT NULL DEFAULT '[]',
      strength INTEGER NOT NULL DEFAULT 5,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(project_id, src, dst, rel_type)
    );
  `);
}

describe('NoeKnowledgeGraphTemporal', () => {
  describe('TEMPORAL_COLUMNS', () => {
    it('declares the three bitemporal columns (event_start_at / event_end_at / ingested_at)', () => {
      const names = TEMPORAL_COLUMNS.map(([n]) => n);
      expect(names).toEqual(['event_start_at', 'event_end_at', 'ingested_at']);
      // 每条都是 INTEGER —— SQLite 存时间戳用整数。
      for (const [, ddl] of TEMPORAL_COLUMNS) {
        expect(ddl).toContain('INTEGER');
      }
    });
  });

  describe('SINGLE_VALUED_REL_TYPES', () => {
    it('includes has_type (the only type with a writer wired up today)', () => {
      expect(SINGLE_VALUED_REL_TYPES.has('has_type')).toBe(true);
    });

    it('includes the people-fact slots (lives_in / current_city / status)', () => {
      // 接线现状：人物事实的写入路径尚未接线，但策略已就位 —— 等上层接入。
      expect(SINGLE_VALUED_REL_TYPES.has('lives_in')).toBe(true);
      expect(SINGLE_VALUED_REL_TYPES.has('current_city')).toBe(true);
      expect(SINGLE_VALUED_REL_TYPES.has('status')).toBe(true);
      expect(SINGLE_VALUED_REL_TYPES.has('is_a')).toBe(true);
      expect(SINGLE_VALUED_REL_TYPES.has('named')).toBe(true);
    });

    it('excludes multi-valued owner-like rels (owner_of / works_at / belongs_to / contains)', () => {
      // 刻意排除：dst 不同 = 并存事实，不该 supersede。
      expect(SINGLE_VALUED_REL_TYPES.has('owner_of')).toBe(false);
      expect(SINGLE_VALUED_REL_TYPES.has('works_at')).toBe(false);
      expect(SINGLE_VALUED_REL_TYPES.has('belongs_to')).toBe(false);
      expect(SINGLE_VALUED_REL_TYPES.has('contains')).toBe(false);
      expect(SINGLE_VALUED_REL_TYPES.has('mentions')).toBe(false);
      expect(SINGLE_VALUED_REL_TYPES.has('related_to')).toBe(false);
    });
  });

  describe('isSingleValuedRel()', () => {
    it('returns true for known single-valued rel_types', () => {
      expect(isSingleValuedRel('has_type')).toBe(true);
      expect(isSingleValuedRel('lives_in')).toBe(true);
      expect(isSingleValuedRel('is_a')).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(isSingleValuedRel('HAS_TYPE')).toBe(true);
      expect(isSingleValuedRel('Lives_In')).toBe(true);
    });

    it('trims surrounding whitespace', () => {
      expect(isSingleValuedRel('  has_type  ')).toBe(true);
    });

    it('returns false for unknown / multi-valued rel_types', () => {
      expect(isSingleValuedRel('contains')).toBe(false);
      expect(isSingleValuedRel('mentions')).toBe(false);
      expect(isSingleValuedRel('not_a_real_rel')).toBe(false);
    });

    it('is null / undefined / empty safe', () => {
      expect(isSingleValuedRel(null)).toBe(false);
      expect(isSingleValuedRel(undefined)).toBe(false);
      expect(isSingleValuedRel('')).toBe(false);
      expect(isSingleValuedRel('   ')).toBe(false);
      expect(isSingleValuedRel(0)).toBe(false); // String(0)='0' 不在白名单
    });
  });

  describe('windowRelationId()', () => {
    const base = { projectId: 'p1', srcId: 's', relType: 'lives_in', dstId: 'd', eventStartAt: 100 };

    it('is deterministic for the same window', () => {
      expect(windowRelationId(base)).toBe(windowRelationId(base));
    });

    it('returns a 20-char hex string (sha256 truncated)', () => {
      const id = windowRelationId(base);
      expect(id).toHaveLength(20);
      expect(id).toMatch(/^[0-9a-f]{20}$/);
    });

    it('differs when eventStartAt differs (lives_in 成都→上海→成都 = 2 windows for same triple)', () => {
      // 核心约束：window id 必须含 eventStartAt，否则二次开同窗会与历史窗 id 撞、覆盖历史。
      const a = windowRelationId({ ...base, eventStartAt: 100 });
      const b = windowRelationId({ ...base, eventStartAt: 200 });
      const c = windowRelationId({ ...base, eventStartAt: 100 }); // 与 a 同窗口
      expect(a).not.toBe(b);
      expect(a).toBe(c);
    });

    it('differs when any of projectId / srcId / dstId / relType differs', () => {
      const seed = windowRelationId(base);
      expect(windowRelationId({ ...base, projectId: 'p2' })).not.toBe(seed);
      expect(windowRelationId({ ...base, srcId: 's2' })).not.toBe(seed);
      expect(windowRelationId({ ...base, dstId: 'd2' })).not.toBe(seed);
      expect(windowRelationId({ ...base, relType: 'works_at' })).not.toBe(seed);
    });

    it('tolerates null / undefined inputs without throwing', () => {
      expect(() =>
        windowRelationId({
          projectId: null,
          srcId: undefined,
          relType: null,
          dstId: undefined,
          eventStartAt: undefined,
        }),
      ).not.toThrow();
    });

    it('treats eventStartAt=undefined the same as eventStartAt=0 (both go through `... || 0`)', () => {
      const a = windowRelationId({ projectId: 'p', srcId: 's', relType: 'r', dstId: 'd', eventStartAt: undefined });
      const b = windowRelationId({ projectId: 'p', srcId: 's', relType: 'r', dstId: 'd', eventStartAt: 0 });
      expect(a).toBe(b);
    });
  });

  describe('ensureTemporalColumns()', () => {
    let db;
    beforeEach(() => {
      db = new Database(':memory:');
    });

    it('adds the three temporal columns to a v2 table that lacks them (idempotent)', () => {
      createV2RelationTable(db);
      ensureTemporalColumns(db);

      const cols = new Set(db.prepare('PRAGMA table_info(noe_kg_relation)').all().map((r) => r.name));
      expect(cols.has('event_start_at')).toBe(true);
      expect(cols.has('event_end_at')).toBe(true);
      expect(cols.has('ingested_at')).toBe(true);

      // 第二次跑不应崩（idempotent：列已存在 → ALTER 不再执行）。
      expect(() => ensureTemporalColumns(db)).not.toThrow();
      const cols2 = new Set(db.prepare('PRAGMA table_info(noe_kg_relation)').all().map((r) => r.name));
      expect(cols2.size).toBe(cols.size); // 不增不减
    });

    it('backfills event_start_at and ingested_at from created_at for legacy rows', () => {
      createV2RelationTable(db);
      db.prepare(
        `INSERT INTO noe_kg_relation
         (id, project_id, src, dst, rel_type, description, refs, strength, created_at, updated_at)
         VALUES (?, 'noe', 's', 'd', 'has_type', '', '[]', 5, 1700000000, 1700000000)`,
      ).run('row1');

      ensureTemporalColumns(db);
      const row = db
        .prepare('SELECT event_start_at, event_end_at, ingested_at FROM noe_kg_relation WHERE id = ?')
        .get('row1');

      // 两轴回填一致是刻意的：老数据没有「声明生效时间 ≠ 记录时间」的信息。
      expect(row.event_start_at).toBe(1700000000);
      expect(row.ingested_at).toBe(1700000000);
      // 老数据视为「当前有效」：event_end_at 保持 NULL = 窗口开着。
      expect(row.event_end_at).toBeNull();
    });

    it('COALESCE backfill does NOT overwrite already-set temporal values', () => {
      // 边界：若双时态列已存在但值为非 NULL，回填 UPDATE 的 COALESCE 必须保留原值。
      createV2RelationTable(db);
      db.exec(`ALTER TABLE noe_kg_relation ADD COLUMN event_start_at INTEGER`);
      db.exec(`ALTER TABLE noe_kg_relation ADD COLUMN event_end_at INTEGER`);
      db.exec(`ALTER TABLE noe_kg_relation ADD COLUMN ingested_at INTEGER`);
      db.prepare(
        `INSERT INTO noe_kg_relation
         (id, project_id, src, dst, rel_type, description, refs, strength, created_at, updated_at, event_start_at, event_end_at, ingested_at)
         VALUES ('row1', 'noe', 's', 'd', 'has_type', '', '[]', 5, 1700000000, 1700000000, 1500000000, NULL, 1600000000)`,
      ).run();

      ensureTemporalColumns(db);
      const row = db
        .prepare('SELECT event_start_at, event_end_at, ingested_at FROM noe_kg_relation WHERE id = ?')
        .get('row1');

      expect(row.event_start_at).toBe(1500000000);
      expect(row.ingested_at).toBe(1600000000);
    });

    it('rebuilds a v1 table that carries UNIQUE(project_id, src, dst, rel_type)', () => {
      createV1RelationTable(db);
      db.prepare(
        `INSERT INTO noe_kg_relation
         (id, project_id, src, dst, rel_type, description, refs, strength, created_at, updated_at)
         VALUES ('r1', 'noe', 'file.txt', 'type/doc', 'has_type', '', '[]', 5, 1700000000, 1700000000)`,
      ).run();

      ensureTemporalColumns(db);

      // UNIQUE 已消失（v2 形态：同三元组可并存多窗口）。
      const ddl = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='noe_kg_relation'")
        .get();
      expect(/UNIQUE\s*\(/i.test(String(ddl.sql || ''))).toBe(false);

      // 老数据完整保留 + 三列已就位且按 v1 回填。
      const row = db.prepare('SELECT * FROM noe_kg_relation WHERE id = ?').get('r1');
      expect(row).toBeTruthy();
      expect(row.event_start_at).toBe(1700000000);
      expect(row.ingested_at).toBe(1700000000);
      expect(row.event_end_at).toBeNull();
    });

    it('after a v1 rebuild, subsequent ensureTemporalColumns() does NOT rebuild again', () => {
      createV1RelationTable(db);
      ensureTemporalColumns(db);
      // 再跑一次：DDL 已无 UNIQUE，应走「幂等补列」路径 —— 不重建、不丢数据。
      expect(() => ensureTemporalColumns(db)).not.toThrow();

      // 行数仍为 0（原 v1 表为空），且不会因二次重建而崩。
      const n = db.prepare('SELECT COUNT(*) AS c FROM noe_kg_relation').get().c;
      expect(n).toBe(0);
    });

    it('creates the asOf + window indexes on the relation table', () => {
      createV2RelationTable(db);
      ensureTemporalColumns(db);
      const idxs = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='noe_kg_relation'")
        .all()
        .map((r) => r.name);
      expect(idxs).toContain('idx_noe_kg_relation_event_window');
      expect(idxs).toContain('idx_noe_kg_relation_event_asof');
    });

    it('after v1 rebuild, src and dst lookup indexes are recreated', () => {
      createV1RelationTable(db);
      ensureTemporalColumns(db);
      const idxs = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='noe_kg_relation'")
        .all()
        .map((r) => r.name);
      expect(idxs).toContain('idx_noe_kg_relation_src');
      expect(idxs).toContain('idx_noe_kg_relation_dst');
    });
  });
});
