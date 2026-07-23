// @ts-check
// NoeMemoryEcho — 记忆回声采样（设计文档《AI自我意识实现方案》§5.2 P2）。
//
// 问题：反刍只看"最近 12 条"——近因茧房，联想永远绕着昨天打转，久远的经历只能等梦境升华。
// 设计：从更久远的情景池（>24h，排除念头本身防回声室）按
//   0.4·显著度 + 0.3·新近度(半衰 14 天) + 0.3·情感相称(当下 VAD vs 情景印记)
//   打分后做 softmax 采样（温度 0.25：高分占优但保留偶然性——联想的"意外感"来源）。
// 注入式可测：timeline/affectProbe/now/rng 全注入；任何环节炸了返回 null（fail-open，反刍照跑）。

const SOFTMAX_T = 0.25;

export function createMemoryEcho({
  timeline,
  affectProbe = null,          // () => {v,a,...}|null：当下情感（NOE_AFFECT 开才注入；缺省按中性相称 0.5）
  now = Date.now,
  rng = Math.random,
  minAgeMs = 24 * 3600_000,    // 回声=久远：太近的经历不算回声
  poolLimit = 120,
  halfLifeMs = 14 * 86400_000,
} = {}) {
  if (!timeline?.recent) throw new Error('createMemoryEcho: timeline(EpisodicTimeline) required');

  /** 采一段回声记忆；池空/出错返回 null。 */
  function sample() {
    const t = now();
    let pool = [];
    try {
      pool = timeline.recent({ limit: poolLimit, types: ['interaction', 'observation', 'milestone', 'dream'] })
        .filter((e) => t - e.ts >= minAgeMs && e.summary);
    } catch { return null; }
    if (!pool.length) return null;

    let cur = null;
    if (typeof affectProbe === 'function') { try { cur = affectProbe(); } catch { cur = null; } }

    const scores = pool.map((e) => {
      const sal = Math.min(1, (Number(e.salience) || 3) / 5);
      const rec = Math.exp(-(t - e.ts) / halfLifeMs);
      const av = e.meta?.affect?.v;
      const cong = cur && Number.isFinite(av) ? 1 - Math.abs((Number(cur.v) || 0) - av) / 2 : 0.5;
      return 0.4 * sal + 0.3 * rec + 0.3 * cong;
    });
    const mx = Math.max(...scores);
    const ws = scores.map((s) => Math.exp((s - mx) / SOFTMAX_T));
    const sum = ws.reduce((a, b) => a + b, 0);
    let r = rng() * sum;
    for (let i = 0; i < pool.length; i++) { r -= ws[i]; if (r <= 0) return pool[i]; }
    return pool[pool.length - 1];
  }

  return { sample };
}
