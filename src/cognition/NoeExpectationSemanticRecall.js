// @ts-check
// P1-A：judge 证据检索的 embedding 语义召回模块（注入式）。
//
// 背景：judge（buildEventsEvidence）原本只走 bigram 词面匹配，avgSemanticCoverage=0.044——
// 预测多是诗意内省念头、证据是 action 结构化日志，词面几不重合（hits=0），judge 拿不到证据回 UNKNOWN，
// source=surprise 恒 0。R6 离线实验（真实 claim×events qwen3-embedding）证实：4/6 claim 与相关事件有强语义
// 关联（simMax 0.8、跨度 0.5），embedding 能召回词面漏掉的证据。
//
// 本模块只做「claim × 候选事件」的 embedding 相似度计算，含双代理辩论揪出的守卫：
//  - R2/dim+fallback 守卫：ollama 单条失败不抛错而退 128 维 hash(fallback:true)，cosineSim 的 Math.min 会
//    静默截断算假相似度——故显式 `fallback || dim 不等 → 跳过该事件`（照抄 VectorIndex:89 的 dim 守卫思路）。
//  - 锁 model=qwen3-embedding:0.6b（1024 维），不用 EmbeddingProvider 默认的 nomic(768 维)。
//  - Promise.all 并行 embed（避免逐条 await 的串行延迟）。
//  - threshold 默认 0.5（R6：弱关联 0.575 也要召回；0.6 会漏），env 可调。
//  - 对象引用作 Map 键（events 的 ev 对象，与 buildEventsEvidence 主循环共享同一引用，禁 clone）。
//  - degraded 可观测：claim 或任一事件退 fallback 时记标志，供 judge 结果落账「本次走语义/退降级」。
//
// 默认 OFF：装配方仅在 NOE_JUDGE_EMBEDDING=1 时创建并注入；recall=null 时 buildEventsEvidence 走旧词面路径。

const DEFAULT_MODEL = 'qwen3-embedding:0.6b';
const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_MAX_EMBED_EVENTS = 32;

/** 哨兵键：以对象引用为键的 Map 里塞一个降级标志，供消费方读 result.get(DEGRADED_KEY)?.degraded。 */
export const DEGRADED_KEY = Symbol('noe-recall-degraded');

/** 向量校验：兼容普通数组与 Float32Array（EmbeddingProvider 返回 Float32Array，Array.isArray 对它恒 false——
 *  这正是 P1-A 端到端揪出的真 bug：单测 mock 返回普通数组没暴露，真实 embed 返回 Float32Array 时 recall 全 degraded）。 */
const isVector = (v) => (Array.isArray(v) || ArrayBuffer.isView(v)) && v.length > 0;

/**
 * @param {object} opts
 * @param {(text:string, o?:object)=>Promise<{vector:number[], fallback?:boolean}>} opts.embed
 * @param {(a:number[], b:number[])=>number} opts.cosineSim
 * @param {string} [opts.model]
 * @param {number} [opts.threshold]
 * @param {number} [opts.maxEmbedEvents]
 * @returns {null | ((claimText:string, events:Array<{ev:object, text:string}>)=>Promise<Map<any,{similarity:number}|{degraded:boolean}>>)}
 */
export function createClaimEventEmbedRecall({
  embed,
  cosineSim,
  model = DEFAULT_MODEL,
  threshold = DEFAULT_THRESHOLD,
  maxEmbedEvents = DEFAULT_MAX_EMBED_EVENTS,
} = {}) {
  if (typeof embed !== 'function' || typeof cosineSim !== 'function') return null;
  const thr = Number.isFinite(threshold) ? Number(threshold) : DEFAULT_THRESHOLD;
  const cap = Math.max(1, Math.min(200, Number(maxEmbedEvents) || DEFAULT_MAX_EMBED_EVENTS));

  return async function recall(claimText, events) {
    /** @type {Map<any,{similarity:number}|{degraded:boolean}>} */
    const result = new Map();
    if (!claimText || typeof claimText !== 'string' || !Array.isArray(events) || !events.length) return result;

    // claim 向量（R2：退 fallback 则整体降级走 needle，绝不用 128 维 claim 去比）
    let claimVec = null;
    try {
      const cr = await embed(claimText, { provider: 'ollama', model });
      if (cr && !cr.fallback && isVector(cr.vector) && cr.vector.every(Number.isFinite)) claimVec = cr.vector; // P1[2]：逐元素 finite 校验，含 NaN 的 claim 向量→整体降级走 needle，不静默
    } catch { /* fall through to degraded */ }
    if (!claimVec) {
      result.set(DEGRADED_KEY, { degraded: true });
      return result;
    }

    const cand = events.slice(0, cap).filter((e) => e && e.ev && typeof e.text === 'string' && e.text);
    // P1-006：并行 embed 候选事件
    const vecs = await Promise.all(cand.map(async (e) => {
      try {
        const er = await embed(e.text, { provider: 'ollama', model });
        // R2 守卫：fallback 或维度不等于 claim → 不可比，跳过（返回 null）
        // P1[2]（修三方审查 minor）：逐元素 finite 校验——含 NaN/Inf 的 embedding(proxy/中转层截断可致)返回 null→标 degraded，不静默漏证据
        if (!er || er.fallback || !isVector(er.vector) || er.vector.length !== claimVec.length || !er.vector.every(Number.isFinite)) return null;
        return er.vector;
      } catch { return null; }
    }));

    // R5：超 cap 的候选被 slice 静默丢弃，标 degraded 让上游可观测「召回可能不全」（防 sim=1.0 的完美证据排第 33 位被无声漏掉）
    let degraded = events.length > cap;
    for (let i = 0; i < cand.length; i++) {
      const v = vecs[i];
      if (!v) { degraded = true; continue; } // 该事件降级，跳过（不污染）
      const sim = cosineSim(claimVec, v);
      if (Number.isFinite(sim)) {
        if (sim >= thr) result.set(cand[i].ev, { similarity: Math.round(sim * 1000) / 1000 });
      } else { degraded = true; } // P1[2]：sim 异常(NaN)也标 degraded 可观测，不静默吞
    }
    if (degraded) result.set(DEGRADED_KEY, { degraded: true });
    return result;
  };
}

export const NOE_RECALL_DEFAULTS = Object.freeze({ model: DEFAULT_MODEL, threshold: DEFAULT_THRESHOLD, maxEmbedEvents: DEFAULT_MAX_EMBED_EVENTS });
