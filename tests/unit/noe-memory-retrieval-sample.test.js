import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, getDb, initSqlite } from '../../src/storage/SqliteStore.js';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { NoeMemoryAuditLog } from '../../src/memory/NoeMemoryAuditLog.js';
import { NoeMemoryRetriever } from '../../src/memory/NoeMemoryRetriever.js';
import { runNoeMemoryRetrievalSample } from '../../src/memory/NoeMemoryRetrievalSample.js';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noe-memory-retrieval-sample-test-'));
  initSqlite(join(dir, 'panel.db'));
});

afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

describe('runNoeMemoryRetrievalSample', () => {
  it('writes retrieval log entries without memory body output', async () => {
    const memory = new MemoryCore({ logger: { warn: () => {}, info: () => {} } });
    memory.write({ id: 'm1', projectId: 'noe', scope: 'fact', body: '长期记忆 retrieval sample fixture', sourceType: 'unit' });
    const auditLog = new NoeMemoryAuditLog({ db: () => getDb() });
    const retriever = new NoeMemoryRetriever({ memory, auditLog, logger: { warn: () => {} } });

    const report = await runNoeMemoryRetrievalSample({
      retriever,
      queries: [{ id: 'memory', q: '长期记忆' }, { id: 'none', q: 'not-present' }],
    });

    expect(report.ok).toBe(true);
    expect(report.sampled).toBe(2);
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM noe_memory_retrieval_log').get().c).toBe(2);
    expect(JSON.stringify(report)).not.toContain('fixture');
  });
});
