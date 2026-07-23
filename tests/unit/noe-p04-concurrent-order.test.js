// @ts-check
// P0.4 反向 probe：self-evolution 自改链「并发/重入 tick 顺序」边界。
//   被测机制（真实，绝不 mock）：单 writer + 幂等推进顺序——
//     ① 同一 goal 重入 tick 时不重复执行同一步（cycle 真回写 → loop 真前进 → 下拍走下一阶段）；
//     ② 推不动的 cycle 连续无进展会被「有界」drop 解锁（防 openSelfEvolutionGoals()[0] 永久占位空转）；
//     ③ 并发 tick 同一 goal 不抛、不把 cycle 推回乱序。
//   用真 NoeSelfEvolutionCycleStore + 真 evaluateNoeSelfEvolutionLoop（stage 推进核心）。
//   只桩外部依赖：propose（ActPipeline，非本模块机制）+ goalSystem（用有状态 spy 记 setStatus）。
//   反向核心：若把上述机制改坏（advance 不落库 / 重读旧态 / stuck 计数每拍误重置 / 永不 drop），本测试必红。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';
import { NoeSelfEvolutionCycleStore } from '../../src/room/NoeSelfEvolutionCycleStore.js';
import { createNoeSelfEvolutionTrigger } from '../../src/room/NoeSelfEvolutionTrigger.js';
import { buildNoeConsensusLedger } from '../../src/room/NoeConsensusLedger.js';
import { NOE_REQUIRED_BOUNDARY_IDS } from '../../src/room/NoeConsensusGate.js';
import { NOE_SELF_EVOLUTION_CYCLE_SCHEMA_VERSION } from '../../src/room/NoeSelfEvolutionCycle.js';

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'noe-p04-concurrent-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

function vote(model) {
  return {
    model,
    decision: 'approve_with_changes',
    authority: model === 'm3' ? 'suggestion_only' : model === 'codex' ? 'writer_integrator' : 'advisory',
    canWrite: model === 'codex',
    firstClass: model === 'claude' ? true : undefined,
    consensusVote: 'yes',
    blockers: [],
    verificationRequired: [`${model} verification`],
    recommendedFirstSlice: [`${model} first slice`],
    rawOutputRef: `output/noe-multimodel/round/${model}.txt`,
    evidenceRef: 'output/noe-multimodel/round/brief.md',
  };
}

// 内联 validated consensus ledger（cycle.ledger 路径，免文件读）→ 起点 implementation_ready。
function inlineLedger() {
  return buildNoeConsensusLedger({
    roundId: 'round-p04-concurrent',
    goal: 'Noe self evolution concurrent-order',
    evidenceRef: 'output/noe-multimodel/round/brief.md',
    votes: ['codex', 'claude', 'm3'].map(vote),
    boundaries: NOE_REQUIRED_BOUNDARY_IDS.map((id) => ({ id })),
    implementation: { writer: 'codex', authorizationRequired: true, runtimeVerificationRequired: true, rollbackRequired: true, memoryWritebackAckRequired: true },
  }, { createdAt: '2026-06-22T00:00:00.000Z' });
}

describe('P0.4 并发/重入自改顺序（真 store + 真 loop，反向 probe）', () => {
  // 反向 probe ①：重入 tick 不重复执行同一步。
  //   第一拍 propose implementation 并真回写（impl done + runtime ok）→ store stage 真前进；
  //   第二拍读到已前进的 cycle，loop 算出下一阶段 → 绝不再 propose implementation（不重复执行）。
  it('重入：第一拍 propose implementation 并推进 cycle；第二拍不再重复同一步（单 writer 幂等推进）', async () => {
    const store = new NoeSelfEvolutionCycleStore({ projectId: 'noe' });
    const seed = store.upsert({
      schemaVersion: NOE_SELF_EVOLUTION_CYCLE_SCHEMA_VERSION,
      cycleId: 'c-reentry',
      goalId: 'goal-reentry',
      goal: '修复 NoeMissionRunner 前缀越界',
      ledger: inlineLedger(),
      authorization: { consensusApproved: true, scope: 'p04 self-evolution', costClass: 'local_or_user_approved_model_calls' },
      rollback: { planRef: 'output/noe-self-evolution/rb.md' },
    });
    expect(seed.stage).toBe('implementation_ready'); // 前置：真 loop 算出的起点

    // 拟真 ActPipeline.propose：implementation 成功并返回 executorResult（含 runtimeOk）；记录每次 action。
    const actions = [];
    const propose = vi.fn(async (input) => {
      actions.push(input.action);
      if (input.action === 'noe.self_evolution.implementation') {
        return { ok: true, act: { id: 'a-impl' }, executorResult: { applyReportRef: 'output/ap.json', diffRef: 'output/ap.json', runtimeReportRef: 'output/rt.json', runtimeOk: true, touchedFiles: ['evo.js'] } };
      }
      return { ok: true, act: { id: 'a-other' } };
    });
    const goalSystem = { get: () => ({ title: '修复 NoeMissionRunner 前缀越界' }), setStatus: vi.fn(() => true), list: () => [] };
    const trigger = createNoeSelfEvolutionTrigger({ goalSystem, cycleStore: store, propose, realApply: true });

    const r1 = await trigger.tick({ goalId: 'goal-reentry' });
    expect(r1.action).toBe('noe.self_evolution.implementation'); // 第一拍执行 implementation
    expect(r1.advancedByResult).toBe(true);
    expect(store.getByCycleId('c-reentry').stage).toBe('post_review_required'); // cycle 真被回写前进（非原地）

    const r2 = await trigger.tick({ goalId: 'goal-reentry' });
    // 反向断言：第二拍绝不再 propose implementation（机制坏=重读旧态/advance 未落库 → 会重复执行 → 此断言红）。
    expect(r2.action).not.toBe('noe.self_evolution.implementation');
    expect(actions.filter((a) => a === 'noe.self_evolution.implementation')).toHaveLength(1);
  });

  // 反向 probe ②（核心）：implementer 反复失败的 cycle 连续无进展 → 有界 drop 解锁；过早/永不 drop 都判红。
  //   危险被拦截：一个 implementation 反复硬失败（无 needsSelfRepair）的目标若不被 drop，会永久占据
  //   openSelfEvolutionGoals()[0]、被心跳无限重提空转（实测过的 P0 自锁）。走真 store + 真 loop：
  //   起点 implementation_ready；propose 持续 ok:false → 既不回写推进、也不计进展 → stuck 严格累加。
  it('卡死解锁：act 持续失败时连续无进展严格累加到 maxNonProgressTicks 才 drop（不过早、不永不）', async () => {
    const store = new NoeSelfEvolutionCycleStore({ projectId: 'noe' });
    const seed = store.upsert({
      schemaVersion: NOE_SELF_EVOLUTION_CYCLE_SCHEMA_VERSION,
      cycleId: 'c-stuck', goalId: 'goal-stuck', goal: '修复 NoeMissionRunner 前缀越界',
      ledger: inlineLedger(),
      authorization: { consensusApproved: true, scope: 'p04 self-evolution', costClass: 'local_or_user_approved_model_calls' },
      rollback: { planRef: 'output/noe-self-evolution/rb.md' },
    });
    expect(seed.stage).toBe('implementation_ready'); // 真 loop 起点：可执行但下面让 act 反复失败

    const setStatus = vi.fn(() => true);
    const goalSystem = { get: () => ({ title: '修复 NoeMissionRunner 前缀越界' }), setStatus, list: () => [] };
    // implementer 硬失败（无 needsSelfRepair）→ trigger 不路由 self_repair、不 advance → 每拍计一次无进展。
    const propose = vi.fn(async () => ({ ok: false, error: 'self_evolution_apply_preflight_blocked', selfEvolution: { blockers: ['x'] } }));
    const trigger = createNoeSelfEvolutionTrigger({ goalSystem, cycleStore: store, propose, realApply: true, maxNonProgressTicks: 2 });

    const r1 = await trigger.tick({ goalId: 'goal-stuck' }); // count=1：未达阈值
    expect(r1.goalDropped).toBeUndefined();
    expect(setStatus).not.toHaveBeenCalled(); // 反向：过早 drop = 机制坏 = 红

    const r2 = await trigger.tick({ goalId: 'goal-stuck' }); // count=2：达阈值 → 必 drop
    // 反向断言：若 stuck 计数被每拍误重置 / 并发下丢失 / 永不 drop，则下面三条全红。
    expect(r2.goalDropped).toBe(true);
    expect(r2.reason).toBe('stuck_unlocked');
    expect(setStatus).toHaveBeenCalledWith('goal-stuck', 'dropped');
    // cycle 未被失败的 act 篡改前进（implementer 失败绝不偷偷推进 stage）。
    expect(store.getByCycleId('c-stuck').stage).toBe('implementation_ready');
  });

  // 反向 probe ③：并发 tick 同一 goal（act 持续失败）不抛、不把 cycle 推回乱序、不误推进（单 writer 在重入下安全）。
  it('并发：Promise.all 两拍同一 goal（act 持续失败）都安全返回、cycle stage 不被并发推乱/误进', async () => {
    const store = new NoeSelfEvolutionCycleStore({ projectId: 'noe' });
    store.upsert({
      schemaVersion: NOE_SELF_EVOLUTION_CYCLE_SCHEMA_VERSION,
      cycleId: 'c-conc', goalId: 'goal-conc', goal: '优化 src/loop/ActPipeline.js 并发',
      ledger: inlineLedger(),
      authorization: { consensusApproved: true, scope: 'p04 self-evolution', costClass: 'local_or_user_approved_model_calls' },
      rollback: { planRef: 'output/noe-self-evolution/rb.md' },
    });
    const goalSystem = { get: () => ({ title: 'x' }), setStatus: vi.fn(() => true), list: () => [] };
    // act 持续失败 → 无论并发交错如何，两拍都不回写推进 → 最终态确定（仍 implementation_ready），不 flaky。
    const propose = vi.fn(async () => ({ ok: false, error: 'self_evolution_apply_preflight_blocked' }));
    // maxNonProgressTicks=0（关闭 drop）→ 并发下绝不应触发任何 drop。
    const trigger = createNoeSelfEvolutionTrigger({ goalSystem, cycleStore: store, propose });

    const [a, b] = await Promise.all([
      trigger.tick({ goalId: 'goal-conc' }),
      trigger.tick({ goalId: 'goal-conc' }),
    ]);
    // 反向断言：并发重入若抛异常 / 把 cycle 推乱 / 误 drop，下列断言红。
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(store.getByCycleId('c-conc').stage).toBe('implementation_ready'); // 失败的 act 绝不并发推进 stage
    expect(goalSystem.setStatus).not.toHaveBeenCalled(); // drop 关闭，绝不误 drop
  });
});
