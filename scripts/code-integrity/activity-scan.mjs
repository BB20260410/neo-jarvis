#!/usr/bin/env node
// @ts-check

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertSafeRelativePath,
  atomicJsonWrite,
  canonicalJson,
  describePaths,
  gitHead,
  hashBytes,
  listDirtyPaths,
  manifestDigest,
  resolveWithin,
} from './lib/artifacts.mjs';
import { assertNoSymlinkSegments, assertPathInside, existingRealDirectory } from './lib/policy.mjs';

const SEARCHABLE_TEXT = /\.(?:cjs|css|html?|js|json|jsx|md|mjs|py|sh|swift|toml|ts|tsx|txt|ya?ml)$/i;

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ sourceRoot?: string, output?: string, allowedFiles: string[], responsibilityTerms: Array<{ id: string, term: string }> }} */
  const out = { allowedFiles: [], responsibilityTerms: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${key}`);
    if (key === '--source-root') out.sourceRoot = value;
    else if (key === '--output') out.output = value;
    else if (key === '--allowed-file') out.allowedFiles.push(assertSafeRelativePath(value));
    else if (key === '--responsibility-term') {
      const separator = value.indexOf('=');
      const id = separator > 0 ? value.slice(0, separator) : '';
      const term = separator > 0 ? value.slice(separator + 1) : '';
      if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(id) || term.length < 3 || term.length > 100 || /[\u0000-\u001f\u007f]/.test(term)) {
        throw new Error('--responsibility-term must be <safe-id>=<literal-term>');
      }
      out.responsibilityTerms.push({ id, term });
    }
    else throw new Error(`unknown option: ${key}`);
  }
  if (!out.sourceRoot || !out.output) throw new Error('--source-root and --output are required');
  if (out.allowedFiles.length === 0) throw new Error('at least one --allowed-file is required');
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceRoot = existingRealDirectory(resolve(args.sourceRoot), 'source root');
  const outputPath = resolve(args.output);
  if (process.env.NOE_CODE_INTEGRITY_RUNTIME_ROOT) {
    const runtimeRoot = existingRealDirectory(resolve(process.env.NOE_CODE_INTEGRITY_RUNTIME_ROOT), 'runtime root');
    assertPathInside(runtimeRoot, outputPath, 'activity report');
    assertNoSymlinkSegments(runtimeRoot, outputPath, 'activity report');
  }
  const dirtyPaths = listDirtyPaths(sourceRoot);
  const items = describePaths(sourceRoot, dirtyPaths);
  const dirtySet = new Set(dirtyPaths);
  const blockedAllowedPaths = [...new Set(args.allowedFiles)].filter((item) => dirtySet.has(item)).sort();
  const semanticHits = args.responsibilityTerms.map(({ id, term }) => {
    const needle = term.toLowerCase();
    const paths = dirtyPaths.filter((pathValue) => {
      if (pathValue.toLowerCase().includes(needle)) return true;
      const item = items.find((candidate) => candidate.path === pathValue);
      if (!item || item.kind !== 'file' || item.size > 2 * 1024 * 1024 || !SEARCHABLE_TEXT.test(pathValue)) return false;
      const absolute = resolveWithin(sourceRoot, pathValue);
      if (!existsSync(absolute)) return false;
      const stat = lstatSync(absolute);
      return stat.isFile() && !stat.isSymbolicLink() && readFileSync(absolute, 'utf8').toLowerCase().includes(needle);
    });
    return { id, term, paths };
  }).filter((item) => item.paths.length > 0);
  const semanticConflictPaths = [...new Set(semanticHits.flatMap((item) => item.paths))].sort();
  const metadata = {
    schema: 'neo.code-integrity.activity-scan.v2',
    observedAt: new Date().toISOString(),
    sourceRoot,
    head: gitHead(sourceRoot),
    dirtyCount: dirtyPaths.length,
    dirtyDigest: manifestDigest(items),
    dirtyPaths,
    allowedFiles: [...new Set(args.allowedFiles)].sort(),
    blockedAllowedPaths,
    responsibilityTerms: args.responsibilityTerms,
    semanticHits,
    semanticConflictPaths,
    clearForSlice: blockedAllowedPaths.length === 0 && semanticConflictPaths.length === 0,
  };
  const report = { ...metadata, metadataDigest: hashBytes(canonicalJson(metadata)) };
  atomicJsonWrite(outputPath, report);
  process.stdout.write(`${JSON.stringify({ dirtyCount: report.dirtyCount, clearForSlice: report.clearForSlice, blockedAllowedPaths, semanticConflictPaths })}\n`);
  if (!report.clearForSlice) process.exitCode = 3;
}

try {
  main();
} catch (error) {
  process.stderr.write(`activity scan refused: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
