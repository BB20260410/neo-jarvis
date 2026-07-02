// @ts-check
// NoeNightlyReflection — 夜间反思（意识工程·阶段2，2026-06-11）。
//
// 缺口：梦境整合只做记忆库整理（去重/升降级），不产新知。睡眠巩固的另一半是"反思"——
// 把当日经历蒸馏成教训(lesson)/模式(pattern)/信念(belief)，写成带 confidence 的 insight
// 记忆；并复核既有 insight：被今日经历印证的升 confidence、被动摇的降。这是元认知的最小
// 闭环——它对自己认知的把握度，随证据演化，而非一锤定音。
//
// 形态（照 NoeNarrativeSelf 官方模板）：refresh() 异步 + 新鲜度守卫（默认 20h，日更级）+
// 并发守卫 + circadian 相位守卫（注入 phaseOf 时只在 night 真跑，贴合"睡眠巩固"语义；
// 未注入不受限）+ 水位线持久化（atomicJsonFile，反思过的经历不重复消化）。
// 大脑默认走 LM Studio 主脑 Qwen 35B A3B 6bit，不烧付费配额，不设超时（跑模型纪律）。
// 一切失败 fail-open：返回原因，绝不向上抛。
//
// env 门控（NOE_NIGHTLY_REFLECTION=1 默认 OFF）在装配点（server.js），本模块不读门控 env。

import { NOE_MAIN_BRAIN_MODEL, normalizeNoeAutoModel, resolveNoeOutputBudget } from '../model/NoeLocalModelPolicy.js';
import { parseNoeLlmJsonValue } from '../runtime/NoeLlmJsonExtractor.js';
import { atomicWriteJson, readJsonWithCorruptBackup } from '../state/atomicJsonFile.js';

const KINDS = new Set(['lesson', 'pattern', 'belief']);
const MAX_INSIGHT = 200;
const MIN_EPISODES = 5;
const DEFAULT_REFLECTION_MODEL = NOE_MAIN_BRAIN_MODEL;

const REFLECT_SYSTEM = '你是在夜里复盘自己一天经历的 AI。基于经历素材，蒸馏出 1-3 条真正有信息量的洞察，'
  + '并复核「我过去的认知」里哪些被今天的经历印证或动摇。'
  + '只输出 JSON（不要 markdown 围栏、不要解释）：'
  + '{"new":[{"text":"洞察正文（第一人称，≤60字）","kind":"lesson|pattern|belief","confidence":0.3-0.9}],'
  + '"reviews":[{"id":"既有认知的id","verdict":"confirmed|shaken|neutral"}]}。'
  + 'kind 含义：lesson=该改的做法教训；pattern=发现的规律（主人习惯/我自己的行为模式）；belief=对世界/关系的认知更新。'
  + '没有值得记的洞察就输出 {"new":[],"reviews":[]}。不编造、不抒情、不凑数。';

function normalizeAutoReflectionModel(model) {
  return normalizeNoeAutoModel(model);
}

/**
 * 提取文本中第一个括号平衡的 {...} 段（审查建议 B：indexOf+lastIndexOf 在
 * "JSON 后还有含 {} 的废话"时会把两段连着抓成坏 JSON——括号计数不会）。
 * @param {string} text
 * @returns {string|null}
 */
export function extractFirstJson(text) {
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;            // 跳过转义对（\" \\ 等）
      else if (ch === '"') inString = false;
      continue;                            // 字符串内的 {} 不参与计数（insight 文本里出现花括号不破坏解析）
    }
    if (ch === '"' && depth > 0) inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 从模型输出提取 JSON；解析失败返回 null（fail-open）。
 * @param {unknown} reply
 * @returns {{new?: Array<object>, reviews?: Array<object>}|null}
 */
export function parseReflection(reply) {
  const parsed = parseNoeLlmJsonValue(reply, null);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

/** confidence 收进 [0.05, 0.95]（永不绝对确定/绝对否定——给后续证据留余地）。 */
export function clampConfidence(n, fallback = 0.5) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0.05, Math.min(0.95, v));
}

/**
 * 复核裁决 → confidence 调整（对称 ±0.1 / 其他不动）。
 * 终审 P0-1：原 shaken -0.2 非对称——交替印证/动摇时期望净变化 -0.05/轮，模拟 50 轮均值
 * 跌到 0.21（而非中性 0.5），所有认知系统性漂移到"几乎不确信"。对称步长才能让
 * confidence 真实反映证据平衡。
 */
export function adjustConfidence(current, verdict) {
  const c = clampConfidence(current);
  if (verdict === 'confirmed') return clampConfidence(c + 0.1);
  if (verdict === 'shaken') return clampConfidence(c - 0.1);
  return c;
}

/**
 * 复核回写：confirmed/shaken 按裁决调 confidence（显式 id upsert，全字段原样回写）。
 * 从 reflectOnce 提出便于独立单测（终审 P2）。
 * @param {{priors: Array<any>, reviews: unknown, memory: any, projectId: string}} args
 * @returns {number} 实际回写条数
 */
export function applyVerdicts({ priors, reviews, memory, projectId }) {
  const verdictById = new Map(
    (Array.isArray(reviews) ? reviews : [])
      .filter((r) => r && typeof r.id === 'string')
      .map((r) => [r.id, String(r.verdict || 'neutral')]),
  );
  let reviewed = 0;
  for (const p of priors) {
    const verdict = verdictById.get(p.id);
    if (!verdict || verdict === 'neutral') continue;
    const next = adjustConfidence(p.confidence, verdict);
    if (next === clampConfidence(p.confidence)) continue;
    try {
      memory.write({
        id: p.id,
        projectId,
        scope: p.scope || 'insight',
        title: p.title,
        body: p.body,
        tags: p.tags,
        salience: p.salience,
        sourceType: 'nightly_reflection',
        confidence: next,
        // 审查修复：显式 id upsert 会用 excluded.* 覆写全行——不透传这四项会被静默清零
        // （有 TTL 的 insight 复核一次就变永久记忆）。原样回写保住原值。
        ttlMs: /** @type {any} */ (p).ttlMs ?? null,
        expiresAt: /** @type {any} */ (p).expiresAt ?? null,
        sourceId: /** @type {any} */ (p).sourceId ?? null,
        mergeTrace: /** @type {any} */ (p).mergeTrace ?? [],
      });
      reviewed += 1;
    } catch { /* 单条回写失败不阻断 */ }
  }
  return reviewed;
}

export function createNightlyReflection({
  timeline = null,           // EpisodicTimeline：当日经历素材
  memory = null,             // MemoryCore：insight 读写
  writeGate = null,          // NoeMemoryWriteGate：新 insight 候选门禁/证据链接
  getAdapter,
  brainAdapterId = 'lmstudio',
  // 反思=自动认知路径 → 默认主脑 Qwen；NOE_REFLECTION_MODEL 可显式覆盖
  model = process.env.NOE_REFLECTION_MODEL ?? process.env.NOE_FACT_MODEL ?? DEFAULT_REFLECTION_MODEL,
  stateFile = null,          // 水位线持久化（null → 仅进程内存，测试用）
  minIntervalMs = 20 * 3600000,
  phaseOf = null,            // circadian.phaseOf（注入才生效）：'night' 相位才真跑；null 不受限
  // 盐度累计触发（长期规划 M4，生成式智能体范式：重要事件攒够就反思，不死等夜里）：
  // 自上次反思以来高盐(≥4)非念头情景的盐度累计 ≥ 阈值 → 绕过夜相与 20h 守卫提前反思。
  // 0 = 关闭（默认，行为与原版逐字一致）；旁路自带 4h 硬下限防刷。
  salienceThreshold = 0,
  salienceBypassMinMs = 4 * 3600000,
  projectId = 'noe',
  episodeLimit = 80,
  reviewLimit = 8,
  now = Date.now,
} = {}) {
  /** @type {{lastRunAt: number}} */
  let state = { lastRunAt: 0 };
  if (stateFile) {
    try {
      const j = readJsonWithCorruptBackup(stateFile, { label: 'noe-nightly-reflection' });
      const at = Number(j?.lastRunAt);
      if (Number.isFinite(at) && at > 0) state = { lastRunAt: at };
    } catch { /* fail-open：读失败当从未跑过 */ }
  }
  /** @type {Promise<object>|null} */
  let inFlight = null;
  model = normalizeAutoReflectionModel(model);

  function persist() {
    if (!stateFile) return;
    try { atomicWriteJson(stateFile, { version: 1, lastRunAt: state.lastRunAt }); } catch { /* 丢一次水位可接受 */ }
  }

  async function reflectOnce(force) {
    const t = now();
    // 盐度旁路（M4）：白天攒够了值得反思的大事（高盐情景盐度累计 ≥ 阈值）→ 提前反思一轮
    let salienceBypass = false;
    if (!force && salienceThreshold > 0 && timeline?.recent && (!state.lastRunAt || t - state.lastRunAt >= salienceBypassMinMs)) {
      try {
        // ≥3：实测 24h 真实分布里"有意义经历"几乎全是默认盐度 3（≥4 过滤会让旁路永远死火）
        const eps = timeline.recent({ sinceTs: (state.lastRunAt || t - 24 * 3600000) + 1, limit: 100 }) || [];
        const acc = eps.filter((e) => e.type !== 'inner_monologue' && Number(e.salience) >= 3)
          .reduce((s, e) => s + Number(e.salience), 0);
        salienceBypass = acc >= salienceThreshold;
      } catch { salienceBypass = false; }
    }
    if (!force && !salienceBypass && state.lastRunAt && t - state.lastRunAt < minIntervalMs) return { reflected: false, reason: 'fresh' };
    if (!force && !salienceBypass && typeof phaseOf === 'function') {
      let phase = null;
      try { phase = phaseOf(t); } catch { phase = null; }
      if (phase && phase !== 'night') return { reflected: false, reason: 'not_night' };
    }
    if (!timeline?.recent || !memory?.write) return { reflected: false, reason: 'not_wired' };

    // 素材 = 水位线以来（首次取近 24h）的经历；太少不硬挤
    const sinceTs = state.lastRunAt || t - 24 * 3600000;
    let episodes = [];
    try {
      episodes = timeline.recent({ sinceTs, limit: episodeLimit }) || [];
    } catch { episodes = []; }
    if (episodes.length < MIN_EPISODES) return { reflected: false, reason: 'too_few_episodes', count: episodes.length };

    // 既有 insight（给大脑复核：哪些被今天印证/动摇）
    /** @type {Array<{id:string, body:string, confidence:number, tags:string[], scope:string, salience:number, title:string}>} */
    let priors = [];
    try {
      priors = (memory.recall({ q: '', scope: 'insight', projectId, limit: reviewLimit, bumpHits: false }) || []);
    } catch { priors = []; }

    let adapter = null;
    try { adapter = getAdapter?.(brainAdapterId); } catch { adapter = null; }
    if (!adapter?.chat) return { reflected: false, reason: 'no_brain' };

    const lines = episodes
      .map((e) => `- [${e.type || 'interaction'}] ${String(e.summary || '').slice(0, 160)}`)
      .join('\n');
    const priorBlock = priors.length
      ? `\n\n【我过去的认知（复核它们）】\n${priors.map((p) => `- id=${p.id} (把握度${Math.round(clampConfidence(p.confidence) * 100)}%) ${String(p.body || '').slice(0, 120)}`).join('\n')}`
      : '';
    const userContent = `【我今天的经历（最近在前）】\n${lines}${priorBlock}`;

    let parsed = null;
    try {
      const budget = resolveNoeOutputBudget('memory_write_candidate');
      const r = await adapter.chat(
        [{ role: 'system', content: REFLECT_SYSTEM }, { role: 'user', content: userContent }],
        // 不设超时（跑模型纪律）
        { budgetContext: { projectId, taskId: 'noe-nightly-reflection' }, think: false, temperature: 0, top_p: 1, maxTokens: budget.max_tokens, ...(model ? { model } : {}) },
      );
      if (r?.incomplete) return { reflected: false, reason: 'brain_incomplete', finishReason: r.finishReason || 'length' };
      parsed = parseReflection(r?.reply);
    } catch (e) {
      return { reflected: false, reason: 'brain_error', error: /** @type {any} */ (e)?.message };
    }
    if (!parsed) return { reflected: false, reason: 'unparseable' };

    // 写新 insight（≤3 条，字段全校验）
    let written = 0;
    const newInsights = []; // M9：带出洞察文本（次日晨间意识流的种子，server 反思回调缓存）
    const evidenceRefs = episodes.slice(0, 8).map((e) => e?.id ? `episode:${e.id}` : '').filter(Boolean);
    const sourceEpisodeId = episodes.find((e) => e?.id)?.id ? String(episodes.find((e) => e?.id).id).slice(0, 240) : null;
    for (const item of (Array.isArray(parsed.new) ? parsed.new : []).slice(0, 3)) {
      const text = String(item?.text || '').trim().slice(0, MAX_INSIGHT);
      if (text.length < 6) continue;
      const kind = KINDS.has(String(item?.kind)) ? String(item.kind) : 'pattern';
      try {
        const payload = {
          kind: 'insight',
          projectId,
          scope: 'insight',
          body: text,
          confidence: clampConfidence(item?.confidence),
          tags: ['insight', kind, 'nightly'],
          sourceType: 'nightly_reflection',
          salience: 3,
          sourceEpisodeId,
          evidenceRefs,
        };
        const r = writeGate?.commit ? writeGate.commit(payload) : { ok: true, memory: memory.write(payload) };
        if (r?.ok !== false) {
          written += 1;
          newInsights.push(text);
        }
      } catch { /* 单条写失败不阻断其余 */ }
    }

    const reviewed = applyVerdicts({ priors, reviews: parsed.reviews, memory, projectId });

    state = { lastRunAt: t };
    persist();
    return { reflected: true, written, reviewed, episodes: episodes.length, newInsights };
  }

  return {
    /** 异步反思一次（并发守卫共享同一次）。永不 reject。@param {{force?: boolean}} [opts] */
    refresh({ force = false } = {}) {
      if (inFlight) return inFlight;
      inFlight = reflectOnce(force === true).finally(() => { inFlight = null; });
      return inFlight;
    },
    /** 上次成功反思时间（0=从未）。 */
    lastRunAt() { return state.lastRunAt; },
  };
}
