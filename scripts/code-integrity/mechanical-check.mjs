#!/usr/bin/env node
// @ts-check

import { resolve } from 'node:path';
import { atomicJsonWrite, canonicalJson, hashBytes } from './lib/artifacts.mjs';
import { collectChangeContext } from './lib/gate.mjs';
import { inspectChangedFiles } from './lib/mechanical.mjs';
import { assertPathInside } from './lib/policy.mjs';

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ repoRoot?: string, output?: string, mode: 'worktree'|'staged'|'commit-range', range?: string }} */
  const out = { mode: 'worktree' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${key}`);
    if (key === '--repo-root') out.repoRoot = value;
    else if (key === '--output') out.output = value;
    else if (key === '--mode' && ['worktree', 'staged', 'commit-range'].includes(value)) out.mode = /** @type {typeof out.mode} */ (value);
    else if (key === '--range') out.range = value;
    else throw new Error(`unknown option: ${key}`);
  }
  if (!out.repoRoot || !out.output) throw new Error('--repo-root and --output are required');
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(args.repoRoot);
  const outputPath = resolve(args.output);
  if (process.env.NOE_CODE_INTEGRITY_RUNTIME_ROOT) {
    assertPathInside(resolve(process.env.NOE_CODE_INTEGRITY_RUNTIME_ROOT), outputPath, 'mechanical report');
  }
  const context = collectChangeContext(repoRoot, args.mode, args.range || null);
  const result = inspectChangedFiles(repoRoot, context.paths, context.newPaths, context.addedLines);
  const metadata = {
    ...result,
    createdAt: new Date().toISOString(),
    repoRoot,
    mode: context.mode,
    range: context.range,
    baseSha: context.baseSha,
    headSha: context.headSha,
  };
  const report = { ...metadata, metadataDigest: hashBytes(canonicalJson(metadata)) };
  atomicJsonWrite(outputPath, report);
  process.stdout.write(`${JSON.stringify({ passed: report.passed, checked: report.checkedPaths.length, issues: report.issues.length, outputPath })}\n`);
  if (!report.passed) process.exitCode = 3;
}

try {
  main();
} catch (error) {
  process.stderr.write(`mechanical check refused: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
