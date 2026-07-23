// @ts-check
// NoeLearningScheduleStore — 定时学习任务的 SQLite 访问层（noe_learning_jobs，迁移 v15）。
// 照 NoeHeartbeatStore 模式：注入式 db、运行锁(running_at_ms)、崩溃恢复 recoverStuck（清死锁不自动重放副作用）。
// 下次时间/成效自适应由编排层(NoeLearningScheduler)用 NoeLearningSchedule 纯函数算好后传入，本层只持久化。
import { getDb } from '../storage/SqliteStore.js';

export class NoeLearningScheduleStore {
  constructor({ db = null } = {}) { this._db = db; }
  get db() { return this._db || getDb(); }

  /** 立/更新一个学习任务。id 已存在则覆盖 spec（保留 mastery/idle 等运行态，除非显式传 nextRunAtMs）。 */
  addJob({ id, topic, kind = 'every', everyMs = null, anchorMs = null, atMs = null, cronExpr = null, tz = null, priority = 0.5, nextRunAtMs = null } = {}, now = Date.now()) {
    if (!id || !topic) return null;
    if (this.getJob(id)) {
      const sets = ['topic=?', 'kind=?', 'every_ms=?', 'anchor_ms=?', 'at_ms=?', 'cron_expr=?', 'tz=?', 'priority=?'];
      const args = [topic, kind, everyMs, anchorMs, atMs, cronExpr, tz, priority];
      if (nextRunAtMs != null) { sets.push('next_run_at_ms=?'); args.push(nextRunAtMs); }
      sets.push('updated_at=?'); args.push(now, id);
      this.db.prepare(`UPDATE noe_learning_jobs SET ${sets.join(', ')} WHERE id=?`).run(...args);
      return id;
    }
    this.db.prepare(`INSERT INTO noe_learning_jobs(id, topic, kind, every_ms, anchor_ms, at_ms, cron_expr, tz, enabled, priority, next_run_at_ms, consecutive_errors, consecutive_idle, mastery, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,1,?,?,0,0,0,?,?)`)
      .run(id, topic, kind, everyMs, anchorMs, atMs, cronExpr, tz, priority, nextRunAtMs, now, now);
    return id;
  }

  getJob(id) { return this.db.prepare('SELECT * FROM noe_learning_jobs WHERE id=?').get(id) || null; }
  listJobs({ limit = 200 } = {}) { return this.db.prepare('SELECT * FROM noe_learning_jobs ORDER BY priority DESC, created_at ASC LIMIT ?').all(Math.max(1, Math.min(500, Number(limit) || 200))); }
  removeJob(id) { return this.db.prepare('DELETE FROM noe_learning_jobs WHERE id=?').run(id).changes > 0; }
  setEnabled(id, enabled, now = Date.now()) { return this.db.prepare('UPDATE noe_learning_jobs SET enabled=?, updated_at=? WHERE id=?').run(enabled ? 1 : 0, now, id).changes > 0; }

  /** 到点且未锁的任务（enabled=1 且 next<=now 且未 running，priority 高先）。 */
  dueJobs(now = Date.now()) {
    return this.db.prepare('SELECT * FROM noe_learning_jobs WHERE enabled=1 AND next_run_at_ms IS NOT NULL AND next_run_at_ms <= ? AND running_at_ms IS NULL ORDER BY priority DESC, next_run_at_ms ASC').all(now);
  }

  /** 锁 running（CAS：仅当未锁时锁住，返回是否锁成功——防并发重入）。 */
  beginRun(id, now = Date.now()) {
    return this.db.prepare('UPDATE noe_learning_jobs SET running_at_ms=?, updated_at=? WHERE id=? AND running_at_ms IS NULL').run(now, now, id).changes > 0;
  }

  /** 落成功结果 + 下次时间（成效自适应已由编排层算好传入）。next 为 null（at 一次性学完）则 disable。解锁 running。 */
  finishRun(id, { learned = false, mastery = 0, consecutiveIdle = 0, nextRunAtMs = null } = {}, now = Date.now()) {
    this.db.prepare('UPDATE noe_learning_jobs SET running_at_ms=NULL, last_run_at_ms=?, last_status=?, last_error=NULL, consecutive_errors=0, consecutive_idle=?, mastery=?, next_run_at_ms=?, enabled=(CASE WHEN ? IS NULL THEN 0 ELSE enabled END), updated_at=? WHERE id=?')
      .run(now, learned ? 'learned' : 'idle', consecutiveIdle, mastery, nextRunAtMs, nextRunAtMs, now, id);
  }

  /** 落失败 + 退避下次。consecutiveErrors 超上限由编排层 setEnabled(0) auto-disable。解锁 running。 */
  failRun(id, error, nextRunAtMs, consecutiveErrors, now = Date.now()) {
    this.db.prepare('UPDATE noe_learning_jobs SET running_at_ms=NULL, last_run_at_ms=?, last_status=?, last_error=?, consecutive_errors=?, next_run_at_ms=?, updated_at=? WHERE id=?')
      .run(now, 'error', String(error || 'unknown').slice(0, 300), consecutiveErrors, nextRunAtMs, now, id);
  }

  /** 崩溃恢复：running 锁超 stuckMs（默认 2h）的清锁标 stuck_recovered（不自动重放副作用，痕迹留反思）。 */
  recoverStuck(now = Date.now(), stuckMs = 2 * 3600_000) {
    return this.db.prepare("UPDATE noe_learning_jobs SET running_at_ms=NULL, last_status='stuck_recovered', last_error='lease_expired', updated_at=? WHERE running_at_ms IS NOT NULL AND running_at_ms < ?")
      .run(now, now - stuckMs).changes;
  }
}
