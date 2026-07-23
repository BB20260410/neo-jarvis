// VectorIndex 续审修复测试（§续审 P0 dim 过滤 + P1 statement 缓存）
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { upsertEmbedding, semanticSearch, deleteEmbedding, listEmbeddings } from '../../src/embeddings/VectorIndex.js';
import { close, initSqlite, getDb } from '../../src/storage/SqliteStore.js';

let tmp;
beforeEach(() => { close(); tmp = mkdtempSync(join(tmpdir(), 'noe-vec-')); initSqlite(join(tmp, 'panel.db')); });
afterEach(() => { close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = null; });

describe('VectorIndex 续审 P0/P1', () => {
  it('upsert + semanticSearch 端到端（hash provider 确定性）', async () => {
    await upsertEmbedding({ kind: 'mem', refId: 'a', text: '今天天气很好适合爬山' });
    await upsertEmbedding({ kind: 'mem', refId: 'b', text: '股票市场行情分析报告' });
    const hits = await semanticSearch('今天天气很好适合爬山', { kind: 'mem', limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].refId).toBe('a'); // 与 query 完全相同的 a 应排第一
  });

  it('P0 dim 过滤：search 只返回与 query 同维的向量（异维不解码不返回）', async () => {
    await upsertEmbedding({ kind: 'mem', refId: 'h128', text: '一二三四五六七八九十' }); // hash 固定 128 维
    // 手动插一条 256 维异维向量（模拟 provider 切换后的旧向量）
    const fakeVec = Buffer.alloc(256 * 4);
    getDb().prepare('INSERT INTO embeddings(kind, ref_id, text, vector, dim, model) VALUES (?,?,?,?,?,?)')
      .run('mem', 'odd256', 'x', fakeVec, 256, 'fake');
    const hits = await semanticSearch('一二三四五六七八九十', { kind: 'mem', limit: 10 });
    expect(hits.map((h) => h.refId)).toContain('h128');
    expect(hits.map((h) => h.refId)).not.toContain('odd256'); // 异维被 SQL dim 过滤掉
  });

  it('P1 statement 缓存：切库后 upsert/search 不报错（按 db 实例失效重建）', async () => {
    await upsertEmbedding({ kind: 'mem', refId: 'x', text: '旧库测试内容' });
    const tmp2 = mkdtempSync(join(tmpdir(), 'noe-vec2-'));
    try {
      close();
      initSqlite(join(tmp2, 'panel.db')); // 切到新库（旧 statement 随旧连接失效）
      await expect(upsertEmbedding({ kind: 'mem', refId: 'y', text: '新库测试内容' })).resolves.toMatchObject({ ok: true });
      const hits = await semanticSearch('新库测试内容', { kind: 'mem' });
      expect(hits.map((h) => h.refId)).toContain('y');
      expect(hits.map((h) => h.refId)).not.toContain('x'); // x 只在旧库
    } finally {
      close();
      rmSync(tmp2, { recursive: true, force: true });
      initSqlite(join(tmp, 'panel.db')); // 复原供 afterEach
    }
  });

  it('deleteEmbedding + listEmbeddings', async () => {
    await upsertEmbedding({ kind: 'mem', refId: 'd1', text: 'aaa内容' });
    await upsertEmbedding({ kind: 'mem', refId: 'd2', text: 'bbb内容' });
    expect(listEmbeddings({ kind: 'mem' }).length).toBe(2);
    expect(deleteEmbedding({ kind: 'mem', refId: 'd1' })).toBe(1);
    expect(listEmbeddings({ kind: 'mem' }).length).toBe(1);
  });
});
