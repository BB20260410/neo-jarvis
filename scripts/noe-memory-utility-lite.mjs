#!/usr/bin/env node
// @ts-check

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNoeMemoryUtilityLiteReport } from '../src/memory/NoeMemoryUtilityLite.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DB_PATH = process.env.PANEL_DB_PATH || join(homedir(), '.noe-panel', 'panel.db');
const DEFAULT_OUT_DIR = 'output/noe-memory-utility-lite';
const SENSITIVE_REF_RE = /(^|\/)(?:\.env(?:$|[./_-][^/]*)?|owner[-_]?token(?:\.txt)?|ownertoken(?:\.txt)?|evals\/neo\/private_holdout)(?:\/|$)/i;

function safeRef(value) {
  return String(value ?? '').trim().replaceAll('\\', '/');
}

function decodeRef(value) {
  const text = safeRef(value);
  try {
    return decodeURIComponent(text).replaceAll('\\', '/');
  } catch {
    return text;
  }
}

function rel(file) {
  const abs = resolve(file);
  const ref = relative(ROOT, abs).replaceAll('\\', '/');
  return ref && !ref.startsWith('..') && ref !== '..' && !ref.startsWith('/') ? ref : abs;
}

function guardedPath(ref, label, { mustBeOutput = false, allowOutsideRepo = false } = {}) {
  const text = safeRef(ref);
  const decoded = decodeRef(text);
  if (!text) throw new Error(`${label} is required`);
  if (/^file:/i.test(text) || /^file:/i.test(decoded)) throw new Error(`${label} uses forbidden file scheme: ${ref}`);
  if (SENSITIVE_REF_RE.test(text) || SENSITIVE_REF_RE.test(decoded)) throw new Error(`${label} references forbidden sensitive path: ${ref}`);
  const file = resolve(ROOT, decoded);
  const repoRef = relative(ROOT, file).replaceAll('\\', '/');
  const insideRepo = repoRef && repoRef !== '..' && !repoRef.startsWith('../') && !repoRef.startsWith('/');
  if (!allowOutsideRepo && !insideRepo) throw new Error(`${label} escapes repo: ${ref}`);
  if (mustBeOutput && (!insideRepo || (repoRef !== 'output' && !repoRef.startsWith('output/')))) {
    throw new Error(`${label} must stay under output/: ${ref}`);
  }
  return { file, repoRef: insideRepo ? repoRef : file };
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    dbPath: DEFAULT_DB_PATH,
    outDir: DEFAULT_OUT_DIR,
    projectId: 'noe',
    recentRetrievalLimit: 1000,
    maxCandidates: 50,
    includeColdZeroHit: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db-path') args.dbPath = argv[++i] || args.dbPath;
    else if (arg.startsWith('--db-path=')) args.dbPath = arg.slice('--db-path='.length);
    else if (arg === '--out-dir') args.outDir = argv[++i] || args.outDir;
    else if (arg.startsWith('--out-dir=')) args.outDir = arg.slice('--out-dir='.length);
    else if (arg === '--project-id') args.projectId = argv[++i] || args.projectId;
    else if (arg.startsWith('--project-id=')) args.projectId = arg.slice('--project-id='.length);
    else if (arg === '--recent-retrieval-limit') args.recentRetrievalLimit = Number(argv[++i] || args.recentRetrievalLimit);
    else if (arg.startsWith('--recent-retrieval-limit=')) args.recentRetrievalLimit = Number(arg.slice('--recent-retrieval-limit='.length));
    else if (arg === '--max-candidates') args.maxCandidates = Number(argv[++i] || args.maxCandidates);
    else if (arg.startsWith('--max-candidates=')) args.maxCandidates = Number(arg.slice('--max-candidates='.length));
    else if (arg === '--no-cold-zero-hit') args.includeColdZeroHit = false;
  }
  return args;
}

function renderMarkdown(report = {}, jsonRef = '') {
  const rows = [
    ['Metric', 'Value'],
    ['---', '---:'],
    ['ok', String(report.ok === true)],
    ['memory total', String(report.memory?.total ?? 0)],
    ['memory visible', String(report.memory?.visible ?? 0)],
    ['retrieval rows', String(report.retrieval?.rows ?? 0)],
    ['selected total', String(report.retrieval?.selectedTotal ?? 0)],
    ['inferred dropped total', String(report.retrieval?.inferredDroppedTotal ?? 0)],
    ['candidate items', String(report.candidates?.total ?? 0)],
  ].map((row) => `| ${row.join(' | ')} |`).join('\n');
  const actionRows = [
    ['Action', 'Count'],
    ['---', '---:'],
    ...Object.entries(report.candidates?.byAction || {}).map(([action, count]) => [`\`${action}\``, String(count)]),
  ].map((row) => `| ${row.join(' | ')} |`).join('\n');
  const itemRows = [
    ['Memory', 'Action', 'Score', 'Selected', 'Dropped', 'Reasons'],
    ['---', '---', '---:', '---:', '---:', '---'],
    ...(report.candidates?.items || []).slice(0, 20).map((item) => [
      `\`${item.memoryId}\``,
      `\`${item.action}\``,
      String(item.utilityScore),
      String(item.selectedMentions),
      String(item.inferredDroppedMentions),
      (item.reasons || []).map((reason) => `\`${reason}\``).join('<br>') || '-',
    ]),
  ].map((row) => `| ${row.join(' | ')} |`).join('\n');
  return [
    '# Neo Memory Utility Lite',
    '',
    `Generated: ${report.generatedAt || '-'}`,
    `JSON: \`${jsonRef || '-'}\``,
    '',
    '## Policy',
    '',
    '- Read-only DB aggregation.',
    '- Candidate-only output; no MemoryCore write, memory-v2 write, salience change, private holdout read, model call, live action, or runtime restart.',
    '- Memory body and prompt body text are not emitted.',
    '',
    '## Summary',
    '',
    rows,
    '',
    '## Actions',
    '',
    actionRows,
    '',
    '## Top Candidates',
    '',
    itemRows,
    '',
  ].join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { file: dbPath } = guardedPath(args.dbPath, 'db-path', { allowOutsideRepo: true });
  const { file: outDir } = guardedPath(args.outDir, 'out-dir', { mustBeOutput: true });
  if (!existsSync(dbPath)) throw new Error(`db not found: ${args.dbPath}`);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const db = new Database(dbPath, { readonly: true });
  try {
    const report = buildNoeMemoryUtilityLiteReport({
      db,
      projectId: args.projectId,
      recentRetrievalLimit: args.recentRetrievalLimit,
      maxCandidates: args.maxCandidates,
      includeColdZeroHit: args.includeColdZeroHit,
    });
    const now = Date.now();
    const jsonPath = join(outDir, `memory-utility-lite-${now}.json`);
    const mdPath = join(outDir, `memory-utility-lite-${now}.md`);
    const latestJson = join(outDir, 'latest.json');
    const latestMd = join(outDir, 'latest.md');
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(latestJson, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    const markdown = renderMarkdown(report, rel(jsonPath));
    writeFileSync(mdPath, `${markdown}\n`, { mode: 0o600 });
    writeFileSync(latestMd, `${markdown}\n`, { mode: 0o600 });
    console.log(JSON.stringify({
      ok: report.ok,
      jsonPath: rel(jsonPath),
      mdPath: rel(mdPath),
      candidates: report.candidates?.total || 0,
      byAction: report.candidates?.byAction || {},
    }, null, 2));
    if (!report.ok) process.exitCode = 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
