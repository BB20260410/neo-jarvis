#!/usr/bin/env node
// @ts-check

import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { canonicalJson } from './lib/artifacts.mjs';
import {
  absolutePath,
  assertExecutableNameAllowed,
  assertNoProtectedOverlap,
  assertNoSymlinkSegments,
  assertPathInside,
  buildSandboxProfile,
  defaultProtectedReadRoots,
  existingExecutable,
  existingRealDirectory,
  sha256,
  uniquePaths,
} from './lib/policy.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TASK_ROOT = resolve(SCRIPT_DIR, '../..');

/** @typedef {{ taskRoot?: string, runtimeRoot?: string, cwd?: string, receipt?: string, timeoutMs?: number, writeRoots: string[], readRoots: string[], protectedReadRoots: string[], allowedExecutables: string[], boundOutputs: string[], command: string[] }} CliOptions */

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {CliOptions} */
  const out = {
    writeRoots: [],
    readRoots: [],
    protectedReadRoots: [],
    allowedExecutables: [],
    boundOutputs: [],
    command: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      out.command = argv.slice(i + 1);
      break;
    }
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${arg}`);
    if (arg === '--task-root') out.taskRoot = value;
    else if (arg === '--runtime-root') out.runtimeRoot = value;
    else if (arg === '--cwd') out.cwd = value;
    else if (arg === '--receipt') out.receipt = value;
    else if (arg === '--write-root') out.writeRoots.push(value);
    else if (arg === '--read-root') out.readRoots.push(value);
    else if (arg === '--protect-read') out.protectedReadRoots.push(value);
    else if (arg === '--allow-exec') out.allowedExecutables.push(value);
    else if (arg === '--bind-output') out.boundOutputs.push(value);
    else if (arg === '--timeout-ms') out.timeoutMs = Number(value);
    else throw new Error(`unknown option: ${arg}`);
    i += 1;
  }

  if (out.command.length === 0) throw new Error('missing command after --');
  if (out.timeoutMs !== undefined && (!Number.isInteger(out.timeoutMs) || out.timeoutMs < 1000 || out.timeoutMs > 300000)) {
    throw new Error('--timeout-ms must be an integer from 1000 to 300000');
  }
  return out;
}

/**
 * Only pass deterministic, non-secret process context. In particular, HOME
 * and provider/token variables are intentionally not forwarded.
 * @param {string} tmpDir
 * @param {string} guardContextPath
 * @param {string} guardToken
 * @param {string} taskRoot
 * @param {string} runtimeRoot
 */
function childEnvironment(tmpDir, guardContextPath, guardToken, taskRoot, runtimeRoot) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    CI: '1',
    NO_COLOR: '1',
    NOE_CODE_INTEGRITY_GUARD: '1',
    NOE_CODE_INTEGRITY_GUARD_CONTEXT: guardContextPath,
    NOE_CODE_INTEGRITY_GUARD_TOKEN: guardToken,
    NOE_CODE_INTEGRITY_TASK_ROOT: taskRoot,
    NOE_CODE_INTEGRITY_RUNTIME_ROOT: runtimeRoot,
    NODE_OPTIONS: '--max-old-space-size=768',
    PATH: process.env.PATH || '/usr/bin:/bin',
    TMPDIR: tmpDir,
  };
  for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE', 'TERM']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

/** @param {string} filePath @param {unknown} value */
function atomicJsonWrite(filePath, value) {
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    linkSync(tmp, filePath);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

/** @param {string} root @param {string} candidate @param {string} label */
function ensureSafeDirectory(root, candidate, label) {
  assertPathInside(root, candidate, label);
  assertNoSymlinkSegments(root, candidate, label);
  mkdirSync(candidate, { recursive: true, mode: 0o700 });
  assertNoSymlinkSegments(root, candidate, label);
  const real = existingRealDirectory(candidate, label);
  assertPathInside(root, real, label);
  return real;
}

/** @param {string} executable @param {string[]} args @param {string} cwd @param {string} taskRoot */
function commandEvidence(executable, args, cwd, taskRoot) {
  const evidence = [{ path: executable, sha256: sha256(readFileSync(executable)), role: 'executable' }];
  if (basename(executable).toLowerCase() !== 'node') return evidence;
  const denied = new Set(['-e', '--eval', '-p', '--print', '-r', '--require', '--import', '--loader', '--experimental-loader']);
  if (args.some((item) => denied.has(item))) throw new Error('inline or preload Node execution is not allowed');
  let entryArg = args[0];
  if (entryArg === '--check') entryArg = args[1];
  if (!entryArg || entryArg.startsWith('-')) throw new Error('Node command requires a file entrypoint');
  const entryInput = resolve(cwd, entryArg);
  assertPathInside(taskRoot, entryInput, 'Node entrypoint');
  assertNoSymlinkSegments(taskRoot, entryInput, 'Node entrypoint');
  const stat = lstatSync(entryInput);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Node entrypoint must be a regular file: ${entryInput}`);
  evidence.push({ path: entryInput, sha256: sha256(readFileSync(entryInput)), role: 'entrypoint' });
  return evidence;
}

/** @param {number} pid */
function readProcessGroupId(pid) {
  const result = spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' });
  const value = Number((result.stdout || '').trim());
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** @param {string} pathValue */
function directoryIdentity(pathValue) {
  const realPath = existingRealDirectory(pathValue, 'policy directory');
  const stat = lstatSync(realPath);
  return { resolvedPath: resolve(pathValue), realPath, dev: stat.dev, ino: stat.ino, kind: 'directory' };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const taskRootInput = resolve(parsed.taskRoot || DEFAULT_TASK_ROOT);
  if (!existsSync(taskRootInput)) throw new Error(`task root does not exist: ${taskRootInput}`);
  const taskRoot = existingRealDirectory(taskRootInput, 'task root');

  const runtimeInput = resolve(parsed.runtimeRoot || join(taskRoot, 'output', 'code-integrity-runtime'));
  assertPathInside(taskRoot, runtimeInput, 'runtime root');
  const runtimeRoot = ensureSafeDirectory(taskRoot, runtimeInput, 'runtime root');

  const cwdInput = resolve(parsed.cwd || taskRoot);
  const cwd = existingRealDirectory(cwdInput, 'cwd');
  assertPathInside(taskRoot, cwd, 'cwd');

  const tmpDir = ensureSafeDirectory(runtimeRoot, join(runtimeRoot, 'tmp'), 'tmp directory');
  const profilesDir = ensureSafeDirectory(runtimeRoot, join(runtimeRoot, 'profiles'), 'profiles directory');
  const receiptsDir = ensureSafeDirectory(runtimeRoot, join(runtimeRoot, 'receipts'), 'receipts directory');
  const guardContextsDir = ensureSafeDirectory(runtimeRoot, join(runtimeRoot, 'guard-contexts'), 'guard contexts directory');

  const writeInputs = parsed.writeRoots.length > 0 ? parsed.writeRoots : [runtimeRoot];
  const allowedWriteRoots = uniquePaths(writeInputs.map((item) => {
    const candidate = resolve(item);
    const real = ensureSafeDirectory(runtimeRoot, candidate, 'write root');
    assertPathInside(runtimeRoot, real, 'write root');
    return real;
  }));

  const userHome = homedir();
  const defaultProtectedReads = defaultProtectedReadRoots(userHome);
  const protectedReadRoots = uniquePaths([...defaultProtectedReads, ...parsed.protectedReadRoots]
    .map((item) => absolutePath(resolve(item), 'protected read root')));
  assertNoProtectedOverlap(allowedWriteRoots, protectedReadRoots);

  const explicitReadRoots = parsed.readRoots.map((item) => existingRealDirectory(resolve(item), 'read root'));
  const allowedReadRoots = uniquePaths([taskRoot, runtimeRoot, ...explicitReadRoots]);
  assertNoProtectedOverlap(allowedReadRoots, protectedReadRoots);

  const commandExecutable = existingExecutable(parsed.command[0]);
  assertExecutableNameAllowed(commandExecutable);
  const allowedExecutables = uniquePaths([
    existingExecutable(process.execPath),
    ...parsed.allowedExecutables.map((item) => existingExecutable(item)),
  ]);
  for (const executable of allowedExecutables) assertExecutableNameAllowed(executable);
  if (!allowedExecutables.includes(commandExecutable)) {
    throw new Error(`command executable is not allowlisted: ${commandExecutable}`);
  }
  const commandFiles = commandEvidence(commandExecutable, parsed.command.slice(1), cwd, taskRoot);

  const runId = `${Date.now()}-${randomUUID()}`;
  const receiptInput = resolve(parsed.receipt || join(receiptsDir, `${runId}.json`));
  assertPathInside(runtimeRoot, receiptInput, 'receipt');
  const receiptDir = ensureSafeDirectory(runtimeRoot, dirname(receiptInput), 'receipt directory');
  if (receiptDir === runtimeRoot) throw new Error('receipt must use a dedicated directory below runtime root');
  assertNoSymlinkSegments(runtimeRoot, receiptInput, 'receipt');
  if (existsSync(receiptInput)) throw new Error(`receipt already exists: ${receiptInput}`);

  const protectedWriteRoots = uniquePaths([profilesDir, receiptsDir, guardContextsDir, receiptDir]);
  const controlDirectoryIdentity = protectedWriteRoots.map((pathValue) => {
    const stat = lstatSync(pathValue);
    return { path: pathValue, dev: stat.dev, ino: stat.ino };
  });

  const boundOutputPaths = [...new Set(parsed.boundOutputs.map((item) => resolve(item)))].sort();
  for (const pathValue of boundOutputPaths) {
    assertPathInside(runtimeRoot, pathValue, 'bound output');
    ensureSafeDirectory(runtimeRoot, dirname(pathValue), 'bound output directory');
    assertNoSymlinkSegments(runtimeRoot, pathValue, 'bound output');
    if (existsSync(pathValue)) throw new Error(`bound output already exists: ${pathValue}`);
  }
  assertNoProtectedOverlap(boundOutputPaths, protectedWriteRoots);

  const profile = buildSandboxProfile({
    allowedExecutables,
    allowedWriteRoots,
    protectedWriteRoots,
    allowedReadRoots,
    homeReadRoot: userHome,
    protectedReadRoots,
    allowNetwork: false,
  });
  const profilePath = join(profilesDir, `${runId}.sb`);
  writeFileSync(profilePath, profile, { flag: 'wx', mode: 0o600 });
  const profileSha256 = sha256(profile);
  const effectivePolicy = {
    taskRoot: directoryIdentity(taskRoot),
    runtimeRoot: directoryIdentity(runtimeRoot),
    cwd: directoryIdentity(cwd),
    allowedExecutables,
    allowedWriteRoots,
    protectedWriteRoots,
    allowedReadRoots,
    protectedReadRoots,
    network: 'denied',
    processSignals: 'denied',
    profileSha256,
  };
  const effectivePolicyHash = sha256(canonicalJson(effectivePolicy));
  const safeRunArgvCount = process.argv.slice(2).length;
  const safeRunArgvSha256 = sha256(JSON.stringify(process.argv.slice(2)));

  const guardToken = `${randomUUID()}${randomUUID()}`;
  const guardContextPath = join(guardContextsDir, `${runId}.json`);
  const guardMetadata = {
    schema: 'neo.code-integrity.guard-context.v1',
    runId,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    taskRoot,
    runtimeRoot,
    cwd,
    executable: commandExecutable,
    argsSha256: sha256(JSON.stringify(parsed.command.slice(1))),
    commandFiles,
    profileSha256,
    allowedWriteRoots,
    protectedWriteRoots,
    allowedReadRoots,
    network: 'denied',
    processSignals: 'denied',
    effectivePolicyHash,
    tokenSha256: sha256(guardToken),
  };
  const guardContext = { ...guardMetadata, metadataDigest: sha256(canonicalJson(guardMetadata)) };
  writeFileSync(guardContextPath, `${JSON.stringify(guardContext, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const guardContextSha256 = sha256(readFileSync(guardContextPath));

  const startedAt = new Date();
  const startNs = process.hrtime.bigint();
  const runnerPgid = readProcessGroupId(process.pid);
  const timeoutMs = parsed.timeoutMs || 60000;
  const child = spawnSync('/usr/bin/nice', [
    '-n',
    '10',
    '/usr/bin/sandbox-exec',
    '-f', profilePath,
    commandExecutable, ...parsed.command.slice(1),
  ], {
    cwd,
    env: childEnvironment(tmpDir, guardContextPath, guardToken, taskRoot, runtimeRoot),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const endedAt = new Date();
  const durationMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
  const stdout = child.stdout || '';
  const stderr = child.stderr || '';

  for (const identity of controlDirectoryIdentity) {
    assertNoSymlinkSegments(runtimeRoot, identity.path, 'control directory');
    const currentReal = existingRealDirectory(identity.path, 'control directory');
    const currentStat = lstatSync(currentReal);
    if (currentReal !== identity.path || currentStat.dev !== identity.dev || currentStat.ino !== identity.ino) {
      throw new Error(`control directory changed during child execution: ${identity.path}`);
    }
  }
  for (const identity of [effectivePolicy.taskRoot, effectivePolicy.runtimeRoot, effectivePolicy.cwd]) {
    assertNoSymlinkSegments(identity.realPath, identity.realPath, 'policy directory');
    const current = directoryIdentity(identity.resolvedPath);
    if (canonicalJson(current) !== canonicalJson(identity)) {
      throw new Error(`policy directory changed during child execution: ${identity.resolvedPath}`);
    }
  }
  assertNoSymlinkSegments(runtimeRoot, profilePath, 'sandbox profile');
  assertNoSymlinkSegments(runtimeRoot, guardContextPath, 'guard context');
  assertNoSymlinkSegments(runtimeRoot, receiptInput, 'receipt');
  for (const controlFile of [
    { path: profilePath, expected: profileSha256, label: 'sandbox profile' },
    { path: guardContextPath, expected: guardContextSha256, label: 'guard context' },
  ]) {
    const stat = lstatSync(controlFile.path);
    if (!stat.isFile() || stat.isSymbolicLink() || sha256(readFileSync(controlFile.path)) !== controlFile.expected) {
      throw new Error(`${controlFile.label} changed during child execution`);
    }
  }

  const boundOutputs = boundOutputPaths.map((pathValue) => {
    if (!existsSync(pathValue)) return { path: pathValue, valid: false, reason: 'missing', sha256: null, size: null };
    assertNoSymlinkSegments(runtimeRoot, pathValue, 'bound output');
    const stat = lstatSync(pathValue);
    if (!stat.isFile() || stat.isSymbolicLink()) return { path: pathValue, valid: false, reason: 'not_regular_file', sha256: null, size: null };
    const bytes = readFileSync(pathValue);
    return { path: pathValue, valid: true, reason: 'regular_file', sha256: sha256(bytes), size: bytes.length };
  });
  const boundOutputFailure = boundOutputs.some((item) => !item.valid);
  const effectiveExitCode = child.error || boundOutputFailure ? 1 : child.status ?? 1;

  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  const receiptMetadata = {
    schema: 'neo.code-integrity.safe-run.v2',
    runId,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: Number(durationMs.toFixed(3)),
    runnerPid: process.pid,
    runnerPpid: process.ppid,
    runnerPgid,
    sandboxExecPid: child.pid ?? null,
    sandboxPgid: runnerPgid,
    processGroupEvidence: 'sandbox-exec inherits the runner process group; static safe-run never sends signals',
    taskRoot,
    runtimeRoot,
    cwd,
    executable: commandExecutable,
    args: parsed.command.slice(1),
    argsSha256: sha256(JSON.stringify(parsed.command.slice(1))),
    safeRunArgvCount,
    safeRunArgvSha256,
    commandFiles,
    guardContext: { path: guardContextPath, sha256: guardContextSha256, runId },
    runnerSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    policySha256: sha256(readFileSync(join(SCRIPT_DIR, 'lib', 'policy.mjs'))),
    timeoutMs,
    nice: 10,
    allowedExecutables,
    allowedWriteRoots,
    protectedWriteRoots,
    allowedReadRoots,
    homeReadRoot: userHome,
    protectedReadRoots,
    network: 'denied',
    processSignals: 'denied',
    profilePath,
    profileSha256,
    effectivePolicy,
    effectivePolicyHash,
    environmentKeys: Object.keys(childEnvironment(tmpDir, guardContextPath, guardToken, taskRoot, runtimeRoot)).sort(),
    childExitCode: child.status,
    exitCode: effectiveExitCode,
    signal: child.signal || null,
    spawnError: child.error ? { code: child.error.code || null, message: child.error.message } : null,
    stdoutBytes: Buffer.byteLength(stdout),
    stdoutSha256: sha256(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    stderrSha256: sha256(stderr),
    boundOutputs,
  };
  const receipt = { ...receiptMetadata, metadataDigest: sha256(canonicalJson(receiptMetadata)) };
  atomicJsonWrite(receiptInput, receipt);
  process.stderr.write(`safe-run receipt: ${receiptInput}\n`);

  process.exitCode = effectiveExitCode;
}

try {
  main();
} catch (error) {
  process.stderr.write(`safe-run refused: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
