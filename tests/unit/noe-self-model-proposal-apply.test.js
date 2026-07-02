// @ts-check
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NoeSelfModelVersionStore } from '../../src/context/NoeSelfModelVersionStore.js';
import {
  applySelfModelProposalReport,
  parseSelfModelProposalApplyArgs,
} from '../../scripts/noe-self-model-proposal-apply.mjs';

const tempRoots = [];
const T0 = 1_780_000_000_000;

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'noe-self-model-proposal-apply-'));
  tempRoots.push(dir);
  return dir;
}

function writeReport(root, proposalPatch = { disposition: '更重视证据闭环' }) {
  const file = join(root, 'proposal.json');
  writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    decision: 'proposal_generated',
    proposal: {
      schemaVersion: 1,
      proposalId: 'proposal-apply-unit',
      createdAt: T0,
      source: 'unit',
      status: 'proposed',
      blockers: [],
      reason: 'unit proposal',
      evidenceRefs: ['output/noe-self-maintenance-end2end/latest.json'],
      patch: proposalPatch,
      requiresOwnerConfirmation: false,
    },
  }, null, 2));
  return file;
}

afterEach(() => {
  while (tempRoots.length) {
    const dir = tempRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('noe-self-model-proposal-apply', () => {
  it('parses explicit owner confirmation and source args', () => {
    expect(parseSelfModelProposalApplyArgs([
      '--source', 'output/noe-self-model-proposals/latest.json',
      '--self-model-dir=/tmp/noe-self-model',
      '--confirm-owner',
      '--dry-run',
    ])).toMatchObject({
      source: 'output/noe-self-model-proposals/latest.json',
      selfModelDir: '/tmp/noe-self-model',
      confirmOwner: true,
      dryRun: true,
    });
  });

  it('refuses to apply without explicit owner confirmation', () => {
    const root = tempDir();
    const source = writeReport(root);
    const result = applySelfModelProposalReport({
      source,
      store: new NoeSelfModelVersionStore({ rootDir: join(root, 'self-model'), now: () => T0 }),
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'owner_confirmation_required_for_apply_command',
      proposalId: 'proposal-apply-unit',
    });
  });

  it('applies an owner-confirmed proposal and bootstraps default identity fields', () => {
    const root = tempDir();
    const source = writeReport(root);
    const store = new NoeSelfModelVersionStore({ rootDir: join(root, 'self-model'), now: () => T0 });
    const result = applySelfModelProposalReport({ source, store, confirmOwner: true });
    const current = store.current();

    expect(result).toMatchObject({
      ok: true,
      applied: true,
      proposalId: 'proposal-apply-unit',
      versionId: 'v001',
      previousVersionId: null,
      identityFields: ['disposition', 'name', 'relationship'],
    });
    expect(current.identity).toMatchObject({
      name: 'Noe',
      relationship: expect.stringContaining('owner'),
      disposition: '更重视证据闭环',
    });
    expect(JSON.stringify(result)).not.toContain(current.identity.relationship);
  });

  it('supports dry-run without writing a version file', () => {
    const root = tempDir();
    const source = writeReport(root);
    const store = new NoeSelfModelVersionStore({ rootDir: join(root, 'self-model'), now: () => T0 });
    const result = applySelfModelProposalReport({ source, store, confirmOwner: true, dryRun: true });

    expect(result).toMatchObject({ ok: true, dryRun: true, applied: true, versionId: 'v001' });
    expect(store.current()).toBeNull();
  });

  it('does not print applied identity values in the command summary', () => {
    const root = tempDir();
    const source = writeReport(root, { relationship: 'owner-private-relation', values: ['证据优先'] });
    const store = new NoeSelfModelVersionStore({ rootDir: join(root, 'self-model'), now: () => T0 });
    const result = applySelfModelProposalReport({ source, store, confirmOwner: true });
    const raw = readFileSync(store.current().file, 'utf8');

    expect(raw).toContain('owner-private-relation');
    expect(JSON.stringify(result)).not.toContain('owner-private-relation');
    expect(result.identityFields).toEqual(['disposition', 'name', 'relationship', 'values']);
  });
});
