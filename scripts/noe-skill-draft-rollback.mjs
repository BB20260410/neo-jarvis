#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillStore } from '../src/skills/SkillStore.js';
import { runNoeSkillDraftRollback } from '../src/skills/NoeSkillDraftRollback.js';

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
    applyReportRef: report.applyReportRef,
    reportRef: report.reportRef,
    counts: report.counts,
    writesSkillStore: report.writesSkillStore,
    directWrites: report.directWrites,
    errors: report.errors,
    blocked: report.blocked,
  };
}

const apply = hasFlag('--apply');
const report = runNoeSkillDraftRollback({
  root: ROOT,
  applyReportRef: arg('--apply-report', arg('--apply-report-ref', '')),
  dryRun: !apply,
  confirmOwner: hasFlag('--confirm-owner'),
  skillStore: apply ? skillStore : null,
});

console.log(JSON.stringify(summarize(report), null, 2));
process.exitCode = report.ok || report.status === 'skipped' ? 0 : 1;
