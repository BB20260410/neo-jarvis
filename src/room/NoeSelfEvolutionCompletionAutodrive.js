// @ts-check
// P2 complete 闭环自驱器：自进化 cycle 在 apply+runtime 成功后，自动走完
//   post_review_required → retrospective_required → memory_writeback_ready → complete
//   （解「cycle 永停在 post_review_required、DB complete=0」的死锁）。
//
// 安全命脉（与 NoeSelfEvolutionConsensusAutodrive 的关键区别）：
//   consensus 是 planning 阶段，可由 standing-grant 代表 owner 本地批准；
//   post_review 是「patch 已落盘后的复核」——**绝不能硬编码盖章**，否则坏 patch 会自我盖章 complete。
//   故 post_review 必须经注入的 runPostReview 跑**真能拒绝**的非-implementer 复核；
//   未注入 runPostReview → post_review 不自动过（安全失败：无真复核绝不盖章）。任何 reject → 不过。
//   retrospective / memory_writeback 是低风险记录写入（apply+runtime+post-review 都过后才到）。
//
// 全注入式（root/now/runPostReview）；env 门控在 server（NOE_SELF_EVOLUTION_COMPLETION_AUTODRIVE）。
//   未注入本 autodrive 时 trigger 行为与现状逐字一致（零回归）。

import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { evaluateStandingAutonomyGrant } from '../../scripts/lib/noe-standing-autonomy-grant.mjs';
import { validateNoePostReview } from './NoePostReviewGate.js';
import { noeSelfEvolutionReviewerIds } from './NoeSelfEvolutionReviewers.js';

export const SELF_EVOLUTION_GRANT_SCOPE = 'self-evolution:run';
const OUTPUT_DIR = 'output/noe-self-evolution/completion-autodrive';

function cleanString(value) { return String(value || '').trim(); }
function asDate(now) {
  const value = typeof now === 'function' ? now() : now;
  return value instanceof Date ? value : new Date(value || Date.now());
}
function stampOf(date) { return date.toISOString().replace(/[-:.]/g, '').slice(0, 15); }

function writeArtifact(rootAbs, dir, name, content) {
  const ref = `${dir}/${name}`;
  const file = resolve(rootAbs, ref);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, content, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best-effort */ }
  return ref;
}

/**
 * @param {{root?:string, now?:any, requireStandingGrant?:boolean, evaluateGrant?:Function, runPostReview?:Function}} deps
 * @returns {(args:{stage:string, cycle?:object}) => Promise<{ok:boolean, reason?:string, patch?:object, reviews?:any[], grantId?:string}>}
 */
export function makeNoeSelfEvolutionCompletionAutodrive(deps = {}) {
  const {
    root = process.cwd(),
    now = () => new Date(),
    requireStandingGrant = true,
    evaluateGrant = evaluateStandingAutonomyGrant,
    // 真复核函数（能拒绝）：({goal,objective,patchPlanRef,applyReportRef,runtimeReportRef,dir,rootAbs}) =>
    //   Promise<{reviews:[{model,decision,authority,canWrite,rawOutputRef}]}>。未注入=post_review 不自动过。
    runPostReview = null,
  } = deps;

  return async function assembleCompletion({ stage = '', cycle = {} } = {}) {
    // standing-grant 是自驱解锁的唯一授权来源；缺则不解锁（保留 blocked 行为）。
    let grantId = '';
    if (requireStandingGrant) {
      const grant = typeof evaluateGrant === 'function' ? evaluateGrant({ scope: SELF_EVOLUTION_GRANT_SCOPE }) : { authorized: false };
      if (!grant || grant.authorized !== true) return { ok: false, reason: 'standing_grant_required_for_completion_autodrive' };
      grantId = cleanString(grant.grantId);
    }
    const rootAbs = resolve(root);
    const date = asDate(now);
    const dir = `${OUTPUT_DIR}/${stampOf(date)}-${randomUUID().slice(0, 8)}`;
    const goal = cleanString(cycle.goal || cycle.objective) || '自我进化：改进自身代码';

    if (stage === 'post_review_required') {
      // 安全命脉：post_review 必须真复核能拒绝。未注入 runPostReview → 绝不自动盖章。
      if (typeof runPostReview !== 'function') return { ok: false, reason: 'post_review_runner_required' };
      let review;
      try {
        // CRITICAL（总验收三轮·多模型复审实证）：实现证据写在 **nested** cycle.implementation.*（NoeSelfEvolutionTrigger
        //   的 advancedByResult 回写），**不在顶层 cycle.patchPlanRef/applyReportRef**。原读顶层 → 传给 post-review 的
        //   patchPlanRef/applyReportRef 恒空 → pack.implementation.diffRef/touchedFiles 空 → validateNoePostReviewPack
        //   的 requireChangedFiles 失败 → pack_invalid → reviews 永空 → cycle 永卡 post_review（CRITICAL-1 只在 adapter 层
        //   补 actionEvidence 不够，数据流断点在此）。改读 nested 证据（顶层作兼容兜底）+ 透传 touchedFiles 给 pack。
        const impl = (cycle.implementation && typeof cycle.implementation === 'object') ? cycle.implementation : {};
        review = await runPostReview({
          goal,
          objective: cleanString(cycle.objective || cycle.goal),
          patchPlanRef: cleanString(impl.diffRef || impl.patchPlanRef || impl.applyReportRef || cycle.patchPlanRef),
          applyReportRef: cleanString(impl.applyReportRef || impl.evidenceRef || cycle.applyReportRef),
          touchedFiles: Array.isArray(impl.touchedFiles) ? impl.touchedFiles : (Array.isArray(impl.changedFiles) ? impl.changedFiles : []),
          runtimeReportRef: cleanString(cycle.runtimeVerification && cycle.runtimeVerification.reportRef),
          // P0-fix(总验收 Codex):补传 consensusLedgerRef/rollbackRef——NoePostReviewPack 要求这两项,漏传则
          //   pack_invalid、reviews:0 → complete 链路卡死(印证 completion-audit 的 complete_cycle incomplete)。
          //   cycle 在 consensus 阶段已存(NoeSelfEvolutionTrigger 经 cycleStore.advance 写入 cycle.consensusLedgerRef/cycle.rollback)。
          consensusLedgerRef: cleanString(cycle.consensusLedgerRef),
          rollbackRef: cleanString(cycle.rollback && (cycle.rollback.rollbackRef || cycle.rollback.planRef)),
          dir,
          rootAbs,
        });
      } catch (e) { return { ok: false, reason: 'post_review_failed', error: cleanString(e && e.message ? e.message : e).slice(0, 200) }; }
      const reviews = Array.isArray(review && review.reviews) ? review.reviews : [];
      // Finding 1（总验收三轮·多模型复审）：原「anyApprove(≥1) 且无拦截裁决」放行，与 complete gate 用的
      //   validateNoePostReview（**动态 quorum ≥2** + 必需非实施者 reviewer 齐 + rawOutputRef）**定义分歧** →
      //   claude:approve + m3:unavailable 时 autodrive 报 ok:true 推进 post_review，但 complete gate 随后 quorum 不足
      //   打回 complete_blocked（cycle 卡死被 drop，本可重试拿全 reviewer 的一轮被浪费）。改用**与 complete gate 同一份**
      //   validateNoePostReview 判定（共享 source of truth）：post_review 通过 ⟺ complete 的 post-review 检查也会过，消除
      //   状态分歧。它已覆盖「reject/request_changes/未知词」拦截（KNOWN_REVIEW_DECISIONS + APPROVAL_DECISIONS 口径）。
      //   activeExecutor='codex'（self-evolution implementer 恒 codex）；requireFile=false（与 cycle.advance 完整校验同口径）。
      const prErrors = [];
      // P0.2b 修(子代理审 P1-1):启用本地 reviewer 时,这里的 post_review 判定口径必须与 complete gate / cycle 完整校验
      //   一致用本地 reviewer 集——否则 autodrive 按 cloud[claude,m3] 判 → missing_required_reviewer → 永卡 post_review。
      //   env 未设 → undefined → 回退 cloud(零回归)。这正是"post_review 通过 ⟺ complete 也会过"不变量的第三处接线。
      validateNoePostReview(prErrors, { root: rootAbs, postReview: { ok: true, reviews }, requireFile: false, activeExecutor: 'codex', requiredReviewers: noeSelfEvolutionReviewerIds() || undefined, prefix: 'post_review' });
      if (prErrors.length > 0) return { ok: false, reason: 'post_review_not_approved', reviews, errors: prErrors.slice(0, 12) };
      return { ok: true, grantId, reviews, patch: { postReview: { ok: true, reviews } } };
    }

    if (stage === 'retrospective_required') {
      const ref = writeArtifact(rootAbs, dir, 'retrospective.md',
        `# 自进化协作复盘（completion-autodrive 装配）\n\n- 目标：${goal}\n- cycleId：${cleanString(cycle.cycleId)}\n- patchPlanRef：${cleanString(cycle.patchPlanRef)}\n- runtime：${cleanString(cycle.runtimeVerification && cycle.runtimeVerification.reportRef)}\n- 生成：${date.toISOString()}\n- standing-grant：${grantId}\n`);
      // P0.1（complete 控制链 Finding 2 配套）：retrospective 通过即同时记下 memory_writeback 的 consensusAck +
      //   计划 summaryRef（指向 retrospective 文档——真实存在的 summary 类产物）。否则 loop 进入 memory_writeback_BLOCKED
      //   （gate 要 consensusAck+summaryRef，原生产链无人设它们 = cycle 卡在 memory_writeback、永不 complete 的又一断点）。
      //   consensus 已在前序阶段 validated（post_review/retrospective 都过了），故 consensusAck=true 诚实。**不**设 done/ok：
      //   stage 留在 memory_writeback_ready，待 memory_writeback act 真写记忆后由 trigger 推到 done + 真 summaryRef → complete。
      return { ok: true, grantId, patch: { retrospectiveRef: ref, memoryWriteback: { consensusAck: true, summaryRef: ref } } };
    }

    // 注（多模型 review）：memory_writeback_ready / complete 不由本 autodrive 处理——它们在 STAGE_TO_ACTION 里有 action，
    //   走既有 trigger propose-act 路（memory_writeback act 执行器写记忆、complete act 收口）。本 autodrive 只解
    //   post_review_required / retrospective_required 两个原本无 action、永卡的 stuck stage（避免与 act 路双重处理 memory）。
    return { ok: false, reason: 'stage_not_autodrivable' };
  };
}
