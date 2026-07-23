// @ts-check
// #16 子改动1：skill 蒸馏主题去重——蒸馏成卡前，按 goal.title 主题指纹查近30天同主题 alive 蒸馏卡，
//   有则跳过（防不同 goalId 同主题反复蒸馏灌满技能库；现有去重只按 goalId 幂等，挡不住同主题不同 goalId）。
//   字符级 charDice（对中文短标题近重复鲁棒，不依赖分词；与 NoeSelfEvolutionLessonRecall 同算法，跨域故各自
//   持有 8 行纯函数，第三次复用再抽通用）。去重锚=近 windowMs 内蒸馏卡（source==='goal_distillation' 优先识别、
//   name 前缀 noe-learned- 兜底）——**不依赖 enabled**（蒸馏卡默认 disabled 防注入、但仍占技能库分母，多模型审 P1）。
//   保守去重（宁漏不误：漏=多张卡无害，误=漏蒸馏真技能有害）。

const DISTILL_NAME_PREFIX = 'noe-learned-';

function charBigrams(s) {
  const t = String(s || '').toLowerCase().replace(/\s+/g, '');
  const grams = new Set();
  for (let i = 0; i < t.length - 1; i += 1) grams.add(t.slice(i, i + 2));
  return grams;
}
// Sørensen–Dice 系数 2|A∩B|/(|A|+|B|)，0..1。
function charDiceSimilarity(a, b) {
  const ga = charBigrams(a);
  const gb = charBigrams(b);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  return (2 * inter) / (ga.size + gb.size);
}

function ageMs(updatedAt, nowMs) {
  const t = Date.parse(String(updatedAt || ''));
  return Number.isFinite(t) ? nowMs - t : Infinity;
}

/**
 * 蒸馏前主题去重：goalTitle 与近 windowMs 内 alive 蒸馏卡（name 前缀 noe-learned-）的 displayName
 *   charDice >= threshold → skip（已有同主题活卡，不重复蒸馏）。
 * @param {string} goalTitle
 * @param {Array<{name?:string, displayName?:string, enabled?:boolean, updatedAt?:string}>} existingCards - 通常 skillStore.list()
 * @param {{now?:()=>number, windowMs?:number, threshold?:number, minChars?:number}} [opts]
 * @returns {{skip:boolean, reason:string, matchedCard?:object, score:number}}
 */
export function shouldSkipDistillByTopic(goalTitle, existingCards, { now = () => Date.now(), windowMs = 30 * 86400_000, threshold = 0.85, minChars = 6 } = {}) {
  const title = String(goalTitle || '').trim();
  if (title.replace(/\s+/g, '').length < minChars) return { skip: false, reason: 'title_too_thin', score: 0 };
  const cards = Array.isArray(existingCards) ? existingCards : [];
  const nowMs = typeof now === 'function' ? now() : Number(now) || Date.now();
  let best = { score: 0, card: null };
  for (const c of cards) {
    if (!c) continue;
    // P1：蒸馏卡默认 enabled:false（红队防注入），仍占技能库分母——去重锚不依赖 enabled。
    // P2-3 + 重审 P2 边界：source 严格优先——有 source 只信 source（显式非 goal_distillation 不被 name 前缀误判为蒸馏卡）；
    //   source 缺失/空才用 name 前缀 noe-learned- 兜底（同进程 upsert reload 后 source 通常可得，兜底覆盖极端缺失）。
    const isDistillCard = c.source
      ? c.source === 'goal_distillation'
      : String(c.name || '').startsWith(DISTILL_NAME_PREFIX);
    if (!isDistillCard) continue;
    if (ageMs(c.updatedAt, nowMs) > windowMs) continue; // 超窗旧卡不算去重锚
    const score = charDiceSimilarity(title, c.displayName);
    if (score > best.score) best = { score, card: c };
  }
  if (best.card && best.score >= threshold) {
    return { skip: true, reason: 'duplicate_topic_alive_card', matchedCard: best.card, score: best.score };
  }
  return { skip: false, reason: 'no_duplicate_topic', score: best.score };
}
