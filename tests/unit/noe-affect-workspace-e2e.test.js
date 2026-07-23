// @ts-check
// 端到端集成（阶段0铁证）：真实任务搞砸 → setback 落真 SQLite → AffectEngine 消化 → v 真跌。
// 与单测不同：这条不注入收集器，而是走真 EpisodicTimeline（含 type 白名单）+ 真 events 表，
// 证明"失败→沮丧"整条链在真实存储上通电，而非各环节单独绿——防"机制存在≠活着"。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initSqlite, close } from '../../src/storage/SqliteStore.js';
import { EpisodicTimeline } from '../../src/memory/EpisodicTimeline.js';
import { createAffectEngine, AFFECT_BASELINE } from '../../src/cognition/NoeAffectEngine.js';
import { createWorkspace } from '../../src/cognition/NoeWorkspace.js';

const T0 = 1_780_000_000_000;
const flush = () => new Promise((r) => setTimeout(r, 0));

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noe-e2e-'));
  initSqlite(join(dir, 'panel.db'));
});
afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

function failingGoalSystem() {
  return {
    arbitrate: () => {},
    nextStep: () => ({ goalId: 'g1', title: '修个东西', stepIndex: 0, step: '动手修', kind: 'act', actionSpec: { action: 'noe.fix' } }),
    recordStepResult: () => ({ goalDone: false }),
  };
}

function makeWorkspace(timeline, now, affectNegativeEpisodes) {
  return createWorkspace({
    timeline,
    goalSystem: failingGoalSystem(),
    runAct: async () => ({ ok: false, error: 'blocked_safety' }),  // 真失败：没放行
    recordEpisode: (e) => timeline.record(e),                       // 走真白名单
    deliberate: async () => ({}),
    affectNegativeEpisodes,
    kv: { get: () => null, set: () => {} },
    appendJournal: () => {},
    now,
  });
}

describe('阶段0端到端：真实失败 → setback → affect v 跌（真 SQLite，非注入桩）', () => {
  it('NOE_AFFECT_NEGATIVE 开：任务被拦下 → setback 落库且类型保留 → tick 后 v 跌破基线', async () => {
    let t = T0;
    const now = () => t;
    const timeline = new EpisodicTimeline({ now });
    const affect = createAffectEngine({ now, timeline });   // watermark = T0
    const before = affect.snapshot().v;
    expect(before).toBeCloseTo(AFFECT_BASELINE.v, 5);

    t = T0 + 60_000;
    makeWorkspace(timeline, now, true).step();
    await flush();

    // setback 真落库，且没被白名单回退成 interaction
    const eps = timeline.recent({ limit: 10 });
    expect(eps.some((e) => e.type === 'setback')).toBe(true);
    expect(eps.some((e) => e.type === 'interaction')).toBe(false);

    t = T0 + 120_000;
    affect.tick();                                  // 从真库消化 setback
    expect(affect.snapshot().v).toBeLessThan(before);   // 铁证：失败真的把心情拉下来了
  });

  it('默认 OFF：同样被拦下 → 记 observation → v 不被拉低（零行为变化）', async () => {
    let t = T0;
    const now = () => t;
    const timeline = new EpisodicTimeline({ now });
    const affect = createAffectEngine({ now, timeline });
    const before = affect.snapshot().v;

    t = T0 + 60_000;
    makeWorkspace(timeline, now, false).step();   // 默认 OFF
    await flush();

    const eps = timeline.recent({ limit: 10 });
    expect(eps.some((e) => e.type === 'setback')).toBe(false);      // 没有 setback
    expect(eps.some((e) => e.type === 'observation')).toBe(true);   // 仍是 observation

    t = T0 + 120_000;
    affect.tick();
    expect(affect.snapshot().v).toBeCloseTo(before, 5);  // observation 对 v 增量恒为 0（只动 arousal），钉死零变化
  });

  it('NOE_AFFECT_NEGATIVE 开：runAct 抛错（真失败 .catch 路径）→ setback 落库 → tick 后 v 跌', async () => {
    let t = T0;
    const now = () => t;
    const timeline = new EpisodicTimeline({ now });
    const affect = createAffectEngine({ now, timeline });
    const before = affect.snapshot().v;

    t = T0 + 60_000;
    createWorkspace({
      timeline,
      goalSystem: failingGoalSystem(),
      runAct: async () => { throw new Error('executor 炸了'); },   // 走 .catch failed 分支（与 blocked 是两个独立写入点）
      recordEpisode: (e) => timeline.record(e),
      deliberate: async () => ({}),
      affectNegativeEpisodes: true,
      kv: { get: () => null, set: () => {} },
      appendJournal: () => {},
      now,
    }).step();
    await flush();

    expect(timeline.recent({ limit: 10 }).some((e) => e.type === 'setback')).toBe(true);

    t = T0 + 120_000;
    affect.tick();
    expect(affect.snapshot().v).toBeLessThan(before);
  });

  it('NOE_AFFECT_NEGATIVE 开：research 上网研究抛错（真失败）→ setback 落库 → tick 后 v 跌', async () => {
    let t = T0;
    const now = () => t;
    const timeline = new EpisodicTimeline({ now });
    const affect = createAffectEngine({ now, timeline });
    const before = affect.snapshot().v;

    t = T0 + 60_000;
    createWorkspace({
      timeline,
      goalSystem: {
        arbitrate: () => {},
        nextStep: () => ({ goalId: 'g2', title: '查点资料', stepIndex: 0, step: '上网查', kind: 'research' }),
        recordStepResult: () => ({ goalDone: false }),
      },
      runResearch: async () => { throw new Error('网络炸了'); },   // research 真失败走 .catch
      recordEpisode: (e) => timeline.record(e),
      deliberate: async () => ({}),
      affectNegativeEpisodes: true,
      kv: { get: () => null, set: () => {} },
      appendJournal: () => {},
      now,
    }).step();
    await flush();

    expect(timeline.recent({ limit: 10 }).some((e) => e.type === 'setback')).toBe(true);

    t = T0 + 120_000;
    affect.tick();
    expect(affect.snapshot().v).toBeLessThan(before);
  });
});
