// NoeDbBackup — panel.db 自动快照备份（强健②，2026-06-10）。
//
// 痛点：~/.noe-panel/panel.db 是 Noe 的记忆/审计/预算全部家当（11MB+），此前零备份——
//   库文件一坏 = Noe 失忆。json 配置早有 .bak-latest 机制，唯独最值钱的 db 裸奔。
// 方案：better-sqlite3 原生 db.backup()（在线一致快照，WAL 下安全、不锁写）；
//   按「日」粒度落 backups/panel-YYYY-MM-DD.db，同日重复跑覆盖为最新；轮转只保留最近 keep 份。
// 恢复：停 panel → cp 备份文件回 ~/.noe-panel/panel.db → 启动。
// 注入式（db/dir/now 可注入）可单测；server 启动延迟 + 每 24h 各跑一次，NOE_DB_BACKUP=0 可关。

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { getDb } from './SqliteStore.js';

// 隔离修复（点火验证暴露）：备份目录跟 PANEL_DB_PATH 走，否则隔离端口(PANEL_DB_PATH=/tmp/...)的备份会写进
//   生产 ~/.noe-panel/backups 污染生产备份目录并轮转删生产老备份。默认仍 ~/.noe-panel（生产路径不变，零回归）。
const PANEL_DIR = dirname(process.env.PANEL_DB_PATH || join(homedir(), '.noe-panel', 'panel.db'));
const DEFAULT_DIR = join(PANEL_DIR, 'backups');
const NAME_RE = /^panel-(\d{4}-\d{2}-\d{2})\.db$/;
const FILES_DIR_RE = /^files-(\d{4}-\d{2}-\d{2})$/;
// 关键状态文件白名单（panel.db 之外的"第二家当"）：对话历史/人物库/身份/配置/license。
// 都是小件（合计 <1MB），跟库一起进每日快照。
// license.txt：2026-06-10 被单测误删时备份里没有它、无从恢复——2026-06-11 收编进白名单。
const KEY_FILES = ['rooms.json', 'rooms-archive.json', 'people-knowledge.json', 'owner-identity.json', 'owner-gate.json', 'chat-profiles.json', 'identity-model-settings.json', 'mcp-servers.json', 'data.json', 'license.txt'];

function dayStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 列出现有备份（按日期降序）。 */
export function listBackups({ dir = DEFAULT_DIR } = {}) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => NAME_RE.test(f))
    .sort()
    .reverse()
    .map((file) => {
      const full = join(dir, file);
      let sizeBytes = 0;
      try { sizeBytes = statSync(full).size; } catch { /* 列表容错 */ }
      return { file, path: full, sizeBytes, day: NAME_RE.exec(file)[1] };
    });
}

/**
 * 做一次在线快照备份并轮转。
 * @param {object} [opts] { db=getDb(), dir, keep=7, now=()=>new Date() }
 * @returns {Promise<{ok:true, path:string, sizeBytes:number, pruned:string[]}>}
 */
export async function backupPanelDb({ db = null, dir = DEFAULT_DIR, keep = 7, now = () => new Date(), stateDir = null } = {}) {
  const database = db || getDb();
  if (typeof database.backup !== 'function') throw new Error('db.backup 不可用（需要 better-sqlite3 连接）');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const day = dayStamp(now());
  const dest = join(dir, `panel-${day}.db`);
  await database.backup(dest);   // 在线一致快照：WAL 内容一并 checkpoint 进单文件
  const sizeBytes = statSync(dest).size;
  // 关键状态文件全家桶（rooms.json 对话历史等）→ backups/files-YYYY-MM-DD/，与库同轮转
  const filesDir = join(dir, `files-${day}`);
  const copiedFiles = [];
  try {
    mkdirSync(filesDir, { recursive: true, mode: 0o700 });
    const base = stateDir || PANEL_DIR;
    for (const name of KEY_FILES) {
      const src = join(base, name);
      if (!existsSync(src)) continue;
      try { copyFileSync(src, join(filesDir, name)); copiedFiles.push(name); } catch { /* 单文件失败不阻断 */ }
    }
  } catch { /* 全家桶失败不阻断库备份主体 */ }
  // 轮转：库文件与 files- 目录按【统一 day 集合】保留最近 keep 天（审计 §3.3 P1①）——
  // 否则某天只有一侧（如库备份失败只剩 files-）时，两者各自数 keep 份会保留不同的天，
  // 恢复时出现「有库无 files」或反之。先取两侧 day 并集的最近 keep 天，再删两侧不在该集合的。
  const pruned = [];
  const all = listBackups({ dir });
  let fileDirs = [];
  try { fileDirs = readdirSync(dir).filter((f) => FILES_DIR_RE.test(f)); } catch { /* 备份目录被外部删除/竞争丢失：files- 轮转跳过，不阻断本次备份整体返回 */ }
  const fileDirDay = (d) => FILES_DIR_RE.exec(d)?.[1] || null;
  const keepDays = new Set(
    [...new Set([...all.map((b) => b.day), ...fileDirs.map(fileDirDay)].filter(Boolean))]
      .sort().reverse()
      .slice(0, Math.max(1, keep)),
  );
  for (const b of all) {
    if (keepDays.has(b.day)) continue;
    try { rmSync(b.path); pruned.push(b.file); } catch { /* 删失败下轮再试 */ }
  }
  for (const d of fileDirs) {
    if (keepDays.has(fileDirDay(d))) continue;
    try { rmSync(join(dir, d), { recursive: true }); pruned.push(d); } catch { /* 同上 */ }
  }
  return { ok: true, path: dest, sizeBytes, copiedFiles, filesDir, pruned };
}
