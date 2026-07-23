// @ts-check
import crypto from 'node:crypto';
import path from 'node:path';
import { getDb } from '../storage/SqliteStore.js';
import {
  ensureTemporalColumns,
  closeStaleWindows,
  isSingleValuedRel,
  windowRelationId,
} from './NoeKnowledgeGraphTemporal.js';

// v2：边/事实加双时态（event-time + ingestion-time，关旧窗开新窗 + asOf）。
export const NOE_KNOWLEDGE_GRAPH_SCHEMA_VERSION = 2;

const ENTITY_TYPES = new Set(['project', 'file', 'type', 'term', 'other']);
const STOP_TERMS = new Set([
  'const',
  'function',
  'return',
  'import',
  'export',
  'from',
  'true',
  'false',
  'null',
  'undefined',
]);

function clean(value, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

function now(clock) {
  return Number(clock?.()) || Date.now();
}

function stableId(...parts) {
  return crypto.createHash('sha256').update(parts.map((part) => clean(part, 400)).join('|')).digest('hex').slice(0, 20);
}

function normalizeType(type) {
  const t = clean(type, 40).toLowerCase();
  return ENTITY_TYPES.has(t) ? t : 'other';
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mergeJsonArray(a, b) {
  return JSON.stringify([...new Set([...parseJsonArray(a), ...parseJsonArray(b)])].slice(0, 80));
}

function extractTerms(text = '', limit = 12) {
  const raw = clean(text, 6000);
  const candidates = [
    ...(raw.match(/\b[A-Z][A-Za-z0-9_]{2,}\b/g) || []),
    ...(raw.match(/\b[a-z][a-z0-9_]{3,}\b/g) || []),
    ...(raw.match(/[\u4e00-\u9fff]{2,8}/g) || []),
  ];
  const counts = new Map();
  for (const candidate of candidates) {
    const term = clean(candidate, 80);
    const lower = term.toLowerCase();
    if (!term || STOP_TERMS.has(lower)) continue;
    counts.set(term, (counts.get(term) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term, count]) => ({ term, count }));
}

export class NoeKnowledgeGraph {
  constructor({ db = null, clock = Date.now } = {}) {
    this.db = db || getDb();
    this.clock = clock;
    this.#ensureSchema();
  }

  #ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS noe_kg_entity (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL DEFAULT 'noe',
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        refs TEXT NOT NULL DEFAULT '[]',
        mention_count INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(project_id, name, type)
      );
      CREATE INDEX IF NOT EXISTS idx_noe_kg_entity_project_type
        ON noe_kg_entity(project_id, type, updated_at);
      CREATE INDEX IF NOT EXISTS idx_noe_kg_entity_project_name
        ON noe_kg_entity(project_id, name);

      CREATE TABLE IF NOT EXISTS noe_kg_relation (
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
      CREATE INDEX IF NOT EXISTS idx_noe_kg_relation_src
        ON noe_kg_relation(project_id, src);
      CREATE INDEX IF NOT EXISTS idx_noe_kg_relation_dst
        ON noe_kg_relation(project_id, dst);
    `);
    // 双时态列 + 索引 + 老数据回填（幂等；新库本步直接补齐三列）。
    // 注意：v1 的 UNIQUE(project_id,src,dst,rel_type) 与双时态「同三元组多窗口」不兼容，
    // 已从建表语句移除——窗口唯一性改由含 event_start_at 的窗口级 id（PRIMARY KEY）保证。
    ensureTemporalColumns(this.db);
    const key = 'noe_knowledge_graph_schema';
    const existing = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(key);
    const ts = Math.floor(now(this.clock) / 1000);
    if (!existing) {
      this.db.prepare('INSERT INTO kv(k, v, updated_at) VALUES(?, ?, ?)').run(key, String(NOE_KNOWLEDGE_GRAPH_SCHEMA_VERSION), ts);
    } else if (Number(existing.v) < NOE_KNOWLEDGE_GRAPH_SCHEMA_VERSION) {
      // 前向迁移：实际 schema 变更已由上面 ensureTemporalColumns 幂等完成（含老数据回填），此处只推进版本号。
      this.db.prepare('UPDATE kv SET v = ?, updated_at = ? WHERE k = ?').run(String(NOE_KNOWLEDGE_GRAPH_SCHEMA_VERSION), ts, key);
    } else if (Number(existing.v) > NOE_KNOWLEDGE_GRAPH_SCHEMA_VERSION) {
      // 仅在库版本「更新」（代码被回退）时报错，避免新 schema 被老代码误读。
      throw new Error(`NOE_KG_SCHEMA_MISMATCH: db=${existing.v} > code=${NOE_KNOWLEDGE_GRAPH_SCHEMA_VERSION}`);
    }
  }

  entityId({ projectId = 'noe', name, type = 'other' } = {}) {
    return stableId(projectId, clean(name, 300).toLowerCase(), normalizeType(type));
  }

  upsertEntity({ projectId = 'noe', name, type = 'other', description = '', ref = '' } = {}) {
    const entity = {
      id: this.entityId({ projectId, name, type }),
      projectId: clean(projectId, 120) || 'noe',
      name: clean(name, 300),
      type: normalizeType(type),
      description: clean(description, 1000),
      ref: clean(ref, 1000),
    };
    if (!entity.name) throw new Error('entity name required');
    const ts = now(this.clock);
    const refs = entity.ref ? JSON.stringify([entity.ref]) : '[]';
    const existing = this.db.prepare('SELECT refs, mention_count FROM noe_kg_entity WHERE id = ?').get(entity.id);
    if (existing) {
      this.db.prepare(`
        UPDATE noe_kg_entity SET
          description = CASE WHEN ? != '' THEN ? ELSE description END,
          refs = ?,
          mention_count = ?,
          updated_at = ?
        WHERE id = ?
      `).run(entity.description, entity.description, mergeJsonArray(existing.refs, refs), Math.max(parseJsonArray(mergeJsonArray(existing.refs, refs)).length, existing.mention_count + 1), ts, entity.id);
    } else {
      this.db.prepare(`
        INSERT INTO noe_kg_entity(id, project_id, name, type, description, refs, mention_count, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(entity.id, entity.projectId, entity.name, entity.type, entity.description, refs, ts, ts);
    }
    return entity.id;
  }

  /**
   * 双时态写入边/事实。语义：
   *   - 同三元组 (src,dst,relType) 已有「开窗」边（event_end_at IS NULL）→ 视为重申同一仍为真的事实，
   *     并入该开窗（更新 description/refs/strength，必要时回拨更早的 event_start_at），**不**新开窗。
   *   - 否则单值 rel_type（lives_in/has_type/identity… 见 SINGLE_VALUED_REL_TYPES）→ 先把同 src+rel_type
   *     下别的开窗（dst 不同）关掉（event_end_at=关窗时刻），再插新开窗（关旧窗开新窗，旧边不物理删）。
   *   - 多值 rel_type（contains/mentions/related_to…）→ 直接插新开窗，并存不关旧窗。
   *
   * 原子性（BLOCKER 修复）：上述「查 openSame / 关旧窗 / 开新窗」整体跑在一个事务里，
   *   杜绝「已关旧窗但新窗 INSERT 抛错（id 撞约束）→ 该 rel_type 此刻无任何开窗、真事实丢失」的半截破坏。
   * id 撞退避：同 eventStartAt 重复开窗时窗口级 id 会撞历史窗，用**循环**单调 +1 退避到空位
   *   （旧实现只 +1 一次，同毫秒往返 ≥3 次仍撞 PRIMARY KEY → 配合非事务造成丢数据）。
   *
   * 乱序/补录策略（MAJOR3，择稳妥=显式拒绝）：
   *   - 正序与同序补录（新 eventStart >= 既有开窗 start）正常关旧窗开新窗；关窗时刻取 min(物理 now, 新 eventStart)，
   *     避免新事实在旧窗中间生效却把旧窗关到更晚导致 asOf 区间重叠双命中。
   *   - **乱序补录**（单值、dst 不同、且新 eventStart < 既有冲突开窗的 start）= 需在历史中间插窗的区间手术，
   *     本实现不做，返回 { ok:false, reason:'needs_review', conflict }，由上层人工/补录工具处理。不静默写脏。
   *
   * 双时态轴（别设反）：
   *   - eventStartAt（event-time，默认 now）：事实「在世界里何时开始为真」，控 asOf 命中。可显式传入做「补录历史」。
   *   - ingestedAt（ingestion-time，默认 now）：何时被记录，纯留痕，不控有效性。可显式传入留真实记录时刻。
   * @returns {string|null|{ok:false,reason:string,conflict?:object}} 命中/新建窗口的 id；乱序补录冲突返回 needs_review 对象；非法入参 null
   */
  upsertRelation({ projectId = 'noe', srcId, dstId, relType = 'related_to', description = '', ref = '', strength = 5, eventStartAt = null, ingestedAt = null } = {}) {
    if (!srcId || !dstId || srcId === dstId) return null;
    const rel = {
      projectId: clean(projectId, 120) || 'noe',
      srcId,
      dstId,
      // relType 写入统一小写+去空白（MAJOR2）：避免 lives_in / Lives_In 被当两种 rel_type 各自开窗不关旧窗。
      relType: clean(relType, 80).toLowerCase().trim() || 'related_to',
      description: clean(description, 1000),
      ref: clean(ref, 1000),
      strength: Math.max(1, Math.min(10, Math.trunc(Number(strength) || 5))),
    };
    const ts = now(this.clock);
    // 注意 Number(null)===0 且 isFinite(0)===true 的陷阱：未显式传入时必须回落 ts，不能误用 0。
    const eventStart = (eventStartAt !== null && eventStartAt !== undefined && Number.isFinite(Number(eventStartAt))) ? Number(eventStartAt) : ts;
    const ingested = (ingestedAt !== null && ingestedAt !== undefined && Number.isFinite(Number(ingestedAt))) ? Number(ingestedAt) : ts;
    const refs = rel.ref ? JSON.stringify([rel.ref]) : '[]';

    // 关旧窗 + 开新窗必须原子：半截（关了旧窗但新窗 INSERT 失败）会让该 rel_type 当下无任何开窗 → 丢真事实。
    return this.db.transaction(() => {
      // 同三元组的开窗（当前有效）边——重申同一事实时并入它，避免同一仍为真的事实重复开窗。
      const openSame = this.db.prepare(`
        SELECT id, refs, event_start_at FROM noe_kg_relation
        WHERE project_id = ? AND src = ? AND dst = ? AND rel_type = ? AND event_end_at IS NULL
        ORDER BY event_start_at DESC LIMIT 1
      `).get(rel.projectId, rel.srcId, rel.dstId, rel.relType);
      if (openSame) {
        // 不静默丢 temporal 字段：若显式补录到更早的 event_start_at（事实其实更早就为真），回拨开窗 start。
        const earlierStart = Math.min(Number(openSame.event_start_at), eventStart);
        this.db.prepare(`
          UPDATE noe_kg_relation SET
            description = CASE WHEN ? != '' THEN ? ELSE description END,
            refs = ?,
            strength = MAX(strength, ?),
            event_start_at = ?,
            updated_at = ?
          WHERE id = ?
        `).run(rel.description, rel.description, mergeJsonArray(openSame.refs, refs), rel.strength, earlierStart, ts, openSame.id);
        return openSame.id;
      }

      // 单值关系：dst 变 = 语义冲突。乱序补录（新 start 落在既有冲突开窗 start 之前）= 区间手术，本实现拒绝。
      let plannedStart = eventStart;
      if (isSingleValuedRel(rel.relType)) {
        const conflictOpen = this.db.prepare(`
          SELECT id, dst, event_start_at FROM noe_kg_relation
          WHERE project_id = ? AND src = ? AND rel_type = ? AND dst != ? AND event_end_at IS NULL
          ORDER BY event_start_at DESC LIMIT 1
        `).get(rel.projectId, rel.srcId, rel.relType, rel.dstId);
        if (conflictOpen && eventStart < Number(conflictOpen.event_start_at)) {
          return {
            ok: false,
            reason: 'needs_review',
            conflict: {
              relType: rel.relType,
              existingDst: conflictOpen.dst,
              existingStart: Number(conflictOpen.event_start_at),
              attemptedDst: rel.dstId,
              attemptedStart: eventStart,
            },
          };
        }
        if (conflictOpen) {
          // 单值时间线 = 非重叠区间序列：新窗须严格晚于旧窗 start。同毫秒往返（clock 冻结、eventStart==旧 start）时
          // 把新窗推到 旧 start+1，使旧窗关成正长 [s,s+1) 而非零/负长死窗（MINOR1），且永远只剩 1 个开窗（BLOCKER 不变量）。
          plannedStart = Math.max(eventStart, Number(conflictOpen.event_start_at) + 1);
          // 关窗时刻 = 新窗 start（plannedStart）：旧窗 [oldStart, plannedStart) 正长且与新窗 [plannedStart, …) 无重叠双命中。
          closeStaleWindows(this.db, {
            projectId: rel.projectId,
            srcId: rel.srcId,
            relType: rel.relType,
            newDstId: rel.dstId,
            now: plannedStart,
          });
        }
      }

      // 开新窗：id 含 event_start_at（同三元组多窗口需窗口级唯一）。同 start 撞历史窗时循环单调退避到空位。
      let startUsed = plannedStart;
      let id = windowRelationId({ projectId: rel.projectId, srcId: rel.srcId, relType: rel.relType, dstId: rel.dstId, eventStartAt: startUsed });
      while (this.db.prepare('SELECT 1 FROM noe_kg_relation WHERE id = ?').get(id)) {
        startUsed += 1;
        id = windowRelationId({ projectId: rel.projectId, srcId: rel.srcId, relType: rel.relType, dstId: rel.dstId, eventStartAt: startUsed });
      }
      this.db.prepare(`
        INSERT INTO noe_kg_relation(id, project_id, src, dst, rel_type, description, refs, strength, created_at, updated_at, event_start_at, event_end_at, ingested_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
      `).run(id, rel.projectId, rel.srcId, rel.dstId, rel.relType, rel.description, refs, rel.strength, ts, ts, startUsed, ingested);
      return id;
    })();
  }

  ingestFileIndex({ fileIndex, projectId = 'noe', limit = 500 } = {}) {
    const items = Array.isArray(fileIndex?.items) ? fileIndex.items.slice(0, limit) : [];
    const projectEntity = this.upsertEntity({ projectId, name: projectId, type: 'project', description: 'Noe local project' });
    let files = 0;
    let terms = 0;
    let relations = 0;
    const tx = this.db.transaction(() => {
      for (const item of items) {
        if (!item?.path || item.sensitive) continue;
        const fileName = item.relativePath || path.basename(item.path);
        const fileId = this.upsertEntity({
          projectId,
          name: fileName,
          type: 'file',
          description: `${item.typeClass || 'other'} tier=${Number(item.valueTier) || 0}`,
          ref: item.path,
        });
        files += 1;
        if (this.upsertRelation({ projectId, srcId: projectEntity, dstId: fileId, relType: 'contains', ref: item.path, strength: 6 })) relations += 1;
        const typeId = this.upsertEntity({ projectId, name: item.typeClass || 'other', type: 'type' });
        if (this.upsertRelation({ projectId, srcId: fileId, dstId: typeId, relType: 'has_type', ref: item.path, strength: 4 })) relations += 1;
        for (const { term, count } of extractTerms(`${fileName}\n${item.text || ''}`, 8)) {
          const termId = this.upsertEntity({ projectId, name: term, type: 'term', ref: item.path });
          terms += 1;
          if (this.upsertRelation({ projectId, srcId: fileId, dstId: termId, relType: 'mentions', ref: item.path, strength: Math.min(10, count + 2) })) relations += 1;
        }
      }
    });
    tx();
    return { ok: true, projectId, files, terms, relations, readOnlySource: true };
  }

  stats({ projectId = 'noe' } = {}) {
    const entityCount = this.db.prepare('SELECT COUNT(*) c FROM noe_kg_entity WHERE project_id = ?').get(projectId).c;
    const relationCount = this.db.prepare('SELECT COUNT(*) c FROM noe_kg_relation WHERE project_id = ?').get(projectId).c;
    const byType = this.db.prepare(`
      SELECT type, COUNT(*) count FROM noe_kg_entity WHERE project_id = ? GROUP BY type ORDER BY count DESC
    `).all(projectId);
    return { schemaVersion: NOE_KNOWLEDGE_GRAPH_SCHEMA_VERSION, projectId, entities: entityCount, relations: relationCount, byType };
  }

  search({ q = '', query = '', projectId = 'noe', limit = 20 } = {}) {
    const term = `%${clean(q || query, 200).replace(/[\\%_]/g, '\\$&')}%`;
    const rows = this.db.prepare(`
      SELECT id, name, type, description, refs, mention_count
      FROM noe_kg_entity
      WHERE project_id = ? AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
      ORDER BY mention_count DESC, updated_at DESC
      LIMIT ?
    `).all(projectId, term, term, Math.max(1, Math.min(100, Number(limit) || 20)));
    return { query: clean(q || query, 200), count: rows.length, entities: rows.map((row) => ({ ...row, refs: parseJsonArray(row.refs).slice(0, 10) })) };
  }

  /**
   * 邻居一跳。默认只返回「当前有效」的边（event_end_at IS NULL）——双时态默认视图。
   * includeHistory=true 时返回该实体全历史边（含已关窗的旧事实），用于审计/回放。
   */
  oneHop({ id, name, projectId = 'noe', limit = 30, includeHistory = false } = {}) {
    const entity = id
      ? this.db.prepare('SELECT * FROM noe_kg_entity WHERE project_id = ? AND id = ?').get(projectId, id)
      : this.db.prepare('SELECT * FROM noe_kg_entity WHERE project_id = ? AND lower(name) = lower(?)').get(projectId, clean(name, 300));
    if (!entity) return { found: false, entity: null, edges: [] };
    // event-time 过滤：默认「当前有效」= event_start_at <= now AND (event_end_at IS NULL OR event_end_at > now)。
    // 注意必须同时查起点（MAJOR1）：只查 event_end_at IS NULL 会把「未来才生效」的边（event_start>now，end 仍 NULL）
    //   错当作当前有效返回。includeHistory 取全部历史边。ingestion-time 不参与此判定。
    const at = now(this.clock);
    const liveFilter = includeHistory ? '' : 'AND r.event_start_at <= ? AND (r.event_end_at IS NULL OR r.event_end_at > ?)';
    const cap = Math.max(1, Math.min(100, Number(limit) || 30));
    const args = includeHistory
      ? [projectId, entity.id, projectId, entity.id, cap]
      : [projectId, entity.id, at, at, projectId, entity.id, at, at, cap];
    const rows = this.db.prepare(`
      SELECT r.rel_type, r.strength, r.refs, r.event_start_at, r.event_end_at, r.ingested_at, e.id, e.name, e.type, e.description
      FROM noe_kg_relation r
      JOIN noe_kg_entity e ON e.id = r.dst
      WHERE r.project_id = ? AND r.src = ? ${liveFilter}
      UNION ALL
      SELECT r.rel_type, r.strength, r.refs, r.event_start_at, r.event_end_at, r.ingested_at, e.id, e.name, e.type, e.description
      FROM noe_kg_relation r
      JOIN noe_kg_entity e ON e.id = r.src
      WHERE r.project_id = ? AND r.dst = ? ${liveFilter}
      ORDER BY strength DESC
      LIMIT ?
    `).all(...args);
    return {
      found: true,
      entity: { id: entity.id, name: entity.name, type: entity.type, description: entity.description, refs: parseJsonArray(entity.refs).slice(0, 10) },
      edges: rows.map((row) => ({ ...row, refs: parseJsonArray(row.refs).slice(0, 10) })),
    };
  }

  /**
   * 时间点查询（bitemporal asOf）：返回在 event-time t 时刻有效的边，即
   *   event_start_at <= t AND (event_end_at IS NULL OR event_end_at > t)。
   * 半开区间 [start, end)：关窗时刻 t=end 的边已失效（新窗在 end 开始），避免边界双命中。
   * 只读 event-time 两列；**绝不**读 ingested_at（ingestion-time 不控有效性）——这是两轴不设反的关键。
   * @param {{t:number, projectId?:string, srcId?:string, relType?:string, limit?:number}} input
   */
  asOf({ t, projectId = 'noe', srcId = null, relType = null, limit = 200 } = {}) {
    const at = Number(t);
    if (!Number.isFinite(at)) return { t: null, count: 0, edges: [] };
    const where = ['project_id = ?', 'event_start_at <= ?', '(event_end_at IS NULL OR event_end_at > ?)'];
    const args = [projectId, at, at];
    if (srcId) { where.push('src = ?'); args.push(srcId); }
    // rel_type 写入已统一小写（见 upsertRelation），查询侧也小写匹配，保持大小写一致（MAJOR2）。
    if (relType) { where.push('rel_type = ?'); args.push(clean(relType, 80).toLowerCase().trim()); }
    args.push(Math.max(1, Math.min(1000, Number(limit) || 200)));
    const rows = this.db.prepare(`
      SELECT id, src, dst, rel_type, description, refs, strength, event_start_at, event_end_at, ingested_at
      FROM noe_kg_relation
      WHERE ${where.join(' AND ')}
      ORDER BY event_start_at DESC, strength DESC
      LIMIT ?
    `).all(...args);
    return { t: at, count: rows.length, edges: rows.map((row) => ({ ...row, refs: parseJsonArray(row.refs).slice(0, 10) })) };
  }
}
