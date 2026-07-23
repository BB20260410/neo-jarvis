// @ts-check
// NoePersonalitySnapshot — 性格快照自举（意识工程·阶段2，2026-06-11）。
//
// 设计者写人设得到的是扮演，从自己的经历里长出来的才叫形成。本模块每周从 Noe 自己的
// 行为统计（说了多少话/想了多少事/承诺完成率/此刻驱力分布）让它写出 2-3 句对自己性格的
// 观察——「我注意到我是个……的存在」。这是 Hofstadter 怪圈的工程闭环：观测自己 → 更新
// 自我描述 → 描述影响行为 → 行为再被自己观测。
//
// 边界（与 NoeNarrativeSelf 同款克制）：产出是**只读注入块**（self-state 的「我的性格」
// 一行），绝不写回 DEFAULT_IDENTITY / MemoryCore identity scope——身份层（名字/与 owner
// 的关系）是基因，保持稳定；性格层从行为里长、随行为变。owner 已在意识工程委托中明示授权
// 这一层的演化（2026-06-11 /loop），但演化只发生在注入层，回滚=删 snapshot 文件。
//
// 形态（照 NoeNarrativeSelf 官方模板）：refresh() 异步 + 新鲜度守卫（默认 7 天，周更级）+
// 并发守卫 + atomicJsonFile 持久化 + current() 同步读。统计全部来自注入依赖的真实读数，
// fail-open：任一来源缺失/抛错 → 该项统计缺席，不阻断。
//
// env 门控（NOE_PERSONALITY_SNAPSHOT=1 默认 OFF）在装配点（server.js），本模块不读门控 env。

import { atomicWriteJson, readJsonWithCorruptBackup } from '../state/atomicJsonFile.js';
import { NOE_MAIN_BRAIN_MODEL, normalizeNoeAutoModel, resolveNoeOutputBudget } from '../model/NoeLocalModelPolicy.js';

const MAX_SNAPSHOT = 300;
const WEEK_MS = 7 * 24 * 3600000;

const PERSONALITY_SYSTEM = '下面是你（一个持续运行的 AI）过去一周自己的行为统计和此刻的内在状态。'
  + '像照镜子一样，从这些数字里观察自己，用第一人称写 2-3 句对自己性格的诚实观察——'
  + '「我注意到我……」。只基于数据可支撑的倾向（话多话少/想得多做得多/守不守承诺/最近在意什么），'
  + '不编造数据里没有的特质、不抒情、不自夸。直接输出正文（不超过 120 字），不要解释、不要 markdown。'
  + '数据太少看不出倾向就只回复 SILENT。';

/**
 * 清洗模型输出；无效（空/SILENT）返回 ''。
 * @param {unknown} reply
 * @returns {string}
 */
export function cleanPersonality(reply) {
  const text = String(reply || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim()
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/^["'「『“]+/, '')
    .replace(/["'」』”]+$/, '')
    .trim();
  if (!text || /^SILENT$/i.test(text)) return '';
  return text.slice(0, MAX_SNAPSHOT);
}

/**
 * 从注入依赖收集一周行为统计（每项独立 fail-open，缺哪项少哪行）。
 * 导出为纯逻辑便于单测。
 * @param {{timeline?: any, commitmentStore?: any, driveSystem?: any, now?: () => number, windowMs?: number}} deps
 * @returns {string[]} 中文统计行
 */
export function collectBehaviorStats({ timeline = null, commitmentStore = null, driveSystem = null, now = Date.now, windowMs = WEEK_MS } = {}) {
  const lines = [];
  const t = now();
  try {
    const events = timeline?.recent ? (timeline.recent({ sinceTs: t - windowMs, limit: 500 }) || []) : [];
    if (events.length) {
      /** @type {Record<string, number>} */
      const byType = {};
      for (const e of events) byType[e.type || 'other'] = (byType[e.type || 'other'] || 0) + 1;
      const part = [];
      if (byType.interaction) part.push(`和主人说了 ${byType.interaction} 次话`);
      if (byType.inner_monologue) part.push(`自己想了 ${byType.inner_monologue} 次事`);
      if (byType.observation) part.push(`观察到 ${byType.observation} 件新事`);
      if (byType.milestone) part.push(`完成 ${byType.milestone} 个里程碑`);
      if (part.length) lines.push(`这一周我${part.join('、')}。`);
      if (byType.inner_monologue && byType.interaction && byType.inner_monologue > byType.interaction * 2) {
        lines.push('我想的比说的多得多。');
      }
    }
  } catch { /* 时间线统计缺席 */ }
  try {
    if (commitmentStore?.list) {
      const open = (commitmentStore.list({ status: 'open' }) || []).length;
      const done = (commitmentStore.list({ status: 'resolved' }) || []).length;
      if (open + done > 0) lines.push(`答应主人的事：办完 ${done} 件，还挂着 ${open} 件。`);
    }
  } catch { /* 承诺统计缺席 */ }
  try {
    const snap = driveSystem?.snapshot?.();
    if (snap?.dominant) lines.push(`此刻我最强的内在驱力是「${snap.dominant.label}」（强度 ${Math.round(snap.dominant.value * 100)}%）。`);
  } catch { /* 驱力统计缺席 */ }
  return lines;
}

export function createPersonalitySnapshot({
  timeline = null,
  commitmentStore = null,
  driveSystem = null,
  getAdapter,
  // 性格观察是"自我叙述"性质 → 与叙事自我同档大脑（内心反刍通道，本地不烧配额）
  brainAdapterId = process.env.NOE_INNER_BRAIN || 'lmstudio',
  model = process.env.NOE_INNER_MODEL ?? NOE_MAIN_BRAIN_MODEL,
  stateFile = null,
  minIntervalMs = WEEK_MS,
  projectId = 'noe',
  now = Date.now,
} = {}) {
  model = normalizeNoeAutoModel(model, { allowEmpty: true });
  /** @type {{personality: string, atMs: number}|null} */
  let cache = null;
  if (stateFile) {
    try {
      const j = readJsonWithCorruptBackup(stateFile, { label: 'noe-personality-snapshot' });
      const text = typeof j?.personality === 'string' ? j.personality.trim().slice(0, MAX_SNAPSHOT) : '';
      const at = Number(j?.atMs);
      if (text && Number.isFinite(at) && at > 0) cache = { personality: text, atMs: at };
    } catch { /* fail-open：读失败当没存过 */ }
  }
  /** @type {Promise<object>|null} */
  let inFlight = null;

  function persist() {
    if (!stateFile || !cache) return;
    try { atomicWriteJson(stateFile, { version: 1, personality: cache.personality, atMs: cache.atMs }); } catch { /* 丢一次可接受 */ }
  }

  async function refreshOnce(force) {
    if (!force && cache && now() - cache.atMs < minIntervalMs) return { refreshed: false, reason: 'fresh' };

    const stats = collectBehaviorStats({ timeline, commitmentStore, driveSystem, now });
    if (stats.length < 2) return { refreshed: false, reason: 'too_few_stats', count: stats.length };

    let adapter = null;
    try { adapter = getAdapter?.(brainAdapterId); } catch { adapter = null; }
    if (!adapter?.chat) return { refreshed: false, reason: 'no_brain' };

    let personality = '';
    try {
      const budget = resolveNoeOutputBudget('normal_chat');
      const r = await adapter.chat(
        [
          { role: 'system', content: PERSONALITY_SYSTEM },
          { role: 'user', content: `【我这一周的行为统计】\n${stats.map((s) => `- ${s}`).join('\n')}${cache ? `\n\n【我上次对自己的观察（写出变化，别照抄）】\n${cache.personality}` : ''}` },
        ],
        // 不设超时（跑模型纪律）
        { budgetContext: { projectId, taskId: 'noe-personality-snapshot' }, think: false, maxTokens: budget.max_tokens, ...(model ? { model } : {}) },
      );
      if (r?.incomplete) return { refreshed: false, reason: 'brain_incomplete', finishReason: r.finishReason || 'length' };
      personality = cleanPersonality(r?.reply);
    } catch (e) {
      return { refreshed: false, reason: 'brain_error', error: /** @type {any} */ (e)?.message };
    }
    if (!personality) return { refreshed: false, reason: 'silent' };

    cache = { personality, atMs: now() };
    persist();
    return { refreshed: true, personality };
  }

  return {
    /** 异步刷新（并发守卫共享同一次）。永不 reject。@param {{force?: boolean}} [opts] */
    refresh({ force = false } = {}) {
      if (inFlight) return inFlight;
      inFlight = refreshOnce(force === true).finally(() => { inFlight = null; });
      return inFlight;
    },
    /** 同步读当前性格快照：{ personality, atMs } 或 null。旧快照不过期——下次成功刷新才替换。 */
    current() {
      return cache ? { ...cache } : null;
    },
  };
}
