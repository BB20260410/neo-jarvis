// @ts-check
// NoeMoodAnalyzer — mood 启发式 → 本地模型情感分析（内在世界·支柱④）。
//
// 问题：NoeSelfModel.inferMood 是规则启发式（数 interaction 条数/看 milestone 新鲜度），表达力有限。
// 本模块用本地模型（NOE_INNER_BRAIN/NOE_INNER_MODEL 同款大脑，纯本地不烧付费配额）从自传体时间线
// 读最近经历，评出一个 ≤10 字的「行为层心境」短语。
//
// 硬约束：NoeSelfModel.snapshot 是同步函数，绝不能让它等模型 → 异步后台算 + 缓存同步读：
//   - analyze()：异步跑模型刷新缓存（不设任何超时，跑模型纪律）；自带并发守卫（同一时刻只跑一次）。
//   - current()：同步读缓存，新鲜（ttlMs 内）返回 { mood, atMs }，过期/没跑过返回 null。
//   - createCachedMoodInferrer()：包成 moodInferrer 形状——缓存新鲜用模型结果；过期/为空时后台
//     fire-and-forget 触发刷新（绝不等），本轮立即回启发式兜底（fail-open）。
//     这也是 NOE_INNER_MONOLOGUE 未开时的独立工作机制：不加新 timer，靠 snapshot 读取侧惰性刷新。
//
// 克制（仿 InnerMonologue.INNER_SYSTEM）：输出限 ≤10 字短语；读不出特别心境只回 SILENT（不更新缓存，
// 旧缓存自然过期回启发式）；跑题长文/空回复判无效，绝不硬塞进自我状态。
// 诚实：这评的仍是「行为层心境」（从经历文本推断的连续质感），不声称是真情绪。
// env 门控（NOE_MOOD_MODEL=1）在装配点（server.js），本模块不读门控 env。

import { NOE_MAIN_BRAIN_MODEL, normalizeNoeAutoModel, resolveNoeOutputBudget } from '../model/NoeLocalModelPolicy.js';

const MOOD_SYSTEM = '回顾你最近的经历，用一个不超过 10 个字的中文短语描述你此刻的心境——'
  + '像「平稳，待命中」「有点惦记」这样自然的状态短语，是从经历里读出来的，不是表演情绪。'
  + '只回复这个短语本身，不要解释、不要引号、不要 markdown。'
  + '如果从经历里读不出什么特别的心境，只回复 SILENT。';

/**
 * 清洗模型输出成合法心境短语；无效（空/SILENT/跑题长文）返回 ''。
 * 跑题长文不截断硬塞——直接判无效，让调用方回启发式（宁可保守不可瞎说）。
 * @param {unknown} reply
 * @returns {string}
 */
export function cleanMood(reply) {
  const firstLine = String(reply || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim()
    .split('\n')[0]
    .trim()
    .replace(/^["'「『“]+/, '')
    .replace(/["'」』”。.!！]+$/, '')
    .trim();
  if (!firstLine || /SILENT/i.test(firstLine)) return '';
  if (firstLine.length > 20) return '';   // prompt 限 10 字，留 2 倍余量；再长视为跑题
  return firstLine;
}

/**
 * @param {object} opts
 * @param {{recent: (o?: object) => Array<{type:string,summary:string,salience:number,ts:number}>}|null} [opts.timeline]
 * @param {(id: string) => ({chat: Function}|null|undefined)} [opts.getAdapter]
 * @param {string} [opts.brainAdapterId]
 * @param {string} [opts.model]
 * @param {number} [opts.ttlMs] 缓存新鲜期（默认 20min，略大于反刍 timer 默认 15min，两次顺风车之间不掉缓存）
 * @param {() => number} [opts.now]
 * @param {string} [opts.projectId]
 * @param {number} [opts.recallLimit]
 */
export function createMoodAnalyzer({
  timeline = null,
  getAdapter,
  // 复用内心反刍同款本地大脑通道（NOE_INNER_BRAIN/NOE_INNER_MODEL，与 InnerMonologue 同形默认）
  brainAdapterId = process.env.NOE_INNER_BRAIN || 'lmstudio',
  model = process.env.NOE_INNER_MODEL ?? NOE_MAIN_BRAIN_MODEL,
  ttlMs = 20 * 60000,
  now = Date.now,
  projectId = 'noe',
  recallLimit = 12,
} = {}) {
  model = normalizeNoeAutoModel(model, { allowEmpty: true });
  /** @type {{mood: string, atMs: number}|null} */
  let cache = null;
  /** @type {Promise<object>|null} 并发守卫：顺风车+惰性刷新可能同时触发，只跑一次模型 */
  let inFlight = null;

  async function analyzeOnce() {
    let recent = [];
    try { recent = timeline?.recent ? timeline.recent({ limit: recallLimit }) : []; } catch { recent = []; }
    if (!Array.isArray(recent) || !recent.length) return { analyzed: false, reason: 'no_episodes' };

    let adapter = null;
    try { adapter = getAdapter?.(brainAdapterId); } catch { adapter = null; }
    if (!adapter?.chat) return { analyzed: false, reason: 'no_brain' };

    const stream = recent.slice(0, 8).map((e) => `- ${e.summary}`).join('\n');
    let mood = '';
    try {
      const budget = resolveNoeOutputBudget('mood');
      const r = await adapter.chat(
        [
          { role: 'system', content: MOOD_SYSTEM },
          { role: 'user', content: `我最近的经历（最近在前）：\n${stream}` },
        ],
        // 不设超时（跑模型纪律）；model 空串则用 adapter 默认（LM Studio 当前加载的）
        { budgetContext: { projectId, taskId: 'noe-mood-analyzer' }, think: false, maxTokens: budget.max_tokens, ...(model ? { model } : {}) },
      );
      if (r?.incomplete) return { analyzed: false, reason: 'brain_incomplete', finishReason: r.finishReason || 'length' };
      mood = cleanMood(r?.reply);
    } catch (e) {
      // fail-open：模型挂了不动旧缓存（旧缓存自然过期回启发式），不向上抛
      return { analyzed: false, reason: 'brain_error', error: /** @type {any} */ (e)?.message };
    }

    if (!mood) return { analyzed: false, reason: 'silent' };   // SILENT/无效输出：不更新缓存
    cache = { mood, atMs: now() };
    return { analyzed: true, mood };
  }

  return {
    /** 异步刷新心境缓存（并发守卫：进行中则共享同一次）。永不 reject（内部已 fail-open）。 */
    analyze() {
      if (inFlight) return inFlight;
      inFlight = analyzeOnce().finally(() => { inFlight = null; });
      return inFlight;
    },
    /** 同步读缓存：新鲜返回 { mood, atMs }，过期/没跑过返回 null（调用方据此回启发式）。 */
    current() {
      if (!cache) return null;
      if (now() - cache.atMs > ttlMs) return null;
      return { ...cache };
    },
  };
}

/**
 * 把 analyzer 包成 NoeSelfModel 的 moodInferrer 形状（同步函数，签名与 inferMood 一致含 circadian 透传）。
 * 缓存新鲜 → 用模型结果；过期/为空 → 后台 fire-and-forget 触发刷新（绝不等模型——snapshot 必须同步返回），
 * 本轮立即回 fallback 启发式；analyzer 任何异常都不影响回退（fail-open）。
 * @param {object} opts
 * @param {{current: () => ({mood:string,atMs:number}|null), analyze: () => Promise<object>}} opts.analyzer
 * @param {(recent?: Array<object>, now?: number, circadian?: object|null) => string} opts.fallback
 */
export function createCachedMoodInferrer({ analyzer, fallback }) {
  if (typeof fallback !== 'function') throw new Error('createCachedMoodInferrer: fallback(inferMood) required');
  return (recent = [], nowTs = Date.now(), circadian = null) => {
    try {
      const c = analyzer?.current?.();
      if (c?.mood) return c.mood;
      // 缓存过期/为空：后台触发刷新（这也是反刍 timer 未开时的独立刷新机制），本轮不等
      const p = analyzer?.analyze?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* fail-open：analyzer 坏了照常走启发式 */ }
    return fallback(recent, nowTs, circadian);
  };
}
