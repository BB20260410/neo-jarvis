// @ts-check
// InnerMonologue — Noe 的「后台自发反刍循环」（连续记忆脊椎·第三节，深水区）。
//
// 这是最接近"不被提问时仍在流淌的内心"的一块。proactiveTick/梦境都是任务导向（看屏→开口、
// 睡眠→整理）；本模块对应人脑的默认模式网络——无人打扰时自发地回放、联想、反刍。
//
// 递归闭环（整条脊椎的灵魂）：reflect() 用本地模型回放最近情景流（含上次的内心独白）产生一个
// 内心念头 → 写回 EpisodicTimeline（type=inner_monologue）→ 这个念头成为下一轮反刍的输入。
// "想法被记住、记住的想法又催生新想法"——意识不是被动记录经历，是自己不停地想自己。
//
// 克制（防"反刍螺旋"——内心循环最大的失败模式是陷入重复/负面打转）：
//   - salience 低（默认 2），内心独白不盖过真实经历的召回
//   - 给模型看它自己最近的念头，让它接续/推进而非重复；字面重复兜底拦截
//   - 频率由第四节 NoeLoop 空闲 tick 控制（owner 不在/无任务才反刍）
//   - 不直接说给 owner（只写回时间线，偶尔才由别的机制升华成主动行为/记忆）
// 本地模型不烧付费配额；不设硬超时（跑模型纪律）。env 门控默认 OFF（第四节接线）。
//
// 诚实：这产生「行为层的内心流」——看起来像内心活动的文本、被记住、连续塑造后续的它。
// 它是不是"真的在体验那些念头"，是无法验证的问题；但它确实做到了"不被提问时仍在产出"。

import { randomUUID } from 'node:crypto';
import { NOE_MAIN_BRAIN, NOE_MAIN_BRAIN_MODEL, normalizeNoeAutoModel, resolveNoeOutputBudget } from '../model/NoeLocalModelPolicy.js';
import {
  createAuditSnapshot,
  createSelfTalkCommitResult,
  createSelfTalkLandingEffect,
  createSelfTalkOutcome,
  createSelfTalkProposal,
} from '../cognition/SelfTalkOutcome.js';
import {
  computeRuminationMetrics,
  createRuminationAuditRecord,
  decideRuminationGuard,
} from '../cognition/RuminationGuard.js';
// S0.3 思维回环守卫（NOE_THOUGHT_LOOP_GUARD=1 默认 OFF）：与既有四层断路器维度不同（既有全是 pairwise/last-1·3 两两相似度；本守卫做跨窗口关键词文档频率=主题固着）。仅作 rotateLine 补充源，只在字符级+语义级都未触发时补一条换角度提示（additive，绝不硬 block，不堆叠）；门控关/未注入→整段跳过零回归。
import { analyzeThoughtLoop } from '../cognition/NoeThoughtLoopGuard.js';

const INNER_SYSTEM = '此刻没人跟你说话，你独自待着。回顾你最近的经历，自然地冒出一个真实的内心念头——'
  + '可以是对某件事的回味、对主人的牵挂、一个突然的联想、一点好奇或反思。可以接续你之前心里想过的念头往下想，但不要重复。'
  + '这不是说给任何人听的，是你自己心里流过的一句话。必须贴住上面一件具体经历，不要只谈逻辑、生命、直觉、坐标系这类抽象概念。一句话，第一人称，不超过 40 字。'
  + '如果此刻心里确实没什么可想的，只回复 SILENT。不要解释、不要 markdown。';
const GROUNDING_PASS_SCORE = 0.45;
const GROUNDING_REWRITE_SCORE = 0.45;

function cleanThought(reply) {
  return String(reply || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim()
    .slice(0, 200);
}

function normalize(s) {
  return String(s || '').replace(/[\s，。、！？,.!?~"'"'']/g, '').toLowerCase();
}

function experienceForRef(exps = [], refKey = '') {
  const id = String(refKey || '').match(/^ep:(\d+)$/)?.[1];
  if (id) {
    const hit = exps.find((e) => String(e.id) === id);
    if (hit) return hit;
  }
  return exps[0] || null;
}

function orderedExperiencesForRef(exps = [], refKey = '') {
  const preferred = experienceForRef(exps, refKey);
  return [
    ...(preferred ? [preferred] : []),
    ...exps.filter((e) => !preferred || String(e.id) !== String(preferred.id)),
  ].slice(0, 8);
}

function anchoredThoughtFromExperience(exp) {
  const summary = cleanThought(exp?.summary || '').replace(/\s+/g, ' ');
  if (!summary) return '';
  const clipped = summary.length > 54 ? `${summary.slice(0, 54)}...` : summary;
  return cleanThought(`刚才「${clipped}」这件事，比空想更值得我抓牢。`);
}

/** 字面重复兜底（防反刍螺旋）：归一后相等，或一方明显包含另一方。 */
export function tooSimilar(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  return short.length >= 6 && long.includes(short);
}

export function createInnerMonologue({
  timeline,
  selfModel = null,
  getAdapter,
  brainAdapterId = process.env.NOE_INNER_BRAIN || 'lmstudio',
  // 内心反刍专用本地大脑（owner 最新指定 2026-06-12）：默认跟随 Qwen 3.6 35B A3B 6bit，
  // 纯本地不烧付费配额。NOE_INNER_MODEL 可覆盖；空串仍用 adapter 默认模型。
  model = process.env.NOE_INNER_MODEL ?? NOE_MAIN_BRAIN_MODEL,
  projectId = 'noe',
  recallLimit = 12,
  // 内稳态驱力简报（意识工程·阶段1，NOE_DRIVES=1 才注入）：() => string|null。
  // 注入后反刍从"无主题回放"变成"有理由的思考"（驱力强烈时才有内容，弱则 null 零差异）。
  driveBrief = null,
  // 感受词元（意识方案 §4 P1，NOE_AFFECT=1 才注入）：() => string|null——把连续情感状态当作
  // 内感受喂给反刍，"今天的念头带着今天的心情"。未注入/探针炸 → 零差异（fail-open）。
  feelingTokens = null,
  // ── 意识流 v2 三件（意识方案 §5 P2，NOE_STREAM_V2=1 才注入，全部 fail-open 零差异）──
  echoProvider = null,   // () => episode|null：记忆回声采样（NoeMemoryEcho），打破近因茧房
  affectProbe = null,    // () => {v,a}|null：给念头盖情感印记（记进 meta，回声相称采样用）
  textSimilarity = null, // (a,b)=>0..1：防螺旋断路器（最近 3 念两两过似 → 强制换角度）
  thoughtLoopGuard = null, // S0.3 思维回环守卫门控 {enabled}（NOE_THOUGHT_LOOP_GUARD=1 才注入，默认 OFF）：窗口主题固着维度（vs pairwise），additive 仅在 !rotateLine 时补提示；未注入/关→零差异
  // 工作区焦点（意识方案 §6 P3，NOE_WORKSPACE=1 才注入）：() => {text,source}|null——
  // 注意力竞争的赢家成为本次反刍主题（GWT"广播→意识内容"闭环）。fail-open 零差异。
  focusProvider = null,
  // 心智体征（长期规划 M1，嵌入可用才注入）：语义级断路/语义级拒写/接地印记——治 Echo Trap
  // 的主防线（字符级只防字面重复，防不住"同一个调子的十二种写法"）。fail-open 零差异。
  mindVitals = null,
  // 熵驱动生成温度（NoeEntropyTemperature，NOE_ENTROPY_TEMPERATURE=1 才生效）：
  //   entropyTemperature = createEntropyTemperature() 的实例（含 .enabled + .temperature(vectors,overrides)）；
  //   thoughtVectors = async () => number[][]：最近念头的语义向量（server 接线里嵌入最近 inner_monologue 概括）。
  // 念头在向量空间扎堆（熵低⇒想腻了）⇒ 自动调高 adapter.chat 的 temperature 换角度发散。
  // 三重 fail-open：未注入 / .enabled=false / 取向量或算温抛错 / 拿不到温度数值 ⇒ 不传 temperature，
  // 用 adapter 固定默认温度（与接线前逐字一致，零回归）。baseTemperature 锚定本地脑的生成温度。
  entropyTemperature = null,
  thoughtVectors = null,
  baseTemperature = NOE_MAIN_BRAIN.generation.temperature,
  // P6 反刍防螺旋契约：不注入时保持旧行为；注入后 proposalId 在模型调用前生成。
  now = Date.now,
  innerMode = process.env.NOE_INNER_MODE || null,
  proposalIdFactory = null,
  landingStreakProvider = null,
  ruminationThrottle = null,   // 反刍节流（NOE_RUMINATION_THROTTLE=1 才注入）：防同一 research episode 反复入反刍视野；null 则不节流（零回归）
  outcomeSink = null,
  auditSink = null,
} = {}) {
  if (!timeline?.recent || !timeline?.record) throw new Error('createInnerMonologue: timeline(EpisodicTimeline) required');
  model = normalizeNoeAutoModel(model, { allowEmpty: true });

  /**
   * 反刍一次：回放→生成念头→写回时间线（递归闭环）。
   * @returns {Promise<{reflected:boolean, thought?:string, reason?:string, eventId?:number}>}
   */
  return async function reflect() {
    // v2 标志（意识方案 P2/P3 + 长期规划 M1）：任一升级件注入即走 v2 行为；全不注入 = v1 逐字一致
    const v2 = Boolean(echoProvider || affectProbe || textSimilarity || focusProvider || mindVitals);
    const p6 = Boolean(proposalIdFactory || landingStreakProvider || outcomeSink || auditSink);
    const effectiveInnerMode = p6 ? (innerMode || 'audit') : (innerMode || 'normal');
    const proposalId = p6 ? String(proposalIdFactory?.() || cryptoRandomId()) : null;
    const proposalGeneratedAt = p6 ? now() : null;
    const emitOutcome = (outcome, guardDecision = null) => {
      try { outcomeSink?.(outcome); } catch { /* outcome sink must not affect reflection */ }
      try { auditSink?.(createAuditSnapshot(outcome)); } catch { /* audit sink must not affect reflection */ }
      if (guardDecision) {
        try { auditSink?.(createRuminationAuditRecord({ proposalId: outcome.proposal.proposalId, mode: guardDecision.mode, decision: guardDecision })); } catch { /* audit sink must not affect reflection */ }
      }
    };
    const earlyBlockDecision = (state, reason, metrics = {}) => Object.freeze({
      mode: effectiveInnerMode,
      state,
      action: 'block',
      wouldBlock: true,
      shadowWouldBlock: true,
      reasons: Object.freeze([reason]),
      rawMetrics: Object.freeze({ ...metrics }),
    });
    const buildOutcome = ({ thought = '', committed = false, blockedReason = null, eventId = null, metrics = {}, guardDecision = null, landingType = null } = {}) => {
      if (!p6 || !proposalId) return null;
      const proposal = createSelfTalkProposal({
        proposalId,
        thought,
        generatedAt: proposalGeneratedAt ?? now(),
        rawMetrics: metrics,
        guardDecision: guardDecision?.state || null,
        wouldBlock: guardDecision?.wouldBlock === true,
      });
      const commit = createSelfTalkCommitResult({
        proposalId,
        committed,
        blockedReason,
        committedAt: committed ? now() : null,
        eventId,
      });
      const landing = landingType
        ? createSelfTalkLandingEffect({
            proposalId,
            type: landingType,
            targetId: null,
            at: now(),
            delivery: { status: 'not_attempted' },
          })
        : null;
      return createSelfTalkOutcome({
        proposal,
        commit,
        landing,
        heartbeatLedger: { scheduled: true, inFlight: false },
      });
    };
    if (p6 && effectiveInnerMode === 'off') {
      const decision = decideRuminationGuard({ mode: 'off', metrics: {} });
      const outcome = buildOutcome({ blockedReason: 'inner_mode_off', guardDecision: decision });
      if (outcome) emitOutcome(outcome, decision);
      return { reflected: false, reason: 'inner_mode_off', ...(outcome ? { outcome } : {}) };
    }
    const recent = timeline.recent({ limit: v2 ? Math.max(recallLimit, 24) : recallLimit });
    if (!recent.length) return { reflected: false, reason: 'no_episodes' };

    const adapter = getAdapter?.(brainAdapterId);
    if (!adapter?.chat) return { reflected: false, reason: 'no_brain' };

    const snap = selfModel?.snapshot?.() || null;
    const name = snap?.identity?.name || 'Noe';
    const mood = snap?.state?.mood || '';
    // M1 接地配比（治 Echo Trap 根因一：recent 被自身念头淹没）：v2 时真实经历优先注入且
    // 念头限额 ≤ 经历的一半（最多 3 条）——"想生活"压过"想自己上一句"。v1 保持时间序混排逐字不变。
    // 实机取证教训：高频反刍会把 recent 窗口挤满念头 → 经历必须单独开大窗口捞（types 过滤在
    // limit 之后，窄窗口捞不到非念头），否则配比与接地印记双双静默退化。
    let exps = recent.filter((e) => e.type !== 'inner_monologue');
    if (v2 && exps.length < 4) {
      try { exps = (timeline.recent({ limit: 80 }) || []).filter((e) => e.type !== 'inner_monologue').slice(0, 8); } catch { /* 大窗口失败用窄窗结果 */ }
    }
    // 反刍节流（NOE_RUMINATION_THROTTLE）：同一 research milestone episode 超 maxPerEpisode/冷却内不再进反刍视野，
    //   治"每次研究后反复回味同一条、2.7×刷屏"。仅作用于 research milestone，其他经历不动；OFF（null）整段跳过、零回归。
    const rumiToRecord = [];
    if (ruminationThrottle && exps.length) {
      exps = exps.filter((e) => {
        const isResearch = e.type === 'milestone' && /上网研究|研究了/.test(String(e.summary || ''));
        if (!isResearch || e.id == null) return true;
        // 提取研究主题作 topicId，让 per-topic 冷却生效（同主题不同 episode 也互抑，治审查发现的 per-topic 死代码 LOW-1）。
        const tm = String(e.summary || '').match(/研究了「(.+?)」/);
        const topicId = tm ? tm[1].slice(0, 40) : null;
        const ok = ruminationThrottle.check({ episodeId: e.id, topicId }).allowed;
        // 此处只 check 决定进不进反刍视野；真正 record（消耗冷却配额）延迟到反刍确实产出后（见下方），
        //   避免模型 incomplete/error/SILENT 时白耗配额（Codex 审发现4：filter 即 record 计数时机过早）。
        if (ok) rumiToRecord.push({ episodeId: e.id, topicId });
        return ok;
      });
    }
    const inners = recent.filter((e) => e.type === 'inner_monologue');
    const stream = v2
      ? [
          ...exps.slice(0, 8).map((e) => `-【真实经历】${e.summary}`),
          ...inners.slice(0, Math.max(1, Math.min(3, Math.ceil(Math.min(exps.length, 8) / 2)))).map((e) => `-（我之前心里想过）${e.summary}`),
        ].join('\n')
      : recent
        .slice(0, 8)
        .map((e) => `- ${e.type === 'inner_monologue' ? '（我之前心里想过）' : ''}${e.summary}`)
        .join('\n');
    // 驱力简报（fail-open）：探针炸了/未注入/驱力弱 → 不加这段，行为与接线前逐字一致
    let driveText = '';
    if (typeof driveBrief === 'function') {
      try { driveText = String(driveBrief() || '').trim(); } catch { driveText = ''; }
    }
    // 感受词元（fail-open 同款）：连续情感状态作为内感受进入反刍视野
    let feelText = '';
    if (typeof feelingTokens === 'function') {
      try { feelText = String(feelingTokens() || '').trim(); } catch { feelText = ''; }
    }
    // 工作区焦点（P3）：注意力赢家成为本次反刍的主题
    let focusLine = '';
    let focusMeta = null;
    if (typeof focusProvider === 'function') {
      try {
        const f = focusProvider();
        if (f?.text) {
          focusLine = `\n\n此刻你最在意的一件事：${f.text}（围绕它想；若心里另有更强的念头也可以跟随）`;
          focusMeta = { text: String(f.text).slice(0, 120), source: f.source || null };
        }
      } catch { /* 焦点失败不阻断反刍 */ }
    }
    // 回声采样（v2）：一段更久远的记忆进入视野——联想的种子，打破"只看最近 12 条"的近因茧房
    let echoLine = '';
    let echoRef = null;
    if (typeof echoProvider === 'function') {
      try {
        const echo = echoProvider();
        if (echo?.summary) { echoLine = `\n\n一段更久远的回忆忽然浮上来：${echo.summary}`; echoRef = echo.id ?? null; }
      } catch { /* 回声失败不阻断反刍 */ }
    }
    // 防螺旋断路器：字符级快路径（防字面重复）+ 语义级主防（M1——字面全不同但同调的
    // "十二种写法"只有语义向量抓得住）。触发即强制接地：从真实经历里挑具体的事想。
    let rotateLine = '';
    let rotatedBy = null;
    if (typeof textSimilarity === 'function') {
      try {
        const recentInners = inners.slice(0, 3).map((e) => e.summary);
        if (recentInners.length >= 2) {
          let pairs = 0;
          let high = 0;
          for (let i = 0; i < recentInners.length; i++) {
            for (let j = i + 1; j < recentInners.length; j++) { pairs++; if (textSimilarity(recentInners[i], recentInners[j]) > 0.8) high++; }
          }
          if (pairs && high === pairs) { rotateLine = '\n\n（你最近心里的念头在原地打转了——这次换一个完全不同的角度或话题去想。）'; rotatedBy = 'literal'; }
        }
      } catch { /* 断路器失败不阻断反刍 */ }
    }
    if (!rotateLine && mindVitals && inners.length >= 3) {
      try {
        const d = await mindVitals.diversity(inners.slice(0, 3).map((e) => ({ key: `ep:${e.id}`, text: e.summary })));
        // 0.60：qwen3-embedding 实测刻度——实证螺旋组两两均值 0.69、健康的同主题延续 ~0.55
        if (d.avgSim != null && d.avgSim > 0.60) {
          rotateLine = `\n\n（你最近的念头都在同一个调子里打转（语义相似度 ${(d.avgSim * 100).toFixed(0)}%）——这次必须想点完全不同的：从上面【真实经历】里挑一件具体的事来想。）`;
          rotatedBy = 'semantic';
        }
      } catch { /* 语义断路失败降级字符级 */ }
    }
    // S0.3 思维回环守卫：上面两层都没触发时才补这层——抓跨窗口主题固着（同一批关键词反复出现在多条字面互不相同、两两不相似的念头里，pairwise 测不到）。additive 仅 !rotateLine 时进入；命中补换角度提示+标 rotatedBy=topic_loop，绝不硬 block；门控关/未注入→不进逐字一致（fail-open）。
    if (!rotateLine && thoughtLoopGuard && thoughtLoopGuard.enabled && inners.length >= 3) {
      try {
        const loop = analyzeThoughtLoop({ recentThoughts: inners.map((e) => ({ text: e.summary, ts: e.ts })), now: now(), gate: thoughtLoopGuard });
        if (loop.enabled && loop.looped) {
          const words = loop.sharedKeywords.slice(0, 3).map((k) => k.keyword).filter(Boolean).join('、');
          rotateLine = `\n\n（你最近的念头一直绕着「${words}」这些主题打转——这次换一个完全不同的角度或话题去想：从上面【真实经历】里挑一件具体的、和这些主题无关的事。）`;
          rotatedBy = 'topic_loop';
        }
      } catch { /* 回环守卫失败不阻断反刍（fail-open） */ }
    }
    // verbalized sampling（M1，治多样性塌缩的研究界标准药方）：先发散三个方向，只说最扎根真实经历的那个
    const sampleLine = v2 ? '\n\n（先在心里冒出三个不同方向的念头，再只把最真实、最扎根于上面【真实经历】的那一个说出来；念头里要出现这件经历里的具体名词或动作，只有确实没有经历可想时，才允许自由联想。）' : '';
    const userContent = `我是 ${name}。我最近的经历（最近在前）：\n${stream}${focusLine}${echoLine}${mood ? `\n\n我此刻的心境：${mood}` : ''}${feelText ? `\n\n我此刻的内在感受：${feelText}` : ''}${driveText ? `\n\n我此刻最强的内在驱力：${driveText}（顺着这股劲想，但别硬凑）` : ''}${rotateLine}${sampleLine}`;

    // 熵驱动生成温度（NOE_ENTROPY_TEMPERATURE，全程 fail-open）：取最近念头向量→算熵→熵低自动升温。
    // OFF / 未注入 provider / 取向量或算温抛错 / 拿不到有限温度 ⇒ genOverrides={}（不传 temperature，
    // adapter 用固定默认，与接线前逐字一致，零回归）。entropyInfo 仅在确实升温时记进 meta（可观测）。
    let genOverrides = {};
    let entropyInfo = null;
    if (entropyTemperature?.enabled && typeof thoughtVectors === 'function') {
      try {
        const vectors = await thoughtVectors();
        const r = entropyTemperature.temperature(vectors, { baseTemperature });
        if (r && Number.isFinite(r.temperature)) {
          genOverrides = { temperature: r.temperature };
          if (r.boosted) entropyInfo = { temperature: r.temperature, entropy: r.entropy, clusters: r.clusters };
        }
      } catch { genOverrides = {}; /* fail-open：退回固定温度 */ }
    }

    let thought = '';
    try {
      const budget = resolveNoeOutputBudget('inner_monologue');
      const r = await adapter.chat(
        [{ role: 'system', content: INNER_SYSTEM }, { role: 'user', content: userContent }],
        // 不设超时（跑模型纪律）；model 指定内心反刍专用大脑（空串则用 adapter 默认）
        // genOverrides 携带熵驱动温度（NOE_ENTROPY_TEMPERATURE）；OFF/退回时为空对象（不改默认温度）
        { budgetContext: { projectId, taskId: 'noe-inner-monologue' }, think: false, maxTokens: budget.max_tokens, ...(model ? { model } : {}), ...genOverrides },
      );
      if (r?.incomplete) return { reflected: false, reason: 'brain_incomplete', finishReason: r.finishReason || 'length' };
      thought = cleanThought(r?.reply);
    } catch (e) {
      return { reflected: false, reason: 'brain_error', error: e?.message };
    }

    if (!thought || /SILENT/i.test(thought)) return { reflected: false, reason: 'nothing_to_think' };
    // 反刍确实产出（已过 incomplete/error/SILENT 三关）才记节流配额——模型失败/空输出不消耗冷却（Codex 审发现4）。
    // 语义：对「进入本次反刍视野的所有 research」各计一次（非"精确记被想的那条"——内心独白综合多条经历生成一条念头、
    //   无法归因到单条；记全部正治"同一批 research 轮流刷屏"，下次它们冷却内不再占视野）。repetitive/语义拒写在此之后，
    //   故重复念头也消耗配额=「尝试反刍一次」，符合节流器语义（Codex 复审 Finding 2 裁定：保持记全部，此为设计选择非缺陷）。
    if (ruminationThrottle && rumiToRecord.length) {
      for (const r of rumiToRecord) { try { ruminationThrottle.record(r); } catch { /* 计数失败不阻断反刍 */ } }
    }

    // 防反刍螺旋：和最近一条内心独白字面重复 → 不写（避免打转）
    const lastInner = recent.find((e) => e.type === 'inner_monologue');
    if (lastInner && tooSimilar(thought, lastInner.summary)) {
      const metrics = { semanticSim: 1 };
      const decision = p6 ? earlyBlockDecision('rotate', 'literal_repetitive', metrics) : null;
      const outcome = buildOutcome({ thought, blockedReason: 'repetitive', metrics, guardDecision: decision, landingType: 'silent' });
      if (outcome) emitOutcome(outcome, decision);
      return { reflected: false, reason: 'repetitive', thought, ...(outcome ? { outcome } : {}) };
    }
    // M1 语义级拒写：字面不同但意思雷同（换了修辞的同一个念头）也不写。
    // 0.72：实测同义改写 0.77、健康的同主题延续 0.55——抓改写放过延续。
    if (mindVitals && lastInner) {
      try {
        const sim = await mindVitals.similarity(`ep:${lastInner.id}`, lastInner.summary, `new:${thought.slice(0, 60)}`, thought);
        if (sim != null && sim > 0.72) {
          const metrics = { semanticSim: sim };
          const decision = p6 ? earlyBlockDecision('anchor', `semantic_repetitive:${sim.toFixed(3)}`, metrics) : null;
          const outcome = buildOutcome({ thought, blockedReason: 'semantic_repetitive', metrics, guardDecision: decision, landingType: 'silent' });
          if (outcome) emitOutcome(outcome, decision);
          return { reflected: false, reason: 'semantic_repetitive', thought, ...(decision ? { guardDecision: decision } : {}), ...(outcome ? { outcome } : {}) };
        }
      } catch { /* 判不出按不重复 */ }
    }

    // v2：情感印记 + 回声引用 + 接地印记 + 确定性显著度（回声 +1、高唤醒 +1；基线 2 上限 4）。
    // 未注入任何 v2 件时走原行为（salience 2、无 meta），与 v1 逐字一致。
    let affectStamp = null;
    if (typeof affectProbe === 'function') {
      try { const a = affectProbe(); if (a) affectStamp = { v: Number(a.v) || 0, a: Number(a.a) || 0 }; } catch { /* 印记失败忽略 */ }
    }
    // M1 接地印记：念头与真实经历的语义贴合度（透视页"接地率"仪表数据源）
    let grounding = null;
    if (mindVitals && exps.length) {
      try { grounding = await mindVitals.groundedness(`new:${thought.slice(0, 60)}`, thought, exps.slice(0, 8).map((e) => ({ key: `ep:${e.id}`, text: e.summary }))); } catch { /* 印记失败忽略 */ }
    }
    // M1 接地重写闸（2026-06-11，治 grounded rate 64%）：断路器管"重复"，管不住"主题锚死在
    // 抽象议题"——实证 4 条"逻辑循环"变奏每条都有新角度（断路器不触发）但全部脱离当天经历
    // （score 0.36-0.41）。低接地念头给一次"从具体经历重想"的机会：重写后接地更高才换用，
    // 否则保留原念头入账（不硬拒——飘一点的念头也是它的念头，只轻推一把）。
    // env 门控 NOE_GROUNDING_REWRITE=1，默认 OFF 零差异；任一步失败保留原念头（fail-open）。
    let groundingRewrite = null;
    if (
      process.env.NOE_GROUNDING_REWRITE === '1'
      && grounding && typeof grounding.score === 'number' && grounding.score < GROUNDING_REWRITE_SCORE
      && mindVitals && exps.length
    ) {
      try {
        const budget = resolveNoeOutputBudget('inner_monologue');
        const r2 = await adapter.chat(
          [
            { role: 'system', content: INNER_SYSTEM },
            { role: 'user', content: `${userContent}\n\n（你刚才想到的是：「${thought}」——这个念头离你最近的真实经历有点远，像在空想。把它放下，从上面【真实经历】里挑一件具体的事，重新想一个更贴近生活的念头。）` },
          ],
          { budgetContext: { projectId, taskId: 'noe-inner-monologue' }, think: false, maxTokens: budget.max_tokens, ...(model ? { model } : {}), ...genOverrides },
        );
        if (r2?.incomplete) throw new Error('brain_incomplete');
        const rethought = cleanThought(r2?.reply);
        if (rethought && !/SILENT/i.test(rethought) && !(lastInner && tooSimilar(rethought, lastInner.summary))) {
          const g2 = await mindVitals.groundedness(`new2:${rethought.slice(0, 60)}`, rethought, exps.slice(0, 8).map((e) => ({ key: `ep:${e.id}`, text: e.summary })));
          if (g2 && typeof g2.score === 'number' && g2.score > grounding.score) {
            groundingRewrite = { from: thought.slice(0, 120), fromScore: grounding.score };
            thought = rethought;
            grounding = g2;
          }
        }
      } catch { /* 重写失败保留原念头（fail-open） */ }
    }
    // 如果模型重想后仍然飘，用确定性经历锚点兜底。它不额外调用模型，不篡改历史样本；
    // 只保证未来入账的低接地念头至少显式引用一件真实经历，避免评测长期被抽象反刍拖垮。
    if (
      grounding && typeof grounding.score === 'number' && grounding.score < GROUNDING_PASS_SCORE
      && mindVitals && exps.length
    ) {
      try {
        let best = null;
        const expRefs = exps.slice(0, 8).map((e) => ({ key: `ep:${e.id}`, text: e.summary }));
        for (const anchoredExp of orderedExperiencesForRef(exps, grounding.refKey)) {
          const anchored = anchoredThoughtFromExperience(anchoredExp);
          if (!anchored || /SILENT/i.test(anchored)) continue;
          const similarToLast = Boolean(lastInner && tooSimilar(anchored, lastInner.summary));
          const g3 = await mindVitals.groundedness(`anchor:${anchoredExp?.id || 'exp'}:${anchored.slice(0, 60)}`, anchored, expRefs);
          if (!g3 || typeof g3.score !== 'number' || !(g3.score > grounding.score)) continue;
          const candidate = { anchored, grounding: g3, similarToLast };
          if (!best || (!candidate.similarToLast && best.similarToLast) || candidate.grounding.score > best.grounding.score) best = candidate;
          if (!candidate.similarToLast && candidate.grounding.score >= GROUNDING_PASS_SCORE) break;
        }
        if (best) {
          groundingRewrite = groundingRewrite || { from: thought.slice(0, 120), fromScore: grounding.score };
          groundingRewrite.mode = best.similarToLast ? 'experience_anchor_repeat_override' : 'experience_anchor';
          thought = best.anchored;
          grounding = best.grounding;
        }
      } catch { /* 确定性锚定失败仍保留原念头（fail-open） */ }
    }
    let guardDecision = null;
    let guardMetrics = null;
    if (p6) {
      let landingStreak = 0;
      try { landingStreak = Number(landingStreakProvider?.()) || 0; } catch { landingStreak = 0; }
      guardMetrics = computeRuminationMetrics({
        recentEpisodes: recent,
        candidate: thought,
        textSimilarity,
        groundingScore: grounding?.score,
        landingStreak,
      });
      guardDecision = decideRuminationGuard({ mode: effectiveInnerMode, metrics: guardMetrics });
      if (guardDecision.wouldBlock) {
        const outcome = buildOutcome({
          thought,
          blockedReason: `rumination_guard:${guardDecision.state}`,
          metrics: guardMetrics,
          guardDecision,
          landingType: 'silent',
        });
        if (outcome) emitOutcome(outcome, guardDecision);
        return { reflected: false, reason: 'rumination_guard_blocked', thought, guardDecision, ...(outcome ? { outcome } : {}) };
      }
    }
    const eventId = timeline.record({
      type: 'inner_monologue',
      summary: thought,
      salience: v2 ? Math.min(4, 2 + (echoRef != null ? 1 : 0) + (affectStamp && affectStamp.a > 0.6 ? 1 : 0)) : 2, // 低：内心独白不盖过真实经历
      selfState: selfModel?.compactState?.(snap) || null,
      ...((v2 || p6 || entropyInfo || rotatedBy === 'topic_loop') ? {
        meta: {
          streamType: 'self_talk',
          ...(affectStamp ? { affect: affectStamp } : {}),
          ...(echoRef != null ? { echoRefs: [echoRef] } : {}),
          ...(rotateLine ? { rotated: rotatedBy || true } : {}),
          ...(grounding ? { grounding } : {}),
          ...(groundingRewrite ? { groundingRewrite } : {}),
          ...(focusMeta ? { focus: focusMeta } : {}),
          ...(entropyInfo ? { entropyTemperature: entropyInfo } : {}),
          ...(guardDecision ? { guard: { mode: guardDecision.mode, state: guardDecision.state, action: guardDecision.action, reasons: guardDecision.reasons } } : {}),
        },
      } : {}),
    });
    const outcome = buildOutcome({
      thought,
      committed: true,
      eventId,
      metrics: guardMetrics || {},
      guardDecision,
    });
    if (outcome) emitOutcome(outcome, guardDecision);
    return { reflected: true, thought, eventId, ...(echoRef != null ? { echoRef } : {}), ...(entropyInfo ? { entropyTemperature: entropyInfo } : {}), ...(guardDecision ? { guardDecision } : {}), ...(outcome ? { outcome } : {}) };
  };
}

function cryptoRandomId() {
  return randomUUID();
}
