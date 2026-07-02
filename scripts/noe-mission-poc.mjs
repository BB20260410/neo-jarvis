#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NoeCloudProviderRegistry } from '../src/cloud/NoeCloudProviderRegistry.js';
import { assembleEvidencePack, serializeEvidencePack, validateEvidencePack } from '../src/runtime/mission/NoeEvidencePack.js';
import { NoeEvidenceReconciler } from '../src/runtime/mission/NoeEvidenceReconciler.js';
import { NoeMissionStore } from '../src/runtime/mission/NoeMissionStore.js';
import { NoePatchTransaction } from '../src/runtime/mission/NoePatchTransaction.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const prefixed = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function safeId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'provider';
}

function missionContract(missionId, { providerId = 'mock-minimax-m3' } = {}) {
  const safePatchRef = `output/noe-mission-poc/${missionId}/safe-patch.txt`;
  const evidencePackRef = `output/noe-missions/${missionId}/artifacts/evidence-pack.json`;
  const patchPlanRef = `output/noe-missions/${missionId}/artifacts/cloud-task-output.json`;
  const reportRef = `output/noe-missions/${missionId}/artifacts/final-report.json`;
  return {
    missionId,
    objective: `Cloud Change Lead provider ${providerId} produces a patch plan that local mission runtime applies and verifies.`,
    scope: ['src/runtime/mission/**', 'src/cloud/**', 'scripts/noe-mission-poc.mjs', 'output/noe-mission-poc/**'],
    forbidden: ['.env', 'token', 'cookie', 'OAuth', 'owner-token', '51735', 'games/cartoon-apocalypse/**'],
    completionCriteria: [
      { id: 'safe-patch-exists', type: 'file_exists', ref: safePatchRef },
      { id: 'evidence-pack-linked', type: 'evidence_ref_exists', ref: evidencePackRef },
      { id: 'patch-plan-linked', type: 'evidence_ref_exists', ref: patchPlanRef },
      { id: 'final-report-traces-evidence', type: 'final_report_traces_evidence', evidenceRefs: [evidencePackRef, patchPlanRef, safePatchRef] },
      { id: 'no-open-blockers', type: 'no_unresolved_blockers' },
      { id: 'no-truncation', type: 'no_truncated_results' },
    ],
    evidenceRequirements: [
      { id: 'evidence-pack', ref: evidencePackRef, required: true },
      { id: 'patch-plan', ref: patchPlanRef, required: true },
      { id: 'safe-patch', ref: safePatchRef, required: true },
    ],
    rollbackPlan: ['Remove output/noe-mission-poc/<missionId> and output/noe-missions/<missionId> if this PoC output is not needed.'],
    autonomyLevel: 'local_write',
    leader: 'cloud',
    executor: 'local',
    reviewers: ['local_review'],
    cloudContextPolicy: 'redacted_brief',
    patchAuthority: 'request_apply',
    localAutonomy: 'apply',
    reviewPolicy: { ownerGate: ['external_write', 'live_write', 'delete', 'publish'], reviewBrain: ['high_risk_write'] },
    expectedArtifacts: [{ id: 'final_report', type: 'final_report', ref: reportRef }],
    plan: [{ id: 'mock-cloud-change-lead-poc', type: 'mock_cloud_patch_plan' }],
  };
}

async function main() {
  const providerId = argValue('--provider', 'mock-minimax-m3');
  const livePreflight = hasArg('--live-preflight');
  const missionId = `cloud-change-lead-poc-${safeId(providerId)}-${Date.now()}`;
  const store = new NoeMissionStore({ root: ROOT });
  const created = store.createMission(missionContract(missionId, { providerId }));
  const mission = store.readMission(missionId);
  const state = store.readState(missionId);

  const evidencePack = assembleEvidencePack({
    root: ROOT,
    mission,
    state,
    files: ['src/runtime/mission/NoeMissionContract.js', 'src/cloud/NoeCloudProviderRegistry.js', 'package.json'],
    snippets: [
      'Synthetic redaction check: OPENAI_API_KEY=sk-testredaction000000000000000000 should never survive.',
      'Cloud Change Lead should see evidence, not raw secrets or full private memory.',
    ],
    testOutputs: ['poc bootstrapping: no tests have run yet'],
    constraints: mission.forbidden,
  });
  const evidencePackValidation = validateEvidencePack(evidencePack);
  const serializedPack = serializeEvidencePack(evidencePack);
  const evidenceArtifact = store.writeArtifact(missionId, 'evidence-pack.json', JSON.parse(serializedPack.text));

  const registry = new NoeCloudProviderRegistry();
  const preflight = livePreflight
    ? await registry.preflightLive(providerId)
    : registry.preflight(providerId);
  const cloudOutput = await registry.generatePatchPlan({
    providerId,
    evidencePack,
    objective: mission.objective,
  });
  const patchPlanArtifact = store.writeArtifact(missionId, 'cloud-task-output.json', cloudOutput);

  const evidenceReconciler = new NoeEvidenceReconciler({ root: ROOT });
  const noEvidenceDecision = evidenceReconciler.decideSucceeded({
    taskOutput: cloudOutput,
    evidenceRefs: [],
    requiredEvidenceRefs: [cloudOutput.patchPlan?.operations?.[0]?.path].filter(Boolean),
  });

  let applyResult = { ok: false, changedFiles: [], skipped: true, reason: 'cloud_patch_plan_unavailable' };
  let diffArtifact = { ref: '' };
  if (cloudOutput.patchPlan) {
    const patchTransaction = new NoePatchTransaction({ root: ROOT, missionId, patchPlan: cloudOutput.patchPlan });
    applyResult = patchTransaction.apply();
    diffArtifact = store.writeArtifact(missionId, 'patch-transaction.json', patchTransaction.recordDiff());
  }
  const safePatchRef = applyResult.changedFiles?.[0];
  if (safePatchRef) store.addEvidenceRef(missionId, safePatchRef);

  const rollbackTarget = `output/noe-mission-poc/${missionId}/rollback-target.txt`;
  const rollbackTransaction = new NoePatchTransaction({
    root: ROOT,
    missionId,
    patchPlan: {
      operations: [{ id: 'write-rollback-target', op: 'write_file', path: rollbackTarget, content: 'temporary failing test output\n' }],
    },
  });
  const rollbackApply = rollbackTransaction.apply();
  const rollbackResult = rollbackTransaction.rollback();

  const acceptedOutput = { ...cloudOutput, evidenceRefs: [safePatchRef, evidenceArtifact.ref, patchPlanArtifact.ref, diffArtifact.ref].filter(Boolean) };
  const evidenceDecision = evidenceReconciler.decideSucceeded({
    taskOutput: acceptedOutput,
    evidenceRefs: acceptedOutput.evidenceRefs,
    requiredEvidenceRefs: [safePatchRef, evidenceArtifact.ref, patchPlanArtifact.ref].filter(Boolean),
  });

  const gates = {
    providerReady: preflight.ok === true,
    cloudPatchPlan: cloudOutput.ok === true && Boolean(cloudOutput.patchPlan),
    mockCloudPatchPlan: providerId === 'mock-minimax-m3' ? cloudOutput.ok === true && Boolean(cloudOutput.patchPlan) : true,
    redactedEvidencePack: evidencePackValidation.ok && !serializedPack.text.includes('sk-testredaction000000000000000000'),
    safePatchApplied: applyResult.ok === true && Boolean(safePatchRef && existsSync(resolve(ROOT, safePatchRef))),
    rollbackOnFailure: rollbackApply.ok === true && rollbackResult.ok === true && !existsSync(resolve(ROOT, rollbackTarget)),
    claimedSuccessBlockedWithoutEvidence: cloudOutput.claimedSucceeded === true
      ? noEvidenceDecision.ok === false && noEvidenceDecision.blockers.includes('cloud_claimed_success_without_evidence')
      : true,
  };

  const finalReport = store.writeArtifact(missionId, 'final-report.json', {
    ok: Object.values(gates).every(Boolean) && evidenceDecision.ok,
    missionId,
    providerId,
    livePreflight,
    summary: 'Cloud provider generated a patch plan; local runtime assembled evidence, applied a safe patch when available, rolled back a simulated failure, and rejected cloud success without evidence.',
    evidenceRefs: [evidenceArtifact.ref, patchPlanArtifact.ref, diffArtifact.ref, safePatchRef].filter(Boolean),
    gates,
  });
  store.updateState(missionId, (current) => ({ ...current, finalReportRef: finalReport.ref }));
  store.addEvidenceRef(missionId, finalReport.ref);

  const result = {
    ok: Object.values(gates).every(Boolean) && evidenceDecision.ok,
    missionId,
    provider: { requested: providerId, livePreflight, used: preflight },
    gates,
    evidenceDecision,
    refs: {
      ...created.refs,
      evidencePack: evidenceArtifact.ref,
      cloudTaskOutput: patchPlanArtifact.ref,
      patchTransaction: diffArtifact.ref,
      safePatch: safePatchRef,
      finalReport: finalReport.ref,
    },
    secretValuesReturned: false,
  };
  if (!result.ok) process.exitCode = 1;
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.log(JSON.stringify({ ok: false, error: error.message, secretValuesReturned: false }, null, 2));
  process.exitCode = 1;
});
