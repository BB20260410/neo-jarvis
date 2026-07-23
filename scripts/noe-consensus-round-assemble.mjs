#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildNoeConsensusLedgerFromRawOutputs } from '../src/room/NoeConsensusRound.js';
import {
  validateNoeConsensusLedgerArtifact,
  writeNoeConsensusLedgerFile,
} from '../src/room/NoeConsensusLedger.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN_REF_PATTERN = /(^|[/\\])(\.env[^/\\]*|room-adapters\.json|private_holdout|owner[-_]?token)([/\\]|$)|\.\.|^~|^file:|^[a-z][a-z0-9+.-]*:/i;

function normalizeRef(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/\/+/g, '/');
}

export function assertSafeAssembleCliRef(value, { kind, allowedPrefixes }) {
  const ref = normalizeRef(value);
  if (!ref || ref.startsWith('/') || FORBIDDEN_REF_PATTERN.test(ref)) {
    throw new Error(`${kind}_ref_forbidden`);
  }
  const prefixes = allowedPrefixes.map(normalizeRef);
  if (!prefixes.some((prefix) => ref === prefix.replace(/\/$/, '') || ref.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))) {
    throw new Error(`${kind}_ref_outside_allowed_prefix`);
  }
  return ref;
}

function parseArgs(argv) {
  const out = { goal: '', evidenceRef: '', participants: [], outDir: 'output/noe-multimodel', roundId: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--goal') out.goal = argv[++i];
    else if (arg.startsWith('--goal=')) out.goal = arg.slice('--goal='.length);
    else if (arg === '--evidence') out.evidenceRef = argv[++i];
    else if (arg.startsWith('--evidence=')) out.evidenceRef = arg.slice('--evidence='.length);
    else if (arg === '--round-id') out.roundId = argv[++i];
    else if (arg.startsWith('--round-id=')) out.roundId = arg.slice('--round-id='.length);
    else if (arg === '--out-dir') out.outDir = argv[++i];
    else if (arg.startsWith('--out-dir=')) out.outDir = arg.slice('--out-dir='.length);
    else if (arg === '--raw') out.participants.push(parseRawArg(argv[++i]));
    else if (arg.startsWith('--raw=')) out.participants.push(parseRawArg(arg.slice('--raw='.length)));
  }
  return out;
}

function parseRawArg(value) {
  const text = String(value || '');
  const idx = text.indexOf('=');
  if (idx <= 0) throw new Error(`invalid --raw value: ${text}`);
  return { model: text.slice(0, idx), rawOutputFile: text.slice(idx + 1) };
}

function resolveRepoFile(ref, { kind, allowedPrefixes }) {
  const text = assertSafeAssembleCliRef(ref, { kind, allowedPrefixes });
  if (!text || isAbsolute(text)) throw new Error(`invalid repo-relative file: ${text}`);
  const full = resolve(ROOT, text);
  const rel = relative(ROOT, full);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`file escapes repo: ${text}`);
  return full;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.goal) throw new Error('--goal required');
  if (!args.evidenceRef) throw new Error('--evidence required');
  if (args.participants.length === 0) throw new Error('at least one --raw model=file required');
  const evidenceRef = assertSafeAssembleCliRef(args.evidenceRef, {
    kind: 'evidence',
    allowedPrefixes: ['docs', '.planning', 'output'],
  });
  const outDir = assertSafeAssembleCliRef(args.outDir, {
    kind: 'out_dir',
    allowedPrefixes: ['output/noe-multimodel'],
  });

  const participants = args.participants.map((participant) => {
    const rawOutputRef = assertSafeAssembleCliRef(participant.rawOutputFile, {
      kind: `raw_output:${participant.model || 'unknown'}`,
      allowedPrefixes: ['output/noe-multimodel'],
    });
    const full = resolveRepoFile(rawOutputRef, {
      kind: `raw_output:${participant.model || 'unknown'}`,
      allowedPrefixes: ['output/noe-multimodel'],
    });
    if (!existsSync(full)) throw new Error(`raw output file not found: ${rawOutputRef}`);
    return { ...participant, rawOutputFile: full, rawOutputRef };
  });

  const { ledger, parseErrors } = buildNoeConsensusLedgerFromRawOutputs({
    roundId: args.roundId,
    goal: args.goal,
    evidenceRef,
    participants,
    implementation: {
      writer: 'codex',
      authorizationRequired: true,
      runtimeVerificationRequired: true,
      rollbackRequired: true,
      memoryWritebackAckRequired: true,
    },
  });
  if (parseErrors.length) ledger.notes = `parseErrors=${parseErrors.join(',')}`;
  const file = writeNoeConsensusLedgerFile(ledger, { root: ROOT, outDir });
  const result = validateNoeConsensusLedgerArtifact(ledger, {
    root: ROOT,
    requireEvidenceFile: true,
    requireRawOutputFiles: true,
  });

  console.log(JSON.stringify({
    ok: result.ok,
    ledger: relative(ROOT, file),
    gate: ledger.gate,
    parseErrors,
    validation: result,
  }, null, 2));
  if (!result.ok) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
