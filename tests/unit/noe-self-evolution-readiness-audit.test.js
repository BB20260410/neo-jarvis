import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildNoeSelfEvolutionReadinessAudit,
  renderMarkdown,
  runIsolatedDgmArchiveDrill,
} from '../../scripts/noe-self-evolution-readiness-audit.mjs';

describe('noe-self-evolution-readiness-audit', () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function tempDir() {
    dir = mkdtempSync(join(tmpdir(), 'noe-self-evolution-readiness-test-'));
    return dir;
  }

  it('proves the archive writer can produce 10-generation lineage and holdout evidence in isolation', () => {
    const root = tempDir();
    const drill = runIsolatedDgmArchiveDrill({
      generations: 10,
      tempRoot: root,
      cleanup: true,
      nowMs: Date.parse('2026-06-15T00:00:00.000Z'),
    });

    expect(drill.ok).toBe(true);
    expect(drill.archivePath).toBe('[temporary-deleted]');
    expect(drill.evidence).toMatchObject({
      variantGenerations: 10,
      passedVariants: 10,
      appliedEntries: 1,
      parseErrors: 0,
      hasParentChildLineage: true,
      hasHoldoutEvidence: true,
      benchmarkEntries: 11,
    });
    expect(drill.evidence.lineageEntries).toBeGreaterThanOrEqual(10);
    expect(drill.evidence.holdoutEntries).toBeGreaterThanOrEqual(10);
  });

  it('keeps live archive gaps separate from isolated readiness and hides proposal text', () => {
    const root = tempDir();
    const liveArchive = join(root, 'live-archive.jsonl');
    writeFileSync(liveArchive, [
      JSON.stringify({
        verdict: 'tests_passed',
        proposal: 'SECRET SELF IMPROVE PROPOSAL SHOULD NOT LEAK',
      }),
      '',
    ].join('\n'));

    const report = buildNoeSelfEvolutionReadinessAudit({
      liveArchivePath: liveArchive,
      tempRoot: root,
      cleanup: true,
      now: new Date('2026-06-15T00:00:00.000Z'),
    });
    const raw = JSON.stringify(report);
    const md = renderMarkdown(report, join(root, 'audit.json'));

    expect(report.ok).toBe(true);
    expect(report.readiness).toMatchObject({
      status: 'archive_writer_lineage_holdout_ready',
      liveStatus: 'live_archive_still_below_target',
    });
    expect(report.liveArchive).toMatchObject({
      entries: 1,
      variantGenerations: 1,
      hasParentChildLineage: false,
      hasHoldoutEvidence: false,
    });
    expect(report.liveArchive.gaps).toEqual(expect.arrayContaining([
      'live_dgm_archive_generations_below_target',
      'live_dgm_parent_child_lineage_missing',
      'live_dgm_holdout_or_benchmark_missing',
      'live_dgm_applied_entry_missing',
    ]));
    expect(raw).not.toContain('SECRET SELF IMPROVE PROPOSAL');
    expect(md).not.toContain('SECRET SELF IMPROVE PROPOSAL');
  });
});
