// panel v2.0 Task 4.2 — 向量索引（基于 SqliteStore.embeddings 表）

import { getDb, initSqlite } from '../storage/SqliteStore.js';
import { embed, cosineSim } from './EmbeddingProvider.js';

// Float32Array <-> Buffer 互转
function vectorToBuf(vec) {
  const buf = Buffer.allocUnsafe(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}
function bufToVector(buf) {
  const n = buf.length / 4;
  const vec = new Float32Array(n);
  for (let i = 0; i < n; i++) vec[i] = buf.readFloatLE(i * 4);
  return vec;
}

// 审计 §续审 P1：缓存 prepared statement，按 db 实例失效（切库后旧 statement 随旧连接失效则重建）。
// upsertEmbedding（每条记忆写）和 semanticSearch（每轮对话）高频，避免每次重新编译 SQL。
let _stmtDb = null;
const _stmtCache = new Map();
function stmt(db, sql) {
  if (_stmtDb !== db) { _stmtCache.clear(); _stmtDb = db; }
  let s = _stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); _stmtCache.set(sql, s); }
  return s;
}

// 审计 §维度静默丢召回：semanticSearch/semanticSearchVectors 用 SQL `dim = ?` 硬过滤异维行（见下方注释）。
// provider 切换后（hash-128 旧记忆 vs ollama 768/1024 维查询），可能整张表都被过滤掉 → 零命中且无任何信号。
// 该 helper 仅在「评分结果为空」时调用：若该 kind 下没有同维行但存在异维行 = 真·孤儿向量，发一条可观测告警
// 指向 backfill（runNoeMemorySemanticBackfill / NOE_MEMORY_EMBED_PROVIDER），不静默；空库或仅 minScore 没过则不告警避免噪声。
// 节流：semanticSearch 每轮对话高频，按 `kind|dim` 签名做进程级冷却（首次必告警），换 db 实例随 _stmtCache 一并清。
const _dimWarnCooldownMs = 60_000;
let _dimWarnDb = null;
const _dimWarnAt = new Map();
// P0-B（v4）：维度孤儿「真实事件计数」+「最近一次孤儿事件」——在 60s 节流之前累计，故反映真实丢召回
// 频次（不被节流稀释，区别于受节流的 console.warn）。fallbackDuringQuery 标记「ollama 离线退 hash 的查询
// 降级态」（非库损坏），供 NoeMemoryStatus/mind 透视页据此不激活 queryDimOrphaned，避免误报。
let _dimOrphanEventCount = 0;
let _lastOrphanEvent = null; // { queryDim, storedDims, at, fallbackDuringQuery }
function _warnDimMismatchIfOrphaned(db, kind, qvLen, fallbackDuringQuery = false, now = Date.now) {
  if (_dimWarnDb !== db) { _dimWarnAt.clear(); _dimWarnDb = db; }
  let rows;
  try {
    const where = kind ? 'WHERE kind = ?' : '';
    const a = kind ? [kind] : [];
    rows = stmt(db, `SELECT dim, COUNT(*) AS c FROM embeddings ${where} GROUP BY dim`).all(...a);
  } catch { return; } // 诊断失败不得影响主流程
  if (!rows.length) return; // 空库/该 kind 无任何向量 = 正常空结果，非 bug
  const sameDim = rows.find((r) => Number(r.dim) === qvLen);
  if (sameDim && Number(sameDim.c) > 0) return; // 有同维行（只是没过 minScore）= 正常，不告警
  // 确认孤儿事件（有异维、无同维）。dist 提前生成（rows 上方已取）；事件计数 + lastOrphanEvent 在
  // 60s 节流 return 之前累计，反映真实频次（不被节流稀释）。
  const t = now();
  const dist = rows.map((r) => `${r.dim}:${r.c}`).join(', ');
  _dimOrphanEventCount += 1;
  _lastOrphanEvent = { queryDim: qvLen, storedDims: dist, at: t, fallbackDuringQuery: Boolean(fallbackDuringQuery) };
  const key = `${kind || '*'}|${qvLen}`;
  const last = _dimWarnAt.get(key);
  if (last && t - last < _dimWarnCooldownMs) return; // 冷却内不刷屏（只挡 console.warn，不挡上面的事件计数）
  _dimWarnAt.set(key, t);
  console.warn(`[noe-vector] semanticSearch 维度不匹配丢召回 kind=${kind || '*'} 查询维度=${qvLen} 库内维度分布={${dist}}；旧向量需 backfill（runNoeMemorySemanticBackfill / 对齐 NOE_MEMORY_EMBED_PROVIDER）`);
}

// P0-B（v4）：维度黑洞健康快照——供 NoeMemoryStatus.semanticProvider.dimHealth + mind 透视页消费。
export function getDimMismatchHealth() {
  return {
    orphanEventCount: _dimOrphanEventCount,
    lastOrphanEvent: _lastOrphanEvent ? { ..._lastOrphanEvent } : null,
  };
}
export function resetDimMismatchHealth() {
  _dimOrphanEventCount = 0;
  _lastOrphanEvent = null;
  _dimWarnAt.clear();
  _dimWarnDb = null;
}

export async function upsertEmbedding({ kind, refId, text, provider = 'hash', model, baseUrl, keepAlive }) {
  initSqlite();
  const db = getDb();
  const { vector, provider: p, model: m, fallback, error } = await embed(text, { provider, model, baseUrl, keepAlive });
  // M1 修复：请求 ollama 但实际退回 hash-fallback（ollama 离线）时，低维向量与库内 ollama 主体维度
  // 不匹配，查询会被 dim 过滤永远召回不到（=维度孤儿，污染 dim 分布还误导诊断）。此时不写入、回报
  // skipped，留待 ollama 恢复后由 backfill 正确嵌入，而不是静默写一条永远查不到的向量。
  // 纯 hash 配置（provider!=='ollama'）不受影响，正常写 hash-128。
  if (fallback && provider === 'ollama') {
    return { ok: false, skipped: 'embed_fallback', provider: p, model: m, error };
  }
  stmt(db, `
    INSERT INTO embeddings(kind, ref_id, text, vector, dim, model)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind, ref_id) DO UPDATE SET
      text = excluded.text, vector = excluded.vector,
      dim = excluded.dim, model = excluded.model
  `).run(kind, refId, text, vectorToBuf(vector), vector.length, m);
  return { ok: true, dim: vector.length, provider: p, model: m };
}

export async function semanticSearch(query, { kind, limit = 10, provider = 'hash', model, baseUrl, keepAlive, minScore = 0 } = {}) {
  initSqlite();
  const db = getDb();
  const { vector: qv, fallback } = await embed(query, { provider, model, baseUrl, keepAlive });
  // 审计 §续审 P0：SQL 层按 dim 过滤——不同维向量本就判 0 分噪声，先在 SQL 过滤掉省全表 BLOB 解码
  // （混 provider 时省异维行解码；同时去掉返回 0 分异维行的噪声，过滤后所有行同维可直接打分）。
  const conds = ['dim = ?'];
  const args = [qv.length];
  if (kind) { conds.push('kind = ?'); args.push(kind); }
  const rows = stmt(db, `SELECT id, kind, ref_id, text, vector, dim, model FROM embeddings WHERE ${conds.join(' AND ')}`).all(...args);
  const scored = rows.map(r => {
    const v = bufToVector(r.vector);
    return { id: r.id, kind: r.kind, refId: r.ref_id, text: r.text, model: r.model, score: cosineSim(v, qv) };
  });
  scored.sort((a, b) => b.score - a.score);
  const out = scored.filter(s => s.score >= minScore).slice(0, limit);
  if (out.length === 0) _warnDimMismatchIfOrphaned(db, kind, qv.length, fallback); // 零命中时诊断是否维度孤儿（fallback=ollama 退 hash 的查询降级标记）
  return out;
}

export function deleteEmbedding({ kind, refId }) {
  initSqlite();
  const db = getDb();
  return stmt(db, 'DELETE FROM embeddings WHERE kind = ? AND ref_id = ?').run(kind, refId).changes;
}

export function listEmbeddings({ kind, limit = 100 } = {}) {
  initSqlite();
  const db = getDb();
  const where = kind ? 'WHERE kind = ?' : '';
  const args = kind ? [kind] : [];
  args.push(limit);
  return stmt(db, `SELECT id, kind, ref_id, substr(text, 1, 200) as text, dim, model FROM embeddings ${where} ORDER BY id DESC LIMIT ?`).all(...args);
}

// NOE_MEMORY_FISHER_RANK 接线用：与 semanticSearch 同检索，但额外返回「查询向量 + 命中的原始向量」，
// 供 NoeFisherRaoReranker 估计方差并按 Fisher-Rao 度量重排（普通 cosine 路径不需向量，故另开方法不动 semanticSearch）。
// 返回 { queryVector:number[], hits:[{refId,score,vector:number[]}] }（vector 已解码为普通数组，按 cosine 降序）。
export async function semanticSearchVectors(query, { kind, limit = 10, provider = 'hash', model, baseUrl, keepAlive, minScore = 0 } = {}) {
  initSqlite();
  const db = getDb();
  const { vector: qv, fallback } = await embed(query, { provider, model, baseUrl, keepAlive });
  const conds = ['dim = ?'];
  const args = [qv.length];
  if (kind) { conds.push('kind = ?'); args.push(kind); }
  const rows = stmt(db, `SELECT id, kind, ref_id, vector, dim, model FROM embeddings WHERE ${conds.join(' AND ')}`).all(...args);
  const scored = rows.map((r) => {
    const v = bufToVector(r.vector);
    return { refId: r.ref_id, score: cosineSim(v, qv), vector: Array.from(v) };
  });
  scored.sort((a, b) => b.score - a.score);
  const hits = scored.filter((s) => s.score >= minScore).slice(0, limit);
  if (hits.length === 0) _warnDimMismatchIfOrphaned(db, kind, qv.length, fallback); // 零命中时诊断是否维度孤儿（fallback 透传）
  return { queryVector: Array.from(qv), hits };
}
