// @ts-check
// NoeSelfModel — Noe 的「动态自我模型」（连续记忆脊椎·第二节）。
//
// 问题：NoeSelfKnowledge 是静态能力清单（"我能做什么"），不是"我此刻是谁"。一个有连续自我的
// 存在，回应该基于"连续演化到现在的我"，而非每轮冷启动重拼人格。本模块把已有碎片缝合成一个
// 三层自我视图，注入 system prompt，并作为 selfState 快照回写情景时间线（第一节）：
//   身份(稳定:我是谁/和 owner 关系) / 状态(慢变:心境/牵挂) / 处境(快变:此刻/owner在否/距上次多久)
//
// 缝合来源：EpisodicTimeline(第一节，推断心境+距上次交互) / NoeCommitmentStore(当前牵挂) /
//   NoeHostContext(本机处境)。全部注入式，缺失则该层优雅降级为空——不阻塞、可逐步接线。
// 诚实：mood 是从近期经历推断的「行为层心境」启发式，不声称是真情绪（见 inferMood）。

import { relativeTime, defaultEpisodicTimeline } from '../memory/EpisodicTimeline.js';
import { getCachedHostContextBlock } from './NoeHostContext.js';
import { createNoeSelfModelVersionStore } from './NoeSelfModelVersionStore.js';

// 身份层默认（稳定）。可注入覆盖——将来接 OwnerIdentityStore 填真实关系，或改名时换 name（如"伴影"）。
export const DEFAULT_IDENTITY = {
  name: 'Noe',
  relationship: 'owner 是我的主人，我们在一起把我开发成一个有连续记忆、会主动陪伴的私人 AI',
  disposition: '诚实、极客、克制地主动；不吹没有的能力，不打扰人',
};

function loadVersionedIdentity(store) {
  try {
    const current = store?.current?.();
    return current?.identity ? current : null;
  } catch { return null; }
}

/**
 * 从近期情景流推断「行为层心境」——这不是真情绪，是一个让回应有连续质感的启发式（据实标注）。
 * 纯函数，可注入替换。
 * @param {Array<{type:string,summary:string,salience:number,ts:number}>} recent 时序倒序（最近在前）
 * @param {number} [now]
 * @param {{isQuiet?: (ts?: number) => boolean}|null} [circadian] 时间节律（支柱⑦，注入才生效）：深夜且无即时活动 → 安静守着
 */
export function inferMood(recent = [], now = Date.now(), circadian = null) {
  // 时间节律：未注入 circadian（默认 null）时 quietNow 恒 false，下面所有分支与现状逐字一致；判定抛错按非夜处理（fail-open）。
  let quietNow = false;
  if (circadian && typeof circadian.isQuiet === 'function') {
    try { quietNow = circadian.isQuiet(now) === true; } catch { quietNow = false; }
  }
  if (!Array.isArray(recent) || !recent.length) return quietNow ? '夜深了，安静守着' : '平稳，待命中';
  const top = recent[0];
  const sinceTop = now - (top.ts || now);
  const recentChat = recent.filter((e) => e.type === 'interaction' && now - e.ts < 30 * 60000).length;
  const lastInteraction = recent.find((e) => e.type === 'interaction');
  const sinceChat = lastInteraction ? now - lastInteraction.ts : Infinity;
  const hasFreshMilestone = recent.some((e) => e.type === 'milestone' && (e.salience ?? 0) >= 7 && now - e.ts < 60 * 60000);

  // 优先级：当下正发生的 > 即时刚做完的新鲜活动 > 长期背景状态。
  if (recentChat >= 2) return '和 owner 聊得正起劲';
  if (hasFreshMilestone) return '刚完成了要紧的事，踏实';
  if (top.type === 'inner_monologue' && sinceTop < 30 * 60000) return '刚自己想了会儿事，思绪还在飘';
  if (top.type === 'dream' && sinceTop < 60 * 60000) return '梦里刚整理过记忆，清明';
  if (quietNow) return '夜深了，安静守着';  // 深夜且无即时活动：安静守着（惦记白天再浮出）
  if (sinceChat > 24 * 3600000) return '有阵子没 owner 的消息了，有点惦记';  // 即时活动盖不住时才浮出的背景惦记
  return '平稳，待命中';
}

// ── persona-pin（P7 换路线，2026-06-22）─────────────────────────────────────
// owner 2026-06-21 复盘：persona 不该靠 LoRA（训透 SFT=人格退化），该挂 system prompt。
// 本函数把「稳定的人设」（身份基底 disposition + 性格观察 + 自我叙事）缝成一段**稳定 persona
// 文本**（≤maxSentences 句），供 P0.5 的 persona-pin 段挂进 system prompt。
//
// 与 buildSelfStateBlock 的分工：buildSelfStateBlock 是「此刻的我」（含 mood/牵挂/处境等快变层，
// 每轮变）；buildPersonaPin 是「我是谁」（只取稳定层，跨轮稳定，适合固定钉在 system prompt 顶部）。
// 纯函数：句子来源从参数传入（DI），可单测；空/异常段优雅跳过，全空返回 ''（调用方据空判不注入）。

const PERSONA_PIN_MAX_SENTENCES = 5;

// 快变层过滤（防情绪/近况锚定漂移，Codex#7）：persona-pin 只能含「跨轮稳定的性格骨架」，
// 绝不能把「此刻心情 / 这一周做了什么 / 正在经历的项目 / 当前驱力 / 具体承诺」固化进常挂 system prompt
// ——那些是 buildSelfStateBlock 的快变层职责，逐轮变；若漏进 persona-pin 会被每轮放大成情绪锚定。
// personalitySnapshot / narrativeSelf 的 LLM 产出（prompt 含「这一周我…」「我们正在经历什么」）天然夹带时态/
// 近况句，故在此按时态标记词逐句剔除，只留性格倾向句（disposition 是手写稳定基底，但仍过同一把尺，零特例）。
// 纯启发式（标记词命中即判快变），宁可漏掉一句性格观察也不让快变句污染——稳定性 > 完整性。
// 注：标记词只列「足够特异、不会误伤稳定性格句」的词——裸单字「正/刚」会误命中「正直/刚毅」等性格词，故用组合形式。
const VOLATILE_MARKERS = [
  '此刻', '现在', '当下', '正在', '正经历', '正在经历', '刚才', '刚刚', '刚完成', '刚做', '最近', '近来', '近期',
  '今天', '今晚', '昨天', '昨晚', '明天', '这一周', '这周', '本周', '上周', '这一阵', '这阵子', '这段时间',
  '一周', '近一周', '过去一周', '这些天', '眼下',
  '驱力', '牵挂', '惦记', '答应', '承诺', '里程碑', '我们正在经历', '经历着', '在经历',
];

/** 句子是否含快变/近况时态标记（命中即视为快变层，不进 persona-pin）。 */
function isVolatileSentence(s) {
  const text = String(s ?? '');
  if (!text) return false;
  return VOLATILE_MARKERS.some((m) => text.includes(m));
}

/**
 * 把一段可能含多句、夹带快变时态句的文本，过滤成只剩稳定性格骨架的单句（去掉所有命中时态标记的子句）。
 * 按中英文句末标点切句，逐句判定；全被滤掉则返回 ''（调用方据空跳过该来源）。
 * @param {string} raw @param {number} maxLen
 * @returns {string}
 */
function stableSentencesOnly(raw, maxLen) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const parts = text.split(/(?<=[。！？!?；;\n])/).map((p) => p.trim()).filter(Boolean);
  const kept = parts.filter((p) => !isVolatileSentence(p));
  return kept.join('').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

/** 截断到 maxLen 并去尾空白/句末重复标点。 */
function clampSentence(s, maxLen) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

/**
 * 缝合稳定 persona 文本（persona-pin）。纯函数，可单测。
 * 【只取稳定层】每个来源都先过 stableSentencesOnly 剔除快变/近况时态句（防情绪锚定漂移，Codex#7），
 *   只保留跨轮稳定的性格骨架；某来源被滤空则该句跳过。
 * @param {{disposition?: string, personality?: string, narrative?: string, name?: string}} parts
 *   disposition: 身份基底性情（DEFAULT_IDENTITY.disposition）；personality: 性格快照自述；
 *   narrative: 自我叙事；name: 自称（仅在拼首句时用）。任一缺/空/被滤空则该句跳过。
 * @param {{maxSentences?: number, maxLen?: number}} [opts]
 * @returns {string} ≤maxSentences 句的 persona 文本（仅稳定层）；全空返回 ''。
 */
export function buildPersonaPin(parts = {}, { maxSentences = PERSONA_PIN_MAX_SENTENCES, maxLen = 160 } = {}) {
  const cap = Math.max(1, Math.trunc(Number(maxSentences) || PERSONA_PIN_MAX_SENTENCES));
  /** @type {string[]} */
  const sentences = [];
  // 每个来源都只取稳定层（剔时态句），滤空则该句跳过。
  const push = (s) => { const v = clampSentence(stableSentencesOnly(s, maxLen), maxLen); if (v && sentences.length < cap) sentences.push(v); };
  // 顺序：性情基底（最稳定）→ 性格观察 → 自我叙事。
  push(parts.disposition);
  push(parts.personality);
  push(parts.narrative);
  return sentences.join('\n');
}

export class NoeSelfModel {
  constructor({
    timeline = defaultEpisodicTimeline,
    commitmentStore = null,
    hostContextBlock = getCachedHostContextBlock,
    identity = {},
    moodInferrer = inferMood,
    circadian = null,
    narrativeSelf = null,
    driveSystem = null,
    personalitySnapshot = null,
    personaPins = null,
    selfModelVersionStore = undefined,
    selfModelDir = null,
    now = Date.now,
  } = {}) {
    this.timeline = timeline;
    this.commitmentStore = commitmentStore;
    this.hostContextBlock = typeof hostContextBlock === 'function' ? hostContextBlock : () => '';
    this.selfModelVersionStore = selfModelVersionStore === false
      ? null
      : selfModelVersionStore || createNoeSelfModelVersionStore({ ...(selfModelDir ? { rootDir: selfModelDir } : {}), now });
    const versioned = loadVersionedIdentity(this.selfModelVersionStore);
    this.identityVersion = versioned?.versionId || null;
    this.identity = { ...DEFAULT_IDENTITY, ...(versioned?.identity || {}), ...(identity && typeof identity === 'object' ? identity : {}) };
    this.moodInferrer = typeof moodInferrer === 'function' ? moodInferrer : inferMood;
    // 时间节律（支柱⑦）：注入 { phaseOf, isQuiet } 才生效（snapshot 加 timeOfDay + 深夜心境）；null=行为与现状逐字一致。
    this.circadian = circadian && typeof circadian === 'object' ? circadian : null;
    // 叙事自我（支柱⑤）：注入 { current } 才有「我的故事」一行（只读注入，绝不反哺 identity 层）；null=行为与现状逐字一致。
    this.narrativeSelf = narrativeSelf && typeof narrativeSelf.current === 'function' ? narrativeSelf : null;
    // 内稳态驱力（意识工程·阶段1，NOE_DRIVES=1 才注入）：{ brief } 才有「内在驱力」一行；null=行为与现状逐字一致。
    this.driveSystem = driveSystem && typeof driveSystem.brief === 'function' ? driveSystem : null;
    // 性格快照（意识工程·阶段2，NOE_PERSONALITY_SNAPSHOT=1 才注入）：{ current } 才有「我的性格」一行
    // （从自己行为统计长出的只读观察，绝不反哺 identity 层）；null=行为与现状逐字一致。
    this.personalitySnapshot = personalitySnapshot && typeof personalitySnapshot.current === 'function' ? personalitySnapshot : null;
    // owner 偏好下沉（P8，NOE_MEMORY_PERSONA_PIN=1 才下沉）：注入 { buildOwnerPreferenceLines } 才把记忆库里
    // 的稳定 owner 偏好句并到 persona-pin（与 P7 自我人设拼一段，经 personaPinProvider 进 system prompt）；
    // null=行为与现状逐字一致（只剩 P7 自我人设层）。fail-open：取行抛错则跳过该段，不破坏 buildPersonaPin。
    this.personaPins = personaPins && typeof personaPins.buildOwnerPreferenceLines === 'function' ? personaPins : null;
    this.now = now;
  }

  /** 自知之明（长期规划 M11）：期望账本的校准结论 provider（()=>string，"我预测有多准"）；null=行不出现。 */
  setCalibrationNote(provider) {
    this.calibrationNote = typeof provider === 'function' ? provider : null;
  }

  #commitments(t) {
    if (!this.commitmentStore) return [];
    try {
      const due = typeof this.commitmentStore.due === 'function' ? this.commitmentStore.due(t) : [];
      const src = (Array.isArray(due) && due.length)
        ? due
        : (typeof this.commitmentStore.list === 'function' ? this.commitmentStore.list({ status: 'open' }) : []);
      return (Array.isArray(src) ? src : []).map((c) => String(c?.text || c?.summary || '').trim()).filter(Boolean);
    } catch { return []; }
  }

  /**
   * 当前自我快照（三层）。也是回写情景时间线的 selfState 来源（用 compactState 精简）。
   * @param {object} [opts] { ownerPresent:boolean|null, now:number }
   */
  snapshot({ ownerPresent = null, now } = {}) {
    const t = now ?? this.now();
    const recent = this.timeline?.recent ? this.timeline.recent({ limit: 12 }) : [];
    const lastInteraction = recent.find((e) => e.type === 'interaction');
    // 时间节律：注入 circadian 才有 timeOfDay；phaseOf 抛错/空值则不加该字段（fail-open，快照形状回到现状）。
    let timeOfDay = null;
    if (this.circadian && typeof this.circadian.phaseOf === 'function') {
      try { timeOfDay = this.circadian.phaseOf(t) || null; } catch { timeOfDay = null; }
    }
    return {
      identity: { ...this.identity, ...(this.identityVersion ? { selfModelVersion: this.identityVersion } : {}) },
      state: {
        mood: this.moodInferrer(recent, t, this.circadian),
        commitments: this.#commitments(t).slice(0, 5),
        recentThemes: recent.slice(0, 3).map((e) => e.summary).filter(Boolean),
      },
      situation: {
        atMs: t,
        ownerPresent,
        sinceLastInteraction: lastInteraction ? relativeTime(lastInteraction.ts, t) : null,
        hasHostContext: Boolean(this.hostContextBlock()),
        ...(timeOfDay ? { timeOfDay } : {}),
      },
    };
  }

  /** 精简自我状态，供 EpisodicTimeline.record 的 selfState 字段（回放时重建"当时的我"）。 */
  compactState(snap) {
    const s = snap || this.snapshot();
    return {
      mood: s.state.mood,
      commitmentCount: s.state.commitments.length,
      sinceLastInteraction: s.situation.sinceLastInteraction,
    };
  }

  /**
   * 注入 system prompt 的自我状态块。让 Noe 的回应基于"连续演化的我"而非每轮冷启动。
   * @returns {string} <noe-self-state> 块（身份恒在，状态/处境有内容才列）
   */
  buildSelfStateBlock(snap) {
    const s = snap || this.snapshot();
    const lines = [`- 我是谁：${s.identity.name}，${s.identity.relationship}`];
    // 叙事自我（支柱⑤）：读最近一次压缩出的自我叙事；未注入/缺失/抛错/空 → 行不出现（fail-open，与现状逐字一致）。
    if (this.narrativeSelf) {
      try {
        const story = this.narrativeSelf.current();
        const text = typeof story?.narrative === 'string' ? story.narrative.trim() : '';
        if (text) lines.push(`- 我的故事：${text}`);
      } catch { /* 叙事读取失败不破坏自我状态块 */ }
    }
    // 性格快照（意识工程·阶段2）：从自己行为里长出的观察；未注入/缺失/抛错/空 → 行不出现（fail-open）。
    if (this.personalitySnapshot) {
      try {
        const snap2 = this.personalitySnapshot.current();
        const text = typeof snap2?.personality === 'string' ? snap2.personality.trim() : '';
        if (text) lines.push(`- 我的性格（从我自己近来的行为里看出来的，不是设定）：${text}`);
      } catch { /* 性格读取失败不破坏自我状态块 */ }
    }
    if (s.state.mood) lines.push(`- 心境：${s.state.mood}`);
    // 自知之明（M11）：被现实结算出来的预测准头——"我以为的我"接受"实际的我"的修正。fail-open。
    if (this.calibrationNote) {
      try {
        const note = String(this.calibrationNote() || '').trim();
        if (note) lines.push(`- 自知之明：${note}`);
      } catch { /* 校准读取失败不破坏自我状态块 */ }
    }
    // 内稳态驱力（意识工程·阶段1）：驱力强烈才有这行（brief 自带克制阈值）；未注入/抛错/弱 → 行不出现（fail-open）。
    if (this.driveSystem) {
      try {
        const driveLine = this.driveSystem.brief();
        if (driveLine) lines.push(`- 内在驱力：${driveLine}`);
      } catch { /* 驱力读取失败不破坏自我状态块 */ }
    }
    if (s.state.commitments.length) {
      lines.push(`- 牵挂着：${s.state.commitments.map((c, i) => `${i + 1}.${c}`).join('；')}`);
    }
    const sit = [];
    if (s.situation.sinceLastInteraction) sit.push(`距上次和 owner 说话 ${s.situation.sinceLastInteraction}`);
    if (s.situation.ownerPresent === true) sit.push('owner 此刻在');
    else if (s.situation.ownerPresent === false) sit.push('owner 此刻不在');
    if (sit.length) lines.push(`- 此刻：${sit.join('，')}`);
    return [
      '<noe-self-state>',
      '我此刻的状态（不是设定，是我连续演化到现在的样子；回应时带着这个"我"，别每次重新认识自己）：',
      ...lines,
      '</noe-self-state>',
    ].join('\n');
  }

  /**
   * 稳定 persona 文本（persona-pin）：跨轮稳定的人设层，供装配点（server.js）挂进 system prompt 的
   * persona-pin 段——P7 换路线下「persona 挂 system prompt 而非 LoRA」的内容产出口。两部分拼成：
   *   ① P7 自我人设（稳定层）：性情基底 + 性格观察 + 自我叙事（仍只取稳定层、剔快变句，见 buildPersonaPin）；
   *   ② P8 owner 偏好下沉（注入 personaPins 且 NOE_MEMORY_PERSONA_PIN=1 时）：记忆库里的稳定 owner
   *      偏好句（语言/格式/工作方式…）——这些每轮都该在场、内容不变，下沉到此后 retriever 不再召回它们，
   *      释放召回名额给 insight/lesson。OFF / 未注入 → 只剩 ① ，行为与现状逐字一致。
   * 均不含 mood/牵挂/处境等快变层。
   *
   * 主线装配（已装，勿改 server.js）：`personaPinProvider = () => selfModel.buildPersonaPin()`（'' 时不注入）。
   * @param {{maxSentences?: number}} [opts] 仅约束 ① P7 自我人设句数；② owner 偏好行数由 NoePersonaPins.maxPins 管。
   * @returns {string} persona 文本（① + ②，各自非空才出现）；全空返回 ''。
   */
  buildPersonaPin({ maxSentences = PERSONA_PIN_MAX_SENTENCES } = {}) {
    let personality = '';
    if (this.personalitySnapshot) {
      try {
        const snap = this.personalitySnapshot.current();
        personality = typeof snap?.personality === 'string' ? snap.personality.trim() : '';
      } catch { personality = ''; }
    }
    let narrative = '';
    if (this.narrativeSelf) {
      try {
        const story = this.narrativeSelf.current();
        narrative = typeof story?.narrative === 'string' ? story.narrative.trim() : '';
      } catch { narrative = ''; }
    }
    // ① P7 自我人设（稳定层）。
    const selfPersona = buildPersonaPin(
      { disposition: this.identity?.disposition || '', personality, narrative, name: this.identity?.name || '' },
      { maxSentences },
    );
    // ② P8 owner 偏好下沉（注入才有；flag 由装配点的 NoeTurnContextEngine persona-pin 段统一把关 OFF 时不注入，
    //    这里只负责「有就拼」，不重复读 flag——保持 buildPersonaPin 纯产出、flag 单点）。fail-open。
    let ownerPrefs = '';
    if (this.personaPins) {
      try { ownerPrefs = String(this.personaPins.buildOwnerPreferenceLines() || '').trim(); }
      catch { ownerPrefs = ''; } // owner 偏好取行失败不破坏 P7 自我人设
    }
    const parts = [selfPersona, ownerPrefs].map((p) => String(p || '').trim()).filter(Boolean);
    return parts.join('\n');
  }
}

export const defaultNoeSelfModel = new NoeSelfModel();
