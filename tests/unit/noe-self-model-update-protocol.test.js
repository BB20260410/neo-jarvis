// @ts-check
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NoeSelfModelVersionStore } from '../../src/context/NoeSelfModelVersionStore.js';
import {
  applySelfModelDiffProposal,
  createSelfModelDiffProposal,
} from '../../src/context/NoeSelfModelUpdateProtocol.js';

const tempRoots = [];
const T0 = 1_780_000_000_000;

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'noe-self-model-proposal-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tempRoots.length) {
    const dir = tempRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('NoeSelfModelUpdateProtocol', () => {
  it('blocks proposals without evidence and rejects non-whitelisted or secret-like fields', () => {
    const proposal = createSelfModelDiffProposal({
      currentIdentity: { name: 'Noe' },
      patch: {
        disposition: '更重视证据',
        apiKey: ['sk', 'cp', '1234567890abcdef'].join('-'),
        unknown: 'x',
      },
      evidenceRefs: [],
      now: () => T0,
      proposalId: 'p-blocked',
    });

    expect(proposal.status).toBe('blocked');
    expect(proposal.blockers).toContain('evidence_required');
    expect(proposal.blockers).toContain('field_forbidden:apiKey');
    expect(proposal.blockers).toContain('field_not_allowed:apiKey');
    expect(proposal.blockers).toContain('field_not_allowed:unknown');
    expect(proposal.blockers).toContain('secret_like_value_forbidden');
  });

  it('applies evidence-backed non-core disposition changes without owner confirmation', () => {
    const store = new NoeSelfModelVersionStore({ rootDir: tempDir(), now: () => T0 });
    store.writeNextVersion({
      identity: { name: 'Noe', relationship: 'owner 是我的主人', disposition: '诚实' },
      ownerConfirmed: true,
      proposalId: 'p0',
    });
    const proposal = createSelfModelDiffProposal({
      currentIdentity: store.current().identity,
      patch: { disposition: '诚实，且更重视证据闭环' },
      reason: 'weekly behavior audit',
      evidenceRefs: ['output/noe-self-maintenance-end2end/latest.json'],
      now: () => T0 + 1,
      proposalId: 'p1',
    });

    expect(proposal.status).toBe('proposed');
    expect(proposal.requiresOwnerConfirmation).toBe(false);
    const applied = applySelfModelDiffProposal({ store, proposal });
    expect(applied.ok).toBe(true);
    expect(store.current().versionId).toBe('v002');
    expect(store.current().identity.disposition).toBe('诚实，且更重视证据闭环');
  });

  it('requires owner confirmation before applying core identity changes', () => {
    const store = new NoeSelfModelVersionStore({ rootDir: tempDir(), now: () => T0 });
    store.writeNextVersion({
      identity: { name: 'Noe', relationship: 'owner 是我的主人', values: ['诚实'] },
      ownerConfirmed: true,
      proposalId: 'p0',
    });
    const proposal = createSelfModelDiffProposal({
      currentIdentity: store.current().identity,
      patch: { name: '伴影', values: ['诚实', '证据优先'] },
      reason: 'owner requested identity refinement',
      evidenceRefs: ['docs/DESIGN_2026-06-11_AI自我意识实现方案.md#7.6'],
      now: () => T0 + 1,
      proposalId: 'p-core',
    });

    expect(proposal.requiresOwnerConfirmation).toBe(true);
    expect(applySelfModelDiffProposal({ store, proposal })).toMatchObject({
      ok: false,
      reason: 'owner_confirmation_required_for_identity_core',
      proposalId: 'p-core',
    });
    const applied = applySelfModelDiffProposal({ store, proposal, ownerConfirmed: true });
    expect(applied.ok).toBe(true);
    expect(store.current().versionId).toBe('v002');
    expect(store.current().identity).toMatchObject({ name: '伴影', relationship: 'owner 是我的主人', values: ['诚实', '证据优先'] });
  });
});
