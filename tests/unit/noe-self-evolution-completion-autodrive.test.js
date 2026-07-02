import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeNoeSelfEvolutionCompletionAutodrive } from '../../src/room/NoeSelfEvolutionCompletionAutodrive.js';
import { makeNoeCompletionPostReview } from '../../src/room/NoeCompletionPostReview.js';
import { validateNoePostReviewPack } from '../../src/room/NoePostReviewPack.js';

// P2 complete 闭环 autodrive：安全命脉=post_review 真能拒绝（坏 cycle 不自动盖章 complete）。

const grantOk = () => ({ authorized: true, grantId: 'grant-1' });
const reviews = (decisions) => decisions.map((d, i) => ({
  model: i === 0 ? 'claude' : 'm3', decision: d, authority: 'readonly_source_reviewer', canWrite: false, rawOutputRef: `out/${i}.txt`,
}));

function mk(root, { runPostReview, evaluateGrant = grantOk } = {}) {
  return makeNoeSelfEvolutionCompletionAutodrive({ root, now: () => new Date('2026-06-21T00:00:00Z'), evaluateGrant, runPostReview });
}

describe('P2 completion autodrive — 安全(能拒绝) + 三阶段', () => {
  it('post_review 真复核 approve → ok:true，patch.postReview.ok=true', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-ca-'));
    try {
      const ad = mk(root, { runPostReview: async () => ({ reviews: reviews(['approve', 'approve']) }) });
      const r = await ad({ stage: 'post_review_required', cycle: { cycleId: 'c1', goal: 'x' } });
      expect(r.ok).toBe(true);
      expect(r.patch.postReview.ok).toBe(true);
      expect(r.patch.postReview.reviews).toHaveLength(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('P0-fix(总验收 Codex)：cycle 的 consensusLedgerRef/rollbackRef 透传给 runPostReview（漏传则 NoePostReviewPack pack_invalid→complete 卡死）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-ca-'));
    try {
      let received = null;
      const ad = mk(root, { runPostReview: async (args) => { received = args; return { reviews: reviews(['approve', 'approve']) }; } });
      await ad({ stage: 'post_review_required', cycle: { cycleId: 'c1', goal: 'x', patchPlanRef: 'p.json', applyReportRef: 'a.json', consensusLedgerRef: 'output/consensus-ledger.json', rollback: { planRef: 'output/rollback.json' } } });
      expect(received.consensusLedgerRef).toBe('output/consensus-ledger.json'); // 否则 pack.consensus.ledgerRef='' → consensus_ledger_ref_required
      expect(received.rollbackRef).toBe('output/rollback.json'); // 否则 pack.rollback.planRef='' → rollback_ref_required
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('安全命脉①：post_review 有 reject → ok:false（坏 cycle 绝不盖章 complete）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-ca-'));
    try {
      const ad = mk(root, { runPostReview: async () => ({ reviews: reviews(['approve', 'reject']) }) });
      const r = await ad({ stage: 'post_review_required', cycle: { cycleId: 'c1' } });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('post_review_not_approved');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('安全命脉②：未注入 runPostReview → ok:false（无真复核绝不盖章）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-ca-'));
    try {
      const r = await mk(root, {})({ stage: 'post_review_required', cycle: {} });
      expect(r).toMatchObject({ ok: false, reason: 'post_review_runner_required' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('安全命脉③：runPostReview 抛错 → ok:false（不吞错盖章）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-ca-'));
    try {
      const ad = mk(root, { runPostReview: async () => { throw new Error('reviewer down'); } });
      const r = await ad({ stage: 'post_review_required', cycle: {} });
      expect(r).toMatchObject({ ok: false, reason: 'post_review_failed' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('全 unavailable（无 approve）→ ok:false', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-ca-'));
    try {
      const ad = mk(root, { runPostReview: async () => ({ reviews: reviews(['unavailable', 'unavailable']) }) });
      expect((await ad({ stage: 'post_review_required', cycle: {} })).ok).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('安全命脉④：request_changes（非 approve 非 unavailable）→ ok:false（不只字面判 reject）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-ca-'));
    try {
      const ad = mk(root, { runPostReview: async () => ({ reviews: reviews(['approve', 'request_changes']) }) });
      const r = await ad({ stage: 'post_review_required', cycle: {} });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('post_review_not_approved');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('安全命脉⑤：未知裁决词（deny）→ ok:false（默认拦截，不放行未知词）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-ca-'));
    try {
      const ad = mk(root, { runPostReview: async () => ({ reviews: reviews(['approve', 'deny']) }) });
      expect((await ad({ stage: 'post_review_required', cycle: {} })).ok).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('retrospective → 写文件 + patch.retrospectiveRef', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-ca-'));
    try {
      const r = await mk(root, {})({ stage: 'retrospective_required', cycle: { cycleId: 'c1', goal: '改进X' } });
      expect(r.ok).toBe(true);
      expect(existsSync(resolve(root, r.patch.retrospectiveRef))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('memory_writeback_ready → ok:false stage_not_autodrivable（走既有 act 路，autodrive 不双重处理）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-ca-'));
    try {
      const r = await mk(root, {})({ stage: 'memory_writeback_ready', cycle: { cycleId: 'c1' } });
      expect(r).toMatchObject({ ok: false, reason: 'stage_not_autodrivable' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('无 standing grant → ok:false（不解锁，保留 blocked）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-ca-'));
    try {
      const ad = mk(root, { runPostReview: async () => ({ reviews: reviews(['approve']) }), evaluateGrant: () => ({ authorized: false }) });
      expect(await ad({ stage: 'post_review_required', cycle: {} })).toMatchObject({ ok: false, reason: 'standing_grant_required_for_completion_autodrive' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // Finding 1（总验收三轮·多模型复审）：autodrive 的 post_review 判定改用与 complete gate **同一份** validateNoePostReview
  //   （动态 quorum），消除原 anyApprove(≥1) 与 gate quorum(≥2) 的状态分歧。partial availability 应与 complete gate 一致拒绝。
  it('Finding1：1 approve + 1 unavailable（quorum 不足）→ ok:false（与 complete gate quorum 对齐，不再乐观放行）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-ca-'));
    try {
      const ad = mk(root, { runPostReview: async () => ({ reviews: [
        { model: 'claude', decision: 'approve', authority: 'readonly_source_reviewer', canWrite: false, rawOutputRef: 'out/c.txt' },
        { model: 'm3', decision: 'unavailable', authority: 'suggestion_only', canWrite: false, rawOutputRef: 'out/m.txt' },
      ] }) });
      const r = await ad({ stage: 'post_review_required', cycle: { cycleId: 'c1', goal: 'x' } });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('post_review_not_approved');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // CRITICAL（总验收三轮·多模型复审实证）：实现证据写在 **nested** cycle.implementation.*，autodrive 必须从 nested 读
  //   patchPlanRef/applyReportRef/touchedFiles 传给 post-review，否则真 buildPack 的 pack.implementation.diffRef/touchedFiles
  //   为空 → validateNoePostReviewPack 的 requireChangedFiles 失败 → pack_invalid → reviews 永空 → cycle 永卡 post_review。
  //   这里**不 mock** runPostReview 的 pack 构建（用真 makeNoeCompletionPostReview），截获真 pack 跑真 validate——
  //   防该数据流断点复发（mock 掉 runPostReview 的旧测试发现不了）。
  it('CRITICAL(re-gate)：autodrive 从 nested cycle.implementation 读证据 → 真 buildPack 的 pack 通过 validateNoePostReviewPack', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-ca-'));
    try {
      let captured = null;
      const runPostReview = makeNoeCompletionPostReview({ runRound: async ({ pack }) => { captured = pack; return { postReview: { reviews: reviews(['approve', 'approve']) }, status: 'models_run' }; } });
      const ad = mk(root, { runPostReview });
      // 生产真实 cycle：证据全在 nested implementation，**无顶层 patchPlanRef/applyReportRef**（trigger 这样写）。
      const cycle = {
        cycleId: 'c-nested', goal: '修复 NoeMissionRunner 前缀越界',
        implementation: { ok: true, diffRef: 'output/ap.json', applyReportRef: 'output/ap.json', touchedFiles: ['src/room/NoeMissionRunner.js'] },
        runtimeVerification: { ok: true, reportRef: 'output/rt.json' },
        consensusLedgerRef: 'output/l.json',
        rollback: { planRef: 'output/rb.json' },
      };
      const r = await ad({ stage: 'post_review_required', cycle });
      expect(r.ok).toBe(true); // approve×2 → 通过（证明 pack 没 pack_invalid、模型真"跑"出了 reviews）
      expect(captured).toBeTruthy();
      expect(captured.implementation.diffRef).toBe('output/ap.json'); // 从 nested 读到，非空
      expect(captured.implementation.touchedFiles).toEqual(['src/room/NoeMissionRunner.js']);
      expect(captured.actionEvidence).toBeTruthy();
      const v = validateNoePostReviewPack(captured, { requireReviewerOutputRefs: true });
      expect(v.errors).toEqual([]);
      expect(v.ok).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
