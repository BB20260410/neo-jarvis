#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNoeConsensusRef } from '../src/room/NoeConsensusLedger.js';
import { runNoeConsensusRound } from '../src/room/NoeConsensusRunner.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN_REF_PATTERN = /(^|[/\\])(\.env[^/\\]*|room-adapters\.json|private_holdout|owner[-_]?token)([/\\]|$)|\.\.|^~|^file:|^[a-z][a-z0-9+.-]*:/i;

function normalizeRef(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/\/+/g, '/');
}

function assertSafeCliRef(value, { kind, allowedPrefixes }) {
  const ref = normalizeRef(value);
  if (!ref || ref.startsWith('/') || FORBIDDEN_REF_PATTERN.test(ref)) {
    throw new Error(`${kind}_ref_forbidden`);
  }
  const prefixes = allowedPrefixes.map(normalizeRef);
  if (!prefixes.some((prefix) => ref === prefix.replace(/\/$/, '') || ref.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))) {
    throw new Error(`${kind}_ref_outside_allowed_prefix`);
  }
  return ref;
}

function parseArgs(argv) {
  const out = {
    goal: '',
    evidenceText: '',
    evidenceFile: '',
    outDir: 'output/noe-multimodel',
    roundId: '',
    runModels: false,
    ackCost: false,
    activeExecutor: '',
    executorSelectedBy: '',
    executorSelectionReason: '',
    qualityProfile: '',
    stageMatrix: '',
    requireStageComplete: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--goal') out.goal = argv[++i];
    else if (arg.startsWith('--goal=')) out.goal = arg.slice('--goal='.length);
    else if (arg === '--evidence-text') out.evidenceText = argv[++i];
    else if (arg.startsWith('--evidence-text=')) out.evidenceText = arg.slice('--evidence-text='.length);
    else if (arg === '--evidence-file') out.evidenceFile = argv[++i];
    else if (arg.startsWith('--evidence-file=')) out.evidenceFile = arg.slice('--evidence-file='.length);
    else if (arg === '--round-id') out.roundId = argv[++i];
    else if (arg.startsWith('--round-id=')) out.roundId = arg.slice('--round-id='.length);
    else if (arg === '--out-dir') out.outDir = argv[++i];
    else if (arg.startsWith('--out-dir=')) out.outDir = arg.slice('--out-dir='.length);
    else if (arg === '--run-models') out.runModels = true;
    else if (arg === '--ack-cost') out.ackCost = true;
    else if (arg === '--active-executor') out.activeExecutor = argv[++i];
    else if (arg.startsWith('--active-executor=')) out.activeExecutor = arg.slice('--active-executor='.length);
    else if (arg === '--executor-selected-by') out.executorSelectedBy = argv[++i];
    else if (arg.startsWith('--executor-selected-by=')) out.executorSelectedBy = arg.slice('--executor-selected-by='.length);
    else if (arg === '--executor-selection-reason') out.executorSelectionReason = argv[++i];
    else if (arg.startsWith('--executor-selection-reason=')) out.executorSelectionReason = arg.slice('--executor-selection-reason='.length);
    else if (arg === '--quality-profile') out.qualityProfile = argv[++i];
    else if (arg.startsWith('--quality-profile=')) out.qualityProfile = arg.slice('--quality-profile='.length);
    else if (arg === '--stage-matrix') out.stageMatrix = argv[++i];
    else if (arg.startsWith('--stage-matrix=')) out.stageMatrix = arg.slice('--stage-matrix='.length);
    else if (arg === '--require-stage-complete') out.requireStageComplete = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.goal) throw new Error('--goal required');
  const outDir = assertSafeCliRef(args.outDir, {
    kind: 'out_dir',
    allowedPrefixes: ['output/noe-multimodel'],
  });
  const evidenceFile = args.evidenceFile
    ? assertSafeCliRef(args.evidenceFile, {
      kind: 'evidence_file',
      allowedPrefixes: ['docs', '.planning', 'output'],
    })
    : '';
  const stageMatrixRef = args.stageMatrix
    ? assertSafeCliRef(args.stageMatrix, {
      kind: 'stage_matrix',
      allowedPrefixes: ['output/noe-multimodel', 'output/noe-final-real-machine-stages'],
    })
    : '';
  const evidenceText = args.evidenceFile
    ? readFileSync(resolveNoeConsensusRef(ROOT, evidenceFile), 'utf8')
    : args.evidenceText;
  if (!evidenceText) throw new Error('--evidence-text or --evidence-file required');
  if (args.runModels && !args.ackCost) {
    throw new Error('--ack-cost required when --run-models is used');
  }

  return runNoeConsensusRound({
    goal: args.goal,
    evidenceText,
    outDir,
    roundId: args.roundId,
    runModels: args.runModels,
    costAcknowledged: args.ackCost,
    activeExecutor: args.activeExecutor,
    qualityProfile: args.qualityProfile,
    stageMatrixRef,
    stageMatrixRequireComplete: args.requireStageComplete,
    executorSelection: args.activeExecutor ? {
      selectedBy: args.executorSelectedBy || (args.activeExecutor === 'codex' ? 'default' : 'user'),
      reason: args.executorSelectionReason || (args.activeExecutor === 'codex' ? 'default_executor' : 'explicit_executor_selection'),
    } : undefined,
  }, { root: ROOT }).then((result) => {
    console.log(JSON.stringify(result, null, 2));
    if (args.runModels && !result.ok) process.exit(1);
  });
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
