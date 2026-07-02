#!/usr/bin/env node
// @ts-check

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildNoeEvolutionPrRepairDryRunReport,
  NOE_EVOLUTION_PR_REPAIR_DRY_RUN_KIND,
  NOE_EVOLUTION_PR_REPAIR_DRY_RUN_VALIDATOR_VERSION,
  sha256Text,
} from '../src/candidates/NoeEvolutionPrRepairDryRun.js';
import { NOE_CANDIDATE_PATCH_VALIDATOR_VERSION } from '../src/candidates/NoeCandidatePatchArtifactGate.js';
import { NOE_EVOLUTION_ARCHIVE_DRY_RUN_VALIDATOR_VERSION } from '../src/candidates/NoeEvolutionArchiveDryRun.js';
import { NOE_EVOLUTION_SCORECARD_DRY_RUN_VALIDATOR_VERSION } from '../src/candidates/NoeEvolutionScorecardDryRun.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_ROOT = realpathSync(ROOT);
const OUTPUT_ROOT = resolve(ROOT, 'output');
const DEFAULT_OUT_DIR = 'output/noe-pr-repair-dry-run';
const SENSITIVE_REF_RE = /(^|\/)(?:\.env(?:$|[./_-][^/]*)?|\.npmrc|\.netrc|owner[-_]?token(?:\.txt)?|ownertoken(?:\.txt)?|room-adapters\.json|.*secret.*|.*token.*|.*cookie.*|.*oauth.*|evals\/neo\/private_holdout)(?:\/|$)/i;
const FORBIDDEN_INPUT_RE = /(?:NoePatchApply|NoePatchTransaction|NoeSelfEvolution|NoeConsensus|NoeExecutionAuthority|noe-patch-apply|noe-patch-rollback|noe-self-improve|consensus|holdout|evaluator|security|permission|src\/eval|src\/loop|src\/webhook|package\.json|package-lock\.json|\.git\/|\.noe-panel|archive\.jsonl|memoryV2|memory-v2|51735|51835|panel-runtime|runtime-restart|restart-panel|pull-request-publish|github-publish|gh-cli)/i;
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
  const out = { recordFile: '', outDir: DEFAULT_OUT_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--record-file') out.recordFile = argv[++index] || '';
    else if (arg.startsWith('--record-file=')) out.recordFile = arg.slice('--record-file='.length);
    else if (arg === '--out-dir') out.outDir = argv[++index] || out.outDir;
    else if (arg.startsWith('--out-dir=')) out.outDir = arg.slice('--out-dir='.length);
    else throw new Error('unknown argument');
  }
  return out;
}

function reportRef(name) {
  return `output/noe-pr-repair-dry-run/${name}`;
}

function defaultSmokeRecord() {
  const patchRef = 'output/noe-candidate-patches/dry-run/latest.json';
  const draftRef = reportRef('draft-pr-description.md');
  const validationRef = reportRef('validation-report.json');
  const rollbackRef = reportRef('rollback-plan.json');
  const riskRef = reportRef('risk-report.json');
  return {
    kind: NOE_EVOLUTION_PR_REPAIR_DRY_RUN_KIND,
    schemaVersion: 1,
    id: 'pr-repair-dry-run-smoke-001',
    createdAt: '2026-06-19T00:00:00.000Z',
    parentId: 'pr-parent-smoke',
    childId: 'pr-child-smoke',
    generation: 1,
    candidateRef: patchRef,
    archiveReportRef: 'output/noe-evolution-archive-dry-run/latest.json',
    scorecardReportRef: 'output/noe-evolution-scorecard-dry-run/latest.json',
    holdoutRef: 'private_holdout:not_accessed',
    branch: {
      proposedName: 'codex/noe-pr-repair-dry-run-smoke',
      baseRef: 'noe-main',
      branchCreated: false,
      existingBranchChecked: false,
    },
    artifacts: {
      patchArtifactRef: patchRef,
      patchArtifactSha256: sha256Text(patchRef),
      draftPrDescriptionRef: draftRef,
      draftPrDescriptionSha256: sha256Text(draftRef),
      validationReportRef: validationRef,
      validationReportSha256: sha256Text(validationRef),
      rollbackRef,
      rollbackSha256: sha256Text(rollbackRef),
      riskReportRef: riskRef,
      riskReportSha256: sha256Text(riskRef),
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
      verdict: 'dry_run_ready',
      readyForHumanReview: true,
      branchCreated: false,
      patchApplied: false,
      prOpened: false,
      externalPublished: false,
      runtimeVerified: false,
      memoryWritten: false,
      committed: false,
      pushed: false,
    },
    policy: {
      dryRunOnly: true,
      metadataOnly: true,
      noGitBranchCreate: true,
      noGitCommit: true,
      noGitPush: true,
      noExternalPublish: true,
      noPatchApply: true,
      noLive51835: true,
      noMemoryV2Write: true,
      noPrivateHoldoutRead: true,
      noSecretRead: true,
      noPackageScriptChange: true,
      noEvaluatorChange: true,
      noSecurityOrPermissionChange: true,
    },
    validator: {
      validatorVersion: NOE_EVOLUTION_PR_REPAIR_DRY_RUN_VALIDATOR_VERSION,
      reportRef: 'output/noe-pr-repair-dry-run/latest.json',
      warnings: [],
      blockers: [],
      secretValuesReturned: false,
      checks: {
        candidatePatchGate: { ok: true, reportRef: patchRef },
        archiveDryRun: { ok: true, reportRef: 'output/noe-evolution-archive-dry-run/latest.json' },
        scorecardDryRun: { ok: true, reportRef: 'output/noe-evolution-scorecard-dry-run/latest.json' },
        draftPrSchema: { ok: true, reportRef: draftRef },
        validationReport: { ok: true, reportRef: validationRef },
        secretScan: { ok: true, reportRef: reportRef('redaction-scan.json') },
        sast: { ok: true, reportRef: reportRef('sast.json') },
        sca: { ok: true, reportRef: reportRef('sca.json') },
        rollbackDryRun: { ok: true, reportRef: rollbackRef },
        publishDryRun: { ok: true, reportRef: reportRef('publish-dry-run.json') },
      },
    },
    evidenceRefs: [
      reportRef('evidence.md'),
    ],
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

function readUpstreamReport(ref, label, expectedValidatorVersion) {
  try {
    const { file } = guardedRepoPath(ref, `${label} report`, { mustBeOutput: true, mustExist: true });
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed?.ok !== true) return `${label}_report_not_ok`;
    if (parsed?.validatorVersion !== expectedValidatorVersion) return `${label}_validator_version_mismatch`;
    return '';
  } catch {
    return `${label}_report_invalid`;
  }
}

function verifyUpstreamReports(records, report) {
  const specs = [
    ['candidate', 'candidateRef', NOE_CANDIDATE_PATCH_VALIDATOR_VERSION],
    ['archive', 'archiveReportRef', NOE_EVOLUTION_ARCHIVE_DRY_RUN_VALIDATOR_VERSION],
    ['scorecard', 'scorecardReportRef', NOE_EVOLUTION_SCORECARD_DRY_RUN_VALIDATOR_VERSION],
  ];
  for (let index = 0; index < records.length; index += 1) {
    const result = report.results?.[index];
    if (!result) continue;
    const upstreamErrors = [];
    for (const [label, field, version] of specs) {
      const error = readUpstreamReport(records[index]?.[field], `pr_repair_upstream_${label}`, version);
      if (error) upstreamErrors.push(error);
    }
    if (upstreamErrors.length > 0) {
      result.errors = [...new Set([...(result.errors || []), ...upstreamErrors])];
      result.ok = false;
    }
    result.gates = {
      ...(result.gates || {}),
      upstreamReports: upstreamErrors.length === 0,
    };
    result.summary = {
      ...(result.summary || {}),
      readyAfterGate: result.ok === true && result.summary?.readyForHumanReview === true,
    };
  }
  report.policy.verifiesUpstreamReports = true;
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
    ['Record', 'OK', 'Ready After Gate', 'Branch', 'Verdict', 'Errors'],
    ['---', '---:', '---:', '---', '---', '---'],
    ...(report.results || []).map((result) => [
      `\`${result.id || ''}\``,
      String(result.ok),
      String(result.summary?.readyAfterGate ?? ''),
      `\`${result.summary?.branch || ''}\``,
      `\`${result.summary?.verdict || ''}\``,
      result.errors.length ? result.errors.map((error) => `\`${error}\``).join('<br>') : '-',
    ]),
  ].map((row) => `| ${row.join(' | ')} |`).join('\n');
  return [
    '# Neo PR Repair Dry-Run',
    '',
    `Generated: ${report.generatedAt || '-'}`,
    `JSON: \`${jsonRef || '-'}\``,
    '',
    '## Policy',
    '',
    '- Dry-run PR repair metadata only; this CLI does not create branches, commit, push, or open a PR.',
    '- Draft PR body, patch body, diff body, command output, stdout/stderr, and secret values are forbidden; only refs and hashes are accepted.',
    '- No patch apply, live 51835, memory-v2 write, private holdout read, secret read, package script, evaluator, security, or permission change is authorized.',
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
  const report = verifyUpstreamReports(
    records,
    buildNoeEvolutionPrRepairDryRunReport(records, { inputRef: args.recordFile || 'smoke' }),
  );
  const { file: outDir } = guardedRepoPath(args.outDir, 'out-dir', { mustBeOutput: true });
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const now = Date.now();
  const jsonPath = join(outDir, `pr-repair-dry-run-${now}.json`);
  const mdPath = join(outDir, `pr-repair-dry-run-${now}.md`);
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
    console.error(error?.message || 'pr repair dry-run failed');
    process.exitCode = 1;
  }
}
