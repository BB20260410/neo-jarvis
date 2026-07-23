// @ts-check
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FIXED_BASELINE,
  fixedBaselineTreeMatches,
  main,
} from '../../scripts/noe-twelve-dim-compare.mjs';

describe('noe-twelve-dim-compare contract', () => {
  it('is import-safe and exposes its CLI through main', () => {
    expect(typeof main).toBe('function');
  });

  it('requires both the exact fixed version and exact commit', () => {
    expect(
      fixedBaselineTreeMatches({
        version: FIXED_BASELINE.version,
        commit: FIXED_BASELINE.commit,
        worktreeClean: true,
      }),
    ).toBe(true);
    expect(
      fixedBaselineTreeMatches({
        version: FIXED_BASELINE.version,
        commit: 'wrong-commit',
        worktreeClean: true,
      }),
    ).toBe(false);
    expect(
      fixedBaselineTreeMatches({
        version: '2.1.550',
        commit: FIXED_BASELINE.commit,
        worktreeClean: true,
      }),
    ).toBe(false);
    expect(
      fixedBaselineTreeMatches({
        version: FIXED_BASELINE.version,
        commit: FIXED_BASELINE.commit,
        worktreeClean: false,
      }),
    ).toBe(false);
  });

  it('uses rootDir and has no unconditional commit-match escape hatch', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../scripts/noe-twelve-dim-compare.mjs', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('computeSourceDigest({ rootDir: ROOT })');
    expect(source).not.toMatch(/commitMatch:\s*[^\n]*\|\|\s*true/);
  });

  it('does not synthesize D11 or G-FIRST scores from internal probes', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../scripts/noe-twelve-dim-compare.mjs', import.meta.url)),
      'utf8',
    );
    expect(source).not.toContain("expectedSha256: 'a'.repeat(64)");
    expect(source).not.toContain('signatureValid: true');
    expect(source).not.toContain('packagingInternal:');
    expect(source).toContain("runKind: 'neo_internal_technical_probe'");
    expect(source).toContain("relativeReason: 'bilateral_real_artifact_update_rollback_records_missing'");
    expect(source).toContain("g.absoluteGateStatus === 'pass'");
    expect(source).toContain('g.fiveRealHumans === true');
    expect(source).toContain('g.cleanMachineInstall === true');
  });
});
