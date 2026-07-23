#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillStore } from '../src/skills/SkillStore.js';
import {
  NOE_SKILL_DRAFT_QUEUE,
  runNoeSkillDraftApply,
} from '../src/skills/NoeSkillDraftApply.js';

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
    queueRef: report.queueRef,
    reportRef: report.reportRef,
    counts: report.counts,
    writesSkillStore: report.writesSkillStore,
    directWrites: report.directWrites,
    errors: report.errors,
    blocked: report.blocked,
  };
}

const apply = hasFlag('--apply');
const report = runNoeSkillDraftApply({
  root: ROOT,
  queueRef: arg('--queue', NOE_SKILL_DRAFT_QUEUE),
  dryRun: !apply,
  confirmOwner: hasFlag('--confirm-owner'),
  skillStore: apply ? skillStore : null,
});

console.log(JSON.stringify(summarize(report), null, 2));
process.exitCode = report.ok || report.status === 'skipped' ? 0 : 1;
