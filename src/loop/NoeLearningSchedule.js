// @ts-check
// NoeLearningSchedule — 定时学习调度的纯时间计算（P4，复刻 OpenClaw cron 引擎 schedule.ts + jobs.ts 退避，
//   加 Neo 独有的【成效自适应】:学得动就多学、学不动就放过、深夜少学）。纯函数 + 注入式、无副作用、可完整单测。
import { Cron } from 'croner';

// 失败退避查表 30s→1h（OpenClaw jobs.ts:44-73：错误越多睡越久，封顶 1h，从错误风暴自动退避）
const DEFAULT_BACKOFF_MS = Object.freeze([30_000, 60_000, 300_000, 900_000, 3_600_000]);

/**
 * 算下次运行时刻。三种 schedule kind（OpenClaw types.ts:9-18）：
 *   at:    一次性。atMs>now 返回 atMs，否则 null（过期不再跑，调用方据此 disable）。
 *   every: 固定间隔 + 锚点对齐。anchor + (floor((now-anchor)/every)+1)*every，保证返回 > now。
 *   cron:  croner 解析 cron 表达式（可选时区）。
 * @param {{kind?:string, everyMs?:number, anchorMs?:number, atMs?:number, cronExpr?:string, tz?:string}} spec
 * @param {number} [nowMs]
 * @returns {number|null} 下次运行 epoch ms；null = 不再运行（at 过期 / cron 无下次 / 非法 spec）
 */
export function computeNextRunAtMs(spec = {}, nowMs = Date.now()) {
  const kind = String(spec.kind || 'every');
  if (kind === 'at') {
    const at = Number(spec.atMs);
    return Number.isFinite(at) && at > nowMs ? at : null;
  }
  if (kind === 'cron') {
    const expr = String(spec.cronExpr || '').trim();
    if (!expr) return null;
    try {
      const c = spec.tz ? new Cron(expr, { timezone: String(spec.tz) }) : new Cron(expr);
      const next = c.nextRun(new Date(nowMs));
      return next ? next.getTime() : null;
    } catch { return null; }
  }
  // every（默认）：锚点对齐固定间隔。先校验原值——0/负/<1000ms 视为非法返回 null（不兜底成每秒刷爆）。
  const everyMs = Number(spec.everyMs);
  if (!Number.isFinite(everyMs) || everyMs < 1000) return null;
  const anchor = Number.isFinite(Number(spec.anchorMs)) ? Number(spec.anchorMs) : nowMs;
  if (nowMs < anchor) return anchor; // 锚点还没到 → 第一次在锚点
  const steps = Math.floor((nowMs - anchor) / everyMs) + 1; // +1 保证 next 严格 > now（含正好到点）
  return anchor + steps * everyMs;
}

/**
 * 失败退避查表（OpenClaw）：consecutiveErrors 越多睡越久，封顶表末（默认 1h）。
 * @param {number} consecutiveErrors 连续失败次数（≥1）
 * @param {readonly number[]} [table]
 * @returns {number} 退避毫秒
 */
export function errorBackoffMs(consecutiveErrors, table = DEFAULT_BACKOFF_MS) {
  const t = Array.isArray(table) && table.length ? table : DEFAULT_BACKOFF_MS;
  const n = Math.max(1, Math.floor(Number(consecutiveErrors) || 1));
  return t[Math.min(n - 1, t.length - 1)];
}

/**
 * 成效自适应间隔（Neo 超越 OpenClaw 的增量——OpenClaw 只有失败退避，没有"按学习成效调节节奏"）：
 *   · mastery 高（这主题学会了）→ 间隔拉长（少看，1×→3×）
 *   · consecutiveIdle 高（同主题反复学没学到新东西=空耗）→ 指数退避（放过，每次 ×1.5，封顶 ×8）
 *   · quiet（夜间节律）→ ×4（深夜少学）
 * @param {number} baseMs 基础间隔
 * @param {{mastery?:number, consecutiveIdle?:number, quiet?:boolean, maxMs?:number}} [opts]
 * @returns {number} 调整后间隔（≥base，封顶 maxMs 默认 4h）
 */
export function adaptiveCadenceMs(baseMs, { mastery = 0, consecutiveIdle = 0, quiet = false, maxMs = 4 * 3_600_000 } = {}) {
  const base = Math.max(1000, Number(baseMs) || 60_000);
  const m = Math.min(1, Math.max(0, Number(mastery) || 0));
  const idle = Math.max(0, Math.floor(Number(consecutiveIdle) || 0));
  const masteryMult = 1 + 2 * m;                       // 学会了 → 间隔拉到 3 倍（生产已不喂 mastery,见 NoeLearningScheduler.planNextOnSuccess）
  const idleMult = Math.min(8, Math.pow(1.5, idle));   // 学不动 → 指数退避封顶 8 倍
  const quietMult = quiet ? 4 : 1;                     // 夜间 → 4 倍
  // 封顶 = max(base,maxMs)：base<maxMs 退避到 maxMs(默认4h)封顶；base≥maxMs 的稀疏任务(owner 设每6h 等)以 base
  //   为天花板返回 base——基础节奏已够稀疏,再退避无意义(codex 高推理复核:deliberate 语义,非 bug)。
  return Math.min(Math.max(base, maxMs), Math.round(base * masteryMult * idleMult * quietMult));
}

// 学习角度池：同一主题分多角度轮换学习（默认 4 角度，覆盖"最新→实战→坑→集成"的真实学习路径）。
const DEFAULT_LEARNING_ANGLES = Object.freeze(['最新进展与版本动态', '实战配置与最佳实践', '常见坑与排查', '与本机现有能力的集成']);

/**
 * 轮换学习标题（修 M3 红队 serious#1 自锁）：固定 topic+固定 title 会撞 goalSystem.add 同名去重→
 *   第一次后永久 idle 自锁（M3 真机探针：cycle1 起全 idle、只学一次）。按时间分桶轮换角度→每个分桶
 *   title 不同→持续立新 self_learning goal（同主题多角度本就是真实学法：先学最新进展、再学实战、再学坑、再学集成）。
 * @param {string} topic 学习主题
 * @param {number} [nowMs] 当前时刻（决定落在哪个角度分桶）
 * @param {number} [bucketMs] 分桶宽度（通常传 job.every_ms，使每个学习周期换一个角度）
 * @param {readonly string[]} [angles] 角度池（默认 4 个）
 * @returns {string} 学习 goal title
 */
export function pickLearningTitle(topic, nowMs = Date.now(), bucketMs = 3_600_000, angles = DEFAULT_LEARNING_ANGLES) {
  const list = Array.isArray(angles) && angles.length ? angles : DEFAULT_LEARNING_ANGLES;
  const b = Math.max(60_000, Number(bucketMs) || 3_600_000);
  const raw = Math.floor(Number(nowMs) / b);
  const idx = ((raw % list.length) + list.length) % list.length; // 防负/NaN
  return `自主学习：${String(topic || '').slice(0, 90)}（${list[idx]}）`;
}

export { DEFAULT_LEARNING_ANGLES };
