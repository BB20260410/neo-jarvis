#!/usr/bin/env node
// @ts-check

import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateNoeEvalRewardHackingGate } from '../src/eval/NeoEvalRewardHackingGate.js';

const ROOT = resolve(process.cwd());
const ROOT_REAL = realpathSync(ROOT);
const FORBIDDEN_REF_RE = /(^|\/)(?:\.env(?:$|[./_-][^/]*)?|\.npmrc|\.netrc|owner[-_]?token(?:\.txt)?|ownertoken(?:\.txt)?|room-adapters\.json|.*secret.*|.*token.*|.*cookie.*|.*oauth.*|private_holdout)(?:\/|$)|\.\.|^~|^file:|^[a-z][a-z0-9+.-]*:/i;

function normalizeRef(value) {
  return String(value || '').trim().replaceAll('\\', '/').replace(/\/+/g, '/');
}

function assertSafeRef(value, { kind, allowedPrefixes }) {
  const ref = normalizeRef(value);
  if (!ref || isAbsolute(ref) || FORBIDDEN_REF_RE.test(ref)) {
    throw new Error(`${kind}_ref_forbidden`);
  }
  const prefixes = allowedPrefixes.map(normalizeRef);
  if (!prefixes.some((prefix) => ref === prefix.replace(/\/$/, '') || ref.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))) {
    throw new Error(`${kind}_ref_outside_allowed_prefix:${ref}`);
  }
  const full = resolve(ROOT, ref);
  const rel = relative(ROOT, full);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${kind}_ref_escapes_repo`);
  const existing = nearestExistingPath(full);
  const stat = lstatSync(existing);
  if (stat.isSymbolicLink()) throw new Error(`${kind}_ref_symlink_forbidden`);
  const realExisting = realpathSync(existing);
  if (!insideRoot(realExisting)) throw new Error(`${kind}_ref_realpath_escapes_repo`);
  if (existsSync(full)) {
    const fileStat = lstatSync(full);
    if (fileStat.isSymbolicLink()) throw new Error(`${kind}_ref_symlink_forbidden`);
    const realFile = realpathSync(full);
    if (!insideRoot(realFile)) throw new Error(`${kind}_ref_realpath_escapes_repo`);
  }
  return rel.replaceAll('\\', '/');
}

function insideRoot(file) {
  const ref = relative(ROOT_REAL, file).replaceAll('\\', '/');
  return ref === '' || (ref !== '..' && !ref.startsWith('../') && !ref.startsWith('/'));
}

function nearestExistingPath(file) {
  let current = file;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function parseArgs(argv) {
  const args = {
    manifest: 'evals/noe/replay-cases/v2/manifest.json',
    audit: 'output/noe-evidence-flywheel-v2/replay-case-audit.json',
    score: 'output/noe-eval-runs/evidence-flywheel-v2-second-slice/run-replay-collection-001-1781913650839/score.json',
    ledger: 'output/noe-evidence-flywheel-v2/failed-replay-root-cause-ledger.json',
    summary: '',
    out: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--manifest') args.manifest = argv[++i];
    else if (arg.startsWith('--manifest=')) args.manifest = arg.slice('--manifest='.length);
    else if (arg === '--audit') args.audit = argv[++i];
    else if (arg.startsWith('--audit=')) args.audit = arg.slice('--audit='.length);
    else if (arg === '--score') args.score = argv[++i];
    else if (arg.startsWith('--score=')) args.score = arg.slice('--score='.length);
    else if (arg === '--ledger') args.ledger = argv[++i];
    else if (arg.startsWith('--ledger=')) args.ledger = arg.slice('--ledger='.length);
    else if (arg === '--summary') args.summary = argv[++i];
    else if (arg.startsWith('--summary=')) args.summary = arg.slice('--summary='.length);
    else if (arg === '--out') args.out = argv[++i];
    else if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length);
    else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: node scripts/noe-eval-reward-hacking-gate.mjs [--manifest=...] [--audit=...] [--score=...] [--ledger=...] [--summary=...] [--out=...]',
        '',
        'Verifies that a replay bundle/audit cannot be described as passed when the scorer is still failed.',
        'Reads only repo-relative JSON/Markdown evidence refs and rejects secret/private_holdout-like paths before reading.',
      ].join('\n'));
      process.exit(0);
    }
    else {
      throw new Error(`unknown_arg:${arg}`);
    }
  }
  return args;
}

function readJsonRef(ref, kind) {
  const safe = assertSafeRef(ref, {
    kind,
    allowedPrefixes: ['evals/noe/', 'evals/neo/dev/', 'output/noe-evidence-flywheel-v2/', 'output/noe-eval-runs/'],
  });
  if (!existsSync(resolve(ROOT, safe))) throw new Error(`${kind}_ref_missing:${safe}`);
  return { ref: safe, json: JSON.parse(readFileSync(resolve(ROOT, safe), 'utf8')) };
}

function readTextRef(ref, kind) {
  if (!ref) return { ref: '', text: '' };
  const safe = assertSafeRef(ref, {
    kind,
    allowedPrefixes: ['docs/', 'output/noe-evidence-flywheel-v2/', 'output/noe-multimodel/'],
  });
  if (!existsSync(resolve(ROOT, safe))) throw new Error(`${kind}_ref_missing:${safe}`);
  return { ref: safe, text: readFileSync(resolve(ROOT, safe), 'utf8') };
}

function writeOut(ref, report) {
  if (!ref) return;
  const safe = assertSafeRef(ref, {
    kind: 'out',
    allowedPrefixes: ['output/noe-evidence-flywheel-v2/', 'output/noe-eval-runs/'],
  });
  writeFileSync(resolve(ROOT, safe), `${JSON.stringify(report, null, 2)}\n`);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const manifest = readJsonRef(args.manifest, 'manifest');
  const audit = readJsonRef(args.audit, 'audit');
  const score = readJsonRef(args.score, 'score');
  const ledger = readJsonRef(args.ledger, 'ledger');
  const summary = readTextRef(args.summary, 'summary');
  const report = evaluateNoeEvalRewardHackingGate({
    manifest: manifest.json,
    audit: audit.json,
    score: score.json,
    ledger: ledger.json,
    summaryText: summary.text,
    refs: {
      manifest: manifest.ref,
      audit: audit.ref,
      score: score.ref,
      ledger: ledger.ref,
      summary: summary.ref,
    },
  });
  writeOut(args.out, report);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
