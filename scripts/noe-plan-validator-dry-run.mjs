#!/usr/bin/env node
// @ts-check

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildNoePlanValidatorDryRunReport,
  NOE_PLAN_VALIDATOR_DRY_RUN_KIND,
  NOE_PLAN_VALIDATOR_DRY_RUN_VALIDATOR_VERSION,
  sha256Text,
} from '../src/candidates/NoePlanValidatorDryRun.js';
import { NOE_CANDIDATE_PATCH_VALIDATOR_VERSION } from '../src/candidates/NoeCandidatePatchArtifactGate.js';
import { NOE_EVOLUTION_ARCHIVE_DRY_RUN_VALIDATOR_VERSION } from '../src/candidates/NoeEvolutionArchiveDryRun.js';
import { NOE_EVOLUTION_PR_REPAIR_DRY_RUN_VALIDATOR_VERSION } from '../src/candidates/NoeEvolutionPrRepairDryRun.js';
import { NOE_EVOLUTION_SCORECARD_DRY_RUN_VALIDATOR_VERSION } from '../src/candidates/NoeEvolutionScorecardDryRun.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_ROOT = realpathSync(ROOT);
const OUTPUT_ROOT = resolve(ROOT, 'output');
const DEFAULT_OUT_DIR = 'output/noe-plan-validator-dry-run';
const SENSITIVE_REF_RE = /(^|\/)(?:\.env(?:$|[./_-][^/]*)?|\.npmrc|\.netrc|owner[-_]?token(?:\.txt)?|ownertoken(?:\.txt)?|room-adapters\.json|.*secret.*|.*token.*|.*cookie.*|.*oauth.*|evals\/neo\/private_holdout)(?:\/|$)/i;
const FORBIDDEN_INPUT_RE = /(?:NoePatchApply|NoePatchTransaction|NoeSelfEvolution|NoeConsensus|NoeExecutionAuthority|noe-patch-apply|noe-patch-rollback|noe-self-improve|consensus|holdout|evaluator|security|permission|src\/eval|src\/loop|src\/webhook|package\.json|package-lock\.json|\.git\/|\.noe-panel|archive\.jsonl|memoryV2|memory-v2|51735|51835|panel-runtime|runtime-restart|restart-panel|pull-request-publish|github-publish|gh-cli|graphmemory-write|causal-runtime-gate)/i;
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
    const realOutput = realpathSync(OUTPUT_ROOT);
    if (existing !== ROOT && !insidePath(realOutput, realExisting)) throw new Error(`${label} resolves outside output/`);
  }
  return { file, repoRef };
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = { recordFile: '', outDir: DEFAULT_OUT_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--record-file' || arg === '--plan-file') out.recordFile = argv[++index] || '';
    else if (arg.startsWith('--record-file=')) out.recordFile = arg.slice('--record-file='.length);
    else if (arg.startsWith('--plan-file=')) out.recordFile = arg.slice('--plan-file='.length);
    else if (arg === '--out-dir') out.outDir = argv[++index] || out.outDir;
    else if (arg.startsWith('--out-dir=')) out.outDir = arg.slice('--out-dir='.length);
    else throw new Error('unknown argument');
  }
  return out;
}

function reportRef(name) {
  return `output/noe-plan-validator-dry-run/${name}`;
}

function defaultSmokeRecord() {
  const planRef = 'output/noe-pr-repair-dry-run/latest.json';
  const sourceReportRefs = [
    'output/noe-pr-repair-dry-run/latest.json',
    'output/noe-runtime-trace-boundary-check/latest.json',
    'output/noe-memory-utility-lite-boundary-check/latest.json',
  ];
  return {
    kind: NOE_PLAN_VALIDATOR_DRY_RUN_KIND,
    schemaVersion: 1,
    id: 'plan-validator-dry-run-smoke-001',
    createdAt: '2026-06-19T00:00:00.000Z',
    planKind: 'pr_repair',
    planRef,
    planSha256: sha256Text(planRef),
    sourceReportRefs,
    rollbackRef: reportRef('rollback.json'),
    riskReportRef: reportRef('risk.json'),
    intendedStage: 'dry_run_schema_report',
    refs: {
      prRepairReportRef: 'output/noe-pr-repair-dry-run/latest.json',
      runtimeTraceReportRef: 'output/noe-runtime-trace-boundary-check/latest.json',
      boundaryReportRef: 'output/noe-multimodel/20260619-boundary-graphmemory-planvalidator-causalriskgate/ledger.json',
    },
    policy: {
      dryRunOnly: true,
      metadataOnly: true,
      noPlanExecution: true,
      noPatchApply: true,
      noGit: true,
      noGh: true,
      noExternalPublish: true,
      noEvaluatorRun: true,
      noModelApiCall: true,
      noLive51835: true,
      noMemoryV2Write: true,
      noSecretRead: true,
      noPrivateHoldoutRead: true,
      noPackageScriptChange: true,
      noEvaluatorChange: true,
      noSecurityOrPermissionChange: true,
      noGraphMemoryWrite: true,
      noCausalRuntimeGate: true,
    },
    result: {
      verdict: 'plan_review_ready',
      readyAfterGate: true,
      executed: false,
      applied: false,
      committed: false,
      pushed: false,
      published: false,
      runtimeTouched: false,
      memoryWritten: false,
    },
    validator: {
      validatorVersion: NOE_PLAN_VALIDATOR_DRY_RUN_VALIDATOR_VERSION,
      reportRef: 'output/noe-plan-validator-dry-run/latest.json',
      warnings: [],
      blockers: [],
      secretValuesReturned: false,
      checks: {
        planSchema: { ok: true, reportRef: reportRef('schema.json') },
        sourceReports: { ok: true, reportRef: reportRef('source-reports.json') },
        refSafety: { ok: true, reportRef: reportRef('ref-safety.json') },
        policy: { ok: true, reportRef: reportRef('policy.json') },
        secretScan: { ok: true, reportRef: reportRef('redaction-scan.json') },
        noExecution: { ok: true, reportRef: reportRef('no-execution.json') },
        rollbackRef: { ok: true, reportRef: reportRef('rollback.json') },
      },
    },
    evidenceRefs: [reportRef('evidence.md')],
  };
}

function readRecords(recordFile) {
  if (!recordFile) return [defaultSmokeRecord()];
  const { file } = guardedRepoPath(recordFile, 'record file', { mustExist: true });
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.records)) return parsed.records;
  return [parsed];
}

function expectedValidatorVersionForRef(ref) {
  const text = safeRef(ref);
  if (text.startsWith('output/noe-candidate-patches/')) return NOE_CANDIDATE_PATCH_VALIDATOR_VERSION;
  if (text.startsWith('output/noe-evolution-archive-dry-run/')) return NOE_EVOLUTION_ARCHIVE_DRY_RUN_VALIDATOR_VERSION;
  if (text.startsWith('output/noe-evolution-scorecard-dry-run/')) return NOE_EVOLUTION_SCORECARD_DRY_RUN_VALIDATOR_VERSION;
  if (text.startsWith('output/noe-pr-repair-dry-run/')) return NOE_EVOLUTION_PR_REPAIR_DRY_RUN_VALIDATOR_VERSION;
  if (text.startsWith('output/noe-plan-validator-dry-run/')) return NOE_PLAN_VALIDATOR_DRY_RUN_VALIDATOR_VERSION;
  return '';
}

function verifySourceReports(records, report) {
  for (let index = 0; index < records.length; index += 1) {
    const result = report.results?.[index];
    const errors = [];
    for (const ref of records[index]?.sourceReportRefs || []) {
      try {
        const { file } = guardedRepoPath(ref, 'source report', { mustBeOutput: true, mustExist: true });
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (parsed?.ok !== true) errors.push('plan_validator_source_report_not_ok');
        const expectedVersion = expectedValidatorVersionForRef(ref);
        if (expectedVersion && parsed?.validatorVersion !== expectedVersion) errors.push('plan_validator_source_report_validator_version_mismatch');
      } catch {
        errors.push('plan_validator_source_report_invalid');
      }
    }
    if (errors.length > 0 && result) {
      result.errors = [...new Set([...(result.errors || []), ...errors])];
      result.ok = false;
    }
    if (result) {
      result.gates = { ...(result.gates || {}), sourceReportsVerified: errors.length === 0 };
      result.summary = { ...(result.summary || {}), readyAfterGate: result.ok === true && result.summary?.readyAfterGate === true };
    }
  }
  report.policy.verifiesSourceReports = true;
  report.counts.passed = report.results.filter((result) => result.ok).length;
  report.counts.failed = report.results.filter((result) => !result.ok).length;
  report.ok = report.results.length > 0 && report.results.every((result) => result.ok);
  return report;
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
    ['Record', 'OK', 'Plan Kind', 'Ready After Gate', 'Verdict', 'Errors'],
    ['---', '---:', '---', '---:', '---', '---'],
    ...(report.results || []).map((result) => [
      `\`${result.id || ''}\``,
      String(result.ok),
      `\`${result.summary?.planKind || ''}\``,
      String(result.summary?.readyAfterGate ?? ''),
      `\`${result.summary?.verdict || ''}\``,
      result.errors.length ? result.errors.map((error) => `\`${error}\``).join('<br>') : '-',
    ]),
  ].map((row) => `| ${row.join(' | ')} |`).join('\n');
  return [
    '# Neo Plan Validator Dry-Run',
    '',
    `Generated: ${report.generatedAt || '-'}`,
    `JSON: \`${jsonRef || '-'}\``,
    '',
    '## Policy',
    '',
    '- Dry-run plan metadata only; this CLI does not execute plans.',
    '- Plan body, prompt, diff, patch, command output, stdout/stderr, memory body, and secret values are forbidden.',
    '- No patch apply, git/gh, external publish, evaluator/model/API call, live 51835, memory-v2, graph-memory write, causal runtime gate, private holdout read, secret read, package/evaluator/security/permission change is authorized.',
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
  const records = readRecords(args.recordFile);
  const report = verifySourceReports(records, buildNoePlanValidatorDryRunReport(records, { inputRef: args.recordFile || 'smoke' }));
  const { file: outDir } = guardedRepoPath(args.outDir, 'out-dir', { mustBeOutput: true });
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const now = Date.now();
  const jsonPath = join(outDir, `plan-validator-dry-run-${now}.json`);
  const mdPath = join(outDir, `plan-validator-dry-run-${now}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(outDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const markdown = renderMarkdown(report, rel(jsonPath));
  writeFileSync(mdPath, `${markdown}\n`, { mode: 0o600 });
  writeFileSync(join(outDir, 'latest.md'), `${markdown}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ok: report.ok, jsonPath: rel(jsonPath), mdPath: rel(mdPath), counts: report.counts }, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] || '')) {
  try {
    main();
  } catch (error) {
    console.error(error?.message || 'plan validator dry-run failed');
    process.exitCode = 1;
  }
}
