// @ts-check
// P2 生产接线：completion autodrive 的 runPostReview 适配器。
//   把 cycle 的 patch/apply/runtime 证据打成 NoePostReviewPack → 跑真复核(runNoePostReviewRound, runModels) → 返回 reviews。
//   reviewers 默认 = defaultRequiredReviewersFor(codex)（排除 active executor codex）= 非 implementer 复核，能真 approve/reject。
//   **fail-safe**：pack 无效 / round 失败 / 抛错 → 返回 reviews:[] → completion autodrive anyApprove=false → 不盖章（安全：宁可不自驱完成，绝不假通过）。
//   全注入式（buildPack/runRound 可注入便于单测）。runModels 必配 costAcknowledged:true（owner 已撤"花钱"红线 + standing-grant 授权）。

import { buildNoePostReviewPack } from './NoePostReviewPack.js';
import { runNoePostReviewRound } from './NoePostReviewRunner.js';
import { buildNoeActionEvidence } from '../runtime/NoeActionEvidence.js';
import { LmStudioChatAdapter } from './LmStudioChatAdapter.js';
import { noeStructuredCall } from '../runtime/NoeStructuredCall.js';
import { noeSelfEvolutionReviewerIds, noeSelfEvolutionLocalReviewerModel } from './NoeSelfEvolutionReviewers.js';

const clean = (v) => String(v || '').trim();

// P0.2b：本地 clean-JSON reviewer —— cloud reviewer（claude CLI 返 agentic prose / m3·xiaomi 走外网在 launchd 不可达）
//   在本机自改链全部不可用。本地 LM Studio 模型经 reasoning_effort='none'+json_schema 出 clean JSON 裁决（implementer 已验证）。
const REVIEW_VERDICT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    decision: { type: 'string' },
    confidence: { type: 'number' },
    blockers: { type: 'array', items: { type: 'string' } },
    verification_required: { type: 'array', items: { type: 'string' } },
    evidence_gaps: { type: 'array', items: { type: 'string' } },
    consensus_vote: { type: 'string' },
  },
  required: ['decision'],
});
const REVIEW_SYSTEM = [
  'You are an independent, read-only post-implementation reviewer for Noe self-evolution.',
  'The patch is ALREADY applied and runtime-verified (npm test passed). You CANNOT write files.',
  'Judge whether keeping this change is safe and correct. Output ONLY a JSON verdict object — no prose, no markdown fences:',
  '{"decision":"approve"|"approve_with_changes"|"request_changes"|"reject","confidence":0..1,"blockers":[],"verification_required":[],"evidence_gaps":[],"consensus_vote":"yes"|"no"|"abstain"}',
  'Approve a minimal, safe, runtime-verified change even if test coverage is light; use request_changes/reject only for a genuine correctness or safety risk.',
].join(' ');

// 单个本地 reviewer 的 runner（喂给 runNoePostReviewRound 的 opts.runners[id]）：拿 reviewer.prompt → 本地模型出 clean JSON 裁决。
//   非实施者（canWrite:false）；模型不可用/解析失败 → decision:'unavailable'（quorum 不计、绝不假 approve）。
export function makeLocalReviewerRunner(reviewerId, { structuredCall = noeStructuredCall } = {}) {
  return async ({ prompt } = {}) => {
    const localModel = noeSelfEvolutionLocalReviewerModel(reviewerId);
    if (!localModel) return JSON.stringify({ model: reviewerId, decision: 'unavailable', canWrite: false, blockers: ['no_local_model_mapped'] });
    try {
      // LM Studio 本地 API：baseUrl 127.0.0.1:1234/v1 + dummy apiKey（LM Studio 不校验，但 OpenAICompat 适配器要非空，
      //   否则 adapter_error 缺 apiKey）。reasoning_effort='none' 让本地模型直出 content（非进 reasoning_content → 空）。
      const adapter = new LmStudioChatAdapter({
        model: localModel,
        baseUrl: process.env.NOE_LMSTUDIO_BASE_URL || process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1',
        apiKey: process.env.LMSTUDIO_API_KEY || 'lm-studio',
        reasoningEffort: 'none',
        temperature: 0,
        // idle-TTL：本地 reviewer 按需加载、闲置自动卸载（owner 要求只常驻 main 35b）。env 可调,默认 600s。
        loadTtlSeconds: Number.isFinite(Number(process.env.NOE_SELF_EVOLUTION_REVIEWER_TTL_S)) ? Number(process.env.NOE_SELF_EVOLUTION_REVIEWER_TTL_S) : 600,
      });
      const res = await structuredCall({
        adapter,
        messages: [{ role: 'system', content: REVIEW_SYSTEM }, { role: 'user', content: String(prompt || '') }],
        jsonSchema: REVIEW_VERDICT_SCHEMA,
        name: 'noe_post_review_verdict',
      });
      if (res && res.ok && res.value && typeof res.value === 'object') {
        // 安全字段放最后锁死（子代理审 P2-1）：本地模型不得借 JSON 自封 model/canWrite/authority 覆盖——
        //   model 强制 = reviewer 槽 id（审计诚实、防冒充 cloud reviewer）；canWrite 强制 false；authority 固定 advisory。
        return JSON.stringify({ ...res.value, model: reviewerId, canWrite: false, authority: 'advisory' });
      }
      return JSON.stringify({ model: reviewerId, decision: 'unavailable', canWrite: false, blockers: [String((res && res.error) || 'local_review_unparseable').slice(0, 200)] });
    } catch (e) {
      return JSON.stringify({ model: reviewerId, decision: 'unavailable', canWrite: false, blockers: [String((e && e.message) || e).slice(0, 200)] });
    }
  };
}

export function makeNoeCompletionPostReview({
  root = process.cwd(),
  buildPack = buildNoePostReviewPack,
  buildActionEvidence = buildNoeActionEvidence,
  runRound = runNoePostReviewRound,
} = {}) {
  return async function runPostReview({
    goal = '', objective = '', patchPlanRef = '', applyReportRef = '', runtimeReportRef = '', consensusLedgerRef = '', rollbackRef = '', touchedFiles = [], dir = '', rootAbs = root,
  } = {}) {
    try {
      const reviewRoundRef = clean(dir) || 'output/noe-post-review';
      // P0.1（总验收三轮·完整性子代理实证）：runner 用 validateNoePostReviewPack(requireActionEvidence/Runtime/Rollback
      //   默认 true + requireReviewerOutputRefs:true) 校验 pack。原 buildPack 调用**缺 actionEvidence + reviewRoundRef** →
      //   pack_invalid（post_review_action_evidence_required + expected_raw_output_ref_required:claude/m3）→ 在 runModels
      //   **之前**就返回、reviews 永空 → cycle 永卡 post_review_required（complete=0 的核心断点之一，与历史
      //   consensusLedgerRef/rollbackRef 缺失同类、第二次复发）。故补齐：
      //   ① actionEvidence —— validateNoeActionEvidence 以 requireRuntime/requireRollback=true 校验，故须带 runtime/rollback ref；
      //   ② reviewRoundRef —— 给每个 required reviewer 派生 expectedRawOutputRef（reviewRoundRef/<model>.txt）。
      const actionEvidence = buildActionEvidence({
        act: {
          id: clean(patchPlanRef) || clean(goal).slice(0, 160) || 'noe-self-evolution-complete',
          action: 'noe.self_evolution.complete',
          title: `self-evolution complete: ${clean(goal || objective)}`.slice(0, 240),
          riskLevel: 'critical',
        },
        permissionResult: { decision: 'allow', reason: 'self-evolution completion post-review (standing-grant authorized, local 127.0.0.1)' },
        dryRunOnly: false,
        refs: { plan: patchPlanRef, runtimeReport: runtimeReportRef, rollback: rollbackRef, changedFiles: applyReportRef },
      });
      const changedFiles = Array.isArray(touchedFiles) ? touchedFiles.filter(Boolean).map((f) => (f && typeof f === 'object' ? (f.path || f.file || '') : f)).filter(Boolean) : [];
      // P0.2b：env 设了本地 reviewer 集 → 用本地 clean-JSON reviewer（cloud reviewer 在本机自改链不可用）。未设 → null →
      //   pack 用默认 cloud reviewers、runRound 不注入 runners（零回归）。
      const localReviewerIds = noeSelfEvolutionReviewerIds();
      const pack = buildPack({
        goal: goal || objective || '自我进化：改进自身代码',
        actionEvidence,
        consensusLedgerRef,
        // implementation 证据：diffRef/evidenceRef 来自 autodrive 读的 nested cycle.implementation.*（非空）；touchedFiles
        //   双保险 changedFiles —— 满足 validateNoePostReviewPack 的 requireChangedFiles（diffRef||evidenceRef||touchedFiles 非空）。
        implementation: { writer: 'codex', activeExecutor: 'codex', done: true, diffRef: patchPlanRef, evidenceRef: applyReportRef, touchedFiles: changedFiles },
        changedFiles,
        runtimeVerification: { ok: true, reportRef: runtimeReportRef },
        rollback: { planRef: rollbackRef },
        reviewRoundRef,
        // requiredReviewers：默认 defaultRequiredReviewersFor('codex')(cloud);本地启用时换本地 reviewer 集(非 implementer 复核)。
        ...(localReviewerIds ? { requiredReviewers: localReviewerIds } : {}),
      });
      // runners 只给**有本地模型映射**的 reviewer id 注入本地 clean-JSON runner;cloud id（如 m3）不注入 →
      //   runNoePostReviewRound 回落 runBuiltInReviewer 的内置路径（m3 走 MiniMax API，读 MINIMAX_API_KEY）。
      //   这样 reviewer 集可混用「本地 + cloud」（如 local-qwen + m3：本地按需加载 + 云端跨服务商独立，本地只多跑 27b）。
      const localRunnerEntries = localReviewerIds
        ? localReviewerIds.filter((id) => noeSelfEvolutionLocalReviewerModel(id)).map((id) => [id, makeLocalReviewerRunner(id)])
        : [];
      const runners = localRunnerEntries.length ? Object.fromEntries(localRunnerEntries) : undefined;
      // #2 去 codex 收尾：codex 没额度时禁 codex fallback（reviewer unavailable 补 codex runSpawn 不计 quorum、纯超时浪费，
      //   且 codex 没额度补它必失败）。flag NOE_SELFEVO_NO_CODEX_FALLBACK=1 → codexFallbackOnUnavailable:false；默认不传=现状
      //   enabled 逐字零回归。reviewer 已 local-qwen+m3、consensus 本地装配，禁 fallback 后 self-evolution 全链路不调 codex。
      const r = await runRound({
        pack,
        runModels: true,
        costAcknowledged: true,
        outDir: reviewRoundRef,
        ...(process.env.NOE_SELFEVO_NO_CODEX_FALLBACK === '1' ? { codexFallbackOnUnavailable: false } : {}),
      }, { root: rootAbs, ...(runners ? { runners } : {}) });
      // P0-fix(总验收二轮 Codex):runRound runModels 路径把 reviews 放进 r.postReview.reviews(顶层无 reviews),
      //   原读 r.reviews 永远空 → anyApprove=false → cycle 永卡 post_review 不 complete(Neo 没 complete 过的第二根因)。
      //   优先读 postReview.reviews,兼容 dry_run 的顶层 reviews。
      const reviews = Array.isArray(r?.postReview?.reviews) ? r.postReview.reviews
        : (Array.isArray(r?.reviews) ? r.reviews : []);
      return { reviews, status: (r && r.status) || '' };
    } catch (e) {
      // fail-safe：真复核跑挂绝不静默放行 → 空 reviews → autodrive 判 anyApprove=false → 不盖章。
      return { reviews: [], status: 'post_review_adapter_failed', error: String((e && e.message) || e).slice(0, 200) };
    }
  };
}
