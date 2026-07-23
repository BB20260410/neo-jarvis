// @ts-check
// 共享原子文件读写 helper（2026-06-10 强健工程）
//
// 背景：chat-profiles"改完重启还原"暴露的持久化 bug 家族审计发现，6 个 Store 直接
// writeFileSync 覆盖正式文件（进程写一半被 kill = 文件损坏且无备份无兜底）。本 helper 把
// ChatRoomStore / ChatProfileStore 已实战验证的写法提炼成一处，三个保证：
//   1. 原子写：tmp + rename（同目录 rename 是 POSIX 原子操作，读方永远看不到半截文件）
//   2. 一代备份：覆盖前 copy 到 <file>.bak-latest（误写/损坏可手工捞回上一代）
//   3. 损坏兜底：读到坏 JSON 时先备份到 <file>.corrupted-<ts>.bak 再返 null（证据不灭失）
//
// 注意：mode 默认 0o600（~/.noe-panel 下全是用户私有数据）；目录不存在自动建（0o700）。

import { copyFileSync, chmodSync, existsSync, mkdirSync, renameSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { dirname } from 'path';

// 审计 §3.3 P1④：tmp 名加 pid + 进程内递增序号，避免同一文件的并发写互相覆盖 tmp（半截/ENOENT）
let _tmpSeq = 0;

/**
 * 原子写文本文件：tmp + rename，可选覆盖前备份到 .bak-latest。
 * @param {string} file 目标文件绝对路径
 * @param {string} text 文件内容
 * @param {{ mode?: number, backup?: boolean }} [opts]
 */
export function atomicWriteFile(file, text, { mode = 0o600, backup = true } = {}) {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (backup && existsSync(file)) {
    try { copyFileSync(file, `${file}.bak-latest`); chmodSync(`${file}.bak-latest`, mode); } catch {}
  }
  const tmp = `${file}.tmp.${process.pid}.${(_tmpSeq += 1)}`;
  try {
    writeFileSync(tmp, text, { mode });
    try { chmodSync(tmp, mode); } catch {}
    renameSync(tmp, file);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* 清理失败忽略 */ }
    throw e;
  }
}

/**
 * 原子写 JSON 文件（pretty 2 空格，语义同 atomicWriteFile）。
 * @param {string} file
 * @param {unknown} data
 * @param {{ mode?: number, backup?: boolean }} [opts]
 */
export function atomicWriteJson(file, data, opts = {}) {
  atomicWriteFile(file, JSON.stringify(data, null, 2), opts);
}

/**
 * 读 JSON：文件不存在返 null；解析失败先把损坏文件备份成 .corrupted-<ts>.bak 再返 null。
 * 调用方拿到 null 时保持自己的默认值即可（与各 Store 既有"load 失败保持构造默认"契约一致）。
 * @param {string} file
 * @param {{ label?: string }} [opts] label 用于 warn 日志前缀
 * @returns {any|null}
 */
export function readJsonWithCorruptBackup(file, { label = 'store' } = {}) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch (e) {
    try { copyFileSync(file, `${file}.corrupted-${Date.now()}-${process.pid}.bak`); } catch {}
    console.warn(`[${label}] load failed（损坏文件已备份 .corrupted-*.bak）:`, e?.message || e);
    return null;
  }
}
