#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNoeConsensusRef } from '../src/room/NoeConsensusLedger.js';
import {
  buildNoePostReviewPack,
  buildNoePostReviewPrompt,
  validateNoePostReviewPack,
} from '../src/room/NoePostReviewPack.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function clean(value) {
  return String(value || '').trim();
}

function parseList(value) {
  return String(value || '').split(/[,\n，、]/).map((item) => item.trim()).filter(Boolean);
}

export function parsePostReviewPackArgs(argv) {
  const out = {
    touchedFiles: [],
    tests: [],
    reviewers: [],
    optionalReviewers: [],
    reviewerOutputRefs: {},
    outDir: 'output/noe-post-review',
    dryRun: false,
    requireFiles: true,
    requireActionEvidence: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i] || '';
    if (arg === '--goal') out.goal = next();
    else if (arg.startsWith('--goal=')) out.goal = arg.slice(7);
    else if (arg === '--ledger') out.ledger = next();
    else if (arg.startsWith('--ledger=')) out.ledger = arg.slice(9);
    else if (arg === '--action-evidence') out.actionEvidence = next();
    else if (arg.startsWith('--action-evidence=')) out.actionEvidence = arg.slice(18);
    else if (arg === '--round-id') out.roundId = next();
    else if (arg.startsWith('--round-id=')) out.roundId = arg.slice(11);
    else if (arg === '--implementation-evidence') out.implementationEvidence = next();
    else if (arg.startsWith('--implementation-evidence=')) out.implementationEvidence = arg.slice(26);
    else if (arg === '--implementation-diff') out.implementationDiff = next();
    else if (arg.startsWith('--implementation-diff=')) out.implementationDiff = arg.slice(22);
    else if (arg === '--touched') out.touchedFiles.push(next());
    else if (arg.startsWith('--touched=')) out.touchedFiles.push(arg.slice(10));
    else if (arg === '--runtime-report') out.runtimeReport = next();
    else if (arg.startsWith('--runtime-report=')) out.runtimeReport = arg.slice(17);
    else if (arg === '--rollback') out.rollback = next();
    else if (arg.startsWith('--rollback=')) out.rollback = arg.slice(11);
    else if (arg === '--test') out.tests.push(next());
    else if (arg.startsWith('--test=')) out.tests.push(arg.slice(7));
    else if (arg === '--reviewer') out.reviewers.push(...parseList(next()));
    else if (arg.startsWith('--reviewer=')) out.reviewers.push(...parseList(arg.slice(11)));
    else if (arg === '--optional-reviewer') out.optionalReviewers.push(...parseList(next()));
    else if (arg.startsWith('--optional-reviewer=')) out.optionalReviewers.push(...parseList(arg.slice(20)));
    else if (arg === '--reviewer-output') addReviewerOutput(out, next());
    else if (arg.startsWith('--reviewer-output=')) addReviewerOutput(out, arg.slice(18));
    else if (arg === '--notes') out.notes = next();
    else if (arg.startsWith('--notes=')) out.notes = arg.slice(8);
    else if (arg === '--out-dir') out.outDir = next();
    else if (arg.startsWith('--out-dir=')) out.outDir = arg.slice(10);
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--no-require-files') out.requireFiles = false;
    else if (arg === '--no-action-evidence') out.requireActionEvidence = false;
  }
  return out;
}

function addReviewerOutput(out, value) {
  const text = clean(value);
  const index = text.indexOf('=');
  if (index <= 0) return;
  const model = clean(text.slice(0, index)).toLowerCase();
  const ref = clean(text.slice(index + 1));
  if (model && ref) out.reviewerOutputRefs[model] = ref;
}

function missingArgs(args) {
  const missing = [];
  for (const [key, label] of [
    ['goal', '--goal'],
    ['ledger', '--ledger'],
    ['runtimeReport', '--runtime-report'],
    ['rollback', '--rollback'],
  ]) {
    if (!clean(args[key])) missing.push(label);
  }
  if (args.requireActionEvidence !== false && !clean(args.actionEvidence)) missing.push('--action-evidence');
  if (!clean(args.implementationEvidence) && !clean(args.implementationDiff) && !args.touchedFiles.length) {
    missing.push('--implementation-evidence|--implementation-diff|--touched');
  }
  return missing;
}

function roundIdFrom(args) {
  if (clean(args.roundId)) return clean(args.roundId);
  return `post-review-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
}

function readJsonRef(ref) {
  const file = resolveNoeConsensusRef(ROOT, ref);
  return JSON.parse(readFileSync(file, 'utf8'));
}

function checkRef(errors, ref, label, requireFile) {
  const text = clean(ref);
  if (!text) return;
  try {
    const file = resolveNoeConsensusRef(ROOT, text);
    if (requireFile && !existsSync(file)) errors.push(`missing_${label}:${text}`);
  } catch (error) {
    errors.push(`${label}_invalid:${error.message}`);
  }
}

function checkReferencedFiles(args, pack) {
  if (args.requireFiles !== true) return [];
  const errors = [];
  checkRef(errors, pack.consensus?.ledgerRef, 'ledger', true);
  checkRef(errors, pack.runtimeVerification?.reportRef, 'runtime_report', true);
  checkRef(errors, pack.rollback?.planRef, 'rollback', true);
  checkRef(errors, pack.implementation?.diffRef, 'implementation_diff', true);
  checkRef(errors, pack.implementation?.evidenceRef, 'implementation_evidence', true);
  if (clean(args.actionEvidence)) checkRef(errors, args.actionEvidence, 'action_evidence', true);
  return errors;
}

export function buildPostReviewPackFromArgs(args) {
  const roundId = roundIdFrom(args);
  const reviewRoundRef = join(clean(args.outDir) || 'output/noe-post-review', roundId);
  const actionEvidence = clean(args.actionEvidence) ? readJsonRef(args.actionEvidence) : null;
  return buildNoePostReviewPack({
    goal: args.goal,
    consensusLedgerRef: args.ledger,
    actionEvidence,
    implementation: {
      writer: 'codex',
      done: true,
      evidenceRef: clean(args.implementationEvidence) || undefined,
      diffRef: clean(args.implementationDiff) || undefined,
      touchedFiles: args.touchedFiles.map(clean).filter(Boolean),
    },
    runtimeVerification: { ok: true, reportRef: args.runtimeReport },
    rollback: { planRef: args.rollback },
    tests: args.tests,
    reviewRoundRef,
    requiredReviewers: args.reviewers.length ? args.reviewers : undefined,
    optionalReviewers: args.optionalReviewers.length ? args.optionalReviewers : undefined,
    reviewerOutputRefs: args.reviewerOutputRefs,
    notes: args.notes,
  });
}

function writePackArtifacts({ pack, outDir, roundId }) {
  const dir = resolveNoeConsensusRef(ROOT, join(clean(outDir) || 'output/noe-post-review', roundId));
  mkdirSync(dir, { recursive: true });
  const packFile = join(dir, 'pack.json');
  writeFileSync(packFile, `${JSON.stringify(pack, null, 2)}\n`, { mode: 0o600 });
  const prompts = [];
  for (const reviewer of pack.postReviewPlan.reviewers || []) {
    const file = join(dir, `${reviewer.model}-prompt.md`);
    writeFileSync(file, `${buildNoePostReviewPrompt({ pack, reviewer: reviewer.model })}\n`, { mode: 0o600 });
    prompts.push(relative(ROOT, file));
  }
  return { packFile: relative(ROOT, packFile), prompts };
}

function main() {
  const args = parsePostReviewPackArgs(process.argv.slice(2));
  const missing = missingArgs(args);
  if (missing.length) {
    console.error(JSON.stringify({ ok: false, error: 'missing_required_args', missing }, null, 2));
    process.exit(1);
  }
  if (!args.dryRun && args.requireFiles !== true) {
    console.error(JSON.stringify({ ok: false, error: 'no_require_files_only_supported_for_dry_run' }, null, 2));
    process.exit(1);
  }
  const roundId = roundIdFrom(args);
  const pack = buildPostReviewPackFromArgs({ ...args, roundId });
  const validation = validateNoePostReviewPack(pack, {
    requireActionEvidence: args.requireActionEvidence !== false,
    requireReviewerOutputRefs: true,
  });
  const fileErrors = checkReferencedFiles(args, pack);
  if (!validation.ok || fileErrors.length) {
    console.error(JSON.stringify({ ok: false, errors: [...validation.errors, ...fileErrors] }, null, 2));
    process.exit(1);
  }
  const written = args.dryRun ? { packFile: null, prompts: [] } : writePackArtifacts({ pack, outDir: args.outDir, roundId });
  console.log(JSON.stringify({
    ok: true,
    dryRun: args.dryRun,
    roundId,
    packRef: written.packFile,
    promptRefs: written.prompts,
    reviewers: pack.postReviewPlan.reviewers.map((reviewer) => ({
      model: reviewer.model,
      required: reviewer.required,
      expectedRawOutputRef: reviewer.expectedRawOutputRef,
    })),
    sha256: pack.sha256,
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
