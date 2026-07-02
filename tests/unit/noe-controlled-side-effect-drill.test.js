import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateNoeActionEvidence } from '../../src/runtime/NoeActionEvidence.js';

let dir;

function runDrill(args = []) {
  const stdout = execFileSync(
    process.execPath,
    ['scripts/noe-controlled-side-effect-drill.mjs', ...args],
    {
      cwd: process.cwd(),
      env: { ...process.env, NOE_CONTROLLED_SIDE_EFFECT_OUT_DIR: dir },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return JSON.parse(stdout);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noe-side-effect-drill-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('noe-controlled-side-effect-drill', () => {
  it('previews without creating a side-effect report', () => {
    const preview = runDrill();

    expect(preview).toMatchObject({ ok: true, applied: false, wouldRollback: true });
    expect(existsSync(dir)).toBe(true);
  });

  it('writes, verifies, rolls back, and emits rollback-capable action evidence', () => {
    const report = runDrill(['--apply']);

    expect(report.ok).toBe(true);
    expect(report.applied).toBe(true);
    expect(report.sideEffect).toMatchObject({
      externalSideEffectPerformed: true,
      localFilesystemSideEffect: true,
      publicNetworkSideEffect: false,
      writeVerified: true,
    });
    expect(report.rollback).toMatchObject({
      performed: true,
      verified: true,
      artifactAbsent: true,
    });
    expect(report.actionEvidence.dryRunOnly).toBe(false);
    expect(validateNoeActionEvidence(report.actionEvidence, {
      requireRuntime: true,
      requireRollback: true,
    }).ok).toBe(true);
    expect(existsSync(report.sideEffect.artifactPath)).toBe(false);
    expect(JSON.parse(readFileSync(report.reportPath, 'utf8')).ok).toBe(true);
  });
});
