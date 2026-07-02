// @ts-check

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { close, getDb, initSqlite } from '../storage/SqliteStore.js';
import { MemoryCore } from './MemoryCore.js';
import { NoeMemoryAuditLog } from './NoeMemoryAuditLog.js';
import { NoeMemoryRetriever } from './NoeMemoryRetriever.js';
import { buildNoeMemoryStatus } from './NoeMemoryStatus.js';
import { createMemorySemanticIndex } from './NoeMemorySemanticIndex.js';
import { resolveOllamaKeepAlive } from '../embeddings/EmbeddingProvider.js';
import {
  DEFAULT_MEMORY_RETRIEVAL_SAMPLE_QUERIES,
  runNoeMemoryRetrievalSample,
} from './NoeMemoryRetrievalSample.js';
import { runNoeMemoryMaintenanceDryRun } from './NoeMemoryMaintenanceDryRun.js';

function tableExists(db, name) {
  try { return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)); } catch { return false; }
}

function asPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function cleanId(value, max = 180) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function backupSqliteToCopy({ sourceDbPath = '', copyPath }) {
  close();
  const sourceDb = initSqlite(sourceDbPath || undefined);
  await sourceDb.backup(copyPath);
  close();
  return copyPath;
}

export async function probeOllamaEmbeddingModel({
  baseUrl = 'http://127.0.0.1:11434',
  model = 'qwen3-embedding:0.6b',
  keepAlive,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'fetch_unavailable', baseUrl, model };
  try {
    const tagsResp = await fetchImpl(`${baseUrl}/api/tags`);
    if (!tagsResp.ok) return { ok: false, reason: `tags_http_${tagsResp.status}`, baseUrl, model };
    const tagsJson = await tagsResp.json();
    const models = Array.isArray(tagsJson?.models) ? tagsJson.models.map((m) => String(m?.name || '')).filter(Boolean) : [];
    const hasModel = models.includes(model);
    if (!hasModel) return { ok: false, reason: 'model_not_installed', baseUrl, model, models };
    // keep_alive 透传：probe 也让模型常驻，根治按需唤醒间歇失效（reference_ollama_ondemand_embedding_failure）。
    const probeKeepAlive = resolveOllamaKeepAlive(keepAlive);
    const probeBody = { model, prompt: 'Noe memory semantic readiness probe' };
    if (probeKeepAlive !== undefined) probeBody.keep_alive = probeKeepAlive;
    const embedResp = await fetchImpl(`${baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(probeBody),
    });
    if (!embedResp.ok) return { ok: false, reason: `embed_http_${embedResp.status}`, baseUrl, model, models };
    const embedJson = await embedResp.json();
    const dim = Array.isArray(embedJson?.embedding) ? embedJson.embedding.length : 0;
    return { ok: dim > 0, reason: dim > 0 ? '' : 'embedding_empty', baseUrl, model, dim, models };
  } catch (error) {
    return { ok: false, reason: cleanId(error?.message || error, 240), baseUrl, model };
  }
}

function purgeHashEmbeddings(db) {
  if (!tableExists(db, 'embeddings')) return { purged: 0 };
  const result = db.prepare(`
    DELETE FROM embeddings
    WHERE kind='noe_memory' AND (model='hash-128' OR dim=128)
  `).run();
  return { purged: Number(result.changes) || 0 };
}

function visibleMemoryRows(db, { projectId, limit, now }) {
  if (!tableExists(db, 'noe_memory')) return [];
  return db.prepare(`
    SELECT id, title, body
    FROM noe_memory
    WHERE hidden=0 AND project_id=? AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(projectId, now(), limit);
}

function embeddingSummary(db) {
  if (!tableExists(db, 'embeddings')) return { entries: 0, byModel: {} };
  const rows = db.prepare(`
    SELECT COALESCE(model, '') AS model, COUNT(*) AS c
    FROM embeddings
    WHERE kind='noe_memory'
    GROUP BY COALESCE(model, '')
    ORDER BY c DESC
  `).all();
  return {
    entries: rows.reduce((sum, row) => sum + Number(row.c || 0), 0),
    byModel: Object.fromEntries(rows.map((row) => [String(row.model || 'unknown'), Number(row.c) || 0])),
  };
}

async function backfillSemanticCopy({ db, semanticIndex, projectId, maxBackfill, now }) {
  const before = embeddingSummary(db);
  const purge = purgeHashEmbeddings(db);
  const rows = visibleMemoryRows(db, { projectId, limit: maxBackfill, now });
  let upserted = 0;
  let fallbackCount = 0;
  const models = {};
  for (const row of rows) {
    const result = await semanticIndex.upsert({ refId: row.id, text: `${row.title || ''}\n${row.body || ''}` });
    const model = cleanId(result?.model || 'unknown', 120);
    models[model] = (models[model] || 0) + 1;
    if (model.startsWith('hash-') || result?.provider === 'hash-fallback' || result?.fallback === true) fallbackCount += 1;
    upserted += 1;
  }
  const after = embeddingSummary(db);
  return {
    before,
    purge,
    candidates: rows.length,
    upserted,
    fallbackCount,
    models,
    after,
    ok: rows.length > 0 && upserted === rows.length && fallbackCount === 0,
  };
}

async function sampleRetrieval({ memory, projectId, queries, label }) {
  const retriever = new NoeMemoryRetriever({
    memory,
    auditLog: new NoeMemoryAuditLog({ db: () => getDb() }),
    logger: { warn: () => {} },
  });
  const result = await runNoeMemoryRetrievalSample({
    retriever,
    projectId,
    queries,
    turnPrefix: `copy-validation-${label}-${Date.now()}`,
  });
  return {
    ok: result.ok,
    sampled: result.sampled,
    selectedRows: result.selectedRows,
    selectedRatio: result.sampled ? Math.round((result.selectedRows / result.sampled) * 100) / 100 : 0,
    rows: result.rows.map((row) => ({
      id: row.id,
      ok: row.ok,
      routeType: row.routeType,
      selectedCount: row.selectedCount,
      selectedIds: row.selectedIds,
      droppedReasons: row.droppedReasons,
    })),
  };
}

function applyMaintenanceOnCopy({ memory, db, projectId }) {
  const before = buildNoeMemoryStatus({ db });
  const gc = memory.runGc({ apply: true, projectId, reason: 'copy_validation_gc_apply' });
  const hiddenRows = gc.hidden.length
    ? db.prepare(`
      SELECT id, scope, salience, hidden_reason
      FROM noe_memory
      WHERE id IN (${gc.hidden.map(() => '?').join(',')})
    `).all(...gc.hidden)
    : [];
  const protectedAffected = hiddenRows
    .filter((row) => Number(row.salience) >= 5 || ['identity', 'person'].includes(String(row.scope || '')))
    .map((row) => cleanId(row.id));
  const after = buildNoeMemoryStatus({ db });
  return {
    before: {
      counts: before.counts,
      sourceLinked: before.sourceLinked,
    },
    gcApply: {
      applied: true,
      hiddenCount: gc.hidden.length,
      hiddenIds: gc.hidden.map((id) => cleanId(id)).slice(0, 50),
      protectedAffected,
      truncated: gc.truncated === true,
      planCounts: gc.plan?.counts || {},
    },
    after: {
      counts: after.counts,
      sourceLinked: after.sourceLinked,
    },
    ok: protectedAffected.length === 0,
  };
}

export async function runNoeMemoryCopyValidation({
  sourceDbPath = '',
  projectId = 'noe',
  model = 'qwen3-embedding:0.6b',
  provider = 'ollama',
  baseUrl = 'http://127.0.0.1:11434',
  maxBackfill = 240,
  queries = DEFAULT_MEMORY_RETRIEVAL_SAMPLE_QUERIES,
  semanticIndexFactory = createMemorySemanticIndex,
  ollamaProbe = probeOllamaEmbeddingModel,
  cleanup = true,
  now = Date.now,
} = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'noe-memory-copy-validation-'));
  const copyPath = join(tempDir, 'panel.copy.db');
  let report;
  try {
    await backupSqliteToCopy({ sourceDbPath, copyPath });
    close();
    initSqlite(copyPath);
    const db = getDb();
    const statusBefore = buildNoeMemoryStatus({ db });
    const ollama = provider === 'ollama' ? await ollamaProbe({ baseUrl, model }) : { ok: true, reason: 'provider_not_ollama', baseUrl, model };
    const semanticIndex = semanticIndexFactory({ provider, model, baseUrl });
    const semanticBackfill = await backfillSemanticCopy({
      db,
      semanticIndex,
      projectId,
      maxBackfill: asPositiveInt(maxBackfill, 240),
      now,
    });
    const ftsMemory = new MemoryCore({ logger: { warn: () => {}, info: () => {} } });
    const fusedMemory = new MemoryCore({ semanticIndex, logger: { warn: () => {}, info: () => {} } });
    const ftsSample = await sampleRetrieval({ memory: ftsMemory, projectId, queries, label: 'fts' });
    const fusedSample = await sampleRetrieval({ memory: fusedMemory, projectId, queries, label: 'fused' });
    const maintenanceDryRun = await runNoeMemoryMaintenanceDryRun({ memory: fusedMemory, db, projectId, now });
    const maintenanceApply = applyMaintenanceOnCopy({ memory: fusedMemory, db, projectId });
    const selectedDelta = fusedSample.selectedRows - ftsSample.selectedRows;
    const semanticQualityOk = semanticBackfill.ok && fusedSample.selectedRows > 0 && selectedDelta >= 0;
    report = {
      ok: Boolean((provider !== 'ollama' || ollama.ok) && semanticQualityOk && maintenanceApply.ok),
      generatedAt: new Date().toISOString(),
      projectId,
      copy: {
        sourceDbPath: sourceDbPath || 'default_panel_db',
        copyPath,
        retained: cleanup !== true,
        realDbWrites: false,
        livePanelTouched: false,
        port51735Touched: false,
      },
      statusBefore: {
        counts: statusBefore.counts,
        sourceLinked: statusBefore.sourceLinked,
        semanticProvider: statusBefore.semanticProvider,
        retrieval: statusBefore.retrieval,
      },
      ollama,
      semanticBackfill,
      retrievalComparison: {
        fts: ftsSample,
        fused: fusedSample,
        selectedDelta,
        semanticQualityOk,
      },
      maintenance: {
        dryRun: maintenanceDryRun,
        apply: maintenanceApply,
      },
      policy: {
        copyOnly: true,
        noMemoryBodyOutput: true,
        noSecretOutput: true,
        noLivePanelRestart: true,
      },
    };
  } finally {
    close();
    if (cleanup && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  }
  return report;
}
