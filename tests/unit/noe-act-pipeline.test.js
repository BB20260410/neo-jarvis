import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite, listEvents } from '../../src/storage/SqliteStore.js';
import { ActStore } from '../../src/loop/ActStore.js';
import { ActPipeline, DEFAULT_NOE_SELF_EVOLUTION_ROOT } from '../../src/loop/ActPipeline.js';
import { createSafeActExecutors } from '../../src/loop/SafeActExecutors.js';
import { ApprovalStore } from '../../src/approval/ApprovalStore.js';
import { buildNoeConsensusLedger, writeNoeConsensusLedgerFile } from '../../src/room/NoeConsensusLedger.js';

let tmp;

beforeEach(() => {
  close(); tmp = mkdtempSync(join(tmpdir(), 'noe-act-pipeline-')); initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = null;
});

function makePipeline(overrides = {}) {
  const store = new ActStore({ projectId: 'noe-test' });
  const approvalStore = new ApprovalStore({ audit: { recordSafe() {} } });
  const broadcasts = [];
  const pipeline = new ActPipeline({
    projectId: 'noe-test',
    store,
    approvalStore,
    budget: { preflight: () => ({ ok: true, warnings: [], blocked: [] }) },
    permission: { evaluatePermission: () => ({ decision: 'allow', reason: 'test allow' }) },
    audit: { recordSafe() {} },
    broadcast: (msg) => broadcasts.push(msg),
    logger: null,
    ...overrides,
  });
  return { pipeline, store, approvalStore, broadcasts };
}

function vote(model, evidenceRef) {
  return {
    model,
    decision: 'approve_with_changes',
    authority: model === 'm3' ? 'suggestion_only' : model === 'codex' ? 'writer_integrator' : 'advisory',
    canWrite: model === 'codex',
    firstClass: model === 'claude' ? true : undefined,
    consensusVote: 'yes',
    recommendedFirstSlice: ['self-evolution first slice'],
    verificationRequired: ['verify self-evolution act gate'],
    rawOutputRef: `output/noe-multimodel/round/${model}.txt`,
    evidenceRef,
  };
}

function passedLedger() {
  const evidenceRef = 'output/noe-multimodel/round/brief.md';
  return buildNoeConsensusLedger({
    roundId: 'round-a',
    goal: 'Noe self evolution act',
    evidenceRef,
    votes: ['codex', 'claude', 'm3'].map((model) => vote(model, evidenceRef)),
    implementation: { writer: 'codex', authorizationRequired: true, runtimeVerificationRequired: true, rollbackRequired: true, memoryWritebackAckRequired: true },
  }, { createdAt: '2026-06-07T00:00:00.000Z' });
}

function selfEvolutionContext(overrides = {}) {
  return {
    action: 'implementation',
    ledger: passedLedger(),
    authorization: { scope: 'self-evolution first slice', costClass: 'local_or_user_approved_model_calls', userApproved: true },
    rollback: { planRef: 'output/noe-multimodel/round/rollback.md' },
    ...overrides,
  };
}

function selfEvolutionLedgerRefContext(overrides = {}) {
  return selfEvolutionContext({ ledger: undefined, ledgerRef: 'output/noe-multimodel/round-a/ledger.json', ...overrides });
}

function consensusAuth(scope) {
  return { userApproved: false, consensusApproved: true, scope, costClass: 'local_or_user_approved_model_calls' };
}

function sePayload(selfEvolution) {
  return { selfEvolution };
}

function writeLedgerReferencedFiles(root) {
  const roundDir = join(root, 'output/noe-multimodel/round');
  mkdirSync(roundDir, { recursive: true });
  writeFileSync(join(root, 'output/noe-multimodel/round/brief.md'), 'consensus brief\n');
  for (const model of ['codex', 'claude', 'm3']) writeFileSync(join(root, `output/noe-multimodel/round/${model}.txt`), `${model} raw output\n`);
}

describe('ActPipeline', () => {
  it('uses a module-derived self-evolution root instead of the caller cwd by default', () => {
    const oldCwd = process.cwd();
    try {
      process.chdir(tmp); const { pipeline } = makePipeline();
      expect(pipeline.selfEvolutionRoot).toBe(DEFAULT_NOE_SELF_EVOLUTION_ROOT);
    } finally {
      process.chdir(oldCwd);
    }
  });

  it('completes low-risk acts as dry-run evidence without real tool execution', async () => {
    const { pipeline, store, broadcasts } = makePipeline();

    const result = await pipeline.propose({
      title: 'Review focus',
      action: 'noe.focus.review',
      riskLevel: 'low',
      payload: {
        goal: 'produce owner perceived delivery evidence',
        expectation: 'owner expects confirmed delivery sample',
        checkpoint: 'write readiness audit',
      },
    });

    expect(result.ok).toBe(true);
    expect(result.act).toMatchObject({
      status: 'completed',
      permissionState: 'allow',
      budgetState: 'ok',
    });
    expect(result.act.logRef).toContain('sqlite:events/');
    expect(result.act.payload.actionEvidence.semanticTrace.summary.join(' ')).toContain('owner expects confirmed delivery sample');
    expect(result.act.payload.actionEvidence.semanticTrace.checkpoint).toEqual(['write readiness audit']);
    expect(store.list({ projectId: 'noe-test' })).toHaveLength(1);
    expect(listEvents({ kind: 'noe_act_dry_run' })).toHaveLength(1);
    expect(broadcasts.some((msg) => msg.type === 'noe_act_updated')).toBe(true);
  });

  it('carries focus semantic context into default loop action evidence', async () => {
    const { pipeline } = makePipeline();

    const result = await pipeline.tick({
      memoryStats: { visible: 7 },
      focusItems: [
        {
          id: 'focus-1',
          source: 'goal_step',
          text: '推进目标：prove expectation settlement Authorization: Bearer fixture1',
          goalTitle: 'settle owner-visible delivery evidence',
          stepText: 'write readiness audit with delivery evidence',
          queryText: 'write readiness audit with delivery evidence',
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.act.payload).toMatchObject({
      actionEvidence: {
        semanticTrace: {
          goal: ['settle owner-visible delivery evidence'],
          checkpoint: ['write readiness audit with delivery evidence'],
        },
      },
    });
    const trace = result.act.payload.actionEvidence.semanticTrace;
    expect(trace.summary.join(' ')).toContain('prove expectation settlement');
    expect(JSON.stringify(trace)).not.toContain('fixture1');
    expect(JSON.stringify(trace)).not.toContain('Authorization: Bearer fixture1');
  });

  it('routes high-risk acts to approval and does not execute them', async () => {
    const { pipeline, approvalStore } = makePipeline();

    const result = await pipeline.propose({ title: 'Write file', action: 'file.write', riskLevel: 'high' });

    expect(result).toMatchObject({ ok: true, approvalRequired: true });
    expect(result.act.status).toBe('awaiting_approval');
    expect(result.act.permissionState).toBe('approval_required');
    expect(result.act.approvalId).toMatch(/^approval-/);
    expect(approvalStore.listApprovals({ status: 'pending' })).toHaveLength(1);
    expect(listEvents({ kind: 'noe_act_dry_run' })).toHaveLength(0);
  });

  it('executes a high-risk file write only after explicit approved retry', async () => {
    const sandbox = join(tmp, 'workspace');
    const { pipeline, approvalStore } = makePipeline({
      executors: createSafeActExecutors({
        safeResolveFsPath: (p) => join(sandbox, String(p).replace(/^\/+/, '')),
      }),
    });

    const planned = await pipeline.propose({
      title: 'Write note',
      action: 'file.write_text',
      riskLevel: 'high',
      payload: {
        path: 'notes/out.txt',
        content: 'hello approved write',
        goalTitle: 'owner visible delivery evidence',
        expectedClaim: 'owner expects visible delivery evidence from approved retry',
        checkpoint: 'approved retry writes delivery evidence',
        stepText: 'write approved retry delivery evidence',
      },
    });

    expect(planned).toMatchObject({ ok: true, approvalRequired: true });
    expect(planned.act.status).toBe('awaiting_approval');
    approvalStore.approve(planned.act.approvalId, { reason: 'unit test approved' });

    const executed = await pipeline.retry(planned.act.id, { realExecute: true });

    expect(executed.ok).toBe(true);
    expect(executed.act).toMatchObject({ status: 'completed' });
    expect(executed.act.payload).toMatchObject({ dryRunOnly: false });
    expect(executed.act.payload.actionEvidence.semanticTrace).toMatchObject({
      goal: ['owner visible delivery evidence'],
      expectation: ['owner expects visible delivery evidence from approved retry'],
      checkpoint: ['approved retry writes delivery evidence', 'write approved retry delivery evidence'],
    });
    expect(readFileSync(join(sandbox, 'notes/out.txt'), 'utf8')).toBe('hello approved write');
    expect(listEvents({ kind: 'noe_act_executed' })).toHaveLength(1);
  });

  it('executes only when realExecute is explicit and a low-risk executor is registered', async () => {
    let called = 0;
    const { pipeline } = makePipeline({
      executors: {
        'noe.focus.review': async ({ act }) => {
          called += 1;
          return { reviewed: true, actId: act.id };
        },
      },
    });

    const result = await pipeline.propose({ title: 'Review focus', action: 'noe.focus.review', riskLevel: 'low', realExecute: true });

    expect(result.ok).toBe(true);
    expect(called).toBe(1);
    expect(result.act).toMatchObject({ status: 'completed' });
    expect(result.act.payload).toMatchObject({ dryRunOnly: false, executorResult: { reviewed: true } });
    expect(listEvents({ kind: 'noe_act_executed' })).toHaveLength(1);
    expect(listEvents({ kind: 'noe_act_dry_run' })).toHaveLength(0);
  });

  it('fail-closes explicit realExecute when no executor is registered', async () => {
    const { pipeline } = makePipeline();

    const result = await pipeline.propose({ title: 'Review focus', action: 'noe.focus.review', riskLevel: 'low', realExecute: true });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('executor_not_registered');
    expect(result.act).toMatchObject({ status: 'blocked_safety', permissionState: 'blocked_safety' });
    expect(result.act.failureReason).toContain('real executor not registered');
    expect(listEvents({ kind: 'noe_act_executed' })).toHaveLength(0);
    expect(listEvents({ kind: 'noe_act_dry_run' })).toHaveLength(0);
  });

  it('allows consensus-approved self-evolution acts without manual confirmation', async () => {
    writeLedgerReferencedFiles(tmp);
    writeNoeConsensusLedgerFile(passedLedger(), { root: tmp, outDir: 'output/noe-multimodel' });
    const { pipeline } = makePipeline({ selfEvolutionRoot: tmp });

    const result = await pipeline.propose({
      title: 'Consensus-approved self evolution',
      action: 'noe.self_evolution.implementation',
      riskLevel: 'low',
      payload: sePayload(selfEvolutionLedgerRefContext({ authorization: consensusAuth('self-evolution first slice') })),
    });

    expect(result.ok).toBe(true);
    expect(result.act).toMatchObject({ status: 'completed' });
    expect(result.act.payload.selfEvolutionGate.gates.consensusAuthorization).toBe(true);
    expect(listEvents({ kind: 'noe_act_dry_run' })).toHaveLength(1);
  });

  it('allows self-evolution acts authorized by an artifact-valid ledger file ref', async () => {
    writeLedgerReferencedFiles(tmp);
    writeNoeConsensusLedgerFile(passedLedger(), { root: tmp, outDir: 'output/noe-multimodel' });
    const { pipeline } = makePipeline({ selfEvolutionRoot: tmp });

    const result = await pipeline.propose({
      title: 'Ledger file authorized self evolution',
      action: 'noe.self_evolution.implementation',
      riskLevel: 'low',
      payload: sePayload(selfEvolutionContext({
        ledger: undefined,
        ledgerRef: 'output/noe-multimodel/round-a/ledger.json',
        authorization: consensusAuth('ledger file authorization'),
      })),
    });

    expect(result.ok).toBe(true);
    expect(result.act.payload.selfEvolutionGate.gates.consensusAuthorization).toBe(true);
    expect(listEvents({ kind: 'noe_act_dry_run' })).toHaveLength(1);
  });

  it('blocks consensus authorization from a payload ledger object in ActPipeline', async () => {
    const { pipeline } = makePipeline();

    const result = await pipeline.propose({
      title: 'Payload ledger object authorization',
      action: 'noe.self_evolution.implementation',
      riskLevel: 'low',
      payload: sePayload(selfEvolutionContext({ authorization: consensusAuth('payload ledger object') })),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('self_evolution_gate_blocked');
    expect(result.act.payload.selfEvolutionGate.errors).toContain('hard_veto:consensus_authorization_requires_ledger_ref');
    expect(result.act.payload.selfEvolutionGate.errors).toContain('user_or_consensus_authorization_required');
    expect(listEvents({ kind: 'noe_act_dry_run' })).toHaveLength(0);
  });

  it('blocks payload userApproved from authorizing a self-evolution act', async () => {
    const { pipeline } = makePipeline();

    const result = await pipeline.propose({
      title: 'Payload user approval',
      action: 'noe.self_evolution.implementation',
      riskLevel: 'low',
      payload: {
        selfEvolution: selfEvolutionContext({
          authorization: {
            userApproved: true,
            scope: 'payload user approval',
            costClass: 'local_or_user_approved_model_calls',
          },
        }),
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('self_evolution_gate_blocked');
    expect(result.act.payload.selfEvolutionGate.errors).toContain('hard_veto:payload_user_approval_ignored');
    expect(result.act.payload.selfEvolutionGate.errors).toContain('user_or_consensus_authorization_required');
    expect(listEvents({ kind: 'noe_act_dry_run' })).toHaveLength(0);
  });

  it('blocks ledger file authorization when raw model outputs are missing', async () => {
    writeNoeConsensusLedgerFile(passedLedger(), { root: tmp, outDir: 'output/noe-multimodel' });
    const { pipeline } = makePipeline({ selfEvolutionRoot: tmp });

    const result = await pipeline.propose({
      title: 'Ledger file missing raw outputs',
      action: 'noe.self_evolution.implementation',
      riskLevel: 'low',
      payload: sePayload(selfEvolutionContext({
        ledger: undefined,
        ledgerRef: 'output/noe-multimodel/round-a/ledger.json',
        authorization: consensusAuth('ledger file missing raw outputs'),
      })),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('self_evolution_gate_blocked');
    expect(result.act.payload.selfEvolutionGate.errors).toContain('consensus:missing_raw_output_file:codex:output/noe-multimodel/round/codex.txt');
    expect(listEvents({ kind: 'noe_act_dry_run' })).toHaveLength(0);
  });

  it('blocks ledger refs that rely on payload root injection', async () => {
    writeLedgerReferencedFiles(tmp);
    writeNoeConsensusLedgerFile(passedLedger(), { root: tmp, outDir: 'output/noe-multimodel' });
    const { pipeline } = makePipeline();

    const result = await pipeline.propose({
      title: 'Injected root ledger ref',
      action: 'noe.self_evolution.implementation',
      riskLevel: 'low',
      payload: sePayload(selfEvolutionContext({
        root: tmp,
        ledger: undefined,
        ledgerRef: 'output/noe-multimodel/round-a/ledger.json',
        authorization: consensusAuth('payload root injection'),
      })),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('self_evolution_gate_blocked');
    expect(result.act.payload.selfEvolutionGate.errors.some((error) => (
      error.startsWith('consensus:consensus_ledger_ref_invalid:ENOENT: no such file or directory, open')
    ))).toBe(true);
    expect(listEvents({ kind: 'noe_act_dry_run' })).toHaveLength(0);
  });

  it('blocks self-evolution acts before dry-run when the self-evolution gate fails', async () => {
    const { pipeline } = makePipeline();

    const result = await pipeline.propose({
      title: 'Self evolution without valid consensus',
      action: 'noe.self_evolution.implementation',
      riskLevel: 'low',
      payload: {
        selfEvolution: selfEvolutionContext({
          ledger: undefined,
          consensus: { ok: false, errors: ['missing_required_model:claude'] },
          authorization: {
            userApproved: false,
            scope: 'self-evolution first slice',
            costClass: 'local_or_user_approved_model_calls',
          },
        }),
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('self_evolution_gate_blocked');
    expect(result.act).toMatchObject({ status: 'blocked_safety', permissionState: 'blocked_safety' });
    expect(result.act.payload.selfEvolutionGate.errors).toContain('consensus_gate_not_passed');
    expect(listEvents({ kind: 'noe_act_dry_run' })).toHaveLength(0);
  });

  it('blocks self-evolution acts that forge a validated consensus summary without a ledger', async () => {
    const { pipeline } = makePipeline();

    const result = await pipeline.propose({
      title: 'Forged self evolution summary',
      action: 'noe.self_evolution.implementation',
      riskLevel: 'low',
      payload: {
        selfEvolution: selfEvolutionContext({
          ledger: undefined,
          consensus: {
            ok: true,
            validated: true,
            source: 'validated_consensus_ledger',
            ledgerVerified: true,
            consensus: { approvedCount: 4, threshold: 3 },
          },
          authorization: consensusAuth('forged consensus summary'),
        }),
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('self_evolution_gate_blocked');
    expect(result.act.payload.selfEvolutionGate.errors).toContain('validated_consensus_ledger_required');
    expect(listEvents({ kind: 'noe_act_dry_run' })).toHaveLength(0);
  });

  it('allows consensus-approved high-risk self-evolution acts to pass the gate before real execution', async () => {
    writeLedgerReferencedFiles(tmp);
    writeNoeConsensusLedgerFile(passedLedger(), { root: tmp, outDir: 'output/noe-multimodel' });
    let called = 0;
    const { pipeline } = makePipeline({
      selfEvolutionRoot: tmp,
      executors: {
        'noe.self_evolution.implementation': async ({ act }) => {
          called += 1;
          return { selfEvolutionChecked: act.payload.selfEvolutionGate?.ok === true };
        },
      },
    });

    const planned = await pipeline.propose({
      title: 'Approved self-evolution slice',
      action: 'noe.self_evolution.implementation',
      riskLevel: 'high',
      payload: sePayload(selfEvolutionLedgerRefContext({ authorization: consensusAuth('self-evolution first slice') })),
      realExecute: true,
    });
    expect(planned).toMatchObject({ ok: true });
    expect(planned.approvalRequired).toBeUndefined();
    expect(planned.act.status).toBe('completed');
    expect(called).toBe(1);
    expect(planned.act.payload.selfEvolutionGate.ok).toBe(true);
    expect(planned.executorResult).toEqual({ selfEvolutionChecked: true });
  });

  it('allows consensus-approved delete/upload style self-evolution acts to pass as dry-run evidence', async () => {
    writeLedgerReferencedFiles(tmp);
    writeNoeConsensusLedgerFile(passedLedger(), { root: tmp, outDir: 'output/noe-multimodel' });
    const { pipeline } = makePipeline({ selfEvolutionRoot: tmp });

    const result = await pipeline.propose({
      title: 'Consensus-approved scoped deletion',
      action: 'file.delete',
      riskLevel: 'critical',
      payload: {
        path: 'tmp/generated-artifact.txt',
        selfEvolution: selfEvolutionLedgerRefContext({
          authorization: consensusAuth('delete generated artifact after verified rollback'),
          requestedCapabilities: ['file_delete'],
        }),
      },
    });

    expect(result.ok).toBe(true);
    expect(result.act).toMatchObject({ status: 'completed', permissionState: 'allow' });
    expect(result.act.payload.selfEvolutionGate.gates.requestedCapabilities).toContain('file_delete');
    expect(listEvents({ kind: 'noe_act_dry_run' })).toHaveLength(1);
  });

  it('blocks destructive actions with blocked_safety in CE12 P0', async () => {
    const { pipeline } = makePipeline();

    const result = await pipeline.propose({ title: 'Delete files', action: 'file.delete', riskLevel: 'critical' });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('blocked_safety');
    expect(result.act).toMatchObject({ status: 'blocked_safety', permissionState: 'blocked_safety' });
    expect(result.act.failureReason).toContain('blocked');
    expect(listEvents({ kind: 'noe_act_dry_run' })).toHaveLength(0);
  });
});
