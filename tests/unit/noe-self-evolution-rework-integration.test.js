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

// Step3 端到端集成（真 cycle store + 真 loop 求值器 + 真 trigger，仅 propose/assembleCompletion 用桩）：
//   坐实关键跨组件契约——request_changes 信号来自**实时 assembleCompletion 返回**（completion.reviews），
//   从不持久化进 cycle.postReview（completion.ok=false 时原 autodrive 不 advance）。trigger 单测 mock loop 直接返回
//   rework_ready，绕过了"cycle.postReview 实际不含 request_changes、computeStage 不透传 rework"的现实
//   （"机制存在≠活着"，同改动3 projectId 断层教训）。本测真 loop+真 store，验证返工 round 在 sqlite 真推进 + 超限真转 terminal。

let tmp;
beforeEach(() => { close(); tmp = mkdtempSync(join(tmpdir(), 'noe-se-rework-')); initSqlite(join(tmp, 'panel.db')); });
afterEach(() => { close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = null; });

function vote(model) {
  return { model, decision: 'approve_with_changes', authority: model === 'm3' ? 'suggestion_only' : model === 'codex' ? 'writer_integrator' : 'advisory', canWrite: model === 'codex', firstClass: model === 'claude' ? true : undefined, consensusVote: 'yes', blockers: [], verificationRequired: [`${model} verification`], recommendedFirstSlice: [`${model} first slice`], rawOutputRef: `output/noe-multimodel/round/${model}.txt`, evidenceRef: 'output/noe-multimodel/round/brief.md' };
}
function inlineLedger() {
  return buildNoeConsensusLedger({ roundId: 'round-rework', goal: 'Noe self evolution rework', evidenceRef: 'output/noe-multimodel/round/brief.md', votes: ['codex', 'claude', 'm3'].map(vote), boundaries: NOE_REQUIRED_BOUNDARY_IDS.map((id) => ({ id })), implementation: { writer: 'codex', authorizationRequired: true, runtimeVerificationRequired: true, rollbackRequired: true, memoryWritebackAckRequired: true } }, { createdAt: '2026-06-22T00:00:00.000Z' });
}
// 预置一个 consensus 过 + implementation done + runtime ok 的 cycle → 真实 stage=post_review_required。
function seedAtPostReview(store, { cycleId, goalId, goal = '改进调度算法', reworkRounds } = {}) {
  return store.upsert({
    schemaVersion: NOE_SELF_EVOLUTION_CYCLE_SCHEMA_VERSION,
    cycleId, goalId, goal,
    ledger: inlineLedger(),
    authorization: { consensusApproved: true, scope: 'rework self-evolution', costClass: 'local_or_user_approved_model_calls' },
    rollback: { planRef: 'output/noe-self-evolution/rb.md' },
    implementation: { ok: true, applyReportRef: 'output/ap.json', diffRef: 'output/ap.json', touchedFiles: ['evo-x.js'] },
    runtimeVerification: { ok: true, reportRef: 'output/rt.json' },
    ...(reworkRounds !== undefined ? { reworkRounds } : {}),
  });
}
function makeProposeStub(captured) {
  return async (input) => {
    captured.push({ action: input.action, selfEvolution: input.selfEvolution });
    if (input.action === 'noe.self_evolution.implementation') return { ok: true, act: { id: 'a-impl' }, executorResult: { applyReportRef: 'output/ap.json', diffRef: 'output/ap.json', runtimeReportRef: 'output/rt.json', runtimeOk: true, touchedFiles: ['evo-x.js'] } };
    return { ok: true, act: { id: 'a-other' } };
  };
}
// 复核器实时返回 request_changes（reviewer 要求改）——这是真实信号来源，不在 cycle.postReview 里。
const requestChangesCompletion = (errors = ['Tests array is empty', 'No diff content']) => async () => ({
  ok: false, reason: 'post_review_not_approved',
  reviews: [
    { model: 'm3', decision: 'request_changes', authority: 'suggestion_only', canWrite: false, rawOutputRef: 'output/r.txt' },
    { model: 'claude', decision: 'approve', authority: 'readonly_source_reviewer', canWrite: false, rawOutputRef: 'output/c.txt' },
  ],
  errors,
});

describe('Step3 端到端：request_changes 真实返工链路（真 store + 真 loop）', () => {
  it('reworkEnabled ON + 真实复核 request_changes → 清证据返工(reworkRounds 0→1 持久化) + propose implementation 带 blocker', async () => {
    const store = new NoeSelfEvolutionCycleStore({ projectId: 'noe' });
    const seed = seedAtPostReview(store, { cycleId: 'c-rw', goalId: 'g-rw' });
    expect(seed.stage).toBe('post_review_required'); // computeStage 不透传 rework → DB stage 仍 post_review_required
    const captured = [];
    const goalSystem = { get: () => ({ title: '改进调度算法' }), setStatus: vi.fn(() => true), list: () => [] };
    const trigger = createNoeSelfEvolutionTrigger({ goalSystem, cycleStore: store, propose: makeProposeStub(captured), assembleCompletion: requestChangesCompletion(), realApply: true, reworkEnabled: true, maxReworkRounds: 2 });
    await trigger.tick({ goalId: 'g-rw' });
    const after = store.getByCycleId('c-rw');
    expect(after.reworkRounds).toBe(1); // ★ 返工 round 真在 sqlite 推进（缺口时这里是 0/undefined）
    const implCall = captured.find((c) => c.action === 'noe.self_evolution.implementation');
    expect(implCall).toBeTruthy(); // ★ 真返工：propose 被调 implementation
    expect(implCall.selfEvolution.objective).toContain('Tests array is empty'); // reviewer blocker 拼进 objective（implementer 才看得到要改什么）
  });

  it('反向 flag OFF（默认）+ 真实复核 request_changes → 不返工（reworkRounds 不增、不 propose impl，维持现状）', async () => {
    const store = new NoeSelfEvolutionCycleStore({ projectId: 'noe' });
    seedAtPostReview(store, { cycleId: 'c-off', goalId: 'g-off' });
    const captured = [];
    const goalSystem = { get: () => ({ title: 'x' }), setStatus: vi.fn(() => true), list: () => [] };
    const trigger = createNoeSelfEvolutionTrigger({ goalSystem, cycleStore: store, propose: makeProposeStub(captured), assembleCompletion: requestChangesCompletion(), realApply: true }); // reworkEnabled 未传=OFF
    await trigger.tick({ goalId: 'g-off' });
    const after = store.getByCycleId('c-off');
    expect(Number(after.reworkRounds || 0)).toBe(0);
    expect(captured.find((c) => c.action === 'noe.self_evolution.implementation')).toBeFalsy();
  });

  it('超限：reworkRounds 已达 max + 真实复核仍 request_changes → 学习+drop(rework_exhausted)', async () => {
    const store = new NoeSelfEvolutionCycleStore({ projectId: 'noe' });
    seedAtPostReview(store, { cycleId: 'c-exh', goalId: 'g-exh', reworkRounds: 2 });
    const captured = [];
    const goalSystem = { get: () => ({ title: 'x' }), setStatus: vi.fn(() => true), list: () => [] };
    const recordFailureLesson = vi.fn();
    const trigger = createNoeSelfEvolutionTrigger({ goalSystem, cycleStore: store, propose: makeProposeStub(captured), assembleCompletion: requestChangesCompletion(), recordFailureLesson, rejectLearning: true, realApply: true, reworkEnabled: true, maxReworkRounds: 2 });
    const r = await trigger.tick({ goalId: 'g-exh' });
    expect(recordFailureLesson).toHaveBeenCalledTimes(1);
    expect(goalSystem.setStatus).toHaveBeenCalledWith('g-exh', 'dropped');
    expect(r.goalDropped).toBe(true);
    const after = store.getByCycleId('c-exh');
    expect(after.postReviewFailure).toMatchObject({ terminal: true, reason: 'rework_exhausted' });
  });

  it('端到端二阶闭环：连续 request_changes → 返工 round 1→2 真推进 → 超限学习drop（reworkRounds 单调增到 max）', async () => {
    const store = new NoeSelfEvolutionCycleStore({ projectId: 'noe' });
    seedAtPostReview(store, { cycleId: 'c-e2e', goalId: 'g-e2e' });
    const captured = [];
    const goalSystem = { get: () => ({ title: 'x' }), setStatus: vi.fn(() => true), list: () => [] };
    const recordFailureLesson = vi.fn();
    const trigger = createNoeSelfEvolutionTrigger({ goalSystem, cycleStore: store, propose: makeProposeStub(captured), assembleCompletion: requestChangesCompletion(), recordFailureLesson, rejectLearning: true, realApply: true, reworkEnabled: true, maxReworkRounds: 2 });
    const reworkRoundsSeen = [];
    let dropped = false;
    for (let i = 0; i < 10; i += 1) {
      const r = await trigger.tick({ goalId: 'g-e2e' });
      reworkRoundsSeen.push(Number(store.getByCycleId('c-e2e').reworkRounds || 0));
      if (r.goalDropped) { dropped = true; break; }
    }
    expect(Math.max(...reworkRoundsSeen)).toBe(2); // 返工 round 真推进到上限
    expect(dropped).toBe(true); // 超限后转 terminal drop（有界，无无限返工）
    expect(recordFailureLesson).toHaveBeenCalled();
  });

  it('P1-2：reviewer 只在 evidence_gaps 列 blocker（completion.errors 空）→ blocker 仍进 reworkBlockers + objective（不丢 reviewer 要改点）', async () => {
    const store = new NoeSelfEvolutionCycleStore({ projectId: 'noe' });
    seedAtPostReview(store, { cycleId: 'c-gaps', goalId: 'g-gaps' });
    const captured = [];
    const goalSystem = { get: () => ({ title: 'x' }), setStatus: vi.fn(() => true), list: () => [] };
    const assembleCompletion = async () => ({
      ok: false, reason: 'post_review_not_approved',
      reviews: [
        { model: 'm3', decision: 'request_changes', evidence_gaps: ['必须补 no-diff regression test'], canWrite: false, rawOutputRef: 'output/r.txt' },
        { model: 'claude', decision: 'approve', canWrite: false, rawOutputRef: 'output/c.txt' },
      ],
      errors: [], // completion.errors 空 → 只能从 reviews[].evidence_gaps 取
    });
    const trigger = createNoeSelfEvolutionTrigger({ goalSystem, cycleStore: store, propose: makeProposeStub(captured), assembleCompletion, realApply: true, reworkEnabled: true, maxReworkRounds: 2 });
    await trigger.tick({ goalId: 'g-gaps' });
    const after = store.getByCycleId('c-gaps');
    expect((after.reworkBlockers || []).join(' ')).toContain('no-diff regression test'); // evidence_gaps 进 blocker
    const implCall = captured.find((c) => c.action === 'noe.self_evolution.implementation');
    expect(implCall.selfEvolution.objective).toContain('no-diff regression test'); // implementer 看得到要改什么
  });

  it('P1-3：返工清 nested retrospective（防 loop 回退读旧 retrospective.ref 跳过复盘步）', async () => {
    const store = new NoeSelfEvolutionCycleStore({ projectId: 'noe' });
    seedAtPostReview(store, { cycleId: 'c-retro', goalId: 'g-retro' });
    store.advance('c-retro', { retrospective: { ref: 'docs/old-retro.md' } }); // 预置旧 nested retrospective
    const captured = [];
    const goalSystem = { get: () => ({ title: 'x' }), setStatus: vi.fn(() => true), list: () => [] };
    const trigger = createNoeSelfEvolutionTrigger({ goalSystem, cycleStore: store, propose: makeProposeStub(captured), assembleCompletion: requestChangesCompletion(), realApply: true, reworkEnabled: true, maxReworkRounds: 2 });
    await trigger.tick({ goalId: 'g-retro' });
    const after = store.getByCycleId('c-retro');
    expect(after.retrospective?.ref || '').toBe(''); // nested retrospective 清了，loop 不会复用旧复盘
  });
});
