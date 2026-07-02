// @ts-check
// NoeWallSignal — P2 防 Goodhart 撞墙信号检测（路线 §4.2 + P2 验收明文要求的「自动护栏」那一半）。
//
// 为什么：觉醒看板可能「仪表盘繁荣却空转」——两类撞墙态最危险（「觉醒坏了」比「觉醒不了」更险）：
//   ① 整合度持续 ≥0.95：8 子系统过度同步僵化（失去多样性/novelty），看着高整合实为塌缩成单一模式。
//   ② 内心独白多但活跃目标 0：念头空转打转（rumination），思考量大却不转化成行动。
// 路线 P2 验收要求这两类信号「自动触发回滚」（砍语义 novelty / 停 InnerMonologue）。本模块负责
//   纯函数检测 + 产出建议动作（action 字段）；检测/告警始终活（满足「撞墙信号被看见」）。回滚执行端
//   （NOE_WALL_GUARD=1 时 server 写 noe.wall.guard.* 意图 kv）当前只落意图态——真正砍 novelty / 停
//   InnerMonologue 需 P3 器官接此 kv 消费，尚未接，故 action 是「建议」而非「已执行」（诚实标注，复核 R1）。
//
// 纪律：纯函数注入式（吃读数、零 IO），可确定性单测；阈值可注入。

export const WALL_DEFAULTS = Object.freeze({
  integrationThreshold: 0.95, // 整合度 TC 上限（持续高于=过度整合）
  sustainedSamples: 3,        // 连续多少拍 ≥阈值才算「持续」（单拍尖峰不触发）
  monologueThreshold: 30,     // 7 天独白条数门槛
});

/**
 * @param {object} opts
 * @param {Array<{integration:number}>} [opts.integrationHistory] 最近整合度读数（时间正序）
 * @param {number} [opts.monologue7d] 近 7 天内心独白条数
 * @param {number|null} [opts.activeGoals] 当前活跃目标数；null=目标系统不在场（idle_rumination 不检测，避免假 0 误触发）
 * @param {object} [opts.thresholds] 覆盖 WALL_DEFAULTS
 * @returns {{hit:boolean, signals:Array<{kind:string,metric:string,value:number,threshold:number,action:string,message:string}>}}
 */
export function detectWallSignals({ integrationHistory = [], monologue7d = 0, activeGoals = null, thresholds = {} } = {}) {
  const cfg = { ...WALL_DEFAULTS, ...thresholds };
  const signals = [];

  // 撞墙①：整合度连续 sustainedSamples 拍 ≥阈值 → 过度整合僵化（砍 novelty 重引多样性）
  // P2[2]（修三方审查 minor）：sustainedSamples 做范围裁剪——≤1 时 slice(-1) 单拍尖峰即误触发撞墙回滚，下限 2 上限 1000。
  const sustained = Math.max(2, Math.min(1000, Math.round(Number(cfg.sustainedSamples)) || 3));
  const recent = Array.isArray(integrationHistory) ? integrationHistory.slice(-sustained) : [];
  if (recent.length >= sustained
    && recent.every((p) => Number.isFinite(p?.integration) && p.integration >= cfg.integrationThreshold)) {
    signals.push({
      kind: 'over_integration',
      metric: 'integration_tc',
      value: recent[recent.length - 1].integration,
      threshold: cfg.integrationThreshold,
      action: 'cut_semantic_novelty',
      message: `整合度连续 ${sustained} 拍 ≥${cfg.integrationThreshold} → 子系统过度同步僵化，建议砍语义 novelty 重引多样性`,
    });
  }

  // 撞墙②：独白多但活跃目标 0 → 空转打转（停 InnerMonologue 待有目标再启）。
  //   需 activeGoals 真值——目标系统不在场（null）时不检测，避免假 0 报幻象 idle_rumination（复核 R2/R4）。
  if (Number.isFinite(activeGoals) && Number(monologue7d) >= cfg.monologueThreshold && Number(activeGoals) === 0) {
    signals.push({
      kind: 'idle_rumination',
      metric: 'monologue_vs_goals',
      value: Number(monologue7d),
      threshold: cfg.monologueThreshold,
      action: 'pause_inner_monologue',
      message: `内心独白 7 天 ${monologue7d} 条但活跃目标 0 → 空转打转（rumination），建议停 InnerMonologue 待有目标再启`,
    });
  }

  return { hit: signals.length > 0, signals };
}
