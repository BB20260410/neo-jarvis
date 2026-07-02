// 锁住「provider 换维度后旧记忆被 dim 过滤、零命中却静默」回归洞：
// 修复前 semanticSearch/semanticSearchVectors 在全异维库返回空、无任何告警 → 本测试断言 console.warn 必有可观测信号。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { upsertEmbedding, semanticSearch, semanticSearchVectors, getDimMismatchHealth, resetDimMismatchHealth } from '../../src/embeddings/VectorIndex.js';
import { close, initSqlite, getDb } from '../../src/storage/SqliteStore.js';

let tmp;
beforeEach(() => { close(); resetDimMismatchHealth(); tmp = mkdtempSync(join(tmpdir(), 'noe-vecwarn-')); initSqlite(join(tmp, 'panel.db')); });
afterEach(() => { vi.restoreAllMocks(); close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = null; });

// 直接插一条异维(768)向量，模拟 provider 切换后只剩旧维度记忆；hash 查询固定 128 维 → SQL dim=128 命中 0 行
function insertOddDim(refId, dim) {
  const buf = Buffer.alloc(dim * 4);
  for (let i = 0; i < dim; i++) buf.writeFloatLE(0.01, i * 4);
  getDb().prepare('INSERT INTO embeddings(kind, ref_id, text, vector, dim, model) VALUES (?,?,?,?,?,?)')
    .run('noe_memory', refId, 'x', buf, dim, 'ollama-768');
}

describe('VectorIndex 维度不匹配静默丢召回回归', () => {
  it('全异维库 + semanticSearch 零命中时必有可观测告警（修复前：无告警）', async () => {
    insertOddDim('old1', 768);
    insertOddDim('old2', 768);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hits = await semanticSearch('我去年去过日本旅行', { kind: 'noe_memory', limit: 10 });
    expect(hits.length).toBe(0); // 异维被 SQL 过滤掉，零命中（既有优化行为不变）
    const warned = warnSpy.mock.calls.map((c) => c.join(' ')).join('|');
    expect(warned).toContain('[noe-vector]');
    expect(warned).toContain('维度不匹配');
    expect(warned).toContain('backfill');
  });

  it('semanticSearchVectors 同样在全异维零命中时告警', async () => {
    insertOddDim('old1', 1024);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await semanticSearchVectors('随便查点啥', { kind: 'noe_memory', limit: 5 });
    expect(r.hits.length).toBe(0);
    const warned = warnSpy.mock.calls.map((c) => c.join(' ')).join('|');
    expect(warned).toContain('[noe-vector]');
  });

  it('空库零命中不告警（避免噪声：没记忆≠维度 bug）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hits = await semanticSearch('空库查询', { kind: 'noe_memory' });
    expect(hits.length).toBe(0);
    expect(warnSpy.mock.calls.length).toBe(0);
  });

  it('有同维记忆的正常查询：命中且不告警（不破坏正常路径）', async () => {
    await upsertEmbedding({ kind: 'noe_memory', refId: 'same', text: '今天天气很好适合爬山' }); // hash 128 维
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hits = await semanticSearch('今天天气很好适合爬山', { kind: 'noe_memory', limit: 5, minScore: 0 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].refId).toBe('same');
    expect(warnSpy.mock.calls.length).toBe(0); // 同维正常命中不打扰
  });

  it('节流：同 kind|dim 60s 内重复零命中只告警一次', async () => {
    insertOddDim('old1', 768);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await semanticSearch('查询一', { kind: 'noe_memory' });
    await semanticSearch('查询二', { kind: 'noe_memory' });
    await semanticSearch('查询三', { kind: 'noe_memory' });
    const vecWarns = warnSpy.mock.calls.map((c) => c.join(' ')).filter((s) => s.includes('[noe-vector]'));
    expect(vecWarns.length).toBe(1); // 高频对话不刷屏
  });

  it('P0-B v4: 孤儿事件计数不受 60s 节流（delta）+ 记 lastOrphanEvent', async () => {
    insertOddDim('old1', 1024);
    const before = getDimMismatchHealth().orphanEventCount;
    await semanticSearch('查询一', { kind: 'noe_memory' });
    await semanticSearch('查询二', { kind: 'noe_memory' }); // 60s 内：console.warn 被节流，但事件计数继续累计
    const h = getDimMismatchHealth();
    expect(h.orphanEventCount - before).toBe(2); // 不被节流稀释（区别于 console.warn 只 1 次）
    expect(h.lastOrphanEvent.queryDim).toBe(128); // 默认 hash 查询 128 维
    expect(h.lastOrphanEvent.storedDims).toContain('1024');
    expect(h.lastOrphanEvent.fallbackDuringQuery).toBe(false); // 默认 hash provider 非 ollama fallback
  });

  it('P0-B v4: 同维查询不算孤儿（反向 probe）', async () => {
    await upsertEmbedding({ kind: 'noe_memory', refId: 'same', text: '今天天气很好' }); // hash 128 维
    resetDimMismatchHealth();
    await semanticSearch('今天天气很好', { kind: 'noe_memory', minScore: 0 });
    expect(getDimMismatchHealth().orphanEventCount).toBe(0); // 同维命中不算黑洞
  });

  it('P0-B v4: resetDimMismatchHealth 清零', async () => {
    insertOddDim('old1', 768);
    await semanticSearch('q', { kind: 'noe_memory' });
    expect(getDimMismatchHealth().orphanEventCount).toBeGreaterThan(0);
    resetDimMismatchHealth();
    const h = getDimMismatchHealth();
    expect(h.orphanEventCount).toBe(0);
    expect(h.lastOrphanEvent).toBe(null);
  });

  it('P0-B v4: buildNoeMemoryStatus 暴露 dimHealth + dims 分布（mixedDim）', async () => {
    const { buildNoeMemoryStatus } = await import('../../src/memory/NoeMemoryStatus.js');
    insertOddDim('a', 1024);
    insertOddDim('b', 128);
    const st = buildNoeMemoryStatus({ env: {} }); // env 无语义配置 → disabled 分支
    expect(st.semanticProvider.dimHealth).toBeTruthy();
    expect(st.semanticProvider.dimHealth.mixedDim).toBe(true); // 库内 1024+128 两种维度
    expect(Object.keys(st.semanticProvider.dimHealth.dims)).toEqual(expect.arrayContaining(['1024', '128']));
  });
});
