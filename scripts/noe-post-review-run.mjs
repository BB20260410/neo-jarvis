#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNoeConsensusRef } from '../src/room/NoeConsensusLedger.js';
import { runNoePostReviewRound } from '../src/room/NoePostReviewRunner.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function clean(value) {
  return String(value || '').trim();
}

function defaultRoundId() {
  return `post-review-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
}

export function parsePostReviewRunArgs(argv = []) {
  const out = {
    outDir: 'output/noe-post-review',
    runModels: false,
    costAcknowledged: false,
    codexFallbackOnUnavailable: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i] || '';
    if (arg === '--pack') out.pack = next();
    else if (arg.startsWith('--pack=')) out.pack = arg.slice(7);
    else if (arg === '--round-id') out.roundId = next();
    else if (arg.startsWith('--round-id=')) out.roundId = arg.slice(11);
    else if (arg === '--out-dir') out.outDir = next();
    else if (arg.startsWith('--out-dir=')) out.outDir = arg.slice(10);
    else if (arg === '--run-models') out.runModels = true;
    else if (arg === '--ack-cost') out.costAcknowledged = true;
    else if (arg === '--no-codex-fallback') out.codexFallbackOnUnavailable = false;
  }
  return out;
}

function readPack(ref) {
  const cleanRef = clean(ref);
  if (!cleanRef) throw new Error('pack_ref_required');
  const file = resolveNoeConsensusRef(ROOT, cleanRef);
  if (!existsSync(file)) throw new Error(`pack_ref_missing:${cleanRef}`);
  return {
    pack: JSON.parse(readFileSync(file, 'utf8')),
    packFile: file,
    packRef: relative(ROOT, file),
  };
}

export async function runPostReviewRunCli(argv = process.argv.slice(2), opts = {}) {
  const args = parsePostReviewRunArgs(argv);
  const { pack, packRef } = readPack(args.pack);
  const roundId = clean(args.roundId) || defaultRoundId();
  const result = await runNoePostReviewRound({
    pack,
    packRef,
    roundId,
    outDir: clean(args.outDir) || 'output/noe-post-review',
    runModels: args.runModels,
    costAcknowledged: args.costAcknowledged,
    codexFallbackOnUnavailable: args.codexFallbackOnUnavailable,
  }, { root: opts.root || ROOT, runners: opts.runners, secretResolver: opts.secretResolver });

  const roundRef = join(clean(args.outDir) || 'output/noe-post-review', roundId);
  return {
    ok: result.ok === true || result.status === 'dry_run',
    runModels: args.runModels,
    roundId,
    roundRef,
    manifestRef: result.manifestRef || join(roundRef, 'manifest.json'),
    postReviewRef: result.postReviewRef || null,
    status: result.status,
    postReview: result.postReview || null,
    errors: result.errors || result.postReview?.dynamicQuorum?.errors || [],
  };
}

async function main() {
  try {
    const result = await runPostReviewRunCli();
    console.log(JSON.stringify(result, null, 2));
    if (result.ok !== true) process.exit(1);
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
