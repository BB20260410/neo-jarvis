// @ts-check
// NoeKnowledgeGraphTemporal — KG 边的「双时态」(bitemporal) 辅助层（对标 Graphiti arXiv 2501.13956）。
//
// 两条时间轴（经典易错点：别设反）：
//   - event-time（有效时间 / valid-time）: event_start_at / event_end_at —— 事实「在世界里何时为真」。
//       这条轴控制 asOf(t) 的命中：t 落在 [event_start_at, event_end_at) 内才算当时有效。
//   - ingestion-time（写入时间 / transaction-time）: ingested_at —— 事实「何时被 Noe 记录下来」。
//       纯留痕/审计，**不**参与有效性判定；asOf 绝不读它。
//
// 「关旧窗开新窗」：单值关系（如 owner lives_in 成都→上海）变更时，旧边置 event_end_at=now（关窗），
// 新插一条 event_start_at=now / event_end_at=NULL（开新窗），旧边不物理删（全历史可查、可 asOf 回放）。
//
// 本模块只放纯策略/SQL helper，类主体在 NoeKnowledgeGraph.js（避免主文件超 500 行）。
// 依赖注入：所有函数收 db / 现成值，不全局乱抓。

import crypto from 'node:crypto';

// 双时态新增三列的 DDL（幂等 ALTER 用）。
export const TEMPORAL_COLUMNS = [
  // event-time：事实何时为真。start 默认沿用 created_at（迁移时回填），end=NULL 表示「当前有效（窗口开着）」。
  ['event_start_at', 'event_start_at INTEGER'],
  ['event_end_at', 'event_end_at INTEGER'],
  // ingestion-time：何时被记录。迁移时回填 created_at。仅留痕，不控有效性。
  ['ingested_at', 'ingested_at INTEGER'],
];

/**
 * 单值（single-valued）关系白名单：同一 src 在同一时刻对该 rel_type 只应有一个有效 dst。
 * dst 变化 = 语义冲突（旧事实失效），触发「关旧窗开新窗」。
 *
 * 对比多值（multi-valued）关系（contains / mentions / related_to …）：一个文件可 contains 多个东西、
 * mentions 多个术语 —— dst 不同 = 并存的新事实，不是冲突，**不**关旧窗。
 *
 * 选型依据（参考 NoeMemoryConflictPolicy.decideMemoryConflict 的 supersede 思路，但按「三元组」适配——
 * 文本 slot 判定不适用于 src-dst-relType 边，这里改用 rel_type 语义白名单）：
 *   - lives_in / located_in / based_in / current_city : 居住地，单值（人一时刻常住一地）。
 *   - has_type : 文件/实体的类型归类，单值（一个文件一个 typeClass）。
 *   - is_a / instance_of : 身份/类属，单值。
 *   - identity / named : 身份/命名，单值。
 *   - status / state / current_status : 当前状态，单值（新状态取代旧状态）。
 *
 * 刻意排除的「看似单值实则 src 维度可多值」关系（收窄白名单，避免错关同 src 多对象）：
 *   - owner_of / has_role / works_at / employed_at / belongs_to : 一个 owner 可拥有多个对象、
 *     一人可兼多职/多雇主、一物可属多集合 → dst 不同 = 并存事实，不该 supersede。
 *
 * 接线现状（别造「已在用」错觉）：截至当前，本白名单里**只有 has_type 真有写入方**
 * （NoeKnowledgeGraph.ingestFileIndex 给文件打 typeClass）。lives_in / current_city / status 等人物事实
 * 的写入路径尚未接线（关旧窗开新窗逻辑已就绪，等上层接入），勿在文档/汇报里当成已落地能力。
 */
export const SINGLE_VALUED_REL_TYPES = new Set([
  'lives_in',
  'located_in',
  'based_in',
  'current_city',
  'has_type',
  'is_a',
  'instance_of',
  'identity',
  'named',
  'status',
  'state',
  'current_status',
]);

/** 该 rel_type 是否单值（dst 变要关旧窗）。大小写不敏感、容错空值。 */
export function isSingleValuedRel(relType) {
  return SINGLE_VALUED_REL_TYPES.has(String(relType || '').trim().toLowerCase());
}

/**
 * 窗口级 id：双时态下同一 (project,src,dst,relType) 三元组可随时间出现多个窗口
 * （如 lives_in 成都→上海→成都，成都会出现两次），故 id 必须含 event_start_at 才唯一，
 * 否则二次开同窗会与历史窗 id 撞、覆盖历史。
 */
export function windowRelationId({ projectId, srcId, relType, dstId, eventStartAt }) {
  return crypto
    .createHash('sha256')
    .update([projectId, srcId, String(relType || ''), dstId, String(eventStartAt || 0)].map((p) => String(p ?? '').slice(0, 400)).join('|'))
    .digest('hex')
    .slice(0, 20);
}

/**
 * 确保双时态列存在并回填老数据（幂等，向后兼容）。
 *   - 老边：event_start_at=created_at（事实从被创建那刻起为真）、event_end_at=NULL（当前有效）、ingested_at=created_at。
 *   - 两轴回填一致是刻意的：老数据没有「声明生效时间 ≠ 记录时间」的信息，最保守即二者都取 created_at。
 * @param {import('better-sqlite3').Database} db
 */
export function ensureTemporalColumns(db) {
  const tableDdl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='noe_kg_relation'").get();
  // v1 表带 UNIQUE(project_id,src,dst,rel_type) 与双时态「同三元组多窗口」(lives_in 成都→上海→成都)根本不兼容；
  //   SQLite ALTER 无法 DROP 约束 → live v1 库必须**整表重建**移除 UNIQUE。
  //   主线实证 probe 坐实：不重建则回旧值重开窗(成都again)撞 UNIQUE constraint failed（建表语句移 UNIQUE 只救新库，救不了已落地的 live v1 表）。
  if (tableDdl && /UNIQUE\s*\(/i.test(String(tableDdl.sql || ''))) {
    rebuildRelationTableDropUnique(db);
  } else {
    // 新库 / 已 v2（无 UNIQUE）：幂等补列。
    const cols = new Set(db.prepare('PRAGMA table_info(noe_kg_relation)').all().map((row) => row.name));
    for (const [name, ddl] of TEMPORAL_COLUMNS) {
      if (!cols.has(name)) db.exec(`ALTER TABLE noe_kg_relation ADD COLUMN ${ddl}`);
    }
  }
  // 回填：仅补 NULL 行（幂等——已回填或新库无影响）。event_end_at 不回填：老数据视为「当前有效」，NULL 即开窗。
  db.exec(`
    UPDATE noe_kg_relation
       SET event_start_at = COALESCE(event_start_at, created_at),
           ingested_at    = COALESCE(ingested_at, created_at)
     WHERE event_start_at IS NULL OR ingested_at IS NULL
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_noe_kg_relation_event_window
      ON noe_kg_relation(project_id, src, rel_type, event_end_at);
    CREATE INDEX IF NOT EXISTS idx_noe_kg_relation_event_asof
      ON noe_kg_relation(project_id, event_start_at, event_end_at);
  `);
  return true;
}

/**
 * v1 表带 UNIQUE(project_id,src,dst,rel_type) → 整表重建移除（SQLite 不支持 DROP CONSTRAINT）。
 * 新表 = v2 列定义（无 UNIQUE）+ 三个双时态列；保留全部数据 + PK + 普通索引；双时态列按老数据回填
 * （event_start=ingested=created_at，event_end=NULL=当前有效）。整个重建在**事务内**做（中途崩不留半截表）。
 * 幂等前提：仅当 DDL 含 UNIQUE 才被 ensureTemporalColumns 调用（重建后 DDL 无 UNIQUE，下次不再进此分支）。
 * @param {import('better-sqlite3').Database} db
 */
function rebuildRelationTableDropUnique(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(noe_kg_relation)').all().map((row) => row.name));
  // 兼容「已被 ALTER 加过部分双时态列的 v1 表」：有列取现值，无列回填 created_at / NULL。
  const es = cols.has('event_start_at') ? 'COALESCE(event_start_at, created_at)' : 'created_at';
  const ee = cols.has('event_end_at') ? 'event_end_at' : 'NULL';
  const ing = cols.has('ingested_at') ? 'COALESCE(ingested_at, created_at)' : 'created_at';
  db.transaction(() => {
    db.exec(`CREATE TABLE noe_kg_relation__rebuild (
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
      event_start_at INTEGER,
      event_end_at INTEGER,
      ingested_at INTEGER
    )`);
    db.exec(`INSERT INTO noe_kg_relation__rebuild
      (id, project_id, src, dst, rel_type, description, refs, strength, created_at, updated_at, event_start_at, event_end_at, ingested_at)
      SELECT id, project_id, src, dst, rel_type, description, refs, strength, created_at, updated_at, ${es}, ${ee}, ${ing}
        FROM noe_kg_relation`);
    db.exec('DROP TABLE noe_kg_relation');
    db.exec('ALTER TABLE noe_kg_relation__rebuild RENAME TO noe_kg_relation');
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_noe_kg_relation_src ON noe_kg_relation(project_id, src);
      CREATE INDEX IF NOT EXISTS idx_noe_kg_relation_dst ON noe_kg_relation(project_id, dst);
    `);
  })();
}

/**
 * 关旧窗：把某 src+rel_type 下当前有效（event_end_at IS NULL）、且 dst 不是新 dst 的旧边置 event_end_at=now。
 * 只对单值 rel_type 调用。返回关掉的行数。
 *
 * 关窗时刻 `now` 由调用方决定（正序写入=物理 now；乱序/补录历史=min(物理 now, 新事实 eventStartAt)，
 * 避免新事实在旧窗中间生效却把旧窗关到更晚导致区间重叠双命中）。
 *
 * 防零/负长死窗（MINOR）：仅关 `event_start_at < now` 的旧窗——若 now <= 旧窗 event_start_at（如同毫秒、
 * 或补录早于旧窗开始的历史），关了会得到 [start, now) 且 now<=start 的零/负长段（asOf 永不命中的死窗）。
 * 这类旧窗保持开着（由调用方判定语义；正常时间线不会出现 now < 既有开窗 start）。
 * @param {import('better-sqlite3').Database} db
 * @returns {number} 关掉的行数
 */
export function closeStaleWindows(db, { projectId, srcId, relType, newDstId, now }) {
  return db.prepare(`
    UPDATE noe_kg_relation
       SET event_end_at = ?, updated_at = ?
     WHERE project_id = ? AND src = ? AND rel_type = ? AND dst != ?
       AND event_end_at IS NULL
       AND event_start_at < ?
  `).run(now, now, projectId, srcId, relType, newDstId, now).changes;
}
