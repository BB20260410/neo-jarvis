import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initSqlite, close } from '../../src/storage/SqliteStore.js';
import { createGoalSystem } from '../../src/cognition/NoeGoalSystem.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'noe-gdw-')); initSqlite(join(dir, 'panel.db')); });
afterEach(() => { close(); rmSync(dir, { recursive: true, force: true }); });

const T0 = 1_780_000_000_000;

describe('M15 驱力权重浮动 + M14防膨胀上限', () => {
  it('drive 源目标优先级随驱力强度浮动（想要越强→越优先）', () => {
    let level = 0;
    const gs = createGoalSystem({ now: () => T0, driveLevel: () => level });
    const id = gs.add({ title: '驱力目标', source: 'drive', steps: ['a'] });
    gs.arbitrate(T0);
    const pLow = gs.get(id).priority;
    level = 1; // 同一目标、驱力变强后重新仲裁
    gs.arbitrate(T0);
    expect(gs.get(id).priority).toBeGreaterThan(pLow);
  });

  it('driveLevel 探针抛错 → 回静态档不崩', () => {
    const gs = createGoalSystem({ now: () => T0, driveLevel: () => { throw new Error('x'); } });
    const id = gs.add({ title: '驱力目标', source: 'drive', steps: ['a'] });
    expect(() => gs.arbitrate(T0)).not.toThrow();
    expect(gs.get(id).priority).toBeGreaterThan(0);
  });

  it('自生目标积压达上限不再收，owner 永远收', () => {
    const gs = createGoalSystem({ now: () => T0, maxBacklog: 3 });
    expect(gs.add({ title: '自生1', source: 'reflection' })).toBeTruthy();
    expect(gs.add({ title: '自生2', source: 'drive' })).toBeTruthy();
    expect(gs.add({ title: '自生3', source: 'self' })).toBeTruthy();
    expect(gs.add({ title: '自生4', source: 'reflection' })).toBe(null); // 满了
    expect(gs.add({ title: '主人交办', source: 'owner' })).toBeTruthy(); // owner 不受限
  });
});
