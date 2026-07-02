import { describe, it, expect, vi } from 'vitest';
import { makeNoeCompletionPostReview, makeLocalReviewerRunner } from '../../src/room/NoeCompletionPostReview.js';
import { validateNoePostReviewPack } from '../../src/room/NoePostReviewPack.js';

// P2 生产接线适配器：把 cycle 证据→pack→runNoePostReviewRound(runModels)→reviews；fail-safe。

const REVIEWS = [{ model: 'claude', decision: 'approve', authority: 'readonly_source_reviewer', canWrite: false, rawOutputRef: 'o/c.txt' }];

describe('NoeCompletionPostReview 适配器', () => {
  it('正常：透传 runRound 的 reviews + 用 runModels:true/costAcknowledged:true', async () => {
    // P0-fix(Codex):真 runner runModels 路径把 reviews 放进 r.postReview.reviews(顶层无 reviews)——用真 shape,防 mock 掩盖
    const runRound = vi.fn(async () => ({ postReview: { reviews: REVIEWS }, status: 'models_run' }));
    const buildPack = vi.fn((p) => ({ ...p, sha256: 'x' }));
    const adapter = makeNoeCompletionPostReview({ root: '/tmp/x', buildPack, runRound });
    const r = await adapter({ goal: '修 X', patchPlanRef: 'pp.json', applyReportRef: 'ap.json', runtimeReportRef: 'rv.json', dir: 'd' });
    expect(r.reviews).toEqual(REVIEWS);
    // pack 用了 cycle 证据（diffRef=patchPlanRef、runtime reportRef）
    expect(buildPack).toHaveBeenCalledWith(expect.objectContaining({
      goal: '修 X',
      implementation: expect.objectContaining({ diffRef: 'pp.json', activeExecutor: 'codex', done: true }),
      runtimeVerification: expect.objectContaining({ ok: true, reportRef: 'rv.json' }),
    }));
    // runModels + costAcknowledged 必须为 true
    expect(runRound).toHaveBeenCalledWith(expect.objectContaining({ runModels: true, costAcknowledged: true }), expect.objectContaining({ root: '/tmp/x' }));
  });

  // #2 去 codex 收尾：codex 没额度时禁 codex fallback（reviewer unavailable 补 codex runSpawn 不计 quorum、纯超时浪费）。
  //   flag NOE_SELFEVO_NO_CODEX_FALLBACK=1 → 传 codexFallbackOnUnavailable:false 给 runRound；默认 OFF 不传=现状 enabled 零回归。
  it('#2 禁 codex fallback ON → 传 codexFallbackOnUnavailable:false', async () => {
    const runRound = vi.fn(async () => ({ postReview: { reviews: REVIEWS }, status: 'models_run' }));
    const buildPack = vi.fn((p) => ({ ...p, sha256: 'x' }));
    process.env.NOE_SELFEVO_NO_CODEX_FALLBACK = '1';
    try {
      const adapter = makeNoeCompletionPostReview({ root: '/tmp/x', buildPack, runRound });
      await adapter({ goal: 'g', patchPlanRef: 'pp.json', applyReportRef: 'ap.json', runtimeReportRef: 'rv.json', dir: 'd' });
      expect(runRound).toHaveBeenCalledWith(expect.objectContaining({ codexFallbackOnUnavailable: false }), expect.anything());
    } finally { delete process.env.NOE_SELFEVO_NO_CODEX_FALLBACK; }
  });

  it('#2 反向 flag OFF（默认）→ 不传 codexFallbackOnUnavailable（现状 enabled 零回归）', async () => {
    const runRound = vi.fn(async () => ({ postReview: { reviews: REVIEWS }, status: 'models_run' }));
    const buildPack = vi.fn((p) => ({ ...p, sha256: 'x' }));
    const adapter = makeNoeCompletionPostReview({ root: '/tmp/x', buildPack, runRound });
    await adapter({ goal: 'g', patchPlanRef: 'pp.json', applyReportRef: 'ap.json', runtimeReportRef: 'rv.json', dir: 'd' });
    expect(runRound.mock.calls[0][0].codexFallbackOnUnavailable).toBeUndefined();
  });

  it('fail-safe①：runRound 返回 pack_invalid（无 reviews）→ reviews:[]（autodrive 不盖章）', async () => {
    const adapter = makeNoeCompletionPostReview({ buildPack: () => ({}), runRound: async () => ({ ok: false, status: 'pack_invalid' }) });
    const r = await adapter({ goal: 'x' });
    expect(r.reviews).toEqual([]);
  });

  it('fail-safe②：runRound 抛错 → reviews:[]（不静默放行）', async () => {
    const adapter = makeNoeCompletionPostReview({ buildPack: () => ({}), runRound: async () => { throw new Error('models down'); } });
    const r = await adapter({ goal: 'x' });
    expect(r.reviews).toEqual([]);
    expect(r.status).toBe('post_review_adapter_failed');
  });

  // CRITICAL-1（总验收三轮·完整性子代理实证 + 主线实跑亲验）：**不 stub buildPack**，用真 buildNoePostReviewPack 装配，
  //   验证 pack 通过 runner 同款 validateNoePostReviewPack（requireReviewerOutputRefs:true + requireActionEvidence/
  //   Runtime/Rollback 默认 true）。原适配器漏传 actionEvidence + reviewRoundRef → pack_invalid → 模型不跑 → reviews 永空 →
  //   cycle 永卡 post_review（complete=0 核心断点）。这条测试防该断点第三次复发（stub 掉 buildPack 的测试发现不了）。
  it('CRITICAL-1：真 buildNoePostReviewPack 装配的 pack 通过 validateNoePostReviewPack（不再 pack_invalid）', async () => {
    let captured = null;
    const adapter = makeNoeCompletionPostReview({
      runRound: async ({ pack }) => { captured = pack; return { postReview: { reviews: [] }, status: 'models_run' }; },
    });
    await adapter({
      goal: '修复 NoeMissionRunner 前缀越界',
      patchPlanRef: 'output/pp.json', applyReportRef: 'output/ap.json', runtimeReportRef: 'output/rt.json',
      consensusLedgerRef: 'output/l.json', rollbackRef: 'output/rb.json', dir: 'output/noe-post-review/r1',
    });
    expect(captured).toBeTruthy();
    expect(captured.actionEvidence).toBeTruthy();
    expect(captured.actionEvidence.actionId).toBeTruthy();
    const v = validateNoePostReviewPack(captured, { requireReviewerOutputRefs: true });
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  // P0.2b：cloud reviewer（claude CLI 返 prose / m3·xiaomi 外网在 launchd 不可达）在本机自改链全部不可用 → self-evolution
  //   post_review 改用本地 clean-JSON reviewer（env NOE_SELF_EVOLUTION_REVIEW_MODELS 启用，默认空=cloud 零回归）。
  describe('P0.2b 本地 clean-JSON reviewer', () => {
    it('env 混用本地+cloud（local-qwen,m3）→ pack 含两者;只本地 id 注入 runner,m3 走内置 MiniMax 路径', async () => {
      const prev = process.env.NOE_SELF_EVOLUTION_REVIEW_MODELS;
      process.env.NOE_SELF_EVOLUTION_REVIEW_MODELS = 'local-qwen,m3';
      try {
        let capPack = null; let capOpts = null;
        const adapter = makeNoeCompletionPostReview({ runRound: async ({ pack }, opts) => { capPack = pack; capOpts = opts; return { postReview: { reviews: [] }, status: 'x' }; } });
        await adapter({ goal: '修 X', patchPlanRef: 'output/ap.json', applyReportRef: 'output/ap.json', runtimeReportRef: 'output/rt.json', consensusLedgerRef: 'output/l.json', rollbackRef: 'output/rb.json', touchedFiles: ['x.js'], dir: 'output/r1' });
        expect((capPack.postReviewPlan.reviewers || []).filter((r) => r.required).map((r) => r.model)).toEqual(['local-qwen', 'm3']);
        // 只 local-qwen 有本地模型映射 → 只它注入本地 runner;m3 无本地映射 → 不注入 → 走内置 runBuiltInReviewer(MiniMax)。
        expect(Object.keys(capOpts.runners || {})).toEqual(['local-qwen']);
      } finally { if (prev === undefined) delete process.env.NOE_SELF_EVOLUTION_REVIEW_MODELS; else process.env.NOE_SELF_EVOLUTION_REVIEW_MODELS = prev; }
    });

    it('env 未设 → 不注入 runners、用默认 cloud reviewer（零回归）', async () => {
      const prev = process.env.NOE_SELF_EVOLUTION_REVIEW_MODELS; delete process.env.NOE_SELF_EVOLUTION_REVIEW_MODELS;
      try {
        let capOpts = null;
        const adapter = makeNoeCompletionPostReview({ runRound: async (_a, opts) => { capOpts = opts; return { postReview: { reviews: [] }, status: 'x' }; } });
        await adapter({ goal: '修 X', patchPlanRef: 'output/ap.json', runtimeReportRef: 'output/rt.json', consensusLedgerRef: 'output/l.json', rollbackRef: 'output/rb.json', dir: 'output/r1' });
        expect(capOpts.runners).toBeUndefined();
      } finally { if (prev !== undefined) process.env.NOE_SELF_EVOLUTION_REVIEW_MODELS = prev; }
    });

    it('makeLocalReviewerRunner：structuredCall approve → clean JSON 裁决(model=id, canWrite:false)', async () => {
      const runner = makeLocalReviewerRunner('local-qwen', { structuredCall: async () => ({ ok: true, value: { decision: 'approve', confidence: 0.9, consensus_vote: 'yes' } }) });
      const v = JSON.parse(await runner({ prompt: 'review this' }));
      expect(v).toMatchObject({ model: 'local-qwen', decision: 'approve', canWrite: false });
    });

    it('makeLocalReviewerRunner 防假绿：structuredCall 失败 → unavailable（quorum 不计、绝不假 approve）', async () => {
      const runner = makeLocalReviewerRunner('local-gemma', { structuredCall: async () => ({ ok: false, error: 'model down' }) });
      expect(JSON.parse(await runner({ prompt: 'x' })).decision).toBe('unavailable');
    });

    it('makeLocalReviewerRunner：未映射 id → unavailable（不调模型）', async () => {
      let called = false;
      const runner = makeLocalReviewerRunner('local-unknown', { structuredCall: async () => { called = true; return { ok: true, value: { decision: 'approve' } }; } });
      expect(JSON.parse(await runner({ prompt: 'x' })).decision).toBe('unavailable');
      expect(called).toBe(false);
    });
  });
});
