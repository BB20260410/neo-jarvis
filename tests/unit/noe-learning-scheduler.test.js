// @ts-check
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';
import { NoeLearningScheduleStore } from '../../src/cognition/NoeLearningScheduleStore.js';
import { createLearningScheduler } from '../../src/loop/NoeLearningScheduler.js';

// P4 定时学习编排：真 sqlite(schema v15) + fake runLearnOnce。验证 OpenClaw 调度复刻 + Neo 成效自适应。
let tmp;
const T0 = 1_000_000_000_000;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'noe-learn-sched-')); initSqlite(join(tmp, 'panel.db')); });
afterEach(() => { close(); rmSync(tmp, { recursive: true, force: true }); });

describe('NoeLearningScheduler — 调度编排', () => {
  it('addLearningJob 入库+算首次 next；tick 只跑到点的', async () => {
    const store = new NoeLearningScheduleStore();
    const calls = [];
    const sched = createLearningScheduler({ store, runLearnOnce: async (job) => { calls.push(job.id); return { learned: true }; }, now: () => T0 });
    sched.addLearningJob({ id: 'j1', topic: '学A', kind: 'every', everyMs: 10000, anchorMs: T0 });
    expect(store.getJob('j1').next_run_at_ms).toBe(T0 + 10000); // 首次=anchor+every
    expect((await sched.tick(T0)).ran).toBe(0);                  // 还没到点
    expect((await sched.tick(T0 + 15000)).ran).toBe(1);          // 到点跑
    expect(calls).toEqual(['j1']);
  });

  it('成效自适应：learned→mastery↑/idle 清零; 没学到→idle↑(退避)', async () => {
    const store = new NoeLearningScheduleStore();
    const schedL = createLearningScheduler({ store, runLearnOnce: async () => ({ learned: true }), now: () => T0 });
    schedL.addLearningJob({ id: 'jl', topic: 'X', kind: 'every', everyMs: 60000, anchorMs: T0 });
    await schedL.tick(T0 + 60001);
    const jl = store.getJob('jl');
    expect(jl.mastery).toBeCloseTo(0.1, 5);
    expect(jl.last_status).toBe('learned');
    expect(jl.consecutive_idle).toBe(0);

    const schedI = createLearningScheduler({ store, runLearnOnce: async () => ({ learned: false }), now: () => T0 });
    schedI.addLearningJob({ id: 'ji', topic: 'Y', kind: 'every', everyMs: 60000, anchorMs: T0 });
    await schedI.tick(T0 + 60001);
    const ji = store.getJob('ji');
    expect(ji.consecutive_idle).toBe(1);
    expect(ji.last_status).toBe('idle');
  });

  it('失败→退避 + 连续失败超 maxAttempts 自动禁用', async () => {
    const store = new NoeLearningScheduleStore();
    let t = T0;
    const sched = createLearningScheduler({ store, runLearnOnce: async () => ({ error: 'boom' }), maxAttempts: 2, now: () => t });
    sched.addLearningJob({ id: 'jf', topic: 'Z', kind: 'every', everyMs: 60000, anchorMs: T0 });
    t = T0 + 60001;
    await sched.tick(t);
    let jf = store.getJob('jf');
    expect(jf.consecutive_errors).toBe(1);
    expect(jf.last_status).toBe('error');
    expect(jf.next_run_at_ms).toBe(t + 30000); // backoff 表首项 30s
    expect(jf.enabled).toBe(1);
    t = jf.next_run_at_ms + 1;
    await sched.tick(t);
    jf = store.getJob('jf');
    expect(jf.consecutive_errors).toBe(2);
    expect(jf.enabled).toBe(0); // 超 maxAttempts auto-disable
  });

  it('at 一次性：学完 disable(next=null)', async () => {
    const store = new NoeLearningScheduleStore();
    const sched = createLearningScheduler({ store, runLearnOnce: async () => ({ learned: true }), now: () => T0 });
    sched.addLearningJob({ id: 'ja', topic: 'once', kind: 'at', atMs: T0 + 5000 });
    expect(store.getJob('ja').next_run_at_ms).toBe(T0 + 5000);
    await sched.tick(T0 + 6000);
    const ja = store.getJob('ja');
    expect(ja.next_run_at_ms).toBe(null); // at 学完无下次
    expect(ja.enabled).toBe(0);           // disable
  });

  it('recoverStuck 清死锁(running 超时标 recovered)', async () => {
    const store = new NoeLearningScheduleStore();
    store.addJob({ id: 'js', topic: 'S', kind: 'every', everyMs: 60000, nextRunAtMs: T0 }, T0);
    store.beginRun('js', T0); // 锁住(模拟跑到一半崩溃)
    expect(store.getJob('js').running_at_ms).toBe(T0);
    const n = store.recoverStuck(T0 + 3 * 3600_000); // 3h 后(超 2h 死锁阈值)
    expect(n).toBe(1);
    expect(store.getJob('js').running_at_ms).toBe(null);
    expect(store.getJob('js').last_status).toBe('stuck_recovered');
  });

  it('beginRun CAS 防并发重入(第二次锁失败)', () => {
    const store = new NoeLearningScheduleStore();
    store.addJob({ id: 'jc', topic: 'C', kind: 'every', everyMs: 60000, nextRunAtMs: T0 }, T0);
    expect(store.beginRun('jc', T0)).toBe(true);   // 第一次锁成功
    expect(store.beginRun('jc', T0 + 1)).toBe(false); // 已锁,第二次失败
  });
});
