// @ts-check
// 锁住「semanticSearch/semanticSearchVectors 语义检索的 (dim,kind) 复合索引」优化：
//   修复前 `WHERE dim=?`（无 kind）走全表 SCAN、`WHERE dim=? AND kind=?` 走全 kind 扫后再过滤 dim，
//   随 NOE_MEMORY_EMBED=ollama 生产开启、记忆涨大每轮对话 O(N)。加 idx_embeddings_dim_kind 后转 index seek。
// 本测试硬约束：①优化是真的（EXPLAIN 命中 SEARCH...USING INDEX 而非 SCAN）；
//   ②【结果等价】优化后命中集 + 排序与「未优化的暴力 JS 参考实现（全表解码 + cosine）」逐字一致——
//   只更快、不改任何行为；③大库不崩、kind-only/混维路径正确。确定性：hash provider 不触网。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { upsertEmbedding, semanticSearch, semanticSearchVectors } from '../../src/embeddings/VectorIndex.js';
import { close, initSqlite, getDb } from '../../src/storage/SqliteStore.js';
import { embed, cosineSim } from '../../src/embeddings/EmbeddingProvider.js';

let tmp;
beforeEach(() => { close(); tmp = mkdtempSync(join(tmpdir(), 'noe-vecidx-')); initSqlite(join(tmp, 'panel.db')); });
afterEach(() => { close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = null; });

// 未优化的暴力参考：复刻旧 semanticSearch 语义（SQL 取全表 → JS 全解码 + cosine → 降序 → minScore → limit），
// 但【不依赖任何索引】（强制 NOT INDEXED 走全表），作为「优化前结果」的黄金基准与优化后逐字比对。
function bufToVec(buf) {
  const n = buf.length / 4;
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) v[i] = buf.readFloatLE(i * 4);
  return v;
}
async function bruteSearch(query, { kind, limit = 10, minScore = 0 } = {}) {
  const { vector: qv } = await embed(query, { provider: 'hash' });
  const rows = getDb().prepare('SELECT id, kind, ref_id, text, vector, dim, model FROM embeddings NOT INDEXED').all();
  const scored = rows
    .filter((r) => r.dim === qv.length && (!kind || r.kind === kind)) // 复刻 SQL 的 dim/kind 过滤语义
    .map((r) => ({ id: r.id, kind: r.kind, refId: r.ref_id, text: r.text, model: r.model, score: cosineSim(bufToVec(r.vector), qv) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score >= minScore).slice(0, limit);
}

describe('VectorIndex (dim,kind) 复合索引：优化真实 + 结果等价', () => {
  it('索引已建（schema 幂等创建 idx_embeddings_dim_kind，且保留 kind-only 索引）', () => {
    const names = getDb().prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='embeddings'").all().map((r) => r.name);
    expect(names).toContain('idx_embeddings_dim_kind'); // 新增的复合索引
    expect(names).toContain('idx_embeddings_kind'); // kind-only 查询（listEmbeddings/deleteEmbedding）仍需，不能被替代
  });

  it('优化是真的：两种查询形态都走 index SEARCH 而非全表 SCAN', () => {
    const db = getDb();
    const withKind = db.prepare('EXPLAIN QUERY PLAN SELECT id, vector FROM embeddings WHERE dim = ? AND kind = ?').all(128, 'noe_memory');
    const noKind = db.prepare('EXPLAIN QUERY PLAN SELECT id, vector FROM embeddings WHERE dim = ?').all(128);
    const detail = (rows) => rows.map((r) => r.detail).join(' | ');
    // SQLite EXPLAIN：用上索引为 "SEARCH ... USING INDEX"，全表扫为 "SCAN"
    expect(detail(withKind)).toMatch(/SEARCH .*USING (COVERING )?INDEX idx_embeddings_dim_kind/);
    expect(detail(withKind)).not.toMatch(/\bSCAN\b/);
    expect(detail(noKind)).toMatch(/SEARCH .*USING (COVERING )?INDEX idx_embeddings_dim_kind/);
    expect(detail(noKind)).not.toMatch(/\bSCAN\b/);
  });

  it('结果等价（带 kind）：优化后 semanticSearch 命中集与排序 = 暴力全表参考实现', async () => {
    // 构造混 kind + 混维数据：noe_memory 同维(128) + noe_memory 异维(256) + 其他 kind
    for (let i = 0; i < 40; i++) await upsertEmbedding({ kind: 'noe_memory', refId: `m${i}`, text: `记忆内容编号${i}今天天气与心情` });
    for (let i = 0; i < 10; i++) await upsertEmbedding({ kind: 'other', refId: `o${i}`, text: `其他类别内容${i}` });
    // 手插异维行（模拟 provider 切换后的旧向量），应被 dim 过滤掉、两条路径都不应返回
    const odd = Buffer.alloc(256 * 4);
    for (let k = 0; k < 8; k++) getDb().prepare('INSERT INTO embeddings(kind,ref_id,text,vector,dim,model) VALUES (?,?,?,?,?,?)').run('noe_memory', `odd${k}`, 'x', odd, 256, 'fake');

    for (const q of ['记忆内容编号7今天天气与心情', '心情', '随便一段不相关的查询文本测试排序稳定性']) {
      for (const limit of [5, 10, 50]) {
        const got = await semanticSearch(q, { kind: 'noe_memory', limit });
        const ref = await bruteSearch(q, { kind: 'noe_memory', limit });
        // 命中 id 序列 + 排序逐字一致（含分数次序）
        expect(got.map((h) => h.refId)).toEqual(ref.map((h) => h.refId));
        expect(got.map((h) => h.id)).toEqual(ref.map((h) => h.id));
        // 异维行绝不出现
        expect(got.some((h) => h.refId.startsWith('odd'))).toBe(false);
      }
    }
  });

  it('结果等价（无 kind 跨类别）：优化后命中集与排序 = 暴力参考', async () => {
    for (let i = 0; i < 25; i++) await upsertEmbedding({ kind: 'noe_memory', refId: `a${i}`, text: `跨类内容A${i}` });
    for (let i = 0; i < 25; i++) await upsertEmbedding({ kind: 'task', refId: `b${i}`, text: `跨类内容B${i}` });
    for (const limit of [3, 10, 60]) {
      const got = await semanticSearch('跨类内容B7', { limit }); // 不传 kind
      const ref = await bruteSearch('跨类内容B7', { limit });
      expect(got.map((h) => h.refId)).toEqual(ref.map((h) => h.refId));
      expect(got.map((h) => h.id)).toEqual(ref.map((h) => h.id));
    }
  });

  it('结果等价（minScore 边界）：阈值过滤后仍逐字一致', async () => {
    for (let i = 0; i < 20; i++) await upsertEmbedding({ kind: 'noe_memory', refId: `s${i}`, text: `阈值测试${i}` });
    for (const minScore of [0, 0.3, 0.6, 0.95]) {
      const got = await semanticSearch('阈值测试3', { kind: 'noe_memory', limit: 50, minScore });
      const ref = await bruteSearch('阈值测试3', { kind: 'noe_memory', limit: 50, minScore });
      expect(got.map((h) => h.refId)).toEqual(ref.map((h) => h.refId));
      expect(got.map((h) => h.score)).toEqual(ref.map((h) => h.score));
    }
  });

  it('semanticSearchVectors 同样等价：hits 顺序 + queryVector 不受索引影响', async () => {
    for (let i = 0; i < 30; i++) await upsertEmbedding({ kind: 'noe_memory', refId: `v${i}`, text: `向量召回${i}` });
    const got = await semanticSearchVectors('向量召回5', { kind: 'noe_memory', limit: 10 });
    const ref = await bruteSearch('向量召回5', { kind: 'noe_memory', limit: 10 });
    expect(got.hits.map((h) => h.refId)).toEqual(ref.map((h) => h.refId)); // 命中集 + 排序一致
    expect(got.hits.map((h) => h.score)).toEqual(ref.map((h) => h.score));
    expect(got.queryVector.length).toBe(128); // hash 维度
  });

  it('大库不崩 + 命中正确（千级行也只返回同维同 kind 的 top-N）', async () => {
    const db = getDb();
    const ins = db.prepare('INSERT INTO embeddings(kind,ref_id,text,vector,dim,model) VALUES (?,?,?,?,?,?)');
    // 直接批量插同维(128)真向量 + 异维噪声，避开逐条 await 提速
    const mk = async (kind, refId, text) => {
      const { vector } = await embed(text, { provider: 'hash' });
      const buf = Buffer.allocUnsafe(vector.length * 4);
      for (let j = 0; j < vector.length; j++) buf.writeFloatLE(vector[j], j * 4);
      ins.run(kind, refId, text, buf, vector.length, 'hash');
    };
    db.exec('BEGIN');
    try {
      for (let i = 0; i < 2000; i++) await mk('noe_memory', `big${i}`, `大库条目${i}`);
      const oddBuf = Buffer.alloc(256 * 4);
      for (let i = 0; i < 500; i++) ins.run('noe_memory', `bigodd${i}`, 'x', oddBuf, 256, 'fake'); // 异维噪声
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    const hits = await semanticSearch('大库条目1234', { kind: 'noe_memory', limit: 10 });
    expect(hits.length).toBe(10);
    expect(hits[0].refId).toBe('big1234'); // 完全相同文本应排第一
    expect(hits.some((h) => h.refId.startsWith('bigodd'))).toBe(false); // 异维永不入选
    // 与暴力参考最终 top-10 仍逐字一致
    const ref = await bruteSearch('大库条目1234', { kind: 'noe_memory', limit: 10 });
    expect(hits.map((h) => h.refId)).toEqual(ref.map((h) => h.refId));
  });
});
