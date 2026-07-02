// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initSqlite, getDb, close, pruneAuditTables } from '../../../src/storage/SqliteStore.js';

const DAY = 86400000;
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'noe-prune-')); initSqlite(join(dir, 'panel.db')); });
afterEach(() => { try { close(); } catch { /* ignore */ } if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('pruneAuditTables（SQLite-2 审计大表保留期）', () => {
  it('删 noe_ticks 旧行、留新行（COALESCE(finished_at,started_at,due_at)）', () => {
    const db = getDb();
    const now = Date.now();
    const ins = db.prepare('INSERT INTO noe_ticks (kind, due_at, started_at, finished_at) VALUES (?,?,?,?)');
    ins.run('meso', now - 40 * DAY, now - 40 * DAY, now - 40 * DAY); // 40 天前 → 删
    ins.run('meso', now - 1 * DAY, now - 1 * DAY, now - 1 * DAY); // 1 天前 → 留
    const r = pruneAuditTables({ tickRetentionDays: 30, agentRunRetentionDays: 90, now });
    expect(r.ticks).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM noe_ticks').get().n).toBe(1);
  });

  it('删 agent_runs 已完成旧行 + ON DELETE CASCADE 自动删 agent_messages/agent_tool_results', () => {
    const db = getDb();
    const now = Date.now();
    db.prepare('INSERT INTO agent_runs (id, status, created_at, updated_at, finished_at) VALUES (?,?,?,?,?)').run('run-old', 'done', now - 100 * DAY, now - 100 * DAY, now - 100 * DAY);
    db.prepare('INSERT INTO agent_runs (id, status, created_at, updated_at, finished_at) VALUES (?,?,?,?,?)').run('run-new', 'done', now - 1 * DAY, now - 1 * DAY, now - 1 * DAY);
    db.prepare('INSERT INTO agent_messages (id, run_id, created_at) VALUES (?,?,?)').run('m1', 'run-old', now - 100 * DAY);
    db.prepare('INSERT INTO agent_tool_results (id, run_id, tool_name, created_at) VALUES (?,?,?,?)').run('t1', 'run-old', 'shell', now - 100 * DAY);
    const r = pruneAuditTables({ tickRetentionDays: 30, agentRunRetentionDays: 90, now });
    expect(r.runs).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM agent_runs').get().n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM agent_messages').get().n).toBe(0); // CASCADE 删
    expect(db.prepare('SELECT COUNT(*) n FROM agent_tool_results').get().n).toBe(0); // CASCADE 删
  });

  it('codex 加固：活跃 run（finished_at=null，旧 created_at 仍 running）绝不删', () => {
    const db = getDb();
    const now = Date.now();
    db.prepare('INSERT INTO agent_runs (id, status, created_at, updated_at, finished_at) VALUES (?,?,?,?,?)').run('run-active', 'running', now - 100 * DAY, now - 1 * DAY, null);
    const r = pruneAuditTables({ tickRetentionDays: 30, agentRunRetentionDays: 90, now });
    expect(r.runs).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM agent_runs').get().n).toBe(1); // 活跃保留，不误删
  });

  it('codex 加固：旧库无 ON DELETE CASCADE → 跳过 agent_runs（防 orphan），agentRunsSkipped=true', () => {
    const db = getDb();
    const now = Date.now();
    db.exec('DROP TABLE agent_messages');
    db.exec('CREATE TABLE agent_messages (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, created_at INTEGER NOT NULL)'); // 模拟旧库：无 CASCADE 外键
    db.prepare('INSERT INTO agent_runs (id, status, created_at, updated_at, finished_at) VALUES (?,?,?,?,?)').run('run-old', 'done', now - 100 * DAY, now - 100 * DAY, now - 100 * DAY);
    const r = pruneAuditTables({ tickRetentionDays: 30, agentRunRetentionDays: 90, now });
    expect(r.agentRunsSkipped).toBe(true);
    expect(r.runs).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM agent_runs').get().n).toBe(1); // 跳过，未删
  });

  it('<7 天护栏：retentionDays<7 → throw（防误清空审计）', () => {
    expect(() => pruneAuditTables({ tickRetentionDays: 3 })).toThrow();
    expect(() => pruneAuditTables({ agentRunRetentionDays: 1 })).toThrow();
    expect(() => pruneAuditTables({ tickRetentionDays: 30, agentRunRetentionDays: 5 })).toThrow();
  });

  it('反向 probe：minDays 自身 <7 被钳到 7（防绕过护栏）', () => {
    expect(() => pruneAuditTables({ tickRetentionDays: 3, minDays: 1 })).toThrow();
  });

  it('反向 probe：空表/全新行 → 返回 0，不误删', () => {
    const now = Date.now();
    getDb().prepare('INSERT INTO noe_ticks (kind, due_at) VALUES (?,?)').run('meso', now - 1 * DAY);
    expect(pruneAuditTables({ now })).toMatchObject({ ticks: 0, runs: 0 });
    expect(getDb().prepare('SELECT COUNT(*) n FROM noe_ticks').get().n).toBe(1);
  });
});
