#!/usr/bin/env node
// @ts-check

import { lstatSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJsonWrite, canonicalJson, hashBytes } from './lib/artifacts.mjs';
import { validateGuardContext } from './lib/guard-context.mjs';
import { codeIntegritySourceEvidence, GATE_INTEGRATION_TEST, REQUIRED_GATE_SCENARIOS } from './lib/integration-evidence.mjs';
import { assertNoSymlinkSegments, assertPathInside, existingRealDirectory } from './lib/policy.mjs';

const ENTRYPOINT = fileURLToPath(import.meta.url);

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ taskRoot?: string, runtimeRoot?: string, output?: string, roundId?: string, expectedSourceDigest?: string, scenarios: Array<{ scenarioId: string, receipt: string, entrypoint: string, cwd: string, args: string[], expectedExitCode: number }> }} */
  const out = { scenarios: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${key}`);
    if (key === '--task-root') out.taskRoot = value;
    else if (key === '--runtime-root') out.runtimeRoot = value;
    else if (key === '--output') out.output = value;
    else if (key === '--round-id') out.roundId = value;
    else if (key === '--expected-source-digest') out.expectedSourceDigest = value;
    else if (key === '--scenario') out.scenarios.push(JSON.parse(value));
    else throw new Error(`unknown option: ${key}`);
  }
  if (!out.taskRoot || !out.runtimeRoot || !out.output
    || !/^[0-9a-f-]{36}$/.test(out.roundId || '')
    || !/^[a-f0-9]{64}$/.test(out.expectedSourceDigest || '')
    || out.scenarios.length < 40) {
    throw new Error('--task-root, --runtime-root, --output, round/source identity and at least 40 --scenario values are required');
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const taskRoot = existingRealDirectory(resolve(args.taskRoot), 'task root');
  const runtimeRoot = existingRealDirectory(resolve(args.runtimeRoot), 'runtime root');
  const outputPath = resolve(args.output);
  const roundRoot = resolve(runtimeRoot, 'gate-integration', args.roundId);
  validateGuardContext({ runtimeRoot, repoRoot: taskRoot, entrypoint: ENTRYPOINT });
  assertPathInside(roundRoot, outputPath, 'integration summary');
  assertNoSymlinkSegments(roundRoot, outputPath, 'integration summary');
  const scenarioIds = args.scenarios.map((item) => item.scenarioId);
  const scenarioReceipts = args.scenarios.map((item) => resolve(item.receipt));
  if (new Set(scenarioIds).size !== scenarioIds.length
    || new Set(scenarioReceipts).size !== scenarioReceipts.length
    || REQUIRED_GATE_SCENARIOS.some((id) => !scenarioIds.includes(id))) {
    throw new Error('scenario identities must be unique and include every required gate case');
  }
  const receipts = [...args.scenarios].sort((a, b) => a.scenarioId.localeCompare(b.scenarioId)).map((scenario) => {
    if (!scenario.scenarioId || !Array.isArray(scenario.args) || !Number.isInteger(scenario.expectedExitCode)) {
      throw new Error('invalid scenario declaration');
    }
    const absolute = resolve(scenario.receipt);
    assertPathInside(roundRoot, absolute, 'scenario receipt');
    assertNoSymlinkSegments(roundRoot, absolute, 'scenario receipt');
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`scenario receipt must be a regular file: ${absolute}`);
    const bytes = readFileSync(absolute);
    const value = JSON.parse(bytes.toString('utf8'));
    const { metadataDigest, ...metadata } = value;
    if (value.schema !== 'neo.code-integrity.safe-run.v2' || hashBytes(canonicalJson(metadata)) !== metadataDigest) {
      throw new Error(`invalid scenario receipt: ${absolute}`);
    }
    const entrypoint = resolve(scenario.entrypoint);
    const scenarioCwd = resolve(scenario.cwd);
    assertPathInside(taskRoot, entrypoint, 'scenario entrypoint');
    assertNoSymlinkSegments(taskRoot, entrypoint, 'scenario entrypoint');
    assertPathInside(taskRoot, scenarioCwd, 'scenario cwd');
    assertNoSymlinkSegments(taskRoot, scenarioCwd, 'scenario cwd');
    const entrypointEvidence = (value.commandFiles || []).find((item) => item.role === 'entrypoint');
    if (value.exitCode !== scenario.expectedExitCode
      || value.childExitCode !== scenario.expectedExitCode
      || value.executable !== process.execPath
      || resolve(value.cwd) !== scenarioCwd
      || canonicalJson(value.args) !== canonicalJson([entrypoint, ...scenario.args])
      || value.argsSha256 !== hashBytes(JSON.stringify([entrypoint, ...scenario.args]))
      || resolve(entrypointEvidence?.path || '') !== entrypoint
      || entrypointEvidence?.sha256 !== hashBytes(readFileSync(entrypoint))) {
      throw new Error(`scenario command or result mismatch: ${scenario.scenarioId}`);
    }
    if (scenario.scenarioId.startsWith('gate:')) {
      const [, fixtureName, expectedText] = scenario.scenarioId.split(':');
      const repoIndex = scenario.args.indexOf('--repo-root');
      const receiptIndex = scenario.args.indexOf('--receipt');
      if (!entrypoint.endsWith('/scripts/code-integrity/changed-gate.mjs')
        || !scenarioCwd.includes('/gate-integration/')
        || repoIndex < 0
        || resolve(scenario.args[repoIndex + 1] || '') !== scenarioCwd
        || receiptIndex < 0
        || basename(scenario.args[receiptIndex + 1] || '', '.json') !== fixtureName
        || Number(expectedText) !== scenario.expectedExitCode) {
        throw new Error(`gate scenario identity mismatch: ${scenario.scenarioId}`);
      }
    } else if (scenario.scenarioId.startsWith('guard:')) {
      if (!entrypoint.endsWith('/scripts/code-integrity/gate-readonly-probe.mjs')
        || scenario.args[0] !== 'unguarded-gate-refusal'
        || scenario.expectedExitCode !== 0) {
        throw new Error(`guard scenario identity mismatch: ${scenario.scenarioId}`);
      }
    } else if (scenario.scenarioId.startsWith('verify:')) {
      const [, fixtureName, , expectedText] = scenario.scenarioId.split(':');
      const repoIndex = scenario.args.indexOf('--repo-root');
      const receiptIndex = scenario.args.indexOf('--receipt');
      if (!entrypoint.endsWith('/scripts/code-integrity/verify-gate-receipt.mjs')
        || repoIndex < 0
        || resolve(scenario.args[repoIndex + 1] || '') !== scenarioCwd
        || receiptIndex < 0
        || basename(scenario.args[receiptIndex + 1] || '', '.json') !== fixtureName
        || Number(expectedText) !== scenario.expectedExitCode) {
        throw new Error(`verify scenario identity mismatch: ${scenario.scenarioId}`);
      }
    }
    return {
      scenarioId: scenario.scenarioId,
      path: absolute,
      sha256: hashBytes(bytes),
      executable: value.executable,
      entrypoint,
      entrypointSha256: entrypointEvidence.sha256,
      cwd: scenarioCwd,
      argsSha256: value.argsSha256,
      expectedExitCode: scenario.expectedExitCode,
    };
  });
  const source = codeIntegritySourceEvidence(taskRoot);
  if (source.sourceDigest !== args.expectedSourceDigest) throw new Error('code-integrity source changed during integration run');
  const metadata = {
    schema: 'neo.code-integrity.gate-integration.v2',
    createdAt: new Date().toISOString(),
    testPath: GATE_INTEGRATION_TEST,
    roundId: args.roundId,
    passed: true,
    readOnlyOrchestrator: true,
    coverage: ['guard', 'vitest', 'worktree', 'staged', 'commit-range', 'stale', 'mechanical', 'artifacts', 'logs'],
    sourceItems: source.items,
    sourceDigestBefore: args.expectedSourceDigest,
    sourceDigest: source.sourceDigest,
    receipts,
  };
  atomicJsonWrite(outputPath, { ...metadata, metadataDigest: hashBytes(canonicalJson(metadata)) });
  process.stdout.write(`${JSON.stringify({ status: 'pass', outputPath, sourceDigest: source.sourceDigest, receiptCount: receipts.length })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`gate integration summary refused: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
