#!/usr/bin/env node
// @ts-check

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildNoeEvolutionArchiveDryRunReport,
  NOE_EVOLUTION_ARCHIVE_DRY_RUN_KIND,
  NOE_EVOLUTION_ARCHIVE_DRY_RUN_VALIDATOR_VERSION,
  sha256Text,
} from '../src/candidates/NoeEvolutionArchiveDryRun.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_ROOT = realpathSync(ROOT);
const OUTPUT_ROOT = resolve(ROOT, 'output');
const DEFAULT_OUT_DIR = 'output/noe-evolution-archive-dry-run';
const SENSITIVE_REF_RE = /(^|\/)(?:\.env(?:$|[./_-][^/]*)?|\.npmrc|\.netrc|owner[-_]?token(?:\.txt)?|ownertoken(?:\.txt)?|room-adapters\.json|.*secret.*|.*token.*|.*cookie.*|.*oauth.*|evals\/neo\/private_holdout)(?:\/|$)/i;
const FORBIDDEN_INPUT_RE = /(?:NoePatchApply|NoePatchTransaction|NoeSelfEvolution|NoeConsensus|NoeExecutionAuthority|noe-patch-apply|noe-self-improve|consensus|holdout|evaluator|security|permission|src\/loop|src\/webhook|package\.json|\.noe-panel|archive\.jsonl|memoryV2|memory-v2|51735|51835|panel-runtime|runtime-restart|restart-panel)/i;
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
  if (/^file:/i.test(text) || /^file:/i.test(decoded) || /^https?:/i.test(text) || /^https?:/i.test(decoded)) {
    throw new Error(`${label} uses forbidden scheme`);
  }
  if (SENSITIVE_REF_RE.test(text) || SENSITIVE_REF_RE.test(decoded)) {
    throw new Error(`${label} references forbidden sensitive path`);
  }
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
  if (!repoRef || repoRef === '..' || repoRef.startsWith('../') || repoRef.startsWith('/')) {
    throw new Error(`${label} escapes repo`);
  }
  if (mustBeOutput && repoRef !== 'output' && !repoRef.startsWith('output/')) {
    throw new Error(`${label} must stay under output/`);
  }
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
    if (existing !== ROOT && !insidePath(realOutput, realExisting)) {
      throw new Error(`${label} resolves outside output/`);
    }
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
  const out = {
    artifactFile: '',
    outDir: DEFAULT_OUT_DIR,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--artifact-file') out.artifactFile = argv[++index] || '';
    else if (arg.startsWith('--artifact-file=')) out.artifactFile = arg.slice('--artifact-file='.length);
    else if (arg === '--out-dir') out.outDir = argv[++index] || out.outDir;
    else if (arg.startsWith('--out-dir=')) out.outDir = arg.slice('--out-dir='.length);
    else throw new Error('unknown argument');
  }
  return out;
}

function defaultSmokeRecord() {
  const promptSummary = 'dry-run archive prompt ref only';
  const diffSummary = 'metadata-only diff ref';
  const commandSummary = 'vitest output ref';
  return {
    kind: NOE_EVOLUTION_ARCHIVE_DRY_RUN_KIND,
    schemaVersion: 1,
    id: 'evolution-archive-dry-run-smoke-001',
    createdAt: '2026-06-19T00:00:00.000Z',
    parentId: 'dgm-parent-smoke',
    childId: 'dgm-child-smoke',
    generation: 1,
    candidateRef: 'output/noe-candidate-patches/dry-run/latest.json',
    parentArchiveRef: 'output/noe-evolution-archive-dry-run/parent.jsonl',
    lineage: {
      parentId: 'dgm-parent-smoke',
      childId: 'dgm-child-smoke',
      generation: 1,
    },
    refs: {
      patchArtifactRef: 'output/noe-candidate-patches/dry-run/latest.json',
      diffRef: 'output/noe-evolution-archive-dry-run/smoke-diff.json',
      promptRef: 'output/noe-evolution-archive-dry-run/smoke-prompt-redacted.json',
      evalInputRef: 'output/noe-evolution-archive-dry-run/smoke-eval-input.json',
      commandOutputRef: 'output/noe-evolution-archive-dry-run/smoke-command-output.json',
      scoreRef: 'output/noe-evolution-archive-dry-run/smoke-score.json',
      rollbackRef: 'output/noe-evolution-archive-dry-run/smoke-rollback.json',
      holdoutRef: 'private_holdout:not_accessed',
      benchmarkRef: 'output/noe-evolution-archive-dry-run/smoke-benchmark.json',
      reportRef: 'output/noe-evolution-archive-dry-run/latest.json',
    },
    hashes: {
      diffSha256: sha256Text(diffSummary),
      promptSha256: sha256Text(promptSummary),
      evalInputSha256: sha256Text('dev/regression metadata refs only'),
      commandOutputSha256: sha256Text(commandSummary),
    },
    score: {
      overall: 0.82,
      capability: 0.8,
      regression: 1,
      safety: 1,
      cost: 1,
      rewardHackingRisk: 0,
    },
    cost: {
      estimatedUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      paidApiUsed: false,
      quotaRisk: 'none',
    },
    result: {
      verdict: 'dry_run_passed',
      failureReason: '',
      applied: false,
      runtimeVerified: false,
      memoryWritten: false,
      committed: false,
      pushed: false,
    },
    safety: {
      dryRunOnly: true,
      noPatchApply: true,
      noExecutorRegistration: true,
      noLive51835: true,
      noMemoryV2Write: true,
      noPrivateHoldoutRead: true,
      noSecretRead: true,
      noCommit: true,
      noPush: true,
      noPackageScriptChange: true,
      noEvaluatorChange: true,
      noSecurityOrPermissionChange: true,
    },
    validator: {
      validatorVersion: NOE_EVOLUTION_ARCHIVE_DRY_RUN_VALIDATOR_VERSION,
      reportRef: 'output/noe-evolution-archive-dry-run/latest.json',
      warnings: [],
      blockers: [],
      secretValuesReturned: false,
      checks: {
        candidatePatchGate: { ok: true, reportRef: 'output/noe-candidate-patches/dry-run/latest.json' },
        archiveSchema: { ok: true, reportRef: 'output/noe-evolution-archive-dry-run/smoke-schema.json' },
        secretScan: { ok: true, reportRef: 'output/noe-evolution-archive-dry-run/smoke-redaction-scan.json' },
        sast: { ok: true, reportRef: 'output/noe-evolution-archive-dry-run/smoke-sast.json' },
        sca: { ok: true, reportRef: 'output/noe-evolution-archive-dry-run/smoke-sca.json' },
        rollbackDryRun: { ok: true, reportRef: 'output/noe-evolution-archive-dry-run/smoke-rollback-dry-run.json' },
        rewardHacking: { ok: true, reportRef: 'output/noe-evolution-archive-dry-run/smoke-reward-hacking.json' },
      },
    },
  };
}

function readRecords(artifactFile) {
  if (!artifactFile) return [defaultSmokeRecord()];
  const { file } = guardedRepoPath(artifactFile, 'artifact file', { mustExist: true });
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.records)) return parsed.records;
  return [parsed];
}

function renderMarkdown(report = {}, jsonRef = '') {
  const rows = [
    ['Metric', 'Value'],
    ['---', '---:'],
    ['ok', String(report.ok === true)],
    ['records', String(report.counts?.records ?? 0)],
    ['passed', String(report.counts?.passed ?? 0)],
    ['failed', String(report.counts?.failed ?? 0)],
  ].map((row) => `| ${row.join(' | ')} |`).join('\n');
  const resultRows = [
    ['Record', 'OK', 'Verdict', 'Errors'],
    ['---', '---:', '---', '---'],
    ...(report.results || []).map((result) => [
      `\`${result.id || ''}\``,
      String(result.ok),
      `\`${result.summary?.verdict || ''}\``,
      result.errors.length ? result.errors.map((error) => `\`${error}\``).join('<br>') : '-',
    ]),
  ].map((row) => `| ${row.join(' | ')} |`).join('\n');
  return [
    '# Neo Evolution Archive Dry-Run',
    '',
    `Generated: ${report.generatedAt || '-'}`,
    `JSON: \`${jsonRef || '-'}\``,
    '',
    '## Policy',
    '',
    '- Dry-run archive metadata only; this CLI does not write live archive.jsonl.',
    '- Prompt, diff, patch, command output, stdout/stderr, and secret bodies are forbidden.',
    '- No patch apply, live 51835, memory-v2 write, private holdout read, secret read, commit, push, package script, evaluator, security, or permission change is authorized.',
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
  const records = readRecords(args.artifactFile);
  const report = buildNoeEvolutionArchiveDryRunReport(records, {
    inputRef: args.artifactFile || 'smoke',
  });
  const { file: outDir } = guardedRepoPath(args.outDir, 'out-dir', { mustBeOutput: true });
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const now = Date.now();
  const jsonPath = join(outDir, `evolution-archive-dry-run-${now}.json`);
  const mdPath = join(outDir, `evolution-archive-dry-run-${now}.md`);
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
