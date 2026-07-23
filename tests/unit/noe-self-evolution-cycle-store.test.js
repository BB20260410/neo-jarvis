import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite, getDb } from '../../src/storage/SqliteStore.js';
import { NoeSelfEvolutionCycleStore } from '../../src/room/NoeSelfEvolutionCycleStore.js';
import {
  validateNoeSelfEvolutionCycleDraft,
  NOE_SELF_EVOLUTION_CYCLE_SCHEMA_VERSION,
} from '../../src/room/NoeSelfEvolutionCycle.js';
import { evaluateNoeSelfEvolutionLoop } from '../../src/room/NoeSelfEvolutionLoop.js';
import { buildNoeConsensusLedger } from '../../src/room/NoeConsensusLedger.js';
import { resolveSelfEvolutionCycleStoreCapability } from '../../src/room/NoeSelfEvolutionProfile.js';

let tmp;
let store;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'noe-secycle-'));
  initSqlite(join(tmp, 'panel.db'));
  store = new NoeSelfEvolutionCycleStore({ projectId: 'noe' });
});

afterEach(() => {
  close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Minimal consensus ledger matching loop unit fixtures (dry-run path). */
function passedLedger() {
  const evidenceRef = 'output/noe-multimodel/round/brief.md';
  const vote = (model) => ({
    model,
    decision: 'approve_with_changes',
    authority: model === 'm3' ? 'suggestion_only' : model === 'codex' ? 'writer_integrator' : 'advisory',
    canWrite: model === 'codex',
    firstClass: model === 'claude' ? true : undefined,
    consensusVote: 'yes',
    recommendedFirstSlice: ['first safe slice'],
    verificationRequired: ['focused verification'],
    rawOutputRef: `output/noe-multimodel/round/${model}.txt`,
    evidenceRef,
  });
  return buildNoeConsensusLedger({
    roundId: 'round-store-rework',
    goal: 'store rework stage parity',
    evidenceRef,
    votes: ['codex', 'claude', 'm3'].map(vote),
    implementation: {
      writer: 'codex',
      authorizationRequired: true,
      runtimeVerificationRequired: true,
      rollbackRequired: true,
      memoryWritebackAckRequired: true,
    },
  }, { createdAt: '2026-06-07T00:00:00.000Z' });
}

function reworkCyclePayload(extra = {}) {
  return {
    schemaVersion: NOE_SELF_EVOLUTION_CYCLE_SCHEMA_VERSION,
    goal: 'store rework stage parity',
    goalId: 'goal-rework-stage',
    dryRun: true,
    ledger: passedLedger(),
    authorization: {
      userApproved: true,
      scope: 'closed-loop slice',
      costClass: 'local_or_user_approved_model_calls',
    },
    rollback: { planRef: 'output/noe-multimodel/round/rollback.md' },
    implementation: { done: true, ok: true },
    runtimeVerification: { ok: true, reportRef: 'output/noe-full-current/pass.json' },
    postReview: {
      ok: false,
      reviews: [
        { model: 'm3', decision: 'request_changes', authority: 'suggestion_only', canWrite: false, rawOutputRef: 'output/r/m3.txt' },
        { model: 'claude', decision: 'approve', authority: 'readonly_source_reviewer', canWrite: false, rawOutputRef: 'output/r/claude.txt' },
      ],
    },
    reworkRounds: 0,
    ...extra,
  };
}

describe('P2-6 validateNoeSelfEvolutionCycleDraft — 草案骨架校验', () => {
  const base = () => ({
    schemaVersion: NOE_SELF_EVOLUTION_CYCLE_SCHEMA_VERSION,
    cycleId: 'c-1',
    createdAt: '2026-06-14T00:00:00.000Z',
    goal: '改进期望结算率',
  });

  it('合法骨架 → ok（不要求 implementation/runtime 等阶段产物）', () => {
    expect(validateNoeSelfEvolutionCycleDraft(base()).ok).toBe(true);
  });

  it('非对象 → cycle_must_be_object', () => {
    expect(validateNoeSelfEvolutionCycleDraft(null).errors).toContain('cycle_must_be_object');
    expect(validateNoeSelfEvolutionCycleDraft([]).errors).toContain('cycle_must_be_object');
  });

  it('缺各骨架字段 → 对应错误', () => {
    expect(validateNoeSelfEvolutionCycleDraft({ ...base(), goal: '' }).errors).toContain('cycle_goal_required');
    expect(validateNoeSelfEvolutionCycleDraft({ ...base(), cycleId: '' }).errors).toContain('cycle_id_required');
    expect(validateNoeSelfEvolutionCycleDraft({ ...base(), createdAt: '' }).errors).toContain('cycle_created_at_required');
    expect(validateNoeSelfEvolutionCycleDraft({ ...base(), schemaVersion: 999 }).errors)
      .toContain('unsupported_cycle_schema_version:999');
  });
});

describe('NoeSelfEvolutionCycleStore — 建表与落库', () => {
  it('migration v11 建出 noe_self_evolution_cycles 表', () => {
    const row = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='noe_self_evolution_cycles'")
      .get();
    expect(row?.name).toBe('noe_self_evolution_cycles');
  });

  it('upsert 草案（自动补 cycleId/createdAt/schemaVersion）→ 落库可读回，stage 非空', () => {
    const r = store.upsert({ goal: '改进期望结算率', goalId: 'goal-1' });
    expect(r.ok).toBe(true);
    expect(r.cycle.cycleId).toMatch(/^secycle-/);
    expect(r.cycle.goal).toBe('改进期望结算率');
    expect(typeof r.stage).toBe('string');
    expect(r.stage.length).toBeGreaterThan(0);
    const back = store.getByCycleId(r.cycle.cycleId);
    expect(back.goal).toBe('改进期望结算率');
    expect(back.goalId).toBe('goal-1');
  });

  it('draft 校验失败（缺 goal）→ 不写脏行', () => {
    const r = store.upsert({ goalId: 'goal-x' });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('cycle_goal_required');
    expect(r.cycle).toBeNull();
    expect(store.list({ goalId: 'goal-x' })).toHaveLength(0);
  });

  it('getByGoal 取最新一轮（rowid tiebreak）', () => {
    const a = store.upsert({ goal: 'g', goalId: 'goal-2', cycleId: 'c-a' });
    const b = store.upsert({ goal: 'g2', goalId: 'goal-2', cycleId: 'c-b' });
    expect(a.ok && b.ok).toBe(true);
    expect(store.getByGoal('goal-2').cycleId).toBe('c-b');
  });

  it('advance 浅合并 + stage 重算 + 保留 createdAt', () => {
    const r = store.upsert({ goal: '原目标', goalId: 'goal-3', cycleId: 'c-adv' });
    const createdAt = r.cycle.createdAt;
    const adv = store.advance('c-adv', { goal: '改后目标' });
    expect(adv.ok).toBe(true);
    expect(adv.cycle.goal).toBe('改后目标');
    expect(adv.cycle.createdAt).toBe(createdAt);
  });

  it('advance 不存在的 cycle → cycle_not_found', () => {
    const adv = store.advance('nope', { goal: 'x' });
    expect(adv.ok).toBe(false);
    expect(adv.errors).toContain('cycle_not_found');
  });

  it('P2-6：requireComplete 对不完整 cycle 跑完整校验并拒绝（不写）', () => {
    const r = store.upsert({ goal: 'g', goalId: 'goal-4' }, { requireComplete: true });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.some((e) => /consensus|implementation|runtime/.test(e))).toBe(true);
    expect(store.list({ goalId: 'goal-4' })).toHaveLength(0);
  });

  it('list 按 goalId 过滤', () => {
    store.upsert({ goal: 'g', goalId: 'goal-5', cycleId: 'c1' });
    store.upsert({ goal: 'g', goalId: 'goal-6', cycleId: 'c2' });
    expect(store.list({ limit: 50 }).length).toBeGreaterThanOrEqual(2);
    const g5 = store.list({ goalId: 'goal-5' });
    expect(g5).toHaveLength(1);
    expect(g5[0].cycleId).toBe('c1');
  });
});

describe('P1-1 CycleStore stage parity with trigger rework (maxReworkRounds)', () => {
  it('without maxReworkRounds, reworkEnabled alone still yields post_review_required (bug fixed only when max>0)', () => {
    const bare = new NoeSelfEvolutionCycleStore({
      projectId: 'noe',
      reworkEnabled: true,
      // maxReworkRounds defaults 0 — must NOT claim rework_ready
    });
    const r = bare.upsert({ ...reworkCyclePayload(), cycleId: 'c-rework-no-max' });
    expect(r.ok).toBe(true);
    expect(r.stage).toBe('post_review_required');
  });

  it('upsert with reworkEnabled+maxReworkRounds=2 + request_changes → post_review_rework_ready (DB stage)', () => {
    const reworkStore = new NoeSelfEvolutionCycleStore({
      projectId: 'noe',
      reworkEnabled: true,
      maxReworkRounds: 2,
    });
    const payload = reworkCyclePayload({ cycleId: 'c-rework-ready' });
    // Pure loop with same capability must agree
    const loop = evaluateNoeSelfEvolutionLoop({
      ...payload,
      reworkEnabled: true,
      maxReworkRounds: 2,
    });
    expect(loop.stage).toBe('post_review_rework_ready');

    const r = reworkStore.upsert(payload);
    expect(r.ok).toBe(true);
    expect(r.stage).toBe('post_review_rework_ready');
    const back = reworkStore.getByCycleId('c-rework-ready');
    expect(back.stage).toBe('post_review_rework_ready');
  });

  it('advance path also recomputes rework_ready (not stuck post_review_required)', () => {
    const reworkStore = new NoeSelfEvolutionCycleStore({
      projectId: 'noe',
      reworkEnabled: true,
      maxReworkRounds: 2,
    });
    const first = reworkStore.upsert({
      ...reworkCyclePayload({ cycleId: 'c-rework-adv' }),
      postReview: { ok: false, reviews: [] }, // not rework yet
    });
    expect(first.ok).toBe(true);
    // Without request_changes → post_review_required
    expect(first.stage).toBe('post_review_required');

    const adv = reworkStore.advance('c-rework-adv', {
      postReview: reworkCyclePayload().postReview,
      reworkRounds: 0,
    });
    expect(adv.ok).toBe(true);
    expect(adv.stage).toBe('post_review_rework_ready');
  });

  it('resolveSelfEvolutionCycleStoreCapability spreads into store ctor (server wiring shape)', () => {
    const cap = resolveSelfEvolutionCycleStoreCapability({
      NOE_SELFEVO_REWORK: '1',
      NOE_SELF_EVOLUTION_CONSENSUS_AUTODRIVE: '1',
    });
    expect(cap.maxReworkRounds).toBe(2);
    const s = new NoeSelfEvolutionCycleStore({ projectId: 'noe', ...cap });
    const r = s.upsert({ ...reworkCyclePayload(), cycleId: 'c-cap-spread' });
    expect(r.stage).toBe('post_review_rework_ready');
  });
});
