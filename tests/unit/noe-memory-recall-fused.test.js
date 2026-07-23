import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { createMemorySemanticIndex } from '../../src/memory/NoeMemorySemanticIndex.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

// 波次6 接线测试：FTS × 向量双路融合召回（真 SQLite + 真 hash 嵌入端到端）。
// hash 嵌入确定性：同文本=同向量(cosine=1)，测试可精确断言。

let tmp;
let core;
let semantic;

const flushAsync = () => new Promise((r) => setTimeout(r, 30));   // 等 write 的 fire-and-forget 嵌入落库

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'noe-fused-'));
  initSqlite(join(tmp, 'panel.db'));
  semantic = createMemorySemanticIndex({ provider: 'hash' });
  core = new MemoryCore({ semanticIndex: semantic, logger: null });
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('MemoryCore.recallFused（FusionRanker 双路召回接线）', () => {
  it('semanticIndex 未注入时 recallFused 与 recall 结果一致', async () => {
    const plain = new MemoryCore({ logger: null });
    plain.write({ id: 'a', body: '今天去了紫禁城参观故宫博物院' });
    const fused = await plain.recallFused({ q: '紫禁城', bumpHits: false });
    const direct = plain.recall({ q: '紫禁城', bumpHits: false });
    expect(fused.map((m) => m.id)).toEqual(direct.map((m) => m.id));
  });

  it('双路融合：语义命中(同文本=同向量)排进结果', async () => {
    core.write({ id: 'travel', title: '', body: '今天去了紫禁城参观故宫博物院' });
    core.write({ id: 'ml', title: '', body: '机器学习模型训练笔记与调参心得' });
    await flushAsync();
    const items = await core.recallFused({ q: '机器学习模型训练笔记与调参心得', bumpHits: false });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].id).toBe('ml');   // FTS 与向量双路都命中 ml → RRF 融合后第一
  });

  it('向量补取的记忆重过 project 过滤，不跨项目泄漏', async () => {
    core.write({ id: 'pa', projectId: 'projA', body: '量子计算入门资料整理' });
    core.write({ id: 'pb', projectId: 'projB', body: '量子计算入门资料整理' });
    await flushAsync();
    const items = await core.recallFused({ q: '量子计算入门资料整理', projectId: 'projA', bumpHits: false });
    expect(items.map((m) => m.id)).toContain('pa');
    expect(items.map((m) => m.id)).not.toContain('pb');   // projB 的向量命中被过滤
  });

  it('隐藏记忆不通过向量路泄漏', async () => {
    core.write({ id: 'h1', body: '这是一条会被隐藏的秘密记忆内容' });
    await flushAsync();
    core.hide('h1');
    const items = await core.recallFused({ q: '这是一条会被隐藏的秘密记忆内容', bumpHits: false });
    expect(items.map((m) => m.id)).not.toContain('h1');
  });

  it('semanticIndex.search 抛错 → 优雅退回 FTS 结果', async () => {
    const broken = new MemoryCore({ logger: null, semanticIndex: { search: async () => { throw new Error('embed down'); } } });
    broken.write({ id: 'x', body: '紫禁城的雪景照片整理' });
    const items = await broken.recallFused({ q: '紫禁城', bumpHits: false });
    expect(items.map((m) => m.id)).toContain('x');
  });

  it('bumpHits 默认对融合结果生效', async () => {
    core.write({ id: 'b1', body: '健身计划第三周训练安排' });
    await flushAsync();
    await core.recallFused({ q: '健身计划第三周训练安排' });
    expect(core.get('b1').hitCount).toBe(1);
  });

  it('NOE_MEMORY_DYNAMIC_DECAY=1：时间激活叠入融合排序（新近记忆排在久远记忆前）', async () => {
    const prev = process.env.NOE_MEMORY_DYNAMIC_DECAY;
    process.env.NOE_MEMORY_DYNAMIC_DECAY = '1';
    try {
      core.write({ id: 'recent', body: '相同主题内容用于时间激活测试' });
      core.write({ id: 'stale', body: '相同主题内容用于时间激活测试' });
      await flushAsync();
      // 把 stale 调到 400 天前 → 双相衰减后激活远低于 recent（NoeMemoryDynamics 接入生效的证明）
      const longAgo = Date.now() - 400 * 86400000;
      core.db().prepare('UPDATE noe_memory SET updated_at = ?, last_hit_at = ? WHERE id = ?').run(longAgo, longAgo, 'stale');
      const ids = (await core.recallFused({ q: '相同主题内容用于时间激活测试', bumpHits: false })).map((m) => m.id);
      expect(ids).toContain('recent');
      expect(ids).toContain('stale');
      expect(ids.indexOf('recent')).toBeLessThan(ids.indexOf('stale'));
    } finally {
      if (prev === undefined) delete process.env.NOE_MEMORY_DYNAMIC_DECAY;
      else process.env.NOE_MEMORY_DYNAMIC_DECAY = prev;
    }
  });
});
