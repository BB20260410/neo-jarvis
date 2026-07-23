#!/usr/bin/env node
// @ts-check
// Read-only semantic memory recall quality audit.
// No owner-token reads, no memory body/title output, no DB writes, no live panel restart.

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { embed, cosineSim } from '../src/embeddings/EmbeddingProvider.js';
import { resolveNoeMemorySemanticConfig } from '../src/memory/NoeMemorySemanticConfig.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = homedir();
const OUT_DIR = process.env.NOE_MEMORY_SEMANTIC_RECALL_QUALITY_OUT_DIR || join(ROOT, 'output', 'noe-audit');
const OUT_BASE = process.env.NOE_MEMORY_SEMANTIC_RECALL_QUALITY_BASENAME || 'memory-semantic-recall-quality-audit-2026-06-15';
const DB_PATH = process.env.PANEL_DB_PATH || join(HOME, '.noe-panel', 'panel.db');
const NOW = Date.now();

const DEFAULT_QUERIES = Object.freeze([
  { id: 'project_memory', q: 'Neo project memory architecture evidence', routeType: 'mission' },
  { id: 'owner_preference', q: '用户偏好 证据 验证 不要编造', routeType: 'chat' },
  { id: 'handoff_evidence', q: '长期任务 断点 交接 运行证据', routeType: 'mission' },
  { id: 'semantic_recall', q: 'semantic memory retrieval recall quality', routeType: 'reflection' },
  { id: 'runtime_truth', q: '功能 是否真的运行 runtime evidence proof', routeType: 'mission' },
]);

function tableExists(db, name) {
  try { return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)); } catch { return false; }
}

function all(db, sql, params = []) {
  try { return db.prepare(sql).all(...params); } catch { return []; }
}

function one(db, sql, params = []) {
  try { return db.prepare(sql).get(...params) || null; } catch { return null; }
}

function clean(value = '', max = 160) {
  return String(value ?? '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [key]')
    .replace(/token[=:]\S+/gi, 'token=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function num(value, precision = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const scale = 10 ** precision;
  return Math.round(n * scale) / scale;
}

function hashId(value = '') {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 16);
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.map((item) => String(item || '')).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function vectorToBuf(vec) {
  const buf = Buffer.allocUnsafe(vec.length * 4);
  for (let i = 0; i < vec.length; i += 1) buf.writeFloatLE(Number(vec[i]) || 0, i * 4);
  return buf;
}

function bufToVector(buf) {
  if (!buf) return new Float32Array();
  const n = Math.floor(buf.length / 4);
  const vec = new Float32Array(n);
  for (let i = 0; i < n; i += 1) vec[i] = buf.readFloatLE(i * 4);
  return vec;
}

function countBy(rows, key = 'key') {
  return Object.fromEntries(rows.map((row) => [String(row[key] || 'unknown'), Number(row.c) || 0]));
}

function buildStoredSemanticSummary(db) {
  if (!tableExists(db, 'embeddings')) {
    return { entries: 0, refs: 0, visibleRefs: 0, byModel: {}, byDim: {}, byModelDim: [] };
  }
  const entries = one(db, "SELECT COUNT(*) AS c, COUNT(DISTINCT ref_id) AS refs FROM embeddings WHERE kind='noe_memory'") || {};
  const visibleRefs = tableExists(db, 'noe_memory')
    ? Number(one(db, `
      SELECT COUNT(DISTINCT e.ref_id) AS c
      FROM embeddings e
      JOIN noe_memory m ON m.id=e.ref_id
      WHERE e.kind='noe_memory' AND m.hidden=0 AND (m.expires_at IS NULL OR m.expires_at > ?)
    `, [NOW])?.c) || 0
    : 0;
  const byModel = countBy(all(db, `
    SELECT COALESCE(model, '') AS key, COUNT(*) AS c
    FROM embeddings
    WHERE kind='noe_memory'
    GROUP BY COALESCE(model, '')
    ORDER BY c DESC
  `), 'key');
  const byDim = countBy(all(db, `
    SELECT COALESCE(dim, 0) AS key, COUNT(*) AS c
    FROM embeddings
    WHERE kind='noe_memory'
    GROUP BY COALESCE(dim, 0)
    ORDER BY c DESC
  `), 'key');
  const byModelDim = all(db, `
    SELECT COALESCE(model, '') AS model, COALESCE(dim, 0) AS dim, COUNT(*) AS count
    FROM embeddings
    WHERE kind='noe_memory'
    GROUP BY COALESCE(model, ''), COALESCE(dim, 0)
    ORDER BY count DESC
    LIMIT 12
  `).map((row) => ({
    model: clean(row.model || 'unknown', 120),
    dim: Number(row.dim) || 0,
    count: Number(row.count) || 0,
  }));
  return {
    entries: Number(entries.c) || 0,
    refs: Number(entries.refs) || 0,
    visibleRefs,
    byModel,
    byDim,
    byModelDim,
  };
}

function buildRetrievalLogCoverage(db) {
  if (!tableExists(db, 'noe_memory_retrieval_log')) {
    return {
      logs: 0,
      recentLogs: 0,
      logsWithHits: 0,
      logsWithSelected: 0,
      distinctHitIds: 0,
      distinctSelectedIds: 0,
      selectedIdsCleaned: 0,
      selectedIdsCoverageDenominator: 0,
      selectedIdsVisible: 0,
      selectedIdsWithCurrentEmbedding: 0,
      selectedVisibleCoverage: null,
      selectedEmbeddingCoverage: null,
      latestAt: null,
    };
  }
  const total = Number(one(db, 'SELECT COUNT(*) AS c FROM noe_memory_retrieval_log')?.c) || 0;
  const latest = Number(one(db, 'SELECT MAX(ts) AS ts FROM noe_memory_retrieval_log')?.ts) || 0;
  const rows = all(db, `
    SELECT ts, hit_ids, selected_ids
    FROM noe_memory_retrieval_log
    ORDER BY ts DESC
    LIMIT 200
  `);
  const hitIds = new Set();
  const selectedIds = new Set();
  let logsWithHits = 0;
  let logsWithSelected = 0;
  for (const row of rows) {
    const hits = parseJsonArray(row.hit_ids);
    const selected = parseJsonArray(row.selected_ids);
    if (hits.length) logsWithHits += 1;
    if (selected.length) logsWithSelected += 1;
    for (const id of hits) hitIds.add(id);
    for (const id of selected) selectedIds.add(id);
  }
  const selected = [...selectedIds];
  let selectedIdsCleaned = 0;
  let selectedIdsVisible = 0;
  let selectedIdsWithCurrentEmbedding = 0;
  // coverage 分母排除「因合理清理而软删」的历史 selected id：merge 去重 / 污染卡治理(P5 蒸馏污染清理)
  //   都是记忆质量的正确动作，不该被 coverage 当成「本应可见却意外消失」的 miss 计入分母——否则正确清理反而拉低指标造成假失败。
  //   只对「非合理清理却消失」的 selected id 算 miss（分母 = 全部 selected − 合理清理软删）。
  // 锚定已知合理清理 reason 白名单（保守：只排确定合法的），不用宽 LIKE '%cleanup%'——
  //   reason 经 API 可透传，宽 LIKE 会把 'cleanup_failed' / 'manual_cleanup_mistake' 这类「失败/误删」也误当合理清理剔出分母，
  //   反而掩盖真 miss。代码实际写的合理清理 reason 仅两类：merge() 写 'merged_into:<id>'、P5 污染清理写 'p5_distill_poison_cleanup'。
  //   （gc_curator/manual_hide/sensitive_text_detected 等不在白名单——它们要么本就该算 miss、要么是非合理软删，保留计入分母。）
  const CLEANED_REASON_SQL = "(hidden_reason='p5_distill_poison_cleanup' OR hidden_reason LIKE 'merged_into:%')";
  if (selected.length && tableExists(db, 'noe_memory')) {
    const placeholders = selected.map(() => '?').join(',');
    selectedIdsCleaned = Number(one(db, `
      SELECT COUNT(*) AS c
      FROM noe_memory
      WHERE id IN (${placeholders}) AND hidden=1 AND hidden_reason IS NOT NULL AND ${CLEANED_REASON_SQL}
    `, selected)?.c) || 0;
    selectedIdsVisible = Number(one(db, `
      SELECT COUNT(*) AS c
      FROM noe_memory
      WHERE id IN (${placeholders}) AND hidden=0 AND (expires_at IS NULL OR expires_at > ?)
    `, [...selected, NOW])?.c) || 0;
    // embedding coverage 也只数留在分母里的 id 的 embedding（排除合理清理软删的 id），
    //   否则被清理但 embedding 行尚未 GC 的 id 会让 coverage 越过 1.0（分母剔了它、分子还算它）。
    selectedIdsWithCurrentEmbedding = Number(one(db, `
      SELECT COUNT(DISTINCT e.ref_id) AS c
      FROM embeddings e
      JOIN noe_memory m ON m.id=e.ref_id
      WHERE e.kind='noe_memory' AND e.ref_id IN (${placeholders})
        AND NOT (m.hidden=1 AND m.hidden_reason IS NOT NULL AND ${CLEANED_REASON_SQL})
    `, selected)?.c) || 0;
  }
  // 分母剔除合理清理软删的 selected；下限 1 防止「全部 selected 都被合理清理」时除零得出误导性的 0/0。
  const coverageDenominator = Math.max(0, selected.length - selectedIdsCleaned);
  return {
    logs: total,
    recentLogs: rows.length,
    logsWithHits,
    logsWithSelected,
    distinctHitIds: hitIds.size,
    distinctSelectedIds: selectedIds.size,
    selectedIdsCleaned,
    selectedIdsCoverageDenominator: coverageDenominator,
    selectedIdsVisible,
    selectedIdsWithCurrentEmbedding,
    selectedVisibleCoverage: coverageDenominator ? num(selectedIdsVisible / coverageDenominator, 3) : null,
    selectedEmbeddingCoverage: coverageDenominator ? num(selectedIdsWithCurrentEmbedding / coverageDenominator, 3) : null,
    latestAt: latest ? new Date(latest).toISOString() : null,
  };
}

function loadVisibleVectors(db, dim) {
  if (!tableExists(db, 'embeddings') || !tableExists(db, 'noe_memory')) return [];
  return all(db, `
    SELECT e.ref_id, e.vector, e.dim, e.model, m.scope, m.source_type
    FROM embeddings e
    JOIN noe_memory m ON m.id=e.ref_id
    WHERE e.kind='noe_memory'
      AND e.dim=?
      AND m.hidden=0
      AND (m.expires_at IS NULL OR m.expires_at > ?)
  `, [dim, NOW]).filter((row) => row.vector);
}

async function runQueryProbe({ db, config, queries, limit, minScore, embedText }) {
  const rows = [];
  let embedOk = true;
  let queryDim = 0;
  let providerReturned = '';
  let modelReturned = '';
  let fallbackCount = 0;
  const vectorCache = new Map();

  for (const item of queries) {
    const id = clean(item.id || item.q || `q-${rows.length}`, 80);
    const q = clean(item.q || '', 240);
    if (!q) continue;
    let embedded;
    try {
      embedded = await embedText(q, {
        provider: config.provider,
        model: config.model,
        baseUrl: config.baseUrl,
      });
    } catch (error) {
      embedOk = false;
      rows.push({
        id,
        ok: false,
        routeType: clean(item.routeType || '', 40),
        queryHash: hashId(q),
        error: clean(error?.message || error, 180),
        hitCount: 0,
        topScore: 0,
        hits: [],
      });
      continue;
    }
    providerReturned = clean(embedded.provider || '', 80);
    modelReturned = clean(embedded.model || '', 120);
    if (embedded.fallback === true || providerReturned === 'hash-fallback') fallbackCount += 1;
    const qv = embedded.vector instanceof Float32Array ? embedded.vector : new Float32Array(embedded.vector || []);
    queryDim = qv.length;
    const cacheKey = String(queryDim);
    if (!vectorCache.has(cacheKey)) vectorCache.set(cacheKey, loadVisibleVectors(db, queryDim));
    const candidates = vectorCache.get(cacheKey) || [];
    const scored = candidates.map((candidate) => ({
      refHash: hashId(candidate.ref_id),
      scope: clean(candidate.scope || '', 40),
      sourceType: clean(candidate.source_type || '', 60),
      model: clean(candidate.model || '', 120),
      score: cosineSim(bufToVector(candidate.vector), qv),
    })).sort((a, b) => b.score - a.score);
    const hits = scored.filter((hit) => hit.score >= minScore).slice(0, limit);
    rows.push({
      id,
      ok: hits.length > 0,
      routeType: clean(item.routeType || '', 40),
      queryHash: hashId(q),
      candidateRows: candidates.length,
      hitCount: hits.length,
      topScore: num(hits[0]?.score || 0, 4),
      scopeCounts: countBy(
        Object.entries(hits.reduce((acc, hit) => {
          acc[hit.scope || 'unknown'] = (acc[hit.scope || 'unknown'] || 0) + 1;
          return acc;
        }, {})).map(([key, c]) => ({ key, c })),
      ),
      hits: hits.map((hit) => ({
        refHash: hit.refHash,
        scope: hit.scope,
        sourceType: hit.sourceType,
        model: hit.model,
        score: num(hit.score, 4),
      })),
    });
  }
  const okRows = rows.filter((row) => row.ok).length;
  return {
    ok: rows.length > 0 && okRows === rows.length && embedOk && fallbackCount === 0,
    sampled: rows.length,
    okRows,
    selectedRows: okRows,
    queryDim,
    providerReturned,
    modelReturned,
    fallbackCount,
    minScore,
    limit,
    rows,
  };
}

export async function buildNoeMemorySemanticRecallQualityAudit({
  dbPath = DB_PATH,
  env = process.env,
  queries = DEFAULT_QUERIES,
  limit = 6,
  minScore = 0.05,
  embedText = embed,
  now = new Date(),
} = {}) {
  const config = resolveNoeMemorySemanticConfig(env);
  const report = {
    ok: false,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    dbPath: dbPath.replace(`${HOME}/`, '~/'),
    policy: {
      readOnlyDb: true,
      noMemoryBodyOutput: true,
      noMemoryTitleOutput: true,
      noOwnerTokenReads: true,
      noEnvFileReads: true,
      noLivePanelRestart: true,
      localEmbeddingProbeOnly: true,
      noChatOrCompletionCalls: true,
    },
    semanticConfig: {
      enabled: config.enabled === true,
      provider: clean(config.provider || '', 80),
      model: clean(config.model || '', 120),
      baseUrl: clean(config.baseUrl || '', 160),
      source: clean(config.source || '', 80),
      disabledExplicitly: config.disabledExplicitly === true,
    },
    storedSemantic: {},
    retrievalLogCoverage: {},
    queryProbe: {},
    quality: {
      status: 'not_run',
      blockers: [],
    },
  };
  if (!existsSync(dbPath)) {
    report.quality = { status: 'db_missing', blockers: ['panel_db_missing'] };
    return report;
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    report.storedSemantic = buildStoredSemanticSummary(db);
    report.retrievalLogCoverage = buildRetrievalLogCoverage(db);
    if (!config.enabled) {
      report.quality = {
        status: 'semantic_provider_disabled',
        blockers: ['semantic_provider_disabled'],
      };
      return report;
    }
    report.queryProbe = await runQueryProbe({
      db,
      config,
      queries,
      limit: Math.max(1, Math.min(20, Number(limit) || 6)),
      minScore: Math.max(0, Number(minScore) || 0),
      embedText,
    });
    const blockers = [];
    if (!report.storedSemantic.entries) blockers.push('semantic_index_empty');
    if (!report.storedSemantic.visibleRefs) blockers.push('semantic_visible_refs_empty');
    if (report.queryProbe.fallbackCount > 0) blockers.push('embedding_provider_fell_back_to_hash');
    if (report.queryProbe.sampled && report.queryProbe.okRows < report.queryProbe.sampled) blockers.push('semantic_query_probe_empty_hits');
    // 用 coverageDenominator（已剔合理清理）而非 distinctSelectedIds 把门：denominator=0 时
    //   （全部 selected 都是合理清理软删，coverage=null）没有「本应可见却消失」的样本可判，必须跳过 coverage 判定——
    //   否则 Number(null||0)=0 < 0.8 仍成立，全清理场景会报假失败。
    if (report.retrievalLogCoverage.selectedIdsCoverageDenominator > 0
        && Number(report.retrievalLogCoverage.selectedEmbeddingCoverage || 0) < 0.8) {
      blockers.push('retrieval_selected_embedding_coverage_low');
    }
    if (report.retrievalLogCoverage.selectedIdsCoverageDenominator > 0
        && Number(report.retrievalLogCoverage.selectedVisibleCoverage || 0) < 0.8) {
      blockers.push('retrieval_selected_visible_coverage_low');
    }
    report.quality = {
      status: blockers.length ? 'needs_attention' : 'recall_quality_probe_passed',
      blockers,
      caveat: 'query probe verifies local embedding/index behavior and retrieval-id coverage, not semantic relevance by reading memory bodies',
    };
    report.ok = blockers.length === 0;
    return report;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

function mdTable(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

export function renderMarkdown(report, jsonPath) {
  const queryRows = Array.isArray(report.queryProbe?.rows)
    ? report.queryProbe.rows.map((row) => [
        `\`${row.id}\``,
        String(row.ok),
        String(row.hitCount || 0),
        String(row.topScore || 0),
        Object.entries(row.scopeCounts || {}).map(([scope, count]) => `${scope}:${count}`).join('<br>') || '-',
      ])
    : [];
  return [
    '# Noe Memory Semantic Recall Quality Audit',
    '',
    `Generated: ${report.generatedAt}`,
    `DB: \`${report.dbPath}\``,
    '',
    '## Verdict',
    '',
    `- ok: ${report.ok}`,
    `- status: ${report.quality?.status || 'unknown'}`,
    `- blockers: ${Array.isArray(report.quality?.blockers) && report.quality.blockers.length ? report.quality.blockers.map((b) => `\`${b}\``).join(', ') : '-'}`,
    `- caveat: ${clean(report.quality?.caveat || '-', 260)}`,
    '',
    '## Semantic Config',
    '',
    `- provider: \`${report.semanticConfig.provider || '-'}\``,
    `- model: \`${report.semanticConfig.model || '-'}\``,
    `- source: \`${report.semanticConfig.source || '-'}\``,
    `- enabled: ${report.semanticConfig.enabled}`,
    '',
    '## Stored Index',
    '',
    `- entries: ${report.storedSemantic.entries ?? 0}`,
    `- refs: ${report.storedSemantic.refs ?? 0}`,
    `- visible refs: ${report.storedSemantic.visibleRefs ?? 0}`,
    `- model/dim: ${(report.storedSemantic.byModelDim || []).map((row) => `\`${row.model}\`/${row.dim}: ${row.count}`).join(', ') || '-'}`,
    '',
    '## Retrieval Log Coverage',
    '',
    `- logs: ${report.retrievalLogCoverage.logs ?? 0}`,
    `- logs with selected ids: ${report.retrievalLogCoverage.logsWithSelected ?? 0}`,
    `- distinct selected ids: ${report.retrievalLogCoverage.distinctSelectedIds ?? 0}`,
    `- selected ids cleaned (merged/cleanup/poison, excluded from coverage): ${report.retrievalLogCoverage.selectedIdsCleaned ?? 0}`,
    `- coverage denominator (selected − cleaned): ${report.retrievalLogCoverage.selectedIdsCoverageDenominator ?? 0}`,
    `- selected visible coverage: ${report.retrievalLogCoverage.selectedVisibleCoverage ?? '-'}`,
    `- selected embedding coverage: ${report.retrievalLogCoverage.selectedEmbeddingCoverage ?? '-'}`,
    '',
    '## Query Probe',
    '',
    mdTable([
      ['query', 'ok', 'hits', 'top score', 'scope counts'],
      ['---', '---', '---:', '---:', '---'],
      ...queryRows,
    ]),
    '',
    '## JSON',
    '',
    `Full report: \`${jsonPath.replace(`${ROOT}/`, '')}\`.`,
  ].join('\n');
}

export function writeNoeMemorySemanticRecallQualityAudit(report) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${OUT_BASE}.json`);
  const mdPath = join(OUT_DIR, `${OUT_BASE}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mdPath, `${renderMarkdown(report, jsonPath)}\n`, { mode: 0o600 });
  return { jsonPath, mdPath };
}

export { DEFAULT_QUERIES, vectorToBuf };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await buildNoeMemorySemanticRecallQualityAudit();
  const paths = writeNoeMemorySemanticRecallQualityAudit(report);
  console.log(JSON.stringify({
    ok: report.ok,
    status: report.quality.status,
    blockers: report.quality.blockers,
    storedEntries: report.storedSemantic.entries,
    visibleRefs: report.storedSemantic.visibleRefs,
    retrievalSelectedEmbeddingCoverage: report.retrievalLogCoverage.selectedEmbeddingCoverage,
    queryProbeOkRows: report.queryProbe.okRows,
    paths,
  }, null, 2));
}
