// @ts-check
// NoeGoalCandidateStore — 候选池持久化（sqlite noe_goal_candidates，schema v16）。
//
// 角色：给 NoeCandidatePool 注入 store 依赖（{insert/update/get/list}），把候选对象（camelCase）
//   落到 DB 列（snake_case），并做反向 rowToCandidate 还原。纯存储、零执行权。
//
// 设计：全注入式——constructor({db}) 可注入连接（测试/隔离库），缺省走 getDb() 单例（与
//   NoeSelfEvolutionCycleStore 同模式）。写前裁剪长度；update 走列名白名单（非白名单 key 丢弃，
//   防把任意 key 拼进 SQL 造脏列/注入）。risk 对象单列存 risk_json，供 mind.html 与 P3.2 风险门读。

import { getDb } from './SqliteStore.js';

// 候选对象(camelCase) → DB 列(snake) 白名单。risk 对象单独 → risk_json（见 update 特判）。
const COL_MAP = Object.freeze({
  source: 'source',
  title: 'title',
  why: 'why',
  baseScore: 'base_score',
  score: 'score',
  decision: 'decision',
  reject_reason: 'reject_reason',
  risk_tier: 'risk_tier',
  goal_id: 'goal_id',
  decided_at: 'decided_at',
  overridden_by_owner: 'overridden_by_owner',
});

function clampStr(v, max) {
  if (v === undefined || v === null) return '';
  return String(v).slice(0, max);
}

function safeJson(v) {
  if (v === undefined || v === null) return null;
  try { return JSON.stringify(v); } catch { return null; }
}

function parseJson(v) {
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}

function rowToCandidate(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    title: row.title,
    why: row.why,
    baseScore: row.base_score === null || row.base_score === undefined ? undefined : Number(row.base_score),
    score: Number(row.score) || 0,
    decision: row.decision,
    reject_reason: row.reject_reason || '',
    risk_tier: row.risk_tier || '',
    risk: parseJson(row.risk_json),
    goal_id: row.goal_id || null,
    overridden_by_owner: !!row.overridden_by_owner,
    created_at: Number(row.created_at) || 0,
    decided_at: row.decided_at === null || row.decided_at === undefined ? null : Number(row.decided_at),
  };
}

export class NoeGoalCandidateStore {
  /** @param {{ db?: any }} [opts] 可注入连接（测试/隔离库）；缺省 getDb() 单例。 */
  constructor({ db = null } = {}) {
    this._db = db;
  }

  db() {
    return this._db || getDb();
  }

  /**
   * 候选进池（NoeCandidatePool.submit 产物）。INSERT OR REPLACE：同 id 覆盖（候选 id 唯一，
   * 重复 submit 同 id 视为覆盖而非报错——幂等友好）。created_at 由候选自带（候选池注入 now）。
   */
  insert(c = {}) {
    const db = this.db();
    db.prepare(`
      INSERT OR REPLACE INTO noe_goal_candidates
        (id, created_at, decided_at, source, title, why, base_score, score, decision, reject_reason, risk_tier, risk_json, goal_id, overridden_by_owner)
      VALUES
        (@id, @created_at, @decided_at, @source, @title, @why, @base_score, @score, @decision, @reject_reason, @risk_tier, @risk_json, @goal_id, @overridden_by_owner)
    `).run({
      id: clampStr(c.id, 160),
      created_at: Number(c.created_at) || Date.now(),
      decided_at: c.decided_at === null || c.decided_at === undefined ? null : Number(c.decided_at),
      source: clampStr(c.source || 'unknown', 64),
      title: clampStr(c.title, 500),
      why: clampStr(c.why, 2000),
      base_score: Number.isFinite(Number(c.baseScore)) ? Number(c.baseScore) : null,
      score: Number.isFinite(Number(c.score)) ? Number(c.score) : 0,
      decision: clampStr(c.decision || 'pending', 32),
      reject_reason: clampStr(c.reject_reason, 1000),
      risk_tier: clampStr(c.risk_tier, 16),
      risk_json: safeJson(c.risk),
      goal_id: c.goal_id ? clampStr(c.goal_id, 160) : null,
      overridden_by_owner: c.overridden_by_owner ? 1 : 0,
    });
  }

  /**
   * 局部更新：仅白名单列写入；risk 对象 → risk_json；boolean → 0/1；数值/时间做规整。
   * 非白名单 key 静默丢弃（不拼进 SQL）。无可写列时直接返回（不发空 UPDATE）。
   */
  update(id, patch = {}) {
    const db = this.db();
    const sets = [];
    const params = { id: clampStr(id, 160) };
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'risk') { sets.push('risk_json = @risk_json'); params.risk_json = safeJson(v); continue; }
      if (!Object.hasOwn(COL_MAP, k)) continue; // 非白名单列丢弃（含继承键 __proto__/constructor，防注入脏列名）
      const col = COL_MAP[k];
      sets.push(`${col} = @${col}`);
      if (col === 'overridden_by_owner') params[col] = v ? 1 : 0;
      else if (col === 'base_score') params[col] = Number.isFinite(Number(v)) ? Number(v) : null;
      else if (col === 'score') params[col] = Number.isFinite(Number(v)) ? Number(v) : 0;
      else if (col === 'decided_at') params[col] = v === null || v === undefined ? null : Number(v);
      else if (col === 'goal_id') params[col] = v ? clampStr(v, 160) : null;
      else params[col] = clampStr(v, 2000);
    }
    if (!sets.length) return;
    db.prepare(`UPDATE noe_goal_candidates SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  get(id) {
    const row = this.db().prepare('SELECT * FROM noe_goal_candidates WHERE id = ?').get(clampStr(id, 160));
    return rowToCandidate(row);
  }

  /** 列表：filter.decision 过滤（pending/accepted/rejected）；按 created_at 倒序；limit 默认 100、上限 500。 */
  list(filter = {}) {
    const db = this.db();
    const limit = Math.max(1, Math.min(500, Number(filter.limit) || 100));
    let rows;
    if (filter.decision) {
      rows = db.prepare('SELECT * FROM noe_goal_candidates WHERE decision = ? ORDER BY created_at DESC LIMIT ?').all(clampStr(filter.decision, 32), limit);
    } else {
      rows = db.prepare('SELECT * FROM noe_goal_candidates ORDER BY created_at DESC LIMIT ?').all(limit);
    }
    return rows.map(rowToCandidate);
  }
}
