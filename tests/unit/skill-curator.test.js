import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { classifySkillForCurator, runSkillCurator } from '../../src/skills/SkillCurator.js';

describe('SkillCurator', () => {
  const now = new Date('2026-06-07T00:00:00.000Z');

  it('keeps pinned skills regardless of age', () => {
    const out = classifySkillForCurator({ updatedAt: '2025-01-01T00:00:00.000Z', extra: { pinned: 'true' } }, { nowMs: now.getTime() });

    expect(out).toMatchObject({ state: 'pinned', action: 'keep' });
  });

  it('marks stale and archive candidates without destructive actions', () => {
    const report = runSkillCurator({
      now,
      skills: [
        { name: 'fresh', updatedAt: '2026-06-01T00:00:00.000Z' },
        { name: 'stale', updatedAt: '2026-04-01T00:00:00.000Z' },
        { name: 'old', updatedAt: '2026-01-01T00:00:00.000Z' },
      ],
    });

    expect(report.items.map((item) => [item.name, item.state, item.destructive])).toEqual([
      ['fresh', 'active', false],
      ['stale', 'stale', false],
      ['old', 'archive_candidate', false],
    ]);
  });

  it('writes curator state only when dryRun is false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-curator-'));
    try {
      const stateFile = join(dir, 'curator_state.json');
      const report = runSkillCurator({ now, dryRun: false, stateFile, skills: [{ name: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }] });

      expect(report.dryRun).toBe(false);
      expect(JSON.parse(readFileSync(stateFile, 'utf8')).items.old.state).toBe('archive_candidate');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a recoverable snapshot without mutating skill files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-curator-'));
    try {
      const snapshotFile = join(dir, 'snapshot.json');
      const report = runSkillCurator({
        now,
        dryRun: true,
        snapshotFile,
        skills: [
          { name: 'old', displayName: 'Shared Skill', description: 'MINIMAX_API_KEY=example-placeholder', updatedAt: '2026-01-01T00:00:00.000Z' },
          { name: 'old-copy', displayName: 'Shared Skill', updatedAt: '2026-06-01T00:00:00.000Z' },
        ],
      });

      expect(report.recoverable).toBe(true);
      expect(report.snapshotRef).toBe(snapshotFile);
      expect(report.directSkillMutations).toEqual([]);
      expect(report.pruned).toEqual([
        expect.objectContaining({ name: 'old', action: 'propose_archive', destructive: false, recoverable: true }),
      ]);
      expect(report.consolidated).toEqual([
        expect.objectContaining({ skills: ['old', 'old-copy'], action: 'propose_consolidation', destructive: false }),
      ]);
      expect(report.recoveryInstructions.join('\n')).toContain('No skill files are deleted or archived');
      expect(existsSync(snapshotFile)).toBe(true);
      const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'));
      expect(snapshot.directSkillMutations).toEqual([]);
      expect(snapshot.skills[0].description).toBe('MINIMAX_API_KEY=[redacted]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports state transitions as proposals with recovery guidance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-curator-'));
    try {
      const stateFile = join(dir, 'curator_state.json');
      runSkillCurator({
        now: new Date('2026-01-02T00:00:00.000Z'),
        dryRun: false,
        stateFile,
        skills: [{ name: 'aging-skill', updatedAt: '2026-01-01T00:00:00.000Z' }],
      });
      const report = runSkillCurator({
        now,
        dryRun: true,
        stateFile,
        skills: [{ name: 'aging-skill', updatedAt: '2026-01-01T00:00:00.000Z' }],
      });

      expect(report.stateTransitions).toEqual([
        expect.objectContaining({
          name: 'aging-skill',
          from: 'active',
          to: 'archive_candidate',
          action: 'propose_archive',
          destructive: false,
        }),
      ]);
      expect(report.recoveryInstructions.join('\n')).toContain('Treat archive_candidate and consolidation entries as proposals');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
