// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkDbIntegrity, findLatestBackup, autoRecoverDb } from '../../src/storage/NoeDbSelfCheck.js';

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noe-dbselfcheck-')); });
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

function makeGoodDb(p, val = 'hello') {
  const db = new Database(p);
  db.exec('CREATE TABLE events(id INTEGER PRIMARY KEY, ts INTEGER)'); // Neo 核心表，满足 expectTable='events' schema 校验
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t(v) VALUES(?)').run(val);
  db.close();
}
// 合法 SQLite 库但缺 Neo 核心表 events（模拟业务 schema 错的库，应被 schema 校验拒）
function makeSchemaBadDb(p) {
  const db = new Database(p);
  db.exec('CREATE TABLE onlyjunk(id INTEGER PRIMARY KEY)');
  db.close();
}
function writeGarbage(p) {
  // 非 sqlite header → 打开/quick_check 必失败（稳定触发 unopenable 路径）
  fs.writeFileSync(p, Buffer.from('NOT-A-SQLITE-DB '.repeat(200)));
}
function makeBackupDir(dbPath, days) {
  const dir = path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  for (const [day, val] of days) makeGoodDb(path.join(dir, `panel-${day}.db`), val);
  return dir;
}

describe('NoeDbSelfCheck (VCP 吸收 H2)', () => {
  describe('checkDbIntegrity', () => {
    it('健康库 → ok:true', () => {
      const p = path.join(tmp, 'panel.db'); makeGoodDb(p);
      expect(checkDbIntegrity(p).ok).toBe(true);
    });
    it('垃圾文件(非db) → ok:false, unopenable', () => {
      const p = path.join(tmp, 'panel.db'); writeGarbage(p);
      const r = checkDbIntegrity(p);
      expect(r.ok).toBe(false);
      expect(r.unopenable).toBe(true);
    });
    it('不存在的库 → ok:false', () => {
      expect(checkDbIntegrity(path.join(tmp, 'nope.db')).ok).toBe(false);
    });
  });

  describe('findLatestBackup', () => {
    it('多份备份取最新(日期降序)', () => {
      const dbPath = path.join(tmp, 'panel.db');
      makeBackupDir(dbPath, [['2026-06-20', 'old'], ['2026-06-22', 'new'], ['2026-06-21', 'mid']]);
      expect(findLatestBackup(dbPath)).toContain('panel-2026-06-22.db');
    });
    it('无 backups 目录 → null', () => {
      expect(findLatestBackup(path.join(tmp, 'panel.db'))).toBe(null);
    });
    it('空 backups 目录 → null', () => {
      const dbPath = path.join(tmp, 'panel.db');
      fs.mkdirSync(path.join(tmp, 'backups'));
      expect(findLatestBackup(dbPath)).toBe(null);
    });
  });

  describe('autoRecoverDb', () => {
    it('flag 默认 OFF → disabled，不动库', () => {
      const p = path.join(tmp, 'panel.db'); writeGarbage(p);
      expect(autoRecoverDb(p, { env: {} })).toEqual({ recovered: false, reason: 'disabled' });
    });
    it('flag ON 库不存在 → no_db', () => {
      expect(autoRecoverDb(path.join(tmp, 'panel.db'), { env: { NOE_DB_AUTORECOVER: '1' } }).reason).toBe('no_db');
    });
    it('flag ON 空库(size 0) → empty_db，不动', () => {
      const p = path.join(tmp, 'panel.db'); fs.writeFileSync(p, '');
      expect(autoRecoverDb(p, { env: { NOE_DB_AUTORECOVER: '1' } }).reason).toBe('empty_db');
    });
    it('反向 probe：flag ON 健康库 → healthy，内容不变(不误恢复覆盖)', () => {
      const p = path.join(tmp, 'panel.db'); makeGoodDb(p, 'original');
      makeBackupDir(p, [['2026-06-22', 'BACKUP-VAL']]);
      const r = autoRecoverDb(p, { env: { NOE_DB_AUTORECOVER: '1' } });
      expect(r.reason).toBe('healthy');
      expect(r.recovered).toBe(false);
      const db = new Database(p, { readonly: true });
      expect(db.prepare('SELECT v FROM t LIMIT 1').get().v).toBe('original'); // 没被备份覆盖
      db.close();
    });
    it('flag ON 坏库 + 有备份 → 恢复，dbPath 内容来自备份，损坏库隔离可取证', () => {
      const p = path.join(tmp, 'panel.db'); writeGarbage(p);
      makeBackupDir(p, [['2026-06-22', 'BACKUP-VAL']]);
      const logs = [];
      const r = autoRecoverDb(p, { env: { NOE_DB_AUTORECOVER: '1' }, log: (m) => logs.push(m) });
      expect(r.recovered).toBe(true);
      expect(r.reason).toBe('restored');
      expect(checkDbIntegrity(p).ok).toBe(true);
      const db = new Database(p, { readonly: true });
      expect(db.prepare('SELECT v FROM t LIMIT 1').get().v).toBe('BACKUP-VAL'); // 数据来自备份
      db.close();
      expect(fs.existsSync(r.corruptPath)).toBe(true); // 损坏库隔离存在
      expect(logs.some(l => l.includes('恢复'))).toBe(true);
    });
    it('反向 probe：flag ON 坏库 + 无备份 → corrupt_no_backup，损坏库不丢(数据安全)', () => {
      const p = path.join(tmp, 'panel.db'); writeGarbage(p);
      const sizeBefore = fs.statSync(p).size;
      const r = autoRecoverDb(p, { env: { NOE_DB_AUTORECOVER: '1' } });
      expect(r.reason).toBe('corrupt_no_backup');
      expect(r.recovered).toBe(false);
      expect(fs.existsSync(p)).toBe(true);            // 损坏库原地保留
      expect(fs.statSync(p).size).toBe(sizeBefore);   // 没被动
    });
    it('反向 probe：恢复后再跑 → healthy(幂等，不重复恢复)', () => {
      const p = path.join(tmp, 'panel.db'); writeGarbage(p);
      makeBackupDir(p, [['2026-06-22', 'BACKUP-VAL']]);
      autoRecoverDb(p, { env: { NOE_DB_AUTORECOVER: '1' } });
      expect(autoRecoverDb(p, { env: { NOE_DB_AUTORECOVER: '1' } }).reason).toBe('healthy');
    });

    // ↓ H2 审计加固：MAJOR1(坏备份回退) + isolate/restore_failed 数据安全路径 + quick_check 主路径
    it('MAJOR1：最新备份也坏 → 跳过，回退到更早的健康备份恢复', () => {
      const p = path.join(tmp, 'panel.db'); writeGarbage(p);
      const dir = path.join(tmp, 'backups'); fs.mkdirSync(dir, { recursive: true });
      makeGoodDb(path.join(dir, 'panel-2026-06-20.db'), 'OLD-HEALTHY'); // 更早，健康
      writeGarbage(path.join(dir, 'panel-2026-06-22.db'));             // 最新，也坏
      const r = autoRecoverDb(p, { env: { NOE_DB_AUTORECOVER: '1' } });
      expect(r.recovered).toBe(true);
      expect(r.from).toContain('panel-2026-06-20.db');
      const db = new Database(p, { readonly: true });
      expect(db.prepare('SELECT v FROM t LIMIT 1').get().v).toBe('OLD-HEALTHY');
      db.close();
    });
    it('MAJOR1：所有备份都坏 → corrupt_no_backup，损坏库原地不动(绝不被坏备份覆盖)', () => {
      const p = path.join(tmp, 'panel.db'); writeGarbage(p);
      const sizeBefore = fs.statSync(p).size;
      const dir = path.join(tmp, 'backups'); fs.mkdirSync(dir, { recursive: true });
      writeGarbage(path.join(dir, 'panel-2026-06-22.db'));
      writeGarbage(path.join(dir, 'panel-2026-06-21.db'));
      const r = autoRecoverDb(p, { env: { NOE_DB_AUTORECOVER: '1' } });
      expect(r.reason).toBe('corrupt_no_backup');
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.statSync(p).size).toBe(sizeBefore);
    });
    it('isolate_failed：隔离 rename 抛错 → 不动原库', () => {
      const p = path.join(tmp, 'panel.db'); writeGarbage(p);
      const sizeBefore = fs.statSync(p).size;
      makeBackupDir(p, [['2026-06-22', 'BACKUP-VAL']]);
      const fsImpl = { ...fs, renameSync: () => { throw new Error('EACCES'); } };
      const r = autoRecoverDb(p, { env: { NOE_DB_AUTORECOVER: '1' }, fsImpl });
      expect(r.reason).toBe('isolate_failed');
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.statSync(p).size).toBe(sizeBefore);
    });
    it('restore_failed：copy 抛错 → 还原损坏库(绝不留空库)', () => {
      const p = path.join(tmp, 'panel.db'); writeGarbage(p);
      const sizeBefore = fs.statSync(p).size;
      makeBackupDir(p, [['2026-06-22', 'BACKUP-VAL']]);
      const fsImpl = { ...fs, copyFileSync: () => { throw new Error('ENOSPC'); } };
      const r = autoRecoverDb(p, { env: { NOE_DB_AUTORECOVER: '1' }, fsImpl });
      expect(r.reason).toBe('restore_failed');
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.statSync(p).size).toBe(sizeBefore);
    });
    it('restore_failed 双保险：copy 成功但内容坏(恢复后自检失败) → 还原损坏库', () => {
      const p = path.join(tmp, 'panel.db'); writeGarbage(p);
      const sizeBefore = fs.statSync(p).size;
      makeBackupDir(p, [['2026-06-22', 'BACKUP-VAL']]);
      const fsImpl = { ...fs, copyFileSync: (_s, dst) => { fs.writeFileSync(dst, Buffer.from('PARTIAL-GARBAGE'.repeat(50))); } };
      const r = autoRecoverDb(p, { env: { NOE_DB_AUTORECOVER: '1' }, fsImpl });
      expect(r.reason).toBe('restore_failed');
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.statSync(p).size).toBe(sizeBefore);
    });
    it('quick_check 主路径：能打开但 quick_check 返回非 ok 行 → ok:false 且非 unopenable(精确测主检测解析)', () => {
      class FakeCorruptDb { constructor() {} pragma(q) { return q === 'quick_check' ? [{ quick_check: 'malformed *** Page 3 is never used' }] : []; } close() {} }
      const r = checkDbIntegrity('/whatever', { DatabaseCtor: FakeCorruptDb });
      expect(r.ok).toBe(false);
      expect(r.unopenable).toBeFalsy(); // 走了 quick_check 解析路径，而非打开失败旁路
    });
    it('quick_check 主路径恢复：能打开但 quick_check 报坏的库 → autoRecover 从备份恢复', () => {
      const p = path.join(tmp, 'panel.db'); makeGoodDb(p, 'looks-openable');
      makeBackupDir(p, [['2026-06-22', 'BACKUP-VAL']]);
      let calls = 0; // 第1次(主库)报坏，第2次(备份)/第3次(恢复后主库)走真 Database 报 ok
      class FirstBadThenReal {
        constructor(file, opts) { this.real = new Database(file, opts); }
        pragma(q) { if (q === 'quick_check') { calls++; if (calls === 1) return [{ quick_check: 'malformed' }]; } return this.real.pragma(q); }
        prepare(...a) { return this.real.prepare(...a); } // schema 校验需 db.prepare
        close() { try { this.real.close(); } catch {} }
      }
      const r = autoRecoverDb(p, { env: { NOE_DB_AUTORECOVER: '1' }, DatabaseCtor: FirstBadThenReal });
      expect(r.recovered).toBe(true);
      expect(r.reason).toBe('restored');
    });
    it('0 字节库 + 有健康备份 → 恢复(H2 multimodel审#1，防崩溃截断空库失忆)', () => {
      const p = path.join(tmp, 'panel.db'); fs.writeFileSync(p, ''); // 0 字节
      makeBackupDir(p, [['2026-06-22', 'BACKUP-VAL']]);
      const r = autoRecoverDb(p, { env: { NOE_DB_AUTORECOVER: '1' } });
      expect(r.recovered).toBe(true);
      const db = new Database(p, { readonly: true });
      expect(db.prepare('SELECT v FROM t LIMIT 1').get().v).toBe('BACKUP-VAL');
      db.close();
    });
    it('0 字节库 + 无备份 → empty_db(首次启动放行)', () => {
      const p = path.join(tmp, 'panel.db'); fs.writeFileSync(p, '');
      expect(autoRecoverDb(p, { env: { NOE_DB_AUTORECOVER: '1' } }).reason).toBe('empty_db');
    });
    it('schema 校验(H2 multimodel审#2)：备份缺核心表 events → 不被选为健康', () => {
      const p = path.join(tmp, 'panel.db'); writeGarbage(p);
      const dir = path.join(tmp, 'backups'); fs.mkdirSync(dir, { recursive: true });
      makeSchemaBadDb(path.join(dir, 'panel-2026-06-22.db')); // SQLite 合法但无 events 表
      expect(autoRecoverDb(p, { env: { NOE_DB_AUTORECOVER: '1' } }).reason).toBe('corrupt_no_backup');
    });
    it('sidecar 一致恢复(H2 multimodel审#3)：恢复 DB 时一并恢复同日 rooms.json', () => {
      const p = path.join(tmp, 'panel.db'); writeGarbage(p);
      const dir = path.join(tmp, 'backups'); fs.mkdirSync(dir, { recursive: true });
      makeGoodDb(path.join(dir, 'panel-2026-06-22.db'), 'V');
      const filesDir = path.join(dir, 'files-2026-06-22'); fs.mkdirSync(filesDir, { recursive: true });
      fs.writeFileSync(path.join(filesDir, 'rooms.json'), '{"backup":true}');
      const r = autoRecoverDb(p, { env: { NOE_DB_AUTORECOVER: '1' } });
      expect(r.recovered).toBe(true);
      expect(r.sidecar).toContain('rooms.json');
      expect(fs.readFileSync(path.join(tmp, 'rooms.json'), 'utf8')).toBe('{"backup":true}');
    });
  });
});
