#!/usr/bin/env node
// @ts-check

import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertNoSymlinkSegments, assertPathInside, existingRealDirectory } from './lib/policy.mjs';
import { atomicJsonWrite, canonicalJson, hashBytes } from './lib/artifacts.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TASK_ROOT = resolve(SCRIPT_DIR, '../..');

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ taskRoot?: string, runtimeRoot?: string, mainRoot?: string, protectedPid?: number }} */
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${key}`);
    if (key === '--task-root') out.taskRoot = value;
    else if (key === '--runtime-root') out.runtimeRoot = value;
    else if (key === '--main-root') out.mainRoot = value;
    else if (key === '--protected-pid') out.protectedPid = Number(value);
    else throw new Error(`unknown option: ${key}`);
  }
  if (!out.mainRoot) throw new Error('--main-root is required');
  if (!Number.isInteger(out.protectedPid) || Number(out.protectedPid) <= 1) {
    throw new Error('--protected-pid must identify an existing non-canary process');
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const taskRoot = existingRealDirectory(resolve(args.taskRoot || DEFAULT_TASK_ROOT), 'task root');
  const mainRoot = existingRealDirectory(resolve(args.mainRoot), 'main root');
  const runtimeInput = resolve(args.runtimeRoot || join(taskRoot, 'output', 'code-integrity-runtime'));
  assertPathInside(taskRoot, runtimeInput, 'runtime root');
  assertNoSymlinkSegments(taskRoot, runtimeInput, 'runtime root');
  mkdirSync(runtimeInput, { recursive: true, mode: 0o700 });
  const runtimeRoot = existingRealDirectory(runtimeInput, 'runtime root');
  assertPathInside(taskRoot, runtimeRoot, 'runtime root');
  assertNoSymlinkSegments(taskRoot, runtimeRoot, 'runtime root');
  const canaryDir = join(runtimeRoot, 'canary');
  const receiptDir = join(runtimeRoot, 'canary-receipts');
  for (const pathValue of [canaryDir, receiptDir]) {
    assertNoSymlinkSegments(runtimeRoot, pathValue, 'canary directory');
    mkdirSync(pathValue, { recursive: true, mode: 0o700 });
    assertNoSymlinkSegments(runtimeRoot, pathValue, 'canary directory');
  }

  const safeRun = join(SCRIPT_DIR, 'safe-run.mjs');
  const probe = join(SCRIPT_DIR, 'probe.mjs');
  const unique = randomUUID();
  const cases = [
    { name: 'allowed-runtime-write', probe: ['allowed-write', join(canaryDir, `allowed-${unique}.txt`)] },
    { name: 'clone-source-write-denied', probe: ['create-denied', join(taskRoot, `code-integrity-must-not-exist-${unique}.tmp`)] },
    { name: 'control-dir-rename-denied', probe: ['control-dir-rename-denied', receiptDir] },
    { name: 'main-rplus-denied', probe: ['open-rplus-denied', join(mainRoot, 'AGENTS.md')] },
    { name: 'main-read-denied', probe: ['read-denied', join(mainRoot, 'AGENTS.md')] },
    { name: 'symlink-escape-denied', probe: ['symlink-rplus-denied', join(canaryDir, `main-link-${unique}`), join(mainRoot, 'AGENTS.md')] },
    { name: 'symlink-read-denied', probe: ['symlink-read-denied', join(canaryDir, `main-read-link-${unique}`), join(mainRoot, 'AGENTS.md')] },
    { name: 'foreign-signal-denied', probe: ['signal-zero-denied', String(args.protectedPid)] },
    { name: 'launchctl-exec-denied', probe: ['launchctl-denied'] },
    { name: 'network-denied', probe: ['network-denied', '127.0.0.1', '65534'] },
  ];

  /** @type {Array<Record<string, unknown>>} */
  const results = [];
  for (const item of cases) {
    const receipt = join(receiptDir, `${item.name}-${unique}.json`);
    const child = spawnSync(process.execPath, [
      safeRun,
      '--task-root', taskRoot,
      '--runtime-root', runtimeRoot,
      '--cwd', taskRoot,
      '--protect-read', mainRoot,
      '--receipt', receipt,
      '--',
      process.execPath,
      probe,
      ...item.probe,
    ], {
      cwd: taskRoot,
      encoding: 'utf8',
      env: { PATH: process.env.PATH || '/usr/bin:/bin' },
      maxBuffer: 8 * 1024 * 1024,
    });
    let receiptValid = false;
    /** @type {string|null} */
    let receiptSha256 = null;
    try {
      assertNoSymlinkSegments(runtimeRoot, receipt, 'canary receipt');
      const stat = lstatSync(receipt);
      const bytes = readFileSync(receipt);
      const value = JSON.parse(bytes.toString('utf8'));
      const { metadataDigest, ...metadata } = value;
      receiptSha256 = hashBytes(bytes);
      receiptValid = stat.isFile()
        && !stat.isSymbolicLink()
        && value.schema === 'neo.code-integrity.safe-run.v2'
        && hashBytes(canonicalJson(metadata)) === metadataDigest
        && value.exitCode === 0
        && value.network === 'denied'
        && value.processSignals === 'denied';
    } catch {
      receiptValid = false;
    }
    const passed = child.status === 0 && receiptValid;
    results.push({
      name: item.name,
      passed,
      exitCode: child.status,
      signal: child.signal || null,
      receipt,
      receiptSha256,
      receiptValid,
      stdoutSha256: hashBytes(child.stdout || ''),
      stderrSha256: hashBytes(child.stderr || ''),
    });
    process.stdout.write(`${passed ? 'PASS' : 'FAIL'} ${item.name}\n`);
  }

  const passed = results.filter((item) => item.passed).length;
  const metadata = {
    schema: 'neo.code-integrity.canary.v2',
    createdAt: new Date().toISOString(),
    taskRoot,
    runtimeRoot,
    mainRoot,
    protectedPid: args.protectedPid,
    total: results.length,
    passed,
    failed: results.length - passed,
    readyForStaticChecks: passed === results.length,
    readyForRuntimeChecks: false,
    results,
  };
  const summary = { ...metadata, metadataDigest: hashBytes(canonicalJson(metadata)) };
  const summaryPath = join(runtimeRoot, `canary-summary-${unique}.json`);
  atomicJsonWrite(summaryPath, summary);
  process.stdout.write(`canary summary: ${summaryPath}\n`);
  if (summary.failed > 0) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(`canary refused: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
