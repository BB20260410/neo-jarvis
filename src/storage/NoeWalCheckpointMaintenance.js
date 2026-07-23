// @ts-check
// NoeWalCheckpointMaintenance — WAL 文件定期截断维护。
//
// 问题：长驻进程下 SQLite WAL 单调膨胀——PASSIVE autocheckpoint 把内容刷回主库但「不缩文件」，
//   而连接从不 close（只有 close 时才 TRUNCATE）→ WAL 攒到峰值（实测 1.6GB），占磁盘 +
//   崩溃恢复慢（要 replay 整个 WAL）+ 读略降。
// 方案：心跳定期跑 wal_checkpoint(TRUNCATE)，把已刷入主库的 WAL 截回小尺寸。
//   数据安全：TRUNCATE 先把 WAL 全量刷入主库、确认无 reader 持有（busy=0）后才清零，不丢不重；
//     撞 reader 时只部分 checkpoint、不截断（busy!=0），数据仍安全，下周期重来。
//   fail-safe：撞 reader / 异常 / 无 db 都不抛、不崩心跳。
//   返回值同既有 backupDbOnce 的处理：db.pragma('wal_checkpoint(TRUNCATE)') → [{busy,log,checkpointed}]。

import * as sqliteStore from './SqliteStore.js';

/**
 * 创建 WAL checkpoint 维护器（纯 DI + fail-safe，供心跳周期调用）。
 * @param {object} [deps]
 * @param {() => any} [deps.getDb] 取 better-sqlite3 活连接（默认 sqliteStore.getDb）
 * @param {() => number} [deps.now] 时间源（测试可注入）
 * @returns {{ runOnce: () => { ok: boolean, busy?: number, walFrames?: number|null, checkpointed?: number|null, reason?: string, error?: string, at?: number } }}
 */
export function createWalCheckpointMaintenance({
  getDb = () => sqliteStore.getDb(),
  now = () => Date.now(),
} = {}) {
  function runOnce() {
    let db;
    try { db = getDb(); } catch { return { ok: false, reason: 'no_db' }; }
    if (!db || typeof db.pragma !== 'function') return { ok: false, reason: 'no_db' };
    try {
      const res = db.pragma('wal_checkpoint(TRUNCATE)');
      const row = Array.isArray(res) ? res[0] : res;
      if (!row) return { ok: false, reason: 'no_result', at: now() };
      const busy = Number(row.busy);
      return {
        ok: busy === 0,                          // 0=WAL 全刷入主库并截断成功；!=0=有 reader 持有，这次没截净
        busy,
        walFrames: row.log ?? null,              // WAL 总帧数
        checkpointed: row.checkpointed ?? null,  // 已 checkpoint 帧数
        at: now(),
      };
    } catch (e) {
      return { ok: false, reason: 'checkpoint_failed', error: String((e && e.message) || e).slice(0, 120), at: now() };
    }
  }
  return { runOnce };
}
