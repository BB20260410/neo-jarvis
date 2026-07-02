#!/usr/bin/env node
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillStore } from '../src/skills/SkillStore.js';
import { runSkillCurator } from '../src/skills/SkillCurator.js';
import { atomicWriteFile } from '../src/state/atomicJsonFile.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_ROOT = resolve(ROOT, 'output/noe-skill-curator');

function assertUnderOutput(file) {
  const target = resolve(file);
  const rel = relative(OUTPUT_ROOT, target);
  if (rel.startsWith('..') || rel === '..' || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) {
    throw new Error('state_file_must_be_under_output_noe_skill_curator');
  }
  return target;
}

function safeStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function toRef(file) {
  const rel = relative(ROOT, resolve(file));
  if (rel && !rel.startsWith('..') && rel !== '..' && !rel.startsWith('/')) return rel.replaceAll('\\', '/');
  return resolve(file);
}

function parseArgs(argv) {
  const now = new Date();
  const stamp = safeStamp(now);
  const out = {
    dryRun: true,
    now,
    staleDays: 30,
    archiveDays: 90,
    stateFile: resolve(OUTPUT_ROOT, 'curator_state.json'),
    snapshotFile: resolve(OUTPUT_ROOT, 'snapshots', `${stamp}-snapshot.json`),
    reportFile: resolve(OUTPUT_ROOT, 'reports', `${stamp}-report.json`),
  };
  for (const arg of argv) {
    if (arg === '--apply') out.dryRun = false;
    if (arg === '--dry-run') out.dryRun = true;
    if (arg.startsWith('--stale-days=')) out.staleDays = Number(arg.slice(13)) || 30;
    if (arg.startsWith('--archive-days=')) out.archiveDays = Number(arg.slice(15)) || 90;
    if (arg.startsWith('--state-file=')) out.stateFile = assertUnderOutput(resolve(ROOT, arg.slice(13)));
    if (arg.startsWith('--snapshot-file=')) out.snapshotFile = assertUnderOutput(resolve(ROOT, arg.slice(16)));
    if (arg.startsWith('--report-file=')) out.reportFile = assertUnderOutput(resolve(ROOT, arg.slice(14)));
  }
  out.stateFile = assertUnderOutput(out.stateFile);
  out.snapshotFile = assertUnderOutput(out.snapshotFile);
  out.reportFile = assertUnderOutput(out.reportFile);
  return out;
}

const args = parseArgs(process.argv.slice(2));
skillStore.reload();
const report = runSkillCurator({
  skills: skillStore.list(),
  now: args.now,
  dryRun: args.dryRun,
  stateFile: args.stateFile,
  snapshotFile: args.snapshotFile,
  staleDays: args.staleDays,
  archiveDays: args.archiveDays,
});
atomicWriteFile(args.reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  ok: true,
  dryRun: report.dryRun,
  reportRef: toRef(args.reportFile),
  snapshotRef: report.snapshotRef,
  counts: report.counts,
  consolidated: report.consolidated.length,
  pruned: report.pruned.length,
  stateTransitions: report.stateTransitions.length,
  directSkillMutations: report.directSkillMutations,
  recoveryInstructions: report.recoveryInstructions,
}, null, 2));
