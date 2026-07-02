import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildNoeEvolutionArchiveEntry,
  createNoeEvolutionVariantId,
  readLatestNoeEvolutionVariant,
} from '../../src/room/NoeEvolutionArchive.js';

let dir;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('NoeEvolutionArchive', () => {
  it('creates lineage and holdout metadata for DGM variant records', () => {
    const entry = buildNoeEvolutionArchiveEntry({
      ts: Date.parse('2026-06-15T00:00:00Z'),
      proposal: 'improve self-evolution',
      verdict: 'tests_passed',
      plan: { file: 'src/cognition/NoeWorkspace.js', why: 'tune salience', startLine: 10, endLine: 12 },
      patchFile: '~/.noe-panel/self-improve/patches/a.diff',
      parentId: 'dgm-parent',
      holdoutRef: 'output/noe-evolution-holdout/report.json',
      benchmarkRef: 'output/noe-evolution-benchmark/report.json',
    });

    expect(entry).toMatchObject({
      schemaVersion: 1,
      kind: 'noe_evolution_archive_entry',
      verdict: 'tests_passed',
      parentId: 'dgm-parent',
      childId: entry.variantId,
      generation: 1,
      lineage: { parentId: 'dgm-parent', childId: entry.variantId, generation: 1 },
      holdout: { reportRef: 'output/noe-evolution-holdout/report.json' },
      benchmark: { reportRef: 'output/noe-evolution-benchmark/report.json' },
    });
    expect(entry.variantId).toMatch(/^dgm-/);
  });

  it('continues generation from the latest archived variant and reuses lineage for applied records', () => {
    dir = mkdtempSync(join(tmpdir(), 'noe-evolution-archive-'));
    const archivePath = join(dir, 'archive.jsonl');
    const first = buildNoeEvolutionArchiveEntry({
      archivePath,
      ts: Date.parse('2026-06-15T00:00:00Z'),
      proposal: 'first',
      verdict: 'tests_passed',
      variantId: 'dgm-first',
    });
    writeFileSync(archivePath, `${JSON.stringify(first)}\n`);

    const secondId = createNoeEvolutionVariantId({ ts: Date.parse('2026-06-15T00:01:00Z'), proposal: 'second', plan: { file: 'x' }, patchFile: 'p.diff' });
    const second = buildNoeEvolutionArchiveEntry({
      archivePath,
      ts: Date.parse('2026-06-15T00:01:00Z'),
      proposal: 'second',
      verdict: 'tests_passed',
      variantId: secondId,
    });
    writeFileSync(archivePath, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
    const applied = buildNoeEvolutionArchiveEntry({
      archivePath,
      ts: Date.parse('2026-06-15T00:02:00Z'),
      proposal: 'second',
      verdict: 'applied',
      variantId: secondId,
    });

    expect(second).toMatchObject({ parentId: 'dgm-first', generation: 2 });
    expect(readLatestNoeEvolutionVariant({ archivePath })).toMatchObject({ variantId: secondId, parentId: 'dgm-first', generation: 2 });
    expect(applied).toMatchObject({ parentId: 'dgm-first', generation: 2, childId: secondId });
  });

  it('does not attach fake lineage to non-variant archive records', () => {
    const entry = buildNoeEvolutionArchiveEntry({
      proposal: 'declined',
      verdict: 'brain_declined',
      why: 'outside allowlist',
    });

    expect(entry.variantId).toBeUndefined();
    expect(entry.lineage).toBeUndefined();
    expect(entry.why).toBe('outside allowlist');
  });
});
