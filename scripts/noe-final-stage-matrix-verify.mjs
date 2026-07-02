#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolveNoeConsensusRef } from '../src/room/NoeConsensusLedger.js';
import {
  assertNoeFinalStageSafeRef,
  validateNoeFinalStageAuthorizationMatrix,
  validateNoeFinalStageEvidence,
} from '../src/runtime/NoeFinalStageMatrix.js';

function parseArgs(argv) {
  const out = {
    matrix: 'output/noe-multimodel/20260619-final-real-machine-authorization/authorization.json',
    requireComplete: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--matrix') out.matrix = argv[++i];
    else if (arg.startsWith('--matrix=')) out.matrix = arg.slice('--matrix='.length);
    else if (arg === '--require-complete') out.requireComplete = true;
    else throw new Error(`unknown arg: ${arg}`);
  }
  return out;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const matrixRef = assertNoeFinalStageSafeRef(args.matrix, {
    kind: 'stage_matrix',
    allowedPrefixes: ['output/noe-multimodel', 'output/noe-final-real-machine-stages'],
  });
  const matrix = readJson(resolveNoeConsensusRef(process.cwd(), matrixRef));
  const authResult = validateNoeFinalStageAuthorizationMatrix(matrix);
  const stageEvidence = {};
  if (authResult.ok) {
    for (const id of authResult.requiredStages || ['B', 'C', 'D', 'E']) {
      const ref = matrix.stageEvidenceRefs?.[id];
      if (!ref) continue;
      const safeRef = assertNoeFinalStageSafeRef(ref, {
        kind: `stage_evidence_ref:${id}`,
        allowedPrefixes: [matrix.stageEvidenceDir || 'output/noe-final-real-machine-stages'],
      });
      const file = resolveNoeConsensusRef(process.cwd(), safeRef);
      if (existsSync(file)) stageEvidence[id] = readJson(file);
    }
  }
  const result = validateNoeFinalStageEvidence({
    matrix,
    stageEvidence,
    requireComplete: args.requireComplete,
  });
  console.log(JSON.stringify({
    ok: result.ok,
    matrix: matrixRef,
    requireComplete: args.requireComplete,
    completed: result.completed,
    requiredStages: result.requiredStages,
    errors: result.errors,
    warnings: result.warnings,
  }, null, 2));
  if (!result.ok) process.exit(1);
}

main();
