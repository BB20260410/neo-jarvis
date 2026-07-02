// @ts-check
// NoeNarrativeSelf — 叙事自我（内在世界·支柱⑤：只读注入块版，零人格漂移）。
//
// 问题：self-state 的身份层是静态设定（DEFAULT_IDENTITY），时间线 narrative() 是事件列表——
// 中间缺一层「把一路经历压成一句话的自我故事」：我是谁、我们正在经历什么。人对自己的连续感
// 不止来自记得每件事，更来自能把这些事讲成一个故事。
//
// 设计边界（零人格漂移，owner 未授权前的保守解）：叙事是**只读注入块**——只出现在
// <noe-self-state> 的「我的故事」一行（NoeSelfModel 注入），绝不写回 identity 层
// （DEFAULT_IDENTITY / MemoryCore scope 'identity'）。让叙事反哺 Noe 的自述身份是人格层变更，
// 连续累积会漂移，那是另一个需要 owner 明示授权的 feature。
//
// 形态（与 NoeMoodAnalyzer 同款「异步刷新 + 同步读」）：
//   - refresh()：异步取时间线全幅（recent 大 limit + aged 故事开端），用本地大脑压成 2-3 句
//     第一人称叙事（不设任何超时，跑模型纪律）；自带新鲜度守卫（默认 24h 内不重跑，force 可越过）
//     与并发守卫（同一时刻只跑一次）。模型挂/SILENT/输出无效 → 保留旧叙事（fail-open）。
//   - current()：同步读 { narrative, atMs } 或 null。叙事不设 TTL 失效——旧故事仍是故事，
//     直到下次成功刷新才被替换（与 mood 的"过期回启发式"不同：叙事没有启发式兜底，旧值即兜底）。
//   - 持久化：atomicJsonFile（~/.noe-panel/narrative-self.json，重启不丢）。选它不选 MemoryCore
//     显式 id upsert 的理由：①同形态先例（NoeEpisodeSublimation 水位线就是 atomicJsonFile）；
//     ②叙事是「单一最新值」状态而非可召回知识，写进 MemoryCore 会进入 FTS/语义召回与梦境整合/
//     GC 的动作面（中性 scope 不在 protectedScopes 保护带，可能被合并/降级/清理），徒增不确定性。
//
// env 门控（NOE_NARRATIVE_SELF=1 默认 OFF）在装配点（server.js），本模块不读门控 env。

import { atomicWriteJson, readJsonWithCorruptBackup } from '../state/atomicJsonFile.js';
import { NOE_MAIN_BRAIN_MODEL, normalizeNoeAutoModel, resolveNoeOutputBudget } from '../model/NoeLocalModelPolicy.js';

// prompt 限 120 字，留 2 倍余量截断（叙事截断比拒收损失小——故事开头就是最重要的部分）。
const MAX_NARRATIVE = 240;
const MAX_LINE = 160;

const NARRATIVE_SYSTEM = '回顾你的经历，用第一人称写 2-3 句话的自我叙事——「我是谁、我们正在经历什么」。'
  + '基于经历里真实发生的事，把一路走来压缩成有连续感的故事，不编造、不逐条罗列、不堆砌抒情。'
  + '直接输出叙事正文（不超过 120 字），不要解释、不要引号、不要 markdown。'
  + '如果经历太少写不出有内容的叙事，只回复 SILENT。';

/**
 * 清洗模型输出成合法叙事；无效（空/SILENT）返回 ''。
 * 多行折成一行（注入块是单行「我的故事」），超长截断到 MAX_NARRATIVE。
 * @param {unknown} reply
 * @returns {string}
 */
export function cleanNarrative(reply) {
  const text = String(reply || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim()
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/^["'「『“]+/, '')
    .replace(/["'」』”]+$/, '')
    .trim();
  if (!text || /^SILENT$/i.test(text)) return '';
  return text.slice(0, MAX_NARRATIVE);
}

/**
 * 叙事自我。注入式全可 fake；依赖缺失/抛错一律 fail-open（保留旧叙事，绝不向上抛）。
 * @param {object} opts
 * @param {{recent: (o?: object) => Array<{type:string,summary:string,salience:number,ts:number}>, aged?: (o?: object) => Array<{type:string,summary:string,ts:number}>}|null} [opts.timeline]
 * @param {(id: string) => ({chat: Function}|null|undefined)} [opts.getAdapter]
 * @param {string} [opts.brainAdapterId]
 * @param {string} [opts.model]
 * @param {string|null} [opts.stateFile] 持久化文件（null → 仅进程内存，测试用）
 * @param {number} [opts.minIntervalMs] 新鲜度守卫（默认 24h：叙事是日更级低频，refresh 可被高频调用自限）
 * @param {() => number} [opts.now]
 * @param {string} [opts.projectId]
 * @param {number} [opts.recentLimit] 时间线「最近」段取多少条
 * @param {number} [opts.agedLimit] 时间线「故事开端」段取多少条（recent 取满才补取，避免重叠）
 */
export function createNarrativeSelf({
  timeline = null,
  getAdapter,
  // 复用内心反刍同款本地大脑通道（NOE_INNER_BRAIN/NOE_INNER_MODEL，与 InnerMonologue 同形默认）
  brainAdapterId = process.env.NOE_INNER_BRAIN || 'lmstudio',
  model = process.env.NOE_INNER_MODEL ?? NOE_MAIN_BRAIN_MODEL,
  stateFile = null,
  minIntervalMs = 24 * 3600000,
  now = Date.now,
  projectId = 'noe',
  recentLimit = 40,
  agedLimit = 20,
} = {}) {
  model = normalizeNoeAutoModel(model, { allowEmpty: true });
  /** @type {{narrative: string, atMs: number}|null} */
  let cache = null;
  // 启动恢复：文件缺失/损坏 → null（readJsonWithCorruptBackup 已把损坏件备份），下次 refresh 重建。
  if (stateFile) {
    try {
      const j = readJsonWithCorruptBackup(stateFile, { label: 'noe-narrative-self' });
      const text = typeof j?.narrative === 'string' ? j.narrative.trim().slice(0, MAX_NARRATIVE) : '';
      const at = Number(j?.atMs);
      if (text && Number.isFinite(at) && at > 0) cache = { narrative: text, atMs: at };
    } catch { /* fail-open：读失败当没存过 */ }
  }
  /** @type {Promise<object>|null} 并发守卫：启动刷新+反刍顺风车可能同时触发，只跑一次模型 */
  let inFlight = null;

  function persist() {
    if (!stateFile || !cache) return;
    try { atomicWriteJson(stateFile, { version: 1, narrative: cache.narrative, atMs: cache.atMs }); } catch { /* 持久化失败不阻断（重启丢一次叙事，可接受） */ }
  }

  async function refreshOnce(force) {
    // 新鲜度守卫：refresh 可以被高频调用（反刍 tick 顺风车），真跑模型由这里自限成日更级。
    if (!force && cache && now() - cache.atMs < minIntervalMs) return { refreshed: false, reason: 'fresh' };

    let recent = [];
    try { recent = timeline?.recent ? timeline.recent({ limit: recentLimit }) : []; } catch { recent = []; }
    if (!Array.isArray(recent) || !recent.length) return { refreshed: false, reason: 'no_episodes' };

    // 全幅：recent 取满（说明时间线比窗口长）才补取「故事开端」段（aged 最老在前，untilTs 防重叠）。
    /** @type {Array<{type:string,summary:string,ts:number}>} */
    let opening = [];
    if (recent.length >= recentLimit && typeof timeline?.aged === 'function') {
      try {
        const oldestTs = Number(recent[recent.length - 1]?.ts);
        if (Number.isFinite(oldestTs)) opening = timeline.aged({ untilTs: oldestTs - 1, limit: agedLimit }) || [];
      } catch { opening = []; }
    }

    let adapter = null;
    try { adapter = getAdapter?.(brainAdapterId); } catch { adapter = null; }
    if (!adapter?.chat) return { refreshed: false, reason: 'no_brain' };

    const line = (e) => `- [${e.type || 'interaction'}] ${String(e.summary || '').slice(0, MAX_LINE)}`;
    const openingBlock = opening.length ? `【故事开端（最早在前）】\n${opening.map(line).join('\n')}\n\n` : '';
    const userContent = `我的经历素材：\n${openingBlock}【最近的经历（最近在前）】\n${recent.map(line).join('\n')}`;

    let narrative = '';
    try {
      const budget = resolveNoeOutputBudget('normal_chat');
      const r = await adapter.chat(
        [
          { role: 'system', content: NARRATIVE_SYSTEM },
          { role: 'user', content: userContent },
        ],
        // 不设超时（跑模型纪律）；model 空串则用 adapter 默认（LM Studio 当前加载的）
        { budgetContext: { projectId, taskId: 'noe-narrative-self' }, think: false, maxTokens: budget.max_tokens, ...(model ? { model } : {}) },
      );
      if (r?.incomplete) return { refreshed: false, reason: 'brain_incomplete', finishReason: r.finishReason || 'length' };
      narrative = cleanNarrative(r?.reply);
    } catch (e) {
      // fail-open：模型挂了保留旧叙事，不向上抛
      return { refreshed: false, reason: 'brain_error', error: /** @type {any} */ (e)?.message };
    }

    if (!narrative) return { refreshed: false, reason: 'silent' };   // SILENT/无效输出：保留旧叙事
    cache = { narrative, atMs: now() };
    persist();
    return { refreshed: true, narrative };
  }

  return {
    /**
     * 异步刷新叙事（并发守卫：进行中则共享同一次）。永不 reject（内部已 fail-open）。
     * @param {{force?: boolean}} [opts] force 越过新鲜度守卫（手动触发/调试用）
     */
    refresh({ force = false } = {}) {
      if (inFlight) return inFlight;
      inFlight = refreshOnce(force === true).finally(() => { inFlight = null; });
      return inFlight;
    },
    /** 同步读当前叙事：{ narrative, atMs } 或 null（从未生成过）。旧叙事不过期——下次成功刷新才替换。 */
    current() {
      return cache ? { ...cache } : null;
    },
  };
}
