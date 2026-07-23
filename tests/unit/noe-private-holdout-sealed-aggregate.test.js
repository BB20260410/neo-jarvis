import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createNoePrivateHoldoutSealedAggregate } from '../../src/eval/NoePrivateHoldoutSealedAggregate.js';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'noe-sealed-holdout-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Noe private holdout sealed aggregate', () => {
  it('returns metadata-only counts and hash without leaking filenames or file body', () => withTempDir((dir) => {
    writeFileSync(join(dir, 'do-not-leak-name.bin'), 'opaque sealed payload must not leak');

    const report = createNoePrivateHoldoutSealedAggregate({
      datasetDir: dir,
      observedAt: '2026-06-19T16:00:00+08:00',
    });

    expect(report.ok).toBe(true);
    expect(report.stage).toBe('C');
    expect(report.redacted).toBe(true);
    expect(report.evaluationMode).toBe('sealed_metadata_hash_only');
    expect(report.fileCount).toBe(1);
    expect(report.jsonFileCount).toBe(0);
    expect(report.nonJsonFileCount).toBe(1);
    expect(report.parsedJsonFileCount).toBe(0);
    expect(report.parseFailedFileCount).toBe(0);
    expect(report.policy).toMatchObject({
      filenamesStored: false,
      caseIdsStored: false,
      rawContentRead: false,
      rawContentPrinted: false,
      rawCaseContentStored: false,
      rawContentReadAllowed: false,
    });
    expect(report.warningCategories).toEqual(expect.arrayContaining([
      { category: 'sealed_holdout_no_json_artifacts', count: 1 },
      { category: 'non_json_file', count: 1 },
    ]));

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('do-not-leak-name');
    expect(serialized).not.toContain('opaque sealed payload must not leak');
  }));

  it('does not read file bytes while aggregating sealed metadata', () => withTempDir((dir) => {
    const file = join(dir, 'unreadable-name-must-not-leak.bin');
    writeFileSync(file, 'unreadable body must not be needed');
    chmodSync(file, 0o000);
    try {
      const report = createNoePrivateHoldoutSealedAggregate({
        datasetDir: dir,
        observedAt: '2026-06-19T16:00:00+08:00',
      });

      expect(report.ok).toBe(true);
      expect(report.fileCount).toBe(1);
      expect(report.policy.rawContentRead).toBe(false);
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain('unreadable-name-must-not-leak');
      expect(serialized).not.toContain('unreadable body must not be needed');
    } finally {
      chmodSync(file, 0o600);
    }
  }));

  it('records json artifacts as unparsed by policy instead of parsing hidden content', () => withTempDir((dir) => {
    writeFileSync(join(dir, 'json-name-must-not-leak.json'), '{"id":"raw-json-body-must-not-leak",');

    const report = createNoePrivateHoldoutSealedAggregate({
      datasetDir: dir,
      observedAt: '2026-06-19T16:00:00+08:00',
    });

    expect(report.ok).toBe(true);
    expect(report.jsonFileCount).toBe(1);
    expect(report.parsedJsonFileCount).toBe(0);
    expect(report.parseFailedFileCount).toBe(0);
    expect(report.warningCategories).toEqual(expect.arrayContaining([
      { category: 'sealed_holdout_json_artifacts_not_parsed_by_policy', count: 1 },
    ]));

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('json-name-must-not-leak');
    expect(serialized).not.toContain('raw-json-body-must-not-leak');
  }));
});
