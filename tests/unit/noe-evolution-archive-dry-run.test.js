import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  buildNoeEvolutionArchiveDryRunReport,
  evaluateNoeEvolutionArchiveDryRunRecord,
  NOE_EVOLUTION_ARCHIVE_DRY_RUN_KIND,
  NOE_EVOLUTION_ARCHIVE_DRY_RUN_VALIDATOR_VERSION,
  sha256Text,
} from '../../src/candidates/NoeEvolutionArchiveDryRun.js';
import { main as runEvolutionArchiveDryRun } from '../../scripts/noe-evolution-archive-dry-run.mjs';

function safeRecord(overrides = {}) {
  return {
    kind: NOE_EVOLUTION_ARCHIVE_DRY_RUN_KIND,
    schemaVersion: 1,
    id: 'archive-dry-run-unit-001',
    createdAt: '2026-06-19T00:00:00.000Z',
    parentId: 'dgm-parent-unit',
    childId: 'dgm-child-unit',
    generation: 2,
    candidateRef: 'output/noe-candidate-patches/dry-run/latest.json',
    parentArchiveRef: 'output/noe-evolution-archive-dry-run/parent.jsonl',
    lineage: {
      parentId: 'dgm-parent-unit',
      childId: 'dgm-child-unit',
      generation: 2,
    },
    refs: {
      patchArtifactRef: 'output/noe-candidate-patches/dry-run/latest.json',
      diffRef: 'output/noe-evolution-archive-dry-run/unit-diff.json',
      promptRef: 'output/noe-evolution-archive-dry-run/unit-prompt-redacted.json',
      evalInputRef: 'output/noe-evolution-archive-dry-run/unit-eval-input.json',
      commandOutputRef: 'output/noe-evolution-archive-dry-run/unit-command-output.json',
      scoreRef: 'output/noe-evolution-archive-dry-run/unit-score.json',
      rollbackRef: 'output/noe-evolution-archive-dry-run/unit-rollback.json',
      holdoutRef: 'private_holdout:not_accessed',
      benchmarkRef: 'output/noe-evolution-archive-dry-run/unit-benchmark.json',
      reportRef: 'output/noe-evolution-archive-dry-run/latest.json',
    },
    hashes: {
      diffSha256: sha256Text('diff'),
      promptSha256: sha256Text('prompt'),
      evalInputSha256: sha256Text('eval'),
      commandOutputSha256: sha256Text('command'),
    },
    score: {
      overall: 0.75,
      capability: 0.7,
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
        archiveSchema: { ok: true, reportRef: 'output/noe-evolution-archive-dry-run/schema.json' },
        secretScan: { ok: true, reportRef: 'output/noe-evolution-archive-dry-run/redaction-scan.json' },
        sast: { ok: true, reportRef: 'output/noe-evolution-archive-dry-run/sast.json' },
        sca: { ok: true, reportRef: 'output/noe-evolution-archive-dry-run/sca.json' },
        rollbackDryRun: { ok: true, reportRef: 'output/noe-evolution-archive-dry-run/rollback-dry-run.json' },
        rewardHacking: { ok: true, reportRef: 'output/noe-evolution-archive-dry-run/reward-hacking.json' },
      },
    },
    ...overrides,
  };
}

describe('NoeEvolutionArchiveDryRun', () => {
  it('accepts metadata-only DGM/SICA archive records', () => {
    const result = evaluateNoeEvolutionArchiveDryRunRecord(safeRecord());

    expect(result).toMatchObject({
      ok: true,
      id: 'archive-dry-run-unit-001',
      gates: {
        lineage: true,
        metadataOnly: true,
        refsSafe: true,
        dryRunOnly: true,
        scoring: true,
        validator: true,
      },
      summary: {
        parentId: 'dgm-parent-unit',
        childId: 'dgm-child-unit',
        generation: 2,
        verdict: 'dry_run_passed',
      },
    });
  });

  it('requires the archive dry-run protocol fields', () => {
    const result = evaluateNoeEvolutionArchiveDryRunRecord({});

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'archive_kind_unsupported',
      'archive_schema_version_unsupported',
      'archive_id_required',
      'archive_created_at_required',
      'archive_parent_id_required',
      'archive_child_id_required',
      'archive_lineage_required',
      'archive_refs_required',
      'archive_hashes_required',
      'archive_score_required',
      'archive_cost_required',
      'archive_result_required',
      'archive_safety_required',
      'archive_validator_required',
    ]));
  });

  it('rejects patch, prompt, command-output, and secret-like bodies anywhere in the record', () => {
    const result = evaluateNoeEvolutionArchiveDryRunRecord(safeRecord({
      patch: 'diff --git must not appear',
      prompt: 'prompt body must not appear',
      refs: {
        ...safeRecord().refs,
        commandOutputRef: '.env.local',
      },
      nested: { stdout: 'raw command output must not appear' },
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'archive_body_field_forbidden:patch',
      'archive_body_field_forbidden:prompt',
      'archive_body_field_forbidden:stdout',
      'archive_unknown_field',
      'archive_ref_forbidden:commandOutputRef',
      'archive_ref_forbidden',
    ]));
    expect(JSON.stringify(result)).not.toContain('prompt body must not appear');
    expect(JSON.stringify(result)).not.toContain('raw command output must not appear');
  });

  it('rejects private holdout file refs while allowing not-accessed attestations', () => {
    const pass = evaluateNoeEvolutionArchiveDryRunRecord(safeRecord({
      refs: { ...safeRecord().refs, holdoutRef: 'private_holdout:not_accessed' },
    }));
    const fail = evaluateNoeEvolutionArchiveDryRunRecord(safeRecord({
      refs: { ...safeRecord().refs, holdoutRef: 'evals/neo/private_holdout/hidden.jsonl' },
    }));

    expect(pass.ok).toBe(true);
    expect(fail.ok).toBe(false);
    expect(fail.errors).toContain('archive_holdout_ref_forbidden');
  });

  it('rejects lineage mismatch, invalid scores, paid cost, and result claims', () => {
    const result = evaluateNoeEvolutionArchiveDryRunRecord(safeRecord({
      generation: 2,
      lineage: { parentId: 'other-parent', childId: 'other-child', generation: 3 },
      score: {
        ...safeRecord().score,
        overall: 2,
        rewardHackingRisk: -1,
      },
      cost: {
        ...safeRecord().cost,
        estimatedUsd: -1,
        paidApiUsed: true,
      },
      result: {
        ...safeRecord().result,
        applied: true,
        committed: true,
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'archive_lineage_parent_mismatch',
      'archive_lineage_child_mismatch',
      'archive_lineage_generation_mismatch',
      'archive_score_invalid:overall',
      'archive_score_invalid:rewardHackingRisk',
      'archive_cost_invalid:estimatedUsd',
      'archive_cost_paid_api_forbidden',
      'archive_result_claim_forbidden:applied',
      'archive_result_claim_forbidden:committed',
    ]));
  });

  it('requires validator checks and safe output refs', () => {
    const result = evaluateNoeEvolutionArchiveDryRunRecord(safeRecord({
      validator: {
        ...safeRecord().validator,
        validatorVersion: 'old',
        reportRef: 'docs/report.json',
        checks: {
          candidatePatchGate: { ok: false, reportRef: 'output/noe-candidate-patches/dry-run/latest.json' },
          archiveSchema: { ok: true, reportRef: '.env.local' },
        },
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'archive_validator_version_mismatch',
      'archive_validator_report_ref_forbidden',
      'archive_validator_check_failed:candidatePatchGate',
      'archive_validator_check_report_ref_forbidden:archiveSchema',
      'archive_validator_check_required:secretScan',
      'archive_validator_check_required:sast',
      'archive_validator_check_required:sca',
      'archive_validator_check_required:rollbackDryRun',
      'archive_validator_check_required:rewardHacking',
      'archive_ref_forbidden',
    ]));
  });

  it('keeps top-level archive refs scoped to dry-run output artifacts', () => {
    const result = evaluateNoeEvolutionArchiveDryRunRecord(safeRecord({
      candidateRef: 'output/not-candidate/latest.json',
      parentArchiveRef: 'docs/archive-parent.jsonl',
      evidenceRefs: ['docs/evidence.md'],
      refs: {
        ...safeRecord().refs,
        diffRef: 'output/src/loop/raw.json',
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'archive_candidate_ref_scope_required',
      'archive_parent_archive_ref_output_scope_required',
      'archive_ref_output_scope_required',
      'archive_ref_forbidden:diffRef',
    ]));
  });

  it('rejects body-like values hidden in ids and refs without echoing them in reports', () => {
    const payload = 'RAW PROMPT BODY SHOULD NOT BE IN REPORT';
    const report = buildNoeEvolutionArchiveDryRunReport([safeRecord({
      kind: payload,
      id: payload,
      parentId: payload,
      lineage: {
        parentId: payload,
        childId: 'dgm-child-unit',
        generation: 2,
      },
      result: {
        ...safeRecord().result,
        verdict: payload,
      },
      refs: {
        ...safeRecord().refs,
        promptRef: `output/noe-evolution-archive-dry-run/prompt.json\n${payload}`,
      },
    })], { inputRef: `output/noe-evolution-archive-dry-run/input.json\n${payload}` });

    expect(report.ok).toBe(false);
    expect(report.inputRef).toBe('unsafe_ref');
    expect(report.results[0].id).toBe('');
    expect(report.results[0].kind).toBe('');
    expect(report.results[0].summary.parentId).toBe('');
    expect(report.results[0].summary.verdict).toBe('');
    expect(report.results[0].errors).toEqual(expect.arrayContaining([
      'archive_kind_unsupported',
      'archive_id_invalid',
      'archive_parent_id_invalid',
      'archive_lineage_parent_id_invalid',
      'archive_verdict_invalid',
      'archive_ref_forbidden:promptRef',
      'archive_ref_forbidden',
    ]));
    expect(JSON.stringify(report)).not.toContain(payload);
  });

  it('rejects leading or trailing whitespace instead of normalizing identity and ref values', () => {
    const result = evaluateNoeEvolutionArchiveDryRunRecord(safeRecord({
      id: ' archive-dry-run-unit-001 ',
      parentId: ' dgm-parent-unit ',
      childId: 'dgm-child-unit ',
      lineage: {
        parentId: ' dgm-parent-unit ',
        childId: 'dgm-child-unit ',
        generation: 2,
      },
      refs: {
        ...safeRecord().refs,
        promptRef: ' output/noe-evolution-archive-dry-run/unit-prompt-redacted.json ',
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.id).toBe('');
    expect(result.summary.parentId).toBe('');
    expect(result.summary.childId).toBe('');
    expect(result.errors).toEqual(expect.arrayContaining([
      'archive_id_invalid',
      'archive_parent_id_invalid',
      'archive_child_id_invalid',
      'archive_lineage_parent_id_invalid',
      'archive_lineage_child_id_invalid',
      'archive_ref_forbidden:promptRef',
      'archive_ref_output_scope_required:promptRef',
    ]));
  });

  it('builds reports without body values', () => {
    const report = buildNoeEvolutionArchiveDryRunReport([safeRecord({
      commandOutput: 'this raw output must not survive',
    })], { inputRef: 'unit' });

    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).not.toContain('this raw output must not survive');
    expect(report.counts).toMatchObject({ records: 1, passed: 0, failed: 1 });
  });

  it('CLI smoke writes only dry-run reports and not a live archive', () => {
    runEvolutionArchiveDryRun(['--out-dir', 'output/noe-evolution-archive-dry-run/unit']);
    const root = resolve(process.cwd());
    const latest = join(root, 'output/noe-evolution-archive-dry-run/unit/latest.json');
    const liveArchive = join(root, 'output/noe-evolution-archive-dry-run/unit/archive.jsonl');
    const report = JSON.parse(readFileSync(latest, 'utf8'));

    expect(report.ok).toBe(true);
    expect(report.policy.doesNotWriteLiveArchive).toBe(true);
    expect(existsSync(liveArchive)).toBe(false);
  });

  it('CLI rejects sensitive inputs, output escapes, unknown flags, and symlinked output dirs', () => {
    const root = resolve(process.cwd());
    const tempRoot = mkdtempSync(join(tmpdir(), 'noe-evolution-archive-dry-run-'));
    const outRoot = join(root, 'output/noe-evolution-archive-dry-run');
    const outLink = join(outRoot, 'unit-out-link');
    mkdirSync(outRoot, { recursive: true, mode: 0o700 });
    rmSync(outLink, { recursive: true, force: true });
    symlinkSync(tempRoot, outLink, 'dir');

    try {
      expect(() => runEvolutionArchiveDryRun(['--artifact-file', '.env.local']))
        .toThrow(/forbidden sensitive path/);
      expect(() => runEvolutionArchiveDryRun(['--artifact-file', 'evals/neo/private_holdout/hidden.jsonl']))
        .toThrow(/forbidden sensitive path/);
      expect(() => runEvolutionArchiveDryRun(['--artifact-file', 'package.json']))
        .toThrow(/forbidden dry-run path/);
      expect(() => runEvolutionArchiveDryRun(['--artifact-file', '~/.noe-panel/self-improve/archive.jsonl']))
        .toThrow(/forbidden dry-run path/);
      expect(() => runEvolutionArchiveDryRun(['--artifact-file', 'src/loop/x.js']))
        .toThrow(/forbidden dry-run path/);
      expect(() => runEvolutionArchiveDryRun(['--artifact-file', 'output/noe-evolution-archive-dry-run/input.json\nRAW PROMPT BODY']))
        .toThrow(/forbidden dry-run path/);
      expect(() => runEvolutionArchiveDryRun(['--artifact-file', ' output/noe-evolution-archive-dry-run/latest.json ']))
        .toThrow(/forbidden dry-run path/);
      expect(() => runEvolutionArchiveDryRun(['--out-dir', 'docs/noe-evolution-archive-dry-run']))
        .toThrow(/must stay under output/);
      expect(() => runEvolutionArchiveDryRun(['--unknown']))
        .toThrow(/unknown argument/);
      expect(() => runEvolutionArchiveDryRun(['--out-dir', 'output/noe-evolution-archive-dry-run/unit-out-link']))
        .toThrow(/symlink|outside output/);
    } finally {
      rmSync(outLink, { recursive: true, force: true });
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
