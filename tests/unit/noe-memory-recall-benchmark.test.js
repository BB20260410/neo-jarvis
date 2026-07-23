import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, getDb, initSqlite } from '../../src/storage/SqliteStore.js';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { NoeMemoryAuditLog } from '../../src/memory/NoeMemoryAuditLog.js';
import { NoeMemoryWriteGate } from '../../src/memory/NoeMemoryWriteGate.js';
import { NoeMemoryRetriever } from '../../src/memory/NoeMemoryRetriever.js';
import { runNoeMemoryRecallBenchmark } from '../../src/memory/NoeMemoryRecallBenchmark.js';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noe-memory-recall-benchmark-test-'));
  initSqlite(join(dir, 'panel.db'));
});

afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

describe('runNoeMemoryRecallBenchmark', () => {
  it('runs a labeled recall benchmark without exposing memory bodies', async () => {
    const memory = new MemoryCore({ logger: { warn: () => {}, info: () => {} } });
    const auditLog = new NoeMemoryAuditLog({ db: () => getDb() });
    const writeGate = new NoeMemoryWriteGate({ memory, auditLog, logger: { warn: () => {} } });
    const retriever = new NoeMemoryRetriever({ memory, auditLog, logger: { warn: () => {} } });

    const report = await runNoeMemoryRecallBenchmark({ writeGate, retriever });

    expect(report.ok).toBe(true);
    expect(report.summary).toMatchObject({ cases: 4, passed: 4, failed: 0 });
    expect(report.results.map((r) => r.id)).toEqual(['coffee_preference', 'roadmap_provenance', 'voice_sublimation', 'negative_unrelated']);
    expect(report.results.find((r) => r.id === 'coffee_preference')?.blockedIds).toEqual([]);
    expect(report.results.find((r) => r.id === 'negative_unrelated')?.selectedIds).toEqual([]);
    expect(JSON.stringify(report)).not.toContain('主人长期偏好黑咖啡');
  });
});
