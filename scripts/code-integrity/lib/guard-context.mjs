// @ts-check

import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson, hashBytes } from './artifacts.mjs';
import { assertNoSymlinkSegments, assertPathInside } from './policy.mjs';

/**
 * Validate the one-run context emitted by safe-run. This is local workflow
 * provenance, not a remote signature; the outer safe-run receipt must still
 * bind the generated gate receipt after the child exits.
 * @param {{ runtimeRoot: string, repoRoot: string, entrypoint: string }} expected
 */
export function validateGuardContext(expected) {
  const contextInput = process.env.NOE_CODE_INTEGRITY_GUARD_CONTEXT;
  const token = process.env.NOE_CODE_INTEGRITY_GUARD_TOKEN;
  if (process.env.NOE_CODE_INTEGRITY_GUARD !== '1' || !contextInput || !token) {
    throw new Error('sandbox_unproven: missing safe-run guard context');
  }
  const runtimeRoot = resolve(expected.runtimeRoot);
  const contextPath = resolve(contextInput);
  assertPathInside(runtimeRoot, contextPath, 'guard context');
  assertNoSymlinkSegments(runtimeRoot, contextPath, 'guard context');
  const stat = lstatSync(contextPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('sandbox_unproven: guard context is not a regular file');
  const bytes = readFileSync(contextPath);
  const context = JSON.parse(bytes.toString('utf8'));
  if (context.schema !== 'neo.code-integrity.guard-context.v1') throw new Error('sandbox_unproven: unsupported guard context');
  const { metadataDigest, ...metadata } = context;
  if (hashBytes(canonicalJson(metadata)) !== metadataDigest) throw new Error('sandbox_unproven: guard context digest mismatch');
  if (hashBytes(token) !== context.tokenSha256) throw new Error('sandbox_unproven: guard token mismatch');
  if (Date.now() > Date.parse(context.expiresAt) || Date.now() < Date.parse(context.issuedAt) - 5000) {
    throw new Error('sandbox_unproven: guard context expired or not yet valid');
  }
  if (resolve(context.runtimeRoot) !== runtimeRoot || resolve(context.cwd) !== resolve(expected.repoRoot)) {
    throw new Error('sandbox_unproven: guard scope mismatch');
  }
  if (context.argsSha256 !== hashBytes(JSON.stringify(process.argv.slice(1)))) {
    throw new Error('sandbox_unproven: command arguments mismatch');
  }
  const entrypoint = resolve(expected.entrypoint);
  const entry = (context.commandFiles || []).find((item) => item.role === 'entrypoint');
  if (!entry || resolve(entry.path) !== entrypoint || entry.sha256 !== hashBytes(readFileSync(entrypoint))) {
    throw new Error('sandbox_unproven: entrypoint mismatch');
  }
  if (context.network !== 'denied' || context.processSignals !== 'denied') {
    throw new Error('sandbox_unproven: unsafe sandbox policy');
  }
  return {
    schema: context.schema,
    runId: context.runId,
    path: contextPath,
    sha256: hashBytes(bytes),
    profileSha256: context.profileSha256,
    allowedWriteRoots: context.allowedWriteRoots,
    allowedReadRoots: context.allowedReadRoots,
  };
}
