import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, getDb, initSqlite } from '../../src/storage/SqliteStore.js';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { runNoeMemoryMaintenanceDryRun } from '../../src/memory/NoeMemoryMaintenanceDryRun.js';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noe-memory-maintenance-test-'));
  initSqlite(join(dir, 'panel.db'));
});

afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

describe('runNoeMemoryMaintenanceDryRun', () => {
  it('plans dream consolidation and GC without mutating memory', async () => {
    const memory = new MemoryCore({ logger: { warn: () => {}, info: () => {} } });
    memory.write({ id: 'dup-a', projectId: 'noe', body: '主人喜欢黑咖啡', salience: 3 });
    memory.write({ id: 'dup-b', projectId: 'noe', body: '主人喜欢黑咖啡', salience: 4 });
    memory.write({ id: 'expired', projectId: 'noe', body: '过期低价值记忆', expiresAt: Date.now() - 1000 });
    memory.write({ id: 'identity', projectId: 'noe', body: '身份级记忆', salience: 5, expiresAt: Date.now() - 1000 });

    const report = await runNoeMemoryMaintenanceDryRun({ memory, db: getDb(), projectId: 'noe' });

    expect(report.ok).toBe(true);
    expect(report.mode).toBe('dry_run');
    expect(report.dream.mergeCount).toBeGreaterThanOrEqual(1);
    expect(report.gc.candidateIds).toContain('expired');
    expect(report.gc.candidateIds).not.toContain('identity');
    expect(memory.get('expired')).not.toBeNull();
    expect(JSON.stringify(report)).not.toContain('主人喜欢黑咖啡');
  });
});
