// @ts-check
// NoeFailureLessonSignal — P1 学习→进化接通：失败教训 → 可执行代码改进目标（叠加飞轮真信号源）。
//
// 问题：learning_lesson/surprise_lesson 失败教训（248+19 条）只存进记忆、从不驱动改自己 → 学和改两张皮。
//   且教训大多抽象（认知/交互修正，如"该问清需求"），不直接含代码改进点。
// 做什么：读失败教训 → 本地 LLM 提炼判定「能否转成具体的、可由改代码解决的改进目标」→
//   能则立成 self_evolution goal（叠加 JSDoc 真信号、不替换；meta.signal='failure_lesson'），
//   不能（太抽象/交互层无着力点）则跳过。立的目标交由飞轮 implement→apply，价值由 P0 度量验证。
// flag NOE_FAILURE_LESSON_SIGNAL 默认 OFF（分量动作：驱动自改方向）。纯 DI(recall/getAdapter/goalSystem) + 全程 fail-open。

import { NOE_MAIN_BRAIN_MODEL, normalizeNoeAutoModel } from '../model/NoeLocalModelPolicy.js';

const SIGNAL_SOURCE = 'self_evolution'; // 必须 self_evolution 才被飞轮 openSelfEvolutionGoals 选中
const SIGNAL = 'failure_lesson';

const REFINE_SYSTEM = [
  '你判断一条失败教训能否转成「具体的、可由改代码解决的改进目标」。',
  '规则：',
  '1. 能转成代码改进（指向某模块/函数/逻辑该改）→ {"actionable":true,"objective":"具体改进目标(动词开头,含可定位的模块或问题)","area":"可能涉及的代码区域,可空"}',
  '2. 太抽象 / 属于对话或交互层面 / 无代码着力点 → {"actionable":false}',
  '3. 只输出 JSON 对象，不要任何解释文字。',
].join('\n');

/** 鲁棒解析 LLM 提炼结果（容错：整体失败时提取首个 {...} 块）。 */
export function parseRefined(reply) {
  const text = String(reply || '').trim();
  if (!text) return null;
  let obj = null;
  try { obj = JSON.parse(text); } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); } catch { obj = null; } }
  }
  if (!obj || typeof obj !== 'object') return null;
  return { actionable: obj.actionable === true, objective: String(obj.objective || '').trim(), area: String(obj.area || '').trim() };
}

export function createFailureLessonSignal({
  recall,
  getAdapter,
  goalSystem,
  brainAdapterId = process.env.NOE_INNER_BRAIN || 'lmstudio',
  model = process.env.NOE_INNER_MODEL ?? NOE_MAIN_BRAIN_MODEL,
  recallRejectLessons = null,
  now = () => Date.now(),
} = {}) {
  const resolvedModel = normalizeNoeAutoModel(model, { allowEmpty: true });

  // 单坑位：已有 meta.signal='failure_lesson' 的 open/active goal 在飞则本轮不立（防刷屏；只看自己的 signal，不挡 JSDoc/诗性）。
  function hasInFlightLessonGoal() {
    try {
      const open = goalSystem.list({ status: 'open', limit: 200 }) || [];
      const active = goalSystem.list({ status: 'active', limit: 200 }) || [];
      return [...open, ...active].some((g) => g && g.source === SIGNAL_SOURCE && g.meta && g.meta.signal === SIGNAL);
    } catch { return false; } // fail-open：查不到当无在飞
  }

  async function runOnce({ limit = 20 } = {}) {
    if (process.env.NOE_FAILURE_LESSON_SIGNAL !== '1') return { ok: false, skipped: 'flag_off' };
    if (!goalSystem || typeof goalSystem.add !== 'function') return { ok: false, skipped: 'no_goalsystem' };
    if (hasInFlightLessonGoal()) return { ok: false, reason: 'signal_goal_in_flight' };

    let lessons;
    try { lessons = recall({ sourceTypes: ['learning_lesson', 'surprise_lesson'], limit, order: 'hot' }) || []; }
    catch { return { ok: false, reason: 'recall_failed' }; }
    if (!lessons.length) return { ok: false, reason: 'no_lesson' };

    // 选第一条非近重复被拒的教训（从失败学：不重复立注定被拒的）。
    let chosen = null;
    for (const l of lessons) {
      const text = String((l && (l.title || l.body)) || '').trim();
      if (!text) continue;
      if (typeof recallRejectLessons === 'function') {
        let verdict = null;
        try { verdict = recallRejectLessons(text); } catch { verdict = null; } // fail-open
        if (verdict && verdict.similar === true) continue;
      }
      chosen = l; break;
    }
    if (!chosen) return { ok: false, reason: 'all_near_duplicate' };

    const adapter = (() => { try { return getAdapter?.(brainAdapterId); } catch { return null; } })();
    if (!adapter?.chat) return { ok: false, skipped: 'no_brain' };

    const lessonText = String(chosen.title || chosen.body || '');
    let refined;
    try {
      const r = await adapter.chat(
        [{ role: 'system', content: REFINE_SYSTEM }, { role: 'user', content: `失败教训：${lessonText.slice(0, 500)}` }],
        // maxTokens 4096：本地 reasoning 模型(qwen3.6)即便 think:false 仍占额，1024 会把 JSON 判定整段截断成空 reply。
        { budgetContext: { projectId: 'noe', taskId: 'noe-failure-lesson-signal' }, think: false, maxTokens: 4096, ...(resolvedModel ? { model: resolvedModel } : {}) },
      );
      if (r?.incomplete) return { ok: false, reason: 'brain_incomplete' }; // 截断=无完整判断,跳过(下轮重试),不立模糊目标
      refined = parseRefined(r?.reply);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 120) }; // fail-open
    }
    if (!refined || !refined.actionable || !refined.objective) return { ok: false, reason: 'not_actionable' };

    const goalId = goalSystem.add({
      title: refined.objective.slice(0, 120),
      source: SIGNAL_SOURCE,
      why: `失败教训驱动改进（学→改接通）：${lessonText.slice(0, 80)}`,
      steps: [{ step: refined.objective.slice(0, 100), kind: 'think' }], // feasible 杠杆 + 给 cycle 动作锚
      meta: { signal: SIGNAL, lessonId: chosen.id || '', area: refined.area || '', discoveredAt: now() },
    });
    if (!goalId) return { ok: false, reason: 'add_rejected' };
    return { ok: true, goalId, lessonId: chosen.id || '', objective: refined.objective };
  }

  return { runOnce };
}
