import { randomUUID } from 'node:crypto';
import * as sqliteStore from '../storage/SqliteStore.js';
import { planMemoryGc } from './NoeMemoryCurator.js';
import { reciprocalRankFusion, salienceBoostFactor } from './NoeFusionRanker.js';
import { makeActivationScorer } from './NoeMemoryDynamics.js';
import { makeFisherRaoReranker } from './NoeFisherRaoReranker.js';
import { decideMemoryWrite, decideSemanticConflict } from './NoeMemoryDedup.js';
import { decideMemoryConflict } from './NoeMemoryConflictPolicy.js';
import { shouldBlockEntityMerge } from './NoeEntityMergeGuard.js';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

const DEFAULT_PROJECT = 'default';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_TEXT = 100_000;

function nowMs() {
  return Date.now();
}

function safeString(value, max = 1000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function safeMemoryString(value, max = 1000) {
  return redactSensitiveText(safeString(value, max));
}

function normalizeProject(value) {
  return safeMemoryString(value || DEFAULT_PROJECT, 240) || DEFAULT_PROJECT;
}

function normalizeLimit(value, fallback = DEFAULT_LIMIT) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(n)));
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return '[]';
  const out = tags.map((tag) => safeMemoryString(tag, 80)).filter(Boolean).slice(0, 40);
  return JSON.stringify(out);
}

function parseTags(value) {
  try {
    const tags = JSON.parse(value || '[]');
    return Array.isArray(tags) ? tags : [];
  } catch {
    return [];
  }
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function sanitizeTraceArray(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((entry) => {
    const redacted = redactSensitiveText(JSON.stringify(entry ?? null)).slice(0, 20_000);
    try {
      return JSON.parse(redacted);
    } catch {
      return { redacted: true };
    }
  });
}

function normalizeConfidence(value) {
  if (value === undefined || value === null || value === '') return 1;
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(1, n));
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// 梦境/睡眠整合用:salience 1-5 显著性(5=身份级受保护;默认 3)。
function clampSalience(value, fallback = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(5, Math.trunc(n)));
}

function rowToMemory(row = {}) {
  return {
    id: row.id,
    projectId: row.project_id,
    scope: row.scope,
    title: row.title || '',
    body: row.body || '',
    sourceType: row.source_type || 'manual',
    sourceId: row.source_id || null,
    tags: parseTags(row.tags),
    hidden: row.hidden === 1,
    hitCount: Number(row.hit_count) || 0,
    lastHitAt: row.last_hit_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confidence: normalizeConfidence(row.confidence),
    ttlMs: row.ttl_ms ?? null,
    expiresAt: row.expires_at ?? null,
    expired: row.expires_at ? row.expires_at <= nowMs() : false,
    mergeTrace: parseJsonArray(row.merge_trace),
    hiddenReason: row.hidden_reason || null,
    salience: clampSalience(row.salience),
    validFrom: row.valid_from ?? null,
    validTo: row.valid_to ?? null,
    sourceEpisodeId: row.source_episode_id || null,
    score: row.score ?? row.rank ?? null,
  };
}

function ftsPhrase(query) {
  const text = safeString(query, 512).replace(/"/g, '""');
  return text ? `"${text}"` : '';
}

export class MemoryCore {
  constructor({ storage = sqliteStore, logger = console, semanticIndex = null, dedupe = null, conflictPolicy = null, fisherRank = null, salienceFusion = null } = {}) {
    this.storage = storage;
    this.logger = logger;
    this.semanticIndex = semanticIndex; // NoeMemorySemanticIndex（波次6 接线）：注入才开双路召回，否则纯 FTS 行为不变
    // 写入去重/冲突合并（借鉴 mem0）：与近期同 scope 记忆高度相似 → UPDATE 替换并记 merge_trace 而非堆新。
    // 默认看 env（NOE_MEMORY_DEDUP=1 开），可注入覆盖便于测试；关闭时 write 行为与旧完全一致。
    const env = (dedupe && dedupe.env) || process.env;
    this.dedupe = {
      enabled: dedupe?.enabled ?? (env.NOE_MEMORY_DEDUP === '1'),
      threshold: dedupe?.threshold ?? (Number(env.NOE_MEMORY_DEDUP_THRESHOLD) || 0.62),
      protectSalience: dedupe?.protectSalience ?? 5,
      scanLimit: dedupe?.scanLimit ?? 25,
      // 语义冲突合并（方向三，NOE_MEMORY_DEDUP_SEMANTIC=1 默认 OFF）：写后异步 sweep 抓"换关键词矛盾"
      //（美式→拿铁），需 semanticIndex 已注入（生产即 NOE_MEMORY_EMBED 非 hash）。阈值故意偏高保守。
      semantic: {
        enabled: dedupe?.semantic?.enabled ?? (env.NOE_MEMORY_DEDUP_SEMANTIC === '1'),
        threshold: dedupe?.semantic?.threshold ?? (Number(env.NOE_MEMORY_DEDUP_SEMANTIC_THRESHOLD) || 0.82),
        scanLimit: dedupe?.semantic?.scanLimit ?? 8,
      },
    };
    this.conflictPolicy = {
      enabled: conflictPolicy?.enabled ?? (env.NOE_MEMORY_CONFLICT_POLICY === '1'),
      scanLimit: conflictPolicy?.scanLimit ?? 25,
    };
    // Fisher-Rao 召回重排（NOE_MEMORY_FISHER_RANK=1 默认 OFF）：开启且 semanticIndex.searchVectors 可用时，
    // recallFused 的「向量路名次」改用信息几何度量（嵌入带方差/不确定度）替代 cosine 名次，再喂 RRF。
    // 关闭时 recallFused 行为与旧逐字一致；可注入覆盖便于测试（fisherRank.env / fisherRank.enabled）。
    const frEnv = (fisherRank && fisherRank.env) || env;
    this.fisherRank = {
      enabled: fisherRank?.enabled ?? (frEnv.NOE_MEMORY_FISHER_RANK === '1'),
      scale: Number(fisherRank?.scale) > 0 ? Number(fisherRank.scale) : 1,
    };
    this._fisherReranker = makeFisherRaoReranker({ scale: this.fisherRank.scale });
    // salience 软加权融合（NOE_MEMORY_SALIENCE_FUSION=1 默认 OFF）：开启时 recallFused 的最终排序在
    // 「RRF 名次 × 时间衰减」分上再乘一个 salience 1-5→1.0-1.4 的温和因子（复用 weightedFusion 的
    // salienceBoostFactor 单一真源），抬升身份级/重要记忆。【软加权，绝不压过相关性】：因子乘在 RRF 分上，
    // RRF 分已编码两路名次——双路命中靠前的相关记忆基分远高于单路命中的不相关记忆，即便后者 salience=5
    // (×1.4) 也不足以反超明显更相关的结果（见 recall benchmark 测试的边界用例）。关闭时因子恒为 1，
    // 最终排序与旧逐字一致（乘 1 不改值）；可注入覆盖便于测试（salienceFusion.env / salienceFusion.enabled）。
    const sfEnv = (salienceFusion && salienceFusion.env) || env;
    this.salienceFusion = {
      enabled: salienceFusion?.enabled ?? (sfEnv.NOE_MEMORY_SALIENCE_FUSION === '1'),
    };
  }

  db() {
    return this.storage.getDb();
  }

  ftsAvailable() {
    // 审计 §3.3 P0-2：FTS 表存在性进程内不变，按 db 实例缓存探测结果，
    // 消除 recall 热路径每次两条 sqlite 探测查询（切库时 this.db() 实例变化自动失效重探）。
    const db = this.db();
    if (this._ftsDb === db && this._ftsAvail !== undefined) return this._ftsAvail;
    let avail = false;
    try {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'noe_memory_fts'").get();
      if (row) {
        db.prepare("SELECT rowid FROM noe_memory_fts WHERE noe_memory_fts MATCH ? LIMIT 1").all('"__probe__"');
        avail = true;
      }
    } catch {
      avail = false;
    }
    this._ftsDb = db;
    this._ftsAvail = avail;
    return avail;
  }

  write(input = {}) {
    const body = safeMemoryString(input.body ?? input.text ?? input.content, MAX_TEXT);
    if (!body) throw new Error('memory body required');
    const now = nowMs();
    let id = safeMemoryString(input.id, 160) || `mem-${randomUUID()}`;
    const projectId = normalizeProject(input.projectId ?? input.project_id ?? input.project);
    const scope = safeMemoryString(input.scope || 'project', 80) || 'project';
    const title = safeMemoryString(input.title || body.split(/\s+/).slice(0, 12).join(' '), 500);
    const sourceType = safeMemoryString(input.sourceType ?? input.source_type ?? 'manual', 80) || 'manual';
    const sourceId = safeMemoryString(input.sourceId ?? input.source_id, 240) || null;
    const tags = normalizeTags(input.tags);
    const confidence = normalizeConfidence(input.confidence);
    const ttlMs = nullableNumber(input.ttlMs ?? input.ttl_ms);
    const explicitExpiresAt = nullableNumber(input.expiresAt ?? input.expires_at);
    const expiresAt = explicitExpiresAt ?? (ttlMs && ttlMs > 0 ? now + ttlMs : null);
    const salience = clampSalience(input.salience, 3);
    const validFrom = nullableNumber(input.validFrom ?? input.valid_from) ?? now;
    const validTo = nullableNumber(input.validTo ?? input.valid_to);
    const sourceEpisodeId = safeMemoryString(input.sourceEpisodeId ?? input.source_episode_id, 240) || null;
    let supersededIds = [];
    let conflictTrace = null;
    if (this.conflictPolicy?.enabled && !safeString(input.id, 160) && scope === 'fact') {
      try {
        const candidates = this.#recentForDedup({ projectId, scope, limit: this.conflictPolicy.scanLimit });
        for (const candidate of candidates) {
          const decision = decideMemoryConflict({
            oldFact: candidate,
            newFact: { body, sourceType, confidence, salience },
            now,
          });
          if (decision.action === 'ignore') return this.get(candidate.id, { includeHidden: true });
          if (decision.action === 'merge' && candidate.id) {
            id = candidate.id;
            conflictTrace = { at: now, action: decision.action, reason: decision.reason, sourceIds: [candidate.id] };
            break;
          }
          if (decision.action === 'supersede' && candidate.id) {
            supersededIds.push(candidate.id);
            conflictTrace = { at: now, action: decision.action, reason: decision.reason, slot: decision.slot || '', sourceIds: [...supersededIds] };
          }
        }
      } catch (e) {
        this.logger?.warn?.('[noe-memory] 冲突策略失败，按普通写入处理:', e?.message || e);
        supersededIds = [];
        conflictTrace = null;
      }
    }
    // 去重/冲突合并（借鉴 mem0，确定性零 LLM）：仅对"未显式指定 id 的新写入"生效——
    // 显式 id 是调用方要精确 upsert（如 vision-latest），不参与模糊合并。命中相似旧记忆则改写其 id +
    // 接续 merge_trace，等于 UPDATE 而非堆新；保守优先：模糊/高 salience 一律走 ADD。
    let mergedFrom = null;
    if (this.dedupe?.enabled && !safeString(input.id, 160)) {
      try {
        // 候选取"同 project+scope 的近期记忆"——不走 FTS 查询匹配（长句/带标点的 phrase 常召回空，
        // 之前实测候选数 0 导致没合并）；相似度比对在 decideMemoryWrite 里用字符 bigram 做。
        const candidates = this.#recentForDedup({ projectId, scope, limit: this.dedupe.scanLimit });
        const decision = decideMemoryWrite({ body, scope, salience: input.salience }, candidates, { threshold: this.dedupe.threshold, protectSalience: this.dedupe.protectSalience });
        // P3-3 实体守卫：高文本相似但带不同编号/版本/频率（如 440Hz vs 880Hz、x-1 vs x-10）→ 不同实体，禁合，回落 ADD。
        if (decision.action === 'update' && decision.target?.id && !shouldBlockEntityMerge(body, decision.target.body).block) {
          id = decision.target.id;
          mergedFrom = { at: now, similarity: Math.round(decision.similarity * 1000) / 1000, prevBody: String(decision.target.body || '').slice(0, 200) };
        }
      } catch (e) { this.logger?.warn?.('[noe-memory] 去重判定失败，按新增处理:', e?.message || e); }
    }
    const mergeTraceInput = input.mergeTrace ?? input.merge_trace;
    let mergeTraceArr = sanitizeTraceArray(mergeTraceInput);
    // 合并命中：接续被替换记忆的既有 merge_trace + 追加本次合并痕迹（可审计"这条记忆替换过哪些旧说法"）
    if (mergedFrom) {
      const prev = this.get(id, { includeHidden: true });
      const prevTrace = Array.isArray(prev?.mergeTrace) ? prev.mergeTrace : [];
      mergeTraceArr = [...prevTrace, mergedFrom].slice(-100);
    }
    if (conflictTrace) mergeTraceArr = [...mergeTraceArr, conflictTrace].slice(-100);
    const mergeTrace = JSON.stringify(mergeTraceArr);

    this.db().prepare(`
      INSERT INTO noe_memory(
        id, project_id, scope, title, body, source_type, source_id, tags,
        hidden, hit_count, created_at, updated_at, confidence, ttl_ms, expires_at, merge_trace, salience,
        valid_from, valid_to, source_episode_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        scope = excluded.scope,
        title = excluded.title,
        body = excluded.body,
        source_type = excluded.source_type,
        source_id = excluded.source_id,
        tags = excluded.tags,
        confidence = excluded.confidence,
        ttl_ms = excluded.ttl_ms,
        expires_at = excluded.expires_at,
        merge_trace = excluded.merge_trace,
        salience = excluded.salience,
        valid_from = excluded.valid_from,
        valid_to = excluded.valid_to,
        source_episode_id = excluded.source_episode_id,
        hidden = 0,
        hidden_reason = NULL,
        updated_at = excluded.updated_at
    `).run(id, projectId, scope, title, body, sourceType, sourceId, tags, now, now, confidence, ttlMs, expiresAt, mergeTrace, salience, validFrom, validTo, sourceEpisodeId);
    if (supersededIds.length) {
      const stmt = this.db().prepare(`
        UPDATE noe_memory SET hidden = 1, hidden_reason = ?, valid_to = ?, updated_at = ?
        WHERE id = ? AND project_id = ? AND hidden = 0
      `);
      for (const supersededId of [...new Set(supersededIds)].filter((x) => x !== id)) {
        stmt.run(`superseded_by:${id}`, now, now, supersededId, projectId);
        try { this.semanticIndex?.remove?.(supersededId); } catch { /* 向量清理失败不阻断 */ }
      }
    }
    // 语义索引（波次6 接线）：异步嵌入入库，不阻塞写路径；失败只警告（FTS 主路不受影响）
    if (this.semanticIndex?.upsert) {
      Promise.resolve(this.semanticIndex.upsert({ refId: id, text: `${title}\n${body}` }))
        .catch((e) => this.logger?.warn?.('[noe-memory] 语义索引写入失败:', e?.message || e));
    }
    // 语义冲突合并（方向三）：写后异步 sweep，不阻塞写路径；只对"未显式 id 且字符路没合并"的新写入跑
    //（显式 id=精确 upsert 不参与；字符路已合并=本次就是 UPDATE，保守不再扩大动作面）。失败只警告。
    if (this.dedupe?.semantic?.enabled && this.semanticIndex?.search && !safeString(input.id, 160) && !mergedFrom) {
      Promise.resolve(this.semanticConflictSweep({ id, body, projectId, scope }))
        .catch((e) => this.logger?.warn?.('[noe-memory] 语义冲突 sweep 失败:', e?.message || e));
    }
    return this.get(id, { includeHidden: true });
  }

  /**
   * 语义冲突 sweep（方向三）：向量索引召回与新写入语义同位的旧记忆，decideSemanticConflict 双指标
   * 确定性判矛盾（"美式→拿铁"换关键词类），命中走 merge()——旧条 hidden=merged_into:<新id>（unhide 可逆）
   * + 新条记 merge_trace + 清旧向量防隐藏条继续被语义召回。
   * hash provider（精度近零，仅测试/兜底档）直接拒跑，防垃圾相似分误合并真记忆。
   * @returns {Promise<{swept: boolean, merged: string[], reason?: string}>}
   */
  async semanticConflictSweep({ id, body, projectId, scope }) {
    const cfg = this.dedupe?.semantic || {};
    if (!cfg.enabled || !this.semanticIndex?.search) return { swept: false, merged: [], reason: 'disabled' };
    if ((this.semanticIndex.provider || '') === 'hash') return { swept: false, merged: [], reason: 'hash_provider' };
    const hits = await this.semanticIndex.search(String(body || ''), { limit: Math.max(1, Math.min(20, cfg.scanLimit || 8)) });
    const merged = [];
    for (const hit of (Array.isArray(hits) ? hits : [])) {
      if (!hit?.refId || hit.refId === id) continue;
      const old = this.get(hit.refId);                       // 默认口径已排除 hidden/不存在
      if (!old || old.projectId !== projectId) continue;     // 向量索引是全库的，必须重过 project 过滤
      const decision = decideSemanticConflict(
        { body, scope },
        { id: old.id, body: old.body, scope: old.scope, salience: old.salience },
        { vecScore: Number(hit.score) || 0, semanticThreshold: cfg.threshold, charThreshold: this.dedupe.threshold, protectSalience: this.dedupe.protectSalience },
      );
      // P3-3 实体守卫：语义相似但编号/版本/频率不同 → 不同实体，不并入（防把 v1.2/v1.3、440/880Hz 这类合掉）。
      if (decision.conflict && !shouldBlockEntityMerge(body, old.body).block) merged.push(old.id);
    }
    if (merged.length) {
      this.merge({ targetId: id, sourceIds: merged, projectId, reason: 'semantic_conflict' });
      for (const oldId of merged) { try { this.semanticIndex.remove?.(oldId); } catch { /* 向量清理失败不阻断 */ } }
      this.logger?.info?.('[noe-memory] 语义冲突合并:', merged.join(','), '→', id);
    }
    return { swept: true, merged };
  }

  // 去重候选：同 project+scope 未隐藏未过期的近期记忆（按 updated_at DESC），不依赖 FTS 查询词。
  #recentForDedup({ projectId, scope, limit = 25 }) {
    const rows = this.db().prepare(`
      SELECT id, body, scope, salience, source_type, confidence, valid_from, valid_to, source_episode_id FROM noe_memory
      WHERE project_id = ? AND scope = ? AND hidden = 0
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY updated_at DESC LIMIT ?
    `).all(projectId, scope, nowMs(), Math.max(1, Math.min(100, limit)));
    return rows.map((r) => ({
      id: r.id,
      body: r.body || '',
      scope: r.scope,
      salience: clampSalience(r.salience),
      sourceType: r.source_type || 'manual',
      confidence: normalizeConfidence(r.confidence),
      validFrom: r.valid_from ?? null,
      validTo: r.valid_to ?? null,
      sourceEpisodeId: r.source_episode_id || null,
    }));
  }

  get(id, { includeHidden = false } = {}) {
    const memoryId = safeString(id, 160);
    if (!memoryId) return null;
    const row = this.db().prepare(`
      SELECT * FROM noe_memory
      WHERE id = ? ${includeHidden ? '' : 'AND hidden = 0'}
    `).get(memoryId);
    return row ? rowToMemory(row) : null;
  }

  // 审计 §3.3 P1③：批量取多条（一次 WHERE id IN），供 recallFused 补取避免逐条 get 的小 N+1。
  getMany(ids, { includeHidden = false } = {}) {
    const clean = [...new Set((Array.isArray(ids) ? ids : []).map((i) => safeString(i, 160)).filter(Boolean))];
    if (!clean.length) return new Map();
    const placeholders = clean.map(() => '?').join(',');
    const rows = this.db().prepare(`
      SELECT * FROM noe_memory
      WHERE id IN (${placeholders}) ${includeHidden ? '' : 'AND hidden = 0'}
    `).all(...clean);
    return new Map(rows.map((row) => { const m = rowToMemory(row); return [m.id, m]; }));
  }

  hide(id, { projectId, reason = 'manual_hide' } = {}) {
    const memoryId = safeString(id, 160);
    if (!memoryId) return false;
    const now = nowMs();
    const whereProject = projectId ? 'AND project_id = ?' : '';
    const args = projectId
      ? [safeString(reason, 500) || 'manual_hide', now, memoryId, normalizeProject(projectId)]
      : [safeString(reason, 500) || 'manual_hide', now, memoryId];
    const result = this.db().prepare(`
      UPDATE noe_memory SET hidden = 1, hidden_reason = ?, updated_at = ?
      WHERE id = ? ${whereProject}
    `).run(...args);
    // 审计 §3.3 P0-1：软删同时移除向量索引项，否则 hidden 记忆仍被向量路召回再被过滤丢弃，
    // 静默缩减 recallFused 实际返回数（runGc 经此方法落地，一并受益）。fire-and-forget 不阻断。
    if (result.changes > 0 && this.semanticIndex?.remove) {
      Promise.resolve(this.semanticIndex.remove(memoryId))
        .catch((e) => this.logger?.warn?.('[noe-memory] hide 向量清理失败:', e?.message || e));
    }
    return result.changes > 0;
  }

  /**
   * 记忆库 GC：遍历未隐藏记忆 → NoeMemoryCurator.planMemoryGc 分桶 → 对 gcCandidates 执行 hide。
   * 默认 dry-run（apply=false 只返回计划，不改库）；apply=true 才真 hide（保守可逆，hidden 可 unhide 恢复）。
   * salience>=5 身份级与 pinned 永不入候选（铁律由 curator 把关）。治 MEMORY.md 膨胀，可由梦境循环定时调。
   * projectId：null/undefined=全库；其余值统一 normalize（SELECT 与 hide 用同一 pid，语义一致，杜绝 falsy 跨项目歧义）。
   * maxScan：单轮最多扫描的最旧记忆数（防海量库一次性 SELECT * OOM）；超限时 truncated=true 且 log 警告（不静默截断）。
   * @param {object} [opts] { apply=false, projectId, reason='gc_curator', maxScan=10000, staleMs/lowSalience/maxHitCount/minConfidence（透传 curator） }
   * @returns {{plan:object, applied:boolean, hidden:string[], truncated:boolean}}
   */
  runGc({ apply = false, projectId, reason = 'gc_curator', maxScan = 10000, ...curatorOpts } = {}) {
    // 强健：maxScan 是 OOM 防护参数（见上方 JSDoc），但若调用方传非法值会反向击穿防护——
    // 负数 → SQLite 负 LIMIT = 无限扫描（全量 SELECT *，OOM 防护失效）；NaN → 'datatype mismatch' 抛错崩溃；
    // 小数/超大值 → slice 错切 / LIMIT 仍可 OOM。统一钳到 [1, 1_000_000] 整数（复用 normalizeLimit 同款 idiom）。
    // 合法正整数（默认 10000 及任何现实取值）逐字不变；仅非法输入获安全兜底。
    const scanN = Number(maxScan);
    maxScan = Number.isFinite(scanN) ? Math.max(1, Math.min(1_000_000, Math.trunc(scanN))) : 10000;
    const pid = projectId == null ? null : normalizeProject(projectId);   // null=全库；其余归一化（B1/B2 一致性）
    const where = pid ? 'WHERE hidden = 0 AND project_id = ?' : 'WHERE hidden = 0';
    const args = pid ? [pid] : [];
    // 审计 §3.3 P0-8：窄列 SELECT——GC 分类（NoeMemoryCurator）只看 salience/hit_count/expires_at/
    // updated_at/confidence/hidden 等元数据，绝不需要 body（最大 10 万字）。满载 10001 条全量反序列化
    // body 可达 ~1GB；只取所需列把内存压到极小（rowToMemory 对缺失的 body/title/tags 有 ''/[] 兜底）。
    // ORDER BY updated_at ASC：优先扫最旧的（最该被 GC 的）；LIMIT maxScan+1 探测是否超限
    const GC_COLS = 'id, scope, salience, hit_count, created_at, updated_at, confidence, ttl_ms, expires_at, hidden';
    const rows = this.db().prepare(`SELECT ${GC_COLS} FROM noe_memory ${where} ORDER BY updated_at ASC LIMIT ?`).all(...args, maxScan + 1);
    const truncated = rows.length > maxScan;
    const entries = (truncated ? rows.slice(0, maxScan) : rows).map(rowToMemory);
    const plan = planMemoryGc(entries, { now: nowMs(), ...curatorOpts });
    const hidden = [];
    if (apply) {
      for (const id of plan.gcCandidates) {
        if (this.hide(id, { projectId: pid, reason })) hidden.push(id);   // 用同一 pid，避免跨项目误 hide
      }
    }
    if (truncated) this.logger?.warn?.(`[runGc] 记忆数超过 maxScan=${maxScan}，本轮只扫描最旧 ${maxScan} 条，余下留待下轮`);
    return { plan, applied: !!apply, hidden, truncated };
  }

  merge({ targetId, sourceIds = [], projectId, reason = 'manual_merge' } = {}) {
    const targetMemoryId = safeString(targetId, 160);
    if (!targetMemoryId) throw new Error('targetId required');
    const target = this.get(targetMemoryId, { includeHidden: true });
    if (!target) throw new Error('target memory missing');
    const normalizedProject = projectId ? normalizeProject(projectId) : target.projectId;
    const sources = [...new Set(sourceIds.map((id) => safeString(id, 160)).filter(Boolean))]
      .filter((id) => id !== targetMemoryId)
      .slice(0, 100);
    const sourceMemories = sources
      .map((id) => this.get(id, { includeHidden: true }))
      .filter(Boolean);
    const crossScope = sourceMemories.find((item) => item.scope !== target.scope);
    if (crossScope) throw new Error(`memory merge scope mismatch: ${crossScope.scope}->${target.scope}`);
    const now = nowMs();
    const nextTrace = [
      ...(target.mergeTrace || []),
      { at: now, reason: safeString(reason, 500) || 'manual_merge', sourceIds: sources },
    ].slice(-100);
    this.db().transaction(() => {
      this.db().prepare('UPDATE noe_memory SET merge_trace = ?, updated_at = ? WHERE id = ? AND project_id = ?')
        .run(JSON.stringify(nextTrace), now, targetMemoryId, normalizedProject);
      const stmt = this.db().prepare(`
        UPDATE noe_memory SET hidden = 1, hidden_reason = ?, updated_at = ?
        WHERE id = ? AND project_id = ?
      `);
      for (const sourceId of sources) {
        stmt.run(`merged_into:${targetMemoryId}`, now, sourceId, normalizedProject);
      }
    })();
    // P4 根因A 修复：merge 把 source 记忆 hidden 后必须同步删其向量——否则向量索引残留指向 hidden 行的孤儿
    //   （实测 ~465 条/43% embedding 是 merged_into 孤儿，占向量 top-K 一半名额，把真 insight 卡挤出召回池 → insight 通道仅 1.9% 可用）。
    //   对照 supersede(#superseded)/consolidate/hide 都删了向量，唯独 merge 漏。事务提交后清（向量清理失败不阻断已落库 merge）。
    for (const sourceId of sources) {
      try { this.semanticIndex?.remove?.(sourceId); }
      catch (e) { this.logger?.warn?.('[noe-memory] merge 向量清理失败(留孤儿,可经 backfill/孤儿清理重清):', sourceId, e?.message || e); }
    }
    return this.get(targetMemoryId, { includeHidden: true });
  }

  bumpHit(id) {
    const memoryId = safeString(id, 160);
    if (!memoryId) return null;
    const now = nowMs();
    this.db().prepare(`
      UPDATE noe_memory
      SET hit_count = hit_count + 1, last_hit_at = ?, updated_at = ?
      WHERE id = ? AND hidden = 0
    `).run(now, now, memoryId);
    return this.get(memoryId);
  }

  /**
   * 审计 §3.3 P0-3：批量记命中——recall 默认对召回的每条 bumpHit，旧实现 N 条 = N 次 UPDATE + N 次
   * 丢弃返回值的 get()（limit 默认 20 即 40 次查询）。改单条 `UPDATE ... WHERE id IN(...)`，无返回值需求。
   * @returns {number} 实际更新行数
   */
  bumpHitMany(ids = []) {
    const clean = [...new Set((Array.isArray(ids) ? ids : []).map((i) => safeString(i, 160)).filter(Boolean))];
    if (!clean.length) return 0;
    const now = nowMs();
    const placeholders = clean.map(() => '?').join(',');
    const r = this.db().prepare(`
      UPDATE noe_memory
      SET hit_count = hit_count + 1, last_hit_at = ?, updated_at = ?
      WHERE id IN (${placeholders}) AND hidden = 0
    `).run(now, now, ...clean);
    return r.changes;
  }

  /** 调整某条记忆的 salience(1-5)。梦境整合用。返回更新后记忆或 null。 */
  setSalience(id, salience, { reason = 'consolidate' } = {}) {
    void reason; // 预留审计标记字段（接口兼容保留；2026-06-10 终检清 lint）
    const memoryId = safeString(id, 160);
    if (!memoryId) return null;
    const s = clampSalience(salience);
    const now = nowMs();
    const r = this.db().prepare('UPDATE noe_memory SET salience = ?, updated_at = ? WHERE id = ?').run(s, now, memoryId);
    return r.changes > 0 ? this.get(memoryId, { includeHidden: true }) : null;
  }

  /** 降级:salience 降到 newSalience(默认当前-1,不低于 1)。身份保护由整合器把关,这里只执行。 */
  downgrade(id, newSalience) {
    const cur = this.get(id, { includeHidden: true });
    if (!cur) return null;
    const target = Number.isFinite(Number(newSalience)) ? clampSalience(newSalience) : Math.max(1, cur.salience - 1);
    return this.setSalience(id, target, { reason: 'downgrade' });
  }

  /** 恢复软删除的记忆(hidden→0)。补 BaiLongma/旧实现都缺的"一键复活"入口。 */
  unhide(id, { projectId } = {}) {
    const memoryId = safeString(id, 160);
    if (!memoryId) return false;
    const now = nowMs();
    const whereProject = projectId ? 'AND project_id = ?' : '';
    const args = projectId ? [now, memoryId, normalizeProject(projectId)] : [now, memoryId];
    const r = this.db().prepare(`
      UPDATE noe_memory SET hidden = 0, hidden_reason = NULL, updated_at = ?
      WHERE id = ? ${whereProject}
    `).run(...args);
    // 审计 §3.3 P0-1：复活记忆时重建向量索引（hide 已移除），否则 unhide 后向量路永久缺失到下次 write。
    if (r.changes > 0 && this.semanticIndex?.upsert) {
      const mem = this.get(memoryId, { includeHidden: true });
      if (mem) {
        Promise.resolve(this.semanticIndex.upsert({ refId: memoryId, text: `${mem.title}\n${mem.body}` }))
          .catch((e) => this.logger?.warn?.('[noe-memory] unhide 向量重建失败:', e?.message || e));
      }
    }
    return r.changes > 0;
  }

  recall(input = {}) {
    const query = safeString(input.q ?? input.query, 512);
    const projectId = normalizeProject(input.projectId ?? input.project_id ?? input.project);
    const scope = safeString(input.scope, 80);
    const limit = normalizeLimit(input.limit);
    const includeHidden = Boolean(input.includeHidden);
    const includeExpired = Boolean(input.includeExpired);
    // trigram FTS 需查询 ≥3 字符才能生成索引词；更短的查询（如 'M1'、中文 2 字词）在
    // trigram 下 MATCH 恒返回空且不报错（不会触发 #recallFts 的 catch fallback），
    // 故短查询直接走 LIKE，保证 1-2 字符词也能正确召回。
    const ftsEligible = query.length >= 3 && input.useFts !== false && this.ftsAvailable();
    // 审计 §3.3 P0-7：order='cold' 让整合/GC 调用方按 updated_at ASC 取最旧记忆（默认 'hot' 不变）
    const order = input.order === 'cold' ? 'cold' : 'hot';
    // P4 codex#10：原生 source_type 过滤（默认不传=逐字零回归）。治「深思/对话召回先按 limit 取再事后过滤 lesson →
    //   前 N 个不是 lesson 则 learning_lesson/skill_distill 永远进不来」，让召回时直接圈定 sourceType。
    const sourceTypes = Array.isArray(input.sourceTypes) ? input.sourceTypes.map((s) => safeString(s, 80)).filter(Boolean).slice(0, 12) : null;
    // P1.1 P5 双时态：asOf(ms 时间戳) → 只召回该时刻有效的记忆(valid_from<=asOf<valid_to)。默认不传=零回归。
    const asOf = nullableNumber(input.asOf ?? input.as_of);
    const rows = query && ftsEligible
      ? this.#recallFts({ query, projectId, scope, sourceTypes, limit, includeHidden, includeExpired, asOf })
      : this.#recallLike({ query, projectId, scope, sourceTypes, limit, includeHidden, includeExpired, order, asOf });
    const items = rows.map(rowToMemory);
    if (input.bumpHits !== false) {
      this.bumpHitMany(items.map((item) => item.id));
    }
    return items;
  }

  /**
   * 双路融合召回（波次6 接线）：FTS/LIKE × 向量语义并跑，NoeFusionRanker RRF 融合排序。
   * semanticIndex 未注入 / 无查询 / 向量无结果时与 recall() 结果一致。
   * 仅此方法 async（recall 保持同步，兼容既有调用方）。
   */
  async recallFused(input = {}) {
    const base = this.recall({ ...input, bumpHits: false });
    const query = safeString(input.q ?? input.query, 512);
    if (!this.semanticIndex?.search || !query) return this.#finishRecall(base, input);
    // 根因B 修复(三方互评 M3+Claude+codex 一致):向量搜索是全库的,用通道小 limit(insight/user=2)搜全库→小众 scope 的卡
    //   几乎必被数量占优的 fact/project 挤出 top-N,scope 过滤后净贡献≈0(insight 通道实测仅 1.9% 可用)。over-fetch 更大候选池,
    //   融合+scope 过滤后再截到 limit。flag NOE_MEMORY_VECTOR_POOL 默认 OFF;OFF 时 vectorPool=limit 逐字零回归。
    const vectorPool = process.env.NOE_MEMORY_VECTOR_POOL === '1'
      ? Math.max(normalizeLimit(input.limit), 50)
      : normalizeLimit(input.limit);
    let vecHits = [];
    // Fisher-Rao 重排路径（NOE_MEMORY_FISHER_RANK=1 且 semanticIndex 支持 searchVectors）：
    // 用「带方差/不确定度的嵌入」按信息几何度量重排向量名次，替代 cosine 名次喂 RRF。任何失败优雅退回旧 search 路径。
    if (this.fisherRank?.enabled && typeof this.semanticIndex.searchVectors === 'function') {
      try {
        const res = await this.semanticIndex.searchVectors(query, { limit: vectorPool });
        const hits = res && Array.isArray(res.hits) ? res.hits : [];
        if (res && res.queryVector && hits.length) {
          vecHits = this._fisherReranker(res.queryVector, hits, res.queryVariance);
        }
      } catch (e) {
        this.logger?.warn?.('[noe-memory] Fisher-Rao 重排失败，退回 cosine 召回:', e?.message || e);
        vecHits = [];
      }
    }
    if (!vecHits.length) {
      try {
        vecHits = await this.semanticIndex.search(query, { limit: vectorPool });
      } catch (e) {
        this.logger?.warn?.('[noe-memory] 语义召回失败，退回 FTS:', e?.message || e);
      }
    }
    if (!Array.isArray(vecHits) || !vecHits.length) return this.#finishRecall(base, input);
    const fused = reciprocalRankFusion([
      vecHits.map((v) => ({ id: v.refId })),
      base.map((m) => ({ id: m.id })),
    ]);
    const projectId = normalizeProject(input.projectId ?? input.project_id ?? input.project);
    const scope = safeString(input.scope, 80);
    // P4 codex#10：向量路补取的记忆也按 source_type 过滤（base 路已在 recall 内过滤）。默认不传=零回归。
    //   slice(0,12) 与 recall 入口对齐(M3+Claude 互评:防内部直调 recallFused 传超长 type 列表撑大 includes 集)。
    const vecSourceTypes = Array.isArray(input.sourceTypes) ? input.sourceTypes.map((s) => safeString(s, 80)).filter(Boolean).slice(0, 12) : null;
    const limit = normalizeLimit(input.limit);
    const byId = new Map(base.map((m) => [m.id, m]));
    // 审计 §3.3 P1③：先批量补取 fused 中不在 base 的 id（一次 WHERE id IN），避免逐条 get 的小 N+1
    const missingIds = fused.filter((f) => !byId.has(f.id)).map((f) => f.id);
    const fetched = missingIds.length ? this.getMany(missingIds, { includeHidden: Boolean(input.includeHidden) }) : null;
    // 叠时间激活维度（借鉴 OpenMemory 双相衰减：检索即强化，召回更像回忆）。
    // env NOE_MEMORY_DYNAMIC_DECAY 默认 OFF → makeActivationScorer 返回恒等因子 ()=>1，乘上去零回归。
    const activationOf = makeActivationScorer({ now: Date.now, floor: 0.1 });
    // salience 软加权（NOE_MEMORY_SALIENCE_FUSION，默认 OFF）：OFF → salFactor 恒为 ()=>1，乘上去零回归。
    // ON → 复用 salienceBoostFactor（1.0-1.4 温和加成），抬升高 salience 记忆但因乘在 RRF 分上不压过相关性。
    const salienceEnabled = !!this.salienceFusion?.enabled;
    const ranked = fused
      .map((f) => {
        const m = byId.get(f.id) || fetched?.get(f.id) || {};
        const act = activationOf({ lastHitAt: m.lastHitAt ?? m.last_hit_at, updatedAt: m.updatedAt ?? m.updated_at, createdAt: m.createdAt ?? m.created_at });
        const salFactor = salienceEnabled ? salienceBoostFactor(m.salience) : 1;
        return { ...f, score: f.score * act * salFactor };
      })
      .sort((a, b) => b.score - a.score);
    const items = [];
    for (const f of ranked) {
      if (items.length >= limit) break;
      let m = byId.get(f.id);
      if (!m) {
        // 向量索引是全库的：补取的记忆必须重过 project/scope/过期过滤，防跨项目/过期/隐藏泄漏
        const got = fetched?.get(f.id);
        if (!got) continue;
        if (got.projectId !== projectId) continue;
        if (scope && got.scope !== scope) continue;
        if (vecSourceTypes?.length && !vecSourceTypes.includes(got.sourceType)) continue;
        if (!input.includeExpired && got.expired) continue;
        m = got;
      }
      items.push(m);
    }
    return this.#finishRecall(items, input);
  }

  #finishRecall(items, input = {}) {
    if (input.bumpHits !== false) {
      this.bumpHitMany(items.map((item) => item.id));
    }
    return items;
  }

  #recallFts({ query, projectId, scope, sourceTypes, limit, includeHidden, includeExpired, asOf = null }) {
    const where = ['m.project_id = ?'];
    const args = [ftsPhrase(query), projectId];
    if (!includeHidden) where.push('m.hidden = 0');
    if (!includeExpired) {
      where.push('(m.expires_at IS NULL OR m.expires_at > ?)');
      args.push(nowMs());
    }
    if (scope) { where.push('m.scope = ?'); args.push(scope); }
    if (sourceTypes?.length) { where.push(`m.source_type IN (${sourceTypes.map(() => '?').join(',')})`); args.push(...sourceTypes); }
    // P1.1 P5 双时态 asOf（m 别名前缀，JOIN）：只召回 asOf 时刻有效的记忆。
    if (asOf != null) { where.push('(m.valid_from IS NULL OR m.valid_from <= ?)', '(m.valid_to IS NULL OR m.valid_to > ?)'); args.push(asOf, asOf); }
    args.push(limit);
    try {
      return this.db().prepare(`
        SELECT m.*, bm25(noe_memory_fts) AS score
        FROM noe_memory_fts
        JOIN noe_memory m ON m.rowid = noe_memory_fts.rowid
        WHERE noe_memory_fts MATCH ? AND ${where.join(' AND ')}
        ORDER BY score ASC, m.updated_at DESC
        LIMIT ?
      `).all(...args);
    } catch (e) {
      this.logger?.warn?.('[noe-memory] FTS recall fallback:', e?.message || e);
      // P4 codex#10(Claude 互评 SERIOUS·反向探针坐实):fallback 必须透传 sourceTypes,否则 FTS 异常时 source_type 过滤失效 → lesson 又被淹没。
      return this.#recallLike({ query, projectId, scope, sourceTypes, limit, includeHidden, includeExpired, asOf });
    }
  }

  #recallLike({ query, projectId, scope, sourceTypes, limit, includeHidden, includeExpired, order = 'hot', asOf = null }) {
    const where = ['project_id = ?'];
    const args = [projectId];
    if (!includeHidden) where.push('hidden = 0');
    if (!includeExpired) {
      where.push('(expires_at IS NULL OR expires_at > ?)');
      args.push(nowMs());
    }
    if (scope) { where.push('scope = ?'); args.push(scope); }
    if (sourceTypes?.length) { where.push(`source_type IN (${sourceTypes.map(() => '?').join(',')})`); args.push(...sourceTypes); }
    if (query) {
      where.push('(title LIKE ? OR body LIKE ? OR tags LIKE ?)');
      const like = `%${query.replace(/[%_]/g, '\\$&')}%`;
      args.push(like, like, like);
    }
    // P1.1 P5 双时态 asOf：只召回 asOf 时刻有效的记忆（valid_from<=asOf<valid_to）。
    if (asOf != null) { where.push('(valid_from IS NULL OR valid_from <= ?)', '(valid_to IS NULL OR valid_to > ?)'); args.push(asOf, asOf); }
    args.push(limit);
    // 'cold'：最旧优先（整合/GC 需要扫到陈旧冷记忆做降级）；默认 'hot'：高命中+最近优先
    // hit 封顶 50 防个别高 hit 记忆(深思历史刷到 1656)垄断 LIKE 候选池(codex/M3 验证实证的承重隐患)；hit<50 排序不变。
    const orderBy = order === 'cold' ? 'updated_at ASC' : 'MIN(hit_count, 50) DESC, updated_at DESC';
    return this.db().prepare(`
      SELECT *, 0 AS score
      FROM noe_memory
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ?
    `).all(...args);
  }

  // 取高显著度记忆（salience DESC）——给 Markdown 镜像导出/整合用（recall 需 query、getMany 需 ids，
  // 都不适合「按重要度批量取」，故补此查询）。纯只读，不 bumpHits。
  topBySalience({ limit = 50, minSalience = 4, projectId = null, includeHidden = false } = {}) {
    const where = ['salience >= ?'];
    const args = [Math.max(1, Math.min(5, Number(minSalience) || 4))];
    if (projectId != null) { where.push('project_id = ?'); args.push(normalizeProject(projectId)); }
    if (!includeHidden) where.push('hidden = 0');
    where.push('(expires_at IS NULL OR expires_at > ?)');
    args.push(nowMs());
    args.push(normalizeLimit(limit));
    return this.db().prepare(`
      SELECT * FROM noe_memory
      WHERE ${where.join(' AND ')}
      ORDER BY salience DESC, updated_at DESC
      LIMIT ?
    `).all(...args).map(rowToMemory);
  }

  stats({ projectId } = {}) {
    const args = [];
    const where = [];
    if (projectId) { where.push('project_id = ?'); args.push(normalizeProject(projectId)); }
    const suffix = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const row = this.db().prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN hidden = 0 THEN 1 ELSE 0 END) AS visible,
        SUM(CASE WHEN hidden = 1 THEN 1 ELSE 0 END) AS hidden,
        SUM(CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 1 ELSE 0 END) AS expired
      FROM noe_memory ${suffix}
    `).get(nowMs(), ...args);
    return {
      total: Number(row?.total) || 0,
      visible: Number(row?.visible) || 0,
      hidden: Number(row?.hidden) || 0,
      expired: Number(row?.expired) || 0,
      fts: this.ftsAvailable(),
    };
  }
}

export const memoryCore = new MemoryCore();
