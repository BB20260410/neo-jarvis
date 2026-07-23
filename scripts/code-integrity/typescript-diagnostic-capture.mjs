#!/usr/bin/env node
// @ts-check

import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomicJsonWrite, canonicalJson, describePaths, gitHead, hashBytes, listDirtyPaths, manifestDigest, runGit } from './lib/artifacts.mjs';
import { assertNoSymlinkSegments, assertPathInside, existingRealDirectory } from './lib/policy.mjs';

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ repoRoot?: string, runtimeRoot?: string, tscEntrypoint?: string, typescriptPackage?: string, output?: string, stdout?: string, stderr?: string }} */
  const out = {};
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${key}`);
    if (seen.has(key)) throw new Error(`duplicate option: ${key}`);
    seen.add(key);
    if (key === '--repo-root') out.repoRoot = value;
    else if (key === '--runtime-root') out.runtimeRoot = value;
    else if (key === '--tsc-entrypoint') out.tscEntrypoint = value;
    else if (key === '--typescript-package') out.typescriptPackage = value;
    else if (key === '--output') out.output = value;
    else if (key === '--stdout') out.stdout = value;
    else if (key === '--stderr') out.stderr = value;
    else throw new Error(`unknown option: ${key}`);
  }
  if (!out.repoRoot || !out.runtimeRoot || !out.tscEntrypoint || !out.typescriptPackage || !out.output || !out.stdout || !out.stderr) {
    throw new Error('repo/runtime/tsc/package/output/stdout/stderr are required');
  }
  return out;
}

/** @param {string} pathValue @param {string} root @param {string} label */
function regularFile(pathValue, root, label) {
  const absolute = resolve(pathValue);
  assertPathInside(root, absolute, label);
  assertNoSymlinkSegments(root, absolute, label);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  return absolute;
}

/** @param {string} repoRoot */
function sourceEvidence(repoRoot) {
  const baseSha = gitHead(repoRoot);
  const baseTree = String(runGit(repoRoot, ['rev-parse', 'HEAD^{tree}']).stdout || '').trim();
  const dirtyPaths = listDirtyPaths(repoRoot);
  const dirtyItems = describePaths(repoRoot, dirtyPaths);
  const overlayDigest = manifestDigest(dirtyItems);
  const subject = { kind: 'candidate-git-worktree-v1', baseSha, baseTree, dirtyItems, overlayDigest };
  return { ...subject, sourceDigest: `sha256:${hashBytes(canonicalJson(subject))}` };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = existingRealDirectory(resolve(args.repoRoot), 'repository root');
  const runtimeRoot = existingRealDirectory(resolve(args.runtimeRoot), 'runtime root');
  const tscEntrypoint = regularFile(args.tscEntrypoint, repoRoot, 'TypeScript entrypoint');
  const packageJson = regularFile(args.typescriptPackage, repoRoot, 'TypeScript package');
  const outputPath = resolve(args.output);
  const stdoutPath = resolve(args.stdout);
  const stderrPath = resolve(args.stderr);
  for (const pathValue of [outputPath, stdoutPath, stderrPath]) {
    assertPathInside(runtimeRoot, pathValue, 'diagnostic output');
    assertNoSymlinkSegments(runtimeRoot, pathValue, 'diagnostic output');
  }
  if (new Set([outputPath, stdoutPath, stderrPath]).size !== 3) throw new Error('diagnostic outputs must be distinct');

  const before = sourceEvidence(repoRoot);
  const versionRun = spawnSync(process.execPath, [tscEntrypoint, '--version'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { CI: '1', NO_COLOR: '1', PATH: process.env.PATH || '/usr/bin:/bin', TMPDIR: process.env.TMPDIR },
    maxBuffer: 4 * 1024 * 1024,
  });
  const version = String(versionRun.stdout || '').trim();
  if (versionRun.error || versionRun.status !== 0 || !/^Version\s+\d+\.\d+(?:\.\d+)?(?:[-+].*)?$/.test(version)) {
    throw new Error('unable to obtain TypeScript version from entrypoint');
  }
  const invocationArgs = ['--noEmit', '--pretty', 'false'];
  const run = spawnSync(process.execPath, [tscEntrypoint, ...invocationArgs], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { CI: '1', NO_COLOR: '1', PATH: process.env.PATH || '/usr/bin:/bin', TMPDIR: process.env.TMPDIR },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  const stdout = String(run.stdout || '');
  const stderr = String(run.stderr || '');
  writeFileSync(stdoutPath, stdout, { flag: 'wx', mode: 0o600 });
  writeFileSync(stderrPath, stderr, { flag: 'wx', mode: 0o600 });
  const after = sourceEvidence(repoRoot);
  if (before.sourceDigest !== after.sourceDigest || canonicalJson(before) !== canonicalJson(after)) {
    throw new Error('source changed during TypeScript diagnostic capture');
  }
  const metadata = {
    schema: 'neo.code-integrity.typescript-diagnostic-evidence.v1',
    capturedAt: new Date().toISOString(),
    repoRoot,
    runtimeRoot,
    source: before,
    tool: {
      name: 'typescript',
      nodePath: process.execPath,
      nodeSha256: hashBytes(readFileSync(process.execPath)),
      entrypoint: tscEntrypoint,
      entrypointSha256: hashBytes(readFileSync(tscEntrypoint)),
      packageJson,
      packageJsonSha256: hashBytes(readFileSync(packageJson)),
      version,
    },
    invocation: {
      cwd: repoRoot,
      args: invocationArgs,
      argsSha256: hashBytes(JSON.stringify(invocationArgs)),
    },
    result: {
      exitCode: run.status,
      signal: run.signal || null,
      spawnError: null,
      stdout: { path: stdoutPath, sha256: hashBytes(stdout), size: Buffer.byteLength(stdout) },
      stderr: { path: stderrPath, sha256: hashBytes(stderr), size: Buffer.byteLength(stderr) },
    },
    stability: {
      beforeSourceDigest: before.sourceDigest,
      afterSourceDigest: after.sourceDigest,
      stable: true,
    },
  };
  atomicJsonWrite(outputPath, { ...metadata, metadataDigest: hashBytes(canonicalJson(metadata)) });
  process.stdout.write(`${JSON.stringify({ captured: true, typecheckExitCode: run.status, outputPath })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`TypeScript diagnostic capture refused: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
