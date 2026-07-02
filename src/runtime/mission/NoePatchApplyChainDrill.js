// @ts-check

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runNoePatchApply, runNoePatchRollback } from './NoePatchApplyExecutor.js';
import { redactSensitiveText } from '../NoeContextScrubber.js';

export const NOE_PATCH_APPLY_CHAIN_DRILL_SCHEMA_VERSION = 1;
export const NOE_PATCH_APPLY_CHAIN_DRILL_DIR = 'output/noe-patch-transactions/drills';

function clean(value, max = 1000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function rel(root, file) {
  return relative(root, file).replaceAll('\\', '/');
}

function sha256(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function safeRunId(value = '') {
  const base = clean(value || `patch-apply-chain-${Date.now()}-${randomUUID().slice(0, 8)}`, 160)
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .slice(0, 120);
  return base || `patch-apply-chain-${Date.now()}`;
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function buildNoePatchApplyChainDrillPatch({ runId = 'patch-apply-chain' } = {}) {
  const safeId = safeRunId(runId);
  return {
    ok: true,
    provenance: 'cloud',
    provider: 'fixture-cloud-change-lead',
    model: 'fixture',
    claimedSucceeded: false,
    patchPlan: {
      kind: 'noe_patch_plan',
      providerId: 'fixture-cloud-change-lead',
      objective: 'verify local patch apply and rollback chain with isolated output target',
      operations: [{
        id: 'write-isolated-proof',
        op: 'write_file',
        path: `output/noe-patch-transactions/drills/${safeId}/target/proof.txt`,
        content: `patch apply chain drill proof\nrunId=${safeId}\n`,
      }],
      evidenceRefs: [],
      risks: ['isolated output-only write; rollback must remove the proof file'],
    },
    secretValuesReturned: false,
  };
}

export function runNoePatchApplyChainDrill({
  root = process.cwd(),
  outDir = NOE_PATCH_APPLY_CHAIN_DRILL_DIR,
  runId = '',
  now = new Date(),
} = {}) {
  const rootAbs = resolve(root);
  const safeId = safeRunId(runId);
  const generatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const runDir = resolve(rootAbs, outDir, safeId);
  const patchOutput = buildNoePatchApplyChainDrillPatch({ runId: safeId });
  const patchPlanRef = rel(rootAbs, resolve(runDir, 'cloud-task-output.json'));
  const targetRef = patchOutput.patchPlan.operations[0].path;
  const targetPath = resolve(rootAbs, targetRef);
  writeJson(resolve(rootAbs, patchPlanRef), patchOutput);

  const dryRunApply = runNoePatchApply({ root: rootAbs, patchPlanRef, dryRun: true, now });
  const unconfirmedApply = runNoePatchApply({ root: rootAbs, patchPlanRef, dryRun: false, confirmOwner: false, now });
  const confirmedApply = runNoePatchApply({ root: rootAbs, patchPlanRef, dryRun: false, confirmOwner: true, now });
  const targetExistsAfterApply = existsSync(targetPath);
  const targetHashAfterApply = targetExistsAfterApply ? sha256(readFileSync(targetPath, 'utf8')) : '';
  const rollbackDryRun = runNoePatchRollback({ root: rootAbs, applyReportRef: confirmedApply.reportRef, dryRun: true, now });
  const confirmedRollback = runNoePatchRollback({ root: rootAbs, applyReportRef: confirmedApply.reportRef, dryRun: false, confirmOwner: true, now });
  const targetExistsAfterRollback = existsSync(targetPath);

  const gates = {
    patchPlanWritten: existsSync(resolve(rootAbs, patchPlanRef)),
    dryRunReady: dryRunApply.status === 'dry_run_ready' && dryRunApply.writesRepoFiles === false,
    unconfirmedBlocked: unconfirmedApply.status === 'blocked' && unconfirmedApply.errors.some((item) => item.error === 'owner_confirmation_required'),
    confirmedApplyWroteTarget: confirmedApply.status === 'applied' && targetExistsAfterApply && confirmedApply.changedFiles.includes(targetRef),
    rollbackDryRunReady: rollbackDryRun.status === 'dry_run_ready' && rollbackDryRun.writesRepoFiles === false,
    confirmedRollbackRemovedTarget: confirmedRollback.status === 'rolled_back' && targetExistsAfterRollback === false,
    secretValuesReturned: false,
  };
  const ok = Object.entries(gates).every(([key, value]) => key === 'secretValuesReturned' ? value === false : value === true);
  const report = {
    ok,
    schemaVersion: NOE_PATCH_APPLY_CHAIN_DRILL_SCHEMA_VERSION,
    generatedAt,
    status: ok ? 'passed' : 'blocked',
    runId: safeId,
    patchPlanRef,
    targetRef,
    targetHashAfterApply,
    gates,
    stages: {
      dryRunApply: {
        status: dryRunApply.status,
        reportRef: dryRunApply.reportRef,
        writesRepoFiles: dryRunApply.writesRepoFiles,
      },
      unconfirmedApply: {
        status: unconfirmedApply.status,
        reportRef: unconfirmedApply.reportRef,
        errors: unconfirmedApply.errors,
      },
      confirmedApply: {
        status: confirmedApply.status,
        reportRef: confirmedApply.reportRef,
        backupManifestRef: confirmedApply.backupManifestRef,
        changedFiles: confirmedApply.changedFiles,
      },
      rollbackDryRun: {
        status: rollbackDryRun.status,
        reportRef: rollbackDryRun.reportRef,
        writesRepoFiles: rollbackDryRun.writesRepoFiles,
      },
      confirmedRollback: {
        status: confirmedRollback.status,
        reportRef: confirmedRollback.reportRef,
        rolledBack: confirmedRollback.rolledBack,
      },
    },
    safety: {
      writesOnlyUnder: `output/noe-patch-transactions/drills/${safeId}/`,
      targetExistsAfterApply,
      targetExistsAfterRollback,
      noSourceFilesChangedByDrill: true,
      secretValuesReturned: false,
    },
  };
  const reportPath = resolve(runDir, 'drill-report.json');
  const latestPath = resolve(rootAbs, outDir, 'latest.json');
  writeJson(reportPath, report);
  writeJson(latestPath, report);
  return {
    ...report,
    reportRef: rel(rootAbs, reportPath),
    latestRef: rel(rootAbs, latestPath),
  };
}
