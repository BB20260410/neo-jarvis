import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { runNoeMemorySemanticBackfill } from '../../src/memory/NoeMemorySemanticBackfill.js';
import { close, getDb, initSqlite } from '../../src/storage/SqliteStore.js';

let dir = null;

beforeEach(() => {
  close();
  dir = mkdtempSync(join(tmpdir(), 'noe-memory-semantic-backfill-test-'));
  initSqlite(join(dir, 'panel.db'));
  const memory = new MemoryCore({ logger: { warn: () => {} } });
  memory.write({
    id: 'semantic-real-1',
    projectId: 'noe',
    scope: 'fact',
    body: '用于真实语义 backfill 测试的记忆正文。',
  });
  getDb().prepare(`
    INSERT INTO embeddings(kind, ref_id, text, vector, dim, model)
    VALUES ('noe_memory', 'semantic-real-1', '', ?, 128, 'hash-128')
  `).run(Buffer.alloc(512));
});

afterEach(() => {
  close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('runNoeMemorySemanticBackfill', () => {
  const fakeSemantic = {
    async upsert({ refId, text }) {
      getDb().prepare(`
        INSERT INTO embeddings(kind, ref_id, text, vector, dim, model)
        VALUES ('noe_memory', ?, ?, ?, 3, 'fake-embed')
        ON CONFLICT(kind, ref_id) DO UPDATE SET text=excluded.text, vector=excluded.vector, dim=excluded.dim, model=excluded.model
      `).run(refId, text, Buffer.alloc(12));
      return { ok: true, provider: 'fake', model: 'fake-embed', dim: 3 };
    },
  };

  it('dry-runs and refuses apply without explicit ack', async () => {
    const dry = await runNoeMemorySemanticBackfill({ provider: 'fake', semanticIndexFactory: () => fakeSemantic });
    expect(dry).toMatchObject({ ok: true, mode: 'dry_run', candidates: 1, plannedHashPurge: 1 });
    expect(dry.policy.realDbWrites).toBe(false);

    const blocked = await runNoeMemorySemanticBackfill({ provider: 'fake', apply: true, semanticIndexFactory: () => fakeSemantic });
    expect(blocked).toMatchObject({ ok: false, mode: 'blocked', reason: 'ack_semantic_backfill_apply_required' });
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM embeddings WHERE model='hash-128'").get().c).toBe(1);
  });

  it('blocks ollama apply before purging when embedding probe fails', async () => {
    const report = await runNoeMemorySemanticBackfill({
      provider: 'ollama',
      apply: true,
      ackApply: true,
      ollamaProbe: async () => ({ ok: false, reason: 'offline' }),
      semanticIndexFactory: () => fakeSemantic,
    });

    expect(report).toMatchObject({
      ok: false,
      mode: 'blocked',
      reason: 'ollama_embedding_unavailable',
      policy: { realDbWrites: false },
    });
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM embeddings WHERE model='hash-128'").get().c).toBe(1);
  });

  it('purges hash vectors and backfills visible memories when acknowledged', async () => {
    const report = await runNoeMemorySemanticBackfill({
      provider: 'fake',
      apply: true,
      ackApply: true,
      semanticIndexFactory: () => fakeSemantic,
    });

    expect(report.ok).toBe(true);
    // M2 修复：改用"逐条原子覆盖(ON CONFLICT)+ 仅清理未覆盖的残留 hash"，candidate 的 hash 行被 upsert
    // 直接升级为 fake-embed（同 ref_id），故无残留 hash 可删 → purged:0（旧流程"先删全部再重建"为 1）。
    // 两者最终库状态一致（1 条升级向量），新流程消除了"先删后写中途崩溃留空洞"的窗口。
    expect(report.apply).toMatchObject({ purge: { purged: 0 }, candidates: 1, upserted: 1, fallbackCount: 0 });
    expect(report.after.semanticProvider.stored.models).toEqual({ 'fake-embed': 1 });
    expect(report.policy.realDbWrites).toBe(true);
    expect(JSON.stringify(report)).not.toContain('backfill 测试的记忆正文');
  });

  it('M2: 嵌入 fallback 时不删旧向量、无空洞、ok=false', async () => {
    const fallbackSemantic = {
      async upsert() {
        return { ok: false, skipped: 'embed_fallback', provider: 'hash-fallback', model: 'hash-128', fallback: true };
      },
    };
    const report = await runNoeMemorySemanticBackfill({
      provider: 'ollama',
      apply: true,
      ackApply: true,
      ollamaProbe: async () => ({ ok: true }),
      semanticIndexFactory: () => fallbackSemantic,
    });
    expect(report.ok).toBe(false);
    expect(report.apply.fallbackCount).toBe(1);
    expect(report.apply.purge).toMatchObject({ purged: 0, skipped: 'fallback_or_incomplete' });
    // 关键：fallback 时旧 hash 向量保留，候选记忆不会变成"既无 hash 也无 ollama"的空洞。
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM embeddings WHERE ref_id='semantic-real-1'").get().c).toBe(1);
  });
});
