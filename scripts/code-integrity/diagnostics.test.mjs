#!/usr/bin/env node
// @ts-check

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { canonicalJson, hashBytes } from './lib/artifacts.mjs';
import { compareDiagnostics, diagnosticCounts, parseDiagnosticLine } from './lib/diagnostics.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CAPTURE = join(SCRIPT_DIR, 'typescript-diagnostic-capture.mjs');
const RATCHET = join(SCRIPT_DIR, 'diagnostic-ratchet.mjs');
const SAFE_RUN = join(SCRIPT_DIR, 'safe-run.mjs');
const POLICY = join(SCRIPT_DIR, 'lib', 'policy.mjs');
const runtimeInput = process.argv[2] || process.env.NOE_CODE_INTEGRITY_RUNTIME_ROOT;
if (!runtimeInput) throw new Error('runtime root argument is required');
const fixtureRoot = join(resolve(runtimeInput), 'diagnostic-tests', randomUUID());
const repoRoot = join(fixtureRoot, 'repo');
const captureRuntime = join(repoRoot, 'output', 'diagnostic-runtime');
mkdirSync(join(repoRoot, 'src'), { recursive: true, mode: 0o700 });
mkdirSync(join(repoRoot, 'node_modules', 'typescript', 'bin'), { recursive: true, mode: 0o700 });
mkdirSync(captureRuntime, { recursive: true, mode: 0o700 });

/** @param {string} executable @param {string[]} args @param {string} cwd @param {number} [expected] */
function run(executable, args, cwd, expected = 0) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    env: {
      CI: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0',
      NO_COLOR: '1',
      PATH: '/usr/bin:/bin',
      TMPDIR: process.env.TMPDIR,
    },
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, expected, `${executable} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

/** @param {string} pathValue @param {Record<string, unknown>} metadata */
function writeJson(pathValue, metadata) {
  writeFileSync(pathValue, `${JSON.stringify({ ...metadata, metadataDigest: hashBytes(canonicalJson(metadata)) }, null, 2)}\n`);
}

const tscEntrypoint = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc.mjs');
const packageJson = join(repoRoot, 'node_modules', 'typescript', 'package.json');
writeFileSync(join(repoRoot, '.gitignore'), 'output/\n');
writeFileSync(join(repoRoot, 'src', 'a.js'), 'export const value = 1;\n');
writeFileSync(join(repoRoot, 'diagnostic-mode.txt'), 'baseline\n');
writeFileSync(packageJson, '{"name":"typescript","version":"5.9.1"}\n');
writeFileSync(tscEntrypoint, `// @ts-check
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv.includes('--version')) {
  process.stdout.write('Version 5.9.1\\n');
} else {
  const mode = readFileSync(join(process.cwd(), 'diagnostic-mode.txt'), 'utf8').trim();
  const line = mode === 'moved' ? 99 : 10;
  process.stdout.write(\`${'${process.cwd()}'}/src/a.js(\${line},2): error TS1161: Unterminated regular expression literal.\\n\`);
  if (mode === 'extra') process.stdout.write(\`${'${process.cwd()}'}/src/b.js(1,1): error TS2304: Cannot find name x.\\n\`);
  process.exitCode = 2;
}
`);
run('/usr/bin/git', ['init', '--initial-branch=noe-main'], repoRoot);
run('/usr/bin/git', ['config', 'user.email', 'code-integrity@example.invalid'], repoRoot);
run('/usr/bin/git', ['config', 'user.name', 'Code Integrity Test'], repoRoot);
run('/usr/bin/git', ['add', '.gitignore', 'src/a.js', 'diagnostic-mode.txt', 'node_modules/typescript/bin/tsc.mjs', 'node_modules/typescript/package.json'], repoRoot);
run('/usr/bin/git', ['commit', '-m', 'diagnostic fixture'], repoRoot);

const sampleLine = `${repoRoot}/src/a.js(10,2): error TS1161: Unterminated regular expression literal.`;
assert.equal(parseDiagnosticLine(sampleLine, repoRoot)?.path, 'src/a.js');
const baselineCounts = diagnosticCounts(`${sampleLine}\n`, repoRoot);
const movedCounts = diagnosticCounts(`${repoRoot}/src/a.js(99,8): error TS1161: Unterminated regular expression literal.\n`, repoRoot);
assert.equal(compareDiagnostics(baselineCounts, movedCounts).length, 0);
assert.throws(() => diagnosticCounts('not tsc output\n', repoRoot), /unsupported TypeScript diagnostic output/);

/** @param {string} label */
function capture(label) {
  const root = join(captureRuntime, label);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const evidencePath = join(root, 'evidence.json');
  const stdoutPath = join(root, 'stdout.log');
  const stderrPath = join(root, 'stderr.log');
  const captureArgs = [
    '--repo-root', repoRoot,
    '--runtime-root', captureRuntime,
    '--tsc-entrypoint', tscEntrypoint,
    '--typescript-package', packageJson,
    '--output', evidencePath,
    '--stdout', stdoutPath,
    '--stderr', stderrPath,
  ];
  run(process.execPath, [CAPTURE, ...captureArgs], repoRoot);
  const receiptPath = join(root, 'safe-run.json');
  const boundOutputs = [evidencePath, stdoutPath, stderrPath].map((pathValue) => {
    const bytes = readFileSync(pathValue);
    return { path: pathValue, valid: true, reason: 'regular_file', sha256: hashBytes(bytes), size: bytes.length };
  }).sort((a, b) => a.path.localeCompare(b.path));
  writeJson(receiptPath, {
    schema: 'neo.code-integrity.safe-run.v2',
    taskRoot: repoRoot,
    runtimeRoot: captureRuntime,
    cwd: repoRoot,
    executable: process.execPath,
    args: [CAPTURE, ...captureArgs],
    commandFiles: [
      { path: process.execPath, sha256: hashBytes(readFileSync(process.execPath)), role: 'executable' },
      { path: CAPTURE, sha256: hashBytes(readFileSync(CAPTURE)), role: 'entrypoint' },
    ],
    runnerSha256: hashBytes(readFileSync(SAFE_RUN)),
    policySha256: hashBytes(readFileSync(POLICY)),
    allowedReadRoots: [repoRoot, captureRuntime],
    allowedWriteRoots: [captureRuntime],
    protectedReadRoots: [],
    network: 'denied',
    processSignals: 'denied',
    childExitCode: 0,
    exitCode: 0,
    signal: null,
    spawnError: null,
    boundOutputs,
  });
  return { evidencePath, receiptPath, stdoutPath };
}

const baselineCapture = capture('baseline');
const baselinePath = join(captureRuntime, 'baseline-v2.json');
run(process.execPath, [
  RATCHET, 'create',
  '--evidence', baselineCapture.evidencePath,
  '--safe-run-receipt', baselineCapture.receiptPath,
  '--output', baselinePath,
  '--repo-root', repoRoot,
  '--runtime-root', captureRuntime,
], repoRoot);
assert.equal(JSON.parse(readFileSync(baselinePath, 'utf8')).schema, 'neo.code-integrity.diagnostics.v2');

writeFileSync(join(repoRoot, 'diagnostic-mode.txt'), 'moved\n');
const movedCapture = capture('moved');
const movedReport = join(captureRuntime, 'moved-report.json');
run(process.execPath, [
  RATCHET, 'compare',
  '--evidence', movedCapture.evidencePath,
  '--safe-run-receipt', movedCapture.receiptPath,
  '--baseline', baselinePath,
  '--output', movedReport,
  '--repo-root', repoRoot,
  '--runtime-root', captureRuntime,
], repoRoot);
assert.equal(JSON.parse(readFileSync(movedReport, 'utf8')).passed, true);

writeFileSync(join(repoRoot, 'diagnostic-mode.txt'), 'extra\n');
const extraCapture = capture('extra');
const extraReport = join(captureRuntime, 'extra-report.json');
run(process.execPath, [
  RATCHET, 'compare',
  '--evidence', extraCapture.evidencePath,
  '--safe-run-receipt', extraCapture.receiptPath,
  '--baseline', baselinePath,
  '--output', extraReport,
  '--repo-root', repoRoot,
  '--runtime-root', captureRuntime,
], repoRoot, 3);
assert.equal(JSON.parse(readFileSync(extraReport, 'utf8')).newDiagnostics[0].diagnostic.code, 'TS2304');

const tampered = capture('tampered');
writeFileSync(tampered.stdoutPath, 'tampered\n');
run(process.execPath, [
  RATCHET, 'create',
  '--evidence', tampered.evidencePath,
  '--safe-run-receipt', tampered.receiptPath,
  '--output', join(captureRuntime, 'tampered-baseline.json'),
  '--repo-root', repoRoot,
  '--runtime-root', captureRuntime,
], repoRoot, 2);
run(process.execPath, [RATCHET, 'create', '--input', 'legacy.txt'], repoRoot, 2);

process.stdout.write('diagnostic tests: PASS (typed capture evidence + v2 ratchet)\n');
