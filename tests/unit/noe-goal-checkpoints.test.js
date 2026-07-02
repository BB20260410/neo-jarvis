import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initSqlite, close, getDb } from '../../src/storage/SqliteStore.js';
import { appendGoalCheckpoint, listGoalCheckpoints } from '../../src/cognition/NoeGoalCheckpoints.js';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noe-goal-checkpoints-'));
  initSqlite(join(dir, 'panel.db'));
});

afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

describe('NoeGoalCheckpoints workflow metadata', () => {
  it('adds idempotency key, resume cursor, side-effect fingerprint, and rollback policy', () => {
    const db = getDb();
    appendGoalCheckpoint(db, {
      now: () => 1_780_000_000_000,
      goalId: 'g-workflow',
      stepIndex: 2,
      phase: 'evidence',
      status: 'done',
      kind: 'act',
      action: 'social.publish.final',
      step: 'publish final post',
      evidenceRef: 'sqlite:events/42',
      payload: {
        actId: 'act-1',
        dryRunOnly: false,
        ok: true,
        actionEvidenceSummary: {
          schemaVersion: 1,
          sha256: 'a'.repeat(64),
          dryRunOnly: false,
          refs: { rollback: ['output/rollback.md'] },
        },
      },
    });

    const cp = listGoalCheckpoints(db, { goalId: 'g-workflow' })[0];

    expect(cp.payload.workflow.schemaVersion).toBe(1);
    expect(cp.payload.workflow.idempotencyKey).toMatch(/^goal-step:[a-f0-9]{40}$/);
    expect(cp.payload.workflow.resumeCursor).toMatchObject({
      goalId: 'g-workflow',
      stepIndex: 2,
      phase: 'evidence',
      status: 'done',
      checkpointId: cp.id,
      replaySafe: false,
    });
    expect(cp.payload.workflow.sideEffectFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(cp.payload.workflow.rollbackEvidence).toMatchObject({
      required: true,
      status: 'available',
      reason: 'rollback_refs_present',
      refs: ['output/rollback.md'],
    });
  });

  it('marks dry-run and readonly actions as not requiring rollback evidence', () => {
    const db = getDb();
    appendGoalCheckpoint(db, {
      goalId: 'g-dry',
      stepIndex: 0,
      phase: 'evidence',
      status: 'done',
      kind: 'act',
      action: 'shell.exec',
      payload: { dryRunOnly: true, ok: true },
    });
    appendGoalCheckpoint(db, {
      goalId: 'g-dry',
      stepIndex: 1,
      phase: 'evidence',
      status: 'done',
      kind: 'act',
      action: 'shell.exec',
      payload: { dryRunOnly: false, readonly: true, ok: true },
    });

    const rows = listGoalCheckpoints(db, { goalId: 'g-dry' });

    expect(rows[0].payload.workflow.rollbackEvidence).toMatchObject({
      required: false,
      status: 'not_required',
      reason: 'dry_run_only_no_external_side_effect',
    });
    expect(rows[1].payload.workflow.rollbackEvidence).toMatchObject({
      required: false,
      status: 'not_required',
      reason: 'readonly_action_no_external_side_effect',
    });
  });
});
