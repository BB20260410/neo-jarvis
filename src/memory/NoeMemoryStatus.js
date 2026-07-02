// @ts-check

import * as sqliteStore from '../storage/SqliteStore.js';
import { ensureNoeMemoryV2Schema } from '../storage/NoeMemoryV2Schema.js';
import { STRONG_MEMORY_SOURCE_LINK_TYPES } from './NoeMemoryGovernanceRepair.js';
import { resolveNoeMemorySemanticConfig } from './NoeMemorySemanticConfig.js';
import { getDimMismatchHealth } from '../embeddings/VectorIndex.js';

function tableExists(db, name) {
  try { return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)); } catch { return false; }
}

function one(db, sql, params = []) {
  try { return db.prepare(sql).get(...params) || null; } catch { return null; }
}

function all(db, sql, params = []) {
  try { return db.prepare(sql).all(...params) || []; } catch { return []; }
}

function countBy(rows, key = 'key') {
  return Object.fromEntries(rows.map((r) => [String(r[key] || 'unknown'), Number(r.c) || 0]));
}

function sourceLinkedSummary(db, now) {
  if (!tableExists(db, 'noe_memory')) return { factTotal: 0, linkedFacts: 0, anyLinkedFacts: 0, weakLinkedFacts: 0, reviewedOrphanFacts: 0, unreviewedOrphanFacts: 0, orphanFacts: 0, orphanFactIds: [] };
  const strongTypes = STRONG_MEMORY_SOURCE_LINK_TYPES.map(() => '?').join(',');
  const strongTypeArgs = [...STRONG_MEMORY_SOURCE_LINK_TYPES];
  const orphanWhere = `
    m.hidden=0 AND m.scope='fact' AND (m.expires_at IS NULL OR m.expires_at > ?)
      AND (m.source_episode_id IS NULL OR m.source_episode_id = '')
      AND (m.source_id IS NULL OR m.source_id = '')
      AND NOT EXISTS(SELECT 1 FROM noe_memory_link l WHERE l.memory_id=m.id AND l.link_type IN (${strongTypes}) LIMIT 1)
  `;
  const factTotal = Number(one(db, "SELECT COUNT(*) AS c FROM noe_memory WHERE hidden=0 AND scope='fact' AND (expires_at IS NULL OR expires_at > ?)", [now])?.c) || 0;
  const linkedFacts = Number(one(db, `
    SELECT COUNT(*) AS c FROM noe_memory m
    WHERE m.hidden=0 AND m.scope='fact' AND (m.expires_at IS NULL OR m.expires_at > ?)
      AND ((m.source_episode_id IS NOT NULL AND m.source_episode_id != '')
        OR (m.source_id IS NOT NULL AND m.source_id != '')
        OR EXISTS(SELECT 1 FROM noe_memory_link l WHERE l.memory_id=m.id AND l.link_type IN (${strongTypes}) LIMIT 1))
  `, [now, ...strongTypeArgs])?.c) || 0;
  const anyLinkedFacts = Number(one(db, `
    SELECT COUNT(*) AS c FROM noe_memory m
    WHERE m.hidden=0 AND m.scope='fact' AND (m.expires_at IS NULL OR m.expires_at > ?)
      AND EXISTS(SELECT 1 FROM noe_memory_link l WHERE l.memory_id=m.id LIMIT 1)
  `, [now])?.c) || 0;
  const reviewedOrphanFacts = tableExists(db, 'noe_memory_candidate')
    ? Number(one(db, `
      SELECT COUNT(*) AS c FROM noe_memory m
      WHERE ${orphanWhere}
        AND EXISTS(SELECT 1 FROM noe_memory_candidate c
          WHERE c.target_memory_id=m.id AND c.decision LIKE 'auto_%' LIMIT 1)
    `, [now, ...strongTypeArgs])?.c) || 0
    : 0;
  const orphanFactIds = all(db, `
    SELECT m.id FROM noe_memory m
    WHERE ${orphanWhere}
    ORDER BY m.updated_at DESC LIMIT 20
  `, [now, ...strongTypeArgs]).map((r) => r.id);
  const orphanFacts = Math.max(0, factTotal - linkedFacts);
  return {
    factTotal,
    linkedFacts,
    anyLinkedFacts,
    weakLinkedFacts: Math.max(0, anyLinkedFacts - linkedFacts),
    reviewedOrphanFacts,
    unreviewedOrphanFacts: Math.max(0, orphanFacts - reviewedOrphanFacts),
    orphanFacts,
    orphanFactIds,
  };
}

function latestSourceTimes(db) {
  return countBy(all(db, 'SELECT source_type AS key, MAX(created_at) AS c FROM noe_memory GROUP BY source_type'), 'key');
}

function candidateStats(db) {
  if (!tableExists(db, 'noe_memory_candidate')) return { total: 0, byDecision: {}, quarantineCount: 0, needsReview: 0 };
  const byDecision = countBy(all(db, 'SELECT decision AS key, COUNT(*) AS c FROM noe_memory_candidate GROUP BY decision'), 'key');
  return {
    total: Object.values(byDecision).reduce((sum, n) => sum + Number(n), 0),
    byDecision,
    quarantineCount: Number(byDecision.quarantined || 0),
    needsReview: Number(byDecision.needs_review || 0),
  };
}

function retrievalStats(db) {
  if (!tableExists(db, 'noe_memory_retrieval_log')) return { logs: 0, hitRate: null, recentLessons: [] };
  const rows = all(db, 'SELECT hit_ids, selected_ids FROM noe_memory_retrieval_log ORDER BY ts DESC LIMIT 200');
  if (!rows.length) return { logs: 0, hitRate: null, recentLessons: [] };
  let selected = 0;
  const recentSelectedIds = [];
  for (const row of rows) {
    try {
      const s = JSON.parse(row.selected_ids || '[]');
      if (Array.isArray(s) && s.length) { selected += 1; for (const id of s) if (recentSelectedIds.length < 80) recentSelectedIds.push(String(id)); }
    } catch { /* ignore */ }
  }
  // P2 杠杆2：列出最近召回(真注入对话)的 lesson 类记忆明细，让 owner 在透视页看到"这次回答用了哪条学过的 lesson"(可追溯)。
  //   selected_ids 已落库(NoeMemoryAuditLog)，这里纯只读 join noe_memory 取 title/source_type，不改召回逻辑。
  let recentLessons = [];
  try {
    const uniq = [...new Set(recentSelectedIds)].slice(0, 60);
    if (uniq.length) {
      const ph = uniq.map(() => '?').join(',');
      // codex 互评：加 hidden=0 + expires_at 过滤，与可见记忆口径一致——不把已隐藏(merge/deleted)或过期的 lesson 展示给 owner。
      recentLessons = all(db, `SELECT id, title, source_type AS sourceType, hit_count AS hitCount FROM noe_memory WHERE id IN (${ph}) AND source_type IN ('learning_lesson','surprise_lesson','skill_distill') AND hidden = 0 AND (expires_at IS NULL OR expires_at > ?) ORDER BY hit_count DESC LIMIT 8`, [...uniq, Date.now()]);
    }
  } catch { /* ignore */ }
  return { logs: rows.length, hitRate: Math.round((selected / rows.length) * 100) / 100, recentLessons };
}

function semanticIndexStoredSummary(db) {
  if (!tableExists(db, 'embeddings')) return { entries: 0, refs: 0, models: {}, dims: {}, mixedDim: false };
  const row = one(db, "SELECT COUNT(*) AS c, COUNT(DISTINCT ref_id) AS refs FROM embeddings WHERE kind='noe_memory'");
  const models = countBy(all(db, "SELECT COALESCE(model, '') AS key, COUNT(*) AS c FROM embeddings WHERE kind='noe_memory' GROUP BY COALESCE(model, '') ORDER BY c DESC LIMIT 8"), 'key');
  // P0-B（v4）：维度分布——过滤 dim=0/NULL 脏数据防 'unknown' 键虚增 mixedDim；mixedDim=库内同时存在多种维度。
  const dims = countBy(all(db, "SELECT dim AS key, COUNT(*) AS c FROM embeddings WHERE kind='noe_memory' AND dim IS NOT NULL AND dim>0 GROUP BY dim ORDER BY c DESC LIMIT 8"), 'key');
  return {
    entries: Number(row?.c) || 0,
    refs: Number(row?.refs) || 0,
    models,
    dims,
    mixedDim: Object.keys(dims).length > 1,
  };
}

// P0-B（v4）：维度黑洞健康——enabled 用运行时 queryDimOrphaned 主判据（fallback 降级态不激活，避免误报）；
// disabled 态无召回流量 → queryDimOrphaned=null，靠 mixedDim/dims 静态快照。
function buildDimHealth(storedSemantic, enabled) {
  const runtime = getDimMismatchHealth();
  const dimKeys = Object.keys(storedSemantic.dims || {});
  const last = runtime.lastOrphanEvent;
  const queryDimOrphaned = enabled
    ? Boolean(last) && !last.fallbackDuringQuery && !dimKeys.includes(String(last.queryDim))
    : null;
  return {
    mixedDim: Boolean(storedSemantic.mixedDim),
    dims: storedSemantic.dims || {},
    queryDimOrphaned,
    orphanEventCount: runtime.orphanEventCount,
    lastOrphanEvent: last,
    note: enabled
      ? 'queryDimOrphaned=运行时实测主判据；fallback 降级态不激活'
      : 'disabled 态无查询流量、靠 mixedDim/dims 静态快照',
  };
}

export function buildNoeMemoryStatus({
  db = null,
  env = process.env,
  now = Date.now,
} = {}) {
  const database = db || sqliteStore.getDb();
  ensureNoeMemoryV2Schema(database);
  const t = now();
  const counts = tableExists(database, 'noe_memory')
    ? {
        total: Number(one(database, 'SELECT COUNT(*) AS c FROM noe_memory')?.c) || 0,
        visible: Number(one(database, 'SELECT COUNT(*) AS c FROM noe_memory WHERE hidden=0 AND (expires_at IS NULL OR expires_at > ?)', [t])?.c) || 0,
        hidden: Number(one(database, 'SELECT COUNT(*) AS c FROM noe_memory WHERE hidden=1')?.c) || 0,
        expired: Number(one(database, 'SELECT COUNT(*) AS c FROM noe_memory WHERE expires_at IS NOT NULL AND expires_at <= ?', [t])?.c) || 0,
        byScope: countBy(all(database, 'SELECT scope AS key, COUNT(*) AS c FROM noe_memory WHERE hidden=0 GROUP BY scope'), 'key'),
        bySourceType: countBy(all(database, 'SELECT source_type AS key, COUNT(*) AS c FROM noe_memory WHERE hidden=0 GROUP BY source_type'), 'key'),
      }
    : { total: 0, visible: 0, hidden: 0, expired: 0, byScope: {}, bySourceType: {} };
  const linked = sourceLinkedSummary(database, t);
  const last = latestSourceTimes(database);
  const cstats = candidateStats(database);
  const rstats = retrievalStats(database);
  const storedSemantic = semanticIndexStoredSummary(database);
  const semanticConfig = resolveNoeMemorySemanticConfig(env);
  const semanticProvider = semanticConfig.enabled
    ? {
        enabled: true,
        provider: semanticConfig.provider,
        model: semanticConfig.model,
        baseUrl: semanticConfig.baseUrl,
        source: semanticConfig.source,
        status: 'enabled',
        stored: storedSemantic,
        dimHealth: buildDimHealth(storedSemantic, true),
      }
    : {
        enabled: false,
        provider: '',
        model: '',
        baseUrl: '',
        source: semanticConfig.source,
        disabledExplicitly: semanticConfig.disabledExplicitly,
        status: storedSemantic.entries > 0
          ? (semanticConfig.disabledExplicitly ? 'stored_index_disabled' : 'stored_index_unconfigured')
          : (semanticConfig.disabledExplicitly ? 'disabled' : 'off'),
        stored: storedSemantic,
        dimHealth: buildDimHealth(storedSemantic, false),
      };
  const dreamEnabled = env.NOE_DREAM === '1' || env.NOE_DREAM_CONSOLIDATION === '1';
  const episodeSublimationEnabled = env.NOE_DREAM_EPISODES === '1' || env.NOE_EPISODE_SUBLIMATION === '1';
  const memoryGcMode = env.NOE_MEMORY_GC === '1' ? 'apply' : (env.NOE_MEMORY_GC === 'dry' ? 'dry' : 'off');
  const maintenance = {
    dream: { enabled: dreamEnabled, lastAt: last.dream_consolidation || null },
    nightlyReflection: { enabled: env.NOE_NIGHTLY_REFLECTION === '1', lastAt: last.nightly_reflection || null },
    episodeSublimation: { enabled: episodeSublimationEnabled, lastAt: last.episode_sublimation || null },
    memoryGc: { enabled: memoryGcMode !== 'off', mode: memoryGcMode, lastAt: last.memory_gc || null },
    skillDistill: { enabled: true, lastAt: last.skill_distill || null },
    sftDataset: { enabled: env.NOE_PERSONALITY_DATASET === '1' || env.NOE_SFT_DATASET === '1' },
  };
  const status = {
    ok: true,
    ts: t,
    counts,
    sourceLinked: {
      factTotal: linked.factTotal,
      linkedFacts: linked.linkedFacts,
      anyLinkedFacts: linked.anyLinkedFacts,
      weakLinkedFacts: linked.weakLinkedFacts,
      reviewedOrphanFacts: linked.reviewedOrphanFacts,
      unreviewedOrphanFacts: linked.unreviewedOrphanFacts,
      orphanFacts: linked.orphanFacts,
      orphanRatio: linked.factTotal ? Math.round((linked.orphanFacts / linked.factTotal) * 100) / 100 : 0,
    },
    orphanFacts: linked.orphanFactIds,
    semanticProvider,
    maintenance,
    lastConsolidation: maintenance.dream.lastAt || maintenance.memoryGc.lastAt || null,
    lastEpisodeSublimation: maintenance.episodeSublimation.lastAt,
    writeGate: cstats,
    retrieval: rstats,
    retrievalHitRate: rstats.hitRate,
    quarantineCount: cstats.quarantineCount,
  };
  return {
    ...status,
    memory: {
      visible: counts.visible,
      byScope: counts.byScope,
      bySourceType: counts.bySourceType,
      sourceLinked: status.sourceLinked,
      orphanFacts: status.orphanFacts,
      semanticProvider,
      lastConsolidation: status.lastConsolidation,
      lastEpisodeSublimation: status.lastEpisodeSublimation,
      retrievalHitRate: status.retrievalHitRate,
      quarantineCount: status.quarantineCount,
      maintenance,
    },
  };
}
