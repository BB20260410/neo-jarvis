// @ts-check
// NoeSkillDistiller（P1-2 自学习）——把「完成的多步 goal」蒸馏成可复用技能卡，写入 SkillStore。
//
// 设计：
//   - 全注入式（skillUpsert/recordEpisode/now），便于单测 stub；env 门控在 server 侧（默认 OFF）。
//   - 触发点：goalSystem.recordStepResult 返回 goalDone:true 时（M7）。只蒸馏「多步、有实质动作」的 goal
//     （单步/纯 think 的 goal 不值得成技能，避免技能库被琐碎条目灌满）。
//   - 产物：SkillStore.upsert 的技能卡 = 步骤模板（plan 序列）+ 触发条件（从标题/步骤抽的关键词）。
//   - **注入面对齐（P1 红队修复）**：goal 标题/步骤可能来自外部/对话，会逐字进 card.body/description（挂载时进
//     system prompt）。SkillStore 的 NOE_SKILL_SCAN 内容扫描**默认 OFF**，故蒸馏卡一律 `enabled:false` 落盘
//     （对齐 SkillExtractor/NoeSkillDraftApply 的自动卡默认停用惯例），需显式启用才生效——把「自动蒸馏」与「成为活注入面」解耦。
//   - 去重：① name 由 goalId 派生，upsert 幂等；② observe 进程内按 goalId 去重，避免同 goal 多次回报反复重写
//     盘 + 计数虚高（红队实锤：onGoalReportback 每次 done 都触发）。

import { shouldSkipDistillByTopic } from './NoeSkillDedup.js';

const NAME_PREFIX = 'noe-learned-';
const MAX_BODY_STEPS = 20;
const MAX_KEYWORDS = 10;
// 抽触发关键词时滤掉的停用词（中英）。
const STOPWORDS = new Set([
  '的', '了', '和', '与', '把', '让', '是', '在', '对', '为', '到', '个', '这', '那', '一个', '怎么', '如何', '一下', '问题',
  'the', 'a', 'an', 'to', 'of', 'and', 'or', 'for', 'in', 'on', 'with', 'how', 'do', 'is', 'be', 'it', 'this', 'that',
]);

function clean(value, max = 400) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeSkillName(goalId) {
  const slug = String(goalId || '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return `${NAME_PREFIX}${slug || 'goal'}`.slice(0, 64);
}

function planSteps(goal = {}) {
  const plan = Array.isArray(goal.plan) ? goal.plan : [];
  return plan
    .map((s) => ({ step: clean(s && (s.step || s.title || s.note), 200), kind: clean(s && s.kind, 24) || 'step' }))
    .filter((s) => s.step);
}

// 实质动作步数（act/research 等非纯 think）——决定是否值得蒸馏。
function actionableStepCount(steps) {
  return steps.filter((s) => s.kind !== 'think').length;
}

function extractTriggerKeywords(goal, steps) {
  const text = `${clean(goal.title || goal.goal, 200)} ${steps.map((s) => s.step).join(' ')}`;
  const tokens = text
    .split(/[\s，。、；：！？,.;:!?()（）"'`/\\[\]{}|]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t.toLowerCase()));
  const seen = new Set();
  const out = [];
  for (const t of tokens) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

// 从一个 goal 构造技能卡（不写盘）；不满足蒸馏条件返回 null。
export function distillSkillFromGoal(goal = {}, { now = () => Date.now(), minActionableSteps = 2 } = {}) {
  const title = clean(goal.title || goal.goal, 160);
  if (!title) return null;
  const steps = planSteps(goal);
  if (actionableStepCount(steps) < minActionableSteps) return null; // 单步/纯 think 不蒸馏
  const keywords = extractTriggerKeywords(goal, steps);
  const name = safeSkillName(goal.id || goal.goalId);
  const description = clean(`Neo 蒸馏技能：${title}（触发：${keywords.slice(0, 4).join('/') || title}）`, 300);
  const stepLines = steps.slice(0, MAX_BODY_STEPS).map((s, i) => `${i + 1}. [${s.kind}] ${s.step}`).join('\n');
  const body = [
    `# 学到的技能：${title}`,
    '',
    '> 由 Neo 从一次成功完成的目标自动蒸馏（步骤模板，遇同类任务可复用/改写）。',
    '',
    '## 触发条件',
    `当任务涉及：${keywords.join('、') || title}`,
    '',
    '## 步骤模板',
    stepLines || '（无明确步骤）',
  ].join('\n');
  return {
    name,
    displayName: title,
    description,
    body,
    enabled: false, // 红队修复：蒸馏卡默认停用，需显式启用才注入 prompt（goal 内容可能含注入载荷，扫描默认 OFF）
    extra: { source: 'goal_distillation', goalId: clean(goal.id || goal.goalId, 64), distilledAt: String(typeof now === 'function' ? now() : now) },
  };
}

/**
 * 技能蒸馏器。observe(goal, {goalDone}) 在 goalDone 时把多步 goal 蒸馏成技能卡写 SkillStore。
 * @param {{ skillUpsert?: Function, recordEpisode?: Function, now?: () => number, minActionableSteps?: number }} deps
 */
export function createNoeSkillDistiller({ skillUpsert = null, recordEpisode = null, now = () => Date.now(), minActionableSteps = 2, dedupPregate = false, listSkills = null } = {}) {
  const seenGoalIds = new Set(); // 进程内已蒸馏 goalId，防同 goal 多次 done 回报反复重写盘 + 计数虚高（红队修复）
  function observe(goal = {}, { goalDone = false } = {}) {
    try {
      if (!goalDone) return { ok: true, created: false, reason: 'goal_not_done' };
      if (typeof skillUpsert !== 'function') return { ok: false, reason: 'skill_upsert_unavailable' };
      const gid = String((goal && (goal.id || goal.goalId)) || '');
      if (gid && seenGoalIds.has(gid)) return { ok: true, created: false, reason: 'already_distilled' };
      const card = distillSkillFromGoal(goal, { now, minActionableSteps });
      if (!card) return { ok: true, created: false, reason: 'not_distillable' };
      // #16 子改动1：主题去重前移（flag NOE_SKILL_DEDUP_PREGATE）——近30天同主题 alive 蒸馏卡已存在则跳过，
      //   防不同 goalId 同主题反复蒸馏灌满技能库（现有 seenGoalIds 只按 goalId 幂等，挡不住同主题不同 goalId）。
      //   flag OFF / listSkills 未注入 → 不去重（零回归）；判定异常 fail-open（不阻断蒸馏）。
      if (dedupPregate && typeof listSkills === 'function') {
        let dup;
        try { dup = shouldSkipDistillByTopic(card.displayName, listSkills() || [], { now }); } catch { dup = { skip: false }; }
        if (dup && dup.skip) {
          if (gid) seenGoalIds.add(gid); // 同 goal 不再反复判
          return { ok: true, created: false, reason: 'already_distilled_topic', matchedSkill: dup.matchedCard && dup.matchedCard.name, score: dup.score };
        }
      }
      const skill = skillUpsert(card);
      const skillName = (skill && skill.name) || card.name;
      if (gid) seenGoalIds.add(gid); // upsert 成功后才记，失败可重试
      try { recordEpisode?.({ type: 'observation', summary: `从完成的目标蒸馏出技能：${card.displayName}`, salience: 3 }); } catch { /* timeline best-effort */ }
      return { ok: true, created: true, skillName, card };
    } catch (e) {
      // SkillStore 内容扫描拒写 / 数量上限等 → 不阻断主流程，记原因。
      return { ok: false, reason: 'distill_failed', error: clean(e?.message || e, 180) };
    }
  }
  return { observe, distillSkillFromGoal: (g) => distillSkillFromGoal(g, { now, minActionableSteps }) };
}
