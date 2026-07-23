import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite, getDb } from '../../src/storage/SqliteStore.js';

// 防回归（2026-06-10 真事故）：测试以自定义路径 initSqlite(tmp) 后，VectorIndex 等模块内部的
// initSqlite()（无参）曾把单例静默切回默认库 ~/.noe-panel/panel.db，测试数据直接写进用户真实库。
// 修复后语义：无参 = 「确保有库可用」，已有连接一律沿用。

let tmp;

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('initSqlite 无参守卫', () => {
  it('已用自定义路径初始化后，无参调用沿用现连接（不切回默认库）', () => {
    tmp = mkdtempSync(join(tmpdir(), 'noe-init-guard-'));
    const db1 = initSqlite(join(tmp, 'panel.db'));
    db1.prepare("INSERT INTO noe_memory(id, project_id, scope, title, body, source_type, tags, hidden, hit_count, created_at, updated_at, confidence, merge_trace, salience) VALUES ('guard-probe','default','project','t','哨兵行','manual','[]',0,0,1,1,0.5,'[]',3)").run();
    const db2 = initSqlite();           // 无参：必须还是同一个连接
    expect(db2).toBe(db1);
    expect(getDb().prepare("SELECT COUNT(*) n FROM noe_memory WHERE id='guard-probe'").get().n).toBe(1);
  });

  it('显式传不同路径仍按原语义切库', () => {
    tmp = mkdtempSync(join(tmpdir(), 'noe-init-guard-'));
    const dbA = initSqlite(join(tmp, 'a.db'));
    const dbB = initSqlite(join(tmp, 'b.db'));
    expect(dbB).not.toBe(dbA);
  });
});
