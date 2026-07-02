#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNoePatchApply } from '../src/runtime/mission/NoePatchApplyExecutor.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function hasFlag(name) {
  return process.argv.includes(name);
}

function arg(name, fallback = '') {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

function summarize(report) {
  return {
    ok: report.ok,
    status: report.status,
    reason: report.reason,
    dryRun: report.dryRun,
    patchPlanRef: report.patchPlanRef,
    reportRef: report.reportRef,
    backupManifestRef: report.backupManifestRef,
    counts: report.counts,
    writesRepoFiles: report.writesRepoFiles,
    directWrites: report.directWrites,
    errors: report.errors,
    blocked: report.blocked,
    secretValuesReturned: report.secretValuesReturned,
  };
}

const apply = hasFlag('--apply');
const report = runNoePatchApply({
  root: ROOT,
  patchPlanRef: arg('--patch-plan', arg('--patch-plan-ref', arg('--cloud-output', ''))),
  dryRun: !apply,
  confirmOwner: hasFlag('--confirm-owner'),
});

console.log(JSON.stringify(summarize(report), null, 2));
process.exitCode = report.ok || report.status === 'skipped' ? 0 : 1;
