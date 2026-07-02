// @ts-check
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';
import { MemoryCore } from '../../src/memory/MemoryCore.js';

// P4 根因B：向量搜索是全库的，用通道小 limit(insight=2) 搜全库 → 小众 scope 的卡被数量占优的 fact/project 挤出 top-N、
//   scope 过滤后净贡献≈0。NOE_MEMORY_VECTOR_POOL=1 让向量路 over-fetch 更大候选池，融合+scope 过滤后再截 limit。
describe('MemoryCore.recallFused 向量 over-fetch（P4 根因B：小众 scope 召回）', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'noe-vecpool-')); initSqlite(join(dir, 'panel.db')); });
  afterEach(() => { try { close(); } catch { /* ignore */ } rmSync(dir, { recursive: true, force: true }); delete process.env.NOE_MEMORY_VECTOR_POOL; });

  function spySearchIndex() {
    const seen = { searchLimit: null };
    return { seen, search: async (_q, opts) => { seen.searchLimit = opts?.limit; return []; }, remove: () => {}, upsert: () => {}, add: () => {} };
  }

  it('NOE_MEMORY_VECTOR_POOL=1：向量 search 收到 over-fetch 大池(≥50)，而非通道 limit=2', async () => {
    process.env.NOE_MEMORY_VECTOR_POOL = '1';
    const si = spySearchIndex();
    const memory = new MemoryCore({ semanticIndex: si });
    memory.write({ id: 'k1', projectId: 'noe', scope: 'insight', body: '抽象洞见卡' });
    await memory.recallFused({ q: 'insight 抽象洞见', projectId: 'noe', scope: 'insight', limit: 2 });
    expect(si.seen.searchLimit).toBeGreaterThanOrEqual(50);
  });

  it('flag OFF：vectorPool=limit 逐字零回归（search 收到原 limit=2）', async () => {
    delete process.env.NOE_MEMORY_VECTOR_POOL;
    const si = spySearchIndex();
    const memory = new MemoryCore({ semanticIndex: si });
    memory.write({ id: 'k1', projectId: 'noe', scope: 'insight', body: '抽象洞见卡' });
    await memory.recallFused({ q: 'insight 抽象洞见', projectId: 'noe', scope: 'insight', limit: 2 });
    expect(si.seen.searchLimit).toBe(2);
  });

  it('over-fetch 后最终结果仍按 limit 截断（scope 过滤后不超 limit）', async () => {
    process.env.NOE_MEMORY_VECTOR_POOL = '1';
    // search 返回多张 insight 卡的 refId，验证融合+scope 过滤后截到 limit
    const ids = ['i1', 'i2', 'i3', 'i4', 'i5'];
    const si = {
      search: async () => ids.map((id, n) => ({ refId: id, score: 1 - n * 0.1 })),
      remove: () => {}, upsert: () => {}, add: () => {},
    };
    const memory = new MemoryCore({ semanticIndex: si });
    for (const id of ids) memory.write({ id, projectId: 'noe', scope: 'insight', body: `洞见${id}` });
    const out = await memory.recallFused({ q: '洞见', projectId: 'noe', scope: 'insight', limit: 2 });
    expect(out.length).toBeLessThanOrEqual(2);
  });
});
