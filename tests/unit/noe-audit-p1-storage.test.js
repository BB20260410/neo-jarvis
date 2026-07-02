// 审计 §3.3 P1 存储层测试：P1② SqliteStore 切库关闭旧连接、P1④ atomicWriteFile tmp 唯一不互覆
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite, getDb } from '../../src/storage/SqliteStore.js';
import { atomicWriteFile } from '../../src/state/atomicJsonFile.js';

afterEach(() => { close(); });

describe('§3.3 P1② SqliteStore 切库关闭旧连接', () => {
  it('切到不同库后旧连接 close，新库可用', () => {
    const d1 = mkdtempSync(join(tmpdir(), 'noe-db1-'));
    const d2 = mkdtempSync(join(tmpdir(), 'noe-db2-'));
    try {
      initSqlite(join(d1, 'a.db'));
      const db1 = getDb();
      expect(db1.open).toBe(true);
      initSqlite(join(d2, 'b.db')); // 显式切到不同库
      const db2 = getDb();
      expect(db2).not.toBe(db1);
      expect(db2.open).toBe(true);
      expect(() => db2.prepare('SELECT 1 AS x').get()).not.toThrow();
      expect(db1.open).toBe(false); // 审计 P1②：旧连接已被 close（WAL checkpoint + 释放 fd）
    } finally {
      rmSync(d1, { recursive: true, force: true });
      rmSync(d2, { recursive: true, force: true });
    }
  });
});

describe('§3.3 P1④ atomicWriteFile tmp 唯一', () => {
  it('正常写内容正确且不残留 tmp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-atomic-'));
    try {
      const file = join(dir, 'data.json');
      atomicWriteFile(file, '{"a":1}');
      expect(readFileSync(file, 'utf8')).toBe('{"a":1}');
      expect(readdirSync(dir).filter((f) => f.includes('.tmp.'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('连续写同文件成功收敛到最后一次，无 tmp 残留', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-atomic2-'));
    try {
      const file = join(dir, 'd.json');
      for (let i = 0; i < 5; i += 1) atomicWriteFile(file, `{"n":${i}}`);
      expect(readFileSync(file, 'utf8')).toBe('{"n":4}');
      expect(readdirSync(dir).filter((f) => f.includes('.tmp.'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
