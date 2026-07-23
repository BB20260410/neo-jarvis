import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite, getDb } from '../../src/storage/SqliteStore.js';
import { createGoalSystem } from '../../src/cognition/NoeGoalSystem.js';

// 底层改造验证：迁移 v12 给 noe_goals 加 meta 列（幂等）+ add() 能持久化 meta + rowOut 解析回 object。
// 不触网/不碰时钟/不用 RNG/不调真模型——纯 sqlite + 注入。

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'noe-goal-meta-'));
  initSqlite(join(tmp, 'panel.db'));
});
afterEach(() => {
  close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('noe_goals.meta 列（迁移 v12）+ add meta 持久化', () => {
  it('迁移后 noe_goals 真有 meta 列', () => {
    const cols = new Set(getDb().prepare("PRAGMA table_info(noe_goals)").all().map((c) => c.name));
    expect(cols.has('meta')).toBe(true);
  });

  it('add 不传 meta → meta 列为 NULL（零回归：旧调用形态不写 meta）', () => {
    const gs = createGoalSystem({});
    const id = gs.add({ title: '普通目标', source: 'self' });
    expect(id).toBeTruthy();
    const raw = getDb().prepare('SELECT meta FROM noe_goals WHERE id = ?').get(id);
    expect(raw.meta).toBe(null);
    // rowOut 不传 meta 时不应凭空造出非 null 字段
    const g = gs.get(id);
    expect(g.meta).toBe(null);
  });

  it('add 传 meta → JSON 持久化，get/list 解析回同构 object', () => {
    const gs = createGoalSystem({});
    const meta = { curiosity: { score: 0.62, epistemic: 0.9, pragmatic: 0.34, label: 'epistemic' } };
    const id = gs.add({ title: '带元信息目标', source: 'surprise', meta });
    expect(id).toBeTruthy();
    const g = gs.get(id);
    expect(g.meta).toEqual(meta);
    const fromList = gs.list({ status: 'open', limit: 50 }).find((x) => x.id === id);
    expect(fromList.meta).toEqual(meta);
  });

  it('meta 列损坏（非法 JSON）→ rowOut 退化为 null，不抛（fail-open）', () => {
    const gs = createGoalSystem({});
    const id = gs.add({ title: '将被注入坏 meta', source: 'self' });
    getDb().prepare('UPDATE noe_goals SET meta = ? WHERE id = ?').run('{not-json', id);
    expect(() => gs.get(id)).not.toThrow();
    expect(gs.get(id).meta).toBe(null);
  });

  it('记一步推进不会抹掉 meta（StepRecorder 只改 plan/status，不碰 meta）', () => {
    const gs = createGoalSystem({});
    const meta = { curiosity: { score: 0.7, label: 'balanced' } };
    const id = gs.add({ title: '推进后 meta 仍在', source: 'surprise', steps: ['第一步'], meta });
    const res = gs.recordStepResult(id, 0, { note: '做了', done: true });
    expect(res.ok).toBe(true);
    expect(gs.get(id).meta).toEqual(meta);
  });
});
