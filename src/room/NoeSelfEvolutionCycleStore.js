// @ts-check
// 环2：self-evolution cycle 持久化（sqlite noe_self_evolution_cycles）。
// 全注入式（projectId 可配），落库前 draft 校验（非法不写脏行）；
// stage 由 evaluateNoeSelfEvolutionLoop 求值器算出（反映真实进度）；
// 只有 stage==='complete' 或显式 requireComplete 才跑完整校验（P2-6）。

import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/SqliteStore.js';
import { evaluateNoeSelfEvolutionLoop } from './NoeSelfEvolutionLoop.js';
import {
  validateNoeSelfEvolutionCycleDraft,
  validateNoeSelfEvolutionCycle,
  NOE_SELF_EVOLUTION_CYCLE_SCHEMA_VERSION,
} from './NoeSelfEvolutionCycle.js';

function nowMs() {
  return Date.now();
}

function str(value, max = 1000) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).slice(0, max);
}

function json(value) {
  try { return JSON.stringify(value && typeof value === 'object' ? value : {}); } catch { return '{}'; }
}

function parseJson(value) {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

// stage 由 loop 求值器算出（反映 consensus/implementation/runtime/... 的真实进度）；异常回落 'draft'。
function computeStage(cycle = {}) {
  try {
    const loop = evaluateNoeSelfEvolutionLoop({ ...cycle, dryRun: true });
    return String(loop.stage || 'draft');
  } catch {
    return String(cycle.stage || 'draft');
  }
}

function rowToCycle(row) {
  if (!row) return null;
  const cycle = parseJson(row.cycle_json);
  return {
    ...cycle,
    cycleId: row.cycle_id,
    projectId: row.project_id,
    goalId: row.goal_id || cycle.goalId || '',
    stage: row.stage,
    createdAt: cycle.createdAt || new Date(Number(row.created_at) || nowMs()).toISOString(),
    updatedAt: Number(row.updated_at) || nowMs(),
  };
}

export class NoeSelfEvolutionCycleStore {
  constructor({ projectId = 'noe' } = {}) {
    this.projectId = str(projectId, 160) || 'noe';
  }

  db() {
    return getDb();
  }

  /**
   * 落库（首次 INSERT / 已存在 UPDATE，保留首次 created_at）。
   * 落库前跑 draft 校验，非法不写脏行（返回 {ok:false, errors}）。
   * stage==='complete' 或 opts.requireComplete 时额外跑完整校验（P2-6：只 complete artifact 用完整门槛）。
   * @returns {{ok:boolean, errors:string[], cycle:object|null, stage?:string}}
   */
  upsert(cycleInput = {}, opts = {}) {
    const now = nowMs();
    const cycle = { ...(cycleInput && typeof cycleInput === 'object' && !Array.isArray(cycleInput) ? cycleInput : {}) };
    if (cycle.schemaVersion === undefined) cycle.schemaVersion = NOE_SELF_EVOLUTION_CYCLE_SCHEMA_VERSION;
    if (!str(cycle.cycleId, 160)) cycle.cycleId = `secycle-${randomUUID().slice(0, 12)}`;
    if (!str(cycle.createdAt, 64)) cycle.createdAt = new Date(now).toISOString();

    const draft = validateNoeSelfEvolutionCycleDraft(cycle);
    if (!draft.ok) return { ok: false, errors: draft.errors, cycle: null };

    const stage = computeStage(cycle);
    cycle.stage = stage;

    if (stage === 'complete' || opts.requireComplete === true) {
      const full = validateNoeSelfEvolutionCycle(cycle, {
        root: opts.root,
        requireReferencedFiles: opts.requireReferencedFiles === true,
      });
      if (!full.ok) return { ok: false, errors: full.errors, cycle: null, stage };
    }

    const cycleId = str(cycle.cycleId, 160);
    const projectId = str(cycle.projectId || this.projectId, 160) || this.projectId;
    const goalId = str(cycle.goalId || cycle.goal_id, 240) || '';
    const existing = this.db().prepare('SELECT cycle_id FROM noe_self_evolution_cycles WHERE cycle_id = ?').get(cycleId);
    if (existing) {
      this.db().prepare(`
        UPDATE noe_self_evolution_cycles
        SET project_id = ?, goal_id = ?, stage = ?, cycle_json = ?, updated_at = ?
        WHERE cycle_id = ?
      `).run(projectId, goalId, stage, json(cycle), now, cycleId);
    } else {
      this.db().prepare(`
        INSERT INTO noe_self_evolution_cycles(cycle_id, project_id, goal_id, stage, cycle_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(cycleId, projectId, goalId, stage, json(cycle), now, now);
    }
    return { ok: true, errors: [], cycle: this.getByCycleId(cycleId), stage };
  }

  getByCycleId(cycleId) {
    const id = str(cycleId, 160);
    if (!id) return null;
    return rowToCycle(this.db().prepare('SELECT * FROM noe_self_evolution_cycles WHERE cycle_id = ?').get(id));
  }

  // 取某 goal 最新的一轮 cycle（单 writer：一个 goal 同时只推进一轮）。
  getByGoal(goalId) {
    const id = str(goalId, 240);
    if (!id) return null;
    return rowToCycle(this.db().prepare(`
      SELECT * FROM noe_self_evolution_cycles
      WHERE goal_id = ?
      ORDER BY updated_at DESC, created_at DESC, rowid DESC
      LIMIT 1
    `).get(id));
  }

  // 浅合并 patch（顶层字段覆盖；嵌套子对象由调用方给完整对象）→ stage 重算 → 落库。
  advance(cycleId, patch = {}, opts = {}) {
    const current = this.getByCycleId(cycleId);
    if (!current) return { ok: false, errors: ['cycle_not_found'], cycle: null };
    const merged = { ...current, ...(patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}) };
    merged.cycleId = current.cycleId;
    merged.createdAt = current.createdAt;
    return this.upsert(merged, opts);
  }

  list({ projectId = this.projectId, stage, goalId, limit = 20 } = {}) {
    const where = [];
    const args = [];
    if (projectId) { where.push('project_id = ?'); args.push(str(projectId, 160)); }
    if (stage) { where.push('stage = ?'); args.push(str(stage, 80)); }
    if (goalId) { where.push('goal_id = ?'); args.push(str(goalId, 240)); }
    args.push(Math.max(1, Math.min(100, Number(limit) || 20)));
    const rows = this.db().prepare(`
      SELECT * FROM noe_self_evolution_cycles
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY updated_at DESC, created_at DESC, rowid DESC
      LIMIT ?
    `).all(...args);
    return rows.map(rowToCycle);
  }

  /** P3.1：数 stage='complete' 的 cycle 总数（事实来源，供渐进审查梯度；非候选自报，防 reward hacking 抬档）。 */
  countComplete({ projectId = this.projectId, goalId } = {}) {
    const where = ["stage = 'complete'"];
    const args = [];
    if (projectId) { where.push('project_id = ?'); args.push(str(projectId, 160)); }
    if (goalId) { where.push('goal_id = ?'); args.push(str(goalId, 240)); }
    const row = this.db().prepare(`SELECT COUNT(*) AS n FROM noe_self_evolution_cycles WHERE ${where.join(' AND ')}`).get(...args);
    return Number(row?.n) || 0;
  }
}
