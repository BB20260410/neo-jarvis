// @ts-check
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  openUnifiedTaskDb,
  UnifiedTaskSqliteStore,
  reopenUnifiedTaskSqliteStore,
} from '../../src/runtime/UnifiedTaskSqlite.js';

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('UnifiedTaskSqlite restart recovery', () => {
  it('survives process-equivalent reopen with same task id and completed status', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uts-'));
    dirs.push(dir);
    const dbPath = join(dir, 'unified-tasks.db');
    const db = openUnifiedTaskDb(dbPath);
    const store = new UnifiedTaskSqliteStore({
      db,
      env: { NOE_UNIFIED_TASK_WRITE: '1' },
    });
    const t = store.create({ goal: 'persist canary', sourceDigest: 'sha256:p' });
    store.transition(t.id, 'running');
    const done = store.transition(t.id, 'completed', {
      exitCode: 0,
      verified: true,
      hasValidArtifacts: true,
      hasEvidence: true,
      validatorsPass: true,
      sourceDigestMatch: true,
      approvalsSettled: true,
      highRiskActsSettled: true,
      sourceDigest: 'sha256:p',
      artifacts: [{ path: 'r.md', sha256: '1' }],
      resultSummary: 'persisted',
      receiptId: 'rcp1',
    });
    expect(done.status).toBe('completed');
    db.close();

    // reopen = restart
    const store2 = reopenUnifiedTaskSqliteStore(dbPath, { env: { NOE_UNIFIED_TASK_WRITE: '1' } });
    const got = store2.get(t.id);
    expect(got).toBeTruthy();
    expect(got.id).toBe(t.id);
    expect(got.status).toBe('completed');
    expect(got.resultSummary).toBe('persisted');
    expect(store2.buildReceipt(t.id).displayCompleted).toBe(true);
    expect(store2.events(t.id).length).toBeGreaterThan(0);
  });

  it('denies false complete across reopen boundary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uts2-'));
    dirs.push(dir);
    const dbPath = join(dir, 'u.db');
    const store = new UnifiedTaskSqliteStore({
      db: openUnifiedTaskDb(dbPath),
      env: { NOE_UNIFIED_TASK_WRITE: '1' },
    });
    const t = store.create({ goal: 'x' });
    store.transition(t.id, 'completed', {
      exitCode: 1,
      verified: true,
      hasValidArtifacts: true,
      hasEvidence: true,
      validatorsPass: true,
    });
    const mid = store.get(t.id);
    expect(mid.status).not.toBe('completed');

    const store2 = reopenUnifiedTaskSqliteStore(dbPath, { env: { NOE_UNIFIED_TASK_WRITE: '1' } });
    expect(store2.get(t.id).status).not.toBe('completed');
  });
});
