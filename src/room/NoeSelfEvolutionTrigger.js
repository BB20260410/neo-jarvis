// @ts-check
// 环2：self-evolution 触发器——让 Noe 自发起意「改自己」。
// 全注入式（goalSystem/cycleStore/propose 注入，便于单测 stub）；env 门控在 server 侧
// （NOE_SELF_EVOLUTION 决定是否装配 + 心跳是否注册 selfEvolve job），OFF 时整条不通电。
// 防上瘾三件套：observe cooldown（默认 30min）+ open 自进化目标去重 + tick 单 writer（一次一个 Cycle 一步）。

import { evaluateNoeSelfEvolutionLoop } from './NoeSelfEvolutionLoop.js';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';
import { normalizeConsensusDecision } from './NoeConsensusGate.js';
import {
  completionRequestsChanges,
  isReworkExhausted,
  collectCompletionBlockers,
  scrubReworkBlocker,
} from './NoeSelfEvolutionRework.js';
import { orderOpenGoalsAvoidingRejectLessons } from './NoeSelfEvolutionLessonRecall.js';
import { improveSignalFromVerifyFailure } from './NoeSelfEvolutionImproveSignal.js';

const DEFAULT_COOLDOWN_MS = 30 * 60_000;
const SELF_EVOLUTION_SOURCE = 'self_evolution';
const SIGNAL_RE = /改[^，。！？\s]{0,3}(自己|自身|自身代码)|自我?(进化|改进|完善|升级|修复|改造|迭代)|进化自己|重构自身|self[\s_-]?evol/i;

// loop.stage → 可由 trigger 落成的 self_evolution act action。
// 其余 stage（consensus_blocked/implementation_blocked/runtime_verification_required/
// post_review_required/retrospective_required 等）是 consensus/codex/复核的活，trigger 不 propose。
const STAGE_TO_ACTION = Object.freeze({
  implementation_ready: 'noe.self_evolution.implementation',
  self_repair_ready: 'noe.self_evolution.self_repair',
  memory_writeback_ready: 'noe.self_evolution.memory_writeback',
  complete: 'noe.self_evolution.complete',
});

function cleanString(value) {
  return String(value || '').trim();
}

// 据 cycle 证据装配「脱敏」记忆回写 summary（仅元信息：目标 + 改动文件数 + runtime/复核状态；绝不含 diff/文件内容/secret）。
//   memory_writeback executor 要 summary 否则 throw self_evolution_memory_summary_required；executor 再经
//   redactSensitiveText 二次脱敏后落库 + 落 summaryRef artifact（供 cycle 完成完整校验 cycle_memory_summary_ref）。
function buildSelfEvolutionMemorySummary(cycle = {}) {
  const goal = cleanString(cycle.goal || cycle.objective || cycle.title) || '自我进化';
  const impl = (cycle.implementation && typeof cycle.implementation === 'object') ? cycle.implementation : {};
  const touched = Array.isArray(impl.touchedFiles) ? impl.touchedFiles.length : 0;
  const runtimeOk = !!(cycle.runtimeVerification && cycle.runtimeVerification.ok === true);
  const reviewed = !!(cycle.postReview && cycle.postReview.ok === true);
  return `自我进化 cycle 完成：${goal}。改动 ${touched} 个文件；runtime 验证${runtimeOk ? '通过' : '未通过'}；非实施者复核${reviewed ? '已批准' : '未记录'}。`.slice(0, 500);
}

function asMs(now) {
  const v = typeof now === 'function' ? now() : now;
  return Number(v) || 0;
}

// 识别文本是否含「改自身 / 自我进化」意图。
export function classifySelfEvolutionSignal(text = '') {
  const t = cleanString(text);
  if (!t) return { isSelfEvolution: false, reason: 'empty' };
  if (SIGNAL_RE.test(t)) return { isSelfEvolution: true, reason: 'pattern_match' };
  return { isSelfEvolution: false, reason: 'no_match' };
}

// P0-4 AUTOSEED 目标质量：判 objective 是否含「可定位的技术对象」而非纯情绪碎片。
//   实测情绪碎片目标（如「LangGraph 踏实感」）会被 openSelfEvolutionGoals()[0] 永久自锁、空转锁死自驱链。
//   缺陷词 → 永远算技术目标（缺陷天然具体）；情绪词且无技术锚 → 拒；技术锚 +（可选）动作词 → 立项。
const OBJECTIVE_DEFECT_RE = /bug|缺陷|越界|泄漏|泄露|崩溃|报错|错误|失败|异常|回归|死锁|超时|内存泄|leak|race\s*condition|panic|stack\s*trace|throw|reject/i;
const OBJECTIVE_TECH_RE = /(?:src|tests|docs|scripts|public)\/[\w./-]+\.\w+|代码|函数|方法|模块|算法|机制|接口|实现|重构|参数|阈值|索引|架构|逻辑|召回|判证|流程|prompt|查询|缓存|并发|序列化|schema|正则|路由|端点|存储|数据库|sql|配置|字段|状态机|管线|pipeline|率|延迟|耗时|覆盖|准确|吞吐|性能|命中|精度|时延/i;
const OBJECTIVE_ACTION_RE = /修复|优化|重构|实现|改进|提升|补全|增加|减少|消除|加固|治理|改正|修正|解决|加速|降低|提高|拆分|合并|清理|完善|去重|缓存/;
const OBJECTIVE_EMOTION_RE = /踏实感|安全感|归属感|成就感|幸福|温柔|耐心|陪伴|心情|情绪|感觉|更有|更踏实|更安心|想要|希望能|开心|快乐|喜欢|爱/;
// 强技术锚：具体可定位的代码对象——文件路径 / 点号引用(foo.bar) / 函数调用(foo() / snake_case 标识符。
//   红队实锤：泛技术词(率/机制/流程/接口/配置)被情绪句塞一个即穿透质量闸（召回率 bug）→ 情绪句必须有「强锚」
//   才立项，单个泛词不足以让情绪碎片过关。强锚存在即立项（即便带情绪，owner 倾向有具体对象就放手做）。
const OBJECTIVE_STRONG_ANCHOR_RE = /(?:src|tests|docs|scripts|public)\/[\w./-]+\.\w+|\b\w{2,}\.\w{2,}\b|\b[A-Za-z_$][\w$]+\s*\(|\b[a-z][a-z0-9]+_[a-z0-9]+\b/;
// Step 1（飞轮停摆修复 finding 4）：诗性观感意图词——「想看/看着…节奏/指尖/起落」这类纯感受，无可执行技术动作。
//   strictPoetic ON 时即便句中含泛技术词（代码/机制…）也判情绪碎片，堵 autoseed 立"想看 Noe 敲代码节奏"类注定被复核拒的诗性目标。
const OBJECTIVE_POETIC_RE = /想看|看着|看看|瞧瞧|感受|体会|节奏|指尖|起落|韵律|氛围|样子|画面|风景|心境|意境|凝视|端详/;

export function classifySelfEvolutionObjectiveQuality(objective = '', { strictPoetic = false } = {}) {
  const t = cleanString(objective);
  if (!t) return { hasTechnicalTarget: false, reason: 'empty' };
  if (OBJECTIVE_DEFECT_RE.test(t)) return { hasTechnicalTarget: true, reason: 'defect_keyword' };
  if (OBJECTIVE_STRONG_ANCHOR_RE.test(t)) return { hasTechnicalTarget: true, reason: 'strong_anchor' };
  // 立项闸 #24（互审否决·诚实留痕）：曾试 meta_bookkeeping 关键词判据拦 skill-card 目标，三子代理+主线亲核一致证明
  //   关键词黑名单判价值弊大于利——①裸词"里程碑"误伤真技术(实测"重构里程碑状态机"被误杀,里程碑是本库一等概念)②鸡肋
  //   (纯记账无技术词本就落 no_technical_anchor 被拦,唯一增量全在"带技术词的灰色记账"该交盖章点用产物证据判)③立项闸
  //   本职=判"有无技术着力点"非"判价值"。已撤回——skill-card 假进化交盖章点 substance 闸拦(产物 docs/skill-cards/*.md,实测 4/5)。
  // 情绪句 + 无强锚（哪怕含泛技术词）→ 视为情绪碎片，不立项（红队修复：堵泛词穿透）。
  if (OBJECTIVE_EMOTION_RE.test(t)) return { hasTechnicalTarget: false, reason: 'emotional_fragment' };
  // Step 1 + 多模型审 P2-4：strictPoetic ON 时，纯诗性观感意图（含诗性词但「无可执行动作」）算情绪碎片不立项；
  //   若带技术动作词（优化/重构/修复…）则是真技术目标（如"优化调度节奏算法"），让位给下方 tech+action 判定，不误杀。
  if (strictPoetic && OBJECTIVE_POETIC_RE.test(t) && !OBJECTIVE_ACTION_RE.test(t)) return { hasTechnicalTarget: false, reason: 'poetic_fragment' };
  const tech = OBJECTIVE_TECH_RE.test(t);
  if (tech && OBJECTIVE_ACTION_RE.test(t)) return { hasTechnicalTarget: true, reason: 'tech_object_with_action' };
  if (tech) return { hasTechnicalTarget: true, reason: 'tech_object' };
  return { hasTechnicalTarget: false, reason: 'no_technical_anchor' };
}

// 构造 source=self_evolution 的目标对象（交给 goalSystem.add）。
export function buildSelfEvolutionGoal({ objective = '' } = {}) {
  const title = (cleanString(objective) || '自我进化：改进自身代码').slice(0, 200);
  return { title, source: SELF_EVOLUTION_SOURCE, why: 'self-evolution trigger' };
}

// 阶段二A（2026-07-03）：按信号保留率加权排序开放目标——治「test_gap drop 59% 黑洞」。仪表盘证据:test_gap 最差、
//   self_directed/high_complexity 最健康。有效优先级 = 原 priority × 信号保留率权重(高保留信号靠前、低保留降权)。
//   探索地板:权重非 0(不完全饿死任何信号,保探索广度)。signalWeight 默认 ()=>1 = 逐字零回归;fail-open。
export function orderSelfEvolutionGoalsByEffectivePriority(goals, signalWeight = () => 1) {
  const rows = Array.isArray(goals) ? goals : [];
  const weightOf = (g) => {
    let w = 1;
    try { w = Number(signalWeight((g && g.meta && g.meta.signal) || '')); } catch { w = 1; }
    return (Number.isFinite(w) && w > 0) ? w : 1;
  };
  return rows.slice().sort((a, b) => ((Number(b?.priority) || 0) * weightOf(b)) - ((Number(a?.priority) || 0) * weightOf(a)));
}


// Step 2'（飞轮停摆核心）：判 completion 是否「真拒」——reviewer 明确 reject。
//   区别于①暂时失败（reason=post_review_runner_required/post_review_failed/grant_required，复核器不可用/网络/无授权）
//   ②复核器不全致 quorum 不足（reason=post_review_not_approved 但 reviews 无明确负面 decision，只是 unavailable/abstain）
//   ③request_changes（多模型审 P1-3：是「返工信号」非「不可救」，留走原 stuck-drop / 后续返工路径 Step 3'，不在此 terminal 丢弃）。
//   只有明确「reject」才 terminal → 学习+释放坑位；其余保留重试/返工，绝不因网络/复核器/可返工问题误丢 cycle。
export function isTerminalPostReviewReject(completion) {
  if (!completion || completion.ok !== false) return false;
  if (completion.reason !== 'post_review_not_approved') return false;
  const reviews = Array.isArray(completion.reviews) ? completion.reviews : [];
  return reviews.some((r) => normalizeConsensusDecision(r && r.decision) === 'reject');
}

export function createNoeSelfEvolutionTrigger(deps = {}) {
  const {
    goalSystem = null,
    cycleStore = null,
    propose = null, // async (input) => actResult；包 ActPipeline.propose
    now = () => Date.now(),
    cooldownMs = DEFAULT_COOLDOWN_MS,
    // consensus 死锁的最小推进：注入则在 stage=consensus_blocked 时自动装配本地 validated consensus
    //   ledger（NoeSelfEvolutionConsensusAutodrive），patch 进 cycle 解锁。null（默认）= 不解锁，
    //   行为与现状逐字一致（env NOE_SELF_EVOLUTION_CONSENSUS_AUTODRIVE 在 server 侧门控注入）。
    assembleConsensus = null, // ({goal, objective}) => {ok, consensusLedgerRef, rollback, authorization, ...}
    // P2 complete 闭环：post_review_required/retrospective_required 两个 stuck stage（无 action、原永卡）的自驱器。
    //   ({stage, cycle}) => {ok, patch}；post_review 经真复核能拒绝（ok=false 则不 advance、保持 blocked）。未注入=零回归。
    assembleCompletion = null,
    // A4 真执行闸：server 侧按 NOE_SELF_EVOLUTION_REAL_APPLY 注入。OFF（默认）时 implementation/self_repair
    //   仍 dry-run（与通电前逐字一致）；ON 时仅对这两类「真改代码」动作传 realExecute:true（仍过 gate +
    //   standing-grant + PolicyFileGuard 三道硬校验，绝不绕安全网）。
    realApply = false,
    // P0-4 AUTOSEED 质量闸：ON 时 observe 要求 objective 含可定位技术对象（否则返回 clarification、不立空转目标）。
    //   默认 false = 与现状逐字一致（既有单测的通用 objective 不受影响）；server 侧对自进化 trigger 置 true。
    requireTechnicalTarget = false,
    // Step 1（飞轮停摆 finding 4）：ON 时 observe 把 strictPoetic 透传质量闸，堵「诗性观感词 + 泛技术词」穿透立项。
    //   默认 false = 逐字现状（零回归）；server 按 flag NOE_SELFEVO_STRICT_AUTOSEED 置真。
    strictAutoseed = false,
    // 改动3（learning 反馈闭环）：ON 时 observe 立项前召回近期 reject lesson，与当前 objective 近重复则 hard block
    //   （从失败学→不重复立注定被拒的项）。默认 OFF=逐字现状；fail-open（recall 失败/未注入则放行，不饿死飞轮）。
    lessonAwareAutoseed = false,
    recallRejectLessons = null, // (objective) => { similar, reason, lessonObjective, score }
    // P0-4 卡死解锁：同一 goal 连续 N 拍停在非可执行阶段（如 consensus_blocked 无 autodrive）→ 自动 drop 解锁，
    //   防 openSelfEvolutionGoals()[0] 被一个永远推不动的目标永久占位。0（默认）= 关闭（向后兼容）。
    maxNonProgressTicks = 0,
    // Step 2'（飞轮停摆核心）：post_review 真拒后「学习 + 写 terminal artifact + 快速释放坑位」的开关 + 结构化学习回调。
    //   默认 OFF/null = 逐字现状（reject 仍走原 stuck-drop 等 maxNonProgressTicks 拍）；server 按 flag NOE_SELFEVO_REJECT_LEARNING 注入。
    rejectLearning = false,
    recordFailureLesson = null,
    // Step 3（返工闭环）：post_review 列 request_changes（非 reject）时不卡死/不占坑——清证据回 implementation 携 blocker 重做。
    //   reworkEnabled 默认 OFF（server 按 flag NOE_SELFEVO_REWORK 注入）；maxReworkRounds 0=关（默认），>0 才允许返工，
    //   超限转 terminal 学习+释放（复用 Step2'）。reworkRounds 持久化在 cycle（落库，非 in-memory），双保险防无限返工。
    reworkEnabled = false,
    maxReworkRounds = 0,
    // #19 假进化观测哨兵（shadow，绝不拦·非真闸）：complete 盖章时按 holdout delta 记账 cycle.holdoutShadow。
    //   注入式评估器（server 按 flag NOE_SELFEVO_HOLDOUT_SHADOW 注入 evaluateSelfEvolutionHoldoutShadow）；null=不启用→零回归。
    holdoutShadow = null,
    // 阶段二A:信号保留率权重 (signal) => 权重[地板,1];默认 ()=>1 = 逐字零回归。server 按 flag NOE_SELFEVO_SIGNAL_WEIGHTING 注入(从 DB 算各信号 done/(done+dropped))。
    signalRetentionWeight = () => 1,
    // 飞轮 stuck 根因修复(2026-07-03)·A1：ON 时对 type_error goal 把 meta.errors（行号/错误码/消息，seed 采集）
    //   拼进 objective——实证根因：implementer prompt 此前只有「修 X 的类型 error」九个字，零错误信息 → 盲猜 →
    //   价值锚正确拒 → 反复失败 drop（70 个 self_repair_ready 尸体 cycle）。默认 OFF = objective 逐字现状零回归；
    //   server 按 flag NOE_SELFEVO_TYPEERR_DETAIL 注入。
    typeErrDetail = false,
    // 飞轮 stuck 根因修复(2026-07-03)·A2：ON 时 ①implementation verify 失败（needsSelfRepair）回写把 executor
    //   带回的 verifyReason 存 cycle.repairHints（redactSensitiveText 脱敏）②self_repair act 的 objective 拼
    //   「上轮验证失败原因」——实证根因：self_repair 的 implementer 输入与上次完全相同 = 盲重试（359 次
    //   needs_consensus 失败全烧在盲猜上）。默认 OFF = 回写/objective 逐字现状零回归；server 按 flag
    //   NOE_SELFEVO_REPAIR_HINTS 注入。
    repairHintsEnabled = false,
    // 飞轮 stuck 根因修复(2026-07-03)·B：ON 时 ①同一 goal 连续 maxSameFailureRetries 拍**同因**失败（同 failure
    //   reason=确定性失败，重试同输入不可能成功）→ 提前写 stuckDrop 终态 artifact + 学 lesson + drop（不再烧满
    //   maxNonProgressTicks 拍，实证生产 5 拍全烧在盲重试上）②noteStuck 常规 drop 也补写 stuckDrop artifact——
    //   否则 cycle 停尸在 self_repair_ready/implementation_ready（DB 实测 139 个），复盘统计误读「卡在半路」。
    //   默认 OFF = 零回归；server 按 flag NOE_SELFEVO_FAILFAST 注入。
    failFast = false,
    maxSameFailureRetries = 2,
  } = deps;

  let lastObserveAt = 0;
  const nonProgressTicks = new Map(); // goalId → 连续无进展拍数（in-memory，进程级；重启自然清零）
  const sameFailureStreak = new Map(); // B fail-fast：goalId → {reason, count}（in-memory；重启清零，与 nonProgressTicks 同生命周期）

  function noteProgress(id) { nonProgressTicks.delete(id); sameFailureStreak.delete(id); }
  // B：stuckDrop 终态 artifact——goal 被放弃时给 cycle 落「已放弃」戳（atStage/reason/repeats），让 DB 终态统计
  //   能区分「真在途」与「尸体」。reason 经 redactSensitiveText 脱敏。返回 advance 是否成功。
  function writeStuckDropArtifact(cycle, stage, reason, repeats) {
    if (!failFast || !cycle || !cycle.cycleId || typeof cycleStore?.advance !== 'function') return false;
    const adv = cycleStore.advance(cycle.cycleId, {
      stuckDrop: {
        terminal: true,
        atStage: cleanString(stage) || 'unknown',
        reason: redactSensitiveText(cleanString(reason)).slice(0, 200),
        repeats: Number(repeats) || 0,
        droppedAt: asMs(now),
      },
    });
    return !!(adv && adv.ok);
  }
  // 轴4（2026-07-03）：从 stuck-ctx 提炼失败教训上下文（objective + cycleId + 卡在哪）。fail-open 返最小对象。
  function stuckLessonCtx(cycle, loop) {
    const c = (cycle && typeof cycle === 'object') ? cycle : {};
    return {
      objective: cleanString(c.objective || c.goal || c.title),
      cycleId: cleanString(c.cycleId),
      errors: [`反复无进展被放弃（卡在 ${(loop && loop.stage) || 'unknown'} 阶段）`],
    };
  }
  // 记一拍无进展；达阈值则 drop goal 解锁。返回 {dropped, count}。
  // 轴4：drop 时（= 该 goal 反复 verify/self_repair 失败被判"改不动"而放弃）提炼一条失败教训喂回学习库——
  //   此前只有 post_review reject 学习，占多数的 verify_not_green 失败教训全丢（370 回滚仅 1-2 条教训、飞轮反复撞同类改不动目标）。
  //   受 rejectLearning 门控（复用 NOE_SELFEVO_REJECT_LEARNING）；只在真放弃目标时记（非每拍），让 recallRejectLessons 下次立项能甄别避免重复。
  function noteStuck(id, ctx = {}) {
    if (!(maxNonProgressTicks > 0)) return { dropped: false, count: 0 };
    const count = (nonProgressTicks.get(id) || 0) + 1;
    if (count >= maxNonProgressTicks) {
      const dropped = !!(goalSystem && typeof goalSystem.setStatus === 'function' && goalSystem.setStatus(id, 'dropped') === true);
      // 只在 drop 成功才清零；失败（DB 锁/异常）保留计数下拍重试，避免「清零→永远到不了阈值→永远 drop 不掉」（code-reviewer）。
      if (dropped) {
        nonProgressTicks.delete(id);
        if (rejectLearning && typeof recordFailureLesson === 'function' && cleanString(ctx.objective)) {
          try {
            recordFailureLesson({
              goalId: id,
              cycleId: cleanString(ctx.cycleId),
              objective: cleanString(ctx.objective),
              reviews: [],
              errors: Array.isArray(ctx.errors) ? ctx.errors.slice(0, 8) : [],
              reason: 'stuck_repeated_failure',
            });
          } catch { /* fail-open：学习失败不阻断解锁 */ }
        }
      } else nonProgressTicks.set(id, count);
      return { dropped, count };
    }
    nonProgressTicks.set(id, count);
    return { dropped: false, count };
  }

  // Step 3：tick 算 loop 时透传返工上下文（reworkEnabled / 当前轮次 / 上限），让 loop 在 request_changes 未超限时算出
  //   post_review_rework_ready（而非永卡 post_review_required）。**仅 trigger 运行时透传**——computeStage/DB stage 不带，
  //   回归面最小：OFF 或无 request_changes 时 loop 行为逐字不变。
  // progressBlocker：必须透传 autodrive 能力，否则永远报告 consensus_blocked_no_autodrive 假信号。
  function evalLoop(c) {
    return evaluateNoeSelfEvolutionLoop({
      ...c,
      dryRun: true,
      reworkEnabled,
      reworkRounds: Number(c.reworkRounds || 0),
      maxReworkRounds,
      hasConsensusAutodrive: typeof assembleConsensus === 'function',
      hasCompletionAutodrive: typeof assembleCompletion === 'function',
    });
  }
  // Step 3 清证据返工（统一入口，两个触发源共用 → DRY + 脱敏统一）：清旧阶段产物（防假循环复用旧 postReview/retrospective/memory）
  //   + reworkRounds+1（持久化，超限有界）+ 落脱敏后的 reviewer blocker。判定/脱敏/blocker 合并的纯函数见 NoeSelfEvolutionRework.js。
  function applyReworkAdvance(c, rawBlockers) {
    const blockers = (Array.isArray(rawBlockers) ? rawBlockers : [])
      .map((b) => scrubReworkBlocker(b)).filter(Boolean).slice(0, 12);
    // P1-3：同时清 nested retrospective（loop retrospectiveRef 回退读 retrospective.ref/reportRef，只清 retrospectiveRef:'' 会漏 → 复用旧复盘跳过该步）。
    return cycleStore.advance(c.cycleId, {
      implementation: {}, runtimeVerification: {}, postReview: {}, retrospectiveRef: '', retrospective: {}, memoryWriteback: {},
      reworkRounds: Number(c.reworkRounds || 0) + 1, reworkBlockers: blockers, lastReworkAt: asMs(now),
    });
  }

  function openSelfEvolutionGoals() {
    if (!goalSystem || typeof goalSystem.list !== 'function') return [];
    const open = goalSystem.list({ status: 'open', limit: 200 }) || [];
    const active = goalSystem.list({ status: 'active', limit: 200 }) || [];
    // 合并后按 priority 全局降序——修「open 排在 active 前，致高优先的 active 真信号被低优先的 open 诗性目标永久插队」。
    //   实测根因：真信号 active(0.85) 被诗性 open(0.75) 打断，selfEvolve 选 [0] 反复做无法实现的诗性目标 → M3 诚实产空
    //   → no_patch_plan → 失败冷却 → 真信号永远轮不上。改按 priority 排序后，高价值真信号目标才能优先送到 implement。
    // 阶段二A:按信号保留率加权(signalRetentionWeight,默认 ()=>1 零回归)——高保留信号靠前、test_gap 降权但留探索地板。
    let ordered = orderSelfEvolutionGoalsByEffectivePriority(
      [...open, ...active].filter((g) => g && g.source === SELF_EVOLUTION_SOURCE),
      signalRetentionWeight,
    );
    // Lesson flywheel on *open* goals (not only autoseed): demote near-duplicates of reject lessons
    // so tick never re-picks a doomed objective as [0] forever. Flag reuses lessonAwareAutoseed.
    if (lessonAwareAutoseed && typeof recallRejectLessons === 'function' && ordered.length) {
      try {
        ordered = orderOpenGoalsAvoidingRejectLessons(ordered, recallRejectLessons, { demoteOnly: true }).ordered;
      } catch { /* fail-open: keep priority order */ }
    }
    return ordered;
  }

  // observe：收到「改自身」信号 → cooldown + open 去重 → 立项（goalSystem.add）。
  function observe({ text = '', objective = '' } = {}) {
    const signal = classifySelfEvolutionSignal(objective || text);
    if (!signal.isSelfEvolution) return { ok: false, reason: 'not_self_evolution_signal' };
    if (requireTechnicalTarget) {
      const quality = classifySelfEvolutionObjectiveQuality(objective || text, { strictPoetic: strictAutoseed });
      if (!quality.hasTechnicalTarget) {
        // P0-4：纯情绪/模糊目标不立项（防空转自锁），但返回 ClarificationRequest（非静默丢弃，第二轮审计），
        //   供编排向 owner 取技术对象。clarification 不耗 cooldown（lastObserveAt 仅成功立项才设）。
        return {
          ok: false,
          reason: 'no_technical_target',
          qualityReason: quality.reason,
          clarification: '请把要自改的目标落到可定位的技术对象上（文件路径 / 函数名 / 缺陷现象 / 可执行动作），而非纯感受。',
        };
      }
    }
    // 改动3（learning 反馈闭环）：质量闸通过后、cooldown 前，查是否与近期被拒 lesson 近重复。
    //   similar → hard block（不立项 + clarification），不耗 cooldown（与质量闸 clarification 一致，编排可换角度立刻重试）。
    //   fail-open：recall 抛错/未注入 → 不拦（绝不因记忆系统故障饿死飞轮）。flag OFF 整段跳过 = 零回归。
    if (lessonAwareAutoseed && typeof recallRejectLessons === 'function') {
      let verdict = null;
      try { verdict = recallRejectLessons(objective || text); } catch { verdict = null; }
      if (verdict && verdict.similar === true) {
        const lo = cleanString(verdict.lessonObjective).slice(0, 60);
        return {
          ok: false,
          reason: 'similar_to_rejected_lesson',
          matchedLesson: cleanString(verdict.lessonObjective).slice(0, 120),
          clarification: `这个目标与最近被复核拒绝的「${lo || '某自进化项'}」高度相似。先解决上次 blocker 或换个角度再立项更可能通过。`,
        };
      }
    }
    const t = asMs(now);
    if (t - lastObserveAt < cooldownMs) return { ok: false, reason: 'cooldown' };
    const existing = openSelfEvolutionGoals();
    if (existing.length) return { ok: false, reason: 'open_self_evolution_goal_exists', goalId: existing[0]?.id || '' };
    if (!goalSystem || typeof goalSystem.add !== 'function') return { ok: false, reason: 'goal_system_unavailable' };
    const goalId = goalSystem.add(buildSelfEvolutionGoal({ objective: objective || text }));
    if (!goalId) return { ok: false, reason: 'goal_add_rejected' };
    lastObserveAt = t; // 仅成功立项才起 cooldown（被去重/拒绝不消耗冷却窗口）
    return { ok: true, goalId };
  }

  // tick：单 writer 推进一个 Cycle 一步。取/建 goal 的 cycle → loop 求 stage → ready 阶段 propose 对应 act。
  async function tick({ goalId } = {}) {
    const id = cleanString(goalId);
    if (!id) return { ok: false, reason: 'goal_id_required' };
    if (!cycleStore || typeof cycleStore.getByGoal !== 'function') return { ok: false, reason: 'cycle_store_unavailable' };
    // goal 提到 tick 作用域(原在 !cycle 块内)：type_error_fix 域要在 selfEvolutionPayload 透传 goal.meta(signal/targetFile/errorCount)。
    const goal = goalSystem && typeof goalSystem.get === 'function' ? goalSystem.get(id) : null;
    let cycle = cycleStore.getByGoal(id);
    if (!cycle) {
      const created = cycleStore.upsert({ goalId: id, goal: cleanString(goal?.title || goal?.goal) || '自我进化' });
      if (!created || created.ok !== true) return { ok: false, reason: 'cycle_create_failed', errors: created?.errors || [] };
      cycle = created.cycle;
    }
    let loop = evalLoop(cycle);
    let autodrive = null;
    let cycleAdvancedThisTick = false; // 仅当 cycle 真前进（advance.ok）才算进展——autodrive.ok≠cycle推进（红队实锤）
    // consensus 死锁最小推进：consensus_blocked 且注入了 autodrive → 装配本地 validated ledger，patch
    //   cycle（consensusLedgerRef + authorization + rollback）→ 重算 loop。装配失败/未注入则保持原行为。
    if (loop.stage === 'consensus_blocked' && typeof assembleConsensus === 'function') {
      autodrive = assembleConsensus({ goal: cleanString(cycle.goal || cycle.title), objective: cleanString(cycle.objective || cycle.goal) });
      if (autodrive && autodrive.ok) {
        const patch = {
          consensusLedgerRef: autodrive.consensusLedgerRef || autodrive.ledgerRef,
          authorization: { ...(cycle.authorization || {}), ...(autodrive.authorization || {}) },
          rollback: { ...(cycle.rollback || {}), ...(autodrive.rollback || {}) },
        };
        const advanced = cycleStore.advance(cycle.cycleId, patch);
        if (advanced && advanced.ok && advanced.cycle) {
          cycle = advanced.cycle;
          loop = evalLoop(cycle);
          cycleAdvancedThisTick = true; // cycle 真前进，才重置卡死计数
        }
      }
    }
    // P2 complete 闭环：post_review_required / retrospective_required（无 STAGE_TO_ACTION、原永卡 → DB complete=0）
    //   由 completion autodrive 自驱（一拍一阶段，单 writer，对齐 consensus autodrive）。安全：post_review 经真复核能拒绝，
    //   ok=false（含 reject / 无复核器 / 无 grant）则不 advance、保持 blocked（坏 cycle 绝不自动盖章 complete）。
    if ((loop.stage === 'post_review_required' || loop.stage === 'retrospective_required') && typeof assembleCompletion === 'function') {
      const completion = await assembleCompletion({ stage: loop.stage, cycle });
      if (completion && completion.ok && completion.patch) {
        const advanced = cycleStore.advance(cycle.cycleId, completion.patch);
        if (advanced && advanced.ok && advanced.cycle) {
          cycle = advanced.cycle;
          loop = evalLoop(cycle);
          cycleAdvancedThisTick = true; // cycle 真前进才重置卡死计数
        }
      } else if ((rejectLearning && isTerminalPostReviewReject(completion)) || isReworkExhausted(completion, { reworkEnabled, reworkRounds: Number(cycle.reworkRounds || 0), maxReworkRounds })) {
        // reject = reviewer 明确终拒（学习受 rejectLearning 门控，零回归）；rework_exhausted = request_changes 返工到上限仍未过——
        //   多模型审 P1-3：rework_exhausted 收口（学习+drop）**独立于 rejectLearning**（isReworkExhausted 已含 reworkEnabled 检查），
        //   防只开 NOE_SELFEVO_REWORK 不开 REJECT_LEARNING 时返工超限退化 60 拍 stuck-drop。两者都该学习+释放，不再卡死/无限返工。
        const reworkExhausted = isReworkExhausted(completion, { reworkEnabled, reworkRounds: Number(cycle.reworkRounds || 0), maxReworkRounds });
        // Step 2'（飞轮停摆核心）：post_review 真拒（reviewer 明确 reject）→ 学习 + 写 terminal artifact + 快速释放坑位，
        //   不再卡死重试到 maxNonProgressTicks 拍 drop（浪费整个 cycle + 占唯一坑位 28h 堵供给链）。
        //   暂时失败 / 复核器不全（quorum 不足）/ request_changes(可返工) 不进此分支（isTerminalPostReviewReject 已甄别）→ 保留重试/返工。
        //   安全：post_review 复核能拒绝的命脉不动（reject 依旧 reject，绝不盖章 complete）；只加被拒后的善后。
        // 多模型审 P0-2：先写 terminal artifact 并校验 advance.ok——写入成功才学习+释放坑位；失败（DB锁/校验/cycle不存在）
        //   则不 drop（保留 cycle，下拍重试/走原 stuck-drop），避免「goal 已释放但 postReviewFailure 没落库」审计断。
        //   artifact 里的 errors 也经 redactSensitiveText 脱敏（落 cycle_json，绝不带 secret）。
        const adv = (typeof cycleStore.advance === 'function')
          ? cycleStore.advance(cycle.cycleId, {
              postReviewFailure: {
                terminal: true,
                reason: reworkExhausted ? 'rework_exhausted' : completion.reason,
                errors: (Array.isArray(completion.errors) ? completion.errors : []).map((e) => redactSensitiveText(String(e)).slice(0, 120)).slice(0, 12),
                reviewedAt: asMs(now),
              },
            })
          : { ok: false, errors: ['cycle_store_unavailable'] };
        if (!adv || adv.ok !== true) {
          return { ok: true, proposed: false, stage: loop.stage, cycleId: cycle.cycleId, reason: 'post_review_reject_artifact_failed' };
        }
        // artifact 已落库 → 学习（recordFailureLesson 内部对 reviews/errors 二次脱敏）+ 释放坑位。
        if (typeof recordFailureLesson === 'function') {
          recordFailureLesson({
            cycleId: cycle.cycleId,
            goalId: id,
            objective: cleanString(cycle.objective || cycle.goal || cycle.title),
            reviews: Array.isArray(completion.reviews) ? completion.reviews : [],
            errors: Array.isArray(completion.errors) ? completion.errors : [],
            reason: completion.reason,
          });
        }
        const dropped = !!(goalSystem && typeof goalSystem.setStatus === 'function' && goalSystem.setStatus(id, 'dropped') === true);
        return {
          ok: true, proposed: false, stage: loop.stage, cycleId: cycle.cycleId,
          ...(dropped
            ? { goalDropped: true, reason: reworkExhausted ? 'rework_exhausted_learned' : 'post_review_rejected_learned' }
            : { reason: 'post_review_rejected_release_failed' }),
        };
      } else if (reworkEnabled && Number(cycle.reworkRounds || 0) < maxReworkRounds && completionRequestsChanges(completion)) {
        // Step 3 返工主链路：request_changes（非 reject）未超限 → 直接清证据返工（reviewer blocker from completion.errors，helper 内脱敏后落 cycle）。
        //   信号来自实时 assembleCompletion 返回（不在 cycle.postReview）；直接清证据避免把未脱敏 errors 持久化中转（守"secret 不入 db"）。
        //   清证据后 evalLoop 重算 → implementation_ready，下方复用现有 implementation propose 路径返工（objective 拼脱敏 blocker）。
        const adv = applyReworkAdvance(cycle, collectCompletionBlockers(completion));
        if (adv && adv.ok && adv.cycle) {
          cycle = adv.cycle;
          loop = evalLoop(cycle);
          cycleAdvancedThisTick = true;
        }
      }
    }
    // Step 3 返工兜底：cycle.postReview 已含 request_changes（如历史数据/外部写入）时 loop 直接算 post_review_rework_ready →
    //   清证据返工（blocker from loop.evidence.postReviewBlockers）。主链路走上方 completion autodrive 分支；此分支覆盖信号已落 cycle 的情况。
    //   advance 失败则不重算（stage 仍 rework_ready，STAGE_TO_ACTION 无此 key → 不 propose，下方 noteStuck 兜底，绝不带病前进）。
    if (loop.stage === 'post_review_rework_ready' && typeof cycleStore.advance === 'function') {
      const adv = applyReworkAdvance(cycle, loop.evidence?.postReviewBlockers);
      if (adv && adv.ok && adv.cycle) {
        cycle = adv.cycle;
        loop = evalLoop(cycle);
        cycleAdvancedThisTick = true;
      }
    }
    const action = STAGE_TO_ACTION[loop.stage];
    if (!action) {
      // 当前阶段需 consensus/codex/复核补料，trigger 不 propose（返回下一步提示供编排）。
      // P0-4 卡死跟踪：仅当本拍 cycle 真前进（advance.ok）才算进展（重置）；autodrive.ok 但 advance 失败仍卡着
      //   → 计一拍无进展（红队实锤：用 autodrive.ok 会被「装配成功但落库失败」假推进永久废掉解锁）。达阈值 drop。
      const advancedThisTick = cycleAdvancedThisTick;
      let stuck = { dropped: false, count: 0 };
      if (advancedThisTick) noteProgress(id); else stuck = noteStuck(id, stuckLessonCtx(cycle, loop));
      // B：drop 成功后补写 stuckDrop 终态戳（best-effort——goal 已释放，artifact 失败只丢注记不阻断解锁）。
      if (stuck.dropped) writeStuckDropArtifact(cycle, loop.stage, `反复无进展 ${stuck.count} 拍被放弃`, stuck.count);
      return {
        ok: true,
        proposed: false,
        stage: loop.stage,
        nextAction: loop.nextAction,
        cycleId: cycle.cycleId,
        progressBlocker: loop.progressBlocker || null,
        ...(stuck.dropped ? { goalDropped: true, reason: 'stuck_unlocked', droppedAfterTicks: stuck.count } : {}),
        ...(autodrive ? { autodrive: { ok: autodrive.ok, reason: autodrive.reason || '' } } : {}),
      };
    }
    if (typeof propose !== 'function') return { ok: false, reason: 'propose_unavailable', stage: loop.stage, cycleId: cycle.cycleId };
    // realApply=ON 时四个自改动作全部真执行（ActPipeline #executeReal 跑 executor）：implementation/self_repair
    //   真改代码、memory_writeback 真写脱敏记忆、complete 真记完成事件。**原仅 code-changing 真执行 →
    //   memory_writeback/complete 永远 dry-run（executor 不跑、记忆不写、cycle.memoryWriteback 永不回填）= cycle
    //   永不到 complete、DB complete=0 的最深根因**（complete 控制链 Finding 2）。action 恒为 STAGE_TO_ACTION 之一
    //   （上方 !action 已 early-return）。不传 riskLevel（self_evolution 经 normalizeRisk 恒 critical，传 low 是死参数）。
    //   realApply=OFF（默认 shadow）时四动作全 dry-run、全不回写，零回归。
    const isCodeChangingAction = action === STAGE_TO_ACTION.implementation_ready || action === STAGE_TO_ACTION.self_repair_ready;
    const isMemoryWriteback = action === STAGE_TO_ACTION.memory_writeback_ready;
    const realExecute = realApply === true;
    // memory_writeback executor 要 ctx.memoryWriteback.summary（脱敏，无 diff/secret），否则 throw；据 cycle 证据装配灌入。
    const baseObjective = cleanString(cycle.objective || cycle.goal || cycle.title || '自我进化');
    const reworkBlockers = Array.isArray(cycle.reworkBlockers) ? cycle.reworkBlockers.filter(Boolean) : [];
    const reworkRoundsForObjective = Number(cycle.reworkRounds || 0);
    // A1（typeErrDetail flag）：type_error goal 把 seed 采集的错误详情拼进 objective，implementer 才知道「哪行什么错」。
    //   fail-open：meta.errors 缺失/非数组 → 空串 = 不拼；flag OFF → 空串 = 逐字现状。
    const typeErrDetailText = (typeErrDetail
      && goal && goal.meta && goal.meta.signal === 'type_error' && Array.isArray(goal.meta.errors) && goal.meta.errors.length)
      ? `\n\n[typecheck 错误详情，逐条修复]\n${goal.meta.errors.slice(0, 5)
        .map((e) => `L${Number(e?.line) || 0} ${cleanString(e?.code)}: ${cleanString(e?.message).slice(0, 200)}`).join('\n')}`
      : '';
    // A2（repairHintsEnabled flag）：仅 self_repair 动作拼「上轮验证失败原因」（needsSelfRepair 回写时已脱敏），
    //   implementer 才知道上次为什么不过、针对性修而非盲重试。flag OFF / 无 hints / 非 self_repair → 空串零回归。
    const repairHintText = (repairHintsEnabled && action === STAGE_TO_ACTION.self_repair_ready
      && Array.isArray(cycle.repairHints) && cycle.repairHints.filter(Boolean).length)
      ? `\n\n[上轮验证失败原因，修复时须针对性解决]\n${cycle.repairHints.filter(Boolean).slice(0, 3).map((h) => `- ${cleanString(h).slice(0, 300)}`).join('\n')}`
      : '';
    const selfEvolutionPayload = {
      ...cycle,
      action: action.replace('noe.self_evolution.', ''),
      // P2 硬化（P1 子代理发现历史 drill 报告 objective 空）：显式灌 objective，别只靠 executor 隐式回退 ctx.goal。
      //   cycle.goal 在建库时已带 goal.title || '自我进化' 兜底，故此处始终非空，implementer 不再可能拿空目标。
      // Step 3 返工：reworkRounds>0 时把 reviewer blocker 拼进 objective，implementer 才看得到「上轮被要求改什么」（否则只收原 objective 重复犯）。
      objective: ((reworkRoundsForObjective > 0 && reworkBlockers.length)
        ? `${baseObjective}\n\n[返工 round ${reworkRoundsForObjective}/${maxReworkRounds}] 须解决复核 blocker：${reworkBlockers.join('；')}`
        : baseObjective) + typeErrDetailText + repairHintText,
      // type_error_fix 域(扩展自主能力域):透传 goal.meta 给 executor,使其对 type_error goal 包装 runtimeVerify
      //   (apply 后跑 typecheck + 防作弊价值锚)。守卫:仅 type_error goal 带这些字段,其他 goal 零影响。
      ...(goal && goal.meta && goal.meta.signal === 'type_error'
        ? { signal: 'type_error', targetFile: goal.meta.targetFile, beforeErrorCount: goal.meta.errorCount }
        // 根因修复(2026-07-01)：self_directed_evolution 方向也透传真实 targetFile，让 implementer 拿完整路径(不再从
        //   objective 模块名猜路径→patch_replace_file_missing→dropped)。仅带 targetFile(不带 type_error 的 verify 包装)。
        : (goal && goal.meta && goal.meta.signal === 'self_directed_evolution' && goal.meta.targetFile
          ? { targetFile: goal.meta.targetFile }
          : {})),
    };
    if (isMemoryWriteback) {
      selfEvolutionPayload.memoryWriteback = {
        ...(cycle.memoryWriteback && typeof cycle.memoryWriteback === 'object' && !Array.isArray(cycle.memoryWriteback) ? cycle.memoryWriteback : {}),
        summary: buildSelfEvolutionMemorySummary(cycle),
      };
    }
    const actResult = await propose({
      action,
      title: `self-evolution: ${loop.nextAction}`,
      selfEvolution: selfEvolutionPayload,
      payload: { source: SELF_EVOLUTION_SOURCE, goalId: id, cycleId: cycle.cycleId },
      proposedBy: 'noe-self-evolution-trigger',
      ...(realExecute ? { realExecute: true } : {}), // 走显式真执行授权;不传 riskLevel
    });
    // B5 消死循环：真执行后按 action 把结果回写 cycle，推进 loop（否则每拍重提同一 act）。dry-run（realApply=OFF）不回写。
    let advancedByResult = false;
    if (realExecute && isCodeChangingAction && actResult && actResult.ok === true && typeof cycleStore.advance === 'function') {
      // implementation / self_repair 成功 → 回写 implementation done + runtime（→ post_review_required）。
      //   对齐 ActPipeline.#executeReal 真实返回 {ok, act, executorResult}：报告 ref 在 executorResult 顶层兄弟。
      const er = actResult.executorResult
        || (actResult.act && actResult.act.payload && actResult.act.payload.executorResult)
        || {};
      // 组装 cycle.implementation 必须带实现证据(diffRef + touchedFiles)，否则撞完成门 cycle_implementation_evidence_required。
      //   runtimeVerification.ok 用严格 ===true：避免 skip/缺字段的 undefined 被当通过（防假绿）。
      const erTouched = Array.isArray(er.touchedFiles) ? er.touchedFiles
        : (Array.isArray(er.changedFiles) ? er.changedFiles : []);
      const adv = cycleStore.advance(cycle.cycleId, {
        implementation: {
          ok: true,
          // Finding 3（总验收三轮·多模型）：executor 返回真实 patchPlanRef（原始 patch plan，≠ applyReportRef），原回写丢弃 →
          //   下游只能拿 diffRef(=applyReportRef) 当 patchPlanRef，patch plan 可追溯性丢失。显式保留之（autodrive 读取仍 diffRef 优先，行为不变）。
          patchPlanRef: er.patchPlanRef || '',
          applyReportRef: er.applyReportRef || '',
          diffRef: er.diffRef || er.applyReportRef || '',
          touchedFiles: erTouched,
        },
        runtimeVerification: { ok: er.runtimeOk === true, reportRef: er.runtimeReportRef || '' },
      });
      advancedByResult = !!(adv && adv.ok);
    } else if (realExecute && isCodeChangingAction && actResult && actResult.ok === false && typeof cycleStore.advance === 'function') {
      // Finding 3：**implementation** verify 失败（executor 自动 rollback 并 throw needsSelfRepair）→ 回写 implementation
      //   done + runtimeVerification.ok=false → loop 转 self_repair_ready（不再卡 implementation_ready 反复重试）。
      //   结构化字段经 ActPipeline catch 保留在 actResult.selfEvolution。仅 needsSelfRepair 才路由。
      //   注意分工：**self_repair** 自身失败 throw 的是 needsConsensus（非 needsSelfRepair，见 NoeSelfEvolutionExecutors.js:358），
      //   故 self_repair 失败**不**进本分支 → advancedByResult=false → noteStuck → 达阈值 drop（有界，无无限循环）；
      //   preflight/grant 等硬失败同样无 needsSelfRepair → 同走 stuck-drop。
      const se = (actResult.selfEvolution && typeof actResult.selfEvolution === 'object') ? actResult.selfEvolution : {};
      if (se.needsSelfRepair === true) {
        const failRef = cleanString(se.applyReportRef);
        // Perception ring: prefer executor-attached ImproveSignal; else build from verifyReason + goal anchors.
        const improveSignal = (se.improveSignal && typeof se.improveSignal === 'object' && se.improveSignal.hasTechnicalAnchor !== undefined)
          ? se.improveSignal
          : improveSignalFromVerifyFailure({
            targetFile: cleanString(cycle.targetFile || cycle.meta?.targetFile || se.targetFile),
            verifyReason: se.verifyReason,
            objective: cleanString(cycle.objective || cycle.goal || ''),
          });
        // A2：verifyReason 存 cycle.repairHints（脱敏+截断），self_repair 拍据此拼 objective（flag OFF 不写=零回归）。
        const baseHint = repairHintsEnabled ? redactSensitiveText(cleanString(se.verifyReason)).slice(0, 300) : '';
        const anchorHint = improveSignal?.hasTechnicalAnchor && improveSignal?.objective
          ? redactSensitiveText(String(improveSignal.objective)).slice(0, 300)
          : '';
        const repairHints = repairHintsEnabled
          ? [baseHint, anchorHint].filter(Boolean).slice(0, 4)
          : [];
        const adv = cycleStore.advance(cycle.cycleId, {
          implementation: { ok: true, applyReportRef: failRef, diffRef: failRef },
          runtimeVerification: { ok: false, reportRef: cleanString(se.runtimeReportRef) },
          ...(repairHints.length ? { repairHints } : {}),
          // Structured perception anchor for self_repair / lesson flywheel (no secrets).
          lastImproveSignal: improveSignal || null,
          // CRITICAL-2（complete 控制链·完整性子代理实证）：self_repair gate 硬要 repairReturnsToConsensus===true，而
          //   生产源码**无任何 producer** → gate 恒 false → loop 算出 self_repair_BLOCKED（STAGE_TO_ACTION 无此 key）→
          //   trigger 不 propose、cycle 卡死被 drop（= Finding-3 路由到一个不可达的 stage）。此处声明「自修失败则回
          //   consensus」契约（self_repair executor 失败确实 throw self_repair_failed_needs_consensus），使 loop 算出
          //   self_repair_READY（可达），self_repair act 才会被 propose。failedVerificationRef loop 会用 runtime.reportRef
          //   兜底，这里显式带上更稳。
          repairReturnsToConsensus: true,
          failedVerificationRef: cleanString(se.runtimeReportRef),
        });
        advancedByResult = !!(adv && adv.ok);
      }
    } else if (realExecute && isMemoryWriteback && actResult && actResult.ok === true && typeof cycleStore.advance === 'function') {
      // Finding 2：memory_writeback 真写记忆成功 → 回写 memoryWriteback done（含 summaryRef，满足 complete 完整校验
      //   cycle_memory_summary_ref）→ loop 重算到 complete（cycle.stage='complete' = DB complete++）。
      const er = actResult.executorResult
        || (actResult.act && actResult.act.payload && actResult.act.payload.executorResult)
        || {};
      // 合并保留 retrospective 步设的 consensusAck + 计划 summaryRef（store advance 顶层浅合并会整体替换 memoryWriteback，
      //   不 merge 会丢 consensusAck → complete gate 的 memory_writeback_ack 再次失败）。
      // summaryRef 选取（防多模型审指出的「假绿面」）：仅当 executor 真把 artifact 落了盘（summaryWritten===true）才用其
      //   er.summaryRef；否则回退到 retrospective 步设的 priorMw.summaryRef（指向真实存在的 retrospective.md），绝不让
      //   summaryRef 指向一个没写成功的文件（虽 cycle 层 requireFile=false 不查存在性，但留真实可达 ref 更诚实、防 complete 虚高）。
      const priorMw = (cycle.memoryWriteback && typeof cycle.memoryWriteback === 'object' && !Array.isArray(cycle.memoryWriteback)) ? cycle.memoryWriteback : {};
      const writtenSummaryRef = (er.summaryWritten === true && cleanString(er.summaryRef)) ? cleanString(er.summaryRef) : '';
      const adv = cycleStore.advance(cycle.cycleId, {
        memoryWriteback: { ...priorMw, ok: true, done: true, memoryId: cleanString(er.memoryId), summaryRef: writtenSummaryRef || cleanString(priorMw.summaryRef) || cleanString(er.summaryRef) },
      });
      advancedByResult = !!(adv && adv.ok);
    }
    // P0-2 生命周期闭环：cycle 走到 complete（complete act 成功）→ 显式关 goal。self_evolution goal 已被
    //   通用 closeResolvedGoals/nextStep 豁免（防 bootstrap research 步刷 done 切断心跳），代价是 goal 永 open；
    //   故改由 cycle 完成时在此收口。只在 complete 动作成功时关，否则 goal 保持 active 让下一拍继续推进 cycle。
    let goalClosed = false;
    if (action === STAGE_TO_ACTION.complete && actResult && actResult.ok === true
        && goalSystem && typeof goalSystem.setStatus === 'function') {
      goalClosed = goalSystem.setStatus(id, 'done') === true;
    }
    // #19 假进化观测哨兵（shadow，绝不拦·非真闸）：complete 盖章成功时按 holdout delta 记"按外部 holdout 该不该算
    //   成功"，advance 记账 cycle.holdoutShadow。flag OFF → 未注入 → 跳过（零回归）。评估器抛错 fail-open：观测器
    //   绝不影响飞轮盖章。飞轮现状不产 holdout 证据 → 恒记 unverified（观测不拦；真根治需上游让飞轮产 holdout 证据）。
    let holdoutShadowResult;
    if (action === STAGE_TO_ACTION.complete && actResult && actResult.ok === true
        && typeof holdoutShadow === 'function') {
      try {
        const shadow = holdoutShadow(cycle);
        if (shadow) {
          holdoutShadowResult = shadow;
          if (typeof cycleStore.advance === 'function') {
            cycleStore.advance(cycle.cycleId, { holdoutShadow: shadow });
          }
        }
      } catch { /* fail-open：observation must never break the flywheel */ }
    }
    // 卡死跟踪（红队 round-2）：进展看 act 真成功（actResult.ok）**或 cycle 真前进（advancedByResult）**——Finding 3 的
    //   verify 失败→self_repair 路由里 actResult.ok=false 但 cycle 真前进（implementation_ready→self_repair_ready），
    //   算进展不算卡死；否则会被「提出成功/换 stage」误判而永不/过早 drop。
    let stuck = { dropped: false, count: 0 };
    if ((actResult && actResult.ok === true) || advancedByResult) noteProgress(id);
    else {
      // B fail-fast：同一 goal 连续同因失败（同 failure reason = 确定性失败，重试同输入不可能成功）达阈值 →
      //   先写 stuckDrop 终态 artifact（对齐 Step 2' 纪律：落库成功才释放坑位，防「goal 释放但终态没落库」审计断）
      //   → 学 lesson（受 rejectLearning 门控）→ drop 释放。不再烧满 maxNonProgressTicks 拍盲重试。
      //   失败原因变化 = 新信息 → streak 重置，保留原有界重试。
      if (failFast && maxSameFailureRetries > 0) {
        const failReason = cleanString(actResult && (actResult.error || actResult.reason)) || 'unknown_failure';
        const prev = sameFailureStreak.get(id);
        const count = (prev && prev.reason === failReason) ? prev.count + 1 : 1;
        sameFailureStreak.set(id, { reason: failReason, count });
        if (count >= maxSameFailureRetries && writeStuckDropArtifact(cycle, loop.stage, failReason, count)) {
          if (rejectLearning && typeof recordFailureLesson === 'function') {
            try {
              recordFailureLesson({
                goalId: id,
                cycleId: cleanString(cycle.cycleId),
                objective: cleanString(cycle.objective || cycle.goal || cycle.title),
                reviews: [],
                errors: [`同因连败 ${count} 拍（${redactSensitiveText(failReason).slice(0, 160)}），fail-fast 放弃`],
                reason: 'failfast_same_failure_repeated',
              });
            } catch { /* fail-open：学习失败不阻断释放 */ }
          }
          const dropped = !!(goalSystem && typeof goalSystem.setStatus === 'function' && goalSystem.setStatus(id, 'dropped') === true);
          if (dropped) {
            nonProgressTicks.delete(id);
            sameFailureStreak.delete(id);
            return { ok: true, proposed: true, stage: loop.stage, action, cycleId: cycle.cycleId, actResult, advancedByResult, goalClosed,
              goalDropped: true, reason: 'failfast_same_failure', droppedAfterRepeats: count };
          }
          // 释放失败（DB 锁等）→ 不清计数，落回下方有界 noteStuck 路径，下拍重试
        }
      }
      stuck = noteStuck(id, stuckLessonCtx(cycle, loop));
      // B：常规 stuck-drop 也补终态戳（best-effort——goal 已释放，artifact 失败只丢注记不阻断解锁）。
      if (stuck.dropped) writeStuckDropArtifact(cycle, loop.stage, `反复无进展 ${stuck.count} 拍被放弃`, stuck.count);
    }
    return { ok: true, proposed: true, stage: loop.stage, action, cycleId: cycle.cycleId, actResult, advancedByResult, goalClosed,
      ...(holdoutShadowResult ? { holdoutShadow: holdoutShadowResult } : {}),
      ...(stuck.dropped ? { goalDropped: true, reason: 'stuck_unlocked', droppedAfterTicks: stuck.count } : {}),
      ...(autodrive ? { autodrive: { ok: autodrive.ok, consensusLedgerRef: autodrive.consensusLedgerRef || '' } } : {}) };
  }

  return { observe, tick, openSelfEvolutionGoals, classifySelfEvolutionSignal, buildSelfEvolutionGoal };
}
