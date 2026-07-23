import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { runNoeMemoryCopyValidation } from '../../src/memory/NoeMemoryCopyValidation.js';
import { close, getDb, initSqlite } from '../../src/storage/SqliteStore.js';

let dir = null;

function setupSourceDb() {
  dir = mkdtempSync(join(tmpdir(), 'noe-memory-copy-validation-test-'));
  const sourceDbPath = join(dir, 'source.db');
  initSqlite(sourceDbPath);
  const memory = new MemoryCore({ logger: { warn: () => {} } });
  memory.write({
    id: 'semantic-target',
    projectId: 'noe',
    scope: 'fact',
    body: '这条记忆会只被 fake semantic route 命中。',
    confidence: 0.9,
    salience: 3,
  });
  memory.write({
    id: 'copy-stale',
    projectId: 'noe',
    scope: 'project',
    body: '这条低价值陈旧记忆只用于 copy apply 验证。',
    confidence: 0.2,
    salience: 1,
  });
  getDb().prepare('UPDATE noe_memory SET updated_at=?, hit_count=0 WHERE id=?').run(1000, 'copy-stale');
  close();
  return sourceDbPath;
}

afterEach(() => {
  close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('runNoeMemoryCopyValidation', () => {
  it('validates semantic and maintenance behavior on a database copy only', async () => {
    const sourceDbPath = setupSourceDb();
    const fakeSemantic = {
      provider: 'fake',
      async upsert({ refId, text }) {
        getDb().prepare(`
          INSERT INTO embeddings(kind, ref_id, text, vector, dim, model)
          VALUES ('noe_memory', ?, ?, ?, 3, 'fake-embed')
          ON CONFLICT(kind, ref_id) DO UPDATE SET text=excluded.text, vector=excluded.vector, dim=excluded.dim, model=excluded.model
        `).run(refId, text, Buffer.alloc(12));
        return { ok: true, provider: 'fake', model: 'fake-embed', dim: 3 };
      },
      async search() {
        return [{ refId: 'semantic-target', score: 0.99 }];
      },
      remove() { return 0; },
    };

    const report = await runNoeMemoryCopyValidation({
      sourceDbPath,
      provider: 'fake',
      model: 'fake-embed',
      semanticIndexFactory: () => fakeSemantic,
      ollamaProbe: async () => ({ ok: true, reason: 'fake' }),
      queries: [{ id: 'semantic_only', q: 'semantic only query', routeType: 'chat' }],
      maxBackfill: 10,
      now: () => 1781344000000,
    });

    expect(report.ok).toBe(true);
    expect(report.copy.realDbWrites).toBe(false);
    expect(report.semanticBackfill).toMatchObject({ ok: true, candidates: 2, upserted: 2, fallbackCount: 0 });
    expect(report.retrievalComparison.fts.selectedRows).toBe(0);
    expect(report.retrievalComparison.fused.selectedRows).toBe(1);
    expect(report.maintenance.apply.gcApply.protectedAffected).toEqual([]);
    expect(JSON.stringify(report)).not.toContain('fake semantic route');

    initSqlite(sourceDbPath);
    const sourceHidden = getDb().prepare('SELECT hidden FROM noe_memory WHERE id=?').get('copy-stale')?.hidden;
    const sourceEmbeddings = getDb().prepare("SELECT COUNT(*) AS c FROM embeddings WHERE kind='noe_memory'").get()?.c;
    expect(sourceHidden).toBe(0);
    expect(sourceEmbeddings).toBe(0);
  });
});
