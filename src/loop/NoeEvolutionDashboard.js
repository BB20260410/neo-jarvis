// @ts-check
// NoeEvolutionDashboard — 阶段一 诚实仪表盘的纯聚合层（北极星仪器的数据侧）。
//
// 核心区分:「活跃」(cycle 数/apply 率,看起来忙) vs「进步」(真保留改逻辑随时间,真变强)。
//   飞轮曾在 68% 回滚率下自 report「健康」——因为没有一把分清这两者的尺子。本模块把 evolution_outcome
//   的 verdict×applied×reason 聚成:真进步率 + 回滚归因分布 + 按信号的 drop 率。纯函数、fail-open、可独立单测。
//   DB 读取由 scripts/noe-evolution-dashboard.mjs 薄壳做,这里只算。

/** 一条 outcome 是否「真保留改逻辑」(改了 src 逻辑且最终保留)= 真进步的原子单位。 */
function isRealProgress(o) {
  return o && o.verdict === 'logic_changed' && (o.applied === 1 || o.applied === true);
}
function isApplied(o) {
  return o && (o.applied === 1 || o.applied === true);
}

/**
 * 聚合 evolution_outcome:真进步率(真保留改逻辑/总)+ apply/回滚率 + verdict 分布 + reason 归因分布。
 * @param {Array<{verdict?:string, applied?:number|boolean, reason?:string}>} [outcomes]
 */
export function summarizeEvolutionOutcomes(outcomes = []) {
  const rows = Array.isArray(outcomes) ? outcomes : [];
  const total = rows.length;
  let realProgress = 0;
  let applied = 0;
  const verdictDist = {};
  const reasonDist = {};
  for (const o of rows) {
    if (isRealProgress(o)) realProgress += 1;
    if (isApplied(o)) applied += 1;
    const v = (o && o.verdict) || '(无verdict)';
    verdictDist[v] = (verdictDist[v] || 0) + 1;
    const r = (o && o.reason) ? String(o.reason) : '(未归因)';
    reasonDist[r] = (reasonDist[r] || 0) + 1;
  }
  return {
    total,
    realProgress,
    realProgressRate: total ? realProgress / total : 0, // 北极星:真进步率
    appliedRate: total ? applied / total : 0,
    rollbackRate: total ? (total - applied) / total : 0,
    verdictDist,
    reasonDist, // 归因金矿:68% 回滚到底卡在哪一环
  };
}

/**
 * 按信号源聚合 goal 结局 + drop 率(暴露 test_gap 黑洞 vs self_directed 高健康)。
 * @param {Array<{signal?:string, status?:string}>} [goals]
 */
export function summarizeEvolutionGoals(goals = []) {
  const rows = Array.isArray(goals) ? goals : [];
  const bySignal = {};
  for (const g of rows) {
    const sig = (g && g.signal) || '(无信号)';
    const st = (g && g.status) || 'unknown';
    const b = bySignal[sig] || (bySignal[sig] = { total: 0, done: 0, dropped: 0, open: 0, other: 0 });
    b.total += 1;
    if (st === 'done') b.done += 1;
    else if (st === 'dropped') b.dropped += 1;
    else if (st === 'open' || st === 'active') b.open += 1;
    else b.other += 1;
  }
  // drop 率 = dropped / (已终结的 done+dropped),open 不算分母(还没结局)
  for (const sig of Object.keys(bySignal)) {
    const b = bySignal[sig];
    const settled = b.done + b.dropped;
    b.dropRate = settled ? b.dropped / settled : 0;
  }
  return { total: rows.length, bySignal };
}

/**
 * 阶段一C:算一个指标在时间序列上的趋势——最新值 + 与上一快照 delta + 方向。让复盘看得见「随时间是升是降」。
 *   升=进步(继续)、降=退步(该 revert/砍)、flat=没动(样本不足或停滞)。纯函数,fail-open。
 * @param {Array<object>} series 快照序列(旧→新)
 * @param {(snap:object)=>number} pathFn 从快照取该指标
 */
export function computeSeriesTrend(series, pathFn) {
  const rows = Array.isArray(series) ? series : [];
  const vals = rows.map((s) => { try { return Number(pathFn(s)); } catch { return NaN; } }).filter((n) => Number.isFinite(n));
  if (!vals.length) return { latest: null, previous: null, delta: null, direction: 'flat' };
  const latest = vals[vals.length - 1];
  if (vals.length < 2) return { latest, previous: null, delta: null, direction: 'flat' };
  const previous = vals[vals.length - 2];
  const delta = latest - previous;
  const EPS = 1e-9;
  const direction = delta > EPS ? 'up' : (delta < -EPS ? 'down' : 'flat');
  return { latest, previous, delta, direction };
}

/**
 * 阶段二·能力地图显式化:把 goal 结局合成一张 Neo 可读的「我擅长什么/不擅长什么」自我能力模型。
 *   按信号算成功率(done/(done+dropped))+ 强/中/弱/unknown 标签(样本不足不妄断)+ 人读摘要。
 *   显式=可注入 self-knowledge、进每日快照随时间跟踪、供立项前预测"我能不能成"。纯函数。
 * @param {Array<{signal?:string, status?:string}>} [goals]
 */
export function buildCompetenceMap(goals) {
  const rows = Array.isArray(goals) ? goals : [];
  const agg = {};
  for (const g of rows) {
    const sig = (g && g.signal) || '(无信号)';
    const st = (g && g.status) || '';
    const a = agg[sig] || (agg[sig] = { done: 0, dropped: 0 });
    if (st === 'done') a.done += 1; else if (st === 'dropped') a.dropped += 1;
  }
  const bySignal = {};
  const strong = [];
  const weak = [];
  for (const sig of Object.keys(agg)) {
    const settled = agg[sig].done + agg[sig].dropped;
    const successRate = settled ? agg[sig].done / settled : 0;
    // 样本 < 3 不妄断能力(unknown);≥0.7 强、≥0.4 中、否则弱。
    let verdict = 'unknown';
    if (settled >= 3) verdict = successRate >= 0.7 ? 'strong' : (successRate >= 0.4 ? 'moderate' : 'weak');
    bySignal[sig] = { attempts: settled, done: agg[sig].done, successRate, verdict };
    if (verdict === 'strong') strong.push(sig);
    else if (verdict === 'weak') weak.push(sig);
  }
  const parts = [];
  if (strong.length) parts.push(`强项: ${strong.join('/')}`);
  if (weak.length) parts.push(`弱项(该分解/换云端/降权): ${weak.join('/')}`);
  return { bySignal, summary: parts.join('; ') };
}

/** 组装一个时间戳快照(供 append 成时间序列,画「能力随时间」曲线)。 */
export function buildEvolutionDashboard({ outcomes = [], goals = [], lessonCount = 0, at = '' } = {}) {
  return {
    at: String(at || ''),
    outcomes: summarizeEvolutionOutcomes(outcomes),
    goals: summarizeEvolutionGoals(goals),
    competence: buildCompetenceMap(goals), // 阶段二·能力地图显式化:进快照随时间跟踪「Neo 擅长/不擅长什么」
    lessonCount: Number(lessonCount) || 0,
  };
}
