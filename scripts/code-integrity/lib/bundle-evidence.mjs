// @ts-check

import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, hashBytes, manifestDigest } from './artifacts.mjs';
import { assertNoSymlinkSegments, assertPathInside, isPathInside } from './policy.mjs';

const CHANGED_GATE = fileURLToPath(new URL('../changed-gate.mjs', import.meta.url));
const VERIFY_GATE = fileURLToPath(new URL('../verify-gate-receipt.mjs', import.meta.url));
const REQUIRED_VERIFICATION_CHECKS = Object.freeze([
  'receiptPassed',
  'staticGatePassed',
  'blockersEmpty',
  'requiredEvidenceMatches',
  'requestMatches',
  'baseMatches',
  'headMatches',
  'pathSetMatches',
  'inputDigestMatches',
  'commandShapesMatch',
  'commandLogsMatch',
  'safeRunTaskRootExact',
  'safeRunScopeExact',
  'safeRunArgvExact',
  'safeRunEffectivePolicy',
  'safeRunProfileRebuilt',
  'safeRunEntrypoint',
  'safeRunToolHashes',
  'safeRunBoundGate',
  'guardContextBound',
]);

/** @param {string} pathValue @param {string} root @param {string} label */
function readJson(pathValue, root, label) {
  const absolute = resolve(pathValue);
  assertPathInside(root, absolute, label);
  assertNoSymlinkSegments(root, absolute, label);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  const bytes = readFileSync(absolute);
  const value = JSON.parse(bytes.toString('utf8'));
  const { metadataDigest, ...metadata } = value;
  if (hashBytes(canonicalJson(metadata)) !== metadataDigest) throw new Error(`${label} metadata digest mismatch`);
  return { absolute, bytes, value, sha256: hashBytes(bytes), size: bytes.length };
}

/** @param {unknown[]} left @param {unknown[]} right */
function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

/** @param {unknown} value */
function allChecksPass(value) {
  return Boolean(value) && typeof value === 'object' && Object.values(value).length > 0 && Object.values(value).every((item) => item === true);
}

/**
 * Validate the four-way candidate evidence chain. This proves only that the
 * isolated overlay matched a current candidate gate; it deliberately grants
 * no Bauth, integrator identity or replay authority.
 * @param {{
 *   evidenceRoot: string,
 *   gatePath: string,
 *   gateSafeRunPath: string,
 *   verificationPath: string,
 *   verificationSafeRunPath: string,
 *   subjectRepoRoot: string,
 *   checkpoint: Record<string, unknown>,
 *   allowedFiles: string[],
 *   postItems: Array<Record<string, unknown>>
 * }} input
 */
export function validateBundleCandidateEvidence(input) {
  const evidenceRoot = resolve(input.evidenceRoot);
  const subjectRepoRoot = resolve(input.subjectRepoRoot);
  const gateFile = readJson(input.gatePath, evidenceRoot, 'candidate gate');
  const gateSafeFile = readJson(input.gateSafeRunPath, evidenceRoot, 'candidate gate safe-run');
  const verificationFile = readJson(input.verificationPath, evidenceRoot, 'candidate gate verification');
  const verificationSafeFile = readJson(input.verificationSafeRunPath, evidenceRoot, 'candidate verifier safe-run');
  const gate = gateFile.value;
  const gateSafe = gateSafeFile.value;
  const verification = verificationFile.value;
  const verificationSafe = verificationSafeFile.value;
  const allowedFiles = [...input.allowedFiles].sort();
  const postItems = [...input.postItems].sort((a, b) => String(a.path).localeCompare(String(b.path)));
  const subject = {
    checkpointId: input.checkpoint.checkpointId,
    baseSha: input.checkpoint.baseSha,
    baseTree: input.checkpoint.baseTree,
    sourceDigest: input.checkpoint.sourceDigest,
    allowedFiles,
    changedItems: postItems,
  };
  const subjectDigest = `sha256:${hashBytes(canonicalJson(subject))}`;
  if (gate.schema !== 'neo.code-integrity.changed-gate.v3'
    || gate.status !== 'pass'
    || gate.statusScope !== 'isolated-static'
    || gate.staticGate?.passed !== true
    || gate.integration?.ready !== false
    || gate.mode !== 'worktree'
    || gate.baseSha !== input.checkpoint.baseSha
    || gate.headSha !== input.checkpoint.baseSha
    || !same(gate.allowedFiles || [], allowedFiles)
    || !same(gate.changedPaths || [], allowedFiles)
    || !same(gate.changedItems || [], postItems)
    || gate.overlayDigest !== manifestDigest(postItems)
    || (gate.blockers || []).length !== 0
    || (gate.outsideSlice || []).length !== 0) {
    throw new Error('candidate gate does not describe the bundle subject');
  }
  const gateEntrypoint = (gateSafe.commandFiles || []).find((item) => item.role === 'entrypoint');
  const requestArgv = Array.isArray(gate.request?.argv) ? gate.request.argv : [];
  const gateReceiptIndex = requestArgv.indexOf('--receipt');
  const originalGatePath = gateReceiptIndex >= 0 ? resolve(requestArgv[gateReceiptIndex + 1] || '') : '';
  const boundGateByHash = (gateSafe.boundOutputs || []).find((item) => item.sha256 === gateFile.sha256 && item.size === gateFile.size);
  if (gateSafe.schema !== 'neo.code-integrity.safe-run.v2'
    || gateSafe.exitCode !== 0
    || gateSafe.childExitCode !== 0
    || gateSafe.signal !== null
    || gateSafe.spawnError !== null
    || gateSafe.network !== 'denied'
    || gateSafe.processSignals !== 'denied'
    || resolve(gateSafe.cwd || '') !== subjectRepoRoot
    || !isPathInside(resolve(gateSafe.taskRoot || ''), subjectRepoRoot)
    || resolve(gateEntrypoint?.path || '') !== CHANGED_GATE
    || gateEntrypoint?.sha256 !== hashBytes(readFileSync(CHANGED_GATE))
    || !same(gateSafe.args || [], [CHANGED_GATE, ...requestArgv])
    || !boundGateByHash?.valid
    || resolve(boundGateByHash.path || '') !== originalGatePath) {
    throw new Error('candidate gate safe-run is not bound to the gate');
  }
  if (verification.schema !== 'neo.code-integrity.gate-receipt-verification.v1'
    || verification.state !== 'current'
    || !allChecksPass(verification.checks)
    || REQUIRED_VERIFICATION_CHECKS.some((id) => verification.checks?.[id] !== true)
    || resolve(verification.targetReceipt?.path || '') !== originalGatePath
    || verification.targetReceipt?.sha256 !== gateFile.sha256
    || verification.safeRunReceipt?.sha256 !== gateSafeFile.sha256) {
    throw new Error('candidate gate verification is not current for the gate chain');
  }
  const verifierEntrypoint = (verificationSafe.commandFiles || []).find((item) => item.role === 'entrypoint');
  const boundVerification = (verificationSafe.boundOutputs || []).find((item) => item.sha256 === verificationFile.sha256 && item.size === verificationFile.size);
  const verifierArgs = verificationSafe.args || [];
  const option = (name) => {
    const index = verifierArgs.indexOf(name);
    return index >= 0 ? verifierArgs[index + 1] : null;
  };
  if (verificationSafe.schema !== 'neo.code-integrity.safe-run.v2'
    || verificationSafe.exitCode !== 0
    || verificationSafe.childExitCode !== 0
    || verificationSafe.signal !== null
    || verificationSafe.spawnError !== null
    || verificationSafe.network !== 'denied'
    || verificationSafe.processSignals !== 'denied'
    || resolve(verificationSafe.cwd || '') !== subjectRepoRoot
    || !isPathInside(resolve(verificationSafe.taskRoot || ''), subjectRepoRoot)
    || resolve(verifierEntrypoint?.path || '') !== VERIFY_GATE
    || verifierEntrypoint?.sha256 !== hashBytes(readFileSync(VERIFY_GATE))
    || resolve(option('--receipt') || '') !== resolve(verification.targetReceipt.path)
    || resolve(option('--safe-run-receipt') || '') !== resolve(verification.safeRunReceipt.path)
    || resolve(boundVerification?.path || '') !== resolve(option('--output') || '')
    || !boundVerification?.valid) {
    throw new Error('candidate verifier safe-run is not bound to the verification result');
  }
  return {
    schema: 'neo.code-integrity.bundle-candidate-evidence.v1',
    scope: 'candidate_overlay_only',
    assurance: 'candidate_current',
    productionReady: false,
    authoritativeReplay: false,
    subjectDigest,
    files: {
      gate: { path: gateFile.absolute, sha256: gateFile.sha256, size: gateFile.size },
      gateSafeRun: { path: gateSafeFile.absolute, sha256: gateSafeFile.sha256, size: gateSafeFile.size },
      verification: { path: verificationFile.absolute, sha256: verificationFile.sha256, size: verificationFile.size },
      verificationSafeRun: { path: verificationSafeFile.absolute, sha256: verificationSafeFile.sha256, size: verificationSafeFile.size },
    },
  };
}
