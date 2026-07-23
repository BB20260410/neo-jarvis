import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  buildNoePlanValidatorDryRunReport,
  evaluateNoePlanValidatorDryRunRecord,
  NOE_PLAN_VALIDATOR_DRY_RUN_KIND,
  NOE_PLAN_VALIDATOR_DRY_RUN_VALIDATOR_VERSION,
  sha256Text,
} from '../../src/candidates/NoePlanValidatorDryRun.js';
import { NOE_CANDIDATE_PATCH_VALIDATOR_VERSION } from '../../src/candidates/NoeCandidatePatchArtifactGate.js';
import { NOE_EVOLUTION_ARCHIVE_DRY_RUN_VALIDATOR_VERSION } from '../../src/candidates/NoeEvolutionArchiveDryRun.js';
import { NOE_EVOLUTION_PR_REPAIR_DRY_RUN_VALIDATOR_VERSION } from '../../src/candidates/NoeEvolutionPrRepairDryRun.js';
import { NOE_EVOLUTION_SCORECARD_DRY_RUN_VALIDATOR_VERSION } from '../../src/candidates/NoeEvolutionScorecardDryRun.js';
import { main as runPlanValidatorDryRun } from '../../scripts/noe-plan-validator-dry-run.mjs';

function reportRef(name) {
  return `output/noe-plan-validator-dry-run/${name}`;
}

function sourceReportRef(name = 'source.json') {
  return `output/noe-plan-validator-dry-run/unit/${name}`;
}

function safeRecord(overrides = {}) {
  const planRef = 'output/noe-pr-repair-dry-run/latest.json';
  const sources = [sourceReportRef('source-a.json'), sourceReportRef('source-b.json')];
  return {
    kind: NOE_PLAN_VALIDATOR_DRY_RUN_KIND,
    schemaVersion: 1,
    id: 'plan-validator-dry-run-unit-001',
    createdAt: '2026-06-19T00:00:00.000Z',
    planKind: 'pr_repair',
    planRef,
    planSha256: sha256Text(planRef),
    sourceReportRefs: sources,
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
    ...overrides,
  };
}

function writeJson(ref, value) {
  const file = resolve(process.cwd(), ref);
  mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function ensureSourceReports(refs, { ok = true } = {}) {
  for (const ref of refs) {
    const extra = ref.startsWith('output/noe-plan-validator-dry-run/')
      ? { validatorVersion: NOE_PLAN_VALIDATOR_DRY_RUN_VALIDATOR_VERSION }
      : {};
    writeJson(ref, { ok, schemaVersion: 1, ...extra });
  }
}

describe('NoePlanValidatorDryRun', () => {
  it('accepts metadata-only plan validator records', () => {
    const result = evaluateNoePlanValidatorDryRunRecord(safeRecord());

    expect(result).toMatchObject({
      ok: true,
      id: 'plan-validator-dry-run-unit-001',
      gates: {
        dryRunOnly: true,
        noExecution: true,
        validator: true,
      },
      summary: {
        planKind: 'pr_repair',
        verdict: 'plan_review_ready',
        readyAfterGate: true,
      },
    });
  });

  it('requires protocol fields', () => {
    const result = evaluateNoePlanValidatorDryRunRecord({});

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'plan_validator_kind_unsupported',
      'plan_validator_schema_version_unsupported',
      'plan_validator_id_required',
      'plan_validator_created_at_required',
      'plan_validator_plan_kind_invalid',
      'plan_validator_intended_stage_invalid',
      'plan_validator_plan_ref_required',
      'plan_validator_plan_sha_invalid',
      'plan_validator_source_report_refs_required',
      'plan_validator_refs_required',
      'plan_validator_policy_required',
      'plan_validator_result_required',
      'plan_validator_validator_required',
    ]));
  });

  it('rejects execution claims and missing policy boundaries', () => {
    const result = evaluateNoePlanValidatorDryRunRecord(safeRecord({
      policy: {
        ...safeRecord().policy,
        noPlanExecution: false,
        noGit: false,
        noGraphMemoryWrite: false,
      },
      result: {
        ...safeRecord().result,
        executed: true,
        committed: true,
      },
      validator: {
        ...safeRecord().validator,
        blockers: ['manual review required'],
        checks: {
          ...safeRecord().validator.checks,
          noExecution: { ok: false, reportRef: reportRef('no-execution.json') },
        },
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'plan_validator_policy_required:noPlanExecution',
      'plan_validator_policy_required:noGit',
      'plan_validator_policy_required:noGraphMemoryWrite',
      'plan_validator_result_flag_false_required:executed',
      'plan_validator_result_flag_false_required:committed',
      'plan_validator_check_failed:noExecution',
      'plan_validator_ready_verdict_mismatch',
    ]));
  });

  it('rejects sensitive refs, forbidden paths, and whitespace normalization', () => {
    const result = evaluateNoePlanValidatorDryRunRecord(safeRecord({
      id: ' plan-validator-dry-run-unit-001 ',
      planRef: 'package.json',
      sourceReportRefs: ['evals/neo/private_holdout/source.json'],
      rollbackRef: 'output/noe-plan-validator-dry-run/rollback.json ',
      refs: {
        ...safeRecord().refs,
        evalReportRef: 'src/eval/NeoEvalSchema.js',
      },
      evidenceRefs: [' output/noe-plan-validator-dry-run/evidence.md '],
    }));

    expect(result.ok).toBe(false);
    expect(result.id).toBe('');
    expect(result.errors).toEqual(expect.arrayContaining([
      'plan_validator_id_invalid',
      'plan_validator_plan_ref_forbidden',
      'plan_validator_plan_ref_output_scope_required',
      'plan_validator_source_report_ref_forbidden',
      'plan_validator_source_report_ref_output_scope_required',
      'plan_validator_rollback_ref_forbidden',
      'plan_validator_ref:evalReportRef_forbidden',
      'plan_validator_ref:evalReportRef_output_scope_required',
      'plan_validator_evidence_ref_forbidden',
      'plan_validator_evidence_ref_output_scope_required',
      'plan_validator_ref_forbidden',
    ]));
  });

  it('rejects body-like values hidden in ids and refs without echoing them in reports', () => {
    const payload = 'RAW PLAN BODY SHOULD NOT BE IN REPORT';
    const report = buildNoePlanValidatorDryRunReport([safeRecord({
      kind: payload,
      id: payload,
      planRef: `output/noe-plan-validator-dry-run/plan.json\n${payload}`,
    })], { inputRef: `output/noe-plan-validator-dry-run/input.json\n${payload}` });

    expect(report.ok).toBe(false);
    expect(report.inputRef).toBe('unsafe_ref');
    expect(report.results[0].id).toBe('');
    expect(report.results[0].kind).toBe('');
    expect(report.results[0].errors).toEqual(expect.arrayContaining([
      'plan_validator_kind_unsupported',
      'plan_validator_id_invalid',
      'plan_validator_plan_ref_forbidden',
      'plan_validator_ref_forbidden',
    ]));
    expect(JSON.stringify(report)).not.toContain(payload);
  });

  it('CLI writes only dry-run reports and verifies source reports', () => {
    const record = safeRecord();
    ensureSourceReports(record.sourceReportRefs);
    const recordRef = 'output/noe-plan-validator-dry-run/unit/record.json';
    writeJson(recordRef, record);
    runPlanValidatorDryRun(['--record-file', recordRef, '--out-dir', 'output/noe-plan-validator-dry-run/unit']);
    const latest = resolve(process.cwd(), 'output/noe-plan-validator-dry-run/unit/latest.json');
    const liveArchive = resolve(process.cwd(), 'output/noe-plan-validator-dry-run/unit/archive.jsonl');
    const report = JSON.parse(readFileSync(latest, 'utf8'));

    expect(report.ok).toBe(true);
    expect(report.policy.verifiesSourceReports).toBe(true);
    expect(report.policy.doesNotExecutePlan).toBe(true);
    expect(report.results[0].gates.sourceReportsVerified).toBe(true);
    expect(existsSync(liveArchive)).toBe(false);
  });

  it('CLI fails report when a source report is not ok', () => {
    const record = safeRecord({
      sourceReportRefs: [sourceReportRef('bad-source.json')],
    });
    ensureSourceReports(record.sourceReportRefs, { ok: false });
    const recordRef = 'output/noe-plan-validator-dry-run/unit/bad-source-record.json';
    writeJson(recordRef, record);
    runPlanValidatorDryRun(['--record-file', recordRef, '--out-dir', 'output/noe-plan-validator-dry-run/unit-bad-source']);
    const report = JSON.parse(readFileSync(resolve(process.cwd(), 'output/noe-plan-validator-dry-run/unit-bad-source/latest.json'), 'utf8'));

    expect(report.ok).toBe(false);
    expect(report.results[0].gates.sourceReportsVerified).toBe(false);
    expect(report.results[0].errors).toContain('plan_validator_source_report_not_ok');
  });

  it('CLI verifies validatorVersion for known dry-run source reports', () => {
    const knownFamilies = [
      {
        label: 'candidate-patch',
        sourceRef: 'output/noe-candidate-patches/unit-source/latest.json',
        refKey: 'candidatePatchReportRef',
        expectedVersion: NOE_CANDIDATE_PATCH_VALIDATOR_VERSION,
      },
      {
        label: 'archive',
        sourceRef: 'output/noe-evolution-archive-dry-run/unit-source/latest.json',
        refKey: 'archiveReportRef',
        expectedVersion: NOE_EVOLUTION_ARCHIVE_DRY_RUN_VALIDATOR_VERSION,
      },
      {
        label: 'scorecard',
        sourceRef: 'output/noe-evolution-scorecard-dry-run/unit-source/latest.json',
        refKey: 'scorecardReportRef',
        expectedVersion: NOE_EVOLUTION_SCORECARD_DRY_RUN_VALIDATOR_VERSION,
      },
      {
        label: 'pr-repair',
        sourceRef: 'output/noe-pr-repair-dry-run/unit-source/latest.json',
        refKey: 'prRepairReportRef',
        expectedVersion: NOE_EVOLUTION_PR_REPAIR_DRY_RUN_VALIDATOR_VERSION,
      },
      {
        label: 'plan-validator',
        sourceRef: 'output/noe-plan-validator-dry-run/unit-source/latest.json',
        refKey: 'boundaryReportRef',
        expectedVersion: NOE_PLAN_VALIDATOR_DRY_RUN_VALIDATOR_VERSION,
      },
    ];

    for (const family of knownFamilies) {
      writeJson(family.sourceRef, { ok: true, schemaVersion: 1, validatorVersion: 'wrong-validator' });
      const record = safeRecord({
        planRef: family.sourceRef,
        planSha256: sha256Text(family.sourceRef),
        sourceReportRefs: [family.sourceRef],
        refs: {
          ...safeRecord().refs,
          [family.refKey]: family.sourceRef,
        },
      });
      const recordRef = `output/noe-plan-validator-dry-run/unit/${family.label}-version-record.json`;
      writeJson(recordRef, record);
      runPlanValidatorDryRun(['--plan-file', recordRef, '--out-dir', `output/noe-plan-validator-dry-run/unit-${family.label}-version-mismatch`]);
      const mismatch = JSON.parse(readFileSync(resolve(process.cwd(), `output/noe-plan-validator-dry-run/unit-${family.label}-version-mismatch/latest.json`), 'utf8'));
      expect(mismatch.ok).toBe(false);
      expect(mismatch.results[0].errors).toContain('plan_validator_source_report_validator_version_mismatch');

      writeJson(family.sourceRef, { ok: true, schemaVersion: 1, validatorVersion: family.expectedVersion });
      runPlanValidatorDryRun(['--plan-file', recordRef, '--out-dir', `output/noe-plan-validator-dry-run/unit-${family.label}-version-match`]);
      const matched = JSON.parse(readFileSync(resolve(process.cwd(), `output/noe-plan-validator-dry-run/unit-${family.label}-version-match/latest.json`), 'utf8'));
      expect(matched.ok).toBe(true);
    }
  });

  it('CLI rejects sensitive inputs, output escapes, unknown flags, and symlinked output dirs', () => {
    const root = resolve(process.cwd());
    const tempRoot = mkdtempSync(join(tmpdir(), 'noe-plan-validator-dry-run-'));
    const outRoot = join(root, 'output/noe-plan-validator-dry-run');
    const outLink = join(outRoot, 'unit-out-link');
    mkdirSync(outRoot, { recursive: true, mode: 0o700 });
    rmSync(outLink, { recursive: true, force: true });
    symlinkSync(tempRoot, outLink, 'dir');

    try {
      expect(() => runPlanValidatorDryRun(['--record-file', '.env.local']))
        .toThrow(/forbidden sensitive path/);
      expect(() => runPlanValidatorDryRun(['--record-file', 'evals/neo/private_holdout/plan.json']))
        .toThrow(/forbidden sensitive path/);
      expect(() => runPlanValidatorDryRun(['--record-file', 'package.json']))
        .toThrow(/forbidden dry-run path/);
      expect(() => runPlanValidatorDryRun(['--record-file', 'package-lock.json']))
        .toThrow(/forbidden dry-run path/);
      expect(() => runPlanValidatorDryRun(['--record-file', 'src/eval/NeoEvalSchema.js']))
        .toThrow(/forbidden dry-run path/);
      expect(() => runPlanValidatorDryRun(['--record-file', ' output/noe-plan-validator-dry-run/latest.json ']))
        .toThrow(/forbidden dry-run path/);
      expect(() => runPlanValidatorDryRun(['--record-file', 'output/noe-plan-validator-dry-run/input.json\nRAW PLAN BODY']))
        .toThrow(/forbidden dry-run path/);
      expect(() => runPlanValidatorDryRun(['--out-dir', 'docs/noe-plan-validator-dry-run']))
        .toThrow(/must stay under output/);
      expect(() => runPlanValidatorDryRun(['--unknown']))
        .toThrow(/unknown argument/);
      expect(() => runPlanValidatorDryRun(['--out-dir', 'output/noe-plan-validator-dry-run/unit-out-link']))
        .toThrow(/symlink|outside output/);
    } finally {
      rmSync(outLink, { recursive: true, force: true });
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
