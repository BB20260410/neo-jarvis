#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildNoeConsensusLedger,
  readNoeConsensusLedgerFile,
  sha256Text,
  validateNoeConsensusLedgerArtifact,
} from '../src/room/NoeConsensusLedger.js';
import { validateNoeConsensusLedger } from '../src/room/NoeConsensusGate.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = {
    ledgers: [],
    requireArtifacts: false,
    requireEvidence: false,
    requirePassed: false,
    sample: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--ledger') out.ledgers.push(argv[++i]);
    else if (arg.startsWith('--ledger=')) out.ledgers.push(arg.slice('--ledger='.length));
    else if (arg === '--require-artifacts') out.requireArtifacts = true;
    else if (arg === '--require-evidence') out.requireEvidence = true;
    else if (arg === '--require-passed') out.requirePassed = true;
    else if (arg === '--sample') out.sample = true;
  }
  return out;
}

function findLedgerFiles(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findLedgerFiles(full));
    else if (entry.isFile() && entry.name === 'ledger.json') found.push(full);
  }
  return found;
}

function sampleLedger() {
  const evidenceRef = 'output/noe-multimodel/sample/brief.md';
  const raw = {
    codex: 'sample codex vote',
    claude: 'sample claude vote',
    gemini: 'sample gemini vote',
    m3: 'sample m3 vote',
  };
  return buildNoeConsensusLedger({
    roundId: 'sample-noe-consensus',
    goal: 'Noe four-model self-evolution sample consensus',
    evidenceRef,
    votes: [
      {
        model: 'codex',
        decision: 'approve_with_changes',
        authority: 'writer_integrator',
        canWrite: true,
        rawOutputSha256: sha256Text(raw.codex),
        evidenceRef,
      },
      {
        model: 'claude',
        decision: 'approve_with_changes',
        authority: 'readonly_source_reviewer',
        canWrite: false,
        firstClass: true,
        rawOutputSha256: sha256Text(raw.claude),
        evidenceRef,
      },
      {
        model: 'gemini',
        decision: 'approve_with_changes',
        authority: 'advisory',
        canWrite: false,
        rawOutputSha256: sha256Text(raw.gemini),
        evidenceRef,
      },
      {
        model: 'm3',
        decision: 'approve_with_changes',
        authority: 'suggestion_only',
        canWrite: false,
        rawOutputSha256: sha256Text(raw.m3),
        evidenceRef,
      },
    ],
    implementation: {
      writer: 'codex',
      authorizationRequired: true,
      runtimeVerificationRequired: true,
      rollbackRequired: true,
      memoryWritebackAckRequired: true,
    },
  }, { createdAt: '2026-06-07T00:00:00.000Z' });
}

function verifyLedger(name, ledger, opts) {
  const result = validateNoeConsensusLedgerArtifact(ledger, {
    root: ROOT,
    requireEvidenceFile: opts.requireEvidence,
    requireRawOutputFiles: opts.requireArtifacts,
  });
  const gate = validateNoeConsensusLedger(ledger);
  const gateErrors = new Set(gate.errors || []);
  const artifactErrors = (result.errors || []).filter((error) => !gateErrors.has(error));
  const artifactOk = artifactErrors.length === 0;
  const status = result.ok ? 'PASS' : artifactOk ? 'BLOCKED' : 'FAIL';
  console.log(`${status} ${name} approvals=${result.consensus?.approvedCount ?? 0}/${result.consensus?.threshold ?? 3}`);
  if (!result.ok) {
    const diagnostic = JSON.stringify({
      name,
      gateOk: gate.ok,
      artifactOk,
      errors: result.errors,
      artifactErrors,
      warnings: result.warnings,
    }, null, 2);
    if (status === 'BLOCKED' && !opts.requirePassed) console.log(diagnostic);
    else console.error(diagnostic);
  }
  return { ...result, artifactOk, gateOk: gate.ok, blocked: artifactOk && !result.ok };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const ledgerFiles = args.ledgers.length
    ? args.ledgers.map((file) => resolve(ROOT, file))
    : findLedgerFiles(join(ROOT, 'output', 'noe-multimodel'));

  const results = [];
  if (args.sample || ledgerFiles.length === 0) {
    results.push(verifyLedger('sample-ledger', sampleLedger(), {
      requireEvidence: false,
      requireArtifacts: false,
    }));
  }

  for (const file of ledgerFiles) {
    const ledger = readNoeConsensusLedgerFile(file);
    results.push(verifyLedger(relative(ROOT, file), ledger, args));
  }

  const failed = results.filter((result) => !result.artifactOk || (args.requirePassed && !result.ok));
  const blocked = results.filter((result) => result.blocked);
  const payload = {
    ok: failed.length === 0,
    checked: results.length,
    blocked: blocked.length,
    failed: failed.length,
    mode: args.requirePassed
      ? 'ledger_files_require_passed'
      : ledgerFiles.length === 0 ? 'sample_only' : 'ledger_files',
  };
  console.log(JSON.stringify(payload, null, 2));
  if (failed.length) process.exit(1);
}

main();
