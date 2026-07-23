// @ts-check
// NoeThoughtLoopGuard — 意识流去回环守卫（借鉴 lealoth/Sibelium-cognitive-architecture 的 FlowStream 理念）。
//
// 借鉴来源（调研报告 docs/RESEARCH_2026-06-14_Neo增强开源调研.md §lealoth/Sibelium）：
//   1) 「Ebbinghaus 突触强度」理念：Sibelium FlowStream 的 ThoughtItem 叠了
//      S(t)=S_base·e^(-t/tau)，且 tau 随 access_count 增大（被反复访问/复习的念头活得更久）。
//      → 这里用 computeSynapticStrength 纯函数复现该衰减公式：强度随「距上次访问的时间间隔」指数衰减，
//        tau = tauBaseMs·(1 + k·accessCount) 让高频复习的主题强度更耐久。
//   2) 「主题回环侦测」理念：Sibelium 用「≥2 共享关键词出现在 ≥5 条近期念头里」判定意识流在打转。
//      → 这里用 extractKeywords + detectTopicLoop 纯函数复现：在最近 N 条念头里统计关键词出现的「念头条数」，
//        命中阈值条数（默认 5）的关键词若达到阈值个数（默认 2），即判定意识流回环（复读/反刍打转）。
//
// 与 Neo 既有模块的边界（诚实增量，避免重复造轮子）：
//   - RuminationGuard.js：做的是「候选念头 vs 上一条 self_talk 的语义相似度 + grounding/抽象密度」的单步阻断，
//     不做「跨多条念头的关键词反复出现统计」，也不做「带 access 间隔的突触强度衰减」。本模块补这两块。
//   - NoeMemoryDedup.js：normalizeForDedup（CJK/字符归一化）直接复用，关键词抽取在其之上做，不另起一套归一化。
//   - NoeAffectEngine.js：有指数半衰（tauEmotion/tauMood），但针对 VAD 情绪，不针对「念头突触强度」。
//
// 纯函数 + 注入式：输入「近期念头数组（{ text, ts, accessCount? }）」+ now，输出「是否回环 + 共享关键词 + 建议换角度」。
// 不读 SQLite、不调模型、不读时钟（now 注入）；任何异常 fail-open（返回 looped:false，绝不阻断意识流）。
//
// 行为变化（是否要据此干预意识流）由 env 门控、默认 OFF（项目最有效防伤害模式）：
//   readThoughtLoopGuardEnv() 读 NOE_THOUGHT_LOOP_GUARD（缺省/非 '1'/'true'/'on' 一律 OFF）。
//   OFF 时调用方仍可拿到 analyzeThoughtLoop 的诊断结果（纯计算无副作用），但 enabled:false → 不应据此改变行为。

import { normalizeForDedup } from '../memory/NoeMemoryDedup.js';

/** 默认参数（与 Sibelium 报告口径对齐：≥2 关键词在 ≥5 条近期念头反复出现判回环）。 */
export const DEFAULT_LOOP_PARAMS = Object.freeze({
  windowSize: 12,          // 只看最近多少条念头（近期窗口；Sibelium active 集量级）
  loopThreshold: 5,        // 「同一关键词出现在 ≥N 条念头」算反复（报告口径 5）
  minSharedKeywords: 2,    // 「≥M 个这样的关键词」才判回环（报告口径 2）
  minKeywordLen: 2,        // 关键词最短长度（过滤单字噪声）
  maxKeywordsPerThought: 12, // 每条念头最多取多少关键词（防超长念头刷屏）
});

/** Ebbinghaus 突触强度默认时标（仅 computeSynapticStrength 用；与念头衰减相关）。 */
export const DEFAULT_SYNAPSE_PARAMS = Object.freeze({
  sBase: 1,                // S_base：初始/刚访问时的强度
  tauBaseMs: 30 * 60_000,  // 基础时标 30min：单次未复习的念头半程衰减时标
  accessTauGain: 0.5,      // tau 随 accessCount 线性增益系数 k：tau = tauBaseMs·(1 + k·accessCount)
});

/** 极小停用词集：高频但无主题区分度的虚词（中英）；只为降误判，刻意保持小而保守。 */
const STOPWORDS = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '们', '这', '那', '和', '与', '在', '吗', '吧', '呢', '啊',
  '就', '都', '也', '还', '又', '吧', '把', '被', '让', '给', '到', '从', '为', '对', '不', '没', '有', '会', '要',
  'the', 'a', 'an', 'is', 'am', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on', 'and', 'or', 'i', 'you',
  'it', 'this', 'that', 'so', 'do', 'does', 'not', 'no', 'me', 'my', 'we', 'he', 'she', 'they',
]);

/** env 门控：默认 OFF。返回 { enabled }。 */
export function readThoughtLoopGuardEnv(env = process.env) {
  const raw = String(env?.NOE_THOUGHT_LOOP_GUARD ?? '').trim().toLowerCase();
  return Object.freeze({ enabled: raw === '1' || raw === 'true' || raw === 'on' });
}

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Ebbinghaus 突触强度（借鉴 Sibelium FlowStream S(t)=S_base·e^(-t/tau)，tau 随 access_count 增大）。
 * 纯函数：强度随「距上次访问的间隔」指数衰减；被反复复习（accessCount 高）的念头 tau 更大、衰减更慢、活得更久。
 * @param {object} a
 * @param {number} a.lastAccessTs 上次访问该念头的时间戳（ms）
 * @param {number} a.now 当前时间戳（ms，注入）
 * @param {number} [a.accessCount] 累计访问/复习次数（默认 0）
 * @param {object} [params] 见 DEFAULT_SYNAPSE_PARAMS
 * @returns {number} 0..sBase 的强度；异常/未来时间钳为 sBase（fail-open，不误判为遗忘）
 */
export function computeSynapticStrength({ lastAccessTs, now, accessCount = 0 } = {}, params = DEFAULT_SYNAPSE_PARAMS) {
  const p = { ...DEFAULT_SYNAPSE_PARAMS, ...(params || {}) };
  const t = finiteOr(now, NaN);
  const last = finiteOr(lastAccessTs, NaN);
  if (!Number.isFinite(t) || !Number.isFinite(last)) return p.sBase;
  const dt = t - last;
  if (dt <= 0) return p.sBase; // 刚访问/未来时间：满强度
  const ac = Math.max(0, finiteOr(accessCount, 0));
  const tau = Math.max(1, p.tauBaseMs * (1 + p.accessTauGain * ac));
  const s = p.sBase * Math.exp(-dt / tau);
  return Math.max(0, Math.min(p.sBase, s));
}

/**
 * 从一条念头文本抽关键词。
 * 关键修正（原实现 bug）：先按「原文的空白/标点边界」切 token，再对每个 token 归一化抽词；
 * 不能像旧版那样先 normalizeForDedup（它会删空白把整句拼成一长串），否则 latin 词会被粘成一个词
 * （"thinking about consciousness" → "thinkingaboutconsciousness"），且空格分隔的单字虚词
 * （"我 的 是 了"）会被跨边界拼成 bigram（我的/的是/是了）漏过停用词过滤。normalizeForDedup 仍复用，
 * 但只用于「逐 token 归一化」而非「整句拼接」。
 * 每个 token 内：连续 latin/数字 串当一个词；连续中文按字符 bigram 切（中文无空格分词，bigram 是本仓
 * 既有轻量近似——textSimilarity 也用 bigram）。过滤停用词与过短词，去重。纯函数。
 * @param {string} text
 * @param {object} [opts]
 * @returns {string[]} 去重后的关键词
 */
export function extractKeywords(text, { minKeywordLen = DEFAULT_LOOP_PARAMS.minKeywordLen, maxKeywords = DEFAULT_LOOP_PARAMS.maxKeywordsPerThought } = {}) {
  const raw = String(text || '');
  if (!raw) return [];
  const out = new Set();
  const isLatin = (ch) => /[0-9a-z]/.test(ch);
  // 按原文非「中文/字母/数字」字符（空白、标点）切 token，保住词边界；每个 token 再归一化小写。
  const rawTokens = raw.split(/[^0-9A-Za-z０-９\p{Script=Han}]+/u);
  for (const rawTok of rawTokens) {
    const tok = normalizeForDedup(rawTok); // 仅留中文/字母/数字，小写（此处 token 内部本已无空白）
    if (!tok) continue;
    // 逐字符扫描该 token：把 latin/数字 串聚成词，中文段按 bigram 切。
    let buf = '';
    const flushLatin = () => {
      if (buf.length >= minKeywordLen && !STOPWORDS.has(buf)) out.add(buf);
      buf = '';
    };
    let prevHan = '';
    for (const ch of tok) {
      if (isLatin(ch)) {
        if (prevHan) prevHan = '';
        buf += ch;
      } else {
        // 中文字符
        flushLatin();
        if (prevHan) {
          const gram = prevHan + ch; // bigram
          // 两字皆停用词的 bigram 无主题区分度（如 的是/是了），过滤——与「过滤虚词」的初衷一致。
          if (!STOPWORDS.has(gram) && !(STOPWORDS.has(prevHan) && STOPWORDS.has(ch))) out.add(gram);
        } else if (minKeywordLen <= 1 && !STOPWORDS.has(ch)) {
          out.add(ch);
        }
        prevHan = ch;
      }
      if (out.size >= maxKeywords) break;
    }
    flushLatin();
    if (out.size >= maxKeywords) break;
  }
  return [...out].slice(0, maxKeywords);
}

/**
 * 主题回环侦测（借鉴 Sibelium：≥minSharedKeywords 个关键词各自出现在 ≥loopThreshold 条近期念头里 → 打转）。
 * 关键：统计的是「关键词出现在多少 *条* 念头」（doc-frequency），不是总词频——同一条念头里重复不加分，
 * 这样才对应「在多条念头里反复出现」的回环语义。纯函数，不读时钟。
 * @param {Array<{text?: string}>} recentThoughts 近期念头（最近在前或在后都可，只看集合）
 * @param {object} [params] 见 DEFAULT_LOOP_PARAMS
 * @returns {{ looped: boolean, sharedKeywords: Array<{keyword: string, count: number}>, consideredCount: number }}
 */
export function detectTopicLoop(recentThoughts = [], params = DEFAULT_LOOP_PARAMS) {
  const p = { ...DEFAULT_LOOP_PARAMS, ...(params || {}) };
  const list = Array.isArray(recentThoughts) ? recentThoughts : [];
  const window = list.slice(0, Math.max(1, p.windowSize));
  // keyword -> 出现该关键词的念头条数
  const docFreq = new Map();
  for (const th of window) {
    const text = typeof th === 'string' ? th : th?.text;
    let kws;
    try {
      kws = extractKeywords(text, { minKeywordLen: p.minKeywordLen, maxKeywords: p.maxKeywordsPerThought });
    } catch {
      kws = []; // 单条抽词失败不拖垮整体（fail-open）
    }
    for (const kw of new Set(kws)) { // 念头内去重：同一条里出现多次只算一条
      docFreq.set(kw, (docFreq.get(kw) || 0) + 1);
    }
  }
  const sharedKeywords = [...docFreq.entries()]
    .filter(([, count]) => count >= p.loopThreshold)
    .map(([keyword, count]) => ({ keyword, count }))
    .sort((x, y) => y.count - x.count || (x.keyword < y.keyword ? -1 : 1));
  return {
    looped: sharedKeywords.length >= p.minSharedKeywords,
    sharedKeywords,
    consideredCount: window.length,
  };
}

/** 根据回环的共享关键词，生成「换角度」建议文案（纯函数，确定性，便于测试）。 */
export function buildPivotSuggestion(sharedKeywords = []) {
  const words = (Array.isArray(sharedKeywords) ? sharedKeywords : [])
    .map((k) => (typeof k === 'string' ? k : k?.keyword))
    .filter(Boolean)
    .slice(0, 3);
  if (!words.length) return null;
  // 借鉴 Sibelium「侦测到回环就主动换探索方向」：给出可执行的换角度提示，而非空泛"别想了"。
  return `意识流在「${words.join('、')}」上反复打转，建议换个角度：要么落到一件具体可做的小事上，要么主动引入一个不相关的新线索。`;
}

/**
 * 顶层编排：分析近期念头是否陷入回环，并（可选）给出换角度建议。纯函数 + 注入式。
 * @param {object} input
 * @param {Array<{text?: string, ts?: number, accessCount?: number}>} input.recentThoughts 近期念头（最近在前）
 * @param {number} [input.now] 当前时间戳（注入；仅用于最新念头的突触强度参考，不影响回环判定）
 * @param {object} [input.loopParams] 覆盖 DEFAULT_LOOP_PARAMS
 * @param {object} [input.synapseParams] 覆盖 DEFAULT_SYNAPSE_PARAMS
 * @param {{enabled: boolean}} [input.gate] env 门控结果（默认读 NOE_THOUGHT_LOOP_GUARD）
 * @returns {{
 *   enabled: boolean,
 *   looped: boolean,
 *   sharedKeywords: Array<{keyword: string, count: number}>,
 *   suggestion: string|null,
 *   latestStrength: number|null,
 *   consideredCount: number,
 *   reasons: string[],
 * }}
 */
export function analyzeThoughtLoop({
  recentThoughts = [],
  now,
  loopParams = DEFAULT_LOOP_PARAMS,
  synapseParams = DEFAULT_SYNAPSE_PARAMS,
  gate = undefined,
} = {}) {
  const g = gate || readThoughtLoopGuardEnv();
  const enabled = !!g?.enabled;

  let loop;
  try {
    loop = detectTopicLoop(recentThoughts, loopParams);
  } catch {
    // fail-open：分析炸了绝不阻断意识流
    return Object.freeze({
      enabled,
      looped: false,
      sharedKeywords: Object.freeze([]),
      suggestion: null,
      latestStrength: null,
      consideredCount: 0,
      reasons: Object.freeze(['analyze_error']),
    });
  }

  // 最新念头的 Ebbinghaus 突触强度（参考信号：强度越低说明这条念头本身已在淡出，
  // 调用方可据此决定回环时是「换角度」还是「干脆让它衰减掉」）。仅当 now 与 ts 可用时计算。
  let latestStrength = null;
  const latest = Array.isArray(recentThoughts) ? recentThoughts[0] : null;
  if (latest && Number.isFinite(Number(latest.ts)) && Number.isFinite(Number(now))) {
    latestStrength = computeSynapticStrength(
      { lastAccessTs: Number(latest.ts), now: Number(now), accessCount: Number(latest.accessCount) || 0 },
      synapseParams,
    );
  }

  const reasons = [];
  if (loop.looped) {
    reasons.push(`shared_keywords:${loop.sharedKeywords.length}`);
    reasons.push(`loop_threshold:${(loopParams || DEFAULT_LOOP_PARAMS).loopThreshold ?? DEFAULT_LOOP_PARAMS.loopThreshold}`);
  }

  return Object.freeze({
    enabled,
    looped: loop.looped,
    sharedKeywords: Object.freeze(loop.sharedKeywords),
    suggestion: loop.looped ? buildPivotSuggestion(loop.sharedKeywords) : null,
    latestStrength,
    consideredCount: loop.consideredCount,
    reasons: Object.freeze(reasons),
  });
}