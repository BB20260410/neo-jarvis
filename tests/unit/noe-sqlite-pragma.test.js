// @ts-nocheck
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initSqlite, close } from '../../src/storage/SqliteStore.js';

let tmp;
afterEach(() => {
  try { close(); } catch {}
  try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  tmp = null;
});

describe('SqliteStore 连接级性能 PRAGMA (5项目研究 SQLite high)', () => {
  it('initSqlite 设置 busy_timeout/cache_size/temp_store/mmap_size，且既有三项仍在', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noe-pragma-'));
    const db = initSqlite(path.join(tmp, 'panel.db'));
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('cache_size', { simple: true })).toBe(-65536);
    expect(Number(db.pragma('temp_store', { simple: true }))).toBe(2); // 2 = MEMORY
    expect(db.pragma('mmap_size', { simple: true })).toBe(268435456);
    // 既有三项不被覆盖
    expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    expect(Number(db.pragma('foreign_keys', { simple: true }))).toBe(1);
  });
});
