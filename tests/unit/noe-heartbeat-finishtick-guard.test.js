import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initSqlite, close } from '../../src/storage/SqliteStore.js';
import { NoeHeartbeatStore } from '../../src/cognition/NoeHeartbeatStore.js';

// 回归锁：finishTick 终态守卫——只允许 running→done 与设计内 done→done 回填，
// 绝不把 failed/interrupted/coalesced 复活成 done（否则抹掉死亡/打断留痕）。
// 修复前（无 WHERE status 守卫）这些用例会失败（终态被覆盖成 done）。
let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noe-hb-guard-'));
  initSqlite(join(dir, 'panel.db'));
});
afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

const T0 = 1_780_000_000_000;

describe('NoeHeartbeatStore.finishTick 终态守卫', () => {
  it('租约过期被 recoverDeadTicks 标 failed 后，迟到的 finishTick 不复活、不抹留痕（返回 0）', () => {
    const s = new NoeHeartbeatStore();
    const tid = s.beginTick('expectation', T0, T0 + 1_000, { plan: 'detached' }); // 租约 1s
    expect(s.recoverDeadTicks(T0 + 5_000)).toBe(1); // 判死 → failed
    // 后台作业现在才完成，迟到回填：
    const changed = s.finishTick(tid, { detached: true, reason: 'background_completed' }, T0 + 6_000);
    expect(changed).toBe(0); // 被守卫拒写
    const row = s.recentTicks({ limit: 1 })[0];
    expect(row.status).toBe('failed'); // 死亡留痕保留，未被复活成 done
    expect(row.error).toContain('lease_expired');
  });

  it('failTick 后迟到的 finishTick 不把 failed 改回 done', () => {
    const s = new NoeHeartbeatStore();
    const tid = s.beginTick('selfEvolve', T0, T0 + 60_000, null);
    s.failTick(tid, 'boom', T0 + 10);
    expect(s.finishTick(tid, { ok: true }, T0 + 20)).toBe(0);
    const row = s.recentTicks({ limit: 1 })[0];
    expect(row.status).toBe('failed');
    expect(row.error).toBe('boom');
  });

  it('interrupted 的 tick 也不被 finishTick 复活', () => {
    const s = new NoeHeartbeatStore();
    const tid = s.beginTick('proactive', T0, T0 + 60_000, null);
    expect(s.interruptTick(tid, 'shutdown:SIGTERM', T0 + 10)).toBe(1);
    expect(s.finishTick(tid, { ok: true }, T0 + 20)).toBe(0);
    const row = s.recentTicks({ limit: 1 })[0];
    expect(row.status).toBe('interrupted');
    expect(row.error).toBe('shutdown:SIGTERM');
  });

  it('保留设计内行为：running→done 正常收尾（返回 1）', () => {
    const s = new NoeHeartbeatStore();
    const tid = s.beginTick('meso', T0, T0 + 60_000, null);
    expect(s.finishTick(tid, { thought: 'a' }, T0 + 5)).toBe(1);
    expect(s.recentTicks({ limit: 1 })[0].status).toBe('done');
  });

  it('保留设计内行为：detached 作业 done→done 回填最终 outcome（仍返回 1）', () => {
    const s = new NoeHeartbeatStore();
    const tid = s.beginTick('expectation', T0, T0 + 600_000, null);
    // 同步返回先落 started_background：
    expect(s.finishTick(tid, { detached: true, reason: 'started_background' }, T0 + 5)).toBe(1);
    // 后台完成回填 background_completed：done→done 允许：
    expect(s.finishTick(tid, { detached: true, reason: 'background_completed' }, T0 + 250)).toBe(1);
    const row = s.recentTicks({ limit: 1 })[0];
    expect(row.status).toBe('done');
    expect(JSON.parse(row.outcome).reason).toBe('background_completed');
  });
});
