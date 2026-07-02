// @ts-check
// P1 attend 保底配额——治 system_repair 垄断 active 队列、饿死 self_learning/research。
// flag NOE_ATTEND_LEARNING_QUOTA 门控，默认 OFF（逐字零回归）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initSqlite, close } from '../../src/storage/SqliteStore.js';
import { createGoalSystem } from '../../src/cognition/NoeGoalSystem.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'noe-quota-')); initSqlite(join(dir, 'panel.db')); });
afterEach(() => { close(); rmSync(dir, { recursive: true, force: true }); });

const T0 = 1_700_000_000_000;

// 2 个 system_repair(权重 0.95 高) + 1 个 self_learning(0.65 低)——模拟 system_repair 霸占
function seedRepairHeavy(gs) {
  gs.add({ title: '系统自修复A', source: 'system_repair', steps: [{ step: '只读诊断', kind: 'act' }] });
  gs.add({ title: '系统自修复B', source: 'system_repair', steps: [{ step: '只读诊断', kind: 'act' }] });
  gs.add({ title: '自主学习X', source: 'self_learning', steps: [{ step: '上网搜索', kind: 'research' }] });
}

describe('P1 attend 保底配额（NOE_ATTEND_LEARNING_QUOTA）', () => {
  it('flag ON：system_repair 霸占下仍保底给学习类 1 个 active 名额', () => {
    const gs = createGoalSystem({ now: () => T0, maxActive: 2, attendLearningQuota: true });
    seedRepairHeavy(gs);
    gs.arbitrate(T0);
    const active = gs.list({ status: 'active' });
    expect(active.length).toBe(2);
    expect(active.some((g) => g.source === 'self_learning')).toBe(true); // 学习类保底进了
    expect(active.filter((g) => g.source === 'system_repair').length).toBe(1); // system_repair 让出 1 个
  });

  it('flag OFF（默认）：纯优先级，system_repair 霸占 active、self_learning 落 open（零回归）', () => {
    const gs = createGoalSystem({ now: () => T0, maxActive: 2, attendLearningQuota: false });
    seedRepairHeavy(gs);
    gs.arbitrate(T0);
    const active = gs.list({ status: 'active' });
    expect(active.length).toBe(2);
    expect(active.every((g) => g.source === 'system_repair')).toBe(true);
    expect(gs.list({ status: 'open' }).some((g) => g.source === 'self_learning')).toBe(true);
  });

  it('flag ON 但无学习类候选 → 不浪费名额，行为同纯优先级', () => {
    const gs = createGoalSystem({ now: () => T0, maxActive: 2, attendLearningQuota: true });
    gs.add({ title: '修复A', source: 'system_repair', steps: [{ step: 'x', kind: 'act' }] });
    gs.add({ title: '修复B', source: 'system_repair', steps: [{ step: 'x', kind: 'act' }] });
    gs.add({ title: '修复C', source: 'system_repair', steps: [{ step: 'x', kind: 'act' }] });
    gs.arbitrate(T0);
    const active = gs.list({ status: 'active' });
    expect(active.length).toBe(2);
    expect(active.every((g) => g.source === 'system_repair')).toBe(true);
  });
});
