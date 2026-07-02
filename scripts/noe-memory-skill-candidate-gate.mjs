#!/usr/bin/env node
// @ts-check

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildNoeMemorySkillCandidateGateReport,
} from '../src/candidates/NoeMemorySkillCandidateGate.js';
import {
  loadNoeMemorySkillCandidateInputs,
} from '../src/candidates/NoeMemorySkillCandidateInputs.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_ROOT = realpathSync(ROOT);
const OUTPUT_ROOT = resolve(ROOT, 'output');
const DEFAULT_OUT_DIR = 'output/noe-candidate-gate';
const SENSITIVE_REF_RE = /(^|\/)(?:\.env(?:$|[./_-][^/]*)?|\.npmrc|\.netrc|owner[-_]?token(?:\.txt)?|ownertoken(?:\.txt)?|room-adapters\.json|.*secret.*|.*token.*|.*cookie.*|.*oauth.*|evals\/neo\/private_holdout)(?:\/|$)/i;

function rel(file) {
  const abs = resolve(file);
  const ref = relative(ROOT, abs).replaceAll('\\', '/');
  return ref && !ref.startsWith('..') && ref !== '..' && !ref.startsWith('/') ? ref : abs;
}

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

function insidePath(root, file) {
  const ref = relative(root, file).replaceAll('\\', '/');
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

function guardedRepoPath(ref, label, { mustBeOutput = false, mustExist = false } = {}) {
  const text = safeRef(ref);
  const decoded = decodeRef(text);
  if (!text) throw new Error(`${label} is required`);
  if (/^file:/i.test(text) || /^file:/i.test(decoded)) {
    throw new Error(`${label} uses forbidden file scheme: ${ref}`);
  }
  if (SENSITIVE_REF_RE.test(text) || SENSITIVE_REF_RE.test(decoded)) {
    throw new Error(`${label} references forbidden sensitive path: ${ref}`);
  }
  const file = resolve(ROOT, decoded);
  const repoRef = relative(ROOT, file).replaceAll('\\', '/');
  if (!repoRef || repoRef === '..' || repoRef.startsWith('../') || repoRef.startsWith('/')) {
    throw new Error(`${label} escapes repo: ${ref}`);
  }
  if (mustBeOutput && repoRef !== 'output' && !repoRef.startsWith('output/')) {
    throw new Error(`${label} must stay under output/: ${ref}`);
  }
  if (mustExist && !existsSync(file)) {
    throw new Error(`${label} does not exist: ${ref}`);
  }
  const existingPath = existsSync(file) ? file : nearestExistingPath(file);
  if (existsSync(existingPath) && lstatSync(existingPath).isSymbolicLink()) {
    throw new Error(`${label} uses forbidden symlink path: ${ref}`);
  }
  const realExisting = existsSync(existingPath) ? realpathSync(existingPath) : existingPath;
  if (existsSync(existingPath) && !insidePath(REAL_ROOT, realExisting)) {
    throw new Error(`${label} resolves outside repo: ${ref}`);
  }
  if (mustBeOutput && existsSync(OUTPUT_ROOT)) {
    if (lstatSync(OUTPUT_ROOT).isSymbolicLink()) {
      throw new Error(`${label} output root is a forbidden symlink: ${ref}`);
    }
    const realOutput = realpathSync(OUTPUT_ROOT);
    if (existsSync(existingPath) && existingPath !== ROOT && !insidePath(realOutput, realExisting)) {
      throw new Error(`${label} resolves outside output/: ${ref}`);
    }
  }
  if (existsSync(file)) {
    if (lstatSync(file).isSymbolicLink()) {
      throw new Error(`${label} uses forbidden symlink path: ${ref}`);
    }
    const realFile = realpathSync(file);
    if (!insidePath(REAL_ROOT, realFile)) {
      throw new Error(`${label} resolves outside repo: ${ref}`);
    }
    if (mustBeOutput && existsSync(OUTPUT_ROOT) && !insidePath(realpathSync(OUTPUT_ROOT), realFile)) {
      throw new Error(`${label} resolves outside output/: ${ref}`);
    }
  }
  return { file, repoRef };
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    candidateFile: '',
    outDir: DEFAULT_OUT_DIR,
    requirePassedHoldout: false,
    fromExistingQueues: false,
    memoryPendingRef: 'output/noe-memory-candidates/pending.jsonl',
    skillDraftQueueRef: 'output/noe-proposal-executions/queues/skill-drafts.jsonl',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--candidate-file') out.candidateFile = argv[++i] || '';
    else if (arg.startsWith('--candidate-file=')) out.candidateFile = arg.slice('--candidate-file='.length);
    else if (arg === '--out-dir') out.outDir = argv[++i] || out.outDir;
    else if (arg.startsWith('--out-dir=')) out.outDir = arg.slice('--out-dir='.length);
    else if (arg === '--require-passed-holdout') out.requirePassedHoldout = true;
    else if (arg === '--from-existing-queues') out.fromExistingQueues = true;
    else if (arg === '--memory-pending') out.memoryPendingRef = argv[++i] || out.memoryPendingRef;
    else if (arg.startsWith('--memory-pending=')) out.memoryPendingRef = arg.slice('--memory-pending='.length);
    else if (arg === '--skill-draft-queue') out.skillDraftQueueRef = argv[++i] || out.skillDraftQueueRef;
    else if (arg.startsWith('--skill-draft-queue=')) out.skillDraftQueueRef = arg.slice('--skill-draft-queue='.length);
  }
  return out;
}

function readCandidates(candidateFile) {
  if (!candidateFile) return defaultSmokeCandidates();
  const { file } = guardedRepoPath(candidateFile, 'candidate file', { mustExist: true });
  if (!existsSync(file)) throw new Error(`candidate file not found: ${candidateFile}`);
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.candidates)) return parsed.candidates;
  return [parsed];
}

function defaultSmokeCandidates() {
  return [
    {
      candidateId: 'memory-candidate-smoke-001',
      type: 'memory',
      sourceEpisodeId: 'episode-smoke-001',
      evidenceRefs: ['output/noe-candidate-gate/smoke-memory-evidence.json'],
      tests: [{ name: 'candidate-gate-smoke', ok: true, reportRef: 'output/noe-candidate-gate/smoke-memory-test.json' }],
      rollbackPlan: ['Drop the pending candidate artifact before apply; no MemoryCore row is created by this gate.'],
      privateHoldout: { status: 'not_accessed', reason: 'candidate gate smoke does not read holdout' },
      writesMemoryCore: false,
      directWrites: [],
    },
    {
      candidateId: 'skill-candidate-smoke-001',
      type: 'skill',
      sourceEpisodeId: 'episode-smoke-002',
      evidenceRefs: ['output/noe-candidate-gate/smoke-skill-evidence.json'],
      tests: [{ name: 'candidate-gate-smoke', ok: true, reportRef: 'output/noe-candidate-gate/smoke-skill-test.json' }],
      rollbackPlan: ['Drop the disabled skill draft candidate before apply; no SkillStore write is performed by this gate.'],
      privateHoldout: { status: 'not_accessed', reason: 'candidate gate smoke does not read holdout' },
      writesSkillStore: false,
      hotLoadSkill: false,
      enabled: false,
      directWrites: [],
    },
  ];
}

function renderMarkdown(report = {}, jsonRef = '') {
  const rows = [
    ['Metric', 'Value'],
    ['---', '---:'],
    ['ok', String(report.ok === true)],
    ['candidates', String(report.counts?.candidates ?? 0)],
    ['passed', String(report.counts?.passed ?? 0)],
    ['failed', String(report.counts?.failed ?? 0)],
    ['memory', String(report.counts?.memory ?? 0)],
    ['skill', String(report.counts?.skill ?? 0)],
  ].map((row) => `| ${row.join(' | ')} |`).join('\n');
  const resultRows = [
    ['Candidate', 'Type', 'OK', 'Errors', 'Holdout'],
    ['---', '---', '---:', '---', '---'],
    ...(report.results || []).map((result) => [
      `\`${result.candidateId}\``,
      `\`${result.type}\``,
      String(result.ok),
      result.errors.length ? result.errors.map((error) => `\`${error}\``).join('<br>') : '-',
      `\`${result.summary?.privateHoldoutStatus || ''}\``,
    ]),
  ].map((row) => `| ${row.join(' | ')} |`).join('\n');
  return [
    '# Neo Memory/Skill Candidate Gate',
    '',
    `Generated: ${report.generatedAt || '-'}`,
    `JSON: \`${jsonRef || '-'}\``,
    '',
    '## Policy',
    '',
    '- Candidate-only gate.',
    '- No MemoryCore writes, SkillStore writes, skill hot-load, private holdout reads, live actions, runtime restarts, or memory-v2 writes.',
    '',
    '## Summary',
    '',
    rows,
    '',
    '## Results',
    '',
    resultRows,
    '',
  ].join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  let input = {
    inputRef: args.candidateFile || 'smoke',
    inputErrors: [],
    candidates: readCandidates(args.candidateFile),
  };
  if (!args.candidateFile && args.fromExistingQueues) {
    const loaded = loadNoeMemorySkillCandidateInputs({
      root: ROOT,
      memoryPendingRef: args.memoryPendingRef,
      skillDraftQueueRef: args.skillDraftQueueRef,
    });
    input = {
      inputRef: 'existing_queues',
      inputErrors: loaded.errors,
      candidates: loaded.candidates,
    };
  }
  const report = buildNoeMemorySkillCandidateGateReport(input.candidates, {
    requirePassedHoldout: args.requirePassedHoldout,
    inputRef: input.inputRef,
  });
  if (input.inputErrors.length) {
    report.ok = false;
    report.inputErrors = input.inputErrors;
  }
  const { file: outDir } = guardedRepoPath(args.outDir, 'out-dir', { mustBeOutput: true });
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const now = Date.now();
  const jsonPath = join(outDir, `candidate-gate-${now}.json`);
  const mdPath = join(outDir, `candidate-gate-${now}.md`);
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
    counts: report.counts,
  }, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
