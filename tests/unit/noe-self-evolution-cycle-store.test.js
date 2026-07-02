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
