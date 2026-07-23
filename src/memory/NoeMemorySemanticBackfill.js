// @ts-check

import { getDb, initSqlite } from '../storage/SqliteStore.js';
import { buildNoeMemoryStatus } from './NoeMemoryStatus.js';
import { createMemorySemanticIndex } from './NoeMemorySemanticIndex.js';
import { probeOllamaEmbeddingModel } from './NoeMemoryCopyValidation.js';

function tableExists(db, name) {
  try { return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)); } catch { return false; }
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function visibleRows(db, { projectId, limit, now }) {
  if (!tableExists(db, 'noe_memory')) return [];
  return db.prepare(`
    SELECT id, title, body
    FROM noe_memory
    WHERE project_id=? AND hidden=0 AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(projectId, now(), limit);
}

function purgeHashEmbeddings(db) {
  if (!tableExists(db, 'embeddings')) return { purged: 0 };
  const result = db.prepare(`
    DELETE FROM embeddings
    WHERE kind='noe_memory' AND (model='hash-128' OR dim=128)
  `).run();
  return { purged: Number(result.changes) || 0 };
}

export async function runNoeMemorySemanticBackfill({
  projectId = 'noe',
  provider = 'ollama',
  model = 'qwen3-embedding:0.6b',
  baseUrl = 'http://127.0.0.1:11434',
  maxBackfill = 10000,
  apply = false,
  ackApply = false,
  now = Date.now,
  semanticIndexFactory = createMemorySemanticIndex,
  ollamaProbe = probeOllamaEmbeddingModel,
} = {}) {
  initSqlite();
  const db = getDb();
  const before = buildNoeMemoryStatus({ db });
  const candidates = visibleRows(db, { projectId, limit: positiveInt(maxBackfill, 10000), now });
  const plannedHashPurge = Number(before.semanticProvider?.stored?.models?.['hash-128'] || 0);
  const ollama = provider === 'ollama' ? await ollamaProbe({ baseUrl, model }) : { ok: true, reason: 'provider_not_ollama', baseUrl, model };
  if (apply && provider === 'ollama' && !ollama.ok) {
    return {
      ok: false,
      mode: 'blocked',
      reason: 'ollama_embedding_unavailable',
      projectId,
      before: {
        semanticProvider: before.semanticProvider,
        counts: before.counts,
      },
      candidates: candidates.length,
      plannedHashPurge,
      ollama,
      policy: { noMemoryBodyOutput: true, noSecretOutput: true, realDbWrites: false },
    };
  }
  if (apply && !ackApply) {
    return {
      ok: false,
      mode: 'blocked',
      reason: 'ack_semantic_backfill_apply_required',
      projectId,
      before: {
        semanticProvider: before.semanticProvider,
        counts: before.counts,
      },
      candidates: candidates.length,
      plannedHashPurge,
      ollama,
      policy: { noMemoryBodyOutput: true, noSecretOutput: true, realDbWrites: false },
    };
  }
  if (!apply) {
    return {
      ok: true,
      mode: 'dry_run',
      projectId,
      before: {
        semanticProvider: before.semanticProvider,
        counts: before.counts,
      },
      candidates: candidates.length,
      plannedHashPurge,
      ollama,
      policy: { noMemoryBodyOutput: true, noSecretOutput: true, realDbWrites: false },
    };
  }
  const semanticIndex = semanticIndexFactory({ provider, model, baseUrl });
  // M2 修复：不先删 hash 向量。先逐条重嵌入覆盖（ON CONFLICT 更新同 ref_id），全部成功（无 fallback）
  // 后再删残留 hash 行——否则"先删后写"中途崩溃/ollama 掉线会留下既无 hash 也无 ollama 向量的空洞。
  let upserted = 0;
  let fallbackCount = 0;
  const models = {};
  for (const row of candidates) {
    const result = await semanticIndex.upsert({ refId: row.id, text: `${row.title || ''}\n${row.body || ''}` });
    const usedModel = String(result?.model || 'unknown');
    models[usedModel] = (models[usedModel] || 0) + 1;
    if (usedModel.startsWith('hash-') || result?.provider === 'hash-fallback' || result?.fallback === true) fallbackCount += 1;
    upserted += 1;
  }
  // 仅当全部 candidate 都成功嵌入为非 fallback 向量时，才清理残留 hash 行；否则保留旧向量避免空洞。
  const purge = (fallbackCount === 0 && upserted === candidates.length)
    ? purgeHashEmbeddings(db)
    : { purged: 0, skipped: 'fallback_or_incomplete' };
  const after = buildNoeMemoryStatus({ db });
  return {
    ok: Boolean((provider !== 'ollama' || ollama.ok) && candidates.length > 0 && upserted === candidates.length && fallbackCount === 0),
    mode: 'apply',
    projectId,
    before: {
      semanticProvider: before.semanticProvider,
      counts: before.counts,
    },
    apply: {
      purge,
      candidates: candidates.length,
      upserted,
      fallbackCount,
      models,
    },
    after: {
      semanticProvider: after.semanticProvider,
      counts: after.counts,
    },
    ollama,
    policy: { noMemoryBodyOutput: true, noSecretOutput: true, realDbWrites: true },
  };
}
