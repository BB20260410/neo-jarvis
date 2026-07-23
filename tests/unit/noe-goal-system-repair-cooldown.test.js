// @ts-check
// P1-A system_repair 冷却去重——治 IncidentEscalator 反复检测同一故障→done→重立同 title 的刷量(实证 92/24h)。
// flag NOE_SYSTEM_REPAIR_COOLDOWN_MS 门控，默认 0=关（逐字零回归）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initSqlite, close } from '../../src/storage/SqliteStore.js';
import { createGoalSystem } from '../../src/cognition/NoeGoalSystem.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'noe-repair-cd-')); initSqlite(join(dir, 'panel.db')); });
afterEach(() => { close(); rmSync(dir, { recursive: true, force: true }); });

const T0 = 1_700_000_000_000;

describe('P1-A system_repair 冷却去重（NOE_SYSTEM_REPAIR_COOLDOWN_MS）', () => {
  it('冷却 ON：同 title system_repair 在冷却窗内(即便上一条已 done)不重立', () => {
    const gs = createGoalSystem({ now: () => T0, repairCooldownMs: 3600_000 });
    const id1 = gs.add({ title: '系统自修复：系统运行', source: 'system_repair', steps: [{ step: '诊断', kind: 'act' }] });
    expect(id1).toBeTruthy();
    gs.setStatus(id1, 'done'); // 诊断步跑完、goal 收口（现状：done 后去重不挡）
    const id2 = gs.add({ title: '系统自修复：系统运行', source: 'system_repair', steps: [{ step: '诊断', kind: 'act' }] });
    expect(id2).toBe(null); // 冷却窗内不重立 → 砍掉反复刷量
  });

  it('冷却 OFF（默认 0）：done 后同 title 可重立（逐字零回归）', () => {
    const gs = createGoalSystem({ now: () => T0, repairCooldownMs: 0 });
    const id1 = gs.add({ title: '系统自修复：X', source: 'system_repair', steps: [{ step: 'x', kind: 'act' }] });
    gs.setStatus(id1, 'done');
    const id2 = gs.add({ title: '系统自修复：X', source: 'system_repair', steps: [{ step: 'x', kind: 'act' }] });
    expect(id2).toBeTruthy();
  });

  it('冷却 ON 但冷却窗已过：同 title 可重立（不永久封禁，真故障复发仍能立）', () => {
    let t = T0;
    const gs = createGoalSystem({ now: () => t, repairCooldownMs: 3600_000 });
    const id1 = gs.add({ title: '系统自修复：Y', source: 'system_repair', steps: [{ step: 'x', kind: 'act' }] });
    gs.setStatus(id1, 'done');
    t = T0 + 3600_000 + 1; // 冷却窗过后
    const id2 = gs.add({ title: '系统自修复：Y', source: 'system_repair', steps: [{ step: 'x', kind: 'act' }] });
    expect(id2).toBeTruthy();
  });

  it('冷却 ON 只管 system_repair：self_learning 等别的 source 不受影响', () => {
    const gs = createGoalSystem({ now: () => T0, repairCooldownMs: 3600_000 });
    const id1 = gs.add({ title: '学习X', source: 'self_learning', steps: [{ step: 'x', kind: 'research' }] });
    gs.setStatus(id1, 'done');
    const id2 = gs.add({ title: '学习X', source: 'self_learning', steps: [{ step: 'x', kind: 'research' }] });
    expect(id2).toBeTruthy();
  });
});
