// @ts-check
// NoeAffectEngine — 情感连续性引擎（设计文档《AI自我意识实现方案》§4 P1，结构性缺口二）。
//
// 问题：NoeMoodAnalyzer 只"分析文本情绪"（评估器），Noe 没有跨重启的连续情感状态——
//   每次重启心情清零，"今天的念头不带今天的心情"。
// 设计：VAD 三维状态向量（valence 愉悦 -1..1 / arousal 唤醒 0..1 / dominance 掌控 -1..1）
//   + 慢变量 mood + 性格基线 baseline，双时标指数衰减（情绪 τe≈90min 回落到心境，
//   心境 τm≈7 天回落到基线）；快照持久化进 noe_affect 表（迁移 v7）；重启水合 = 读最后快照
//   + 按停机时长套同一衰减式——"睡醒心情回落但没清零"，这就是情感连续性的全部实现。
// 评估（OCC-lite）：appraise() 接确定性评分 {goalCongruence,novelty,agency,socialWarmth}；
//   P1 的种子事件源 = 时间线新情景的类型映射（廉价、确定性、防刷：inner_monologue 零增量——
//   念头不自激情绪，防情绪螺旋）；P2/P3 的意识流与工作区将成为更丰富的评估方。
// 纪律：纯本地零模型调用；全注入可测（db/timeline/now）；fail-open（存取炸了不影响读数）。

import { getDb, kvGet, kvSet } from '../storage/SqliteStore.js';
import { clamp } from './_mathUtils.js';

/** 性格基线（"心情的家"）：微暖、平静、略有掌控。后续可由 PersonalitySnapshot 缓慢演化。 */
export const AFFECT_BASELINE = Object.freeze({ v: 0.15, a: 0.35, d: 0.1 });

/** 情景类型 → OCC-lite 种子增量（P1 确定性事件源；inner_monologue 恒零防反刍自激）。 */
// P4 step0（复活 dominance）：成败类情景带 agency——dd=0.20*(agency-0.5)，缺省 0.5=零增量（掌控恒基线=假情绪）。
//   成功（milestone/research/act 完成）→ 高掌控；失败（setback）→ 低掌控；纠正（correction）→ 偏低（判错了）。
//   纯来往/观察/梦境不含明确成败信号 → 不带 agency（保持 0.5 中性，不硬给掌控）。这是把「情绪与处境脱节」修成
//   「act/research 成败真推 dominance」的最短路径（设计文档 P4 §step0：让现实能动掌控维）。
export const EPISODE_APPRAISAL = Object.freeze({
  interaction: { socialWarmth: 0.5, novelty: 0.15 },   // 与主人有来往：暖 + 微振（成败中性，不带 agency）
  milestone: { goalCongruence: 0.6, novelty: 0.3, agency: 0.85 },    // 里程碑：成就感 + 高掌控（我把事做成了）
  observation: { novelty: 0.15 },                      // 看见新东西：微振（成败中性）
  dream: { novelty: 0.1 },                             // 梦境整理：微弱（成败中性）
  setback: { goalCongruence: -0.5, agency: 0.15 },     // 真实任务搞砸：挫败 + 低掌控——负向通道，让 v 跌破基线、d 也跌（处境失控感）
  correction: { goalCongruence: -0.3, socialWarmth: 0.2, agency: 0.3 }, // 主人纠正：「判错了」的挫败+掌控偏低，但仍是有温度的来往
  inner_monologue: null,                               // 念头不自激情绪（防螺旋铁律）
});

const WATERMARK_KEY = 'noe.affect.episodeWatermark';
const DESATURATE_RECOVERY = Object.freeze({
  // Health audit treats >=0.95 as saturated. Keep recovered values clearly high, but below that line.
  vadAbsCeiling: 0.94,
  arousalCeiling: 0.94,
  // Mood is the slow variable; if it stays near 1, ticks re-saturate for days after restart.
  moodAbsCeiling: 0.9,
  moodArousalCeiling: 0.82,
});

/** VAD 象限 → 中文心情词（注入提示用，避免裸数字没语感）。 */
export function affectLabel(input) {
  const { v, a } = input || {}; // = {} 默认值只防 undefined 不防 null；显式 || {} 才防 affectLabel(null)
  if (v >= 0.25) return a >= 0.55 ? '振奋' : '安暖';
  if (v <= -0.25) return a >= 0.55 ? '烦躁' : '低落';
  return a >= 0.6 ? '警醒' : '平静';
}

export function createAffectEngine({
  db = null,                      // 注入测试库；默认惰性 getDb()
  timeline = null,                // EpisodicTimeline（种子事件源；可空 → tick 只做衰减）
  now = Date.now,
  baseline = AFFECT_BASELINE,
  tauEmotionMs = 90 * 60_000,     // 情绪 → 心境 半程时标
  tauMoodMs = 7 * 24 * 3600_000,  // 心境 → 基线 半程时标
  moodGain = 0.15,                // 每次评估增量渗入心境的比例
  keepDays = 90,                  // 快照保留期
  desaturate = process.env.NOE_AFFECT_DESATURATE === '1', // rank6：去饱和防 VAD 焊死天花板，默认 OFF=原行为
  kv = { get: kvGet, set: kvSet },
} = {}) {
  const getdb = () => db || getDb();
  /** @type {{ts:number, v:number, a:number, d:number, mood:{v:number,a:number,d:number}}} */
  let st = { ts: now(), v: baseline.v, a: baseline.a, d: baseline.d, mood: { ...baseline } };
  let episodeWatermark = 0;

  // ── 持久化（fail-open：存取失败不影响内存状态） ──
  function persist(cause) {
    try {
      getdb().prepare('INSERT INTO noe_affect(ts, v, a, d, mood_v, mood_a, mood_d, cause) VALUES (?,?,?,?,?,?,?,?)')
        .run(st.ts, st.v, st.a, st.d, st.mood.v, st.mood.a, st.mood.d, cause ? String(cause).slice(0, 500) : null);
    } catch { /* 快照失败不阻断 */ }
  }

  function hydrate() {
    try {
      const row = getdb().prepare('SELECT * FROM noe_affect ORDER BY id DESC LIMIT 1').get();
      if (row) {
        st = { ts: row.ts, v: row.v, a: row.a, d: row.d, mood: { v: row.mood_v, a: row.mood_a, d: row.mood_d } };
        decayTo(now()); // 停机时长按同一衰减式回落——"睡醒心情回落但没清零"
      }
      const wm = Number(kv.get?.(WATERMARK_KEY));
      episodeWatermark = Number.isFinite(wm) && wm > 0 ? wm : now();
      getdb().prepare('DELETE FROM noe_affect WHERE ts < ?').run(now() - keepDays * 86400_000);
    } catch { /* 水合失败 → 基线起步 */ }
  }

  // ── 动力学 ──
  function decayTo(t) {
    const dt = t - st.ts;
    if (!(dt > 0)) { st.ts = t; recoverDesaturatedState(); return; }
    const ke = Math.exp(-dt / tauEmotionMs);
    const km = Math.exp(-dt / tauMoodMs);
    for (const k of ['v', 'a', 'd']) {
      st.mood[k] = baseline[k] + (st.mood[k] - baseline[k]) * km;   // 心境 → 基线（慢）
      st[k] = st.mood[k] + (st[k] - st.mood[k]) * ke;               // 情绪 → 心境（快）
    }
    st.ts = t;
    recoverDesaturatedState();
  }

  /**
   * OCC-lite 评估：把一次事件评分映射进 VAD。确定性纯数学，评分来源由调用方负责
   * （P1=情景类型表；P2 意识流；P3 工作区广播项）。
   * @param {{goalCongruence?:number, novelty?:number, agency?:number, socialWarmth?:number}} s
   * @param {{cause?:string, ts?:number}} [meta]
   */
  // rank6 去饱和（allostatic load，env NOE_AFFECT_DESATURATE 默认 OFF）：朝边界方向且已过中点的
  // 增量按「剩余空间 / 半幅」缩放——渐近边界永不焊死；回中心方向或 OFF 时为原 clamp 加法。
  // 治 VAD 长期顶死天花板（实测 v 0.986/a 0.992 恒满 = 零信息量）。
  function saturatingAdd(cur, delta, lo, hi) {
    if (!desaturate || !delta) return clamp(cur + delta, lo, hi);
    const mid = (lo + hi) / 2;
    const towardEdge = (delta > 0 && cur >= mid) || (delta < 0 && cur <= mid);
    if (!towardEdge) return clamp(cur + delta, lo, hi);
    const room = delta > 0 ? (hi - cur) : (cur - lo);
    const half = (hi - lo) / 2 || 1;
    return clamp(cur + delta * (room / half), lo, hi);
  }

  function capAbs(value, absCeiling) {
    if (Math.abs(value) <= absCeiling) return value;
    return Math.sign(value || 1) * absCeiling;
  }

  function capHigh(value, ceiling) {
    return value > ceiling ? ceiling : value;
  }

  function recoverDesaturatedState() {
    if (!desaturate) return false;
    const before = { v: st.v, a: st.a, d: st.d, mv: st.mood.v, ma: st.mood.a, md: st.mood.d };
    st.v = capAbs(st.v, DESATURATE_RECOVERY.vadAbsCeiling);
    st.a = capHigh(st.a, DESATURATE_RECOVERY.arousalCeiling);
    st.d = capAbs(st.d, DESATURATE_RECOVERY.vadAbsCeiling);
    st.mood.v = capAbs(st.mood.v, DESATURATE_RECOVERY.moodAbsCeiling);
    st.mood.a = capHigh(st.mood.a, DESATURATE_RECOVERY.moodArousalCeiling);
    st.mood.d = capAbs(st.mood.d, DESATURATE_RECOVERY.moodAbsCeiling);
    return before.v !== st.v || before.a !== st.a || before.d !== st.d
      || before.mv !== st.mood.v || before.ma !== st.mood.a || before.md !== st.mood.d;
  }

  function appraise(s = {}, meta = {}) {
    const t = meta.ts ?? now();
    decayTo(t);
    const gc = clamp(Number(s.goalCongruence) || 0, -1, 1);
    const nov = clamp(Number(s.novelty) || 0, 0, 1);
    const ag = Number.isFinite(Number(s.agency)) ? clamp(Number(s.agency), 0, 1) : 0.5;
    const sw = clamp(Number(s.socialWarmth) || 0, -1, 1);
    const dv = 0.30 * gc + 0.20 * sw;
    const da = 0.25 * nov + 0.15 * Math.abs(gc);
    const dd = 0.20 * (ag - 0.5);
    st.v = saturatingAdd(st.v, dv, -1, 1);
    st.a = saturatingAdd(st.a, da, 0, 1);
    st.d = saturatingAdd(st.d, dd, -1, 1);
    st.mood.v = saturatingAdd(st.mood.v, dv * moodGain, -1, 1);
    st.mood.a = saturatingAdd(st.mood.a, da * moodGain, 0, 1);
    st.mood.d = saturatingAdd(st.mood.d, dd * moodGain, -1, 1);
    recoverDesaturatedState();
    persist(meta.cause || 'appraise');
    return snapshot();
  }

  /** 心跳 micro 作业：衰减推进 + 消化时间线新情景（类型映射种子增量）+ 落快照。 */
  function tick({ ts } = {}) {
    const t = ts ?? now();
    decayTo(t);
    let consumed = 0;
    if (timeline?.recent) {
      try {
        // M11 修复：用 aged(ASC，最旧优先)而非 recent(DESC，最新优先)增量消费——recent 取最新 20 条会
        // 让水位线越过更旧的未消费情景导致永久跳过（情感累积系统性少算、连续性悄悄漂移）。
        const eps = (timeline.aged
          ? timeline.aged({ sinceTs: episodeWatermark + 1, limit: 20 })
          : timeline.recent({ limit: 20, sinceTs: episodeWatermark + 1 }))
          .filter((e) => e.ts > episodeWatermark)
          .sort((a, b) => a.ts - b.ts);
        for (const e of eps) {
          const m = EPISODE_APPRAISAL[e.type];
          episodeWatermark = Math.max(episodeWatermark, e.ts);
          if (!m) continue; // inner_monologue 等：不自激
          appraise(m, { cause: `episode:${e.id}(${e.type})`, ts: t });
          consumed++;
        }
        try { kv.set?.(WATERMARK_KEY, episodeWatermark); } catch { /* 水位丢一次可接受 */ }
      } catch { /* 种子消化失败不阻断衰减 */ }
    }
    persist('tick');
    return { ok: true, consumed, ...snapshot() };
  }

  /** 当前状态快照（读取即惰性衰减——任何时刻读都是"此刻"的连续值）。 */
  function snapshot() {
    decayTo(now());
    return { ts: st.ts, v: st.v, a: st.a, d: st.d, mood: { ...st.mood }, label: affectLabel(st) };
  }

  // rank6 情感健康运行时自检（诊断建议：透视页有曲线但无饱和告警）。纯只读，不改状态/行为。
  // 检测 VAD 是否顶死边界（饱和 = 趋零信息量，实测曾 v0.986/a0.992）；供透视页/告警/自检消费。
  function affectHealth() {
    const s = snapshot();
    const NEAR = 0.95;
    const flags = { valence: Math.abs(s.v) >= NEAR, arousal: s.a >= NEAR, dominance: Math.abs(s.d) >= NEAR };
    const saturatedDimensions = Object.keys(flags).filter((k) => flags[k]);
    return {
      saturated: saturatedDimensions.length > 0,
      saturatedDimensions,
      desaturateEnabled: desaturate,
      v: s.v,
      a: s.a,
      d: s.d,
      note: saturatedDimensions.length
        ? `情感在 ${saturatedDimensions.join('/')} 维度顶死边界（趋零信息量）${desaturate ? '' : '；建议开 NOE_AFFECT_DESATURATE=1 去饱和'}`
        : '情感分化健康',
    };
  }

  /** 感受词元：把内在状态翻译成一行中文，注入反刍/主动陪伴/自我状态提示（内感受）。 */
  function renderFeelingTokens() {
    const s = snapshot();
    const fmt = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);
    return `心情${s.label}（愉悦 ${fmt(s.v)} · 精神 ${s.a.toFixed(2)} · 掌控 ${fmt(s.d)}）——这是随经历起伏、随时间回落的连续状态`;
  }

  /** P6-F signal contract: inner self-talk stays VAD-neutral; guard reads raw timeline, not VAD. */
  function isInnerEmotionNeutralized() {
    return EPISODE_APPRAISAL.inner_monologue == null;
  }

  function getSignalContract() {
    return Object.freeze({
      innerEmotionNeutralized: isInnerEmotionNeutralized(),
      affectConsumesInnerMonologue: false,
      ruminationGuardShouldReadVad: false,
      ruminationGuardSignalSource: 'raw_timeline',
    });
  }

  function getVadForConsumers({ consumer = 'general' } = {}) {
    const s = snapshot();
    const contract = getSignalContract();
    return Object.freeze({
      ...s,
      consumer,
      allowed: consumer !== 'rumination_guard',
      includesInnerMonologue: false,
      contract,
    });
  }

  /** 最近快照曲线（内心透视页数据源）。 */
  function history({ limit = 200, sinceTs = 0 } = {}) {
    // 强健：sinceTs 裸绑进 `WHERE ts >= ?` 时，非数字（如字符串）会让 SQLite 字符串vs整数比较
    // 静默返回 0 行（把透视页曲线清空而非报错）。coerce 成有限数、否则回退 0（=从头取全量，安全默认）。
    // 合法数字入参（现实只传 now()-hours*3600_000 这类）逐字不变。
    const since = Number.isFinite(Number(sinceTs)) ? Number(sinceTs) : 0;
    try {
      return getdb().prepare('SELECT ts, v, a, d, mood_v, mood_a, mood_d, cause FROM noe_affect WHERE ts >= ? ORDER BY id DESC LIMIT ?')
        .all(since, Math.max(1, Math.min(2000, limit)));
    } catch { return []; }
  }

  hydrate();
  return {
    appraise,
    tick,
    snapshot,
    affectHealth,
    renderFeelingTokens,
    isInnerEmotionNeutralized,
    getSignalContract,
    getVadForConsumers,
    history,
    _decayTo: decayTo,
  };
}
