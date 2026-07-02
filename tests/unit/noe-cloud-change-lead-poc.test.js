import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { NoeCloudProviderRegistry, normalizePatchPlan } from '../../src/cloud/NoeCloudProviderRegistry.js';
import { assembleEvidencePack, serializeEvidencePack, validateEvidencePack } from '../../src/runtime/mission/NoeEvidencePack.js';
import { NoeEvidenceReconciler } from '../../src/runtime/mission/NoeEvidenceReconciler.js';
import { normalizeMissionContract, validateMissionContract } from '../../src/runtime/mission/NoeMissionContract.js';
import { NoePatchTransaction } from '../../src/runtime/mission/NoePatchTransaction.js';

function withTempRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'noe-cloud-change-lead-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function baseMission() {
  return {
    missionId: 'cloud-led-contract',
    objective: 'cloud leads, local applies and verifies',
    scope: ['output/**'],
    forbidden: ['.env', 'token', '51735'],
    completionCriteria: [{ id: 'proof', type: 'file_exists', ref: 'output/proof.txt' }],
    evidenceRequirements: [{ id: 'proof', ref: 'output/proof.txt' }],
    rollbackPlan: ['remove output/proof.txt'],
    autonomyLevel: 'local_write',
    leader: 'cloud',
    executor: 'local',
    reviewers: ['local_review', 'cloud_review'],
    cloudContextPolicy: 'redacted_brief',
    patchAuthority: 'request_apply',
    localAutonomy: 'apply',
    reviewPolicy: { ownerGate: ['external_write'] },
    expectedArtifacts: [{ id: 'final_report', type: 'final_report', ref: 'output/report.json' }],
  };
}

describe('Cloud Change Lead PoC primitives', () => {
  it('normalizes and validates cloud-led mission contract fields', () => {
    const mission = normalizeMissionContract(baseMission(), { nowMs: 1_000 });
    expect(mission).toMatchObject({
      leader: 'cloud',
      executor: 'local',
      reviewers: ['local_review', 'cloud_review'],
      cloudContextPolicy: 'redacted_brief',
      patchAuthority: 'request_apply',
      localAutonomy: 'apply',
    });
    expect(validateMissionContract(mission)).toMatchObject({ ok: true });
  });

  it('assembles a redacted read-only EvidencePack without secret-like values', () => withTempRoot((root) => {
    const pack = assembleEvidencePack({
      root,
      mission: { missionId: 'evidence-pack', objective: 'redact secrets', leader: 'cloud' },
      snippets: ['OPENAI_API_KEY=sk-redact000000000000000000000000 should not survive'],
      files: ['.env'],
    });
    const validation = validateEvidencePack(pack);
    const serialized = serializeEvidencePack(pack).text;

    expect(validation.ok).toBe(true);
    expect(pack.redactionReport.secretValuesReturned).toBe(false);
    expect(pack.redactionReport.blockedFiles[0].ref).toBe('.env');
    expect(serialized).not.toContain('sk-redact000000000000000000000000');
    expect(serialized).toContain('OPENAI_API_KEY=[redacted]');
  }));

  it('applies a safe patch and rolls it back as a local PatchTransaction', () => withTempRoot((root) => {
    const target = 'output/noe-mission-poc/unit/safe-patch.txt';
    const tx = new NoePatchTransaction({
      root,
      missionId: 'unit',
      patchPlan: { operations: [{ id: 'write-safe', op: 'write_file', path: target, content: 'ok\n' }] },
    });

    expect(tx.checkPreconditions()).toMatchObject({ ok: true });
    const applied = tx.apply();
    expect(applied).toMatchObject({ ok: true, changedFiles: [target] });
    expect(readFileSync(join(root, target), 'utf8')).toBe('ok\n');

    const rolledBack = tx.rollback();
    expect(rolledBack.ok).toBe(true);
    expect(existsSync(join(root, target))).toBe(false);
  }));

  it('blocks cloud claimed success when local evidence is missing', () => withTempRoot((root) => {
    const reconciler = new NoeEvidenceReconciler({ root });
    const decision = reconciler.decideSucceeded({
      taskOutput: { provenance: 'cloud', claimedSucceeded: true, evidenceRefs: [] },
      evidenceRefs: [],
      requiredEvidenceRefs: ['output/proof.txt'],
    });

    expect(decision.ok).toBe(false);
    expect(decision.blockers).toContain('cloud_claimed_success_without_evidence');
    expect(decision.blockers).toContain('cloud_output_missing_evidence_refs');
  }));

  it('preflights mock MiniMax M3 and generates a patch plan', async () => {
    const registry = new NoeCloudProviderRegistry();
    expect(registry.preflight('mock-minimax-m3')).toMatchObject({ ok: true, model: 'MiniMax-M3', mock: true });

    const output = await registry.generatePatchPlan({
      providerId: 'mock-minimax-m3',
      evidencePack: { missionId: 'provider-unit', objective: 'write safe patch' },
    });
    expect(output).toMatchObject({
      ok: true,
      provenance: 'cloud',
      provider: 'mock',
      model: 'MiniMax-M3',
      claimedSucceeded: true,
    });
    expect(output.patchPlan.operations[0]).toMatchObject({
      op: 'write_file',
      path: 'output/noe-mission-poc/provider-unit/safe-patch.txt',
    });
  });

  it('preflights real MiniMax M3 through a safe resolver without returning secret values', () => {
    const registry = new NoeCloudProviderRegistry({
      resolveSecret: (provider) => ({ ok: provider === 'minimax', provider, value: 'secret-value-not-returned', source: 'unit', sourceRef: 'fixture' }),
    });

    const preflight = registry.preflight('minimax-m3');

    expect(preflight).toMatchObject({
      ok: true,
      providerId: 'minimax-m3',
      provider: 'minimax',
      model: 'MiniMax-M3',
      configured: true,
      source: 'unit',
      sourceRef: 'fixture',
      secretValuesReturned: false,
    });
    expect(JSON.stringify(preflight)).not.toContain('secret-value-not-returned');
  });

  it('runs MiniMax M3 live preflight through provider health without exposing the key', async () => {
    const registry = new NoeCloudProviderRegistry({
      resolveSecret: (provider) => ({ ok: provider === 'minimax', provider, value: 'secret-value-not-returned', source: 'unit', sourceRef: 'fixture' }),
      fetchImpl: async (url, init) => {
        expect(String(url)).toContain('/models');
        expect(init?.headers?.Authorization).toBe('Bearer secret-value-not-returned');
        return {
          status: 200,
          text: async () => JSON.stringify({ data: [{ id: 'MiniMax-M3' }] }),
        };
      },
    });

    const preflight = await registry.preflightLive('minimax-m3');

    expect(preflight).toMatchObject({
      ok: true,
      reachable: true,
      authOk: true,
      status: 'reachable',
      modelCount: 1,
      selectedModelListed: true,
      secretValuesReturned: false,
    });
    expect(JSON.stringify(preflight)).not.toContain('secret-value-not-returned');
  });

  it('generates a MiniMax M3 cloud patch plan through an injected runner while leaving local evidence as final authority', async () => {
    const registry = new NoeCloudProviderRegistry({
      resolveSecret: () => ({ ok: true, value: 'secret-value-not-returned', source: 'unit' }),
      runner: async () => ({
        reply: JSON.stringify({
          kind: 'noe_patch_plan',
          providerId: 'minimax-m3',
          objective: 'write a safe plan',
          operations: [
            {
              id: 'write-safe-patch-proof',
              op: 'write_file',
              path: 'output/noe-mission-poc/minimax-unit/safe-patch.txt',
              content: 'cloud plan only; local applies and verifies\n',
            },
          ],
          risks: ['local verification still required'],
          evidenceRefs: ['output/evidence-pack.json'],
        }),
        raw: { choices: [{ finish_reason: 'stop' }] },
      }),
    });

    const output = await registry.generatePatchPlan({
      providerId: 'minimax-m3',
      evidencePack: { missionId: 'minimax-unit', objective: 'write a safe plan' },
    });

    expect(output).toMatchObject({
      ok: true,
      provenance: 'cloud',
      provider: 'minimax',
      model: 'MiniMax-M3',
      claimedSucceeded: false,
      finishReason: 'stop',
      incomplete: false,
    });
    expect(output.patchPlan.operations[0]).toMatchObject({
      op: 'write_file',
      path: 'output/noe-mission-poc/minimax-unit/safe-patch.txt',
    });
    expect(JSON.stringify(output)).not.toContain('secret-value-not-returned');
  });

  it('marks MiniMax length-stop patch plans incomplete instead of treating them as success', async () => {
    const registry = new NoeCloudProviderRegistry({
      resolveSecret: () => ({ ok: true, value: 'secret-value-not-returned', source: 'unit' }),
      runner: async () => ({
        reply: '{"kind":"noe_patch_plan"',
        raw: { choices: [{ finish_reason: 'length' }] },
      }),
    });

    const output = await registry.generatePatchPlan({
      providerId: 'minimax-m3',
      evidencePack: { missionId: 'minimax-length', objective: 'truncated plan' },
    });

    expect(output).toMatchObject({
      ok: false,
      provenance: 'cloud',
      provider: 'minimax',
      finishReason: 'length',
      truncated: true,
      incomplete: true,
      claimedSucceeded: false,
    });
  });

  it('rejects unsafe cloud patch plan operations before local apply', () => {
    const out = normalizePatchPlan({
      kind: 'noe_patch_plan',
      operations: [{ id: 'delete-env', op: 'delete_file', path: '.env', content: '' }],
    }, { missionId: 'unsafe-unit', providerId: 'minimax-m3', objective: 'unsafe' });

    expect(out.ok).toBe(false);
    expect(out.blockers).toContain('unsupported_operation:delete_file');
    expect(out.blockers).toContain('operation_path_outside_safe_prefix:.env');
  });
});
