// @ts-check
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';
import { NoeLearningScheduleStore } from '../../src/cognition/NoeLearningScheduleStore.js';
import { createLearningScheduler } from '../../src/loop/NoeLearningScheduler.js';
import { pickLearningTitle } from '../../src/loop/NoeLearningSchedule.js';
import { createGoalSystem } from '../../src/cognition/NoeGoalSystem.js';

// P4 集成：真 NoeGoalSystem + 真 Store + 真 Scheduler + server.js 同款 runLearnOnce(轮换 title)。
//   钉死 M3 红队（真机探针）抓出的两条 serious 的修复：
//     serious#1 自锁——固定 title 撞 goalSystem.add 同名去重→cycle1 起永久 idle、只学一次。
//                修复：pickLearningTitle 按 every_ms 分桶轮换角度→持续立新 goal、零 idle 累积。
//     serious#3 反向激励——learned→mastery 喂 cadence 拉长间隔(惩罚成功)。
//                修复：mastery 不喂 cadence，间隔稳定 baseEvery。
// 这是 P4 唯一【真 goalSystem 去重路径】的回归保护（scheduler 单测用 fake runner 不经去重）。
let tmp;
const BUCKET = 3_600_000; // 1h 分桶 = baseEvery
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'noe-learn-int-')); initSqlite(join(tmp, 'panel.db')); });
afterEach(() => { close(); rmSync(tmp, { recursive: true, force: true }); });

// 复刻 server.js 2157-2164 的 runLearnOnce（测试可控 now，行为逐字对齐生产）
function makeServerRunner(goalSystem, nowRef) {
  return async (job) => {
    const title = pickLearningTitle(job.topic, nowRef.now, Math.max(60_000, Number(job.every_ms) || BUCKET));
    const gid = goalSystem.add({ title, source: 'self_learning', why: 'P4 test' });
    return { learned: Boolean(gid) };
  };
}

describe('P4 集成 — 轮换 title 治自锁(真 goalSystem 去重路径)', () => {
  it('serious#1 修复：跨角度桶持续立新 self_learning goal，不退化成永久 idle', async () => {
    const goalSystem = createGoalSystem({});
    const store = new NoeLearningScheduleStore();
    const nowRef = { now: BUCKET * 100 };
    const sched = createLearningScheduler({ store, runLearnOnce: makeServerRunner(goalSystem, nowRef), now: () => nowRef.now });
    sched.addLearningJob({ id: 'seed', topic: 'AI 工具', kind: 'every', everyMs: BUCKET, anchorMs: nowRef.now, firstDelayMs: 0 });
    const statuses = [];
    for (let i = 0; i < 4; i++) { nowRef.now += BUCKET; await sched.tick(nowRef.now); statuses.push(store.getJob('seed').last_status); }
    // 对照 M3 探针(cycle0 learned、cycle1 起全 idle)：修复后 4 次都 learned
    expect(statuses).toEqual(['learned', 'learned', 'learned', 'learned']);
    expect(store.getJob('seed').consecutive_idle).toBe(0); // 零 idle 累积(探针里爬到 25+)
  });

  it('同一角度桶内重复执行 → 撞 add 去重 → idle(去重路径真覆盖)', async () => {
    const goalSystem = createGoalSystem({});
    const store = new NoeLearningScheduleStore();
    const nowRef = { now: BUCKET * 100 + 1 }; // 桶内固定不跨桶
    const sched = createLearningScheduler({ store, runLearnOnce: makeServerRunner(goalSystem, nowRef), now: () => nowRef.now });
    sched.addLearningJob({ id: 'seed', topic: 'AI 工具', kind: 'every', everyMs: BUCKET, anchorMs: BUCKET * 100, firstDelayMs: 0 });
    await sched.tick(nowRef.now);
    expect(store.getJob('seed').last_status).toBe('learned'); // 第一次立项
    store.finishRun('seed', { learned: true, mastery: 0, consecutiveIdle: 0, nextRunAtMs: nowRef.now }, nowRef.now); // 强制再到点(仍同桶)
    await sched.tick(nowRef.now);
    expect(store.getJob('seed').last_status).toBe('idle'); // 同 title 撞去重→idle(非崩、非 error)
  });

  it('serious#3 修复：mastery 涨但间隔不被拉长(连续 learned 间隔稳定 baseEvery)', async () => {
    const goalSystem = createGoalSystem({});
    const store = new NoeLearningScheduleStore();
    const nowRef = { now: BUCKET * 100 };
    const sched = createLearningScheduler({ store, runLearnOnce: makeServerRunner(goalSystem, nowRef), now: () => nowRef.now });
    sched.addLearningJob({ id: 'seed', topic: 'AI 工具', kind: 'every', everyMs: BUCKET, anchorMs: nowRef.now, firstDelayMs: 0 });
    nowRef.now += BUCKET; await sched.tick(nowRef.now);
    const j1 = store.getJob('seed');
    nowRef.now += BUCKET; await sched.tick(nowRef.now);
    const j2 = store.getJob('seed');
    expect(j2.mastery).toBeGreaterThan(j1.mastery);              // mastery 仍记录成效(可观测)
    expect(j1.next_run_at_ms - (BUCKET * 101)).toBe(BUCKET);     // 间隔=baseEvery
    expect(j2.next_run_at_ms - (BUCKET * 102)).toBe(BUCKET);     // 仍=baseEvery(没被 masteryMult 1.2×/1.4× 拉长)
  });
});
