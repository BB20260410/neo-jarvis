// @ts-check
// NoeWorkspace — 全局工作区：注意力竞争 + 串行广播 + 意识日志（设计文档《AI自我意识实现方案》§6 P3，
// 结构性缺口三）。
//
// 问题：感知/念头/承诺/期望/驱力各自为政，没有"此刻我在注意什么"——没有统一的意识内容。
// 设计（GWT 工程化）：每个 meso tick 收集候选 → 确定性显著度打分 → 唯一赢家"广播"=本周期焦点：
//   ① 焦点喂给反刍（focusProvider 注入 InnerMonologue）——注意力决定意识内容；
//   ② 高分焦点升级深思脑审议（自我质询协议，NoeDeliberation），审议预算每日有上限；
//   ③ 审议"想说"经浮现门（NoeSurfacingGate）→ 既有升华通道入店，绝不开新说话通道；
//   ④ 每周期一行意识日志 JSONL（~/.noe-panel/consciousness/<date>.jsonl）——包括落选者
//      （"我注意到了但没理会"也是经历），这是机制一/六的证据层 + 内心透视页的数据源。
// 打分 v1 全确定性（owner 0.35 / 紧迫 0.25 / 新异 0.2 / 情感 0.2），novelty 用字符相似度对最近
// 广播去重；后续可升级向量。纪律：单 tick 串行、fail-open、零付费模型（审议走本地深思脑）。
// S0.3 思维回环守卫（NOE_THOUGHT_LOOP_GUARD=1 默认 OFF）：广播赢家前对近期广播窗口跑 analyzeThoughtLoop（跨窗口关键词文档频率→主题固着），命中只写 thought_loop 日志+暴露信号，绝不改 winner/currentFocus；门控关/未注入→整段跳过逐字零变化。
import { analyzeThoughtLoop } from './NoeThoughtLoopGuard.js';
import { clamp01 } from './_mathUtils.js';

// S0.3：剥离广播格式前缀（"标签：内容"→"内容"），避免格式标签（如"眼前看到："）污染回环主题检测；
// 冒号在前 12 字内才剥，长前缀（如"推进目标「…」："）保留——反复推进同一目标本身即一种主题固着，不该被剥。
function stripBroadcastLabel(s) {
  const t = String(s || '');
  const i = t.indexOf('：');
  return i > 0 && i <= 12 ? t.slice(i + 1) : t;
}

const SOURCE_BASE = Object.freeze({
  owner_interaction: { owner: 1.0, urgency: 0.4, affect: 0.5 },
  commitment_due: { owner: 0.8, urgency: 1.0, affect: 0.4 },
  expectation_due: { owner: 0.3, urgency: 0.7, affect: 0.3 },
  goal_step: { owner: 0.25, urgency: 0.55, affect: 0.3 },
  fresh_insight: { owner: 0.2, urgency: 0.45, affect: 0.35 }, // 昨夜反思的洞察（M9）：晨间优先回味
  percept: { owner: 0.6, urgency: 0.2, affect: 0.3 },
  system_state: { owner: 0.3, urgency: 0.15, affect: 0.2 }, // 本机感知（M3）：低权背景源，没别的事时"看看自己机器"
  drive: { owner: 0.1, urgency: 0.5, affect: 0.4 },
  last_thought: { owner: 0.0, urgency: 0.1, affect: 0.2 },
});
// 显著度(salience)打分四权重默认值（GEPA 参数进化的「可优化对象」锚点；改造前为同名常量，值逐字不变）。
// 三层缺省链由工厂 resolveSalienceWeights 实现：构造 opts.salienceWeights → env NOE_WS_SALIENCE_* → 此默认。
//
// 【GEPA 可优化对象清单（NoeReflectiveTuner 的进化靶子，逐一对应注入位）】：
//   1) owner   显著度权重（与主人相关度）  ← salienceWeights.owner   / env NOE_WS_SALIENCE_OWNER   / 默认 0.35
//   2) urgency 显著度权重（紧迫度）        ← salienceWeights.urgency / env NOE_WS_SALIENCE_URGENCY / 默认 0.25
//   3) novelty 显著度权重（新异度）        ← salienceWeights.novelty / env NOE_WS_SALIENCE_NOVELTY / 默认 0.20
//   4) affect  显著度权重（情绪强度）      ← salienceWeights.affect  / env NOE_WS_SALIENCE_AFFECT  / 默认 0.20
//   5) 好奇/深思触发阈值 deepThreshold     ← opts.deepThreshold / env NOE_WORKSPACE_DEEP_THRESHOLD / 默认 0.70
//      （即「分数到多高才升级深思脑审议」；越低越爱深思=更好奇但更烧本地深思预算，越高越省=更克制）。
// ReflectiveTuner 当前 PoC 进化 1-4（四权重）；5（好奇阈值）已是同款注入式参数（deepThreshold 接 env），
//   后续把它纳入候选向量即可——本模块的零回归三层缺省链对 1-5 同口径，故扩展不破坏「不配置=逐字默认」。
const WEIGHTS = Object.freeze({ owner: 0.35, urgency: 0.25, novelty: 0.2, affect: 0.2 });
// env → number（仅在有限数时采纳，否则回落 fallback）；纯三层缺省的中间层。
// 【健壮性】未设(undefined)或空/纯空白串都视作「未配置」→ 回落 fallback；否则 Number('')===0 会把空 env 误当成
//   权重 0（静默清零某显著度维度，扭曲注意力，是个隐蔽 footgun）。合法数字（含显式 '0'）照常采纳，零回归。
function envNum(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}
// 解析四权重：opts 缺省读 env（NOE_WS_SALIENCE_OWNER/URGENCY/NOVELTY/AFFECT），env 也无则用 WEIGHTS 默认。
// 不配置时各字段逐字 === WEIGHTS（零行为变化）。返回冻结对象，防 score 期间被改。
function resolveSalienceWeights(opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const pick = (key, env) => {
    const v = Number(o[key]);
    return Number.isFinite(v) ? v : envNum(env, WEIGHTS[key]);
  };
  return Object.freeze({
    owner: pick('owner', 'NOE_WS_SALIENCE_OWNER'),
    urgency: pick('urgency', 'NOE_WS_SALIENCE_URGENCY'),
    novelty: pick('novelty', 'NOE_WS_SALIENCE_NOVELTY'),
    affect: pick('affect', 'NOE_WS_SALIENCE_AFFECT'),
  });
}
const DELIB_KV_KEY = 'noe.workspace.deliberations';
const SECRET_TEXT_RE = /((?:api[_-]?key|authorization|bearer|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const SENSITIVE_PAYLOAD_KEY_RE = /api[_-]?key|authorization|bearer|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token/i;
const QUIET_SYSTEM_REPAIR_RE = /^系统自修复：/;

function redactText(value) {
  return String(value || '')
    .replace(SECRET_TEXT_RE, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_KEY]');
}

function compactText(value, max) {
  return redactText(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function formatVisionSituation(situation) {
  if (!situation || typeof situation !== 'object') return '';
  const interrupt = situation.shouldInterrupt === true ? '建议轻触提醒' : '不建议打扰';
  return `；处境=${compactText(situation.activity || 'unknown', 40)}/${compactText(situation.attention || 'unknown', 40)}；可能需要=${compactText(situation.possibleNeed || 'unknown', 60)}；${interrupt}；置信度=${Number(situation.confidence || 0).toFixed(2)}`;
}

function sanitizeActPayload(value, depth = 0) {
  if (depth > 5) return null;
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return redactText(value).slice(0, 20_000);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => sanitizeActPayload(item, depth + 1)).filter((item) => item !== null && item !== undefined);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 80)) {
      const k = String(key || '').slice(0, 120);
      if (!k || SENSITIVE_PAYLOAD_KEY_RE.test(k)) continue;
      const next = sanitizeActPayload(item, depth + 1);
      if (next !== null && next !== undefined) out[k] = next;
    }
    return Object.keys(out).length ? out : null;
  }
  return null;
}

function parseActStepLine(line) {
  const text = String(line || '').trim();
  const m = text.match(/^\[act:([\w.\-]+)(?:\s+(\{.*\}))?\]\s*(.{2,})$/);
  if (!m) return text;
  let payload = null;
  if (m[2] && m[2].length <= 4000) {
    try { payload = sanitizeActPayload(JSON.parse(m[2])); } catch { payload = null; }
  }
  return {
    step: m[3].trim(),
    kind: 'act',
    action: m[1],
    ...(payload && typeof payload === 'object' ? { payload } : {}),
  };
}

function summarizeActOutput(result) {
  const out = result?.executorResult || result?.act?.payload?.executorResult || null;
  if (!out || typeof out !== 'object') return { noteText: '', exitCode: null, stdoutSummary: '', stderrSummary: '', pageSummary: '' };
  const exitCode = out.exitCode !== undefined ? out.exitCode : null;
  const stdoutSummary = compactText(out.stdout, 600);
  const stderrSummary = compactText(out.stderr, 400);
  // L3.5：browser act 读到的页面正文（read_body 的 extractedText）也进摘要，让深思真消费内容、
  //   写出含页面知识的笔记，而非只看 title 元数据写元笔记（治 owner 实证的「只开不读」空转）。
  const pageText = Array.isArray(out.actions)
    ? out.actions.filter((a) => a && a.contentRead && a.extractedText).map((a) => String(a.extractedText)).join('\n').trim()
    : '';
  const pageSummary = pageText ? compactText(pageText, 1200) : '';
  const parts = [];
  if (exitCode !== null) parts.push(`exit=${exitCode}`);
  if (stdoutSummary) parts.push(`stdout:${stdoutSummary.slice(0, 260)}`);
  if (stderrSummary) parts.push(`stderr:${stderrSummary.slice(0, 180)}`);
  if (pageSummary) parts.push(`页面正文:${pageSummary.slice(0, 700)}`);
  return { noteText: parts.join('；').slice(0, 1200), exitCode, stdoutSummary, stderrSummary, pageSummary };
}

function summarizeActionEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  const semanticTrace = sanitizeActPayload(evidence.semanticTrace || null);
  const summary = {
    schemaVersion: evidence.schemaVersion ?? null,
    actionId: compactText(evidence.actionId || '', 160),
    action: compactText(evidence.action || '', 160),
    riskLevel: compactText(evidence.riskLevel || '', 40),
    dryRunOnly: evidence.dryRunOnly !== false,
    evidenceEventId: evidence.evidenceEventId ?? null,
    logRef: compactText(evidence.logRef || '', 1000),
    sha256: compactText(evidence.sha256 || '', 80),
    refs: sanitizeActPayload(evidence.refs || {}) || {},
  };
  if (semanticTrace) summary.semanticTrace = semanticTrace;
  return summary;
}

export function createWorkspace({
  timeline = null,             // EpisodicTimeline：owner 近况 + 上一念
  commitmentStore = null,      // 到期承诺（只 peek 不 resolve——消费仍归 proactiveTick）
  expectationLedger = null,    // 到期待裁决期望
  stepExpectationBridge = null, // 阶段1：act/research step 真失败→登记预测→outcome=0→harvestSurprise（接通好奇回路供给端，NOE_STEP_EXPECTATION_RESOLVE）
  worldModelContradictionBridge = null, // 阶段1 P1：research 读到内容与认知矛盾→harvestSurprise(world_model_conflict)（信息层 epistemic 源，NOE_WORLDMODEL_CONFLICT）
  driveBrief = null,           // () => string|null
  peekVision = null,           // () => {summary}|null
  systemStateProvider = null,  // () => string|null：本机感知三件套缓存块（M3，NoeHostContext）
  affectProbe = null,          // () => {v,a}|null
  textSimilarity = null,       // (a,b)=>0..1（novelty 用）
  deliberate = null,           // NoeDeliberation 实例（注入才有 S2 升级）
  deliberateThink = null,      // P0-1（治审计"think 末步 100% 模板盖章·深思脑 0 调用"）：async (evidenceText, topic) => 改进方案文本|'SKIP'|null。
                               //   装配层用 reflectBrain + learningHook 范式实现；NOE_THINK_DELIBERATE=1 时 autoClose 末步调它产真深思，失败/SKIP 回退模板（fail-open）。
  surfacingGate = null,        // NoeSurfacingGate（审议想说的闸）
  sublimate = null,            // (text)=>Promise：既有升华通道（NOE_INNER_SPEAK 才有）
  goalSystem = null,           // NoeGoalSystem（P5，NOE_GOALS=1 才注入）：活跃目标下一步进候选，深思推进
  recordEpisode = null,        // (e)=>void：把"自己做成的事"记进自传时间线（研究完成/自己立项/目标完成）——
                               // 实机检验教训：不记的话他的行动不会成为他的经历，经历流贫血、接地无锚、反思无料
  runResearch = null,          // M6 的"手"：async (query)=>{report,sources}——research 步真上网（DeepResearcher）
  persistResearch = null,      // 研究沉淀（NOE_RESEARCH_PERSIST=1 才注入）：async ({report,sources,topic,goalRef,critique})=>{ok}
                               //   ——把 report 精炼摘要沉淀进可召回语义记忆，治"研究了却召不回"。未注入则不沉淀（零回归）。
  harvestEntities = null,      // 知识图谱实体抽取（NOE_KG_INGEST=1 才注入）：({report,sources,topic})=>{written}
  // P0.5 done outcome 门（NOE_LEARNING_OUTCOME_GATE，默认 OFF）：研究步空产出不刷假 done，标 blocked 待重试/换源。
  //   治"步骤跑完≠真学到"的公共根因（实证 self_learning 354 done 却 research_report=0）。注入式以便单测，默认读 env。
  learningOutcomeGate = process.env.NOE_LEARNING_OUTCOME_GATE === '1',
                               //   ——从 report 抽技术实体写知识图谱，让自主发现源①(反复遇到没深究→自动想学)有货。未注入则不抽（零回归）。
  runAct = null,               // 行动的"手"（意识工程 Phase3）：async ({text,goalRef,actionSpec})=>ActPipeline.propose 结果——
                               // act 步走真行动链（预算/权限/共识/审批全套门控自动生效）。未注入时 act 步不会出现
                               // （NoeGoalSystem 数据层 allowActKind 同门控，act 解析回落 think），零差异。
  incidentEscalator = null,    // NoeIncidentEscalator：内心/行动失败里的系统故障 → system_repair 目标
  activityLog = null,          // 可选 ActivityLog：act 结果写入审计流（脱敏摘要，不保存完整输出）
  onGoalDone = null,           // M7 技能蒸馏挂点：目标全完成时回调（成功经验→技能卡入记忆）
  onGoalReportback = null,     // owner 可见任务状态回报：接单后持续显示 running/done/failed/blocked
  insightProvider = null,      // M9：昨夜反思洞察（晨间候选源，server 在反思回调处缓存）
  kv = null,                   // {get,set}：审议日预算
  appendJournal = null,        // (dateStr, lineObj)=>void：意识日志写入（server 注入 fs 实现；测试注入收集器）
  loopGuardGate = null,        // S0.3 思维回环守卫门控 {enabled}（NOE_THOUGHT_LOOP_GUARD=1 才注入，默认 OFF）；未注入/关→整段跳过零回归
  gwtMetrics = null,           // P2-2 GWT 可观测指标记录器（NoeGwtMetrics）；未注入→不记录（optional-chain 零回归），注入→每次广播 record + 暴露 snapshot
  affectModulation = null,     // P2-4 VAD→行为调制器（NoeAffectModulation）；未注入→零回归，注入(NOE_AFFECT_MODULATION=1)→arousal 调制深思触发阈值（高唤醒缩短深思）
  now = Date.now,
  // S0.7（GEPA 可优化对象）：显著度四权重抽成注入式参数。缺省=null → 工厂内 resolveSalienceWeights 走
  //   env NOE_WS_SALIENCE_*(OWNER/URGENCY/NOVELTY/AFFECT) → 原硬编码默认(0.35/0.25/0.2/0.2)。不配置逐字零行为变化。
  //   传 {owner,urgency,novelty,affect} 任意子集可逐项覆盖（GEPA 参数进化注入位）。
  salienceWeights = null,
  // 0.7：到期承诺(~0.78)/新鲜主人互动(~0.72)能升深思，纯看屏(~0.5)/驱力(~0.4)不烧深思预算
  deepThreshold = Number.isFinite(Number(process.env.NOE_WORKSPACE_DEEP_THRESHOLD)) ? Number(process.env.NOE_WORKSPACE_DEEP_THRESHOLD) : 0.7,
  deliberationsPerDay = Number.isFinite(Number(process.env.NOE_WORKSPACE_DELIBERATIONS_PER_DAY))
    ? Math.max(1, Math.min(500, Number(process.env.NOE_WORKSPACE_DELIBERATIONS_PER_DAY)))
    : 12,
  ownerRecentMs = 30 * 60_000,
  affectNegativeEpisodes = process.env.NOE_AFFECT_NEGATIVE === '1',  // 阶段0：真实失败记成 setback 让 affect 能跌；env 默认 OFF（宪法：新功能默认 OFF）
  // S1（HANDOFF rank4 GWT 语义 novelty，NOE_GWT_SEMANTIC_NOVELTY=1 默认 OFF）：用 qwen3-embedding 语义相似度
  //   增强字符相似度算新异度。注入式：semanticEmbedder 从参数传（async (text)=>{vector}|Float32Array|null）。
  //   【codex 硬约束】同步 step/novelty 绝不 embed——只读预缓存 semCache；预热走 refreshSemanticCache()（heartbeat
  //   在 step 之后 fire-and-forget 调，micro-tick 预缓存近期 winner 向量）。ollama down/冷缓存/换维度全部退回字符
  //   相似度（fail-open，不锁死）。OFF（未注入 embedder）时 novelty 第一句即走与原函数逐字相同的字符分支。
  semanticEmbedder = null,        // async (text)=>{vector:Float32Array}|Float32Array|null（不传/null → 永远走字符相似度）
  semanticCacheMax = Number.isFinite(Number(process.env.NOE_GWT_SEMANTIC_CACHE_MAX)) ? Math.max(8, Math.min(500, Number(process.env.NOE_GWT_SEMANTIC_CACHE_MAX))) : 64,
} = {}) {
  // 解析显著度四权重（opts→env→默认三层缺省）。不配置时 weights 各字段 === WEIGHTS（零回归）。
  const weights = resolveSalienceWeights(salienceWeights);
  // 语义 novelty 总闸：仅当注入了 embedder 才可能走语义路（server.js 在 env OFF 时根本不注入 → 逐字零回归）。
  const semanticOn = typeof semanticEmbedder === 'function';
  // 语义向量缓存：键=与 recentWinners/候选同口径的 text.slice(0,200)，值=L2 归一向量（与 EmbeddingProvider 一致）。
  // 仅同步【读】于 novelty；仅异步【写】于 refreshSemanticCache。semDim 记当前维度，换 provider/维度时整表清空防跨维 cosine。
  const semCache = new Map();
  let semDim = 0;
  let lastCandidateTexts = [];     // 上一 tick 候选文本（200 截，供 refreshSemanticCache 预热下一轮打分）
  let focusText = null;        // 本周期广播内容（focusProvider 读）
  let focusSource = null;
  let lastLoopSignal = null;   // S0.3：最近一次回环检测结果（仅 ON 命中时填；可查，不改广播管线）
  const recentWinners = [];    // 进程内近期广播窗口（novelty 用；日志文件才是持久真相）

  const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

  function collectCandidates(t) {
    const out = [];
    try {
      const recent = timeline?.recent?.({ limit: 12 }) || [];
      const ownerEp = recent.find((e) => e.type === 'interaction' && t - e.ts <= ownerRecentMs);
      if (ownerEp) out.push({ source: 'owner_interaction', text: ownerEp.summary, ref: ownerEp.id });
      const lastThought = recent.find((e) => e.type === 'inner_monologue');
      if (lastThought) {
        out.push({ source: 'last_thought', text: lastThought.summary, ref: lastThought.id });
        try { incidentEscalator?.observe?.({ source: 'inner_monologue', text: lastThought.summary, ref: lastThought.id, ts: lastThought.ts }); } catch { /* 自修复升级失败不阻断注意力 */ }
      }
    } catch { /* 单源失败不阻断 */ }
    try {
      const due = commitmentStore?.due?.(t) || [];
      if (due.length) out.push({ source: 'commitment_due', text: `到点的牵挂：${(due[0].text || due[0].body || '一件事')}${due.length > 1 ? `（等 ${due.length} 件）` : ''}` });
    } catch { /* 同上 */ }
    try {
      const dueExp = expectationLedger?.due?.(t) || [];
      if (dueExp.length) out.push({ source: 'expectation_due', text: `到期待验证的预测：${dueExp[0].claim}` });
    } catch { /* 同上 */ }
    try {
      const v = typeof peekVision === 'function' ? peekVision() : null;
      if (v?.summary) out.push({ source: 'percept', text: `眼前看到：${v.summary}${formatVisionSituation(v.situation)}` });
    } catch { /* 同上 */ }
    try {
      const step = goalSystem?.nextStep?.();
      if (step) {
        const prior = Array.isArray(step.priorNotes) && step.priorNotes.length
          ? `；已知进展：${step.priorNotes.join('；').slice(0, 360)}`
          : '';
        out.push({ source: 'goal_step', text: `推进目标「${step.title}」：${step.step}${prior}`, kind: step.kind || 'think', goalPriority: step.priority, queryText: step.step, goalTitle: step.title, stepText: step.step, goalRef: { goalId: step.goalId, stepIndex: step.stepIndex }, ...(step.actionSpec ? { actionSpec: step.actionSpec } : {}) });
      }
    } catch { /* 同上 */ }
    try {
      const ins = typeof insightProvider === 'function' ? String(insightProvider() || '').trim() : '';
      if (ins) out.push({ source: 'fresh_insight', text: `昨夜反思冒出的洞察：${ins.slice(0, 160)}` });
    } catch { /* 同上 */ }
    try {
      const s = typeof systemStateProvider === 'function' ? String(systemStateProvider() || '').trim() : '';
      if (s) out.push({ source: 'system_state', text: `本机此刻：${s.replace(/\s+/g, ' ').slice(0, 160)}` });
    } catch { /* 同上 */ }
    try {
      const d = typeof driveBrief === 'function' ? String(driveBrief() || '').trim() : '';
      if (d) out.push({ source: 'drive', text: `内在驱力：${d}` });
    } catch { /* 同上 */ }
    return out;
  }

  // 同步余弦（输入已 L2 归一，取 min 维度点积，与 EmbeddingProvider.cosineSim 同口径，内联避免热路径多一次调用栈）。
  function semCosine(a, b) {
    const n = Math.min(a.length, b.length);
    let dot = 0;
    for (let i = 0; i < n; i++) dot += a[i] * b[i];
    return dot;
  }

  // novelty：默认/OFF/冷缓存/down 全走字符相似度（与升级前逐字一致）；仅当语义闸开 + 候选与至少一个近期 winner
  // 的向量【都已在 semCache】时才用语义相似度（同步只读，绝不 embed）。语义/字符都失败 → 1（最大新异，保守不抑制）。
  function novelty(text) {
    if (typeof textSimilarity !== 'function' || !recentWinners.length) return 1;
    if (semanticOn) {
      try {
        const tv = semCache.get(String(text).slice(0, 200));
        if (tv) {
          let best = -1;
          for (const w of recentWinners) {
            const wv = semCache.get(w);   // recentWinners 已是 slice(0,200) 口径
            if (wv) { const s = semCosine(tv, wv); if (s > best) best = s; }
          }
          if (best > -1) return 1 - best;   // 命中语义路（候选 + ≥1 winner 都有向量）
        }
        // 落此处 = 候选或全部 winner 向量未缓存（冷启动/ollama down 没入缓存）→ 落到字符 fallback
      } catch { /* 语义路任何异常都 fail-open 到字符相似度 */ }
    }
    try { return 1 - Math.max(...recentWinners.map((w) => textSimilarity(w, text))); } catch { return 1; }
  }

  // 预缓存近期 winner + 上一 tick 候选的语义向量（heartbeat 在 step() 之后 fire-and-forget 调；绝不在同步 step 内调）。
  // 这是 codex 约束的「micro tick 预缓存」：把同步打分需要的向量提前异步备好，下一 tick 的 novelty 才有语义路可走。
  // fail-open：embedder 炸/返回 hash-fallback/单条失败都跳过该条；维度变化整表清空重建（绝不跨维 cosine）。
  async function refreshSemanticCache() {
    if (!semanticOn) return;
    try {
      const wanted = [];
      const seen = new Set();
      for (const w of recentWinners) { if (w && !seen.has(w)) { seen.add(w); wanted.push(w); } }
      for (const c of lastCandidateTexts) { const k = String(c).slice(0, 200); if (k && !seen.has(k)) { seen.add(k); wanted.push(k); } }
      for (const key of wanted) {
        if (semCache.has(key)) continue;
        let vec = null;
        try {
          const r = await semanticEmbedder(key);
          // 解包：支持返回 Float32Array | number[] | {vector,provider?}。仅采纳真实语义向量；
          // EmbeddingProvider 在 ollama 失败时回 {provider:'hash-fallback'}，不让它污染语义缓存（宁可走字符）。
          const v = (r && r.vector !== undefined) ? r.vector : r;
          const isFallback = r && typeof r === 'object' && (r.fallback === true || (typeof r.provider === 'string' && r.provider.includes('hash')));
          if (!isFallback && v && (Array.isArray(v) || ArrayBuffer.isView(v)) && v.length) vec = v;
        } catch { vec = null; }   // 单条嵌入失败不阻断其余（fail-open）
        if (!vec) continue;
        // 维度切换（换 provider/模型）：旧向量与新向量不可同表 cosine → 清空整表，从这条起按新维度重建。
        if (semDim && vec.length !== semDim) { semCache.clear(); }
        semDim = vec.length;
        semCache.set(key, vec);
      }
      // LRU cap：超额从最老（Map 插入序最前）删，连同已不在 recentWinners 的陈旧键自然淘汰。
      while (semCache.size > semanticCacheMax) { const oldest = semCache.keys().next().value; if (oldest === undefined) break; semCache.delete(oldest); }
    } catch { /* 预缓存整体失败不阻断认知；下个 tick novelty 自动退字符相似度 */ }
  }

  function score(c, arousal) {
    const base = SOURCE_BASE[c.source] || { owner: 0.2, urgency: 0.2, affect: 0.2 };
    const n = novelty(c.text);
    let s = weights.owner * base.owner + weights.urgency * base.urgency + weights.novelty * n + weights.affect * base.affect * (0.5 + arousal / 2);
    if (c.source === 'goal_step') {
      const p = clamp01(Number(c.goalPriority) || 0);
      s += 0.18 * p;
      const repeatedRecently = n < 0.15;
      if (!repeatedRecently) {
        s = Math.max(s, 0.62);
        if (c.kind === 'act' || c.kind === 'research') s = Math.max(s + 0.08, 0.68);
      } else if (c.kind === 'act' || c.kind === 'research') {
        s = Math.max(s + 0.08, 0.5);
      }
    }
    return Math.round(s * 1000) / 1000;
  }

  function deliberationBudgetOk(t) {
    try {
      const st = kv?.get?.(DELIB_KV_KEY);
      const today = dayOf(t);
      const cur = st && st.day === today ? Number(st.count) || 0 : 0;
      if (cur >= deliberationsPerDay) return false;
      kv?.set?.(DELIB_KV_KEY, { day: today, count: cur + 1 });
      return true;
    } catch { return false; } // 预算系统炸了 → 宁可不深思（省算力侧安全）
  }

  // 退还一个已预留的深思名额：deliberationBudgetOk 在检查时就 +1 占位（防多个 step 并发各自夺冠后
  // 同时夺名额超支）；当这次深思最终确认失败（no_brain/brain_error/empty/incomplete/no_topic），把占位
  // 退回，避免失败也消耗当日预算（一旦本地深思脑挂掉，原本会在没产出任何一句深思的情况下烧光全天名额）。
  // 跨午夜保护：只在 KV 仍是同一天时回退（深思在途越过午夜则当日计数器已重置，绝不污染新一天）。
  function refundDeliberationBudget(t) {
    try {
      const st = kv?.get?.(DELIB_KV_KEY);
      if (!st || st.day !== dayOf(t)) return;
      const next = Math.max(0, (Number(st.count) || 0) - 1);
      kv?.set?.(DELIB_KV_KEY, { day: st.day, count: next });
    } catch { /* 退款失败不阻断（最坏情况=这次失败仍占名额，与修复前同档） */ }
  }

  function recordActActivity({ winner, status, actResult = null, output = null, error = null }) {
    try {
      if (!activityLog?.recordSafe || !winner?.goalRef) return;
      const result = actResult || {};
      const act = result.act || {};
      const summary = output || summarizeActOutput(result);
      activityLog.recordSafe({
        action: 'noe.goal_step.act',
        actorType: 'noe',
        actorId: 'workspace',
        entityType: 'noe_goal',
        entityId: winner.goalRef.goalId,
        severity: status === 'failed' || status === 'blocked' ? 'warn' : 'info',
        status,
        details: {
          goalId: winner.goalRef.goalId,
          stepIndex: winner.goalRef.stepIndex,
          stepText: compactText(winner.queryText || winner.text, 220),
          actAction: act.action || winner.actionSpec?.action || null,
          exitCode: summary.exitCode,
          stdoutSummary: summary.stdoutSummary,
          stderrSummary: summary.stderrSummary,
          approvalId: act.approvalId || null,
          dryRunOnly: act.payload?.dryRunOnly === true,
          error: error ? compactText(error, 220) : null,
        },
      });
    } catch { /* Activity 失败不阻断目标推进 */ }
  }

  function emitGoalReportback(winner, status, { note = '', kind = null, goalDone = false, speak = null } = {}) {
    try {
      if (typeof onGoalReportback !== 'function' || !winner?.goalRef?.goalId) return null;
      const title = winner.text?.match(/^推进目标「(.+?)」/)?.[1] || winner.title || 'Noe 任务';
      const wantsSpeech = speak === null ? Boolean(goalDone || ['done', 'failed', 'blocked', 'awaiting_approval'].includes(status)) : speak;
      return onGoalReportback({
        goalId: winner.goalRef.goalId,
        taskId: winner.goalRef.goalId,
        title,
        summary: compactText(note || winner.queryText || winner.text || '', 500),
        status,
        kind: kind || winner.kind || null,
        stepIndex: winner.goalRef.stepIndex,
        source: 'workspace',
        speak: QUIET_SYSTEM_REPAIR_RE.test(title) ? false : wantsSpeech,
      });
    } catch { return null; }
  }

  // P0-1：模板收口 note（OFF 路径 + 深思失败回退用）。逐字保留原"自动收口"措辞，零回归。
  function buildAutoCloseNote(others) {
    const completed = others.filter((s) => s.status === 'done').length;
    const recovered = others.filter((s) => s.status === 'recovered').length;
    const evidence = others
      .filter((s) => ['done', 'recovered'].includes(String(s.status || 'open')) && String(s.note || '').trim())
      .slice(-2)
      .map((s) => `${String(s.step || '').slice(0, 40)}：${String(s.note || '').slice(0, 180)}`)
      .join('；');
    return `自动收口：前序已有 ${completed} 个完成证据、${recovered} 个恢复证据；最后复盘步确认目标链已落地。${evidence ? ` 最近证据：${evidence}` : ''}`.slice(0, 500);
  }

  // P0-1：think 末步真正落账（OFF 模板 + ON 深思 共用），deliberated 透传供审计统计"非模板占比"。
  function finalizeThinkClose(winner, stepIndex, t, tickId, note, deliberated) {
    const res = goalSystem.recordStepResult(winner.goalRef.goalId, stepIndex, { note, done: true });
    journal(t, { tickId, kind: 'goal_progress', goalId: winner.goalRef.goalId, stepIndex, autoClosed: true, deliberated: deliberated === true });
    emitGoalReportback(winner, 'done', { note, kind: 'think', goalDone: res?.goalDone === true, speak: true });
    if (res?.goalDone && typeof onGoalDone === 'function') { try { onGoalDone(res.goal); } catch { /* 蒸馏失败不阻断 */ } }
    return res;
  }

  const deliberatingThinkSteps = new Set(); // P0-1 防重入：异步深思中的 think 末步 key（return true 阻止 wantsDeep 重复升级）

  // P0-1：ON 路径——以前序 research+act 证据调深思脑产真改进方案，失败/SKIP 回退模板。async fire-and-forget。
  async function closeThinkWithDeliberation(winner, stepIndex, t, tickId, others, key) {
    let note = null;
    let deliberated = false;
    try {
      const topic = String(goalSystem?.get?.(winner.goalRef.goalId)?.title || winner.text || '')
        .replace(/^搞明白为什么没料到[:：]/, '').slice(0, 150).trim();
      const evidenceText = others
        .filter((s) => ['done', 'recovered'].includes(String(s.status || 'open')) && String(s.note || '').trim())
        .map((s) => `${String(s.step || '').slice(0, 50)}：${String(s.note || '').slice(0, 280)}`)
        .join('\n').slice(0, 1500);
      const improvement = await deliberateThink(evidenceText, topic);
      const clean = String(improvement || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim();
      if (clean.length >= 15 && !/^SKIP\b/i.test(clean) && !/^["「]?SKIP["」]?$/i.test(clean)) { note = clean.slice(0, 500); deliberated = true; }
    } catch { /* fall through to template */ }
    if (!note) note = buildAutoCloseNote(others); // 深思失败/SKIP → 回退模板（fail-open，think 末步绝不卡死）
    try { finalizeThinkClose(winner, stepIndex, t, tickId, note, deliberated); } finally { deliberatingThinkSteps.delete(key); }
  }

  function autoCloseTerminalThinkStep(winner, t, tickId) {
    try {
      if (!winner || winner.source !== 'goal_step' || winner.kind !== 'think' || winner.actionSpec || !winner.goalRef) return false;
      const stepIndex = Number(winner.goalRef.stepIndex);
      if (!Number.isInteger(stepIndex) || stepIndex < 0) return false;
      const goal = goalSystem?.get?.(winner.goalRef.goalId);
      const plan = Array.isArray(goal?.plan) ? goal.plan : [];
      const current = plan[stepIndex] || null;
      if (!current || current.kind !== 'think' || current.status !== 'open') return false;
      const others = plan.filter((_, idx) => idx !== stepIndex);
      if (!others.length) return false;
      const terminal = plan.every((s, idx) => idx === stepIndex || ['done', 'recovered'].includes(String(s.status || 'open')));
      const hasEvidence = others.some((s) => ['done', 'recovered'].includes(String(s.status || 'open')) && String(s.note || '').trim());
      if (!terminal || !hasEvidence || typeof goalSystem?.recordStepResult !== 'function') return false;
      // P0-1（治审计"think 末步 100% 被模板盖章·深思脑 0 次真调用"）：ON 时先以前序 research+act 证据调深思脑产真改进方案
      //   （learningHook 范式：我原以为什么·实际是什么·下次怎么调整，含具体对象/数字），失败/SKIP 才回退模板。
      //   异步 fire-and-forget + 防重入 Set；OFF/无注入时走原模板盖章（逐字零回归）。
      if (process.env.NOE_THINK_DELIBERATE === '1' && typeof deliberateThink === 'function') {
        const key = `${winner.goalRef.goalId}:${stepIndex}`;
        if (deliberatingThinkSteps.has(key)) return true; // 已在深思中，防重入
        deliberatingThinkSteps.add(key);
        void closeThinkWithDeliberation(winner, stepIndex, t, tickId, others, key);
        return true;
      }
      const note = buildAutoCloseNote(others);
      finalizeThinkClose(winner, stepIndex, t, tickId, note, false);
      return true;
    } catch { return false; }
  }

  /**
   * 认知周期的 ATTEND 步：收集→打分→广播→（可能）升级深思→日志。同步快路径；审议异步不阻塞。
   * @returns {{winner: object|null, candidates: Array, escalated: boolean}}
   */
  function step({ tickId = 0 } = {}) {
    const t = now();
    try { goalSystem?.arbitrate?.(t); } catch { /* 仲裁失败不阻断 */ }
    let arousal = 0.35;
    let affectSnap = null;
    if (typeof affectProbe === 'function') {
      try { affectSnap = affectProbe(); arousal = Number(affectSnap?.a) || 0.35; } catch { /* 中性 */ }
    }
    const candidates = collectCandidates(t).map((c) => ({ ...c, score: score(c, arousal) }));
    // 记下本 tick 候选文本（200 截），供 refreshSemanticCache 在 step 之后异步预热——下一 tick 的语义 novelty 才有料。
    // 纯写一个进程内数组，不触发任何 embed（同步 step 仍零网络）。语义闸关时也只是存个数组，无副作用。
    if (semanticOn) { try { lastCandidateTexts = candidates.map((c) => String(c.text || '').slice(0, 200)); } catch { /* 收集候选文本失败不阻断打分 */ } }
    candidates.sort((a, b) => b.score - a.score);
    const winner = candidates[0] || null;

    focusText = winner ? winner.text : null;
    focusSource = winner ? winner.source : null;
    if (winner) { recentWinners.unshift(winner.text.slice(0, 200)); recentWinners.length = Math.min(recentWinners.length, 10); }

    // S0.3 思维回环守卫：广播赢家前对刚更新的近期广播窗口做主题固着检测。门控关/未注入→整段不进逐字零变化；ON 命中只写 thought_loop 证据日志+存信号，绝不改 winner/focusText/currentFocus。
    if (loopGuardGate && loopGuardGate.enabled && winner) {
      try {
        const loop = analyzeThoughtLoop({ recentThoughts: recentWinners.map((text) => ({ text: stripBroadcastLabel(text) })), now: t, gate: loopGuardGate });
        if (loop.enabled && loop.looped) {
          lastLoopSignal = { ts: t, sharedKeywords: loop.sharedKeywords, suggestion: loop.suggestion, consideredCount: loop.consideredCount, winnerSource: winner.source };
          journal(t, { tickId, kind: 'thought_loop', source: winner.source, sharedKeywords: loop.sharedKeywords.slice(0, 4), consideredCount: loop.consideredCount, suggestion: (loop.suggestion || '').slice(0, 160) });
        }
      } catch { /* 回环守卫失败绝不阻断广播（fail-open） */ }
    }

    // M6 研究步分流：kind=research 的目标步不走深思——真上网（异步后台，标 doing 防重复夺冠）
    let researching = false;
    if (winner && winner.source === 'goal_step' && winner.goalRef && winner.kind === 'research' && typeof runResearch === 'function' && goalSystem?.recordStepResult) {
      researching = true;
      try { goalSystem.recordStepCheckpoint?.(winner.goalRef.goalId, winner.goalRef.stepIndex, { phase: 'intent', status: 'queued', kind: 'research', note: '准备执行研究步骤', payload: { query: winner.queryText || winner.text }, replaySafe: true }); } catch { /* checkpoint 失败不阻断 */ }
      try { goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, { doing: true, note: '研究执行中…' }); } catch { /* 标记失败不阻断 */ }
      journal(t, { tickId, kind: 'research_started', goalId: winner.goalRef.goalId, query: (winner.queryText || winner.text).slice(0, 120) });
      emitGoalReportback(winner, 'running', { note: '研究执行中…', kind: 'research', speak: false });
      runResearch(winner.queryText || winner.text)
        .then((rr) => {
          const summary = rr?.report ? String(rr.report).replace(/\s+/g, ' ').slice(0, 400) : '';
          try { goalSystem.recordStepCheckpoint?.(winner.goalRef.goalId, winner.goalRef.stepIndex, { phase: 'evidence', status: rr?.report ? 'done' : 'blocked', kind: 'research', note: summary || '研究完成（未产出报告）', payload: { sourceCount: rr?.sources?.length || 0 }, replaySafe: true }); } catch { /* checkpoint 失败不阻断 */ }
          // P0.5 done outcome 门：空产出研究(rr.report 为空)不刷假 done——门 ON 标 blocked(与上面 checkpoint 口径一致)待重试/换源；
          //   门 OFF(默认)逐字回归 done:true，零回归。
          const res = (learningOutcomeGate && !rr?.report)
            ? goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, { status: 'blocked', note: '研究未产出报告（outcome 门：不计完成，待重试或换源）' })
            : goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, { done: true, note: summary || '研究完成（未产出报告）' });
          journal(now(), { tickId, kind: 'research_done', goalId: winner.goalRef.goalId, ok: Boolean(rr?.report), sources: rr?.sources?.length || 0 });
          // 阶段1 P1：研究读到的内容与已有认知比对，矛盾→harvestSurprise(world_model_conflict)（信息层 epistemic 源，async fire-and-forget 不阻断主流程）
          if (rr?.report) { Promise.resolve(worldModelContradictionBridge?.onContentObserved?.({ content: rr.report, topic: winner.queryText || winner.text, source: 'research' })).catch(() => {}); }
          // 研究沉淀（NOE_RESEARCH_PERSIST）：把 report 精炼摘要写进可召回语义记忆，治"学了召不回"。fail-open，绝不阻断研究闭环。
          if (rr?.report && typeof persistResearch === 'function') { Promise.resolve(persistResearch({ report: rr.report, sources: rr.sources || [], topic: winner.queryText || winner.text, goalRef: winner.goalRef, critique: rr.critique || null })).catch(() => {}); }
          // 知识图谱实体抽取（NOE_KG_INGEST）：从 report 抽技术实体写知识图谱，让自主发现源①(反复遇到没深究→自动想学)有货。fail-open。
          if (rr?.report && typeof harvestEntities === 'function') { Promise.resolve(harvestEntities({ report: rr.report, sources: rr.sources || [], topic: winner.queryText || winner.text })).catch(() => {}); }
          emitGoalReportback(winner, res?.goalDone ? 'done' : 'running', { note: summary || '研究完成（未产出报告），继续下一步。', kind: 'research', goalDone: res?.goalDone === true, speak: res?.goalDone === true });
          // 自己做的事成为自己的经历（盐度 4：高于念头、参与盐度反思与接地锚定）
          // P4 step0：研究成功（产出报告）记 milestone（带 agency:0.85）→ 真推 dominance；空手而归仍记 observation（中性，不冒充成就）。
          // episode 文案不预断言"记进记忆"——persistResearch 是 fire-and-forget，报告太短/写失败时无法同步确认，
          //   预断言会造假（Codex 审发现5）。沉淀的价值由"下次同主题能否召回到"体现，不靠此处文案自夸。
          try { recordEpisode?.({ type: rr?.report ? 'milestone' : 'observation', summary: `我上网研究了「${(winner.queryText || winner.text).slice(0, 50)}」，查了 ${rr?.sources?.length || 0} 个来源`, salience: 4 }); } catch { /* 留痕失败不阻断 */ }
          if (res?.goalDone && typeof onGoalDone === 'function') { try { onGoalDone(res.goal); } catch { /* 蒸馏失败不阻断 */ } }
        })
        .catch((e) => {
          try {
            const note = `研究失败：${String(e?.message || e)}`.slice(0, 200);
            goalSystem.recordStepCheckpoint?.(winner.goalRef.goalId, winner.goalRef.stepIndex, { phase: 'evidence', status: 'failed', kind: 'research', note, replaySafe: true });
            goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, { status: 'failed', note });
            emitGoalReportback(winner, 'failed', { note, kind: 'research', speak: true });
            try { incidentEscalator?.observe?.({ source: 'failed_action', status: 'failed', text: `${winner.text}：${note}`, goalId: winner.goalRef.goalId, stepIndex: winner.goalRef.stepIndex }); } catch { /* 自修复升级失败不阻断原失败记录 */ }
            // 阶段1：research 真失败 → 接通好奇回路供给端
            try { stepExpectationBridge?.onStepFailed?.({ stepText: winner.stepText || winner.queryText || winner.text, kind: 'research', terminal: 'failed', failureReason: String(e?.message || e).slice(0, 60) }); } catch { /* 桥失败不阻断主流程 */ }
          } catch { /* 同上 */ }
          journal(now(), { tickId, kind: 'research_done', goalId: winner.goalRef.goalId, ok: false });
          if (affectNegativeEpisodes) { try { recordEpisode?.({ type: 'setback', summary: `我上网研究却失败了：「${(winner.queryText || winner.text).slice(0, 50)}」`, salience: 4 }); } catch { /* 留痕失败不阻断 */ } }
        });
    }
    // 行动步分流（意识工程 Phase3，2026-06-11）：kind=act 的目标步不走深思——交 ActPipeline 真行动链。
    // owner full developer trust 下真实执行优先；普通动作无 executor 时落 dry-run 证据，Activity/Checkpoint 负责留痕。
    // 这是"目标长出手"：act 步与系统里其他 act 同等审计。等外部条件时步骤挂 doing（nextStep 不再选中）。
    let acting = false;
    if (winner && winner.source === 'goal_step' && winner.goalRef && winner.kind === 'act' && typeof runAct === 'function' && goalSystem?.recordStepResult) {
      acting = true;
      try { goalSystem.recordStepCheckpoint?.(winner.goalRef.goalId, winner.goalRef.stepIndex, { phase: 'intent', status: 'queued', kind: 'act', action: winner.actionSpec?.action || '', note: '准备执行行动步骤', payload: { actionSpec: winner.actionSpec || null }, replaySafe: false }); } catch { /* checkpoint 失败不阻断 */ }
      try { goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, { doing: true, note: '行动执行中…' }); } catch { /* 标记失败不阻断 */ }
      journal(t, { tickId, kind: 'act_started', goalId: winner.goalRef.goalId, step: (winner.queryText || winner.text).slice(0, 120) });
      emitGoalReportback(winner, 'running', { note: '行动执行中…', kind: 'act', speak: false });
      runAct({ text: winner.queryText || winner.text, goal: winner.goalTitle || '', goalTitle: winner.goalTitle || '', checkpoint: winner.stepText || winner.queryText || '', step: winner.stepText || winner.queryText || '', goalRef: winner.goalRef, actionSpec: winner.actionSpec || null })
        .then((ar) => {
          const approval = ar?.approvalRequired === true;
          const acted = ar?.ok === true && !approval;
          const output = summarizeActOutput(ar);
          const note = approval
            ? `行动等 owner 审批（${ar?.act?.approvalId || '审批单已建'}）`
            : acted
              ? `行动完成：${String(ar?.act?.status || 'completed')}${ar?.act?.payload?.dryRunOnly ? '（dry-run 证据）' : ''}${output.noteText ? `；${output.noteText}` : ''}`
              : `行动未放行：${String(ar?.error || ar?.act?.status || 'unknown')}`.slice(0, 200);
          try { goalSystem.recordStepCheckpoint?.(winner.goalRef.goalId, winner.goalRef.stepIndex, { phase: 'evidence', status: approval ? 'awaiting_approval' : acted ? 'done' : 'blocked', kind: 'act', action: ar?.act?.action || winner.actionSpec?.action || '', note, evidenceRef: ar?.act?.logRef || '', payload: { actId: ar?.act?.id || null, approvalId: ar?.act?.approvalId || null, dryRunOnly: ar?.act?.payload?.dryRunOnly === true, ok: ar?.ok === true, readonly: ar?.act?.payload?.readonly === true || ar?.act?.payload?.actionEvidence?.runtime?.readonly === true, actionEvidenceSummary: summarizeActionEvidence(ar?.act?.payload?.actionEvidence) }, replaySafe: false }); } catch { /* checkpoint 失败不阻断 */ }
          // 等审批：保持 doing 挂住（不再夺冠重试）；完成：done；被档：回 open 留 note
          const res = goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, approval ? { status: 'awaiting_approval', note } : acted ? { done: true, note } : { status: 'blocked', note });
          journal(now(), { tickId, kind: 'act_done', goalId: winner.goalRef.goalId, ok: acted, approval, status: ar?.act?.status || null });
          // 阶段1 P1：browse 读到的页面正文也进 worldModel 矛盾检测（治 codex 漏洞2-C/M3 严重-C：原只接 research，browse 是主要内容源）
          if (acted && output.pageSummary && output.pageSummary.length >= 40) { Promise.resolve(worldModelContradictionBridge?.onContentObserved?.({ content: output.pageSummary, topic: winner.queryText || winner.text, source: 'browse' })).catch(() => {}); }
          emitGoalReportback(winner, approval ? 'awaiting_approval' : acted ? (res?.goalDone ? 'done' : 'running') : 'blocked', { note, kind: 'act', goalDone: res?.goalDone === true, speak: approval || !acted || res?.goalDone === true });
          if (!acted && !approval) {
            try { incidentEscalator?.observe?.({ source: 'failed_action', status: 'blocked', text: `${winner.text}：${note}`, goalId: winner.goalRef.goalId, stepIndex: winner.goalRef.stepIndex }); } catch { /* 自修复升级失败不阻断原失败记录 */ }
            // 阶段1：act 真失败 → 接通好奇回路供给端（登记预测→outcome=0→surprise→harvestSurprise(action_failure)）
            // codex 复盘漏洞1：executor 真失败 ActPipeline 返回 {ok:false,act.status:'failed'}，也走这条 !acted 路——
            //   必须按 act.status 区分「executor 真失败(failed)」vs「系统门拦(blocked)」，否则真 act 失败被 bridge 当 system_gate 吞掉。
            const actTerminal = (ar?.act?.status === 'failed') ? 'failed' : 'blocked';
            try { stepExpectationBridge?.onStepFailed?.({ stepText: winner.stepText || winner.queryText || winner.text, kind: 'act', terminal: actTerminal, failureReason: ar?.error || ar?.act?.failureReason || ar?.act?.status }); } catch { /* 桥失败不阻断主流程 */ }
          }
          recordActActivity({ winner, status: approval ? 'awaiting_approval' : acted ? 'done' : 'blocked', actResult: ar, output, error: ar?.error || ar?.act?.status || null });
          // P4 reward-hack 整改（多模型审 finding A）：dry-run 只是"生成了可复现证据"，不是"我真把事做成了"。
          //   ActPipeline 默认 dry_run 路径返回 { ok:true, act.payload.dryRunOnly:true }→acted=true，原直接记 milestone(agency:0.85)
          //   = 把空跑当成就，虚假推高 dominance。故 milestone 只认"真完成"（acted 且非 dry-run）；dry-run 记 observation（中性，不带 agency）。
          const dryRunOnly = ar?.act?.payload?.dryRunOnly === true;
          const realDone = acted && !dryRunOnly;
          // P4 step0：行动真完成记 milestone（带 agency:0.85）→ 推 dominance（我把事做成了的掌控感）；
          //   失败仍受 affectNegativeEpisodes 门控记 setback（agency:0.15 低掌控，owner 拍板才让失败拉低情绪）；
          //   dry-run / 等审批 / 被门拦但非真失败 → observation（中性）。
          try { recordEpisode?.({ type: realDone ? 'milestone' : (affectNegativeEpisodes && !approval && !acted) ? 'setback' : 'observation', summary: `我为目标动了手：「${(winner.queryText || winner.text).slice(0, 50)}」→ ${realDone ? '完成' : acted ? '只跑了 dry-run 证据' : approval ? '等主人审批' : '被安全门拦下'}`, salience: 4 }); } catch { /* 留痕失败不阻断 */ }
          if (res?.goalDone && typeof onGoalDone === 'function') { try { onGoalDone(res.goal); } catch { /* 蒸馏失败不阻断 */ } }
        })
        .catch((e) => {
          const err = String(e?.message || e);
          try {
            const note = `行动失败：${compactText(err, 200)}`;
            goalSystem.recordStepCheckpoint?.(winner.goalRef.goalId, winner.goalRef.stepIndex, { phase: 'evidence', status: 'failed', kind: 'act', action: winner.actionSpec?.action || '', note, replaySafe: false });
            goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, { status: 'failed', note });
            emitGoalReportback(winner, 'failed', { note, kind: 'act', speak: true });
            try { incidentEscalator?.observe?.({ source: 'failed_action', status: 'failed', text: `${winner.text}：${note}`, goalId: winner.goalRef.goalId, stepIndex: winner.goalRef.stepIndex }); } catch { /* 自修复升级失败不阻断原失败记录 */ }
            // 阶段1：act 抛错失败 → 接通好奇回路供给端
            try { stepExpectationBridge?.onStepFailed?.({ stepText: winner.stepText || winner.queryText || winner.text, kind: 'act', terminal: 'failed', failureReason: err }); } catch { /* 桥失败不阻断主流程 */ }
          } catch { /* 同上 */ }
          journal(now(), { tickId, kind: 'act_done', goalId: winner.goalRef.goalId, ok: false, approval: false });
          recordActActivity({ winner, status: 'failed', error: err });
          if (affectNegativeEpisodes) { try { recordEpisode?.({ type: 'setback', summary: `我为目标动手却失败了：「${(winner.queryText || winner.text).slice(0, 50)}」`, salience: 4 }); } catch { /* 留痕失败不阻断 */ } }
        });
    }
    const deterministicClosure = autoCloseTerminalThinkStep(winner, t, tickId);
    let escalated = false;
    // P2-4：情感调制深思触发阈值——高 arousal（deliberationScale<1）抬高有效阈值=缩短深思（应激快反应），
    //   低 arousal（scale>1）降低阈值=更从容深思。flag 关/未注入/无 affect → effDeepThreshold===deepThreshold 零回归。
    let effDeepThreshold = deepThreshold;
    if (affectModulation && affectSnap) {
      try {
        const mod = affectModulation.modulate({ v: affectSnap.v, a: affectSnap.a, d: affectSnap.d });
        if (mod && mod.enabled && mod.deliberationScale > 0) effDeepThreshold = Math.max(0.3, Math.min(0.95, deepThreshold / mod.deliberationScale));
      } catch { /* fail-open：调制失败用原阈值 */ }
    }
    const wantsDeep = winner && !researching && !acting && !deterministicClosure && (winner.score >= effDeepThreshold || winner.source === 'goal_step'); // think 类目标步必走深思（这就是推进机制）
    if (wantsDeep && typeof deliberate === 'function' && winner.source !== 'last_thought' && deliberationBudgetOk(t)) {
      escalated = true;
      // 深思异步跑（不阻塞认知周期）；产出自己留痕；"想说"过浮现门走既有升华通道。
      // 目标步明确教学完成判定（实机教训：不教的话深思永远不说"步骤完成"，目标永不收口）
      deliberate({
        topic: winner.text,
        // 无计划目标长计划时教 act 步格式（runAct 可用才教——教了用不上只会困惑）：
        // 这是"Noe 自主用手"的入口——深思自己决定哪一步需要真实动手，落成 act 步走 ActPipeline 门控。
        ...(winner.goalRef ? { context: `这是你自己目标的一步。如果经过这轮思考这一步已经想透/可以收口，必须在末尾单独一行写：步骤完成。还没想透就不写。${winner.goalRef.stepIndex === -1 && typeof runAct === 'function' ? '列计划时，如果某一步需要真实动手做，把那一行写成「- [act:noe.note.write] 要做的事」（act: 后是动作名）。可用动作名：noe.note.write=写本地自治笔记；shell.exec=本地诊断/修复/验证命令(argv payload 由系统补齐时用)；browser.open_url=打开 http/https 学习资料页；browser.state_probe/browser.observe=读取浏览器 URL/title 元数据；browser.observe_page=用 DOM 观察当前页；browser.click=按 selector/hints 点击；browser.type=按 selector/hints 输入；macos.app.activate=把指定 macOS App 拉到前台；macos.text.type=向当前前台输入焦点粘贴一段文本；macos.key.press=向前台焦点发送受控按键；macos.pointer.click=按屏幕坐标左键点击；macos.applescript.run/macos.script.run=运行 AppleScript 控制 macOS/App；macos.jxa.run=运行 JXA(JavaScript for Automation) 控制 macOS/App；visual.action.plan=生成浏览器/GUI 操作预演计划。需要参数时写成「- [act:browser.type {"role":"search","hints":["Search"],"text":"Noe autonomy"}] 输入搜索词」、「- [act:browser.click {"hints":["Search"]}] 点击搜索按钮」、「- [act:macos.app.activate {"app":"Google Chrome"}] 切到浏览器」、「- [act:macos.text.type {"app":"Google Chrome","text":"Noe autonomy","ackClipboardOverwrite":true}] 用全局键盘输入文本」、「- [act:macos.key.press {"app":"TextEdit","key":"left"}] 按左方向键」、「- [act:macos.key.press {"key":"return","ackSubmitKey":true}] 明确确认后按回车」、「- [act:macos.pointer.click {"app":"Google Chrome","x":120,"y":240,"ackCoordinateClick":true}] 明确确认后点坐标」、「- [act:macos.applescript.run {"script":"tell application \\"System Events\\" to get name of first process whose frontmost is true"}] 读取前台 App」或「- [act:macos.jxa.run {"script":"JSON.stringify({ok:true})"}] 运行 JXA 自动化脚本」。需要凭据时可以读取和使用本机凭据；普通 act payload 不要无意义塞 token/key/cookie/password，除非该动作本身必须传递凭据。全局键盘会覆盖剪贴板且不要写换行；回车/空格等提交键需要 ackSubmitKey；坐标点击需要 ackCoordinateClick。纯思考或研究的步骤不用标。' : ''}` } : {}),
      })
        .then((d) => {
          // 深思失败（脑不在/报错/空产出/被截断）→ 退还预留名额，失败不消耗当日预算。
          if (d?.deliberated !== true) refundDeliberationBudget(t);
          journal(t, { tickId, kind: 'deliberation_done', topic: winner.text.slice(0, 120), deliberated: d?.deliberated === true, prediction: d?.prediction || null, share: d?.share || null });
          // 目标步推进回写（P5）：审议笔记落进步骤；输出含「步骤完成」标完成；
          // 无计划目标（stepIndex=-1）从审议输出的列表行长出计划。
          if (winner.goalRef && d?.deliberated && goalSystem?.recordStepResult) {
            const listLines = (d.text || '').match(/(?:^|\n)\s*[-•①②③④⑤\d][.、)）]?\s*(.{4,480})/g);
            // [act:动作名] 标记 → act 步对象（深思自主声明"这一步要真动手"；GoalSystem 端 allowActKind 总闸再把一道门）
            const newSteps = listLines ? listLines.map((s) => {
              const text = s.replace(/^[\s\n]*[-•①②③④⑤\d][.、)）]?\s*/, '').trim();
              return parseActStepLine(text);
            }).slice(0, 8) : null;
            const stepDone = /步骤完成|这一步完成|已完成这一步/.test(d.text || '');
            const res = goalSystem.recordStepResult(winner.goalRef.goalId, winner.goalRef.stepIndex, {
              note: (d.text || '').slice(0, 300),
              done: stepDone,
              ...(winner.goalRef.stepIndex === -1 && newSteps ? { newSteps } : {}),
            });
            journal(t, { tickId, kind: 'goal_progress', goalId: winner.goalRef.goalId, stepIndex: winner.goalRef.stepIndex });
            if (stepDone || newSteps) emitGoalReportback(winner, res?.goalDone ? 'done' : 'running', { note: stepDone ? '思考步骤已完成，继续推进后续步骤。' : '已经拆出执行计划，继续推进。', kind: 'think', goalDone: res?.goalDone === true, speak: res?.goalDone === true });
            if (res?.goalDone && typeof onGoalDone === 'function') { try { onGoalDone(res.goal); } catch { /* 蒸馏失败不阻断 */ } }
          }
          // M8 自动课程：深思自己立项（「目标：…」行）——想要的事落成持续行动
          if (d?.goal && goalSystem?.add) {
            const gid = goalSystem.add({ title: d.goal, source: 'reflection', why: `深思「${winner.text.slice(0, 60)}」时自己立的项` });
            if (gid) {
              journal(t, { tickId, kind: 'goal_created', goalId: gid, title: d.goal.slice(0, 80) });
              try { recordEpisode?.({ type: 'observation', summary: `我给自己立了个目标：${d.goal.slice(0, 60)}`, salience: 4 }); } catch { /* 同上 */ }
            }
          }
          if (d?.share && typeof sublimate === 'function') {
            const gate = surfacingGate ? surfacingGate.tryPass({ text: d.share, salience: 0.8 }) : { pass: true, reason: 'no_gate' };
            journal(t, { tickId, kind: 'surfacing', text: d.share.slice(0, 120), pass: gate.pass, reason: gate.reason });
            if (gate.pass) sublimate(`想跟主人说：${d.share}`).catch(() => {});
          }
        })
        .catch(() => { refundDeliberationBudget(t); }); // 深思 promise 异常 reject 也退还名额（防御：deliberate 内部已 fail-open，正常不到这）
    }

    journal(t, {
      tickId,
      kind: 'attend',
      winner: winner ? { source: winner.source, score: winner.score, text: winner.text.slice(0, 160) } : null,
      runnerUps: candidates.slice(1, 4).map((c) => ({ source: c.source, score: c.score, text: c.text.slice(0, 80) })),
      escalated,
      affect: affectSnap ? { v: Math.round((affectSnap.v ?? 0) * 100) / 100, a: Math.round((affectSnap.a ?? 0) * 100) / 100, label: affectSnap.label } : null,
    });
    // P2-2：记 GWT 广播指标（赢家来源 + 竞争候选数=广播半径代理）；optional-chain，未注入零回归。
    try { gwtMetrics?.record?.({ winner: winner ? (winner.source || winner.kind || 'unknown') : 'none', candidateCount: candidates.length }); } catch { /* metrics best-effort，绝不阻断广播 */ }
    return { winner, candidates, escalated };
  }

  function journal(t, obj) {
    try { appendJournal?.(dayOf(t), { ts: t, ...obj }); } catch { /* 日志失败不阻断认知 */ }
  }

  /** 本周期焦点（InnerMonologue focusProvider 注入位）。 */
  function currentFocus() {
    return focusText ? { text: focusText, source: focusSource } : null;
  }

  /** S0.3：最近一次思维回环检测信号（门控关/无命中→null）。仅供观测，不参与广播。 */
  function getThoughtLoopSignal() {
    return lastLoopSignal;
  }

  return { step, currentFocus, getThoughtLoopSignal, refreshSemanticCache, gwtMetricsSnapshot: () => (gwtMetrics?.snapshot?.() || null) };
}
