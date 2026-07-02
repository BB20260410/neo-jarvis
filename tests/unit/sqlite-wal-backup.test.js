import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { backupDbOnce, close } from '../../src/storage/SqliteStore.js';

// B1.5 bug②：WAL 模式下 backupDbOnce 此前只 copyFileSync(.db)，丢掉 -wal 里尚未 checkpoint 的数据。
// WAL 模式 + synchronous=NORMAL 时，写入先落 -wal，主 .db 文件可能长时间不含这些行；
// 裸 copy .db = 备份缺数据。修复=用 SQLite backup API 或 checkpoint(TRUNCATE)+复制（含 WAL/SHM）。

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'noe-wal-backup-'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('backupDbOnce — WAL 模式数据完整性', () => {
  it('备份包含尚未 checkpoint 进主库的 WAL 数据（不丢行）', () => {
    const dbPath = join(tmp, 'panel.db');
    const live = new Database(dbPath);
    live.pragma('journal_mode = WAL');
    live.pragma('synchronous = NORMAL');
    // 关掉自动 checkpoint，强制让写入滞留在 -wal（复现裸 copy .db 丢数据的场景）
    live.pragma('wal_autocheckpoint = 0');
    live.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
    const insert = live.prepare('INSERT INTO t(v) VALUES (?)');
    for (let i = 0; i < 500; i++) insert.run(`wal-row-${i}`);

    // 前置确认：此刻确实有数据滞留在 WAL（-wal 文件存在且非空），否则这个测试没复现到 bug
    const walPath = `${dbPath}-wal`;
    expect(existsSync(walPath)).toBe(true);
    expect(statSync(walPath).size).toBeGreaterThan(0);

    const bak = `${dbPath}.bak`;
    backupDbOnce(dbPath, live);
    expect(existsSync(bak)).toBe(true);

    // 用全新连接打开备份，必须能读到全部 500 行（裸 copy .db 会读到 0 或少于 500）
    const restored = new Database(bak, { readonly: true });
    const count = restored.prepare('SELECT COUNT(*) AS n FROM t').get().n;
    restored.close();
    live.close();
    expect(count).toBe(500);
  });

  it('备份文件权限 0600，不留 -wal/-shm 残渣（备份是自洽单文件）', () => {
    const dbPath = join(tmp, 'panel2.db');
    const live = new Database(dbPath);
    live.pragma('journal_mode = WAL');
    live.pragma('synchronous = NORMAL');
    live.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    live.prepare('INSERT INTO t DEFAULT VALUES').run();

    const bak = `${dbPath}.bak`;
    backupDbOnce(dbPath, live);
    live.close();
    expect(existsSync(bak)).toBe(true);
    expect(statSync(bak).mode & 0o777).toBe(0o600);
    // 备份产物自洽，不应额外散落 .bak-wal/.bak-shm
    expect(existsSync(`${bak}-wal`)).toBe(false);
    expect(existsSync(`${bak}-shm`)).toBe(false);
  });

  it('源库不存在/为空时安全跳过（不抛、不产生 .bak）', () => {
    const dbPath = join(tmp, 'missing.db');
    expect(() => backupDbOnce(dbPath, null)).not.toThrow();
    expect(existsSync(`${dbPath}.bak`)).toBe(false);
  });
});
