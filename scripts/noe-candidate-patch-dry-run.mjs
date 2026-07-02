#!/usr/bin/env node
// @ts-check

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildNoeCandidatePatchArtifactReport,
  NOE_CANDIDATE_PATCH_ARTIFACT_KIND,
  NOE_CANDIDATE_PATCH_VALIDATOR_VERSION,
} from '../src/candidates/NoeCandidatePatchArtifactGate.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_ROOT = realpathSync(ROOT);
const OUTPUT_ROOT = resolve(ROOT, 'output');
const DEFAULT_OUT_DIR = 'output/noe-candidate-patches/dry-run';
const SENSITIVE_REF_RE = /(^|\/)(?:\.env(?:$|[./_-][^/]*)?|\.npmrc|\.netrc|owner[-_]?token(?:\.txt)?|ownertoken(?:\.txt)?|room-adapters\.json|.*secret.*|.*token.*|.*cookie.*|.*oauth.*|evals\/neo\/private_holdout)(?:\/|$)/i;

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

function insideRoot(realFile) {
  const realRef = relative(REAL_ROOT, realFile).replaceAll('\\', '/');
  return realRef === '' || (realRef !== '..' && !realRef.startsWith('../') && !realRef.startsWith('/'));
}

function insidePathRoot(root, file) {
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
    throw new Error(`${label} uses forbidden scheme: ${ref}`);
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
  const stat = lstatSync(existingPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} uses forbidden symlink path: ${ref}`);
  }
  const realExisting = realpathSync(existingPath);
  if (!insideRoot(realExisting)) {
    throw new Error(`${label} resolves outside repo: ${ref}`);
  }
  if (mustBeOutput && existsSync(OUTPUT_ROOT)) {
    const outputStat = lstatSync(OUTPUT_ROOT);
    if (outputStat.isSymbolicLink()) {
      throw new Error(`${label} output root is a forbidden symlink: ${ref}`);
    }
    const realOutput = realpathSync(OUTPUT_ROOT);
    if (existingPath !== ROOT && !insidePathRoot(realOutput, realExisting)) {
      throw new Error(`${label} resolves outside output/: ${ref}`);
    }
  }
  if (existsSync(file)) {
    const realFile = realpathSync(file);
    if (!insideRoot(realFile)) {
      throw new Error(`${label} resolves outside repo: ${ref}`);
    }
    if (mustBeOutput) {
      const realOutput = existsSync(OUTPUT_ROOT) ? realpathSync(OUTPUT_ROOT) : OUTPUT_ROOT;
      if (!insidePathRoot(realOutput, realFile)) {
        throw new Error(`${label} resolves outside output/: ${ref}`);
      }
    }
  }
  return { file, repoRef };
}

function sha256(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    artifactFile: '',
    outDir: DEFAULT_OUT_DIR,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--artifact-file') out.artifactFile = argv[++i] || '';
    else if (arg.startsWith('--artifact-file=')) out.artifactFile = arg.slice('--artifact-file='.length);
    else if (arg === '--out-dir') out.outDir = argv[++i] || out.outDir;
    else if (arg.startsWith('--out-dir=')) out.outDir = arg.slice('--out-dir='.length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function readArtifacts(artifactFile) {
  if (!artifactFile) return [defaultSmokeArtifact()];
  const { file } = guardedRepoPath(artifactFile, 'artifact file', { mustExist: true });
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.artifacts)) return parsed.artifacts;
  return [parsed];
}

function defaultSmokeArtifact() {
  const plannedContent = 'Phase 4 candidate patch dry-run smoke artifact.\n';
  const target = 'output/noe-candidate-patches/dry-run/smoke-target.txt';
  return {
    kind: NOE_CANDIDATE_PATCH_ARTIFACT_KIND,
    schemaVersion: 1,
    id: 'candidate-patch-smoke-001',
    createdAt: '2026-06-19T00:00:00.000Z',
    parentRef: 'git:HEAD',
    diffRef: 'output/noe-candidate-patches/dry-run/smoke-diff.json',
    scope: {
      phase: 'phase4',
      changeType: 'dry_run_candidate_patch',
      allowedArea: 'dry_run_report',
      targetFiles: [target],
      changedFiles: 1,
      changedLines: 1,
      diffBytes: Buffer.byteLength(plannedContent, 'utf8'),
      nonCoreOnly: true,
    },
    reason: {
      problemRef: 'docs/PLAN_2026-06-19_Hermes_OpenClaw_自进化蒸馏总路线.md',
      hypothesis: 'A metadata-only candidate patch artifact can be validated before any self-code executor is enabled.',
      expectedBenefit: 'Blocks unsafe self-code candidates while producing an auditable dry-run report.',
    },
    holdoutRef: 'private_holdout:not_accessed',
    holdout: { status: 'not_accessed' },
    provenance: {
      source: 'phase4-local-smoke',
      modelOrTool: 'codex-local-cli',
      sourceEpisodeId: 'episode-phase4-smoke-001',
      sourceReportRef: 'output/noe-candidate-patches/dry-run/smoke-source.json',
      rawOutputRef: 'output/noe-candidate-patches/dry-run/smoke-raw-output-redacted.json',
      roundRef: 'output/noe-candidate-patches/dry-run/smoke-round.json',
      redactionPolicy: 'metadata_only_no_patch_body_no_secret_values',
    },
    signature: {
      payloadSha256: sha256('candidate-patch-smoke-001'),
      verified: false,
    },
    cost: {
      estimatedUsd: 0,
      quotaRisk: 'none',
      paidApiUsed: false,
      note: 'local smoke only',
    },
    evalPlan: {
      reportRef: 'output/noe-candidate-patches/dry-run/smoke-eval.json',
      scoreRef: 'output/noe-candidate-patches/dry-run/smoke-score.json',
      holdoutRef: 'private_holdout:not_accessed',
      holdoutStatus: 'not_accessed',
      devCommands: ['node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/noe-candidate-patch-artifact-gate.test.js'],
      regressionCommands: ['node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-candidate-patch-dry-run.mjs'],
      successCriteria: 'validator ok true and target file absent after dry-run',
      tests: [{
        name: 'candidate-patch-dry-run-smoke',
        ok: true,
        reportRef: 'output/noe-candidate-patches/dry-run/smoke-test.json',
      }],
    },
    rollbackPlan: {
      mode: 'drop_artifact',
      rollbackRef: 'output/noe-candidate-patches/dry-run/smoke-rollback.json',
      reportRef: 'output/noe-candidate-patches/dry-run/smoke-rollback.json',
      reversible: true,
      manualSteps: ['Discard this artifact and report; no patch executor is called by this dry-run gate.'],
      callsRollbackExecutor: false,
    },
    operations: [{
      id: 'write-smoke-doc',
      op: 'write_file',
      path: target,
      contentSha256: sha256(plannedContent),
      contentBytes: Buffer.byteLength(plannedContent, 'utf8'),
      addedLines: 1,
      removedLines: 0,
    }],
    claims: {
      applied: false,
      claimedSucceeded: false,
      committed: false,
      consensusApproved: false,
      live51835Verified: false,
      memoryWritten: false,
      pushed: false,
      runtimeRestarted: false,
      runtimeVerified: false,
      standingApproved: false,
      userApproved: false,
      status: 'dry_run_artifact_only',
    },
    validator: {
      validatorVersion: NOE_CANDIDATE_PATCH_VALIDATOR_VERSION,
      reportRef: 'output/noe-candidate-patches/dry-run/latest.json',
      blockers: [],
      warnings: [],
      secretValuesReturned: false,
      checks: {
        sandbox: { ok: true, reportRef: 'output/noe-candidate-patches/dry-run/smoke-sandbox.json' },
        secretScan: { ok: true, reportRef: 'output/noe-candidate-patches/dry-run/smoke-redaction-scan.json' },
        sast: { ok: true, reportRef: 'output/noe-candidate-patches/dry-run/smoke-sast.json' },
        sca: { ok: true, reportRef: 'output/noe-candidate-patches/dry-run/smoke-sca.json' },
        rollbackDryRun: { ok: true, reportRef: 'output/noe-candidate-patches/dry-run/smoke-rollback-dry-run.json' },
        rewardHacking: { ok: true, reportRef: 'output/noe-candidate-patches/dry-run/smoke-reward-hacking.json' },
      },
    },
    safety: {
      dryRunOnly: true,
      sandboxed: true,
      secretScanPlanned: true,
      sastPlanned: true,
      scaPlanned: true,
      rollbackDryRunPlanned: true,
      rewardHackingChecked: true,
      ciTouched: false,
      commits: false,
      evaluatorTouched: false,
      executorEnabled: false,
      externalSideEffect: false,
      liveAction: false,
      memoryV2Write: false,
      memoryWriteback: false,
      modelCalls: false,
      packageScriptsTouched: false,
      patchExecutorEnabled: false,
      permissionTouched: false,
      privateHoldoutRead: false,
      pushes: false,
      realExecute: false,
      runtimePortTouch: false,
      runtimeRestart: false,
      secretAccess: false,
      securityTouched: false,
      selfEvolutionExecutorsEnabled: false,
      standingGrantEnabled: false,
      writesRepoFiles: false,
      writesMemoryV2: false,
      holdoutStatus: 'not_accessed',
    },
  };
}

function renderMarkdown(report = {}, jsonRef = '') {
  const summaryRows = [
    ['Metric', 'Value'],
    ['---', '---:'],
    ['ok', String(report.ok === true)],
    ['artifacts', String(report.counts?.artifacts ?? 0)],
    ['passed', String(report.counts?.passed ?? 0)],
    ['failed', String(report.counts?.failed ?? 0)],
  ].map((row) => `| ${row.join(' | ')} |`).join('\n');
  const resultRows = [
    ['Artifact', 'OK', 'Errors', 'Targets'],
    ['---', '---:', '---', '---'],
    ...(report.results || []).map((result) => [
      `\`${result.id || ''}\``,
      String(result.ok),
      result.errors.length ? result.errors.map((error) => `\`${error}\``).join('<br>') : '-',
      (result.summary?.targetPaths || []).map((target) => `\`${target}\``).join('<br>') || '-',
    ]),
  ].map((row) => `| ${row.join(' | ')} |`).join('\n');
  return [
    '# Neo Candidate Patch Dry-Run Gate',
    '',
    `Generated: ${report.generatedAt || '-'}`,
    `JSON: \`${jsonRef || '-'}\``,
    '',
    '## Policy',
    '',
    '- Dry-run only; this CLI does not import or call NoePatchApplyExecutor.',
    '- Target patch bodies are forbidden in the artifact; only hashes and metadata are reported.',
    '- No commit, push, runtime restart, memory-v2 write, private holdout read, or package script change is authorized.',
    '',
    '## Summary',
    '',
    summaryRows,
    '',
    '## Results',
    '',
    resultRows,
    '',
  ].join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const artifacts = readArtifacts(args.artifactFile);
  const report = buildNoeCandidatePatchArtifactReport(artifacts, {
    inputRef: args.artifactFile || 'smoke',
  });
  const { file: outDir } = guardedRepoPath(args.outDir, 'out-dir', { mustBeOutput: true });
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const now = Date.now();
  const jsonPath = join(outDir, `candidate-patch-dry-run-${now}.json`);
  const mdPath = join(outDir, `candidate-patch-dry-run-${now}.md`);
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
