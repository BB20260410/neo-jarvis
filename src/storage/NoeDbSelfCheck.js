// @ts-check
/**
 * NoeDbSelfCheck — panel.db 启动自检 + 坏库自动回滚（VCP 吸收 H2，独立实现，不拷 VCP 源码）。
 *
 * 背景：panel.db 是 Neo 记忆/审计/预算全部家当（11MB+）。NoeDbBackup 已做了在线 WAL 安全备份 +
 *   每日轮转 + 关键文件白名单，但缺「开机发现库坏→自动从备份恢复」闭环——断电/磁盘满导致的
 *   WAL 半写损坏目前会让 Neo 直接失忆且不自知。
 *
 * 机制：在 new Database() 打开主库之前用只读连接跑 SQLite `PRAGMA quick_check`：
 *   ok → 不动；损坏/0字节/打不开 → 隔离损坏库 + 从最新【健康】备份恢复 + 一并恢复同日 sidecar + 恢复后再校验。
 *
 * 数据安全纪律（H2 子代理审 + multimodel 审加固）：
 *   - 默认 OFF（NOE_DB_AUTORECOVER=1 才启用），不设时第一行 return，完全不碰库（零回归）。
 *   - 逐个校验备份完整性，跳过同样损坏的最新备份回退到更早健康份（防坏备份覆盖好库+谎报）。
 *   - 健康判据 = quick_check ok + 关键表存在（expectTable，防 SQLite 合法但业务 schema 错的库被选中）。
 *   - 0 字节库若有健康备份则恢复（崩溃截断成空文件不能当首次启动静默失忆）；无任何备份才当首次启动放行。
 *   - 恢复 DB 时一并恢复同日 sidecar（rooms.json/identity 等），当前 sidecar 隔离到 .pre-recover 可找回，防"旧DB+新sidecar"漂移。
 *   - 恢复后再 quick_check 确认；隔离/恢复失败均还原损坏库，绝不留空库。
 *
 * 自包含：不 import NoeDbBackup（它 import getDb 会与 SqliteStore 成环），自己读 backups/ 目录。
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const BACKUP_NAME_RE = /^panel-(\d{4}-\d{2}-\d{2})\.db$/;
// Neo 核心表（quick_check ok 后再验其一存在，防业务 schema 错的合法库被当健康）。events 是最底层流式表，必存在。
const NEO_CORE_TABLE = 'events';

/**
 * 只读连接跑 quick_check 检测完整性；可选校验关键表存在（schema 健康）。
 * @param {string} dbPath
 * @param {{ DatabaseCtor?: any, expectTable?: string|null }} [deps]
 * @returns {{ ok: boolean, unopenable?: boolean, schemaBad?: boolean, detail: any }}
 */
export function checkDbIntegrity(dbPath, { DatabaseCtor = Database, expectTable = null } = {}) {
  let db = null;
  try {
    db = new DatabaseCtor(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.pragma('quick_check');
    const first = Array.isArray(rows) && rows.length >= 1 ? rows[0] : null;
    const integrityOk = !!first && String(first.quick_check).toLowerCase() === 'ok';
    if (!integrityOk) return { ok: false, detail: rows };
    if (expectTable) {
      const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(expectTable);
      if (!t) return { ok: false, schemaBad: true, detail: `missing core table: ${expectTable}` };
    }
    return { ok: true, detail: rows };
  } catch (e) {
    return { ok: false, unopenable: true, detail: String((e && e.message) || e) };
  } finally {
    try { db && db.close(); } catch { /* 已关闭忽略 */ }
  }
}

/**
 * 列出所有每日备份（backups/panel-YYYY-MM-DD.db），按日期降序（最新在前）。
 * @param {string} dbPath
 * @param {{ fsImpl?: any, pathImpl?: any }} [deps]
 * @returns {string[]}
 */
export function findBackupsDesc(dbPath, { fsImpl = fs, pathImpl = path } = {}) {
  const dir = pathImpl.join(pathImpl.dirname(dbPath), 'backups');
  if (!fsImpl.existsSync(dir)) return [];
  let files;
  try { files = fsImpl.readdirSync(dir); } catch { return []; }
  return files.filter((f) => BACKUP_NAME_RE.test(f)).sort().reverse().map((f) => pathImpl.join(dir, f));
}

/** 向后兼容：最新备份 = findBackupsDesc()[0]。 */
export function findLatestBackup(dbPath, deps = {}) {
  const list = findBackupsDesc(dbPath, deps);
  return list.length ? list[0] : null;
}

/**
 * 恢复同日 sidecar（rooms.json/identity 等），保持与 DB 同一时间点一致（H2 multimodel 审 #3）。
 * 当前 sidecar 先隔离到 .pre-recover-<ts> 可人工找回，再 copy 备份的同日版本。
 */
function restoreSidecar(healthyBackup, dbPath, { fsImpl, pathImpl, now, log }) {
  const dayMatch = pathImpl.basename(healthyBackup).match(BACKUP_NAME_RE);
  if (!dayMatch) return [];
  const filesDir = pathImpl.join(pathImpl.dirname(healthyBackup), `files-${dayMatch[1]}`);
  if (!fsImpl.existsSync(filesDir)) return [];
  const panelDir = pathImpl.dirname(dbPath);
  let names;
  try { names = fsImpl.readdirSync(filesDir); } catch { return []; }
  const restored = [];
  for (const name of names) {
    const src = pathImpl.join(filesDir, name);
    const dst = pathImpl.join(panelDir, name);
    try {
      if (fsImpl.existsSync(dst)) { try { fsImpl.renameSync(dst, `${dst}.pre-recover-${now()}`); } catch { /* 隔离失败仍覆盖 */ } }
      fsImpl.copyFileSync(src, dst);
      restored.push(name);
    } catch (e) { log(`[db-selfcheck] sidecar ${name} 恢复失败: ${(e && e.message) || e}`); }
  }
  return restored;
}

/**
 * 启动自检 + 坏库自动回滚。在 new Database() 之前调用。
 * @param {string} dbPath
 * @param {object} [deps]
 * @returns {{ recovered: boolean, reason: string, from?: string, corruptPath?: string, sidecar?: string[], check?: any }}
 */
export function autoRecoverDb(dbPath, {
  env = process.env,
  DatabaseCtor = Database,
  fsImpl = fs,
  pathImpl = path,
  now = () => Date.now(),
  log = () => {},
  expectTable = NEO_CORE_TABLE,
} = {}) {
  if (env.NOE_DB_AUTORECOVER !== '1') return { recovered: false, reason: 'disabled' };
  if (!dbPath || !fsImpl.existsSync(dbPath)) return { recovered: false, reason: 'no_db' };

  let size = 0;
  try { size = fsImpl.statSync(dbPath).size; } catch { size = 1; }
  const backups = findBackupsDesc(dbPath, { fsImpl, pathImpl });

  // 0 字节库（H2 multimodel 审 #1）：无备份=首次启动放行；有备份=崩溃截断，走恢复防静默失忆。
  if (size <= 0 && !backups.length) return { recovered: false, reason: 'empty_db' };

  let check;
  if (size > 0) {
    check = checkDbIntegrity(dbPath, { DatabaseCtor, expectTable });
    if (check.ok) return { recovered: false, reason: 'healthy' };
  } else {
    check = { ok: false, unopenable: true, detail: '0-byte file with backups present' };
  }

  // 逐个找第一个【健康】备份（quick_check ok + 核心表存在），跳过同样损坏/schema 错的份。
  let healthy = null;
  for (const b of backups) {
    if (checkDbIntegrity(b, { DatabaseCtor, expectTable }).ok) { healthy = b; break; }
  }
  if (!healthy) {
    log(`[db-selfcheck] 库损坏(${check.unopenable ? '无法打开/0字节' : 'quick_check/schema 失败'})但无健康备份(共 ${backups.length} 份均不可用)，保留损坏库待人工处理: ${dbPath}`);
    return { recovered: false, reason: 'corrupt_no_backup', check };
  }

  // 隔离损坏库（rename 不删，连带 -wal/-shm）；主库隔离失败放弃恢复、不动原库。
  const corruptPath = `${dbPath}.corrupt-${now()}`;
  try {
    fsImpl.renameSync(dbPath, corruptPath);
  } catch (e) {
    log(`[db-selfcheck] 隔离损坏库失败，放弃恢复(不动原库): ${(e && e.message) || e}`);
    return { recovered: false, reason: 'isolate_failed', check };
  }
  for (const ext of ['-wal', '-shm']) {
    const p = `${dbPath}${ext}`;
    if (fsImpl.existsSync(p)) {
      try { fsImpl.renameSync(p, `${corruptPath}${ext}`); }
      catch (e2) { log(`[db-selfcheck] 副文件 ${ext} 隔离失败，降级删除: ${(e2 && e2.message) || e2}`); try { fsImpl.unlinkSync(p); } catch { /* WAL salt 不匹配会被忽略 */ } }
    }
  }

  // 从健康备份恢复；copy 失败 → 还原损坏库。
  try {
    fsImpl.copyFileSync(healthy, dbPath);
  } catch (e) {
    try { fsImpl.renameSync(corruptPath, dbPath); } catch { /* 损坏库仍在 corruptPath */ }
    log(`[db-selfcheck] 从备份恢复失败，已尝试还原损坏库: ${(e && e.message) || e}`);
    return { recovered: false, reason: 'restore_failed', check };
  }

  // 恢复后再校验确认（防 copy 不完整/坏备份谎报）。
  const after = checkDbIntegrity(dbPath, { DatabaseCtor, expectTable });
  if (!after.ok) {
    try { fsImpl.unlinkSync(dbPath); } catch { /* 下一步 rename 覆盖 */ }
    try { fsImpl.renameSync(corruptPath, dbPath); } catch { /* 损坏库仍在 corruptPath */ }
    log(`[db-selfcheck] 恢复后自检仍失败，已还原损坏库: ${dbPath}`);
    return { recovered: false, reason: 'restore_failed', check };
  }

  // DB 恢复成功 → 一并恢复同日 sidecar 保持一致（H2 multimodel 审 #3）。
  const sidecar = restoreSidecar(healthy, dbPath, { fsImpl, pathImpl, now, log });
  log(`[db-selfcheck] 库损坏已隔离至 ${corruptPath}，从备份 ${pathImpl.basename(healthy)} 恢复并通过自检${sidecar.length ? `（同日 sidecar 恢复 ${sidecar.length} 个）` : ''}`);
  return { recovered: true, reason: 'restored', from: healthy, corruptPath, sidecar, check };
}
