#!/usr/bin/env node
// @ts-check

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildNoeEvolutionScorecardDryRunReport,
  NOE_EVOLUTION_SCORECARD_DRY_RUN_KIND,
  NOE_EVOLUTION_SCORECARD_DRY_RUN_VALIDATOR_VERSION,
} from '../src/candidates/NoeEvolutionScorecardDryRun.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_ROOT = realpathSync(ROOT);
const OUTPUT_ROOT = resolve(ROOT, 'output');
const DEFAULT_OUT_DIR = 'output/noe-evolution-scorecard-dry-run';
const SENSITIVE_REF_RE = /(^|\/)(?:\.env(?:$|[./_-][^/]*)?|\.npmrc|\.netrc|owner[-_]?token(?:\.txt)?|ownertoken(?:\.txt)?|room-adapters\.json|.*secret.*|.*token.*|.*cookie.*|.*oauth.*|evals\/neo\/private_holdout)(?:\/|$)/i;
const FORBIDDEN_INPUT_RE = /(?:NoePatchApply|NoePatchTransaction|NoeSelfEvolution|NoeConsensus|NoeExecutionAuthority|noe-patch-apply|noe-patch-rollback|noe-self-improve|consensus|holdout|evaluator|security|permission|src\/eval|src\/loop|src\/webhook|package\.json|package-lock\.json|\.noe-panel|archive\.jsonl|memoryV2|memory-v2|51735|51835|panel-runtime|runtime-restart|restart-panel)/i;
const UNSAFE_PATH_CHARS_RE = /[\s"'`$;|&<>*?[\]{}()]/;

function safeRef(value) {
  return String(value ?? '').replaceAll('\\', '/');
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
  return ref && ref !== '..' && !ref.startsWith('../') && !ref.startsWith('/') ? ref : abs;
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
  if (/^file:/i.test(text) || /^file:/i.test(decoded) || /^https?:/i.test(text) || /^https?:/i.test(decoded)) throw new Error(`${label} uses forbidden scheme`);
  if (SENSITIVE_REF_RE.test(text) || SENSITIVE_REF_RE.test(decoded)) throw new Error(`${label} references forbidden sensitive path`);
  if (
    text.startsWith('~')
    || decoded.startsWith('~')
    || UNSAFE_PATH_CHARS_RE.test(text)
    || UNSAFE_PATH_CHARS_RE.test(decoded)
    || FORBIDDEN_INPUT_RE.test(text)
    || FORBIDDEN_INPUT_RE.test(decoded)
  ) {
    throw new Error(`${label} references forbidden dry-run path`);
  }
  const file = resolve(ROOT, decoded);
  const repoRef = relative(ROOT, file).replaceAll('\\', '/');
  if (!repoRef || repoRef === '..' || repoRef.startsWith('../') || repoRef.startsWith('/')) throw new Error(`${label} escapes repo`);
  if (mustBeOutput && repoRef !== 'output' && !repoRef.startsWith('output/')) throw new Error(`${label} must stay under output/`);
  if (mustExist && !existsSync(file)) throw new Error(`${label} does not exist`);
  const existing = existsSync(file) ? file : nearestExistingPath(file);
  const stat = lstatSync(existing);
  if (stat.isSymbolicLink()) throw new Error(`${label} uses forbidden symlink path`);
  const realExisting = realpathSync(existing);
  if (!insidePath(REAL_ROOT, realExisting)) throw new Error(`${label} resolves outside repo`);
  if (mustBeOutput && existsSync(OUTPUT_ROOT)) {
    const outputStat = lstatSync(OUTPUT_ROOT);
    if (outputStat.isSymbolicLink()) throw new Error(`${label} output root is a forbidden symlink`);
    const realOutput = realpathSync(OUTPUT_ROOT);
    if (existing !== ROOT && !insidePath(realOutput, realExisting)) throw new Error(`${label} resolves outside output/`);
  }
  if (existsSync(file)) {
    const realFile = realpathSync(file);
    if (!insidePath(REAL_ROOT, realFile)) throw new Error(`${label} resolves outside repo`);
    if (mustBeOutput) {
      const realOutput = existsSync(OUTPUT_ROOT) ? realpathSync(OUTPUT_ROOT) : OUTPUT_ROOT;
      if (!insidePath(realOutput, realFile)) throw new Error(`${label} resolves outside output/`);
    }
  }
  return { file, repoRef };
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = { scorecardFile: '', outDir: DEFAULT_OUT_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--scorecard-file') out.scorecardFile = argv[++index] || '';
    else if (arg.startsWith('--scorecard-file=')) out.scorecardFile = arg.slice('--scorecard-file='.length);
    else if (arg === '--out-dir') out.outDir = argv[++index] || out.outDir;
    else if (arg.startsWith('--out-dir=')) out.outDir = arg.slice('--out-dir='.length);
    else throw new Error('unknown argument');
  }
  return out;
}

function objective(score, weight, threshold, evidenceRef) {
  return { score, weight, threshold, evidenceRef, status: score >= threshold ? 'passed' : 'failed' };
}

function defaultSmokeRecord() {
  return {
    kind: NOE_EVOLUTION_SCORECARD_DRY_RUN_KIND,
    schemaVersion: 1,
    id: 'scorecard-dry-run-smoke-001',
    createdAt: '2026-06-19T00:00:00.000Z',
    parentId: 'score-parent-smoke',
    childId: 'score-child-smoke',
    generation: 1,
    candidateRef: 'output/noe-candidate-patches/dry-run/latest.json',
    archiveReportRef: 'output/noe-evolution-archive-dry-run/latest.json',
    scorecardRef: 'output/noe-evolution-scorecard-dry-run/latest.json',
    holdoutRef: 'private_holdout:not_accessed',
    objectives: {
      capability: objective(0.82, 0.35, 0.7, 'output/noe-evolution-scorecard-dry-run/capability.json'),
      regression: objective(1, 0.25, 0.95, 'output/noe-evolution-scorecard-dry-run/regression.json'),
      safety: objective(1, 0.25, 1, 'output/noe-evolution-scorecard-dry-run/safety.json'),
      costLatency: objective(0.9, 0.1, 0.75, 'output/noe-evolution-scorecard-dry-run/cost-latency.json'),
      rewardHackingRisk: {
        score: 0,
        weight: 0.05,
        maxAllowed: 0.1,
        evidenceRef: 'output/noe-evolution-scorecard-dry-run/reward-hacking.json',
        status: 'passed',
      },
    },
    aggregate: {
      overall: 0.927,
      threshold: 0.75,
      weightsSum: 1,
      passed: true,
      decision: 'review_candidate',
      formulaVersion: 'agentbreeder-v1',
    },
    objectiveDirections: {
      capability: 'max',
      regression: 'max',
      safety: 'max',
      costLatency: 'max',
      rewardHackingRisk: 'min',
    },
    pareto: {
      rank: 0,
      frontIndex: 0,
      dominatedBy: [],
      dominates: [],
      selectedForReview: true,
    },
    cost: {
      estimatedUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: 0,
      paidApiUsed: false,
      modelCalls: false,
      quotaRisk: 'none',
    },
    result: {
      verdict: 'dry_run_scored',
      applied: false,
      runtimeVerified: false,
      memoryWritten: false,
      committed: false,
      pushed: false,
    },
    policy: {
      dryRunOnly: true,
      metadataOnly: true,
      noEvaluatorChange: true,
      noPrivateHoldoutRead: true,
      noSecretRead: true,
      noLive51835: true,
      noPatchApply: true,
      noMemoryV2Write: true,
      noCommit: true,
      noPush: true,
      noPackageScriptChange: true,
    },
    validator: {
      validatorVersion: NOE_EVOLUTION_SCORECARD_DRY_RUN_VALIDATOR_VERSION,
      reportRef: 'output/noe-evolution-scorecard-dry-run/latest.json',
      warnings: [],
      blockers: [],
      secretValuesReturned: false,
      checks: {
        archiveDryRun: { ok: true, reportRef: 'output/noe-evolution-archive-dry-run/latest.json' },
        scoreSchema: { ok: true, reportRef: 'output/noe-evolution-scorecard-dry-run/schema.json' },
        secretScan: { ok: true, reportRef: 'output/noe-evolution-scorecard-dry-run/redaction-scan.json' },
        rewardHacking: { ok: true, reportRef: 'output/noe-evolution-scorecard-dry-run/reward-hacking.json' },
        regression: { ok: true, reportRef: 'output/noe-evolution-scorecard-dry-run/regression.json' },
        safety: { ok: true, reportRef: 'output/noe-evolution-scorecard-dry-run/safety.json' },
        cost: { ok: true, reportRef: 'output/noe-evolution-scorecard-dry-run/cost.json' },
      },
    },
  };
}

function readRecords(scorecardFile) {
  if (!scorecardFile) return [defaultSmokeRecord()];
  const { file } = guardedRepoPath(scorecardFile, 'scorecard file', { mustExist: true });
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.records)) return parsed.records;
  return [parsed];
}

function renderMarkdown(report = {}, jsonRef = '') {
  const summary = [
    ['Metric', 'Value'],
    ['---', '---:'],
    ['ok', String(report.ok === true)],
    ['records', String(report.counts?.records ?? 0)],
    ['passed', String(report.counts?.passed ?? 0)],
    ['failed', String(report.counts?.failed ?? 0)],
  ].map((row) => `| ${row.join(' | ')} |`).join('\n');
  const results = [
    ['Record', 'OK', 'Overall', 'Decision', 'Errors'],
    ['---', '---:', '---:', '---', '---'],
    ...(report.results || []).map((result) => [
      `\`${result.id || ''}\``,
      String(result.ok),
      String(result.summary?.overall ?? ''),
      `\`${result.summary?.decision || ''}\``,
      result.errors.length ? result.errors.map((error) => `\`${error}\``).join('<br>') : '-',
    ]),
  ].map((row) => `| ${row.join(' | ')} |`).join('\n');
  return [
    '# Neo Evolution Scorecard Dry-Run',
    '',
    `Generated: ${report.generatedAt || '-'}`,
    `JSON: \`${jsonRef || '-'}\``,
    '',
    '## Policy',
    '',
    '- Dry-run scorecard metadata only; this CLI does not run evaluators or read holdout data.',
    '- Prompt, diff, patch, command output, stdout/stderr, and secret bodies are forbidden.',
    '- No patch apply, live 51835, memory-v2 write, private holdout read, secret read, commit, push, package script, evaluator, security, or permission change is authorized.',
    '',
    '## Summary',
    '',
    summary,
    '',
    '## Results',
    '',
    results,
    '',
  ].join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const records = readRecords(args.scorecardFile);
  const report = buildNoeEvolutionScorecardDryRunReport(records, { inputRef: args.scorecardFile || 'smoke' });
  const { file: outDir } = guardedRepoPath(args.outDir, 'out-dir', { mustBeOutput: true });
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const now = Date.now();
  const jsonPath = join(outDir, `evolution-scorecard-dry-run-${now}.json`);
  const mdPath = join(outDir, `evolution-scorecard-dry-run-${now}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(outDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const markdown = renderMarkdown(report, rel(jsonPath));
  writeFileSync(mdPath, `${markdown}\n`, { mode: 0o600 });
  writeFileSync(join(outDir, 'latest.md'), `${markdown}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ok: report.ok, jsonPath: rel(jsonPath), mdPath: rel(mdPath), counts: report.counts }, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
