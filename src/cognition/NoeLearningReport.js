// @ts-check
// NoeLearningReport — 自主学习「照妖镜」：把 Neo 的学习活动聚合成 owner 一眼能看懂的体检报告。
//   回答三问：① 在搜什么(主题多样性/重复度) ② 学到啥(产出的学习卡) ③ 有用吗(召回回流率)。
//   纯函数 + 注入 db（建议 readonly），可单测、可被透视页/CLI 复用。只读 SELECT，不写库/不调模型/不联网。
//
// 立这面镜子的动机（owner 2026-06-18 反思）：自主学习此前最大的问题不是"没学"，而是"学了没人看得见成效"。
//   没有一个能回答"Neo 这次学到了吗"的窗口，连衡量都做不到，自然永远感受不到成效。这是后续所有改进的验收标尺。

// learning_lesson：think 末步深思的认知修正卡（P1 闭环新增）——纳入照妖镜，让 owner 能看到新闭环产出/命中。
const LEARNING_CARD_TYPES = ['skill_distill', 'surprise_lesson', 'learning_lesson'];

const stripPrefix = (s) => String(s || '').replace(/^自主学习[:：]\s*/, '');

/**
 * 聚合学习体检报告。
 * @param {{prepare:(sql:string)=>{all:(...a:any[])=>any[], get:(...a:any[])=>any}}} db better-sqlite3 句柄
 * @param {{recentLimit?:number, cardTypes?:string[]}} [opts]
 * @returns {{searching:object, learned:object, usefulness:object, verdict:{level:string,summary:string,flags:string[]}}}
 */
export function buildLearningReport(db, { recentLimit = 10, cardTypes = LEARNING_CARD_TYPES } = {}) {
  const types = Array.isArray(cardTypes) && cardTypes.length ? cardTypes : LEARNING_CARD_TYPES;
  const ph = types.map(() => '?').join(',');

  // ① 在搜什么 —— self_learning 目标主题分布（多样性 + 重复度 + 最常学的）
  const goals = db.prepare("SELECT title, status, created_at FROM noe_goals WHERE source='self_learning' ORDER BY created_at DESC").all();
  const total = goals.length;
  const titleCounts = new Map();
  for (const g of goals) { const k = String(g.title || ''); titleCounts.set(k, (titleCounts.get(k) || 0) + 1); }
  const distinct = titleCounts.size;
  const repeatRatio = total ? 1 - distinct / total : 0;
  const recentTopics = goals.slice(0, recentLimit).map((g) => ({ topic: stripPrefix(g.title).slice(0, 40), status: g.status, at: Number(g.created_at) || 0 }));
  const topRepeated = [...titleCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([title, n]) => ({ topic: stripPrefix(title).slice(0, 36), times: n }));

  // ② 学到啥 —— 学习卡产出（按类型 + 最近几张）
  const byType = db.prepare(`SELECT source_type AS type, count(*) AS n, sum(CASE WHEN hit_count>0 THEN 1 ELSE 0 END) AS used, max(hit_count) AS maxHit FROM noe_memory WHERE source_type IN (${ph}) GROUP BY source_type`).all(...types)
    .map((c) => ({ type: c.type, count: Number(c.n) || 0, used: Number(c.used) || 0, maxHit: Number(c.maxHit) || 0 }));
  const recentCards = db.prepare(`SELECT title, source_type AS type, hit_count AS hits FROM noe_memory WHERE source_type IN (${ph}) ORDER BY created_at DESC LIMIT ?`).all(...types, recentLimit)
    .map((c) => ({ title: String(c.title || '').slice(0, 44), type: c.type, hits: Number(c.hits) || 0 }));

  // ③ 有用吗 —— 召回回流（被用过比例 / 死卡数 / 热点集中度）
  const totalCards = byType.reduce((s, c) => s + c.count, 0);
  const usedCards = byType.reduce((s, c) => s + c.used, 0);
  const usedRatio = totalCards ? usedCards / totalCards : 0;
  const deadCards = totalCards - usedCards;
  const maxHit = byType.reduce((m, c) => Math.max(m, c.maxHit), 0);

  const verdict = buildVerdict({ total, distinct, totalCards, usedRatio, deadCards });
  return {
    searching: { totalLearnings: total, distinctTopics: distinct, repeatRatio, recentTopics, topRepeated },
    learned: { totalCards, byType, recentCards },
    usefulness: { usedCards, usedRatio, deadCards, maxHit },
    verdict,
  };
}

/** 一句话体检：主题原地打转 / 产出回流断 → 勤奋空转；否则健康。 */
function buildVerdict({ total, distinct, totalCards, usedRatio, deadCards }) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  const flags = [];
  if (total > 0 && distinct > 0 && total / distinct >= 5) flags.push(`主题原地打转（${distinct} 个主题学了 ${total} 次，平均每个重复 ${Math.round(total / distinct)} 次）`);
  if (totalCards > 0 && usedRatio < 0.3) flags.push(`产出回流断（${totalCards} 张卡仅 ${pct(usedRatio)} 被用过，${deadCards} 张死在库里）`);
  if (!flags.length) return { level: 'healthy', summary: `学习健康：${distinct} 个主题、${totalCards} 张卡、${pct(usedRatio)} 被用上`, flags };
  return { level: 'spinning', summary: `勤奋空转——${flags.join('；')}`, flags };
}

export { LEARNING_CARD_TYPES };
