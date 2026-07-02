import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  buildNoeCandidatePatchArtifactReport,
  evaluateNoeCandidatePatchArtifact,
  NOE_CANDIDATE_PATCH_ARTIFACT_KIND,
  NOE_CANDIDATE_PATCH_VALIDATOR_VERSION,
} from '../../src/candidates/NoeCandidatePatchArtifactGate.js';
import { main as runCandidatePatchDryRun } from '../../scripts/noe-candidate-patch-dry-run.mjs';

function sha256(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function safeArtifact(overrides = {}) {
  const content = 'safe dry-run patch content\n';
  const target = 'docs/noe-phase4-safe-target.md';
  return {
    kind: NOE_CANDIDATE_PATCH_ARTIFACT_KIND,
    schemaVersion: 1,
    id: 'candidate-patch-unit-001',
    createdAt: '2026-06-19T00:00:00.000Z',
    parentRef: 'git:HEAD',
    diffRef: 'output/noe-candidate-patches/unit-diff.json',
    scope: {
      phase: 'phase4',
      changeType: 'dry_run_candidate_patch',
      allowedArea: 'documentation',
      targetFiles: [target],
      changedFiles: 1,
      changedLines: 1,
      diffBytes: Buffer.byteLength(content, 'utf8'),
      nonCoreOnly: true,
    },
    reason: {
      problemRef: 'docs/PLAN_2026-06-19_Hermes_OpenClaw_自进化蒸馏总路线.md',
      hypothesis: 'Unit-test the candidate patch artifact policy.',
      expectedBenefit: 'Unsafe self-code patch candidates are blocked before any patch executor can run.',
    },
    holdoutRef: 'private_holdout:not_accessed',
    holdout: { status: 'not_accessed' },
    provenance: {
      source: 'unit',
      modelOrTool: 'vitest',
      sourceEpisodeId: 'episode-unit-001',
      sourceReportRef: 'output/noe-candidate-patches/source.json',
      rawOutputRef: 'output/noe-candidate-patches/raw-output-redacted.json',
      roundRef: 'output/noe-candidate-patches/round.json',
      redactionPolicy: 'metadata_only_no_patch_body_no_secret_values',
    },
    signature: {
      payloadSha256: sha256('candidate-patch-unit-001'),
      verified: false,
    },
    cost: {
      estimatedUsd: 0,
      quotaRisk: 'none',
      paidApiUsed: false,
    },
    evalPlan: {
      reportRef: 'output/noe-candidate-patches/eval.json',
      scoreRef: 'output/noe-candidate-patches/score.json',
      holdoutRef: 'private_holdout:not_accessed',
      holdoutStatus: 'not_accessed',
      devCommands: ['node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/noe-candidate-patch-artifact-gate.test.js'],
      regressionCommands: ['node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-candidate-patch-dry-run.mjs'],
      successCriteria: 'validator ok true and target file absent after dry-run',
      tests: [{
        name: 'unit-smoke',
        ok: true,
        reportRef: 'output/noe-candidate-patches/test.json',
      }],
    },
    rollbackPlan: {
      mode: 'drop_artifact',
      rollbackRef: 'output/noe-candidate-patches/rollback.json',
      reportRef: 'output/noe-candidate-patches/rollback.json',
      reversible: true,
      manualSteps: ['Discard the artifact; no patch executor runs.'],
      callsRollbackExecutor: false,
    },
    operations: [{
      id: 'write-report-format-doc',
      op: 'write_file',
      path: target,
      contentSha256: sha256(content),
      contentBytes: Buffer.byteLength(content, 'utf8'),
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
      reportRef: 'output/noe-candidate-patches/latest.json',
      blockers: [],
      warnings: [],
      secretValuesReturned: false,
      checks: {
        sandbox: { ok: true, reportRef: 'output/noe-candidate-patches/sandbox.json' },
        secretScan: { ok: true, reportRef: 'output/noe-candidate-patches/redaction-scan.json' },
        sast: { ok: true, reportRef: 'output/noe-candidate-patches/sast.json' },
        sca: { ok: true, reportRef: 'output/noe-candidate-patches/sca.json' },
        rollbackDryRun: { ok: true, reportRef: 'output/noe-candidate-patches/rollback-dry-run.json' },
        rewardHacking: { ok: true, reportRef: 'output/noe-candidate-patches/reward-hacking.json' },
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
    ...overrides,
  };
}

describe('NoeCandidatePatchArtifactGate', () => {
  it('accepts metadata-only dry-run patch artifacts on whitelisted targets', () => {
    const result = evaluateNoeCandidatePatchArtifact(safeArtifact());

    expect(result).toMatchObject({
      ok: true,
      id: 'candidate-patch-unit-001',
      gates: {
        dryRunOnly: true,
        nonCoreWhitelist: true,
        noExecutionOrWrites: true,
        scopeLimited: true,
      },
      summary: {
        operationCount: 1,
        targetPaths: ['docs/noe-phase4-safe-target.md'],
      },
    });
    expect(JSON.stringify(result)).not.toContain('safe dry-run patch content');
  });

  it('requires the protocol fields from CandidatePatchArtifact v1', () => {
    const result = evaluateNoeCandidatePatchArtifact({});

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'artifact_kind_unsupported:blank',
      'artifact_schema_version_unsupported:blank',
      'artifact_id_required',
      'artifact_created_at_required',
      'artifact_parent_ref_required',
      'artifact_diff_or_patch_plan_ref_required',
      'artifact_scope_required',
      'artifact_reason_required',
      'artifact_eval_plan_required',
      'artifact_holdout_ref_required',
      'artifact_provenance_required',
      'artifact_signature_required',
      'artifact_cost_required',
      'artifact_rollback_plan_required',
      'artifact_operations_required',
      'artifact_tests_required',
      'artifact_claims_required',
      'artifact_validator_required',
      'artifact_safety_required',
    ]));
  });

  it('rejects core, evaluator, package script, runtime, secret, and path-escape targets', () => {
    const result = evaluateNoeCandidatePatchArtifact(safeArtifact({
      operations: [
        { id: 'loop', op: 'write_file', path: 'src/loop/NoeSelfEvolutionLoop.js', contentSha256: sha256('x'), contentBytes: 1, addedLines: 1, removedLines: 0 },
        { id: 'pkg', op: 'write_file', path: 'package.json', contentSha256: sha256('x'), contentBytes: 1, addedLines: 1, removedLines: 0 },
        { id: 'eval', op: 'write_file', path: 'src/eval/NeoEvalSchema.js', contentSha256: sha256('x'), contentBytes: 1, addedLines: 1, removedLines: 0 },
        { id: 'holdout', op: 'write_file', path: 'evals/neo/private_holdout/hidden.jsonl', contentSha256: sha256('x'), contentBytes: 1, addedLines: 1, removedLines: 0 },
        { id: 'env', op: 'write_file', path: '.env.local', contentSha256: sha256('x'), contentBytes: 1, addedLines: 1, removedLines: 0 },
        { id: 'escape', op: 'write_file', path: '../escape.txt', contentSha256: sha256('x'), contentBytes: 1, addedLines: 1, removedLines: 0 },
        { id: 'server', op: 'write_file', path: 'server.js', contentSha256: sha256('x'), contentBytes: 1, addedLines: 1, removedLines: 0 },
        { id: 'consensus', op: 'write_file', path: 'scripts/noe-consensus-ledger-verify.mjs', contentSha256: sha256('x'), contentBytes: 1, addedLines: 1, removedLines: 0 },
      ],
    }));

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('target_path_forbidden_zone:src/loop/NoeSelfEvolutionLoop.js');
    expect(result.errors.join('\n')).toContain('target_path_forbidden_exact:package.json');
    expect(result.errors.join('\n')).toContain('target_path_forbidden_zone:src/eval/NeoEvalSchema.js');
    expect(result.errors.join('\n')).toContain('target_path_forbidden_ref:evals/neo/private_holdout/hidden.jsonl');
    expect(result.errors.join('\n')).toContain('target_path_forbidden_ref:.env.local');
    expect(result.errors.join('\n')).toContain('target_path_forbidden_ref:../escape.txt');
    expect(result.errors.join('\n')).toContain('target_path_forbidden_exact:server.js');
    expect(result.errors.join('\n')).toContain('target_path_forbidden_zone:scripts/noe-consensus-ledger-verify.mjs');
  });

  it('rejects patch bodies, unsupported delete operations, failing tests, and forbidden safety flags', () => {
    const result = evaluateNoeCandidatePatchArtifact(safeArtifact({
      evalPlan: {
        ...safeArtifact().evalPlan,
        holdoutStatus: 'not_accessed',
        tests: [{ name: 'failing', ok: false, reportRef: 'output/noe-candidate-patches/test.json' }],
      },
      operations: [{
        id: 'delete-doc',
        op: 'delete_file',
        path: 'docs/noe-phase4-safe-target.md',
        content: 'body must not be emitted',
        contentSha256: sha256('x'),
        contentBytes: 1,
        addedLines: 0,
        removedLines: 1,
      }],
      safety: {
        ...safeArtifact().safety,
        executorEnabled: true,
        runtimeRestart: true,
        writesRepoFiles: true,
        privateHoldoutRead: true,
        packageScriptsTouched: true,
        realExecute: true,
        patchExecutorEnabled: true,
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'operation_unsupported:delete_file',
      'operation_body_field_forbidden:content',
      'artifact_test_failed:failing',
      'safety_executor_enable_forbidden',
      'safety_runtime_restart_forbidden',
      'safety_repo_write_forbidden',
      'safety_private_holdout_read_forbidden',
      'safety_package_script_touch_forbidden',
      'safety_real_execute_forbidden',
      'safety_patch_executor_enable_forbidden',
    ]));
  });

  it('rejects private holdout file refs while allowing not-accessed holdout attestations', () => {
    const pass = evaluateNoeCandidatePatchArtifact(safeArtifact({
      holdoutRef: 'private_holdout:not_accessed',
      holdout: { status: 'not_accessed' },
    }));
    const fail = evaluateNoeCandidatePatchArtifact(safeArtifact({
      holdoutRef: 'evals/neo/private_holdout/hidden.jsonl',
      holdout: { status: 'passed' },
    }));

    expect(pass.ok).toBe(true);
    expect(fail.ok).toBe(false);
    expect(fail.errors).toEqual(expect.arrayContaining([
      'artifact_holdout_status_forbidden:holdout.status:passed',
      'artifact_holdout_ref_must_not_read_private_holdout',
    ]));
  });

  it('rejects private holdout success claims in any holdout status field', () => {
    const result = evaluateNoeCandidatePatchArtifact(safeArtifact({
      holdout: { status: 'not_accessed' },
      evalPlan: {
        ...safeArtifact().evalPlan,
        holdoutStatus: 'passed',
      },
      safety: {
        ...safeArtifact().safety,
        holdoutStatus: 'structure_only',
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'artifact_holdout_status_forbidden:evalPlan.holdoutStatus:passed',
    ]));
  });

  it('rejects approval claims, executor flags, forbidden commands, and oversize patches', () => {
    const result = evaluateNoeCandidatePatchArtifact(safeArtifact({
      status: 'applied',
      scope: {
        ...safeArtifact().scope,
        targetFiles: [
          'docs/one.md',
          'docs/two.md',
          'docs/three.md',
          'docs/four.md',
        ],
        changedFiles: 4,
        changedLines: 201,
        diffBytes: 102401,
      },
      evalPlan: {
        ...safeArtifact().evalPlan,
        devCommands: ['NOE_SELF_EVOLUTION_EXECUTORS=1 node scripts/noe-patch-apply.mjs --apply --confirm-owner'],
      },
      claims: {
        ...safeArtifact().claims,
        userApproved: true,
        consensusApproved: true,
        runtimeVerified: true,
      },
      operations: [{
        ...safeArtifact().operations[0],
        apply: true,
        confirmOwner: true,
        spawn: true,
      }],
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'artifact_scope_changed_files_limit_exceeded:4',
      'artifact_scope_changed_lines_limit_exceeded:201',
      'artifact_scope_diff_bytes_limit_exceeded:102401',
      'artifact_claim_forbidden:userApproved',
      'artifact_claim_forbidden:consensusApproved',
      'artifact_claim_forbidden:runtimeVerified',
      'artifact_status_claim_forbidden:applied',
      'operation_forbidden_flag:apply',
      'operation_forbidden_flag:confirmOwner',
      'operation_forbidden_flag:spawn',
    ]));
    expect(result.errors.join('\n')).toContain('artifact_eval_plan_command_forbidden');
  });

  it('rejects command bypasses for services, package scripts, patch executors, memory apply, and 51835', () => {
    const result = evaluateNoeCandidatePatchArtifact(safeArtifact({
      evalPlan: {
        ...safeArtifact().evalPlan,
        devCommands: [
          'npm run start:noe',
          'PORT=51835 node server.js',
          'node scripts/noe-patch-apply.mjs',
          'node scripts/noe-memory-candidate-apply.mjs',
        ],
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('artifact_eval_plan_command_forbidden');
    expect(result.errors.join('\n')).toContain('npm run start:noe');
    expect(result.errors.join('\n')).toContain('PORT=51835 node server.js');
    expect(result.errors.join('\n')).toContain('node scripts/noe-patch-apply.mjs');
    expect(result.errors.join('\n')).toContain('node scripts/noe-memory-candidate-apply.mjs');
  });

  it('rejects non-test vitest targets even when the path is otherwise whitelisted', () => {
    const result = evaluateNoeCandidatePatchArtifact(safeArtifact({
      evalPlan: {
        ...safeArtifact().evalPlan,
        devCommands: ['node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run docs/noe-phase4-safe-target.md'],
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('artifact_eval_plan_command_forbidden:vitest_targets');
  });

  it('cross-checks scope metrics against operation aggregates', () => {
    const largeContent = 'x'.repeat(300);
    const result = evaluateNoeCandidatePatchArtifact(safeArtifact({
      scope: {
        ...safeArtifact().scope,
        changedFiles: 1,
        changedLines: 1,
        diffBytes: 1,
      },
      operations: [{
        ...safeArtifact().operations[0],
        contentSha256: sha256(largeContent),
        contentBytes: Buffer.byteLength(largeContent, 'utf8'),
        addedLines: 10,
        removedLines: 2,
      }],
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'artifact_scope_changed_lines_inconsistent:1<12',
      'artifact_scope_diff_bytes_inconsistent:1<300',
    ]));
    expect(result.gates.scopeLimited).toBe(false);
  });

  it('rejects negative, NaN, and unknown scope metrics instead of treating them as zero', () => {
    const result = evaluateNoeCandidatePatchArtifact(safeArtifact({
      scope: {
        ...safeArtifact().scope,
        changedFiles: -1,
        changedLines: Number.NaN,
        diffBytes: 'not-a-number',
      },
      operations: [{
        ...safeArtifact().operations[0],
        addedLines: -1,
        removedLines: Number.NaN,
      }],
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'artifact_scope_changed_files_required:-1',
      'artifact_scope_changed_lines_required:NaN',
      'artifact_scope_diff_bytes_required:not-a-number',
      'operation_line_counts_required:docs/noe-phase4-safe-target.md',
    ]));
  });

  it('rejects top-level and nested patch bodies plus unknown schema fields', () => {
    const result = evaluateNoeCandidatePatchArtifact(safeArtifact({
      patch: 'diff --git must not appear',
      payload: { content: 'nested patch body must not appear' },
      operations: [{
        ...safeArtifact().operations[0],
        rawDiff: 'raw operation diff must not appear',
      }],
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'artifact_body_field_forbidden:artifact.patch',
      'artifact_unknown_field:artifact.patch',
      'artifact_unknown_field:artifact.payload',
      'artifact_body_field_forbidden:artifact.payload.content',
      'artifact_body_field_forbidden:artifact.operations[].rawDiff',
      'artifact_unknown_field:artifact.operations[].rawDiff',
      'operation_body_field_forbidden:rawDiff',
    ]));
    expect(JSON.stringify(result)).not.toContain('nested patch body must not appear');
    expect(JSON.stringify(result)).not.toContain('raw operation diff must not appear');
  });

  it('requires exact validator version and passed verification result refs', () => {
    const result = evaluateNoeCandidatePatchArtifact(safeArtifact({
      validator: {
        ...safeArtifact().validator,
        validatorVersion: 'candidate-patch-artifact-gate-v0',
        checks: {
          sandbox: { ok: false, reportRef: 'output/noe-candidate-patches/sandbox.json' },
          secretScan: { ok: true, reportRef: '.env.local' },
        },
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'artifact_validator_version_mismatch:candidate-patch-artifact-gate-v0',
      'artifact_validator_check_failed:sandbox',
      'artifact_validator_check_report_ref_forbidden:secretScan',
      'artifact_validator_check_required:sast',
      'artifact_validator_check_required:sca',
      'artifact_validator_check_required:rollbackDryRun',
      'artifact_validator_check_required:rewardHacking',
      'artifact_ref_forbidden',
    ]));
  });

  it('rejects negative estimated costs', () => {
    const result = evaluateNoeCandidatePatchArtifact(safeArtifact({
      cost: {
        ...safeArtifact().cost,
        estimatedUsd: -1,
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'artifact_cost_estimated_usd_required',
    ]));
  });

  it('builds reports without patch bodies', () => {
    const artifact = safeArtifact({
      operations: [{
        ...safeArtifact().operations[0],
        content: 'this must not survive',
      }],
    });
    const report = buildNoeCandidatePatchArtifactReport([artifact], { inputRef: 'unit' });

    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).not.toContain('this must not survive');
    expect(report.counts).toMatchObject({ artifacts: 1, passed: 0, failed: 1 });
  });

  it('CLI rejects symlinked artifact files and output directories before reading or writing through them', () => {
    const root = resolve(process.cwd());
    const tempRoot = mkdtempSync(join(tmpdir(), 'noe-candidate-patch-'));
    const externalArtifact = join(tempRoot, 'artifact.json');
    const outputRoot = join(root, 'output/noe-candidate-patches');
    const artifactLink = join(root, 'output/noe-candidate-patches/unit-artifact-link.json');
    const outLink = join(root, 'output/noe-candidate-patches/unit-out-link');
    mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
    rmSync(artifactLink, { force: true });
    rmSync(outLink, { recursive: true, force: true });
    writeFileSync(externalArtifact, JSON.stringify(safeArtifact()), { mode: 0o600 });
    symlinkSync(externalArtifact, artifactLink);
    symlinkSync(tempRoot, outLink, 'dir');

    try {
      expect(() => runCandidatePatchDryRun(['--artifact-file', 'output/noe-candidate-patches/unit-artifact-link.json']))
        .toThrow(/symlink|outside repo/);
      expect(() => runCandidatePatchDryRun(['--out-dir', 'output/noe-candidate-patches/unit-out-link']))
        .toThrow(/symlink|outside repo/);
    } finally {
      rmSync(artifactLink, { force: true });
      rmSync(outLink, { recursive: true, force: true });
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('CLI rejects output paths that resolve inside the repo but outside real output', () => {
    const root = resolve(process.cwd());
    const targetRoot = join(root, 'tests/fixtures/noe-candidate-patch/internal-output-link-target');
    const targetSubdir = join(targetRoot, 'subdir');
    const outLink = join(root, 'output/noe-candidate-patches/unit-internal-out-link');
    mkdirSync(targetSubdir, { recursive: true, mode: 0o700 });
    rmSync(outLink, { recursive: true, force: true });
    symlinkSync(targetRoot, outLink, 'dir');

    try {
      expect(() => runCandidatePatchDryRun(['--out-dir', 'output/noe-candidate-patches/unit-internal-out-link/subdir']))
        .toThrow(/outside output|symlink/);
    } finally {
      rmSync(outLink, { recursive: true, force: true });
      rmSync(targetRoot, { recursive: true, force: true });
    }
  });

  it('CLI rejects unknown arguments instead of silently ignoring them', () => {
    expect(() => runCandidatePatchDryRun(['--unknown-flag']))
      .toThrow(/unknown argument/);
  });

  it('CLI smoke writes only output reports and does not create the planned target file', () => {
    runCandidatePatchDryRun(['--out-dir', 'output/noe-candidate-patches/dry-run-unit']);
    const root = resolve(process.cwd());
    const latest = join(root, 'output/noe-candidate-patches/dry-run-unit/latest.json');
    const plannedTarget = join(root, 'output/noe-candidate-patches/dry-run/smoke-target.txt');
    const report = JSON.parse(readFileSync(latest, 'utf8'));

    expect(report.ok).toBe(true);
    expect(report.policy.doesNotCallPatchApplyExecutor).toBe(true);
    expect(existsSync(plannedTarget)).toBe(false);
  });
});
