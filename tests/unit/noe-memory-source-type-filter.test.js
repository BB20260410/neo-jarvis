// @ts-check
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, getDb, initSqlite } from '../../src/storage/SqliteStore.js';
import { MemoryCore } from '../../src/memory/MemoryCore.js';

// P4 codex#10：recall/recallFused 原生 source_type 过滤（默认不传=零回归），治「深思/对话召回先按 limit 取再事后过滤
//   lesson → 前 N 个不是 lesson 则 learning_lesson/技能卡永远进不来」。让召回时直接圈定 sourceType。
describe('MemoryCore recall source_type 过滤（P4 codex#10）', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'noe-srctype-')); initSqlite(join(dir, 'panel.db')); });
  afterEach(() => { try { close(); } catch { /* ignore */ } rmSync(dir, { recursive: true, force: true }); });

  function seed(memory) {
    memory.write({ id: 'lesson1', projectId: 'noe', scope: 'insight', sourceType: 'learning_lesson', body: 'agent memory 认知修正一' });
    memory.write({ id: 'skill1', projectId: 'noe', scope: 'project', sourceType: 'skill_distill', body: 'agent memory 技能卡一' });
    memory.write({ id: 'fact1', projectId: 'noe', scope: 'fact', sourceType: 'fact_extract', body: 'agent memory 事实一' });
  }

  it('sourceTypes 圈定（LIKE 路）：只返回指定 source_type 的卡', () => {
    const memory = new MemoryCore();
    seed(memory);
    const out = memory.recall({ projectId: 'noe', q: 'agent memory', useFts: false, sourceTypes: ['learning_lesson', 'skill_distill'], bumpHits: false });
    const types = out.map((m) => m.sourceType);
    expect(types).toContain('learning_lesson');
    expect(types).toContain('skill_distill');
    expect(types).not.toContain('fact_extract');
  });

  it('sourceTypes 圈定（FTS 路）：只返回指定 source_type 的卡', () => {
    const memory = new MemoryCore();
    seed(memory);
    const out = memory.recall({ projectId: 'noe', q: 'agent memory', sourceTypes: ['learning_lesson'], bumpHits: false });
    for (const m of out) expect(m.sourceType).toBe('learning_lesson');
    expect(out.some((m) => m.sourceType === 'learning_lesson')).toBe(true);
  });

  it('不传 sourceTypes = 逐字零回归（返回所有 source_type）', () => {
    const memory = new MemoryCore();
    seed(memory);
    const out = memory.recall({ projectId: 'noe', q: 'agent memory', useFts: false, bumpHits: false });
    expect(out.length).toBe(3);
  });

  it('recallFused 向量路补取也按 sourceTypes 过滤（不混入非指定类型）', async () => {
    // 向量返回三卡 refId，验证 sourceTypes 过滤只保留 learning_lesson
    const semanticIndex = {
      search: async () => [{ refId: 'lesson1', score: 0.9 }, { refId: 'skill1', score: 0.8 }, { refId: 'fact1', score: 0.7 }],
      remove: () => {}, upsert: () => {}, add: () => {},
    };
    const memory = new MemoryCore({ semanticIndex });
    seed(memory);
    const out = await memory.recallFused({ projectId: 'noe', q: 'agent memory', sourceTypes: ['learning_lesson'], limit: 5, bumpHits: false });
    for (const m of out) expect(m.sourceType).toBe('learning_lesson');
  });

  it('FTS 异常 fallback 到 LIKE 时仍按 sourceTypes 过滤（Claude 互评 SERIOUS 回归：原 fallback 漏传 sourceTypes）', () => {
    const memory = new MemoryCore();
    seed(memory);
    // 破坏 FTS 表 → #recallFts catch → fallback #recallLike，验证 sourceTypes 仍生效（修复前会返回全部 3 类）
    getDb().exec('DROP TABLE IF EXISTS noe_memory_fts');
    const out = memory.recall({ projectId: 'noe', q: 'agent memory', sourceTypes: ['learning_lesson'], bumpHits: false });
    expect(out.some((m) => m.sourceType === 'learning_lesson')).toBe(true);
    for (const m of out) expect(m.sourceType).toBe('learning_lesson');
  });

  it('不传 sourceTypes(FTS 路) = 零回归（返回所有 source_type）', () => {
    const memory = new MemoryCore();
    seed(memory);
    const out = memory.recall({ projectId: 'noe', q: 'agent memory', bumpHits: false });
    expect(out.length).toBe(3);
  });
});
