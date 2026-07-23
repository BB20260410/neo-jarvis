#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNoeConsensusRef } from '../src/room/NoeConsensusLedger.js';
import {
  NOE_SELF_EVOLUTION_CYCLE_SCHEMA_VERSION,
  validateNoeSelfEvolutionCycle,
} from '../src/room/NoeSelfEvolutionCycle.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = {
    touchedFiles: [],
    postReviews: [],
    outDir: 'output/noe-self-evolution',
    requireFiles: true,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i] || '';
    if (arg === '--goal') out.goal = next();
    else if (arg.startsWith('--goal=')) out.goal = arg.slice(7);
    else if (arg === '--ledger') out.ledger = next();
    else if (arg.startsWith('--ledger=')) out.ledger = arg.slice(9);
    else if (arg === '--cycle-id') out.cycleId = next();
    else if (arg.startsWith('--cycle-id=')) out.cycleId = arg.slice(11);
    else if (arg === '--implementation-evidence') out.implementationEvidence = next();
    else if (arg.startsWith('--implementation-evidence=')) out.implementationEvidence = arg.slice(26);
    else if (arg === '--implementation-diff') out.implementationDiff = next();
    else if (arg.startsWith('--implementation-diff=')) out.implementationDiff = arg.slice(22);
    else if (arg === '--touched') out.touchedFiles.push(next());
    else if (arg.startsWith('--touched=')) out.touchedFiles.push(arg.slice(10));
    else if (arg === '--rollback') out.rollback = next();
    else if (arg.startsWith('--rollback=')) out.rollback = arg.slice(11);
    else if (arg === '--runtime-report') out.runtimeReport = next();
    else if (arg.startsWith('--runtime-report=')) out.runtimeReport = arg.slice(17);
    else if (arg === '--post-review') out.postReviews.push(next());
    else if (arg.startsWith('--post-review=')) out.postReviews.push(arg.slice(14));
    else if (arg === '--retrospective') out.retrospective = next();
    else if (arg.startsWith('--retrospective=')) out.retrospective = arg.slice(16);
    else if (arg === '--memory-summary') out.memorySummary = next();
    else if (arg.startsWith('--memory-summary=')) out.memorySummary = arg.slice(17);
    else if (arg === '--memory-write-ref') out.memoryWriteRef = next();
    else if (arg.startsWith('--memory-write-ref=')) out.memoryWriteRef = arg.slice(19);
    else if (arg === '--out-dir') out.outDir = next();
    else if (arg.startsWith('--out-dir=')) out.outDir = arg.slice(10);
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--no-require-files') out.requireFiles = false;
  }
  return out;
}

function clean(value) {
  return String(value || '').trim();
}

function missingArgs(args) {
  const missing = [];
  for (const [key, label] of [
    ['goal', '--goal'],
    ['ledger', '--ledger'],
    ['rollback', '--rollback'],
    ['runtimeReport', '--runtime-report'],
    ['retrospective', '--retrospective'],
    ['memorySummary', '--memory-summary'],
  ]) {
    if (!clean(args[key])) missing.push(label);
  }
  if (!clean(args.implementationEvidence) && !clean(args.implementationDiff) && !args.touchedFiles.length) {
    missing.push('--implementation-evidence|--implementation-diff|--touched');
  }
  if (!args.postReviews.length) missing.push('--post-review model[:decision]=rawOutputRef');
  return missing;
}

export function postReviewFrom(value) {
  const text = clean(value);
  const index = text.indexOf('=');
  const left = index >= 0 ? text.slice(0, index).trim() : text.trim();
  const decisionIndex = left.indexOf(':');
  const model = decisionIndex >= 0 ? left.slice(0, decisionIndex).trim() : left;
  const decision = decisionIndex >= 0 ? left.slice(decisionIndex + 1).trim() : 'approve';
  const rawOutputRef = index >= 0 ? text.slice(index + 1).trim() : '';
  return {
    model,
    decision,
    authority: model === 'm3' ? 'suggestion_only' : model === 'gemini' ? 'advisory' : 'readonly_source_reviewer',
    canWrite: false,
    rawOutputRef,
  };
}

function cycleIdFrom(args) {
  if (clean(args.cycleId)) return clean(args.cycleId);
  return `cycle-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
}

function buildCycle(args) {
  const cycleId = cycleIdFrom(args);
  return {
    schemaVersion: NOE_SELF_EVOLUTION_CYCLE_SCHEMA_VERSION,
    cycleId,
    createdAt: new Date().toISOString(),
    goal: clean(args.goal),
    consensus: { ledgerRef: clean(args.ledger) },
    authorization: {
      consensusApproved: true,
      scope: 'self-evolution cycle completion',
      costClass: 'local_or_user_approved_model_calls',
    },
    rollback: { planRef: clean(args.rollback) },
    implementation: {
      done: true,
      writer: 'codex',
      evidenceRef: clean(args.implementationEvidence) || undefined,
      diffRef: clean(args.implementationDiff) || undefined,
      touchedFiles: args.touchedFiles.map(clean).filter(Boolean),
    },
    runtimeVerification: { ok: true, reportRef: clean(args.runtimeReport) },
    postReview: {
      ok: true,
      reviews: args.postReviews.map(postReviewFrom),
    },
    retrospectiveRef: clean(args.retrospective),
    memoryWriteback: {
      done: true,
      consensusAck: true,
      summaryRef: clean(args.memorySummary),
      writeRef: clean(args.memoryWriteRef) || undefined,
    },
  };
}

function writeCycle(cycle, outDir) {
  const dir = resolveNoeConsensusRef(ROOT, join(clean(outDir) || 'output/noe-self-evolution', cycle.cycleId));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'cycle.json');
  writeFileSync(file, `${JSON.stringify(cycle, null, 2)}\n`, { mode: 0o600 });
  return file;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const missing = missingArgs(args);
  if (missing.length) {
    console.error(JSON.stringify({ ok: false, error: 'missing_required_args', missing }, null, 2));
    process.exit(1);
  }
  if (!args.dryRun && args.requireFiles !== true) {
    console.error(JSON.stringify({ ok: false, error: 'no_require_files_only_supported_for_dry_run' }, null, 2));
    process.exit(1);
  }
  const cycle = buildCycle(args);
  const validation = validateNoeSelfEvolutionCycle(cycle, {
    root: ROOT,
    requireReferencedFiles: args.requireFiles,
  });
  if (!validation.ok) {
    console.error(JSON.stringify({ ok: false, errors: validation.errors, warnings: validation.warnings }, null, 2));
    process.exit(1);
  }
  const file = args.dryRun ? null : writeCycle(cycle, args.outDir);
  console.log(JSON.stringify({ ok: true, dryRun: args.dryRun, cycleId: cycle.cycleId, file, validation }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
