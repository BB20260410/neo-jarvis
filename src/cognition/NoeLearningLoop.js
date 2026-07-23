// @ts-check
// NoeLearningLoop（P1-4 自学习闭环整合）——把 P1 三器整合成一个事件驱动的学习闭环单元，统一 .env flag。
//
// 三器本质是**事件驱动**（非轮询）：
//   - onActFailed(act)   → NoeFailureLessons：失败 act → type=feedback 教训（根因 unverified）。
//   - onGoalDone(goal)   → NoeSkillDistiller：完成的多步 goal → 蒸馏技能卡写 SkillStore。
//   - onPreference(pair) → NoePreferenceCollector：偏好对 → train/quarantine（低置信隔离）。
// 统一开关 NOE_LEARNING（server 侧门控，默认 OFF）：OFF 时 server 根本不实例化本闭环 = 零回归。
// tick() 返回各器统计，供 learningScheduler 低频心跳或运维巡检调用（不强行注册 job 以免撞现有 runLearnOnce
//   派发约定）。所有钩子对缺失依赖 graceful no-op，绝不抛错阻断主链。

import { createNoeFailureLessons } from './NoeFailureLessons.js';
import { createNoeSkillDistiller } from './NoeSkillDistiller.js';
import { createNoePreferenceCollector } from './NoePreferenceCollector.js';

/**
 * @param {{
 *   memoryWrite?: Function, skillUpsert?: Function, appendLine?: Function,
 *   recordEpisode?: Function, now?: () => number, outDir?: string,
 *   failureLessons?: any, skillDistiller?: any, preferences?: any
 * }} deps
 */
export function createNoeLearningLoop(deps = {}) {
  const { memoryWrite, skillUpsert, appendLine, recordEpisode, now = () => Date.now(), outDir } = deps;
  // 允许直接注入已建好的子器（便于单测精确 stub）；否则按 deps 构造。
  const failureLessons = deps.failureLessons || createNoeFailureLessons({ memoryWrite, recordEpisode, now });
  // #16 子改动1：透传主题去重（dedupPregate flag + listSkills）——蒸馏前查近30天同主题 alive 卡，跳过重复。默认 OFF/null=零回归。
  const skillDistiller = deps.skillDistiller || createNoeSkillDistiller({ skillUpsert, recordEpisode, now, dedupPregate: deps.skillDedupPregate === true, listSkills: deps.listSkills || null });
  const preferences = deps.preferences || createNoePreferenceCollector({ appendLine, now, ...(outDir ? { outDir } : {}) });

  const counters = { lessons: 0, skills: 0, prefs: 0 };

  function onActFailed(act = {}) {
    try {
      const r = failureLessons.observe(act);
      if (r && r.created) counters.lessons += 1;
      return r;
    } catch (e) { return { ok: false, reason: 'exception', error: String(e?.message || e).slice(0, 120) }; }
  }

  function onGoalDone(goal = {}) {
    try {
      const r = skillDistiller.observe(goal, { goalDone: true });
      if (r && r.created) counters.skills += 1;
      return r;
    } catch (e) { return { ok: false, reason: 'exception', error: String(e?.message || e).slice(0, 120) }; }
  }

  function onPreference(pair = {}) {
    try {
      const r = preferences.record(pair);
      if (r && r.written) counters.prefs += 1;
      return r;
    } catch (e) { return { ok: false, reason: 'exception', error: String(e?.message || e).slice(0, 120) }; }
  }

  // 低频心跳/巡检：返回学习成效快照（事件驱动学习的可观测面），不做重活。
  function tick() {
    let prefStats = {};
    try { prefStats = preferences.stats(); } catch { /* best-effort */ }
    return { ok: true, counters: { ...counters }, prefStats };
  }

  function stats() {
    return { ...counters, ...tick().prefStats };
  }

  return { onActFailed, onGoalDone, onPreference, tick, stats, failureLessons, skillDistiller, preferences };
}
