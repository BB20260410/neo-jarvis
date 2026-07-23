import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite, listEvents } from '../../src/storage/SqliteStore.js';
import { ActStore } from '../../src/loop/ActStore.js';
import { ActPipeline } from '../../src/loop/ActPipeline.js';
import { createSafeActExecutors } from '../../src/loop/SafeActExecutors.js';
import { ApprovalStore } from '../../src/approval/ApprovalStore.js';
import { buildNoeConsensusLedger, writeNoeConsensusLedgerFile } from '../../src/room/NoeConsensusLedger.js';
import { NOE_REQUIRED_BOUNDARY_IDS } from '../../src/room/NoeConsensusGate.js';

// self-evolution 生产路径完整端到端：真 ActPipeline + 真 ActGuard gate（consensus ledger 放行）+ 真
// self-evolution executor + 真 NoePatchApplyExecutor。证明 propose → 预算 → 权限(preflight defer)
// → selfEvolutionGate(共识放行) → #executeReal → executor 真改文件 全链真通（不是 dry-run、不是 mock）。

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'noe-se-actpipeline-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

function makePipeline(overrides = {}) {
  const store = new ActStore({ projectId: 'noe-test' });
  const approvalStore = new ApprovalStore({ audit: { recordSafe() {} } });
  const pipeline = new ActPipeline({
    projectId: 'noe-test',
    store,
    approvalStore,
    budget: { preflight: () => ({ ok: true, warnings: [], blocked: [] }) },
    permission: { evaluatePermission: () => ({ decision: 'allow', reason: 'test allow' }) },
    audit: { recordSafe() {} },
    broadcast: () => {},
    logger: null,
    ...overrides,
  });
  return { pipeline, store };
}

function vote(model, evidenceRef) {
  return {
    model,
    decision: 'approve_with_changes',
    authority: model === 'm3' ? 'suggestion_only' : model === 'codex' ? 'writer_integrator' : 'advisory',
    canWrite: model === 'codex',
    firstClass: model === 'claude' ? true : undefined,
    consensusVote: 'yes',
    blockers: [],
    verificationRequired: [`${model} verification`],
    recommendedFirstSlice: [`${model} first slice`],
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
    boundaries: NOE_REQUIRED_BOUNDARY_IDS.map((id) => ({ id })),
    implementation: { writer: 'codex', authorizationRequired: true, runtimeVerificationRequired: true, rollbackRequired: true, memoryWritebackAckRequired: true },
  }, { createdAt: '2026-06-07T00:00:00.000Z' });
}

function writeLedgerReferencedFiles(root) {
  mkdirSync(join(root, 'output/noe-multimodel/round'), { recursive: true });
  writeFileSync(join(root, 'output/noe-multimodel/round/brief.md'), 'consensus brief\n');
  for (const model of ['codex', 'claude', 'm3']) {
    writeFileSync(join(root, `output/noe-multimodel/round/${model}.txt`), `${model} raw output\n`);
  }
}

function writePatchPlan(root, targetRel, content) {
  const ref = 'output/noe-self-evolution/e2e/patch-plan.json';
  mkdirSync(join(root, 'output/noe-self-evolution/e2e'), { recursive: true });
  writeFileSync(join(root, ref), JSON.stringify({
    kind: 'noe_patch_plan',
    operations: [{ id: 'op1', op: 'write_file', path: targetRel, content }],
  }));
  return ref;
}

function selfEvolutionExecutors() {
  return createSafeActExecutors({
    selfEvolution: {
      root: tmp,
      evaluateGrant: () => ({ authorized: true }),
      runtimeVerify: async () => ({ ok: true, reportRef: 'output/noe-self-evolution/runtime-verify/v.json' }),
      now: () => new Date('2026-06-14T00:00:00.000Z'),
    },
  });
}

describe('self-evolution 生产路径完整端到端（真 gate + 真 executor + 真改文件）', () => {
  let prevEnv;
  beforeEach(() => { prevEnv = process.env.NOE_SELF_EVOLUTION_EXECUTORS; process.env.NOE_SELF_EVOLUTION_EXECUTORS = '1'; });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.NOE_SELF_EVOLUTION_EXECUTORS;
    else process.env.NOE_SELF_EVOLUTION_EXECUTORS = prevEnv;
  });

  it('propose 自改 act → 共识 gate 放行 → executor 真改文件 → completed + noe_act_executed', async () => {
    writeLedgerReferencedFiles(tmp);
    writeNoeConsensusLedgerFile(passedLedger(), { root: tmp, outDir: 'output/noe-multimodel' });
    writeFileSync(join(tmp, 'evo-target.txt'), 'ORIGINAL\n');
    const patchRef = writePatchPlan(tmp, 'evo-target.txt', 'CHANGED_VIA_ACTPIPELINE\n');

    const { pipeline } = makePipeline({ selfEvolutionRoot: tmp, executors: selfEvolutionExecutors() });
    const result = await pipeline.propose({
      title: 'E2E self evolution real apply',
      action: 'noe.self_evolution.implementation',
      riskLevel: 'low',
      realExecute: true,
      payload: {
        selfEvolution: {
          action: 'implementation',
          ledger: undefined,
          ledgerRef: 'output/noe-multimodel/round-a/ledger.json',
          patchPlanRef: patchRef,
          authorization: { userApproved: false, consensusApproved: true, scope: 'e2e self-evolution', costClass: 'local_or_user_approved_model_calls' },
          rollback: { planRef: 'output/noe-multimodel/round/rollback.md' },
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.act.status).toBe('completed');
    expect(result.act.payload.selfEvolutionGate.gates.consensusAuthorization).toBe(true);
    // 真改文件证明（经完整 ActPipeline，非直调 executor、非 dry-run）
    expect(readFileSync(join(tmp, 'evo-target.txt'), 'utf8')).toBe('CHANGED_VIA_ACTPIPELINE\n');
    expect(listEvents({ kind: 'noe_act_executed' }).length).toBeGreaterThan(0);
    expect(listEvents({ kind: 'noe_act_dry_run' })).toHaveLength(0);
  });

  it('共识 ledger 缺失 → gate 拦截 → 文件不动（端到端安全网）', async () => {
    // 不写 ledger 文件 → gate consensus 不过
    writeFileSync(join(tmp, 'evo-target.txt'), 'ORIGINAL\n');
    const patchRef = writePatchPlan(tmp, 'evo-target.txt', 'SHOULD_NOT_APPLY\n');
    const { pipeline } = makePipeline({ selfEvolutionRoot: tmp, executors: selfEvolutionExecutors() });
    const result = await pipeline.propose({
      title: 'E2E blocked',
      action: 'noe.self_evolution.implementation',
      riskLevel: 'low',
      realExecute: true,
      payload: {
        selfEvolution: {
          action: 'implementation',
          ledger: undefined,
          ledgerRef: 'output/noe-multimodel/round-a/ledger.json',
          patchPlanRef: patchRef,
          authorization: { userApproved: false, consensusApproved: true, scope: 'e2e', costClass: 'local_or_user_approved_model_calls' },
          rollback: { planRef: 'output/noe-multimodel/round/rollback.md' },
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('self_evolution_gate_blocked');
    expect(readFileSync(join(tmp, 'evo-target.txt'), 'utf8')).toBe('ORIGINAL\n');
    expect(listEvents({ kind: 'noe_act_executed' })).toHaveLength(0);
  });
});

// A2 失败证据回灌(2026-07-03)：verifyReason 必须过 ActPipeline 白名单透传（否则 trigger 拿不到，
//   self_repair 永远盲重试）。用真 pipeline + 真 executor + 注入失败 verify 走完整 catch 路径。
describe('A2 verifyReason 白名单透传（真 pipeline 失败路径）', () => {
  let prevEnv;
  beforeEach(() => { prevEnv = process.env.NOE_SELF_EVOLUTION_EXECUTORS; process.env.NOE_SELF_EVOLUTION_EXECUTORS = '1'; });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.NOE_SELF_EVOLUTION_EXECUTORS;
    else process.env.NOE_SELF_EVOLUTION_EXECUTORS = prevEnv;
  });

  it('verify 失败 → result.selfEvolution.verifyReason 透传到调用方', async () => {
    writeLedgerReferencedFiles(tmp);
    writeNoeConsensusLedgerFile(passedLedger(), { root: tmp, outDir: 'output/noe-multimodel' });
    writeFileSync(join(tmp, 'evo-target.txt'), 'ORIGINAL\n');
    const patchRef = writePatchPlan(tmp, 'evo-target.txt', 'WILL_BE_ROLLED_BACK\n');
    const executors = createSafeActExecutors({
      selfEvolution: {
        root: tmp,
        evaluateGrant: () => ({ authorized: true }),
        runtimeVerify: async () => ({ ok: false, reason: 'type_error_fix_rejected: error 未减少', reportRef: 'output/noe-self-evolution/runtime-verify/vf.json' }),
        now: () => new Date('2026-06-14T00:00:00.000Z'),
      },
    });
    const { pipeline } = makePipeline({ selfEvolutionRoot: tmp, executors });
    const result = await pipeline.propose({
      title: 'A2 verifyReason passthrough',
      action: 'noe.self_evolution.implementation',
      riskLevel: 'low',
      realExecute: true,
      payload: {
        selfEvolution: {
          action: 'implementation',
          ledger: undefined,
          ledgerRef: 'output/noe-multimodel/round-a/ledger.json',
          patchPlanRef: patchRef,
          authorization: { userApproved: false, consensusApproved: true, scope: 'a2 e2e', costClass: 'local_or_user_approved_model_calls' },
          rollback: { planRef: 'output/noe-multimodel/round/rollback.md' },
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.selfEvolution.needsSelfRepair).toBe(true);
    expect(result.selfEvolution.verifyReason).toContain('type_error_fix_rejected');
    // verify 失败已自动回滚，文件复原
    expect(readFileSync(join(tmp, 'evo-target.txt'), 'utf8')).toBe('ORIGINAL\n');
  });
});
