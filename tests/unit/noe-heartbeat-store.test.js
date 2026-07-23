import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initSqlite, close, getDb } from '../../src/storage/SqliteStore.js';
import { NoeHeartbeatStore } from '../../src/cognition/NoeHeartbeatStore.js';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noe-hb-'));
  initSqlite(join(dir, 'panel.db'));
});
afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

const T0 = 1_780_000_000_000;

describe('迁移 v7 noe_cognition_core', () => {
  it('五张认知内核表全部建出（心跳台账/游标/情感/期望/目标）', () => {
    const names = getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'noe_%'").all().map((r) => r.name);
    for (const t of ['noe_ticks', 'noe_tick_cursor', 'noe_affect', 'noe_expectations', 'noe_goals']) {
      expect(names).toContain(t);
    }
  });
});

describe('NoeHeartbeatStore（真 SQLite）', () => {
  it('ensureCursor 播种 next_due=now+cadence、幂等、cadence 变化收紧', () => {
    const s = new NoeHeartbeatStore();
    const c1 = s.ensureCursor('meso', 10_000, T0);
    expect(c1.next_due).toBe(T0 + 10_000);
    const c2 = s.ensureCursor('meso', 10_000, T0 + 5000); // 幂等：不动
    expect(c2.next_due).toBe(T0 + 10_000);
    const c3 = s.ensureCursor('meso', 2_000, T0 + 5000); // 变快：收紧
    expect(c3.next_due).toBe(T0 + 7_000);
    expect(c3.cadence_ms).toBe(2_000);
  });

  it('beginTick/finishTick 往返 + intent/outcome JSON 截断（4000 上限）', () => {
    const s = new NoeHeartbeatStore();
    const tid = s.beginTick('meso', T0, T0 + 60_000, { plan: 'x'.repeat(5000) });
    expect(tid).toBeGreaterThan(0);
    s.finishTick(tid, { thought: '我想到了什么' }, T0 + 100);
    const row = s.recentTicks({ limit: 1 })[0];
    expect(row.status).toBe('done');
    expect(row.intent.length).toBeLessThanOrEqual(4000);
    expect(JSON.parse(row.outcome).thought).toBe('我想到了什么');
  });

  it('failTick 记错误并截断', () => {
    const s = new NoeHeartbeatStore();
    const tid = s.beginTick('proactive', T0, T0 + 60_000, null);
    s.failTick(tid, 'e'.repeat(900), T0 + 50);
    const row = s.recentTicks({ limit: 1 })[0];
    expect(row.status).toBe('failed');
    expect(row.error.length).toBeLessThanOrEqual(500);
  });

  it('interruptTick 只打断 running，不覆盖已完成台账', () => {
    const s = new NoeHeartbeatStore();
    const running = s.beginTick('proactive', T0, T0 + 60_000, null);
    const done = s.beginTick('proactive', T0, T0 + 60_000, null);
    s.finishTick(done, { ok: true }, T0 + 10);
    expect(s.interruptTick(running, 'shutdown:SIGTERM', T0 + 20)).toBe(1);
    expect(s.interruptTick(done, 'shutdown:SIGTERM', T0 + 20)).toBe(0);
    const rows = s.recentTicks({ limit: 10 });
    expect(rows.find((r) => r.id === running).status).toBe('interrupted');
    expect(rows.find((r) => r.id === running).error).toBe('shutdown:SIGTERM');
    expect(rows.find((r) => r.id === done).status).toBe('done');
  });

  it('dueCursors 只返回到期游标', () => {
    const s = new NoeHeartbeatStore();
    s.ensureCursor('a', 1_000, T0);
    s.ensureCursor('b', 50_000, T0);
    const due = s.dueCursors(T0 + 2_000);
    expect(due.map((c) => c.kind)).toEqual(['a']);
  });

  it('dueCursors 同到期时按认知阶段排序：meso → innerReflect → maintenance', () => {
    const s = new NoeHeartbeatStore();
    for (const kind of ['maintenance', 'innerReflect', 'proactive', 'meso', 'micro', 'expectation']) {
      s.ensureCursor(kind, 1_000, T0);
    }
    const due = s.dueCursors(T0 + 1_000);
    expect(due.map((c) => c.kind)).toEqual(['meso', 'innerReflect', 'maintenance', 'micro', 'proactive', 'expectation']);
  });

  it('recoverDeadTicks 只判死租约过期的 running', () => {
    const s = new NoeHeartbeatStore();
    const dead = s.beginTick('meso', T0, T0 + 1_000, null);   // 租约 1s
    const alive = s.beginTick('meso', T0, T0 + 600_000, null); // 租约 10min
    const n = s.recoverDeadTicks(T0 + 5_000);
    expect(n).toBe(1);
    const rows = s.recentTicks({ limit: 10 });
    expect(rows.find((r) => r.id === dead).status).toBe('failed');
    expect(rows.find((r) => r.id === dead).error).toContain('lease_expired');
    expect(rows.find((r) => r.id === alive).status).toBe('running');
  });

  it('markCoalesced 留欠账痕', () => {
    const s = new NoeHeartbeatStore();
    s.markCoalesced('proactive', 7, T0);
    const row = s.recentTicks({ limit: 1 })[0];
    expect(row.status).toBe('coalesced');
    expect(JSON.parse(row.intent).missed).toBe(7);
  });

  it('bootLagMs：取游标最大滞后，无滞后为 0', () => {
    const s = new NoeHeartbeatStore();
    expect(s.bootLagMs(T0)).toBe(0);
    s.ensureCursor('meso', 1_000, T0); // next_due = T0+1000，未来 → 0
    expect(s.bootLagMs(T0)).toBe(0);
    expect(s.bootLagMs(T0 + 3_601_000)).toBe(3_600_000); // 滞后 1 小时
  });

  it('recentTicks 倒序 + limit 钳制；stats 分组统计', () => {
    const s = new NoeHeartbeatStore();
    for (let i = 0; i < 5; i++) { const tid = s.beginTick('meso', T0 + i, T0 + i + 60_000, null); s.finishTick(tid, null, T0 + i + 10); }
    const tid = s.beginTick('meso', T0 + 9, T0 + 9 + 60_000, null);
    s.failTick(tid, 'x', T0 + 10);
    const rows = s.recentTicks({ limit: 3 });
    expect(rows.length).toBe(3);
    expect(rows[0].id).toBeGreaterThan(rows[1].id);
    const st = s.stats();
    expect(st.done).toBe(5);
    expect(st.failed).toBe(1);
  });
});
