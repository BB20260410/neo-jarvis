import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  buildNoeSkillDraftApplyPlan,
  runNoeSkillDraftApply,
} from '../../src/skills/NoeSkillDraftApply.js';

function writeJsonl(file, records = []) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

function skillDraftRecord(overrides = {}) {
  return {
    executionKey: 'exec-skill-1',
    effect: 'pending_queue_only',
    proposal: {
      proposalId: 'proposal-skill-1',
      proposalType: 'skill_draft',
      title: 'Runtime Debug Drill',
      summary: 'Use this when debugging a runtime issue without leaking sk-unitsecret000000000000000000000000000000.',
      sourceReportRef: 'output/noe-background-review/review.json',
      raw: {
        item: {
          name: 'runtime-debug-drill',
          displayName: 'Runtime Debug Drill',
          description: 'Use when debugging a runtime issue with command evidence.',
          body: '1. Reproduce the issue.\n2. Capture evidence.\n3. Do not print sk-unitsecret000000000000000000000000000000.',
        },
      },
    },
    ...overrides,
  };
}

function fakeSkillStore(seed = {}) {
  const skills = new Map(Object.entries(seed));
  return {
    get(name) {
      return skills.get(name) || null;
    },
    upsert(input) {
      const saved = { ...input, updatedAt: '2026-06-13T02:00:00.000Z' };
      skills.set(input.name, saved);
      return saved;
    },
    delete(name) {
      return skills.delete(name);
    },
    skills,
  };
}

describe('NoeSkillDraftApply', () => {
  it('builds a disabled SkillStore apply plan with rollback evidence', () => {
    const out = buildNoeSkillDraftApplyPlan(skillDraftRecord());

    expect(out.ok).toBe(true);
    expect(out.plan).toMatchObject({
      status: 'ready_for_apply',
      writesSkillStore: true,
      requiresOwnerConfirmation: true,
      skillWrite: {
        name: 'runtime-debug-drill',
        enabled: false,
        extra: {
          origin: 'proposal_skill_draft',
          proposalId: 'proposal-skill-1',
        },
      },
    });
    expect(out.plan.skillWrite.body).not.toContain('unitsecret');
    expect(out.plan.rollbackPlan.join('\n')).toContain('delete the disabled skill');
  });

  it('dry-runs materialized skill drafts without writing SkillStore', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-skill-draft-apply-'));
    try {
      writeJsonl(join(root, 'output/noe-proposal-executions/queues/skill-drafts.jsonl'), [skillDraftRecord()]);
      const store = fakeSkillStore();

      const report = runNoeSkillDraftApply({ root, skillStore: store, dryRun: true });

      expect(report).toMatchObject({
        ok: true,
        status: 'dry_run_ready',
        dryRun: true,
        counts: { records: 1, ready: 1, blocked: 0, applied: 0 },
        directWrites: [],
        writesSkillStore: false,
      });
      expect(store.get('runtime-debug-drill')).toBeNull();
      expect(readFileSync(join(root, report.reportRef), 'utf8')).not.toContain('unitsecret');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires owner confirmation and skillStore before real apply', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-skill-draft-apply-'));
    try {
      writeJsonl(join(root, 'output/noe-proposal-executions/queues/skill-drafts.jsonl'), [skillDraftRecord()]);

      expect(runNoeSkillDraftApply({ root, dryRun: false, skillStore: fakeSkillStore() })).toMatchObject({
        ok: false,
        status: 'blocked',
        errors: [{ error: 'owner_confirmation_required' }],
      });
      expect(runNoeSkillDraftApply({ root, dryRun: false, confirmOwner: true })).toMatchObject({
        ok: false,
        status: 'blocked',
        errors: [{ error: 'skill_store_required' }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies confirmed skill drafts as disabled skills and records rollback instructions', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-skill-draft-apply-'));
    try {
      writeJsonl(join(root, 'output/noe-proposal-executions/queues/skill-drafts.jsonl'), [skillDraftRecord()]);
      const store = fakeSkillStore();

      const report = runNoeSkillDraftApply({
        root,
        skillStore: store,
        dryRun: false,
        confirmOwner: true,
        now: new Date('2026-06-13T02:00:00.000Z'),
      });

      expect(report).toMatchObject({
        ok: true,
        status: 'applied',
        counts: { records: 1, ready: 1, applied: 1 },
        writesSkillStore: true,
        directWrites: [report.reportRef, 'SkillStore'],
        applied: [{
          skillName: 'runtime-debug-drill',
          previousExists: false,
          origin: 'proposal_skill_draft',
          rollback: { action: 'delete_skill', skillName: 'runtime-debug-drill' },
        }],
      });
      expect(store.get('runtime-debug-drill')).toMatchObject({
        enabled: false,
        extra: { origin: 'proposal_skill_draft' },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks overwriting existing skills', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-skill-draft-apply-'));
    try {
      writeJsonl(join(root, 'output/noe-proposal-executions/queues/skill-drafts.jsonl'), [skillDraftRecord()]);
      const store = fakeSkillStore({
        'runtime-debug-drill': { name: 'runtime-debug-drill', body: 'existing' },
      });

      const report = runNoeSkillDraftApply({
        root,
        skillStore: store,
        dryRun: false,
        confirmOwner: true,
      });

      expect(report).toMatchObject({
        ok: false,
        status: 'blocked',
        errors: [{ applyId: expect.any(String), skillName: 'runtime-debug-drill', error: 'skill_already_exists' }],
        counts: { applied: 0 },
      });
      expect(store.get('runtime-debug-drill')?.body).toBe('existing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes a skipped report when no skill draft queue exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-skill-draft-apply-'));
    try {
      const report = runNoeSkillDraftApply({ root });

      expect(report).toMatchObject({
        ok: true,
        status: 'skipped',
        reason: 'no_materialized_skill_drafts',
      });
      expect(existsSync(join(root, report.reportRef))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
