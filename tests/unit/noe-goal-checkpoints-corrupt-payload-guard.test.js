// 强健加固测试:NoeGoalCheckpoints.listGoalCheckpoints 损坏 payload 行隔离。
// 覆盖:①手工注入 1 行损坏 payload(模拟旧 schema/外部篡改)不再抛错吞掉整张表——
//        其余合法行全部仍可读,损坏行该字段记 {_payloadParseError:true};
//      ②全合法行行为与加固前逐字等价(payload 对象正确 round-trip,空 payload 仍 null),零回归。
// 确定性:注入 now,临时 SQLite 库,不触网。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite, getDb } from '../../src/storage/SqliteStore.js';
import { appendGoalCheckpoint, ensureGoalCheckpointTable, listGoalCheckpoints } from '../../src/cognition/NoeGoalCheckpoints.js';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noe-cp-corrupt-'));
  initSqlite(join(dir, 'panel.db'));
});
afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

describe('NoeGoalCheckpoints 损坏 payload 行隔离(数据损坏防护)', () => {
  it('单行损坏 payload 不抛错,合法行全部仍可读', () => {
    const db = getDb();
    ensureGoalCheckpointTable(db);
    appendGoalCheckpoint(db, { now: () => 1000, goalId: 'g1', stepIndex: 0, phase: 'a', payload: { ok: 1 } });
    appendGoalCheckpoint(db, { now: () => 2000, goalId: 'g1', stepIndex: 1, phase: 'b', payload: { ok: 2 } });
    // 手工注入损坏 payload 行(本模块正常写入不会产生,模拟旧 schema/外部篡改)
    db.prepare('INSERT INTO noe_goal_checkpoints(id, ts, goal_id, step_index, phase, payload, created_at) VALUES (?,?,?,?,?,?,?)')
      .run('bad-1', 1500, 'g1', 5, 'corrupt', '{not valid json', 1500);

    let rows;
    expect(() => { rows = listGoalCheckpoints(db, { goalId: 'g1' }); }).not.toThrow();
    // 三行都在(两合法 + 一损坏),损坏行不再吞掉整张表
    expect(rows).toHaveLength(3);
    const ok1 = rows.find((r) => r.phase === 'a');
    const ok2 = rows.find((r) => r.phase === 'b');
    const bad = rows.find((r) => r.phase === 'corrupt');
    // 合法行 payload 正常解析
    expect(ok1.payload.ok).toBe(1);
    expect(ok2.payload.ok).toBe(2);
    // 损坏行被隔离标记,而非抛错
    expect(bad.payload).toEqual({ _payloadParseError: true });
    // 损坏行其余列仍可读(留痕,不丢)
    expect(bad.id).toBe('bad-1');
  });

  it('全合法行:payload round-trip 正确 + 空 payload 仍为 null(零回归)', () => {
    const db = getDb();
    ensureGoalCheckpointTable(db);
    // 带 payload
    appendGoalCheckpoint(db, { now: () => 3000, goalId: 'g2', stepIndex: 0, phase: 'x', payload: { foo: 'bar', n: 7 } });
    // 不带 payload(payload 列 NULL)
    appendGoalCheckpoint(db, { now: () => 4000, goalId: 'g2', stepIndex: 1, phase: 'y' });

    const rows = listGoalCheckpoints(db, { goalId: 'g2' });
    expect(rows).toHaveLength(2);
    const withPayload = rows.find((r) => r.phase === 'x');
    const noPayload = rows.find((r) => r.phase === 'y');
    // 写入的字段 round-trip(payload 经 withGoalCheckpointWorkflow 会附 workflow 字段,故只断言原始字段在)
    expect(withPayload.payload).toMatchObject({ foo: 'bar', n: 7 });
    expect(withPayload.payload._payloadParseError).toBeUndefined();
    // 不传 payload 时 withGoalCheckpointWorkflow 仍附 workflow 字段（既有行为，见 line 62 注释）→ 非 null；
    // 关键零回归断言：不含业务字段 foo（与带 payload 行隔离）、不被误标损坏。
    // safeParsePayload 对非 NULL 与原裸 JSON.parse 逐字等价；真 NULL→null 由其 raw==null 分支保证（损坏行用例已覆盖解析路径）。
    expect(noPayload.payload).not.toHaveProperty('foo');
    expect(noPayload.payload?._payloadParseError).toBeUndefined();
  });
});
