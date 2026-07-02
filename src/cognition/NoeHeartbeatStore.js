// @ts-check
// NoeHeartbeatStore — 心跳持久层的 SQLite 访问层（noe_ticks 台账 + noe_tick_cursor 节奏游标，迁移 v7）。
// 设计文档《AI自我意识实现方案》§3：每个认知 tick 开跑前写 intent（写前日志）→ 执行 → 落 outcome；
// running 带租约，进程崩溃/卡死后由 recoverDeadTicks 标 failed 留痕（绝不自动重放有副作用的动作，
// 痕迹留给反思与内心透视页）。游标持久化 = 重启续相位不归零（机制五：时间连续性）。
// 注入式：db 可注入（测试用临时库）；默认惰性取全局 getDb()（initSqlite 之后可用）。
import { getDb } from '../storage/SqliteStore.js';

const MAX_JSON = 4000; // intent/outcome 持久化截断上限（防台账膨胀）
const KIND_ORDER_SQL = `
  CASE kind
    WHEN 'meso' THEN 10
    WHEN 'innerReflect' THEN 20
    WHEN 'maintenance' THEN 30
    WHEN 'micro' THEN 40
    WHEN 'proactive' THEN 50
    WHEN 'expectation' THEN 60
    ELSE 100
  END, kind
`;

function packJson(v) {
  if (v == null) return null;
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > MAX_JSON ? s.slice(0, MAX_JSON) : s;
  } catch { return null; }
}

export class NoeHeartbeatStore {
  constructor({ db = null } = {}) { this._db = db; }
  get db() { return this._db || getDb(); }

  /**
   * 游标不存在则播种（next_due = now + cadence：首跑不在启动瞬间扎堆）；
   * 已存在则只同步 cadence 变化（变快立即收紧 next_due，变慢不提前）——env 调周期重启即生效。
   */
  ensureCursor(kind, cadenceMs, now) {
    const row = this.cursor(kind);
    if (!row) {
      this.db.prepare('INSERT INTO noe_tick_cursor(kind, next_due, cadence_ms, updated_at) VALUES (?,?,?,?)')
        .run(kind, now + cadenceMs, cadenceMs, now);
      return this.cursor(kind);
    }
    if (row.cadence_ms !== cadenceMs) {
      const nextDue = Math.min(row.next_due, now + cadenceMs);
      this.db.prepare('UPDATE noe_tick_cursor SET cadence_ms=?, next_due=?, updated_at=? WHERE kind=?')
        .run(cadenceMs, nextDue, now, kind);
      return this.cursor(kind);
    }
    return row;
  }

  cursor(kind) { return this.db.prepare('SELECT * FROM noe_tick_cursor WHERE kind=?').get(kind) || null; }
  allCursors() { return this.db.prepare(`SELECT * FROM noe_tick_cursor ORDER BY ${KIND_ORDER_SQL}`).all(); }
  dueCursors(now) { return this.db.prepare(`SELECT * FROM noe_tick_cursor WHERE next_due <= ? ORDER BY ${KIND_ORDER_SQL}`).all(now); }

  advanceCursor(kind, nextDue, now) {
    this.db.prepare('UPDATE noe_tick_cursor SET next_due=?, updated_at=? WHERE kind=?').run(nextDue, now, kind);
  }

  /**
   * 开跑一个 tick：写前日志（intent）+ 租约。
   * @returns {number} tickId
   */
  beginTick(kind, now, leaseUntil, intent = null) {
    const r = this.db.prepare(
      "INSERT INTO noe_ticks(kind, due_at, started_at, status, lease_until, intent) VALUES (?,?,?,'running',?,?)",
    ).run(kind, now, now, leaseUntil, packJson(intent));
    return Number(r.lastInsertRowid);
  }

  /**
   * 落 outcome 标 done。终态守卫：只允许 running→done（正常收尾）与 done→done（detached 作业
   * 后台完成后回填最终 outcome，设计内特性）。已 failed/interrupted/coalesced 的 tick 不被复活——
   * 迟到的回填（如租约过期被 recoverDeadTicks 标 failed 后后台才完成）不得抹掉死亡/打断留痕。
   * @returns {number} 实际改写行数（0 = 该 tick 已是不可覆盖的终态，回填被拒）
   */
  finishTick(tickId, outcome, now) {
    return this.db.prepare("UPDATE noe_ticks SET status='done', finished_at=?, outcome=? WHERE id=? AND status IN ('running','done')")
      .run(now, packJson(outcome), tickId).changes;
  }

  failTick(tickId, error, now) {
    this.db.prepare("UPDATE noe_ticks SET status='failed', finished_at=?, error=? WHERE id=?")
      .run(now, String(error || 'unknown').slice(0, 500), tickId);
  }

  interruptTick(tickId, reason, now) {
    return this.db.prepare("UPDATE noe_ticks SET status='interrupted', finished_at=?, error=? WHERE id=? AND status='running'")
      .run(now, String(reason || 'heartbeat_interrupted').slice(0, 500), tickId).changes;
  }

  /** 欠账留痕（catchUp='drop' 的 kind 错过 N 个周期：记一行 coalesced，不补跑）。 */
  markCoalesced(kind, missed, now) {
    this.db.prepare("INSERT INTO noe_ticks(kind, due_at, finished_at, status, intent) VALUES (?,?,?,'coalesced',?)")
      .run(kind, now, now, packJson({ missed }));
  }

  /**
   * 崩溃恢复：把租约过期的 running 标 failed（留痕给反思/透视页，不自动重放副作用）。
   * @returns {number} 处理条数
   */
  recoverDeadTicks(now) {
    return this.db.prepare(
      "UPDATE noe_ticks SET status='failed', finished_at=?, error='lease_expired(进程死亡或卡死期间的 tick)' WHERE status='running' AND lease_until < ?",
    ).run(now, now).changes;
  }

  /** 启动滞后量（游标最大滞后 ms，无游标/无滞后=0）——server 用它生成"我断了一会儿"的恢复情景。 */
  bootLagMs(now) {
    const r = this.db.prepare('SELECT MAX(? - next_due) AS lag FROM noe_tick_cursor').get(now);
    const lag = Number(r?.lag);
    return Number.isFinite(lag) && lag > 0 ? lag : 0;
  }

  /** 最近的 tick 台账（内心透视页数据源；kind 可过滤）。 */
  recentTicks({ limit = 50, kind = null } = {}) {
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    return kind
      ? this.db.prepare('SELECT * FROM noe_ticks WHERE kind=? ORDER BY id DESC LIMIT ?').all(kind, lim)
      : this.db.prepare('SELECT * FROM noe_ticks ORDER BY id DESC LIMIT ?').all(lim);
  }

  /** 台账分状态统计（成功率/恢复次数，自主性月报与透视页用）。 */
  stats() {
    return this.db.prepare('SELECT status, COUNT(*) AS n FROM noe_ticks GROUP BY status').all()
      .reduce((acc, r) => { acc[r.status] = r.n; return acc; }, /** @type {Record<string, number>} */({}));
  }
}
