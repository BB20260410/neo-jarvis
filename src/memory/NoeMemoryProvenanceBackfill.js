// @ts-check

import { ensureNoeMemoryV2Schema } from '../storage/NoeMemoryV2Schema.js';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';
import { STRONG_MEMORY_SOURCE_LINK_TYPES } from './NoeMemoryGovernanceRepair.js';

const CJK_RE = /[\p{Script=Han}]/u;
// 因果方向容差：情景写入与事实抽取之间允许的反向时钟偏差（情景可比记忆"晚"这么多仍算来源候选）。
// 取 1 小时——足够吸收同一会话内"先记下事实摘要、稍后才落情景行"的写入次序抖动，又不至于把真正后发生的事误判。
const PROVENANCE_TIME_TOLERANCE_MS = 3_600_000;

function clean(value, max = 4000) {
  return redactSensitiveText(String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max));
}

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || ''); } catch { return fallback; }
}

function tokenize(value) {
  const text = clean(value, 4000).toLowerCase();
  const out = new Set();
  for (const word of text.match(/[a-z0-9_:-]{3,}/g) || []) out.add(word);
  const chars = [...text].filter((ch) => CJK_RE.test(ch));
  for (let i = 0; i < chars.length - 1; i += 1) out.add(`${chars[i]}${chars[i + 1]}`);
  return out;
}

function overlapScore(a, b) {
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  if (overlap < 4) return 0;
  const coverage = overlap / Math.max(1, Math.min(a.size, b.size));
  const jaccard = overlap / Math.max(1, a.size + b.size - overlap);
  return (coverage * 0.8) + (jaccard * 0.2);
}

function episodeText(payload = {}) {
  return clean([
    payload.summary,
    payload.detail,
    payload.meta?.focus?.text,
    payload.meta?.guard?.action,
  ].filter(Boolean).join('\n'), 4000);
}

function strongTypesSql() {
  return STRONG_MEMORY_SOURCE_LINK_TYPES.map(() => '?').join(',');
}

function loadOrphanFacts(db, { projectId, limit }) {
  return db.prepare(`
    SELECT m.id, m.body, m.created_at
    FROM noe_memory m
    WHERE m.project_id = ?
      AND m.hidden = 0
      AND m.scope = 'fact'
      AND (m.source_episode_id IS NULL OR m.source_episode_id = '')
      AND (m.source_id IS NULL OR m.source_id = '')
      AND NOT EXISTS(
        SELECT 1 FROM noe_memory_link l
        WHERE l.memory_id=m.id AND l.link_type IN (${strongTypesSql()}) LIMIT 1
      )
    ORDER BY m.updated_at DESC
    LIMIT ?
  `).all(projectId, ...STRONG_MEMORY_SOURCE_LINK_TYPES, limit);
}

function loadEpisodes(db, { projectId, limit }) {
  const rows = db.prepare(`
    SELECT id, ts, payload
    FROM events
    WHERE kind='noe_episode'
    ORDER BY ts DESC
    LIMIT ?
  `).all(limit);
  return rows
    .map((row) => {
      const payload = parseJson(row.payload, {});
      const pid = clean(payload.projectId || projectId, 240) || projectId;
      if (pid !== projectId) return null;
      const text = episodeText(payload);
      return text ? { id: row.id, ts: Number(row.ts) || 0, tokens: tokenize(text) } : null;
    })
    .filter(Boolean);
}

export function planNoeMemoryProvenanceBackfill({
  db,
  projectId = 'noe',
  memoryLimit = 200,
  episodeLimit = 5000,
  minScore = 0.78,
} = {}) {
  if (!db?.prepare) throw new Error('db required');
  ensureNoeMemoryV2Schema(db);
  const pid = clean(projectId, 240) || 'noe';
  const memories = loadOrphanFacts(db, {
    projectId: pid,
    limit: Math.max(1, Math.min(5000, Number(memoryLimit) || 200)),
  });
  const episodes = loadEpisodes(db, {
    projectId: pid,
    limit: Math.max(1, Math.min(50_000, Number(episodeLimit) || 5000)),
  });
  const matches = [];
  for (const memory of memories) {
    const tokens = tokenize(memory.body);
    const createdAt = Number(memory.created_at) || 0;
    let best = null;
    for (const episode of episodes) {
      const lexical = overlapScore(tokens, episode.tokens);
      if (lexical <= 0) continue;
      // 因果方向过滤：只有发生在记忆创建之前（含小容差吸收写入/抽取的时钟偏差）的情景才可能是来源。
      // 晚于记忆的情景不可能被这条记忆引用，绝不给时间邻近 boost（旧 abs(time) 会把"后发生的事"误配为来源）。
      // lead = created_at - episode.ts（有符号）：>= -容差（情景不晚于记忆超过容差）且 <= 7 天窗口 → 给 boost。
      const lead = createdAt && episode.ts ? createdAt - episode.ts : null;
      // codex post-review 返工：晚于记忆创建(超容差)的未来情景因果上不可能是来源——整条跳过，
      // 不只是不给 boost（原实现高 lexical 的未来情景仍会被选成 best 并越过 minScore 挂成来源）。
      if (lead !== null && lead < -PROVENANCE_TIME_TOLERANCE_MS) continue;
      const timeBoost = lead !== null && lead <= 7 * 86400000 ? 0.05 : 0;
      const score = Math.round(Math.min(1, lexical + timeBoost) * 1000) / 1000;
      if (!best || score > best.score) best = { episodeId: episode.id, score };
    }
    if (best && best.score >= minScore) {
      matches.push({
        memoryId: memory.id,
        sourceEpisodeId: `events:${best.episodeId}`,
        linkType: 'source_episode',
        score: best.score,
        action: 'attach_real_episode_source',
      });
    }
  }
  return {
    ok: true,
    projectId: pid,
    mode: 'dry_run',
    scannedMemories: memories.length,
    scannedEpisodes: episodes.length,
    minScore,
    matchCount: matches.length,
    matches,
    policy: {
      dryRunOnly: true,
      noMemoryBodyOutput: true,
      noSecretOutput: true,
      noStrongSourceFabrication: true,
      unmatchedRemainWeak: true,
    },
  };
}

export function applyNoeMemoryProvenanceBackfill({
  db,
  apply = false,
  now = Date.now,
  ...opts
} = {}) {
  const plan = planNoeMemoryProvenanceBackfill({ db, ...opts });
  if (!apply) return { ...plan, applied: false, inserted: 0, updated: 0 };
  const insert = db.prepare(`
    INSERT OR IGNORE INTO noe_memory_link(memory_id, link_type, link_ref, quote_hash, created_at)
    VALUES (?, 'source_episode', ?, '', ?)
  `);
  const update = db.prepare(`
    UPDATE noe_memory SET source_episode_id = ?, updated_at = ?
    WHERE id = ? AND (source_episode_id IS NULL OR source_episode_id = '')
  `);
  const t = now();
  let inserted = 0;
  let updated = 0;
  db.transaction(() => {
    for (const match of plan.matches) {
      inserted += insert.run(match.memoryId, match.sourceEpisodeId, t).changes || 0;
      updated += update.run(match.sourceEpisodeId, t, match.memoryId).changes || 0;
    }
  })();
  return {
    ...plan,
    mode: 'apply',
    applied: true,
    inserted,
    updated,
    policy: { ...plan.policy, dryRunOnly: false },
  };
}
