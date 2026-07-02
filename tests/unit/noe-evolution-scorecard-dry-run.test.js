import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  buildNoeEvolutionScorecardDryRunReport,
  evaluateNoeEvolutionScorecardDryRunRecord,
  NOE_EVOLUTION_SCORECARD_DRY_RUN_KIND,
  NOE_EVOLUTION_SCORECARD_DRY_RUN_VALIDATOR_VERSION,
} from '../../src/candidates/NoeEvolutionScorecardDryRun.js';
import { main as runScorecardDryRun } from '../../scripts/noe-evolution-scorecard-dry-run.mjs';

function objective(score, weight, threshold, evidenceRef) {
  return { score, weight, threshold, evidenceRef, status: score >= threshold ? 'passed' : 'failed' };
}

function safeRecord(overrides = {}) {
  return {
    kind: NOE_EVOLUTION_SCORECARD_DRY_RUN_KIND,
    schemaVersion: 1,
    id: 'scorecard-dry-run-unit-001',
    createdAt: '2026-06-19T00:00:00.000Z',
    parentId: 'score-parent-unit',
    childId: 'score-child-unit',
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
    ...overrides,
  };
}

describe('NoeEvolutionScorecardDryRun', () => {
  it('accepts metadata-only AgentBreeder scorecards', () => {
    const result = evaluateNoeEvolutionScorecardDryRunRecord(safeRecord());

    expect(result).toMatchObject({
      ok: true,
      id: 'scorecard-dry-run-unit-001',
      gates: {
        objectives: true,
        aggregate: true,
        dryRunOnly: true,
        validator: true,
      },
      summary: {
        overall: 0.927,
        passed: true,
        decision: 'review_candidate',
        rewardHackingRisk: 0,
      },
    });
  });

  it('requires protocol fields', () => {
    const result = evaluateNoeEvolutionScorecardDryRunRecord({});

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'scorecard_kind_unsupported',
      'scorecard_schema_version_unsupported',
      'scorecard_id_required',
      'scorecard_created_at_required',
      'scorecard_parent_id_required',
      'scorecard_child_id_required',
      'scorecard_candidate_ref_required',
      'scorecard_archive_report_ref_required',
      'scorecard_objectives_required',
      'scorecard_objective_directions_required',
      'scorecard_pareto_required',
      'scorecard_aggregate_required',
      'scorecard_cost_required',
      'scorecard_result_required',
      'scorecard_policy_required',
      'scorecard_validator_required',
    ]));
  });

  it('rejects incorrect aggregate math, thresholds, decisions, paid API, and model calls', () => {
    const result = evaluateNoeEvolutionScorecardDryRunRecord(safeRecord({
      objectives: {
        ...safeRecord().objectives,
        capability: { ...safeRecord().objectives.capability, score: 0.2, status: 'passed' },
        regression: { ...safeRecord().objectives.regression, weight: 0.5 },
        rewardHackingRisk: { ...safeRecord().objectives.rewardHackingRisk, score: 0.5, status: 'passed' },
      },
      objectiveDirections: {
        ...safeRecord().objectiveDirections,
        capability: 'min',
      },
      aggregate: {
        ...safeRecord().aggregate,
        overall: 1,
        passed: true,
        decision: 'review_candidate',
      },
      cost: {
        ...safeRecord().cost,
        paidApiUsed: true,
        modelCalls: true,
      },
      result: {
        ...safeRecord().result,
        applied: true,
      },
      holdoutRef: 'private_holdout:structure_only',
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'scorecard_objective_status_mismatch:capability',
      'scorecard_objective_weight_mismatch:regression',
      'scorecard_objective_direction_mismatch:capability',
      'scorecard_objective_status_mismatch:rewardHackingRisk',
      'scorecard_overall_mismatch',
      'scorecard_passed_mismatch',
      'scorecard_decision_mismatch',
      'scorecard_paid_api_forbidden',
      'scorecard_model_calls_forbidden',
      'scorecard_result_flag_false_required:applied',
      'scorecard_holdout_ref_must_be_not_accessed',
    ]));
  });

  it('keeps Pareto review selection aligned with aggregate decision', () => {
    const result = evaluateNoeEvolutionScorecardDryRunRecord(safeRecord({
      aggregate: {
        ...safeRecord().aggregate,
        passed: false,
        decision: 'reject_candidate',
      },
      pareto: {
        ...safeRecord().pareto,
        selectedForReview: true,
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('scorecard_pareto_review_mismatch');
  });

  it('rejects sensitive refs, forbidden paths, and whitespace normalization', () => {
    const result = evaluateNoeEvolutionScorecardDryRunRecord(safeRecord({
      id: ' scorecard-dry-run-unit-001 ',
      candidateRef: 'package.json',
      archiveReportRef: 'output/noe-evolution-archive-dry-run/latest.json ',
      objectives: {
        ...safeRecord().objectives,
        capability: {
          ...safeRecord().objectives.capability,
          evidenceRef: 'evals/neo/private_holdout/capability.json',
        },
      },
      evidenceRefs: [' output/noe-evolution-scorecard-dry-run/evidence.json '],
    }));

    expect(result.ok).toBe(false);
    expect(result.id).toBe('');
    expect(result.errors).toEqual(expect.arrayContaining([
      'scorecard_id_invalid',
      'scorecard_candidate_ref_scope_required',
      'scorecard_candidate_ref_forbidden',
      'scorecard_candidate_ref_output_scope_required',
      'scorecard_archive_report_ref_forbidden',
      'scorecard_objective_ref:capability_forbidden',
      'scorecard_objective_ref:capability_output_scope_required',
      'scorecard_evidence_ref_forbidden',
      'scorecard_evidence_ref_output_scope_required',
    ]));
  });

  it('rejects body-like values hidden in ids and refs without echoing them in reports', () => {
    const payload = 'RAW SCORECARD BODY SHOULD NOT BE IN REPORT';
    const report = buildNoeEvolutionScorecardDryRunReport([safeRecord({
      kind: payload,
      id: payload,
      objectives: {
        ...safeRecord().objectives,
        capability: {
          ...safeRecord().objectives.capability,
          evidenceRef: `output/noe-evolution-scorecard-dry-run/capability.json\n${payload}`,
        },
      },
      aggregate: {
        ...safeRecord().aggregate,
        decision: payload,
      },
    })], { inputRef: `output/noe-evolution-scorecard-dry-run/input.json\n${payload}` });

    expect(report.ok).toBe(false);
    expect(report.inputRef).toBe('unsafe_ref');
    expect(report.results[0].id).toBe('');
    expect(report.results[0].kind).toBe('');
    expect(report.results[0].summary.decision).toBe('');
    expect(report.results[0].errors).toEqual(expect.arrayContaining([
      'scorecard_kind_unsupported',
      'scorecard_id_invalid',
      'scorecard_decision_invalid',
      'scorecard_objective_ref:capability_forbidden',
      'scorecard_ref_forbidden',
    ]));
    expect(JSON.stringify(report)).not.toContain(payload);
  });

  it('CLI writes only dry-run reports', () => {
    runScorecardDryRun(['--out-dir', 'output/noe-evolution-scorecard-dry-run/unit']);
    const root = resolve(process.cwd());
    const latest = join(root, 'output/noe-evolution-scorecard-dry-run/unit/latest.json');
    const liveArchive = join(root, 'output/noe-evolution-scorecard-dry-run/unit/archive.jsonl');
    const report = JSON.parse(readFileSync(latest, 'utf8'));

    expect(report.ok).toBe(true);
    expect(report.policy.doesNotRunEvaluator).toBe(true);
    expect(existsSync(liveArchive)).toBe(false);
  });

  it('CLI rejects sensitive inputs, output escapes, unknown flags, and symlinked output dirs', () => {
    const root = resolve(process.cwd());
    const tempRoot = mkdtempSync(join(tmpdir(), 'noe-evolution-scorecard-dry-run-'));
    const outRoot = join(root, 'output/noe-evolution-scorecard-dry-run');
    const outLink = join(outRoot, 'unit-out-link');
    mkdirSync(outRoot, { recursive: true, mode: 0o700 });
    rmSync(outLink, { recursive: true, force: true });
    symlinkSync(tempRoot, outLink, 'dir');

    try {
      expect(() => runScorecardDryRun(['--scorecard-file', '.env.local']))
        .toThrow(/forbidden sensitive path/);
      expect(() => runScorecardDryRun(['--scorecard-file', 'evals/neo/private_holdout/score.json']))
        .toThrow(/forbidden sensitive path/);
      expect(() => runScorecardDryRun(['--scorecard-file', 'package.json']))
        .toThrow(/forbidden dry-run path/);
      expect(() => runScorecardDryRun(['--scorecard-file', 'package-lock.json']))
        .toThrow(/forbidden dry-run path/);
      expect(() => runScorecardDryRun(['--scorecard-file', 'src/eval/NeoEvalSchema.js']))
        .toThrow(/forbidden dry-run path/);
      expect(() => runScorecardDryRun(['--scorecard-file', ' output/noe-evolution-scorecard-dry-run/latest.json ']))
        .toThrow(/forbidden dry-run path/);
      expect(() => runScorecardDryRun(['--scorecard-file', 'output/noe-evolution-scorecard-dry-run/input.json\nRAW SCORECARD BODY']))
        .toThrow(/forbidden dry-run path/);
      expect(() => runScorecardDryRun(['--out-dir', 'docs/noe-evolution-scorecard-dry-run']))
        .toThrow(/must stay under output/);
      expect(() => runScorecardDryRun(['--unknown']))
        .toThrow(/unknown argument/);
      expect(() => runScorecardDryRun(['--out-dir', 'output/noe-evolution-scorecard-dry-run/unit-out-link']))
        .toThrow(/symlink|outside output/);
    } finally {
      rmSync(outLink, { recursive: true, force: true });
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
