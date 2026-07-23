// @ts-check
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadEvidenceJson,
  main,
  reduceCandidateStatus,
  summarizeAbsoluteGates,
  summarizeStages,
  synchronizeStageStatuses,
} from '../../scripts/noe-s10-surpass-report.mjs';

const tempRoots = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('noe-s10-surpass-report reducers', () => {
  it('is import-safe and exposes its CLI through main', () => {
    expect(typeof main).toBe('function');
  });

  it('never binds evidence with a missing, stale, or absent current digest', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-s10-report-'));
    tempRoots.push(root);
    const missing = join(root, 'missing-digest.json');
    const matching = join(root, 'matching-digest.json');
    writeFileSync(missing, JSON.stringify({ ok: true }));
    writeFileSync(matching, JSON.stringify({ sourceDigest: 'sha256:current' }));

    expect(loadEvidenceJson(missing, 'sha256:current')).toMatchObject({
      ok: true,
      bound: false,
      reason: 'evidence_digest_missing',
      dig: null,
    });
    expect(loadEvidenceJson(matching, '')).toMatchObject({
      bound: false,
      reason: 'current_digest_missing',
    });
    expect(loadEvidenceJson(matching, 'sha256:stale')).toMatchObject({
      bound: false,
      reason: 'stale_digest',
    });
    expect(loadEvidenceJson(matching, 'sha256:current')).toMatchObject({
      bound: true,
      reason: null,
    });
  });

  it('computes gate counts without folding blocked or waived into pass', () => {
    const gates = [
      ...Array.from({ length: 14 }, (_, index) => ({ id: `G-${index}`, status: 'pass' })),
      { id: 'G-FIRST-01', status: 'blocked_external' },
      { id: 'G-SOAK-01', status: 'pending_owner_waived' },
      { id: 'G-SOAK-02', status: 'pending_owner_waived' },
    ];
    expect(summarizeAbsoluteGates(gates)).toEqual({
      pass: 14,
      pending: 0,
      fail: 0,
      blocked_external: 1,
      pending_owner_waived: 2,
      total: 17,
      bar: '14/17',
    });
  });

  it('allows only a partial candidate when soak alone is owner-waived', () => {
    const gates = Array.from({ length: 15 }, (_, index) => ({
      id: `G-${index}`,
      status: 'pass',
    }));
    const dimensions = Array.from({ length: 11 }, (_, index) => ({
      id: `D-${index}`,
      relative: 'neo_not_below',
    }));
    expect(
      reduceCandidateStatus({
        nonSoakGates: gates,
        nonSoakDimensions: dimensions,
        soakComplete: false,
        soakOwnerWaived: true,
      }),
    ).toBe('partial_owner_waived_soak');
    expect(
      reduceCandidateStatus({
        nonSoakGates: gates,
        nonSoakDimensions: [
          ...dimensions.slice(0, -1),
          { id: 'D12', relative: 'non_comparable' },
        ],
        soakComplete: false,
        soakOwnerWaived: true,
      }),
    ).toBe('in_progress');
    expect(
      reduceCandidateStatus({
        nonSoakGates: [
          ...gates.slice(0, -1),
          { id: 'G-FIRST-01', status: 'blocked_external' },
        ],
        nonSoakDimensions: dimensions,
        blockedExternal: ['G-FIRST_five_real_humans'],
        soakOwnerWaived: true,
      }),
    ).toBe('blocked_external');
  });

  it('synchronizes G-FIRST and propagates blocked stage dependencies', () => {
    const stages = [
      { id: 'S4', status: 'completed', dependsOn: [] },
      { id: 'S5', status: 'completed', dependsOn: ['S4'] },
      { id: 'S6', status: 'completed', dependsOn: ['S5'] },
      { id: 'S8', status: 'blocked_external', dependsOn: ['S6'] },
      { id: 'S9', status: 'completed', dependsOn: ['S8'] },
    ];
    const reduced = synchronizeStageStatuses(stages, [
      { id: 'G-FIRST-01', status: 'blocked_external' },
    ]);
    expect(reduced.find((stage) => stage.id === 'S5')?.status).toBe('blocked_external');
    expect(reduced.find((stage) => stage.id === 'S6')?.status).toBe('blocked_dependency');
    expect(reduced.find((stage) => stage.id === 'S8')?.status).toBe('blocked_external');
    expect(reduced.find((stage) => stage.id === 'S9')?.status).toBe('blocked_dependency');
    expect(summarizeStages(reduced)).toMatchObject({
      total: 5,
      completed: 1,
      byStatus: {
        completed: 1,
        blocked_external: 2,
        blocked_dependency: 2,
      },
    });
  });
});
