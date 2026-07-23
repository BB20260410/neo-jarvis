#!/usr/bin/env node
// @ts-check

import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomicJsonWrite, canonicalJson, hashBytes } from './lib/artifacts.mjs';
import { compareDiagnostics, diagnosticCounts } from './lib/diagnostics.mjs';
import { validateDiagnosticEvidence } from './lib/diagnostic-evidence.mjs';
import { assertNoSymlinkSegments, assertPathInside, existingRealDirectory } from './lib/policy.mjs';

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ evidence?: string, safeRunReceipt?: string, output?: string, baseline?: string, repoRoot?: string, runtimeRoot?: string }} */
  const out = {};
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${key}`);
    if (seen.has(key)) throw new Error(`duplicate option: ${key}`);
    seen.add(key);
    if (key === '--evidence') out.evidence = value;
    else if (key === '--safe-run-receipt') out.safeRunReceipt = value;
    else if (key === '--output') out.output = value;
    else if (key === '--baseline') out.baseline = value;
    else if (key === '--repo-root') out.repoRoot = value;
    else if (key === '--runtime-root') out.runtimeRoot = value;
    else throw new Error(`unknown option: ${key}`);
  }
  if (!out.evidence || !out.safeRunReceipt || !out.output || !out.repoRoot || !out.runtimeRoot) {
    throw new Error('--evidence, --safe-run-receipt, --output, --repo-root and --runtime-root are required');
  }
  return out;
}

/** @param {string} pathValue @param {string} runtimeRoot */
function readBaseline(pathValue, runtimeRoot) {
  const absolute = resolve(pathValue);
  assertPathInside(runtimeRoot, absolute, 'diagnostic baseline');
  assertNoSymlinkSegments(runtimeRoot, absolute, 'diagnostic baseline');
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('diagnostic baseline must be a regular file');
  const bytes = readFileSync(absolute);
  const value = JSON.parse(bytes.toString('utf8'));
  const { metadataDigest, ...metadata } = value;
  if (value.schema !== 'neo.code-integrity.diagnostics.v2' || hashBytes(canonicalJson(metadata)) !== metadataDigest) {
    throw new Error('unsupported or invalid diagnostic baseline');
  }
  return { absolute, bytes, value };
}

function main() {
  const [mode, ...argv] = process.argv.slice(2);
  const args = parseArgs(argv);
  const repoRoot = existingRealDirectory(resolve(args.repoRoot), 'repository root');
  const runtimeRoot = existingRealDirectory(resolve(args.runtimeRoot), 'runtime root');
  const outputPath = resolve(args.output);
  assertPathInside(runtimeRoot, outputPath, 'diagnostic ratchet output');
  assertNoSymlinkSegments(runtimeRoot, outputPath, 'diagnostic ratchet output');
  const evidence = validateDiagnosticEvidence({
    evidencePath: args.evidence,
    safeRunReceiptPath: args.safeRunReceipt,
    repoRoot,
    runtimeRoot,
  });
  const diagnosticText = [evidence.stdoutText, evidence.stderrText].filter(Boolean).join('\n');
  const diagnostics = diagnosticCounts(diagnosticText, repoRoot);
  if (!Number.isInteger(evidence.result.exitCode)
    || evidence.result.signal !== null
    || evidence.result.spawnError !== null
    || ((evidence.result.exitCode === 0) !== (diagnostics.length === 0))) {
    throw new Error('TypeScript result is inconsistent with parsed diagnostics');
  }
  const evidenceReference = {
    schema: evidence.schema,
    evidencePath: evidence.evidencePath,
    evidenceSha256: evidence.evidenceSha256,
    safeRunReceiptPath: evidence.safeRunReceiptPath,
    safeRunReceiptSha256: evidence.safeRunReceiptSha256,
    source: evidence.source,
    tool: evidence.tool,
    invocation: evidence.invocation,
    result: evidence.result,
  };
  if (mode === 'create') {
    if (args.baseline) throw new Error('create mode does not accept --baseline');
    const metadata = {
      schema: 'neo.code-integrity.diagnostics.v2',
      createdAt: new Date().toISOString(),
      repoRoot,
      evidence: evidenceReference,
      diagnostics,
    };
    atomicJsonWrite(outputPath, { ...metadata, metadataDigest: hashBytes(canonicalJson(metadata)) });
    process.stdout.write(`${JSON.stringify({ mode, diagnosticKinds: diagnostics.length, outputPath })}\n`);
    return;
  }
  if (mode !== 'compare' || !args.baseline) throw new Error('use create, or compare with --baseline');
  const baseline = readBaseline(args.baseline, runtimeRoot);
  if (resolve(baseline.value.repoRoot || '') !== repoRoot
    || canonicalJson(baseline.value.evidence?.tool) !== canonicalJson(evidence.tool)
    || canonicalJson(baseline.value.evidence?.invocation) !== canonicalJson(evidence.invocation)) {
    throw new Error('diagnostic baseline tool, invocation or repository differs');
  }
  const newDiagnostics = compareDiagnostics(baseline.value.diagnostics || [], diagnostics);
  const metadata = {
    schema: 'neo.code-integrity.diagnostic-ratchet.v2',
    checkedAt: new Date().toISOString(),
    baseline: { path: baseline.absolute, sha256: hashBytes(baseline.bytes) },
    evidence: evidenceReference,
    currentKinds: diagnostics.length,
    newDiagnosticKinds: newDiagnostics.length,
    newDiagnostics,
    passed: newDiagnostics.length === 0,
  };
  const report = { ...metadata, metadataDigest: hashBytes(canonicalJson(metadata)) };
  atomicJsonWrite(outputPath, report);
  process.stdout.write(`${JSON.stringify({ mode, passed: report.passed, newDiagnosticKinds: report.newDiagnosticKinds, outputPath })}\n`);
  if (!report.passed) process.exitCode = 3;
}

try {
  main();
} catch (error) {
  process.stderr.write(`diagnostic ratchet refused: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
