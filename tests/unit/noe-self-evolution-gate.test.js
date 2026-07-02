import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateNoeSelfEvolutionGate } from '../../src/room/NoeSelfEvolutionGate.js';
import { buildNoeConsensusLedger, writeNoeConsensusLedgerFile } from '../../src/room/NoeConsensusLedger.js';

function vote(model, evidenceRef, extra = {}) {
  const decision = extra.decision || 'approve_with_changes';
  const approval = decision === 'approve' || decision === 'approve_with_changes';
  return {
    model,
    decision,
    authority: model === 'm3' ? 'suggestion_only' : model === 'codex' ? 'writer_integrator' : 'advisory',
    canWrite: model === 'codex',
    firstClass: model === 'claude' ? true : undefined,
    consensusVote: approval ? 'yes' : 'abstain',
    recommendedFirstSlice: decision === 'approve_with_changes' ? ['first safe slice'] : [],
    verificationRequired: approval ? ['focused verification'] : [],
    rawOutputRef: `output/noe-multimodel/round/${model}.txt`,
    evidenceRef,
    ...extra,
  };
}

function passedLedger() {
  const evidenceRef = 'output/noe-multimodel/round/brief.md';
  return buildNoeConsensusLedger({
    roundId: 'round-a',
    goal: 'Noe self evolution gate',
    evidenceRef,
    votes: ['codex', 'claude', 'm3'].map((model) => vote(model, evidenceRef)),
    implementation: {
      writer: 'codex',
      authorizationRequired: true,
      runtimeVerificationRequired: true,
      rollbackRequired: true,
      memoryWritebackAckRequired: true,
    },
  }, { createdAt: '2026-06-07T00:00:00.000Z' });
}

function writeLedgerReferencedFiles(root) {
  const roundDir = join(root, 'output/noe-multimodel/round');
  mkdirSync(roundDir, { recursive: true });
  writeFileSync(join(root, 'output/noe-multimodel/round/brief.md'), 'consensus brief\n');
  for (const model of ['codex', 'claude', 'm3']) {
    writeFileSync(join(root, `output/noe-multimodel/round/${model}.txt`), `${model} raw output\n`);
  }
}

function baseInput(action = 'implementation') {
  return {
    action,
    // 单测验证授权分支逻辑，不验证磁盘证据 => 走 dry-run，跳过内联 ledger / 复核 rawOutputRef 文件存在性。
    dryRun: true,
    ledger: passedLedger(),
    authorization: { userApproved: true, scope: 'consensus first slice', costClass: 'local_or_user_approved_model_calls' },
    rollback: { planRef: 'output/noe-multimodel/round/rollback.md' },
  };
}

function consensusAuth(scope) {
  return { userApproved: false, consensusApproved: true, scope, costClass: 'local_or_user_approved_model_calls' };
}

function candidateInput(extra = {}) {
  return {
    id: 'prompt-candidate-a',
    type: 'prompt',
    baselineRef: 'output/eval/baseline.json',
    candidateRef: 'output/eval/candidate.json',
    size: { changedFiles: 1, addedLines: 24, removedLines: 2, totalBytes: 8000 },
    growth: { currentTotalBytes: 100_000, projectedTotalBytes: 101_000, maxGrowthRatio: 1.05 },
    structure: { ok: true, touchesDefaultConfig: false },
    tests: [{ name: 'unit', ok: true, reportRef: 'output/eval/unit.json' }],
    holdout: { baselineScore: 0.6, candidateScore: 0.63, minDelta: 0.01, reportRef: 'output/eval/holdout.json' },
    rollbackRef: 'output/eval/rollback.md',
    ...extra,
  };
}

describe('Noe self evolution gate', () => {
  it('allows implementation only after consensus, user authorization, and rollback plan', () => {
    const result = evaluateNoeSelfEvolutionGate(baseInput());

    expect(result.ok).toBe(true);
    expect(result.gates.consensus).toBe(true);
  });

  it('allows implementation when consensus authorization replaces manual confirmation', () => {
    const input = baseInput();
    input.authorization.userApproved = false;
    input.authorization.consensusApproved = true;
    const result = evaluateNoeSelfEvolutionGate(input);

    expect(result.ok).toBe(true);
    expect(result.gates.consensusAuthorization).toBe(true);
  });

  it('allows implementation when standing autonomy grant replaces owner approval (consensus ledger still required)', () => {
    // owner 选「保留共识门」:standing grant 只替代 owner 的逐次 approval,validated consensus ledger 仍必需。
    const input = baseInput();
    input.authorization.userApproved = false;
    input.authorization.standingApproved = true;
    const result = evaluateNoeSelfEvolutionGate(input);

    expect(result.ok).toBe(true);
    expect(result.gates.standingAuthorization).toBe(true);
    expect(result.gates.authorization).toBe(true);
    expect(result.errors).not.toContain('user_or_consensus_authorization_required');
  });

  it('does not authorize self-evolution when user/consensus/standing are all absent', () => {
    const input = baseInput();
    input.authorization.userApproved = false;
    const result = evaluateNoeSelfEvolutionGate(input);

    expect(result.gates.standingAuthorization).toBe(false);
    expect(result.gates.authorization).toBe(false);
    expect(result.errors).toContain('user_or_consensus_authorization_required');
  });

  it('preserves all hard constraints under standing authorization (rollback still required)', () => {
    // standing 授权不能拆安全网:缺 rollback 仍被拦。
    const input = baseInput();
    input.authorization.userApproved = false;
    input.authorization.standingApproved = true;
    delete input.rollback;
    const result = evaluateNoeSelfEvolutionGate(input);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('rollback_plan_required');
  });

  it('allows consensus authorization from a validated dynamic quorum ledger', () => {
    const evidenceRef = 'output/noe-multimodel/round/brief.md';
    const input = baseInput();
    input.ledger = buildNoeConsensusLedger({
      roundId: 'round-dynamic-quorum',
      goal: 'Noe dynamic quorum gate',
      evidenceRef,
      votes: [
        vote('codex', evidenceRef),
        vote('claude', evidenceRef),
        vote('m3', evidenceRef, { decision: 'unavailable', consensusVote: 'abstain' }),
      ],
      implementation: { writer: 'codex', authorizationRequired: true, runtimeVerificationRequired: true, rollbackRequired: true, memoryWritebackAckRequired: true },
    }, { createdAt: '2026-06-07T00:00:00.000Z' });
    input.authorization.userApproved = false;
    input.authorization.consensusApproved = true;
    const result = evaluateNoeSelfEvolutionGate(input);

    expect(result.ok).toBe(true);
    expect(result.gates.consensusAuthorization).toBe(true);
  });

  it('blocks spoofed consensus authorization that was not produced by a validated ledger gate', () => {
    const input = baseInput();
    input.ledger = undefined;
    input.consensus = { ok: true, errors: [], warnings: [], consensus: { approvedCount: 3, threshold: 2 } };
    input.authorization.userApproved = false;
    input.authorization.consensusApproved = true;
    const result = evaluateNoeSelfEvolutionGate(input);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('validated_consensus_ledger_required');
    expect(result.errors).toContain('user_or_consensus_authorization_required');
  });

  it('blocks source-shaped consensus summaries when no ledger object is provided', () => {
    const result = evaluateNoeSelfEvolutionGate({
      ...baseInput(),
      ledger: undefined,
      consensus: {
        ok: true,
        validated: true,
        source: 'validated_consensus_ledger',
        ledgerVerified: true,
        consensus: { approvedCount: 3, threshold: 2 },
      },
      authorization: consensusAuth('forged source summary'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('validated_consensus_ledger_required');
    expect(result.errors).toContain('user_or_consensus_authorization_required');
  });

  it('requires ledger objects to pass artifact validation before authorization', () => {
    const ledger = passedLedger();
    delete ledger.schemaVersion;
    delete ledger.gate;
    const result = evaluateNoeSelfEvolutionGate({
      ...baseInput(),
      ledger,
      authorization: consensusAuth('malformed ledger object'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('consensus_gate_not_passed');
    expect(result.errors).toContain('validated_consensus_ledger_required');
  });

  it('allows consensus authorization from an artifact-valid ledger file ref', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-self-evolution-gate-'));
    try {
      writeLedgerReferencedFiles(root);
      writeNoeConsensusLedgerFile(passedLedger(), { root, outDir: 'output/noe-multimodel' });
      const result = evaluateNoeSelfEvolutionGate({
        ...baseInput(),
        root,
        ledger: undefined,
        ledgerRef: 'output/noe-multimodel/round-a/ledger.json',
        authorization: consensusAuth('ledger file authorization'),
      });

      expect(result.ok).toBe(true);
      expect(result.gates.consensusAuthorization).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects ledger file refs when referenced evidence files are missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-self-evolution-gate-'));
    try {
      writeNoeConsensusLedgerFile(passedLedger(), { root, outDir: 'output/noe-multimodel' });
      const result = evaluateNoeSelfEvolutionGate({
        ...baseInput(),
        root,
        ledger: undefined,
        ledgerRef: 'output/noe-multimodel/round-a/ledger.json',
        authorization: consensusAuth('ledger file missing evidence'),
      });

      expect(result.ok).toBe(false);
      expect(result.errors).toContain('consensus:missing_evidence_file:output/noe-multimodel/round/brief.md');
      expect(result.errors).toContain('consensus:missing_raw_output_file:codex:output/noe-multimodel/round/codex.txt');
      expect(result.errors).toContain('validated_consensus_ledger_required');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects ledger file refs that escape the repo root', () => {
    const result = evaluateNoeSelfEvolutionGate({
      ...baseInput(),
      ledger: undefined,
      ledgerRef: '../outside/ledger.json',
      authorization: consensusAuth('escaping ledger ref'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('consensus_gate_not_passed');
    expect(result.errors).toContain('validated_consensus_ledger_required');
    expect(result.errors).toContain('user_or_consensus_authorization_required');
  });

  it('allows delete/upload/publish/secret/restart/kill capabilities only with dynamic quorum consensus authorization', () => {
    const input = baseInput();
    input.authorization.userApproved = false;
    input.authorization.consensusApproved = true;
    input.requestedCapabilities = [
      'file_delete',
      'network_upload',
      'external_publish',
      'secret_access',
      'process_restart',
      'process_kill',
    ];
    const result = evaluateNoeSelfEvolutionGate(input);

    expect(result.ok).toBe(true);
    expect(result.gates.consensusAuthorization).toBe(true);
    expect(result.gates.requestedCapabilities).toContain('secret_access');
  });

  it('blocks sensitive capabilities when only manual authorization exists', () => {
    const result = evaluateNoeSelfEvolutionGate({
      ...baseInput(),
      requestedCapabilities: ['file_delete', 'secret_access', 'process_kill'],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('high_risk_capability_requires_dynamic_quorum_consensus:file_delete');
    expect(result.errors).toContain('high_risk_capability_requires_dynamic_quorum_consensus:secret_access');
    expect(result.errors).toContain('high_risk_capability_requires_dynamic_quorum_consensus:process_kill');
  });

  it('keeps system-level operations outside model-vote authorization', () => {
    const input = baseInput();
    input.authorization.userApproved = false;
    input.authorization.consensusApproved = true;
    input.requestedCapabilities = ['system_level'];
    const result = evaluateNoeSelfEvolutionGate(input);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('system_level_operation_not_consensus_authorizable:system_level');
  });

  it('blocks implementation without user or consensus authorization', () => {
    const input = baseInput();
    input.authorization.userApproved = false;
    const result = evaluateNoeSelfEvolutionGate(input);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('user_or_consensus_authorization_required');
  });

  it('requires self-repair to cite a failed verification and return to consensus', () => {
    const result = evaluateNoeSelfEvolutionGate({
      ...baseInput('self_repair'),
      failedVerificationRef: '',
      repairReturnsToConsensus: false,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('failed_verification_ref_required');
    expect(result.errors).toContain('self_repair_must_return_to_consensus');
  });

  it('allows self-repair when it is tied to failed evidence and re-enters consensus', () => {
    const result = evaluateNoeSelfEvolutionGate({
      ...baseInput('self_repair'),
      failedVerificationRef: 'output/noe-full-current/failed.json',
      repairReturnsToConsensus: true,
    });

    expect(result.ok).toBe(true);
  });

  it('blocks memory writeback until runtime verification and user ack exist', () => {
    const result = evaluateNoeSelfEvolutionGate({
      ...baseInput('memory_writeback'),
      runtimeVerification: { ok: false },
      memoryWriteback: { userAck: false, summaryRef: '' },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('runtime_verification_required');
    expect(result.errors).toContain('memory_writeback_ack_required');
    expect(result.errors).toContain('memory_writeback_summary_ref_required');
  });

  it('allows memory writeback ack by consensus without manual user confirmation', () => {
    const result = evaluateNoeSelfEvolutionGate({
      ...baseInput('memory_writeback'),
      runtimeVerification: { ok: true, reportRef: 'output/noe-full-current/pass.json' },
      memoryWriteback: { consensusAck: true, summaryRef: 'docs/HANDOFF.md' },
    });

    expect(result.ok).toBe(true);
    expect(result.gates.memoryWritebackAck).toBe(true);
  });

  it('blocks memory writeback consensusAck when the consensus result is not validated', () => {
    const result = evaluateNoeSelfEvolutionGate({
      ...baseInput('memory_writeback'),
      ledger: undefined,
      consensus: { ok: true, errors: [], warnings: [], consensus: { approvedCount: 3, threshold: 2 } },
      authorization: {
        userApproved: true,
        scope: 'memory writeback spoof guard',
        costClass: 'local_or_user_approved_model_calls',
      },
      runtimeVerification: { ok: true, reportRef: 'output/noe-full-current/pass.json' },
      memoryWriteback: { consensusAck: true, summaryRef: 'docs/HANDOFF.md', autoWrite: true },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('validated_consensus_ledger_required');
    expect(result.errors).toContain('memory_writeback_ack_required');
    expect(result.errors).toContain('memory_writeback_auto_requires_consensus');
  });

  it('allows memory writeback userAck without consensusAck when autoWrite is false', () => {
    const result = evaluateNoeSelfEvolutionGate({
      ...baseInput('memory_writeback'),
      runtimeVerification: { ok: true, reportRef: 'output/noe-full-current/pass.json' },
      memoryWriteback: { userAck: true, summaryRef: 'docs/HANDOFF.md' },
    });

    expect(result.ok).toBe(true);
    expect(result.gates.memoryWritebackAck).toBe(true);
  });

  it('blocks automatic memory writeback without consensus ack even when other gates pass', () => {
    const result = evaluateNoeSelfEvolutionGate({
      ...baseInput('memory_writeback'),
      runtimeVerification: { ok: true, reportRef: 'output/noe-full-current/pass.json' },
      memoryWriteback: { userAck: true, summaryRef: 'docs/HANDOFF.md', autoWrite: true },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('memory_writeback_auto_requires_consensus');
  });

  it('allows automatic long-term memory writeback when dynamic quorum consensus ack exists', () => {
    const result = evaluateNoeSelfEvolutionGate({
      ...baseInput('memory_writeback'),
      runtimeVerification: { ok: true, reportRef: 'output/noe-full-current/pass.json' },
      memoryWriteback: { consensusAck: true, summaryRef: 'docs/HANDOFF.md', autoWrite: true },
    });

    expect(result.ok).toBe(true);
    expect(result.gates.memoryWritebackAck).toBe(true);
  });

  it('explicit system-level vetoes cannot be outvoted', () => {
    const result = evaluateNoeSelfEvolutionGate({
      ...baseInput(),
      hardVetoes: ['51735_reserved', 'system_level_operation'],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('hard_veto:51735_reserved');
    expect(result.errors).toContain('hard_veto:system_level_operation');
  });

  it('blocks candidate adoption when candidate gate fails holdout evidence', () => {
    const result = evaluateNoeSelfEvolutionGate({
      ...baseInput(),
      candidate: candidateInput({
        writesDefaultConfig: true,
        structure: { ok: true, touchesDefaultConfig: true },
        holdout: { baselineScore: 0.6, candidateScore: 0.6, minDelta: 0.01, reportRef: 'output/eval/holdout.json' },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.gates.candidate).toBe(false);
    expect(result.errors[0]).toMatch(/candidate:candidate_holdout_improvement_required/);
  });
});
