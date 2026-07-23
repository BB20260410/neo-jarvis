// @ts-check
// NoeSleepTimeCompute — 空闲预计算（sleep-time compute）：无活跃对话时，用「已预测的 owner 下一问」
// 提前算好候选上下文（检索结果），写进 NoePrefetchStore 作下一 turn 的参考，命中即秒答（token 降 ~5x）。
//
// 问题：owner 真问出来那一刻才现算检索/上下文，会让首字延迟堆在 turn 上。但 NoeOwnerBehaviorPredictor
//   已经在对每条 owner 交互「下注」——「owner 接下来还会再提到/谈论 X」。这些 open 预测就是「下一问」的
//   现成信号。空闲时（owner 不在键盘前），用最闲的本地脑慢档把这些主题的检索预算先花掉，结果进预取池。
// 设计（注入式、零硬编码 I/O，全 fail-open）：
//   一跳 tick()：① 先判空闲（isIdle 注入）——不空闲直接 skip，绝不抢正在进行的 turn；
//   ② 从 openPredictions() 取「owner 下一问」候选主题（复用 NoeOwnerBehaviorPredictor.openOwnerPredictions，
//      解出 [owner-pred:topic:X] 的 X），按 dedupe + 池中已有候选跳过；③ 对 top-N 主题用注入的 precompute(query,
//      {signal}) 慢档预算算候选上下文；④ 把结果以「带 source + TTL 的候选上下文」写进 NoePrefetchStore
//      （key=keyPrefix:topic，value 含 [来源] 前缀，明确是「空闲预判的候选参考」而非答案）。
//
// codex 硬约束（逐条落实）：
//   - idle-only：tick 开头 isIdle() 不为 true 一律 return {skipped:'not_idle'}，绝不在有活跃 turn 时跑。
//   - 可取消：每跳起一个 AbortController，cancel()（owner 一来就调）立即 abort 在途预计算 + 置 cancelled 标志；
//     precompute 收到 signal.aborted 应尽快退出，写池前再查一次 signal/标志，已取消则丢弃不写（不污染池）。
//   - prefetch 只做带 source+TTL 的「候选上下文」：写入 value 一律包 `[空闲预判候选·来源:…]` 前缀，
//     turn 时经 NoePrefetchStore.toContextBlock 作 <prefetched-items> 参考注入，绝不当回答直接输出。
//   - 低功耗 + fail-open：用本地 Main Brain 空闲慢档（由 precompute 注入决定，本模块不调模型）；不设任何硬超时
//     （本地模型 JIT 加载慢正常）；predictor/precompute/store 缺失或抛错 → 静默 skip，绝不阻断心跳/对话。
//
// 注：本模块不持有时钟用于「判过期」（TTL 由 store 负责）；nowMs 仅透传给 store.set 当 fetchedAt（确定性可测）。

const DEFAULT_TTL_MS = 30 * 60_000;        // 候选上下文新鲜度：30 分钟（与预取池默认同量级）
const TOPIC_TOKEN_RE = /\[owner-pred:topic:([^\]]+)\]/;
const DEFAULT_KEY_PREFIX = 'sleeptime';
const SOURCE_TAG = 'sleep-time-compute';   // 写进 value 的来源标记（候选≠答案的显式凭证）

/** 从一条 open 预测的 claim 解出 topic 主题；非 topic 类（如 followup）返回 ''。 @param {{claim?:string}} pred */
function topicOf(pred) {
  const claim = String(pred?.claim || '');
  const m = claim.match(TOPIC_TOKEN_RE);
  return m && m[1] ? String(m[1]).trim() : '';
}

/**
 * 创建空闲预计算器。
 *
 * @param {{
 *   prefetchStore?: {set: Function, has: Function}|null,   // NoePrefetchStore：写候选 + 查池中是否已有
 *   openPredictions?: (() => Array<{claim:string,p?:number}>)|null, // 通常 = ownerBehaviorPredictor.openOwnerPredictions
 *   precompute?: ((query: string, opts: {signal: AbortSignal, topic: string}) => Promise<string|null>|string|null)|null, // 注入的慢档预算（检索/上下文），返回候选文本
 *   isIdle?: (() => boolean)|null,                          // 空闲判定（注入：通常 = 最近一次 interaction 距今 > 阈值）
 *   now?: () => number,                                     // 仅透传 store.set 当 fetchedAt（确定性可测）
 *   keyPrefix?: string,                                     // 预取池 key 前缀（默认 sleeptime）
 *   ttlMs?: number,                                         // 候选 TTL（毫秒）
 *   maxTopicsPerTick?: number,                              // 一跳最多预计算几个主题（低功耗）
 *   minQueryLen?: number,                                   // 主题太短不值得预算（默认 2）
 *   maxValueLen?: number,                                   // 候选文本长度上限（防污染上下文预算）
 * }} [deps]
 */
export function createSleepTimeCompute({
  prefetchStore = null,
  openPredictions = null,
  precompute = null,
  isIdle = null,
  now = Date.now,
  keyPrefix = DEFAULT_KEY_PREFIX,
  ttlMs = DEFAULT_TTL_MS,
  maxTopicsPerTick = 2,
  minQueryLen = 2,
  maxValueLen = 1200,
} = {}) {
  const prefix = String(keyPrefix || DEFAULT_KEY_PREFIX);
  const ttl = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : DEFAULT_TTL_MS;
  const topN = Math.max(1, Math.min(8, Number(maxTopicsPerTick) || 2));
  const minLen = Math.max(1, Number(minQueryLen) || 2);
  const valueCap = Math.max(80, Number(maxValueLen) || 1200);

  /** @type {AbortController|null} 当前在途预计算的取消句柄（同一时刻至多一个 tick 在跑）。 */
  let inFlight = null;
  let running = false;

  // ready() 通过后，这三个注入依赖必非空；捕获为局部非空引用，既给 tsc 收窄又避免重复可选链。
  const fnOpen = /** @type {() => Array<{claim:string,p?:number}>} */ (openPredictions);
  const fnPre = /** @type {(q:string, o:{signal:AbortSignal,topic:string})=>any} */ (precompute);
  const store = /** @type {{set: Function, has?: Function}} */ (prefetchStore);

  const ready = () =>
    typeof openPredictions === 'function' &&
    typeof precompute === 'function' &&
    Boolean(prefetchStore && typeof prefetchStore.set === 'function');

  /** @param {string} topic */
  const keyFor = (topic) => `${prefix}:${topic}`;

  /** 取「owner 下一问」候选主题：去重 + 跳过池中已有候选 + 按 claim 主观概率高→低排（更可能问的先算）。 */
  function nextTopics() {
    let opens;
    try { opens = fnOpen() || []; } catch { return []; }
    if (!Array.isArray(opens) || !opens.length) return [];
    const seen = new Set();
    /** @type {string[]} */
    const out = [];
    const ranked = opens
      .map((p) => ({ topic: topicOf(p), p: Number(p?.p) || 0 }))
      .filter((x) => x.topic && x.topic.length >= minLen)
      .sort((a, b) => b.p - a.p);
    for (const { topic } of ranked) {
      if (out.length >= topN) break;
      if (seen.has(topic)) continue;
      seen.add(topic);
      // 池中已有未过期候选 → 跳过（不重复花预算）。须传注入 now（否则 has 回退真实时钟，注入时钟下误判过期）。
      // has 抛错按「没有」处理（fail-open）。
      try { if (typeof store.has === 'function' && store.has(keyFor(topic), now())) continue; } catch { /* treat as absent */ }
      out.push(topic);
    }
    return out;
  }

  /** owner 一来立即调用：abort 在途预计算 + 标记取消（在途结果将被丢弃，不写池）。 */
  function cancel(reason = 'owner_active') {
    const had = Boolean(inFlight);
    try { inFlight?.abort?.(reason); } catch { /* abort 失败不阻断 */ }
    return had;
  }

  /**
   * 把候选文本包成「带来源的候选上下文」——显式标注是空闲预判的参考，绝非答案。
   * @param {string} topic @param {string|null|undefined} text
   */
  function wrapCandidate(topic, text) {
    const body = String(text || '').replace(/\s+$/, '').slice(0, valueCap);
    if (!body) return '';
    return `[空闲预判候选·来源:${SOURCE_TAG}·主题:${topic}]（仅作下一轮参考上下文，非结论）\n${body}`;
  }

  /**
   * 一跳：空闲才跑；为「owner 下一问」主题预算候选上下文写入预取池。可被 cancel() 中途打断。
   * @returns {Promise<{skipped?: string, ran?: boolean, topics?: string[], written?: number, cancelled?: boolean}>}
   */
  async function tick() {
    if (!ready()) return { skipped: 'unwired' };
    // 串行：同一时刻至多一个 sleeptime tick（与心跳串行广播一致；并发交叠会互相 abort）。
    if (running) return { skipped: 'already_running' };
    // idle-only：不空闲绝不跑（绝不抢正在进行的对话/turn）。isIdle 抛错按「不空闲」保守处理。
    if (typeof isIdle === 'function') {
      let idle = false;
      try { idle = isIdle() === true; } catch { idle = false; }
      if (!idle) return { skipped: 'not_idle' };
    }
    const topics = nextTopics();
    if (!topics.length) return { skipped: 'no_candidates', topics: [] };

    running = true;
    const ctrl = new AbortController();
    inFlight = ctrl;
    let written = 0;
    try {
      for (const topic of topics) {
        if (ctrl.signal.aborted) break; // owner 来了 → 停止后续主题
        let text = null;
        try {
          text = await fnPre(topic, { signal: ctrl.signal, topic });
        } catch { text = null; } // 预算失败（模型挂/检索空）→ 跳过该主题，fail-open
        // 写池前再查一次：已取消则丢弃不写（绝不把可能过时/被打断的结果污染进上下文）。
        if (ctrl.signal.aborted) break;
        const value = wrapCandidate(topic, text);
        if (!value) continue;
        try {
          if (store.set(keyFor(topic), value, ttl, now())) written += 1;
        } catch { /* 写池失败不阻断其余主题 */ }
      }
      return { ran: true, topics, written, cancelled: ctrl.signal.aborted };
    } finally {
      running = false;
      if (inFlight === ctrl) inFlight = null;
    }
  }

  return { tick, cancel, nextTopics, isRunning: () => running };
}
