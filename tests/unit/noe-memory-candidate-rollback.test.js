import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import {
  buildNoeMemoryCandidateRollbackPlan,
  runNoeMemoryCandidateRollback,
} from '../../src/memory/NoeMemoryCandidateRollback.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

function writeJson(file, data) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function applyReport(overrides = {}) {
  return {
    ok: true,
    status: 'applied',
    rollbackEvidenceRequired: true,
    plans: [{
      applyId: 'memory-apply-1',
      candidateId: 'memory-candidate-1',
      memoryWrite: {
        projectId: 'noe',
        sourceType: 'proposal_memory_candidate',
      },
    }],
    applied: [{
      applyId: 'memory-apply-1',
      candidateId: 'memory-candidate-1',
      memoryId: 'mem-rollback-1',
      rollback: {
        action: 'hide_memory',
        reason: 'rollback:memory-apply-1',
      },
    }],
    ...overrides,
  };
}

afterEach(() => {
  close();
});

describe('NoeMemoryCandidateRollback', () => {
  it('treats missing apply report as skipped smoke, not failed rollback', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-memory-rollback-'));
    try {
      expect(runNoeMemoryCandidateRollback({ root })).toMatchObject({
        ok: true,
        status: 'skipped',
        reason: 'apply_report_required',
        counts: { rollbackItems: 0, rolledBack: 0, blocked: 0, errors: 0 },
        errors: [],
        blocked: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds a rollback plan only for applied proposal memory candidates', () => {
    const plan = buildNoeMemoryCandidateRollbackPlan(applyReport(), {
      applyReportRef: 'output/noe-memory-candidates/apply-reports/apply.json',
    });

    expect(plan).toMatchObject({
      ok: true,
      plan: {
        status: 'ready_for_rollback',
        requiresOwnerConfirmation: true,
        rollbackItems: [{
          applyId: 'memory-apply-1',
          candidateId: 'memory-candidate-1',
          memoryId: 'mem-rollback-1',
          projectId: 'noe',
          action: 'hide_memory',
        }],
      },
    });
  });

  it('dry-runs without hiding MemoryCore entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-memory-rollback-'));
    try {
      initSqlite(join(root, 'panel.db'));
      const memory = new MemoryCore({ logger: null });
      memory.write({ id: 'mem-rollback-1', projectId: 'noe', body: 'candidate memory body' });
      writeJson(join(root, 'apply.json'), applyReport());

      const report = runNoeMemoryCandidateRollback({
        root,
        applyReportRef: 'apply.json',
        memoryCore: memory,
        dryRun: true,
      });

      expect(report).toMatchObject({
        ok: true,
        status: 'dry_run_ready',
        dryRun: true,
        counts: { rollbackItems: 1, rolledBack: 0 },
        directWrites: [],
      });
      expect(memory.get('mem-rollback-1')?.hidden).toBe(false);
      expect(readFileSync(join(root, report.reportRef), 'utf8')).toContain('"dryRun": true');
    } finally {
      close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires owner confirmation and memoryCore for real rollback', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-memory-rollback-'));
    try {
      writeJson(join(root, 'apply.json'), applyReport());

      expect(runNoeMemoryCandidateRollback({
        root,
        applyReportRef: 'apply.json',
        dryRun: false,
        memoryCore: { hide: () => true },
      })).toMatchObject({
        ok: false,
        status: 'blocked',
        errors: [{ error: 'owner_confirmation_required' }],
      });
      expect(runNoeMemoryCandidateRollback({
        root,
        applyReportRef: 'apply.json',
        dryRun: false,
        confirmOwner: true,
      })).toMatchObject({
        ok: false,
        status: 'blocked',
        errors: [{ error: 'memory_core_required' }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('hides confirmed MemoryCore writes and records rollback evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-memory-rollback-'));
    try {
      initSqlite(join(root, 'panel.db'));
      const memory = new MemoryCore({ logger: null });
      memory.write({ id: 'mem-rollback-1', projectId: 'noe', body: 'candidate memory body' });
      writeJson(join(root, 'apply.json'), applyReport());

      const report = runNoeMemoryCandidateRollback({
        root,
        applyReportRef: 'apply.json',
        memoryCore: memory,
        dryRun: false,
        confirmOwner: true,
      });

      expect(report).toMatchObject({
        ok: true,
        status: 'rolled_back',
        counts: { rollbackItems: 1, rolledBack: 1 },
        rolledBack: [{
          memoryId: 'mem-rollback-1',
          status: 'hidden',
          afterHidden: true,
          reason: 'rollback:memory-apply-1',
        }],
      });
      expect(memory.get('mem-rollback-1')).toBeNull();
      expect(memory.get('mem-rollback-1', { includeHidden: true })?.hidden).toBe(true);
    } finally {
      close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rolls back candidates written to the production "noe" project (regression: orphan projectId)', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-memory-rollback-'));
    try {
      initSqlite(join(root, 'panel.db'));
      const memory = new MemoryCore({ logger: null });
      memory.write({ id: 'mem-rollback-noe', projectId: 'noe', body: 'noe candidate memory body' });
      writeJson(join(root, 'apply.json'), applyReport({
        plans: [{
          applyId: 'memory-apply-1',
          candidateId: 'memory-candidate-1',
          memoryWrite: { projectId: 'noe', sourceType: 'proposal_memory_candidate' },
        }],
        applied: [{
          applyId: 'memory-apply-1',
          candidateId: 'memory-candidate-1',
          memoryId: 'mem-rollback-noe',
          rollback: { action: 'hide_memory', reason: 'rollback:memory-apply-1' },
        }],
      }));

      const report = runNoeMemoryCandidateRollback({
        root,
        applyReportRef: 'apply.json',
        memoryCore: memory,
        dryRun: false,
        confirmOwner: true,
      });

      expect(report).toMatchObject({
        ok: true,
        status: 'rolled_back',
        counts: { rollbackItems: 1, rolledBack: 1 },
      });
      expect(memory.get('mem-rollback-noe', { includeHidden: true })?.hidden).toBe(true);
    } finally {
      close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks forged or unsafe apply reports', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-memory-rollback-'));
    try {
      writeJson(join(root, 'apply.json'), applyReport({
        plans: [{ applyId: 'memory-apply-1', memoryWrite: { projectId: 'noe', sourceType: 'manual' } }],
      }));

      expect(runNoeMemoryCandidateRollback({ root, applyReportRef: 'apply.json' })).toMatchObject({
        ok: false,
        status: 'blocked',
        blocked: [{ blockers: expect.arrayContaining(['not_proposal_memory_candidate']) }],
      });
      expect(runNoeMemoryCandidateRollback({ root, applyReportRef: '../escape.json' })).toMatchObject({
        ok: false,
        status: 'blocked',
        errors: [{ error: 'apply_report_outside_root' }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
