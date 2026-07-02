#!/usr/bin/env node
// @ts-check
// Controlled Noe100 side-effect drill: perform a low-risk local filesystem write,
// verify it, roll it back, and emit actionEvidence with rollback refs.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildNoeActionEvidence,
  validateNoeActionEvidence,
} from '../src/runtime/NoeActionEvidence.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_DIR = join(ROOT, 'output', 'noe-controlled-side-effect-drill');
const OUT_DIR = resolve(process.env.NOE_CONTROLLED_SIDE_EFFECT_OUT_DIR || DEFAULT_OUT_DIR);
const NOW = Date.now();
const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');

function stamp() {
  return new Date(NOW).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function rel(file) {
  const abs = resolve(file);
  return abs.startsWith(ROOT) ? relative(ROOT, abs).replace(/\\/g, '/') : abs;
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function bytes(text = '') {
  return Buffer.byteLength(String(text), 'utf8');
}

const runDir = join(OUT_DIR, stamp());
const artifactPath = join(runDir, 'side-effect-artifact.txt');
const reportPath = join(runDir, 'report.json');
const actionId = `noe100-side-effect-${randomUUID().slice(0, 12)}`;
const content = [
  'Noe100 controlled side-effect drill',
  `actionId=${actionId}`,
  `createdAt=${new Date(NOW).toISOString()}`,
  'purpose=prove real local side effect plus rollback evidence',
  '',
].join('\n');

if (!apply) {
  console.log(JSON.stringify({
    ok: true,
    applied: false,
    wouldWrite: rel(artifactPath),
    wouldRollback: true,
    note: 'preview only; rerun with --apply to create verified Noe100 evidence',
  }, null, 2));
  process.exit(0);
}

mkdirSync(runDir, { recursive: true, mode: 0o700 });

let writeVerified = false;
let rollbackVerified = false;
let artifactSha256 = '';
let artifactSize = 0;
let rollbackError = '';

try {
  writeFileSync(artifactPath, content, { mode: 0o600, flag: 'wx' });
  const stat = statSync(artifactPath);
  artifactSize = stat.size;
  artifactSha256 = sha256File(artifactPath);
  writeVerified = artifactSize === bytes(content) && artifactSha256 === createHash('sha256').update(content, 'utf8').digest('hex');
} finally {
  try {
    if (existsSync(artifactPath)) rmSync(artifactPath, { force: true });
    rollbackVerified = !existsSync(artifactPath);
  } catch (e) {
    rollbackError = e?.message || String(e);
    rollbackVerified = false;
  }
}

const runtimeReportRef = rel(reportPath);
const rollbackRef = rel(reportPath);
const executorResult = {
  ok: writeVerified && rollbackVerified,
  adapter: 'controlled-local-filesystem-side-effect',
  sideEffectPerformed: writeVerified,
  localFilesystemSideEffect: true,
  publicNetworkSideEffect: false,
  artifactPath: rel(artifactPath),
  artifactBytes: artifactSize,
  artifactSha256,
  rollbackPerformed: true,
  rollbackVerified,
  rollbackError,
};

const actionEvidence = buildNoeActionEvidence({
  act: {
    id: actionId,
    action: 'noe100.controlled_local_file_side_effect',
    title: 'Noe100 controlled local side-effect rollback drill',
    riskLevel: 'low',
  },
  input: {
    action: 'noe100.controlled_local_file_side_effect',
    title: 'Noe100 controlled local side-effect rollback drill',
    riskLevel: 'low',
  },
  permissionResult: {
    decision: 'allow',
    reason: 'owner-authorized controlled local rollback drill; no network publish; no LM Studio model load/unload',
    requiresApproval: false,
    blockedSafety: false,
  },
  contextSufficiency: {
    sufficient: true,
    blockers: [],
    requiredEvidence: ['write_verified', 'rollback_verified', 'action_evidence'],
  },
  dryRunOnly: false,
  executorResult,
  logRef: runtimeReportRef,
  refs: {
    runtimeReport: runtimeReportRef,
    rollback: rollbackRef,
  },
  rollbackRef,
  notes: 'Controlled Noe100 evidence: local temp file was written, hashed, deleted, and absence verified.',
});
const validation = validateNoeActionEvidence(actionEvidence, {
  requireRuntime: true,
  requireRollback: true,
});

const report = {
  schemaVersion: 1,
  ok: writeVerified && rollbackVerified && validation.ok,
  applied: true,
  generatedAt: new Date(NOW).toISOString(),
  actionId,
  sideEffect: {
    kind: 'controlled_local_filesystem_write_delete',
    externalSideEffectPerformed: true,
    localFilesystemSideEffect: true,
    publicNetworkSideEffect: false,
    artifactPath: rel(artifactPath),
    writeVerified,
    artifactBytes: artifactSize,
    artifactSha256,
  },
  rollback: {
    performed: true,
    verified: rollbackVerified,
    artifactAbsent: !existsSync(artifactPath),
    error: rollbackError,
    refs: [rollbackRef],
  },
  actionEvidence,
  validation,
  source: {
    cwd: ROOT,
    outputDir: rel(runDir),
    policy: 'real local filesystem side effect; rollback immediately verified; no network publish; no model load/unload',
  },
};

writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ...report, reportPath: rel(reportPath) }, null, 2));
if (!report.ok) process.exitCode = 1;
