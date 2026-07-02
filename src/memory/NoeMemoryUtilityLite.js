// @ts-check

import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

export const NOE_MEMORY_UTILITY_LITE_SCHEMA_VERSION = 1;

const DEFAULT_PROJECT = 'noe';
const DEFAULT_RECENT_RETRIEVAL_LIMIT = 1000;

function clean(value, max = 1000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function pct(n, d) {
  return d ? Number(((100 * Number(n || 0)) / Number(d || 0)).toFixed(2)) : 0;
}

function safeJson(value, fallback) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function jsonArray(value) {
  const parsed = safeJson(value, []);
  return Array.isArray(parsed) ? parsed.map((item) => clean(item, 180)).filter(Boolean) : [];
}

function tableExists(db, table) {
  try {
    return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
  } catch {
    return false;
  }
}

function columns(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  } catch {
    return new Set();
  }
}

function all(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

function one(db, sql, params = []) {
  try {
    return db.prepare(sql).get(...params) || null;
  } catch {
    return null;
  }
}

function increment(map, key, amount = 1) {
  const id = clean(key, 180);
  if (!id) return;
  map.set(id, (map.get(id) || 0) + Number(amount || 0));
}

function mergeIds(...maps) {
  const ids = new Set();
  for (const map of maps) {
    for (const key of map.keys()) ids.add(key);
  }
  return [...ids];
}

function loadRetrievalSignals(db, { projectId, recentRetrievalLimit }) {
  if (!tableExists(db, 'noe_memory_retrieval_log')) {
    return {
      ok: false,
      rows: 0,
      selectedMentions: new Map(),
      inferredDroppedMentions: new Map(),
      dropReasons: {},
      routes: {},
      status: 'missing_noe_memory_retrieval_log',
    };
  }
  const rows = all(db, `
    SELECT id, ts, route_type, hit_ids, selected_ids, dropped_reasons
    FROM noe_memory_retrieval_log
    WHERE project_id = ?
    ORDER BY id DESC
    LIMIT ?
  `, [projectId, Math.max(1, Math.min(5000, Number(recentRetrievalLimit) || DEFAULT_RECENT_RETRIEVAL_LIMIT))]);
  const selectedMentions = new Map();
  const inferredDroppedMentions = new Map();
  const dropReasons = {};
  const routes = {};
  let hitRows = 0;
  let selectedRows = 0;
  let hitTotal = 0;
  let selectedTotal = 0;
  let inferredDroppedTotal = 0;
  for (const row of rows) {
    const route = clean(row.route_type || 'unknown', 80) || 'unknown';
    const hits = jsonArray(row.hit_ids);
    const selected = jsonArray(row.selected_ids);
    const dropped = jsonArray(row.dropped_reasons);
    const selectedSet = new Set(selected);
    routes[route] ||= { rows: 0, hitRows: 0, selectedRows: 0, hitTotal: 0, selectedTotal: 0, inferredDroppedTotal: 0 };
    routes[route].rows += 1;
    if (hits.length) {
      hitRows += 1;
      routes[route].hitRows += 1;
    }
    if (selected.length) {
      selectedRows += 1;
      routes[route].selectedRows += 1;
    }
    hitTotal += hits.length;
    selectedTotal += selected.length;
    routes[route].hitTotal += hits.length;
    routes[route].selectedTotal += selected.length;
    for (const id of selected) increment(selectedMentions, id);
    for (const id of hits) {
      if (!selectedSet.has(id)) {
        increment(inferredDroppedMentions, id);
        inferredDroppedTotal += 1;
        routes[route].inferredDroppedTotal += 1;
      }
    }
    for (const item of dropped) {
      const reason = clean(typeof item === 'string' ? item : item?.reason || 'unknown', 120) || 'unknown';
      dropReasons[reason] = (dropReasons[reason] || 0) + 1;
    }
  }
  return {
    ok: true,
    rows: rows.length,
    hitRows,
    selectedRows,
    hitTotal,
    selectedTotal,
    inferredDroppedTotal,
    hitRowRate: pct(hitRows, rows.length),
    selectedRowRate: pct(selectedRows, rows.length),
    selectedMentions,
    inferredDroppedMentions,
    dropReasons,
    routes: Object.fromEntries(Object.entries(routes).map(([route, item]) => [route, {
      ...item,
      hitRowRate: pct(item.hitRows, item.rows),
      selectedRowRate: pct(item.selectedRows, item.rows),
    }])),
  };
}

function loadMemoryRows(db, ids) {
  if (!tableExists(db, 'noe_memory') || !ids.length) return new Map();
  const cols = columns(db, 'noe_memory');
  const select = [
    'id',
    cols.has('project_id') ? 'project_id' : "'' AS project_id",
    cols.has('scope') ? 'scope' : "'' AS scope",
    cols.has('source_type') ? 'source_type' : "'' AS source_type",
    cols.has('hidden') ? 'hidden' : '0 AS hidden',
    cols.has('hidden_reason') ? 'hidden_reason' : "'' AS hidden_reason",
    cols.has('hit_count') ? 'hit_count' : '0 AS hit_count',
    cols.has('last_hit_at') ? 'last_hit_at' : 'NULL AS last_hit_at',
    cols.has('created_at') ? 'created_at' : 'NULL AS created_at',
    cols.has('updated_at') ? 'updated_at' : 'NULL AS updated_at',
    cols.has('confidence') ? 'confidence' : '0 AS confidence',
    cols.has('salience') ? 'salience' : '3 AS salience',
    cols.has('expires_at') ? 'expires_at' : 'NULL AS expires_at',
    cols.has('ttl_ms') ? 'ttl_ms' : 'NULL AS ttl_ms',
    cols.has('source_episode_id') ? 'source_episode_id' : "'' AS source_episode_id",
  ].join(', ');
  const rows = [];
  for (let i = 0; i < ids.length; i += 800) {
    const chunk = ids.slice(i, i + 800);
    const marks = chunk.map(() => '?').join(',');
    rows.push(...all(db, `SELECT ${select} FROM noe_memory WHERE id IN (${marks})`, chunk));
  }
  return new Map(rows.map((row) => [String(row.id), row]));
}

function loadColdVisibleRows(db, { projectId, nowMs, limit = 20, minAgeDays = 30 }) {
  if (!tableExists(db, 'noe_memory')) return [];
  const cols = columns(db, 'noe_memory');
  if (!cols.has('project_id') || !cols.has('hidden') || !cols.has('hit_count')) return [];
  const ageMs = Math.max(1, Number(minAgeDays) || 30) * 24 * 60 * 60 * 1000;
  const createdExpr = cols.has('created_at') ? 'created_at' : `${nowMs}`;
  const select = [
    'id',
    'project_id',
    cols.has('scope') ? 'scope' : "'' AS scope",
    cols.has('source_type') ? 'source_type' : "'' AS source_type",
    'hidden',
    cols.has('hidden_reason') ? 'hidden_reason' : "'' AS hidden_reason",
    'hit_count',
    cols.has('last_hit_at') ? 'last_hit_at' : 'NULL AS last_hit_at',
    `${createdExpr} AS created_at`,
    cols.has('updated_at') ? 'updated_at' : 'NULL AS updated_at',
    cols.has('confidence') ? 'confidence' : '0 AS confidence',
    cols.has('salience') ? 'salience' : '3 AS salience',
    cols.has('expires_at') ? 'expires_at' : 'NULL AS expires_at',
    cols.has('ttl_ms') ? 'ttl_ms' : 'NULL AS ttl_ms',
    cols.has('source_episode_id') ? 'source_episode_id' : "'' AS source_episode_id",
  ].join(', ');
  return all(db, `
    SELECT ${select}
    FROM noe_memory
    WHERE project_id = ?
      AND hidden = 0
      AND COALESCE(hit_count, 0) = 0
      AND COALESCE(${createdExpr}, ?) <= ?
    ORDER BY COALESCE(${createdExpr}, 0) ASC
    LIMIT ?
  `, [projectId, nowMs, nowMs - ageMs, Math.max(1, Math.min(50, Number(limit) || 20))]);
}

function actionForMemory({ row, selected, inferredDropped, nowMs }) {
  const hidden = Number(row?.hidden || 0) !== 0;
  const expiresAt = Number(row?.expires_at || 0) || null;
  const expired = Boolean(expiresAt && expiresAt <= nowMs);
  const salience = Number(row?.salience || 3);
  const hitCount = Number(row?.hit_count || 0);
  const reasons = [];
  let action = 'needs_review';
  if (hidden && selected > 0) reasons.push('selected_hidden_memory');
  if (expired && selected > 0) reasons.push('selected_expired_memory');
  if (selected >= 3 && selected >= inferredDropped * 2 + 1 && !hidden && !expired && salience >= 5) {
    action = 'needs_review';
    reasons.push('protected_high_salience_strong_signal');
  } else if (selected >= 3 && selected >= inferredDropped * 2 + 1 && !hidden && !expired) {
    action = 'promote_candidate';
    reasons.push('repeatedly_selected');
  } else if (inferredDropped >= 3 && inferredDropped >= selected * 2 + 1 && salience < 5) {
    action = hidden || expired ? 'gc_review_candidate' : 'demote_candidate';
    reasons.push('repeatedly_hit_but_not_selected');
  } else if (hidden || expired) {
    action = 'gc_review_candidate';
    reasons.push(hidden ? 'hidden_memory' : 'expired_memory');
  } else if (hitCount === 0 && selected === 0 && inferredDropped === 0) {
    action = 'gc_review_candidate';
    reasons.push('old_visible_zero_hit');
  } else {
    reasons.push('weak_or_mixed_signal');
  }
  const utilityScore = Number((selected * 2.5 - inferredDropped * 1.25 + Math.log1p(Math.max(0, hitCount)) - (hidden ? 5 : 0) - (expired ? 4 : 0)).toFixed(3));
  return { action, reasons, utilityScore, hidden, expired };
}

function summarizeCandidate(row, { selected, inferredDropped, nowMs, source }) {
  const decision = actionForMemory({ row, selected, inferredDropped, nowMs });
  return {
    memoryId: clean(row.id, 180),
    action: decision.action,
    reasons: decision.reasons,
    source,
    selectedMentions: selected,
    inferredDroppedMentions: inferredDropped,
    utilityScore: decision.utilityScore,
    memory: {
      projectId: clean(row.project_id || '', 120),
      scope: clean(row.scope || '', 80),
      sourceType: clean(row.source_type || '', 80),
      hidden: decision.hidden,
      hiddenReason: clean(row.hidden_reason || '', 160),
      expired: decision.expired,
      hitCount: Number(row.hit_count || 0),
      salience: Number(row.salience || 0),
      confidence: Number(row.confidence || 0),
      hasSourceEpisode: Boolean(clean(row.source_episode_id || '', 160)),
      createdAt: Number(row.created_at || 0) || null,
      updatedAt: Number(row.updated_at || 0) || null,
      lastHitAt: Number(row.last_hit_at || 0) || null,
      expiresAt: Number(row.expires_at || 0) || null,
    },
    policy: {
      candidateOnly: true,
      writesMemoryCore: false,
      writesMemoryV2: false,
      changesSalience: false,
      readsPrivateHoldout: false,
      emitsMemoryBody: false,
    },
  };
}

export function buildNoeMemoryUtilityLiteReport({
  db,
  projectId = DEFAULT_PROJECT,
  now = Date.now(),
  recentRetrievalLimit = DEFAULT_RECENT_RETRIEVAL_LIMIT,
  maxCandidates = 50,
  includeColdZeroHit = true,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const safeProjectId = clean(projectId || DEFAULT_PROJECT, 240) || DEFAULT_PROJECT;
  const retrieval = loadRetrievalSignals(db, { projectId: safeProjectId, recentRetrievalLimit });
  const selected = retrieval.selectedMentions || new Map();
  const inferredDropped = retrieval.inferredDroppedMentions || new Map();
  const ids = mergeIds(selected, inferredDropped);
  const rowsById = loadMemoryRows(db, ids);
  const candidates = [];
  for (const id of ids) {
    const row = rowsById.get(id);
    if (!row) continue;
    candidates.push(summarizeCandidate(row, {
      selected: Number(selected.get(id) || 0),
      inferredDropped: Number(inferredDropped.get(id) || 0),
      nowMs,
      source: 'retrieval_log',
    }));
  }
  if (includeColdZeroHit) {
    for (const row of loadColdVisibleRows(db, { projectId: safeProjectId, nowMs })) {
      if (candidates.some((candidate) => candidate.memoryId === row.id)) continue;
      candidates.push(summarizeCandidate(row, {
        selected: 0,
        inferredDropped: 0,
        nowMs,
        source: 'cold_zero_hit_scan',
      }));
    }
  }
  const sorted = candidates
    .sort((a, b) => {
      const actionRank = { promote_candidate: 4, demote_candidate: 3, gc_review_candidate: 2, needs_review: 1 };
      const ar = actionRank[a.action] || 0;
      const br = actionRank[b.action] || 0;
      if (br !== ar) return br - ar;
      return Math.abs(b.utilityScore) - Math.abs(a.utilityScore);
    })
    .slice(0, Math.max(1, Math.min(200, Number(maxCandidates) || 50)));
  const byAction = {};
  for (const candidate of sorted) byAction[candidate.action] = (byAction[candidate.action] || 0) + 1;
  const memoryTable = tableExists(db, 'noe_memory');
  const memoryCounts = memoryTable
    ? one(db, `
      SELECT
        COUNT(*) total,
        SUM(CASE WHEN hidden=0 THEN 1 ELSE 0 END) visible,
        SUM(CASE WHEN hidden<>0 THEN 1 ELSE 0 END) hidden,
        SUM(CASE WHEN hit_count>0 THEN 1 ELSE 0 END) hitAtLeastOnce
      FROM noe_memory
      WHERE project_id = ?
    `, [safeProjectId]) || {}
    : {};
  return {
    ok: Boolean(memoryTable && retrieval.ok),
    schemaVersion: NOE_MEMORY_UTILITY_LITE_SCHEMA_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    projectId: safeProjectId,
    policy: {
      readOnlyDb: true,
      candidateOnly: true,
      noMemoryBodies: true,
      noPromptBodies: true,
      noSecretOutput: true,
      noOwnerTokenRead: true,
      noEnvFileRead: true,
      noModelCalls: true,
      noActionExecution: true,
      noRuntimeRestart: true,
      privateHoldoutRead: false,
      writesMemoryCore: false,
      writesMemoryV2: false,
      changesSalience: false,
    },
    inputs: {
      recentRetrievalLimit: Math.max(1, Math.min(5000, Number(recentRetrievalLimit) || DEFAULT_RECENT_RETRIEVAL_LIMIT)),
      includeColdZeroHit: includeColdZeroHit === true,
    },
    memory: {
      ok: memoryTable,
      total: Number(memoryCounts.total || 0),
      visible: Number(memoryCounts.visible || 0),
      hidden: Number(memoryCounts.hidden || 0),
      hitAtLeastOnce: Number(memoryCounts.hitAtLeastOnce || 0),
      hitAtLeastOnceRate: pct(memoryCounts.hitAtLeastOnce, memoryCounts.total),
    },
    retrieval: {
      ok: retrieval.ok,
      status: retrieval.status || 'ok',
      rows: retrieval.rows,
      hitRows: retrieval.hitRows || 0,
      selectedRows: retrieval.selectedRows || 0,
      hitTotal: retrieval.hitTotal || 0,
      selectedTotal: retrieval.selectedTotal || 0,
      inferredDroppedTotal: retrieval.inferredDroppedTotal || 0,
      selectedRowRate: retrieval.selectedRowRate || 0,
      routes: retrieval.routes || {},
      dropReasons: retrieval.dropReasons || {},
    },
    candidates: {
      total: sorted.length,
      byAction,
      items: sorted,
    },
    correctionSignals: {
      attribution: 'unavailable_in_lite',
      action: 'needs_review_only',
      reason: 'Current act/error/correction logs do not contain reliable memory_id attribution in this lite slice.',
    },
    caveats: [
      'selected_ids and inferred dropped IDs are retrieval-use proxies, not semantic correctness labels.',
      'This report never changes salience or memory rows; it only emits candidate actions for later gated review.',
    ],
  };
}
