import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';
import { createGoalSystem } from '../../src/cognition/NoeGoalSystem.js';
import { NoeSelfEvolutionCycleStore } from '../../src/room/NoeSelfEvolutionCycleStore.js';
import { createNoeSelfEvolutionTrigger } from '../../src/room/NoeSelfEvolutionTrigger.js';

// 环2 集成：真 sqlite + 真 goalSystem + 真 cycleStore + 真 loop 求值器（只 mock propose），
// 验证 server.js 装配链路（observe→立项→tick→建 Cycle）在 env ON 下真跑不崩。

let tmp;
let goalSystem;
let cycleStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'noe-ring2-'));
  initSqlite(join(tmp, 'panel.db'));
  goalSystem = createGoalSystem({});
  cycleStore = new NoeSelfEvolutionCycleStore({ projectId: 'noe' });
});

afterEach(() => {
  close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('环2 集成（真 sqlite + 真 goalSystem + 真 loop）', () => {
  it('observe 真立项（noe_goals）→ tick 真建 Cycle（noe_self_evolution_cycles）→ 落库可读回', async () => {
    let proposed = null;
    const trigger = createNoeSelfEvolutionTrigger({
      goalSystem,
      cycleStore,
      propose: async (input) => { proposed = input; return { ok: true }; },
    });

    const obs = trigger.observe({ objective: '改进自身的期望账本结算率' });
    expect(obs.ok).toBe(true);
    expect(obs.goalId).toBeTruthy();

    const tk = await trigger.tick({ goalId: obs.goalId });
    expect(tk.ok).toBe(true);
    expect(typeof tk.stage).toBe('string');
    // draft cycle 无 validated consensus → loop=consensus_blocked → 不 propose（安全：没共识不改代码）
    expect(tk.proposed).toBe(false);
    expect(proposed).toBeNull();

    const cycle = cycleStore.getByGoal(obs.goalId);
    expect(cycle).toBeTruthy();
    expect(cycle.goalId).toBe(obs.goalId);
  });

  it('防上瘾：第二次 observe 被拦（cooldown 或 open 去重）', () => {
    const trigger = createNoeSelfEvolutionTrigger({ goalSystem, cycleStore, propose: async () => ({ ok: true }) });
    expect(trigger.observe({ objective: '改进自己' }).ok).toBe(true);
    expect(trigger.observe({ objective: '再改进自己' }).ok).toBe(false);
  });

  it('无 cooldown 时仍靠 open 去重拦第二次立项', () => {
    const trigger = createNoeSelfEvolutionTrigger({ goalSystem, cycleStore, propose: async () => ({ ok: true }), cooldownMs: 0 });
    expect(trigger.observe({ objective: '改进自己甲' }).ok).toBe(true);
    const r2 = trigger.observe({ objective: '改进自己乙' });
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe('open_self_evolution_goal_exists');
  });
});
