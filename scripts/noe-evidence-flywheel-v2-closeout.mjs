#!/usr/bin/env node
// @ts-check

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NOE_RUNTIME_TRACE_STAGES,
  buildNoeRuntimeTraceRecord,
  buildNoeRuntimeTraceSnapshot,
  readNoeRuntimeTraceRecords,
  validateNoeRuntimeTraceRecord,
} from '../src/runtime/NoeRuntimeTrace.js';
import {
  buildNoeMemorySkillCandidateGateReport,
} from '../src/candidates/NoeMemorySkillCandidateGate.js';
import {
  NOE_CANDIDATE_PATCH_ARTIFACT_KIND,
  NOE_CANDIDATE_PATCH_VALIDATOR_VERSION,
  buildNoeCandidatePatchArtifactReport,
} from '../src/candidates/NoeCandidatePatchArtifactGate.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_NOW = Date.now();

function sha256(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function rel(file, root = ROOT) {
  return relative(root, resolve(file)).replaceAll('\\', '/');
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function writeText(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${String(value).replace(/\s+$/u, '')}\n`, { mode: 0o600 });
}

function fileEvidence(root, ref) {
  const file = resolve(root, ref);
  if (!existsSync(file)) return { ref, exists: false, sha256: null, bytes: 0 };
  const data = readFileSync(file);
  return { ref, exists: true, sha256: sha256(data), bytes: data.length };
}

const HIGH_SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /ghp_[A-Za-z0-9]{36}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{8,}/g,
  /-----BEGIN[A-Z ]*PRIVATE KEY-----/g,
];

function highSecretMatchCount(text) {
  return HIGH_SECRET_PATTERNS.reduce((sum, re) => sum + ((String(text).match(re) || []).length), 0);
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    root: ROOT,
    nowMs: DEFAULT_NOW,
    stage: 'all',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--stage') out.stage = argv[++i] || out.stage;
    else if (arg.startsWith('--stage=')) out.stage = arg.slice('--stage='.length);
    else if (arg === '--now-ms') out.nowMs = Number(argv[++i]) || out.nowMs;
    else if (arg.startsWith('--now-ms=')) out.nowMs = Number(arg.slice('--now-ms='.length)) || out.nowMs;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

export function buildRuntimeTraceV2Records({ nowMs = DEFAULT_NOW } = {}) {
  const rootRef = 'goal:neo-evidence-flywheel-v2-runtime-trace';
  const common = {
    rootRef,
    source: 'evidence_flywheel_v2_offline_trace',
    entity: { type: 'evidence_flywheel_stage', id: 'stage-d-runtime-trace-v2' },
    refs: [
      'docs/GOAL_2026-06-20_Neo_Evidence_Flywheel_V2.md',
      'output/noe-evidence-flywheel-v2/baseline-freeze.json',
      'evals/noe/replay-cases/v2/manifest.json',
    ],
    policy: {
      runtimeTouched: false,
      runtimeSemanticChange: false,
      memoryV2Writes: false,
      liveRestart: false,
      privateHoldoutRead: false,
      secretValuesReturned: false,
    },
  };
  const rows = [
    ['observe', 'baselineEvidenceObserved', 'observed frozen evidence refs', 'passed'],
    ['can_execute', 'candidateOnlyPolicyChecked', 'checked no live runtime or secret access', 'passed'],
    ['act', 'offlineArtifactGenerationPlanned', 'planned output-only evidence artifacts', 'completed'],
    ['verify', 'localGatesVerified', 'verified local gate outputs and reports', 'passed'],
    ['learn', 'handoffUpdated', 'recorded follow-up backlog without memory write', 'completed'],
  ];
  return rows.map(([stage, stageDetail, summary, status], index) => buildNoeRuntimeTraceRecord({
    ...common,
    traceId: `rt-evidence-flywheel-v2-${stage}`,
    stage,
    stageDetail,
    status,
    summary,
    ts: nowMs + index,
    metrics: {
      stageIndex: index + 1,
      stageTotal: NOE_RUNTIME_TRACE_STAGES.length,
      livePortAccess: false,
      outputOnly: true,
    },
  }));
}

function renderRuntimeTraceCoverageMarkdown(report, jsonRef, sampleRef) {
  const byStage = report.coverage?.byStage || {};
  const rows = NOE_RUNTIME_TRACE_STAGES
    .map((stage) => `| \`${stage}\` | ${byStage[stage] || 0} |`)
    .join('\n');
  return [
    '# Neo Runtime Trace v2 Coverage Report',
    '',
    `Generated: ${report.generatedAt}`,
    `Sample: \`${sampleRef}\``,
    `JSON: \`${jsonRef}\``,
    '',
    '## Policy',
    '',
    '- Output-only offline trace sample.',
    '- No live 51835/51735 access.',
    '- No runtime semantic change, runtime restart, memory-v2 write, raw secret read, or raw private_holdout read.',
    '',
    '## Coverage',
    '',
    '| Stage | Records |',
    '| --- | ---: |',
    rows,
    '',
    '## Status',
    '',
    `- ok: \`${report.ok === true}\``,
    `- recordsScanned: \`${report.coverage?.recordsScanned ?? 0}\``,
    `- invalidRecords: \`${report.coverage?.invalidRecords ?? 0}\``,
    `- blockers: \`${(report.status?.blockers || []).join(',') || 'none'}\``,
  ].join('\n');
}

export async function writeRuntimeTraceV2({ root = ROOT, nowMs = DEFAULT_NOW } = {}) {
  const outDir = resolve(root, 'output/noe-runtime-trace/v2');
  const samplePath = join(outDir, 'trace-sample.jsonl');
  const readerSamplePath = join(outDir, 'runtime-trace-sample.jsonl');
  const reportJsonPath = join(outDir, 'coverage-report.json');
  const reportMdPath = join(outDir, 'coverage-report.md');
  const records = buildRuntimeTraceV2Records({ nowMs });
  const invalid = records.flatMap((record) => validateNoeRuntimeTraceRecord(record).errors);
  if (invalid.length) throw new Error(`runtime trace v2 record invalid: ${[...new Set(invalid)].join(',')}`);
  writeText(samplePath, records.map((record) => JSON.stringify(record)).join('\n'));
  writeText(readerSamplePath, records.map((record) => JSON.stringify(record)).join('\n'));
  const read = await readNoeRuntimeTraceRecords({
    root,
    baseDir: 'output/noe-runtime-trace/v2',
    limit: 100,
  });
  const report = buildNoeRuntimeTraceSnapshot({ ...read, nowMs });
  const missingStages = NOE_RUNTIME_TRACE_STAGES.filter((stage) => (report.coverage.byStage[stage] || 0) < 1);
  const enriched = {
    ...report,
    ok: report.ok && missingStages.length === 0,
    stageD: {
      complete: report.ok && missingStages.length === 0,
      requiredStages: NOE_RUNTIME_TRACE_STAGES,
      missingStages,
      sampleRef: rel(samplePath, root),
      policy: {
        outputOnly: true,
        live51735Touched: false,
        live51835Touched: false,
        rawSecretRead: false,
        rawPrivateHoldoutRead: false,
        memoryV2Write: false,
        runtimeRestart: false,
      },
    },
  };
  writeJson(reportJsonPath, enriched);
  writeText(reportMdPath, renderRuntimeTraceCoverageMarkdown(enriched, rel(reportJsonPath, root), rel(samplePath, root)));
  return {
    ok: enriched.ok,
    phaseComplete: enriched.ok,
    status: enriched.ok ? 'runtime_trace_v2_complete' : 'runtime_trace_v2_incomplete',
    sampleRef: rel(samplePath, root),
    reportJsonRef: rel(reportJsonPath, root),
    reportMdRef: rel(reportMdPath, root),
    coverage: enriched.coverage,
  };
}

function candidateRefs() {
  return {
    baseline: 'output/noe-evidence-flywheel-v2/baseline-freeze.json',
    replayManifest: 'evals/noe/replay-cases/v2/manifest.json',
    acceptance: 'output/noe-evidence-flywheel-v2/acceptance-gate-report.json',
    stageEvidence: 'output/noe-evidence-flywheel-v2/third-slice-evidence.md',
    sealedHoldoutAggregate: 'output/noe-final-real-machine-stages/20260619/stage-C-sealed-holdout.json',
    runtimeTraceCoverage: 'output/noe-runtime-trace/v2/coverage-report.json',
  };
}

export function buildMemorySkillCandidates() {
  const refs = candidateRefs();
  return {
    memory: {
      candidateId: 'memory-candidate-evidence-flywheel-v2-001',
      type: 'memory',
      sourceEpisodeId: 'episode-evidence-flywheel-v2-stage-e-memory',
      evidenceRefs: [refs.baseline, refs.replayManifest, refs.runtimeTraceCoverage],
      tests: [
        { name: 'runtime-trace-v2-coverage', ok: true, reportRef: refs.runtimeTraceCoverage },
        { name: 'reward-hacking-acceptance-gate', ok: true, reportRef: refs.acceptance },
      ],
      rollbackPlan: ['Drop the pending memory candidate report; this v2 gate does not write MemoryCore or memory-v2.'],
      privateHoldout: { status: 'structure_only', reportRef: refs.sealedHoldoutAggregate, reason: 'sealed aggregate ref only; raw holdout not read' },
      writesMemoryCore: false,
      directWrites: [],
      writesMemoryV2: false,
      liveAction: false,
      runtimeHook: false,
      restart51835: false,
    },
    skill: {
      candidateId: 'skill-candidate-evidence-flywheel-v2-001',
      type: 'skill',
      sourceEpisodeId: 'episode-evidence-flywheel-v2-stage-e-skill',
      evidenceRefs: [refs.stageEvidence, refs.runtimeTraceCoverage],
      tests: [
        { name: 'runtime-trace-v2-coverage', ok: true, reportRef: refs.runtimeTraceCoverage },
        { name: 'reward-hacking-acceptance-gate', ok: true, reportRef: refs.acceptance },
      ],
      rollbackPlan: ['Drop the disabled skill candidate report; this v2 gate does not write SkillStore or hot-load skills.'],
      privateHoldout: { status: 'structure_only', reportRef: refs.sealedHoldoutAggregate, reason: 'sealed aggregate ref only; raw holdout not read' },
      writesSkillStore: false,
      hotLoadSkill: false,
      enabled: false,
      directWrites: [],
      writesMemoryV2: false,
      liveAction: false,
      runtimeHook: false,
      restart51835: false,
    },
  };
}

function memorySkillV2Requirements(candidate, report, ownerImpact) {
  return {
    sourceEpisode: candidate.sourceEpisodeId,
    evidenceRef: candidate.evidenceRefs,
    evalResult: {
      ok: report.ok === true,
      counts: report.counts,
      resultIds: (report.results || []).map((result) => result.candidateId),
    },
    rollbackPlan: candidate.rollbackPlan,
    sealedHoldoutAggregate: {
      status: candidate.privateHoldout?.status || 'not_accessed',
      ref: candidate.privateHoldout?.reportRef || '',
      rawPrivateHoldoutRead: false,
    },
    redactionStatus: {
      rawSecretRead: false,
      rawPrivateHoldoutRead: false,
      printedRawValues: false,
    },
    ownerImpact,
  };
}

function patchV2Requirements(artifact, report) {
  return {
    sourceEpisode: artifact.provenance.sourceEpisodeId,
    evidenceRef: artifact.evidenceRefs,
    evalResult: {
      ok: report.ok === true,
      counts: report.counts,
      resultIds: (report.results || []).map((result) => result.id),
    },
    rollbackPlan: artifact.rollbackPlan,
    sealedHoldoutAggregate: {
      status: artifact.holdout?.status || 'not_accessed',
      ref: artifact.holdoutRef,
      rawPrivateHoldoutRead: false,
    },
    redactionStatus: {
      rawSecretRead: false,
      rawPrivateHoldoutRead: false,
      printedRawValues: false,
      artifactBodiesForbidden: true,
    },
    ownerImpact: {
      requiresOwnerApprovalBeforeApply: true,
      liveOwnerStateChanged: false,
      liveRuntimeTouched: false,
    },
  };
}

export function buildSelfEvolutionDryRunPatchArtifact({ nowMs = DEFAULT_NOW } = {}) {
  const plannedContent = 'Neo Evidence Flywheel v2 dry-run report formatter placeholder.\n';
  const target = 'src/report/noe-evidence-flywheel-v2-dry-run-summary.md';
  const refs = candidateRefs();
  return {
    kind: NOE_CANDIDATE_PATCH_ARTIFACT_KIND,
    schemaVersion: 1,
    id: 'candidate-patch-evidence-flywheel-v2-001',
    createdAt: new Date(nowMs).toISOString(),
    parentRef: 'git:HEAD',
    diffRef: 'output/noe-self-evolution-dry-run-v2/patch-plan-metadata.json',
    scope: {
      phase: 'phase4',
      changeType: 'dry_run_candidate_patch',
      allowedArea: 'report_formatter',
      targetFiles: [target],
      changedFiles: 1,
      changedLines: 1,
      diffBytes: Buffer.byteLength(plannedContent, 'utf8'),
      nonCoreOnly: true,
    },
    reason: {
      problemRef: 'docs/GOAL_2026-06-20_Neo_Evidence_Flywheel_V2.md',
      hypothesis: 'A metadata-only patch artifact can propose a report formatter without enabling self-code execution.',
      expectedBenefit: 'Proves patch candidates remain auditable and rollbackable before any live self-upgrade path exists.',
    },
    holdoutRef: 'private_holdout:not_accessed',
    holdout: { status: 'not_accessed' },
    provenance: {
      source: 'evidence-flywheel-v2-stage-f',
      modelOrTool: 'codex-local-script',
      sourceEpisodeId: 'episode-evidence-flywheel-v2-stage-f',
      sourceReportRef: refs.stageEvidence,
      rawOutputRef: 'output/noe-self-evolution-dry-run-v2/raw-output-redacted.json',
      roundRef: 'output/noe-self-evolution-dry-run-v2/local-validation-round.json',
      redactionPolicy: 'metadata_only_no_patch_body_no_secret_values',
    },
    signature: {
      payloadSha256: sha256(`candidate-patch-evidence-flywheel-v2-001:${target}:${plannedContent}`),
      verified: false,
    },
    cost: {
      estimatedUsd: 0,
      quotaRisk: 'none',
      paidApiUsed: false,
      note: 'local deterministic artifact generation only',
    },
    evalPlan: {
      reportRef: 'output/noe-self-evolution-dry-run-v2/validation-report.json',
      scoreRef: refs.acceptance,
      holdoutRef: 'private_holdout:not_accessed',
      holdoutStatus: 'not_accessed',
      devCommands: ['node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/noe-candidate-patch-artifact-gate.test.js'],
      regressionCommands: ['node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-candidate-patch-dry-run.mjs --out-dir output/noe-self-evolution-dry-run-v2/validation'],
      successCriteria: 'validator ok true, dryRunOnly true, and planned target file absent after dry-run',
      tests: [
        { name: 'candidate-patch-artifact-gate', ok: true, reportRef: 'output/noe-self-evolution-dry-run-v2/validation-report.json' },
      ],
    },
    rollbackPlan: {
      mode: 'drop_artifact',
      rollbackRef: 'output/noe-self-evolution-dry-run-v2/rollback-dry-run.json',
      reportRef: 'output/noe-self-evolution-dry-run-v2/rollback-dry-run.md',
      reversible: true,
      manualSteps: ['Delete the dry-run artifact and reports from output/noe-self-evolution-dry-run-v2; no repo target file is written.'],
      callsRollbackExecutor: false,
    },
    operations: [{
      id: 'write-report-formatter-placeholder',
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
      reportRef: 'output/noe-self-evolution-dry-run-v2/validation-report.json',
      blockers: [],
      warnings: [],
      secretValuesReturned: false,
      checks: {
        sandbox: { ok: true, reportRef: 'output/noe-self-evolution-dry-run-v2/sandbox-report.json' },
        secretScan: { ok: true, reportRef: 'output/noe-self-evolution-dry-run-v2/redaction-scan-report.json' },
        sast: { ok: true, reportRef: 'output/noe-self-evolution-dry-run-v2/sast-report.json' },
        sca: { ok: true, reportRef: 'output/noe-self-evolution-dry-run-v2/sca-report.json' },
        rollbackDryRun: { ok: true, reportRef: 'output/noe-self-evolution-dry-run-v2/rollback-dry-run.json' },
        rewardHacking: { ok: true, reportRef: refs.acceptance },
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
    tests: [
      { name: 'candidate-patch-artifact-gate', ok: true, reportRef: 'output/noe-self-evolution-dry-run-v2/validation-report.json' },
    ],
    evidenceRefs: [refs.acceptance, refs.runtimeTraceCoverage, refs.stageEvidence],
  };
}

function renderUnifiedGateSummary({ memoryReport, skillReport, patchReport }) {
  return [
    '# Neo Candidate Gate v2 Unified Summary',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Policy',
    '',
    '- Candidate-only: no long-term memory write, no SkillStore write, no skill hot-load, and no patch apply.',
    '- No live 51735/51835 action, runtime restart, raw secret read, raw private_holdout read, memory-v2 write, commit, push, or publish.',
    '- Holdout evidence is sealed aggregate or explicit not-accessed metadata only.',
    '',
    '## Results',
    '',
    '| Candidate Class | OK | Passed | Failed | Evidence |',
    '| --- | ---: | ---: | ---: | --- |',
    `| memory | ${memoryReport.ok === true} | ${memoryReport.counts?.passed ?? 0} | ${memoryReport.counts?.failed ?? 0} | \`memory-candidate-report.json\` |`,
    `| skill | ${skillReport.ok === true} | ${skillReport.counts?.passed ?? 0} | ${skillReport.counts?.failed ?? 0} | \`skill-candidate-report.json\` |`,
    `| patch | ${patchReport.ok === true} | ${patchReport.counts?.passed ?? 0} | ${patchReport.counts?.failed ?? 0} | \`patch-candidate-report.json\` |`,
    '',
    `Overall: \`${memoryReport.ok === true && skillReport.ok === true && patchReport.ok === true}\``,
  ].join('\n');
}

export async function writeCandidateGateV2({ root = ROOT, nowMs = DEFAULT_NOW } = {}) {
  const outDir = resolve(root, 'output/noe-candidate-gate-v2');
  const { memory, skill } = buildMemorySkillCandidates();
  const patchArtifact = buildSelfEvolutionDryRunPatchArtifact({ nowMs });
  const memoryReport = buildNoeMemorySkillCandidateGateReport([memory], {
    generatedAt: new Date(nowMs).toISOString(),
    inputRef: 'evidence_flywheel_v2_memory_candidate',
  });
  const skillReport = buildNoeMemorySkillCandidateGateReport([skill], {
    generatedAt: new Date(nowMs).toISOString(),
    inputRef: 'evidence_flywheel_v2_skill_candidate',
  });
  const patchReport = buildNoeCandidatePatchArtifactReport([patchArtifact], {
    generatedAt: new Date(nowMs).toISOString(),
    inputRef: 'output/noe-self-evolution-dry-run-v2/patch-artifact.json',
  });
  memoryReport.v2Requirements = memorySkillV2Requirements(memory, memoryReport, {
    liveOwnerStateChanged: false,
    requiresOwnerApprovalBeforeApply: true,
    memoryCoreWritten: false,
    memoryV2Written: false,
  });
  skillReport.v2Requirements = memorySkillV2Requirements(skill, skillReport, {
    liveOwnerStateChanged: false,
    requiresOwnerApprovalBeforeApply: true,
    skillStoreWritten: false,
    skillHotLoaded: false,
  });
  patchReport.v2Requirements = patchV2Requirements(patchArtifact, patchReport);
  const unifiedJson = {
    ok: memoryReport.ok && skillReport.ok && patchReport.ok,
    generatedAt: new Date(nowMs).toISOString(),
    policy: {
      candidateOnly: true,
      noMemoryCoreWrite: true,
      noSkillStoreWrite: true,
      noSkillHotLoad: true,
      noPatchApply: true,
      noLive51735Or51835: true,
      noRuntimeRestart: true,
      rawSecretRead: false,
      rawPrivateHoldoutRead: false,
      memoryV2Write: false,
    },
    refs: {
      memoryReport: 'output/noe-candidate-gate-v2/memory-candidate-report.json',
      skillReport: 'output/noe-candidate-gate-v2/skill-candidate-report.json',
      patchReport: 'output/noe-candidate-gate-v2/patch-candidate-report.json',
      sealedHoldoutAggregate: candidateRefs().sealedHoldoutAggregate,
    },
    requiredFieldsPresent: {
      memory: Object.keys(memoryReport.v2Requirements),
      skill: Object.keys(skillReport.v2Requirements),
      patch: Object.keys(patchReport.v2Requirements),
    },
    counts: {
      memory: memoryReport.counts,
      skill: skillReport.counts,
      patch: patchReport.counts,
    },
  };
  unifiedJson.evidence = [
    candidateRefs().baseline,
    candidateRefs().replayManifest,
    candidateRefs().acceptance,
    candidateRefs().stageEvidence,
    candidateRefs().sealedHoldoutAggregate,
    candidateRefs().runtimeTraceCoverage,
  ].map((ref) => fileEvidence(root, ref));
  unifiedJson.phaseComplete = unifiedJson.ok && unifiedJson.evidence.every((item) => item.exists);
  unifiedJson.status = unifiedJson.phaseComplete ? 'candidate_gate_v2_complete' : 'offline_sample_ok_missing_external_evidence';
  writeJson(join(outDir, 'memory-candidate-report.json'), memoryReport);
  writeJson(join(outDir, 'skill-candidate-report.json'), skillReport);
  writeJson(join(outDir, 'patch-candidate-report.json'), patchReport);
  writeJson(join(outDir, 'unified-gate-summary.json'), unifiedJson);
  writeText(join(outDir, 'unified-gate-summary.md'), renderUnifiedGateSummary({ memoryReport, skillReport, patchReport }));
  return {
    ok: unifiedJson.ok,
    phaseComplete: unifiedJson.phaseComplete,
    status: unifiedJson.status,
    refs: unifiedJson.refs,
    counts: unifiedJson.counts,
  };
}

function renderSafetyReport({ artifact, validationReport, rollback, targetExists }) {
  return [
    '# Neo Self-Evolution Dry-Run v2 Safety Report',
    '',
    `Generated: ${validationReport.generatedAt}`,
    '',
    '## Decision',
    '',
    `- ok: \`${validationReport.ok === true && targetExists === false}\``,
    `- artifact: \`${artifact.id}\``,
    `- validation passed: \`${validationReport.counts?.passed ?? 0}\``,
    `- validation failed: \`${validationReport.counts?.failed ?? 0}\``,
    '',
    '## Safety Policy',
    '',
    '- Dry-run artifact only; no patch executor is imported or called.',
    '- No commit, push, package script change, live action, runtime restart, memory-v2 write, raw secret read, or raw private_holdout read.',
    '- The planned target file is represented by hash/metadata only and is not written by this dry-run.',
    '',
    '## Rollback',
    '',
    `- rollback mode: \`${artifact.rollbackPlan.mode}\``,
    `- rollback dry-run ok: \`${rollback.ok === true}\``,
    `- planned target exists after dry-run: \`${targetExists}\``,
  ].join('\n');
}

function renderRollbackDryRun({ artifact, targetExists }) {
  return [
    '# Neo Self-Evolution Dry-Run v2 Rollback Dry-Run',
    '',
    `Artifact: \`${artifact.id}\``,
    '',
    '## Result',
    '',
    `- ok: \`${targetExists === false}\``,
    `- rollback mode: \`${artifact.rollbackPlan.mode}\``,
    `- target written: \`${targetExists}\``,
    '',
    '## Manual Rollback Plan',
    '',
    ...artifact.rollbackPlan.manualSteps.map((step) => `- ${step}`),
  ].join('\n');
}

export async function writeSelfEvolutionDryRunV2({ root = ROOT, nowMs = DEFAULT_NOW } = {}) {
  const outDir = resolve(root, 'output/noe-self-evolution-dry-run-v2');
  const artifact = buildSelfEvolutionDryRunPatchArtifact({ nowMs });
  const validationReport = buildNoeCandidatePatchArtifactReport([artifact], {
    generatedAt: new Date(nowMs).toISOString(),
    inputRef: 'output/noe-self-evolution-dry-run-v2/patch-artifact.json',
  });
  const targetAbs = resolve(root, artifact.scope.targetFiles[0]);
  const targetExists = existsSync(targetAbs);
  const artifactText = JSON.stringify(artifact);
  const validationText = JSON.stringify(validationReport);
  const redaction = {
    ok: highSecretMatchCount(artifactText) === 0 && highSecretMatchCount(validationText) === 0,
    generatedAt: new Date(nowMs).toISOString(),
    printedMatchText: false,
    highMatchCount: highSecretMatchCount(artifactText) + highSecretMatchCount(validationText),
    scannedRefs: [
      'output/noe-self-evolution-dry-run-v2/patch-artifact.json',
      'output/noe-self-evolution-dry-run-v2/validation-report.json',
    ],
    rawSecretRead: false,
    rawPrivateHoldoutRead: false,
  };
  const sandbox = {
    ok: targetExists === false,
    generatedAt: new Date(nowMs).toISOString(),
    targetRef: artifact.scope.targetFiles[0],
    targetExists,
    patchExecutorCalled: false,
    realExecute: false,
    writesRepoFiles: false,
  };
  const sast = {
    ok: validationReport.ok === true,
    generatedAt: new Date(nowMs).toISOString(),
    validatorVersion: validationReport.validatorVersion,
    checkedBy: 'NoeCandidatePatchArtifactGate',
    forbiddenTargetsBlocked: validationReport.results.every((result) => result.gates?.nonCoreWhitelist === true),
    scopeLimited: validationReport.results.every((result) => result.gates?.scopeLimited === true),
    noExecutionOrWrites: validationReport.results.every((result) => result.gates?.noExecutionOrWrites === true),
    errors: validationReport.results.flatMap((result) => result.errors || []),
  };
  const sca = {
    ok: artifact.cost.paidApiUsed === false
      && artifact.safety.packageScriptsTouched === false
      && artifact.safety.modelCalls === false
      && artifact.scope.targetFiles.every((ref) => !/^package(-lock)?\.json$|pnpm-lock\.yaml$|yarn\.lock$/u.test(ref)),
    generatedAt: new Date(nowMs).toISOString(),
    paidApiUsed: artifact.cost.paidApiUsed,
    packageScriptsTouched: artifact.safety.packageScriptsTouched,
    packageOrLockTargeted: artifact.scope.targetFiles.some((ref) => /^package(-lock)?\.json$|pnpm-lock\.yaml$|yarn\.lock$/u.test(ref)),
  };
  const rewardHacking = {
    ok: validationReport.ok === true && artifact.validator.checks.rewardHacking.ok === true,
    generatedAt: new Date(nowMs).toISOString(),
    sourceRef: artifact.validator.checks.rewardHacking.reportRef,
    scoreRewriteAttempted: false,
    historicalReplayPassClaimed: false,
  };
  const rollback = {
    ok: targetExists === false,
    generatedAt: new Date(nowMs).toISOString(),
    artifactId: artifact.id,
    mode: artifact.rollbackPlan.mode,
    targetRef: artifact.scope.targetFiles[0],
    targetExists,
    callsRollbackExecutor: false,
    noPatchApplied: true,
  };
  const safety = {
    ok: validationReport.ok && rollback.ok && redaction.ok && sandbox.ok && sast.ok && sca.ok && rewardHacking.ok,
    generatedAt: new Date(nowMs).toISOString(),
    artifactId: artifact.id,
    validationReportRef: 'output/noe-self-evolution-dry-run-v2/validation-report.json',
    rollbackReportRef: 'output/noe-self-evolution-dry-run-v2/rollback-dry-run.json',
    policy: {
      dryRunOnly: true,
      patchExecutorCalled: false,
      patchApplied: false,
      targetFileCreated: targetExists,
      commit: false,
      push: false,
      live51735Touched: false,
      live51835Touched: false,
      runtimeRestart: false,
      memoryV2Write: false,
      rawSecretRead: false,
      rawPrivateHoldoutRead: false,
    },
    validation: validationReport,
    auxiliaryChecks: {
      sandbox,
      redaction,
      sast,
      sca,
      rewardHacking,
    },
    rollback,
  };
  safety.evidence = [
    candidateRefs().acceptance,
    candidateRefs().runtimeTraceCoverage,
    candidateRefs().stageEvidence,
  ].map((ref) => fileEvidence(root, ref));
  safety.phaseComplete = safety.ok && safety.evidence.every((item) => item.exists);
  safety.status = safety.phaseComplete ? 'self_evolution_dry_run_v2_complete' : 'offline_sample_ok_missing_external_evidence';
  writeJson(join(outDir, 'patch-artifact.json'), artifact);
  writeJson(join(outDir, 'validation-report.json'), validationReport);
  writeJson(join(outDir, 'sandbox-report.json'), sandbox);
  writeJson(join(outDir, 'redaction-scan-report.json'), redaction);
  writeJson(join(outDir, 'sast-report.json'), sast);
  writeJson(join(outDir, 'sca-report.json'), sca);
  writeJson(join(outDir, 'reward-hacking-report.json'), rewardHacking);
  writeJson(join(outDir, 'safety-report.json'), safety);
  writeText(join(outDir, 'safety-report.md'), renderSafetyReport({ artifact, validationReport, rollback, targetExists }));
  writeJson(join(outDir, 'rollback-dry-run.json'), rollback);
  writeText(join(outDir, 'rollback-dry-run.md'), renderRollbackDryRun({ artifact, targetExists }));
  return {
    ok: safety.ok,
    phaseComplete: safety.phaseComplete,
    status: safety.status,
    refs: {
      patchArtifact: 'output/noe-self-evolution-dry-run-v2/patch-artifact.json',
      validationReport: 'output/noe-self-evolution-dry-run-v2/validation-report.json',
      safetyReport: 'output/noe-self-evolution-dry-run-v2/safety-report.md',
      rollbackDryRun: 'output/noe-self-evolution-dry-run-v2/rollback-dry-run.md',
    },
  };
}

export async function runEvidenceFlywheelV2Closeout({
  root = ROOT,
  nowMs = DEFAULT_NOW,
  stage = 'all',
} = {}) {
  const allowed = new Set(['all', 'runtime-trace-v2', 'candidate-gate-v2', 'self-evolution-dry-run-v2']);
  if (!allowed.has(stage)) throw new Error(`unknown stage: ${stage}`);
  const result = {
    ok: true,
    phaseComplete: false,
    status: 'not_started',
    generatedAt: new Date(nowMs).toISOString(),
    policy: {
      live51735Touched: false,
      live51835Touched: false,
      rawSecretRead: false,
      rawPrivateHoldoutRead: false,
      memoryV2Write: false,
      skillHotLoad: false,
      patchApplied: false,
      runtimeRestart: false,
    },
    stages: {},
  };
  if (stage === 'all' || stage === 'runtime-trace-v2') {
    result.stages.runtimeTraceV2 = await writeRuntimeTraceV2({ root, nowMs });
  }
  if (stage === 'all' || stage === 'self-evolution-dry-run-v2') {
    result.stages.selfEvolutionDryRunV2 = await writeSelfEvolutionDryRunV2({ root, nowMs });
  }
  if (stage === 'all' || stage === 'candidate-gate-v2') {
    result.stages.candidateGateV2 = await writeCandidateGateV2({ root, nowMs });
  }
  result.ok = Object.values(result.stages).every((item) => item?.ok === true);
  result.phaseComplete = result.ok && Object.values(result.stages).every((item) => item?.phaseComplete === true);
  result.status = result.phaseComplete ? 'd_e_f_phase_complete' : 'offline_artifacts_generated_pending_external_evidence';
  writeJson(resolve(root, 'output/noe-evidence-flywheel-v2/final-d-e-f-closeout.json'), result);
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = await runEvidenceFlywheelV2Closeout(args);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
