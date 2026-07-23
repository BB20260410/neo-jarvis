// @ts-check
// NoeTopicCurator — 动态自主学习选题器（治 R1：6 写死 topic 无限轮回 cursor%6）。
//
// 研究结论（M3+Claude 多模型，DB 实证）：自主学习空耗的直观病灶是「6 主题永久轮回 + 学够了还反复学」。
//   本模块用三招破局：
//   ① 饱和冷却——一个 topic 学过 saturationVisits 次后进 cooldown，期内不再选它（治反复学同质）；
//   ② round-robin 跳过饱和——在「未饱和」候选里选最久没学的（治固定相位死循环）；
//   ③ 动态扩池——把读到的新概念（novelty 硬门通过）加进候选池，6 写死种子降级为冷启动兜底（治探索停滞）。
//
// 纪律：注入式（kv 存访问账本 + seeds + now，可选 dynamicConcepts 源），纯函数化可单测；
//   只写自己的 kv 键（noe.learning.topicArchive.v1）；flag NOE_DYNAMIC_TOPICS 默认 OFF，
//   OFF 时调用方回退 cursor%6 零回归。防发散：动态 topic 受 novelty 硬门 + 池上限约束。

const KV_ARCHIVE = 'noe.learning.topicArchive.v1';

/** topic 的稳定 key：优先 url，退而 title。 */
function topicKey(t) {
  return String(t?.url || t?.title || '').trim().toLowerCase();
}

/**
 * @param {object} opts
 * @param {{get:(k:string)=>any, set:(k:string,v:any)=>any}} opts.kv
 * @param {Array<{title:string,query?:string,url:string,localPattern?:string,localPaths?:string[]}>} opts.seeds 6 写死种子（冷启动兜底）
 * @param {() => number} [opts.now]
 * @param {number} [opts.saturationVisits] 学几次算饱和（默认 3）
 * @param {number} [opts.cooldownMs] 饱和后冷却多久（默认 24h）
 * @param {number} [opts.poolCap] 动态池上限（默认 24）
 */
export function createTopicCurator({
  kv,
  seeds = [],
  now = Date.now,
  saturationVisits = 3,
  cooldownMs = 24 * 3600 * 1000,
  poolCap = 24,
} = {}) {
  if (!kv || typeof kv.get !== 'function' || typeof kv.set !== 'function') {
    throw new Error('createTopicCurator: kv{get,set} required');
  }
  const satN = Math.max(1, Math.round(Number(saturationVisits)) || 3);
  const cd = Math.max(60_000, Number(cooldownMs) || 24 * 3600 * 1000);

  function archive() {
    const a = kv.get(KV_ARCHIVE);
    return (a && typeof a === 'object') ? a : {};
  }

  /** 记一次学习访问（计数 + 时间戳）。 */
  function recordVisit(topic) {
    const key = topicKey(topic);
    if (!key) return null;
    const a = archive();
    const rec = a[key] || { visits: 0, lastVisit: 0, title: topic.title || '' };
    rec.visits += 1;
    rec.lastVisit = now();
    rec.title = topic.title || rec.title;
    a[key] = rec;
    kv.set(KV_ARCHIVE, a);
    return rec;
  }

  /** 是否饱和（学够 satN 次且还在冷却期内）。冷却过了重新可学（解冻）。 */
  function isSaturated(topic, a = archive()) {
    const rec = a[topicKey(topic)];
    if (!rec) return false;
    return rec.visits >= satN && (now() - (rec.lastVisit || 0)) < cd;
  }

  /**
   * 选下一个学什么。候选 = seeds + dynamicConcepts（过 novelty 硬门）。
   *   优先未饱和、最久没学的；全饱和则选最久没学的（解冻最旧）。
   * @param {{ dynamicConcepts?: Array<{title:string,url:string,query?:string}>, isNovel?: (concept:any)=>boolean }} [opts]
   * @returns {{topic:object, reason:string}}
   */
  function getNextTopic({ dynamicConcepts = [], isNovel = null, dynamicPriority = false } = {}) {
    const a = archive();
    // 动态概念过 novelty 硬门（与已学库不重复）才进候选
    const dyn = Array.isArray(dynamicConcepts)
      ? dynamicConcepts.filter((c) => c && c.url && c.title && (!isNovel || isNovel(c)) && !a[topicKey(c)])
      : [];
    const pool = [...seeds, ...dyn].slice(0, poolCap);
    if (!pool.length) return { topic: seeds[0] || null, reason: 'empty_pool_fallback' };

    const lastVisitOf = (t) => a[topicKey(t)]?.lastVisit || 0;
    const isDyn = (t) => dyn.includes(t);
    const fresh = pool.filter((t) => !isSaturated(t, a));
    if (fresh.length) {
      // 价值对齐（D，dynamicPriority）：动态发现的主题(基于 Neo 真实状态:好奇/知识缺口/owner 相关)优先于静态表 seed——
      //   让"从遇到的东西自主学"压过"刷预定义池"。OFF 时按原「最久没学」逐字（零回归）。
      if (dynamicPriority) fresh.sort((x, y) => { const d = (isDyn(y) ? 1 : 0) - (isDyn(x) ? 1 : 0); return d !== 0 ? d : lastVisitOf(x) - lastVisitOf(y); });
      else fresh.sort((x, y) => lastVisitOf(x) - lastVisitOf(y));
      const pickedDyn = isDyn(fresh[0]);
      return { topic: fresh[0], reason: pickedDyn ? 'dynamic_novel' : 'fresh_least_recent' };
    }
    // 全饱和：解冻最旧的（避免完全停学）
    const sorted = [...pool].sort((x, y) => lastVisitOf(x) - lastVisitOf(y));
    return { topic: sorted[0], reason: 'all_saturated_thaw_oldest' };
  }

  /** 学习进度报表（供看板/审计）。 */
  function report() {
    const a = archive();
    const entries = Object.entries(a).map(([key, r]) => ({ key, title: r.title, visits: r.visits, saturated: r.visits >= satN && (now() - (r.lastVisit || 0)) < cd }));
    return { total: entries.length, saturated: entries.filter((e) => e.saturated).length, topics: entries };
  }

  return { getNextTopic, recordVisit, isSaturated, report };
}
