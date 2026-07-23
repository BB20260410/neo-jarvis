// @ts-check
// NoeSurfacingGate — 浮现门：统一"内心内容能不能对外开口"的克制闸（设计文档《AI自我意识实现方案》§5.4）。
//
// 设计：四重全过才放行——①非静默时段 ②日预算未超 ③与近期已浮现内容不重复 ④冷却到期。
// 拦下的内容不丢：调用方应把 {pass:false, reason} 留痕（"想说没说"也是经历）。
// 本模块只做判定与记账，不负责"怎么说出口"（说话仍走既有通道：升华入店 → proactiveTick due）。
// 注入式全可测：kv/now/quietCheck/textSimilarity 注入；kv 炸了 fail-open 放行交给下游既有克制兜底。

const KV_KEY = 'noe.surfacing.gate';

export function createSurfacingGate({
  kv,                          // {get(k),set(k,v)}：日预算与近期记录的持久化（SqliteStore kvGet/kvSet）
  now = Date.now,
  quietCheck = null,           // (ts)=>boolean：静默时段判定（NoeCircadian.isQuiet，注入才生效）
  textSimilarity = null,       // (a,b)=>0..1：近期重复判定（注入才生效）
  budgetPerDay = 8,            // 每天最多主动浮现条数（克制原则的硬上限）
  cooldownMs = 30 * 60_000,    // 两次浮现最小间隔
  similarityThreshold = 0.75,
  recentKeep = 12,             // 近期已浮现内容比对窗口
} = {}) {
  function load() {
    try {
      const s = kv?.get?.(KV_KEY);
      if (s && typeof s === 'object') return { day: s.day || '', count: Number(s.count) || 0, lastAt: Number(s.lastAt) || 0, recent: Array.isArray(s.recent) ? s.recent : [] };
    } catch { /* fail-open */ }
    return { day: '', count: 0, lastAt: 0, recent: [] };
  }
  function save(st) { try { kv?.set?.(KV_KEY, st); } catch { /* 丢一次记账可接受 */ } }
  const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

  /**
   * 判定一条内容能否浮现；pass=true 时已记账（计预算/冷却/近期窗口）。
   * @param {{text: string, salience?: number}} item
   * @returns {{pass: boolean, reason: string}}
   */
  function tryPass({ text, salience = 0.7 } = {}) {
    const t = now();
    const body = String(text || '').trim();
    if (!body) return { pass: false, reason: 'empty' };
    if (Number(salience) < 0.7) return { pass: false, reason: 'low_salience' };
    if (typeof quietCheck === 'function') {
      try { if (quietCheck(t) === true) return { pass: false, reason: 'quiet_hours' }; } catch { /* 判不出按非夜 */ }
    }
    const st = load();
    const today = dayOf(t);
    if (st.day !== today) { st.day = today; st.count = 0; }
    if (st.count >= budgetPerDay) return { pass: false, reason: 'budget_exhausted' };
    if (t - st.lastAt < cooldownMs) return { pass: false, reason: 'cooldown' };
    if (typeof textSimilarity === 'function') {
      try {
        if (st.recent.some((r) => textSimilarity(r, body) >= similarityThreshold)) return { pass: false, reason: 'duplicate' };
      } catch { /* 判不出当不重复 */ }
    }
    st.count += 1;
    st.lastAt = t;
    st.recent = [body.slice(0, 200), ...st.recent].slice(0, recentKeep);
    save(st);
    return { pass: true, reason: 'ok' };
  }

  /** 当前记账状态（透视页数据源）。 */
  function status() {
    const st = load();
    return { day: st.day, usedToday: st.count, budgetPerDay, lastAt: st.lastAt };
  }

  return { tryPass, status };
}
