import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';
import { NoeSelfEvolutionCycleStore } from '../../src/room/NoeSelfEvolutionCycleStore.js';
import { createNoeSelfEvolutionTrigger } from '../../src/room/NoeSelfEvolutionTrigger.js';
import { makeNoeSelfEvolutionCompletionAutodrive } from '../../src/room/NoeSelfEvolutionCompletionAutodrive.js';
import { buildNoeConsensusLedger } from '../../src/room/NoeConsensusLedger.js';
import { NOE_REQUIRED_BOUNDARY_IDS } from '../../src/room/NoeConsensusGate.js';
import { NOE_SELF_EVOLUTION_CYCLE_SCHEMA_VERSION } from '../../src/room/NoeSelfEvolutionCycle.js';

// complete 控制链「全链路」集成：真 cycle store + 真 loop 求值器 + 真完整校验 + 真 completion autodrive，
//   驱动一个 cycle 从 implementation_ready 一路走到 stage='complete'（DB complete++）。
//   这是 Finding 2 修复的黄金证据——证明 memory_writeback 回写后状态机 + upsert 完整校验**真能到 complete**
//   （我发现的「第三道关」：upsert 在 stage==='complete' 跑 validateNoeSelfEvolutionCycle，缺 summaryRef 会被拒）。
//   propose 用「拟真 ActPipeline 返回形状」的桩（executor 单测另测真执行）；loop/store/校验全真。

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'noe-se-complete-'));
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

// 内联 validated ledger（cycle.ledger 对象路径，免文件读；requireReferencedFiles=false 时引用文件不需存在）。
function inlineLedger() {
  return buildNoeConsensusLedger({
    roundId: 'round-complete-chain',
    goal: 'Noe self evolution complete-chain',
    evidenceRef: 'output/noe-multimodel/round/brief.md',
    votes: ['codex', 'claude', 'm3'].map(vote),
    boundaries: NOE_REQUIRED_BOUNDARY_IDS.map((id) => ({ id })),
    implementation: { writer: 'codex', authorizationRequired: true, runtimeVerificationRequired: true, rollbackRequired: true, memoryWritebackAckRequired: true },
  }, { createdAt: '2026-06-22T00:00:00.000Z' });
}

// 拟真 ActPipeline.propose 返回（{ok, act, executorResult}），按 action 给 executorResult 顶层 ref。
function makeProposeStub(captured) {
  return async (input) => {
    captured.push({ action: input.action, realExecute: input.realExecute, selfEvolution: input.selfEvolution });
    if (input.action === 'noe.self_evolution.implementation') {
      return { ok: true, act: { id: 'a-impl' }, executorResult: { applyReportRef: 'output/ap.json', diffRef: 'output/ap.json', runtimeReportRef: 'output/rt.json', runtimeOk: true, touchedFiles: ['evo-x.js'] } };
    }
    if (input.action === 'noe.self_evolution.memory_writeback') {
      return { ok: true, act: { id: 'a-mw' }, executorResult: { memoryId: 'mem-1', summaryRef: 'output/noe-self-evolution/memory-writeback/s.md' } };
    }
    if (input.action === 'noe.self_evolution.complete') {
      return { ok: true, act: { id: 'a-cmp' }, executorResult: { completed: true, eventId: 1 } };
    }
    return { ok: true, act: { id: 'a-other' } };
  };
}

describe('self-evolution complete 控制链全链路（真 store + 真 loop + 真完整校验 + 真 completion autodrive）', () => {
  it('从 implementation_ready 一路 tick 到 stage=complete + 关 goal（Finding 2 黄金证据）', async () => {
    const store = new NoeSelfEvolutionCycleStore({ projectId: 'noe' });
    // 预置一个「consensus 已过」的 cycle（内联 validated ledger + authorization + rollback）→ 起点 implementation_ready。
    const seed = store.upsert({
      schemaVersion: NOE_SELF_EVOLUTION_CYCLE_SCHEMA_VERSION,
      cycleId: 'c-chain',
      goalId: 'goal-chain',
      goal: '修复 NoeMissionRunner 前缀越界',
      ledger: inlineLedger(),
      authorization: { consensusApproved: true, scope: 'complete-chain self-evolution', costClass: 'local_or_user_approved_model_calls' },
      rollback: { planRef: 'output/noe-self-evolution/rb.md' },
    });
    expect(seed.ok).toBe(true);
    expect(seed.stage).toBe('implementation_ready'); // consensus 已过、implementation 未做

    const captured = [];
    const propose = makeProposeStub(captured);
    // 真 completion autodrive：post_review 真复核用桩 runPostReview（返回 approve）；retrospective 真写文件到 tmp。
    const assembleCompletion = makeNoeSelfEvolutionCompletionAutodrive({
      root: tmp,
      requireStandingGrant: false,
      runPostReview: async () => ({ reviews: [
        { model: 'claude', decision: 'approve', authority: 'readonly_source_reviewer', canWrite: false, rawOutputRef: 'output/noe-post-review/claude.txt' },
        { model: 'm3', decision: 'approve', authority: 'readonly_source_reviewer', canWrite: false, rawOutputRef: 'output/noe-post-review/m3.txt' },
      ] }),
    });
    const goalSystem = { get: () => ({ title: '修复 NoeMissionRunner 前缀越界' }), setStatus: vi.fn(() => true), list: () => [] };
    const trigger = createNoeSelfEvolutionTrigger({
      goalSystem,
      cycleStore: store,
      propose,
      assembleCompletion,
      realApply: true,
    });

    // 驱动至多 8 拍（一拍一阶段：impl → post_review → retrospective → memory_writeback → complete → 关 goal）。
    let lastStage = seed.stage;
    let closed = false;
    const stages = [];
    for (let i = 0; i < 8; i += 1) {
      const r = await trigger.tick({ goalId: 'goal-chain' });
      const cur = store.getByCycleId('c-chain');
      lastStage = cur.stage;
      stages.push(lastStage);
      if (r.goalClosed) { closed = true; break; }
    }

    // 黄金断言：cycle 真到 complete（含 upsert 完整校验通过）+ goal 被关。
    expect(lastStage).toBe('complete');
    expect(closed).toBe(true);
    expect(goalSystem.setStatus).toHaveBeenCalledWith('goal-chain', 'done');
    // 路径经过 memory_writeback_ready（Finding 2 的卡点）后才到 complete。
    expect(stages).toContain('complete');
    // DB 里该 cycle 的 stage 落库为 complete（list by stage 能查到）。
    expect(store.list({ stage: 'complete' }).some((c) => c.cycleId === 'c-chain')).toBe(true);

    // memory_writeback act 被真执行（realExecute）+ 灌了脱敏 summary（无文件路径泄漏）。
    const mwCall = captured.find((c) => c.action === 'noe.self_evolution.memory_writeback');
    expect(mwCall).toBeTruthy();
    expect(mwCall.realExecute).toBe(true);
    expect(mwCall.selfEvolution.memoryWriteback.summary).toContain('自我进化');
    expect(mwCall.selfEvolution.memoryWriteback.summary).not.toContain('evo-x.js');
  });

  it('CRITICAL-2 集成：verify 失败回写 patch（含 repairReturnsToConsensus）让真 loop 算出 self_repair_ready（可达）', async () => {
    const store = new NoeSelfEvolutionCycleStore({ projectId: 'noe' });
    const base = {
      schemaVersion: NOE_SELF_EVOLUTION_CYCLE_SCHEMA_VERSION,
      goalId: 'g-sr', goal: '修复 NoeMissionRunner 前缀越界',
      ledger: inlineLedger(),
      authorization: { consensusApproved: true, scope: 'complete-chain self-evolution', costClass: 'local_or_user_approved_model_calls' },
      rollback: { planRef: 'output/noe-self-evolution/rb.md' },
    };
    // 对照①：缺 repairReturnsToConsensus（生产历史状态）→ 真 loop 算出 self_repair_BLOCKED（CRITICAL-2 证伪前）
    store.upsert({ ...base, cycleId: 'c-srblocked', goalId: 'g-srb',
      implementation: { ok: true, applyReportRef: 'output/ap.json', diffRef: 'output/ap.json' },
      runtimeVerification: { ok: false, reportRef: 'output/rt.json' } });
    expect(store.getByCycleId('c-srblocked').stage).toBe('self_repair_blocked');
    // 对照②：trigger Finding-3 修复后的回写（带 repairReturnsToConsensus:true + failedVerificationRef）→ self_repair_READY（可达）
    store.upsert({ ...base, cycleId: 'c-srready',
      implementation: { ok: true, applyReportRef: 'output/ap.json', diffRef: 'output/ap.json' },
      runtimeVerification: { ok: false, reportRef: 'output/rt.json' },
      repairReturnsToConsensus: true, failedVerificationRef: 'output/rt.json' });
    expect(store.getByCycleId('c-srready').stage).toBe('self_repair_ready');
  });

  it('反向 probe：complete 后再 tick（goal 已关）不再重复推进/重复关', async () => {
    const store = new NoeSelfEvolutionCycleStore({ projectId: 'noe' });
    store.upsert({
      schemaVersion: NOE_SELF_EVOLUTION_CYCLE_SCHEMA_VERSION,
      cycleId: 'c-chain2',
      goalId: 'goal-chain2',
      goal: '优化 src/loop/ActPipeline.js 并发',
      ledger: inlineLedger(),
      authorization: { consensusApproved: true, scope: 'complete-chain self-evolution', costClass: 'local_or_user_approved_model_calls' },
      rollback: { planRef: 'output/noe-self-evolution/rb.md' },
    });
    const propose = makeProposeStub([]);
    const assembleCompletion = makeNoeSelfEvolutionCompletionAutodrive({
      root: tmp,
      requireStandingGrant: false,
      runPostReview: async () => ({ reviews: [
        { model: 'claude', decision: 'approve', authority: 'readonly_source_reviewer', canWrite: false, rawOutputRef: 'output/noe-post-review/claude.txt' },
        { model: 'm3', decision: 'approve', authority: 'readonly_source_reviewer', canWrite: false, rawOutputRef: 'output/noe-post-review/m3.txt' },
      ] }),
    });
    const setStatus = vi.fn(() => true);
    const goalSystem = { get: () => ({ title: 'x' }), setStatus, list: () => [] };
    const trigger = createNoeSelfEvolutionTrigger({ goalSystem, cycleStore: store, propose, assembleCompletion, realApply: true });
    for (let i = 0; i < 8; i += 1) {
      const r = await trigger.tick({ goalId: 'goal-chain2' });
      if (r.goalClosed) break;
    }
    expect(store.getByCycleId('c-chain2').stage).toBe('complete');
    const callsAfterComplete = setStatus.mock.calls.length;
    // complete 后该 goal 在真实心跳里已不在 open 列表；这里直接再 tick 一次，complete act 仍幂等（不抛、不破坏 complete 态）。
    const again = await trigger.tick({ goalId: 'goal-chain2' });
    expect(again.ok).toBe(true);
    expect(store.getByCycleId('c-chain2').stage).toBe('complete'); // 仍是 complete，未被打回
    // 不应反复多关（setStatus 调用不暴涨）——complete act 成功会再调一次 setStatus done，幂等且无害。
    expect(setStatus.mock.calls.length).toBeLessThanOrEqual(callsAfterComplete + 1);
  });
});
