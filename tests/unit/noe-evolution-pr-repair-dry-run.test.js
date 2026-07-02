import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  buildNoeEvolutionPrRepairDryRunReport,
  evaluateNoeEvolutionPrRepairDryRunRecord,
  NOE_EVOLUTION_PR_REPAIR_DRY_RUN_KIND,
  NOE_EVOLUTION_PR_REPAIR_DRY_RUN_VALIDATOR_VERSION,
  sha256Text,
} from '../../src/candidates/NoeEvolutionPrRepairDryRun.js';
import { NOE_CANDIDATE_PATCH_VALIDATOR_VERSION } from '../../src/candidates/NoeCandidatePatchArtifactGate.js';
import { NOE_EVOLUTION_ARCHIVE_DRY_RUN_VALIDATOR_VERSION } from '../../src/candidates/NoeEvolutionArchiveDryRun.js';
import { NOE_EVOLUTION_SCORECARD_DRY_RUN_VALIDATOR_VERSION } from '../../src/candidates/NoeEvolutionScorecardDryRun.js';
import { main as runPrRepairDryRun } from '../../scripts/noe-evolution-pr-repair-dry-run.mjs';

function reportRef(name) {
  return `output/noe-pr-repair-dry-run/${name}`;
}

function safeRecord(overrides = {}) {
  const patchRef = 'output/noe-candidate-patches/dry-run/latest.json';
  const draftRef = reportRef('draft-pr-description.md');
  const validationRef = reportRef('validation-report.json');
  const rollbackRef = reportRef('rollback-plan.json');
  const riskRef = reportRef('risk-report.json');
  return {
    kind: NOE_EVOLUTION_PR_REPAIR_DRY_RUN_KIND,
    schemaVersion: 1,
    id: 'pr-repair-dry-run-unit-001',
    createdAt: '2026-06-19T00:00:00.000Z',
    parentId: 'pr-parent-unit',
    childId: 'pr-child-unit',
    generation: 1,
    candidateRef: patchRef,
    archiveReportRef: 'output/noe-evolution-archive-dry-run/latest.json',
    scorecardReportRef: 'output/noe-evolution-scorecard-dry-run/latest.json',
    holdoutRef: 'private_holdout:not_accessed',
    branch: {
      proposedName: 'codex/noe-pr-repair-dry-run-unit',
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
    evidenceRefs: [reportRef('evidence.md')],
    ...overrides,
  };
}

function writeJson(ref, value) {
  const file = resolve(process.cwd(), ref);
  mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function ensureUpstreamReports({
  candidateRef = 'output/noe-candidate-patches/unit/latest.json',
  archiveRef = 'output/noe-evolution-archive-dry-run/unit-upstream/latest.json',
  scorecardRef = 'output/noe-evolution-scorecard-dry-run/unit-upstream/latest.json',
  candidateOk = true,
} = {}) {
  writeJson(candidateRef, { ok: candidateOk, validatorVersion: NOE_CANDIDATE_PATCH_VALIDATOR_VERSION, schemaVersion: 1 });
  writeJson(archiveRef, { ok: true, validatorVersion: NOE_EVOLUTION_ARCHIVE_DRY_RUN_VALIDATOR_VERSION, schemaVersion: 1 });
  writeJson(scorecardRef, { ok: true, validatorVersion: NOE_EVOLUTION_SCORECARD_DRY_RUN_VALIDATOR_VERSION, schemaVersion: 1 });
}

describe('NoeEvolutionPrRepairDryRun', () => {
  it('accepts metadata-only PR repair dry-run records', () => {
    const result = evaluateNoeEvolutionPrRepairDryRunRecord(safeRecord());

    expect(result).toMatchObject({
      ok: true,
      id: 'pr-repair-dry-run-unit-001',
      gates: {
        branchSafe: true,
        dryRunOnly: true,
        noGitOrPublish: true,
        validator: true,
      },
      summary: {
        branch: 'codex/noe-pr-repair-dry-run-unit',
        verdict: 'dry_run_ready',
        readyForHumanReview: true,
      },
    });
  });

  it('requires protocol fields', () => {
    const result = evaluateNoeEvolutionPrRepairDryRunRecord({});

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'pr_repair_kind_unsupported',
      'pr_repair_schema_version_unsupported',
      'pr_repair_id_required',
      'pr_repair_created_at_required',
      'pr_repair_parent_id_required',
      'pr_repair_child_id_required',
      'pr_repair_branch_required',
      'pr_repair_artifacts_required',
      'pr_repair_cost_required',
      'pr_repair_result_required',
      'pr_repair_policy_required',
      'pr_repair_validator_required',
      'pr_repair_holdout_ref_must_be_not_accessed',
    ]));
  });

  it('rejects git/publish/apply claims and blocked ready mismatches', () => {
    const record = safeRecord({
      branch: {
        ...safeRecord().branch,
        proposedName: 'feature/unsafe',
        branchCreated: true,
        existingBranchChecked: true,
      },
      result: {
        ...safeRecord().result,
        branchCreated: true,
        patchApplied: true,
        prOpened: true,
        externalPublished: true,
        committed: true,
        pushed: true,
      },
      policy: {
        ...safeRecord().policy,
        noGitBranchCreate: false,
        noExternalPublish: false,
      },
      validator: {
        ...safeRecord().validator,
        blockers: ['manual review required'],
        checks: {
          ...safeRecord().validator.checks,
          publishDryRun: { ok: false, reportRef: reportRef('publish-dry-run.json') },
        },
      },
    });
    const result = evaluateNoeEvolutionPrRepairDryRunRecord(record);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'pr_repair_branch_name_invalid',
      'pr_repair_branch_created_forbidden',
      'pr_repair_existing_branch_check_forbidden',
      'pr_repair_result_flag_false_required:branchCreated',
      'pr_repair_result_flag_false_required:patchApplied',
      'pr_repair_result_flag_false_required:prOpened',
      'pr_repair_result_flag_false_required:externalPublished',
      'pr_repair_result_flag_false_required:committed',
      'pr_repair_result_flag_false_required:pushed',
      'pr_repair_policy_required:noGitBranchCreate',
      'pr_repair_policy_required:noExternalPublish',
      'pr_repair_validator_check_failed:publishDryRun',
      'pr_repair_ready_verdict_mismatch',
    ]));
  });

  it('rejects sensitive refs, forbidden paths, and whitespace normalization', () => {
    const result = evaluateNoeEvolutionPrRepairDryRunRecord(safeRecord({
      id: ' pr-repair-dry-run-unit-001 ',
      candidateRef: 'package.json',
      archiveReportRef: 'output/noe-evolution-archive-dry-run/latest.json ',
      scorecardReportRef: 'src/eval/NeoEvalSchema.js',
      artifacts: {
        ...safeRecord().artifacts,
        draftPrDescriptionRef: 'evals/neo/private_holdout/draft.md',
      },
      evidenceRefs: [' output/noe-pr-repair-dry-run/evidence.md '],
    }));

    expect(result.ok).toBe(false);
    expect(result.id).toBe('');
    expect(result.errors).toEqual(expect.arrayContaining([
      'pr_repair_id_invalid',
      'pr_repair_candidate_ref_forbidden',
      'pr_repair_candidate_ref_output_scope_required',
      'pr_repair_candidate_ref_scope_required',
      'pr_repair_archive_report_ref_forbidden',
      'pr_repair_scorecard_report_ref_forbidden',
      'pr_repair_scorecard_report_ref_output_scope_required',
      'pr_repair_scorecard_report_ref_scope_required',
      'pr_repair_draft_pr_ref_forbidden',
      'pr_repair_draft_pr_ref_output_scope_required',
      'pr_repair_evidence_ref_forbidden',
      'pr_repair_evidence_ref_output_scope_required',
      'pr_repair_ref_forbidden',
    ]));
  });

  it('requires artifact and validator check refs to match the verified upstream refs', () => {
    const alternateCandidateRef = 'output/noe-candidate-patches/unit-alternate/latest.json';
    const alternateArchiveRef = 'output/noe-evolution-archive-dry-run/unit-alternate/latest.json';
    const alternateScorecardRef = 'output/noe-evolution-scorecard-dry-run/unit-alternate/latest.json';
    const result = evaluateNoeEvolutionPrRepairDryRunRecord(safeRecord({
      artifacts: {
        ...safeRecord().artifacts,
        patchArtifactRef: alternateCandidateRef,
        patchArtifactSha256: sha256Text(alternateCandidateRef),
      },
      validator: {
        ...safeRecord().validator,
        checks: {
          ...safeRecord().validator.checks,
          candidatePatchGate: { ok: true, reportRef: alternateCandidateRef },
          archiveDryRun: { ok: true, reportRef: alternateArchiveRef },
          scorecardDryRun: { ok: true, reportRef: alternateScorecardRef },
        },
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'pr_repair_patch_artifact_ref_mismatch',
      'pr_repair_candidate_check_ref_mismatch',
      'pr_repair_archive_check_ref_mismatch',
      'pr_repair_scorecard_check_ref_mismatch',
    ]));
  });

  it('rejects body-like values hidden in ids, branch, and refs without echoing them in reports', () => {
    const payload = 'RAW PR BODY SHOULD NOT BE IN REPORT';
    const report = buildNoeEvolutionPrRepairDryRunReport([safeRecord({
      kind: payload,
      id: payload,
      branch: {
        ...safeRecord().branch,
        proposedName: `codex/noe-pr\n${payload}`,
      },
      artifacts: {
        ...safeRecord().artifacts,
        draftPrDescriptionRef: `output/noe-pr-repair-dry-run/draft.md\n${payload}`,
      },
    })], { inputRef: `output/noe-pr-repair-dry-run/input.json\n${payload}` });

    expect(report.ok).toBe(false);
    expect(report.inputRef).toBe('unsafe_ref');
    expect(report.results[0].id).toBe('');
    expect(report.results[0].kind).toBe('');
    expect(report.results[0].summary.branch).toBe('');
    expect(report.results[0].errors).toEqual(expect.arrayContaining([
      'pr_repair_kind_unsupported',
      'pr_repair_id_invalid',
      'pr_repair_branch_name_invalid',
      'pr_repair_draft_pr_ref_forbidden',
      'pr_repair_ref_forbidden',
    ]));
    expect(JSON.stringify(report)).not.toContain(payload);
  });

  it('CLI writes only dry-run reports', () => {
    const candidateRef = 'output/noe-candidate-patches/unit/latest.json';
    const archiveRef = 'output/noe-evolution-archive-dry-run/unit-upstream/latest.json';
    const scorecardRef = 'output/noe-evolution-scorecard-dry-run/unit-upstream/latest.json';
    ensureUpstreamReports({ candidateRef, archiveRef, scorecardRef });
    const record = safeRecord({
      candidateRef,
      archiveReportRef: archiveRef,
      scorecardReportRef: scorecardRef,
      artifacts: {
        ...safeRecord().artifacts,
        patchArtifactRef: candidateRef,
        patchArtifactSha256: sha256Text(candidateRef),
      },
      validator: {
        ...safeRecord().validator,
        checks: {
          ...safeRecord().validator.checks,
          candidatePatchGate: { ok: true, reportRef: candidateRef },
          archiveDryRun: { ok: true, reportRef: archiveRef },
          scorecardDryRun: { ok: true, reportRef: scorecardRef },
        },
      },
    });
    const recordRef = 'output/noe-pr-repair-dry-run/unit/good-upstream-record.json';
    writeJson(recordRef, record);

    runPrRepairDryRun(['--record-file', recordRef, '--out-dir', 'output/noe-pr-repair-dry-run/unit']);
    const root = resolve(process.cwd());
    const latest = join(root, 'output/noe-pr-repair-dry-run/unit/latest.json');
    const liveArchive = join(root, 'output/noe-pr-repair-dry-run/unit/archive.jsonl');
    const report = JSON.parse(readFileSync(latest, 'utf8'));

    expect(report.ok).toBe(true);
    expect(report.policy.verifiesUpstreamReports).toBe(true);
    expect(report.policy.doesNotCreateBranch).toBe(true);
    expect(report.policy.doesNotOpenPr).toBe(true);
    expect(existsSync(liveArchive)).toBe(false);
  });

  it('CLI rejects bad upstream gate reports without reading outside output', () => {
    const candidateRef = 'output/noe-candidate-patches/unit-bad/latest.json';
    const archiveRef = 'output/noe-evolution-archive-dry-run/unit-bad/latest.json';
    const scorecardRef = 'output/noe-evolution-scorecard-dry-run/unit-bad/latest.json';
    ensureUpstreamReports({ candidateRef, archiveRef, scorecardRef, candidateOk: false });
    const record = safeRecord({
      candidateRef,
      archiveReportRef: archiveRef,
      scorecardReportRef: scorecardRef,
      artifacts: {
        ...safeRecord().artifacts,
        patchArtifactRef: candidateRef,
        patchArtifactSha256: sha256Text(candidateRef),
      },
      validator: {
        ...safeRecord().validator,
        checks: {
          ...safeRecord().validator.checks,
          candidatePatchGate: { ok: true, reportRef: candidateRef },
          archiveDryRun: { ok: true, reportRef: archiveRef },
          scorecardDryRun: { ok: true, reportRef: scorecardRef },
        },
      },
    });
    const recordRef = 'output/noe-pr-repair-dry-run/unit/bad-upstream-record.json';
    writeJson(recordRef, record);

    runPrRepairDryRun(['--record-file', recordRef, '--out-dir', 'output/noe-pr-repair-dry-run/unit-bad']);
    const report = JSON.parse(readFileSync(resolve(process.cwd(), 'output/noe-pr-repair-dry-run/unit-bad/latest.json'), 'utf8'));

    expect(report.ok).toBe(false);
    expect(report.results[0].gates.upstreamReports).toBe(false);
    expect(report.results[0].errors).toContain('pr_repair_upstream_candidate_report_not_ok');
  });

  it('CLI rejects sensitive inputs, output escapes, unknown flags, and symlinked output dirs', () => {
    const root = resolve(process.cwd());
    const tempRoot = mkdtempSync(join(tmpdir(), 'noe-pr-repair-dry-run-'));
    const outRoot = join(root, 'output/noe-pr-repair-dry-run');
    const outLink = join(outRoot, 'unit-out-link');
    mkdirSync(outRoot, { recursive: true, mode: 0o700 });
    rmSync(outLink, { recursive: true, force: true });
    symlinkSync(tempRoot, outLink, 'dir');

    try {
      expect(() => runPrRepairDryRun(['--record-file', '.env.local']))
        .toThrow(/forbidden sensitive path/);
      expect(() => runPrRepairDryRun(['--record-file', 'evals/neo/private_holdout/pr.json']))
        .toThrow(/forbidden sensitive path/);
      expect(() => runPrRepairDryRun(['--record-file', 'package.json']))
        .toThrow(/forbidden dry-run path/);
      expect(() => runPrRepairDryRun(['--record-file', 'package-lock.json']))
        .toThrow(/forbidden dry-run path/);
      expect(() => runPrRepairDryRun(['--record-file', 'src/eval/NeoEvalSchema.js']))
        .toThrow(/forbidden dry-run path/);
      expect(() => runPrRepairDryRun(['--record-file', ' output/noe-pr-repair-dry-run/latest.json ']))
        .toThrow(/forbidden dry-run path/);
      expect(() => runPrRepairDryRun(['--record-file', 'output/noe-pr-repair-dry-run/input.json\nRAW PR BODY']))
        .toThrow(/forbidden dry-run path/);
      expect(() => runPrRepairDryRun(['--out-dir', 'docs/noe-pr-repair-dry-run']))
        .toThrow(/must stay under output/);
      expect(() => runPrRepairDryRun(['--unknown']))
        .toThrow(/unknown argument/);
      expect(() => runPrRepairDryRun(['--out-dir', 'output/noe-pr-repair-dry-run/unit-out-link']))
        .toThrow(/symlink|outside output/);
    } finally {
      rmSync(outLink, { recursive: true, force: true });
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
