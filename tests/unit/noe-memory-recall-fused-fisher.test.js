import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

// NOE_MEMORY_FISHER_RANK 接线测试：证明开关 ON 时 recallFused 的向量名次真的走 Fisher-Rao 重排
//（不是 OFF 恒等假融入），且 OFF / 无 searchVectors / 抛错时逐字退回旧 cosine 名次路径。
//
// 用注入式 stub semanticIndex 精确控制两路命中与向量/方差，做确定性断言（不依赖真嵌入精度）。

let tmp;

const nz = (v) => {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};

// 构造一个「cosine 名次 A>B，但带方差后 Fisher-Rao 名次 B>A」的 stub。
// search()（旧路径）：按 cosine 给分(A 在前)。
// searchVectors()（新路径）：返回带向量+方差的命中，让 reranker 能翻转。
function makeFlipStub() {
  const q = nz([1, 0, 0, 0]);
  const A = nz([0.96, 0.28, 0, 0]);
  const B = nz([0.9, 0.436, 0, 0]);
  return {
    provider: 'stub',
    calls: { search: 0, searchVectors: 0 },
    async search() {
      this.calls.search += 1;
      // cosine: A 比 B 高 → 旧路径 A 在前
      return [
        { refId: 'A', score: 0.96 },
        { refId: 'B', score: 0.9 },
      ];
    },
    async searchVectors() {
      this.calls.searchVectors += 1;
      return {
        queryVector: q,
        queryVariance: 0.05,
        hits: [
          { refId: 'A', vector: A, variance: 0.001 }, // 过度自信 → Fisher-Rao 惩罚
          { refId: 'B', vector: B, variance: 0.5 }, // 宽容 → Fisher-Rao 抬升
        ],
      };
    },
  };
}

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'noe-fisher-fused-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

// 写两条仅 FTS 都不命中查询的记忆，让融合名次完全由向量路决定（隔离被测变量）。
function seedAB(core) {
  core.write({ id: 'A', body: 'alpha 记忆甲 内容互不相同 zzz' });
  core.write({ id: 'B', body: 'beta 记忆乙 内容互不相同 yyy' });
}

describe('recallFused × NOE_MEMORY_FISHER_RANK（ON 端到端 + OFF 零回归）', () => {
  it('ON：fisherRank 开启 → 向量名次走 Fisher-Rao 重排，结果顺序翻转为 B>A（真生效证据）', async () => {
    const stub = makeFlipStub();
    const core = new MemoryCore({ logger: null, semanticIndex: stub, fisherRank: { enabled: true } });
    seedAB(core);
    const ids = (await core.recallFused({ q: '无关查询触发向量路 qqq', bumpHits: false })).map((m) => m.id);
    expect(ids).toEqual(['B', 'A']); // Fisher-Rao 翻转：B 在前
    expect(stub.calls.searchVectors).toBeGreaterThan(0); // 确实走了新路径
  });

  it('OFF：默认(不开关) → 走旧 cosine 名次，顺序为 A>B，且不调用 searchVectors（零回归）', async () => {
    const stub = makeFlipStub();
    const core = new MemoryCore({ logger: null, semanticIndex: stub }); // fisherRank 默认 OFF
    seedAB(core);
    const ids = (await core.recallFused({ q: '无关查询触发向量路 qqq', bumpHits: false })).map((m) => m.id);
    expect(ids).toEqual(['A', 'B']); // 旧 cosine 名次
    expect(stub.calls.searchVectors).toBe(0); // 旧路径根本不碰 searchVectors
    expect(stub.calls.search).toBeGreaterThan(0);
  });

  it('ON 但 semanticIndex 无 searchVectors → 优雅退回旧 search 名次(A>B)，不抛错', async () => {
    const stub = makeFlipStub();
    delete stub.searchVectors; // 老 semanticIndex（无新方法）
    const core = new MemoryCore({ logger: null, semanticIndex: stub, fisherRank: { enabled: true } });
    seedAB(core);
    const ids = (await core.recallFused({ q: '无关查询触发向量路 qqq', bumpHits: false })).map((m) => m.id);
    expect(ids).toEqual(['A', 'B']);
  });

  it('ON 但 searchVectors 抛错 → 退回旧 search 名次(A>B)，不抛错', async () => {
    const stub = makeFlipStub();
    stub.searchVectors = async () => { throw new Error('vectors down'); };
    const core = new MemoryCore({ logger: null, semanticIndex: stub, fisherRank: { enabled: true } });
    seedAB(core);
    const ids = (await core.recallFused({ q: '无关查询触发向量路 qqq', bumpHits: false })).map((m) => m.id);
    expect(ids).toEqual(['A', 'B']);
  });

  it('ON 但 searchVectors 返回空 hits → 退回旧 search 名次(A>B)', async () => {
    const stub = makeFlipStub();
    stub.searchVectors = async () => ({ queryVector: nz([1, 0, 0, 0]), hits: [] });
    const core = new MemoryCore({ logger: null, semanticIndex: stub, fisherRank: { enabled: true } });
    seedAB(core);
    const ids = (await core.recallFused({ q: '无关查询触发向量路 qqq', bumpHits: false })).map((m) => m.id);
    expect(ids).toEqual(['A', 'B']);
  });

  it('env NOE_MEMORY_FISHER_RANK=1 同样开启(与注入等价)', async () => {
    const prev = process.env.NOE_MEMORY_FISHER_RANK;
    process.env.NOE_MEMORY_FISHER_RANK = '1';
    try {
      const stub = makeFlipStub();
      const core = new MemoryCore({ logger: null, semanticIndex: stub }); // 不注入，靠 env
      seedAB(core);
      const ids = (await core.recallFused({ q: '无关查询触发向量路 qqq', bumpHits: false })).map((m) => m.id);
      expect(ids).toEqual(['B', 'A']);
    } finally {
      if (prev === undefined) delete process.env.NOE_MEMORY_FISHER_RANK;
      else process.env.NOE_MEMORY_FISHER_RANK = prev;
    }
  });
});
