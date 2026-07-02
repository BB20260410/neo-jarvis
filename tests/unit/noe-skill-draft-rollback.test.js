import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  buildNoeSkillDraftRollbackPlan,
  runNoeSkillDraftRollback,
} from '../../src/skills/NoeSkillDraftRollback.js';

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
      applyId: 'skill-apply-1',
      proposalId: 'proposal-skill-1',
      skillWrite: {
        name: 'runtime-debug-drill',
        extra: { origin: 'proposal_skill_draft' },
      },
    }],
    applied: [{
      applyId: 'skill-apply-1',
      proposalId: 'proposal-skill-1',
      skillName: 'runtime-debug-drill',
      previousExists: false,
      origin: 'proposal_skill_draft',
      rollback: {
        action: 'delete_skill',
        skillName: 'runtime-debug-drill',
        reason: 'rollback:skill-apply-1',
      },
    }],
    ...overrides,
  };
}

function fakeSkillStore(seed = {}) {
  const skills = new Map(Object.entries(seed));
  return {
    get(name) {
      return skills.get(name) || null;
    },
    delete(name) {
      return skills.delete(name);
    },
    skills,
  };
}

describe('NoeSkillDraftRollback', () => {
  it('treats missing apply report as skipped smoke, not failed rollback', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-skill-draft-rollback-'));
    try {
      expect(runNoeSkillDraftRollback({ root })).toMatchObject({
        ok: true,
        status: 'skipped',
        reason: 'apply_report_required',
        counts: { rollbackItems: 0, rolledBack: 0, blocked: 0, errors: 0 },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds rollback only for matching proposal skill drafts', () => {
    const out = buildNoeSkillDraftRollbackPlan(applyReport(), {
      applyReportRef: 'output/noe-skill-drafts/apply-reports/apply.json',
    });

    expect(out).toMatchObject({
      ok: true,
      plan: {
        status: 'ready_for_rollback',
        requiresOwnerConfirmation: true,
        rollbackItems: [{
          applyId: 'skill-apply-1',
          proposalId: 'proposal-skill-1',
          skillName: 'runtime-debug-drill',
          action: 'delete_skill',
        }],
      },
    });
  });

  it('dry-runs without deleting SkillStore entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-skill-draft-rollback-'));
    try {
      writeJson(join(root, 'apply.json'), applyReport());
      const store = fakeSkillStore({
        'runtime-debug-drill': { name: 'runtime-debug-drill' },
      });

      const report = runNoeSkillDraftRollback({
        root,
        applyReportRef: 'apply.json',
        skillStore: store,
        dryRun: true,
      });

      expect(report).toMatchObject({
        ok: true,
        status: 'dry_run_ready',
        dryRun: true,
        counts: { rollbackItems: 1, rolledBack: 0 },
        directWrites: [],
      });
      expect(store.get('runtime-debug-drill')).toMatchObject({ name: 'runtime-debug-drill' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires owner confirmation and skillStore for real rollback', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-skill-draft-rollback-'));
    try {
      writeJson(join(root, 'apply.json'), applyReport());

      expect(runNoeSkillDraftRollback({
        root,
        applyReportRef: 'apply.json',
        dryRun: false,
        skillStore: fakeSkillStore(),
      })).toMatchObject({
        ok: false,
        status: 'blocked',
        errors: [{ error: 'owner_confirmation_required' }],
      });
      expect(runNoeSkillDraftRollback({
        root,
        applyReportRef: 'apply.json',
        dryRun: false,
        confirmOwner: true,
      })).toMatchObject({
        ok: false,
        status: 'blocked',
        errors: [{ error: 'skill_store_required' }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('deletes confirmed proposal-created skills and records rollback evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-skill-draft-rollback-'));
    try {
      writeJson(join(root, 'apply.json'), applyReport());
      const store = fakeSkillStore({
        'runtime-debug-drill': { name: 'runtime-debug-drill' },
      });

      const report = runNoeSkillDraftRollback({
        root,
        applyReportRef: 'apply.json',
        skillStore: store,
        dryRun: false,
        confirmOwner: true,
      });

      expect(report).toMatchObject({
        ok: true,
        status: 'rolled_back',
        counts: { rollbackItems: 1, rolledBack: 1 },
        writesSkillStore: true,
        rolledBack: [{
          skillName: 'runtime-debug-drill',
          status: 'deleted',
          beforeExists: true,
          afterExists: false,
        }],
      });
      expect(store.get('runtime-debug-drill')).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks forged, preexisting, or escaped apply reports', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-skill-draft-rollback-'));
    try {
      writeJson(join(root, 'preexisting.json'), applyReport({
        applied: [{
          applyId: 'skill-apply-1',
          proposalId: 'proposal-skill-1',
          skillName: 'runtime-debug-drill',
          previousExists: true,
          origin: 'proposal_skill_draft',
          rollback: { action: 'delete_skill' },
        }],
      }));
      writeJson(join(root, 'forged.json'), applyReport({
        plans: [{
          applyId: 'skill-apply-1',
          skillWrite: {
            name: 'runtime-debug-drill',
            extra: { origin: 'manual' },
          },
        }],
      }));

      expect(runNoeSkillDraftRollback({ root, applyReportRef: 'preexisting.json' })).toMatchObject({
        ok: false,
        status: 'blocked',
        blocked: [{ blockers: expect.arrayContaining(['cannot_delete_preexisting_skill']) }],
      });
      expect(runNoeSkillDraftRollback({ root, applyReportRef: 'forged.json' })).toMatchObject({
        ok: false,
        status: 'blocked',
        blocked: [{ blockers: expect.arrayContaining(['apply_plan_origin_invalid']) }],
      });
      expect(runNoeSkillDraftRollback({ root, applyReportRef: '../escape.json' })).toMatchObject({
        ok: false,
        status: 'blocked',
        errors: [{ error: 'apply_report_outside_root' }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
