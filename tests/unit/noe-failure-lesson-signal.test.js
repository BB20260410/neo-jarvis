import { describe, it, expect } from 'vitest';
import { createFailureLessonSignal } from '../../src/room/NoeFailureLessonSignal.js';

// P1 学习→进化接通：读 learning_lesson/surprise_lesson 失败教训 → 本地 LLM 提炼成「可执行代码改进目标」
//   （过滤掉抽象/交互层无代码着力点的）→ 叠加飞轮真信号源（goalSystem.add，meta.signal='failure_lesson'）。
//   契约：flag OFF 零接入、单坑位防刷屏、LLM 判 not_actionable 则不立、近重复去重、全程 fail-open。

const mkGoalSystem = (opts = {}) => {
  const added = [];
  return {
    added,
    add: (g) => { if (opts.addReturnsNull) return null; added.push(g); return `goal-${added.length}`; },
    list: ({ status }) => (opts.openGoals || []).filter((g) => g.status === status),
  };
};
const mkAdapter = (reply, extra = {}) => ({ chat: async () => ({ reply, ...extra }) });
const LESSONS = [{ id: 'm1', title: '认知修正：X 流程反复失败', body: '' }];

const withFlag = async (fn) => {
  const old = process.env.NOE_FAILURE_LESSON_SIGNAL;
  process.env.NOE_FAILURE_LESSON_SIGNAL = '1';
  try { return await fn(); } finally {
    if (old === undefined) delete process.env.NOE_FAILURE_LESSON_SIGNAL; else process.env.NOE_FAILURE_LESSON_SIGNAL = old;
  }
};

describe('NoeFailureLessonSignal', () => {
  it('flag OFF → skipped:flag_off（默认零接入）', async () => {
    const old = process.env.NOE_FAILURE_LESSON_SIGNAL; delete process.env.NOE_FAILURE_LESSON_SIGNAL;
    const r = await createFailureLessonSignal({ recall: () => LESSONS, getAdapter: () => mkAdapter('{}'), goalSystem: mkGoalSystem() }).runOnce();
    expect(r.skipped).toBe('flag_off');
    if (old !== undefined) process.env.NOE_FAILURE_LESSON_SIGNAL = old;
  });

  it('正常：教训 → LLM actionable → 立项(source=self_evolution, meta.signal=failure_lesson, 带 steps)', async () => withFlag(async () => {
    const gs = mkGoalSystem();
    const reply = JSON.stringify({ actionable: true, objective: '排查并修复 X 流程的重试逻辑', area: 'src/loop' });
    const r = await createFailureLessonSignal({ recall: () => LESSONS, getAdapter: () => mkAdapter(reply), goalSystem: gs }).runOnce();
    expect(r.ok).toBe(true);
    expect(gs.added[0].source).toBe('self_evolution');
    expect(gs.added[0].meta.signal).toBe('failure_lesson');
    expect(gs.added[0].meta.lessonId).toBe('m1');
    expect(Array.isArray(gs.added[0].steps) && gs.added[0].steps.length).toBeTruthy(); // feasible 杠杆
    expect(gs.added[0].title).toContain('X 流程');
  }));

  it('LLM 判 not_actionable(抽象教训无代码着力点) → 不立项', async () => withFlag(async () => {
    const gs = mkGoalSystem();
    const r = await createFailureLessonSignal({ recall: () => LESSONS, getAdapter: () => mkAdapter('{"actionable":false}'), goalSystem: gs }).runOnce();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_actionable');
    expect(gs.added.length).toBe(0);
  }));

  it('单坑位：已有 failure_lesson 真信号 goal 在飞 → 不立(不挡诗性/JSDoc 信号)', async () => withFlag(async () => {
    const gs = mkGoalSystem({ openGoals: [{ status: 'open', source: 'self_evolution', meta: { signal: 'failure_lesson' } }] });
    const r = await createFailureLessonSignal({ recall: () => LESSONS, getAdapter: () => mkAdapter('{}'), goalSystem: gs }).runOnce();
    expect(r.reason).toBe('signal_goal_in_flight');
  }));

  it('守人格+不抢 JSDoc：已有 missing_jsdoc 真信号 goal → failure_lesson 照立(只看自己的 signal)', async () => withFlag(async () => {
    const gs = mkGoalSystem({ openGoals: [{ status: 'open', source: 'self_evolution', meta: { signal: 'missing_jsdoc' } }] });
    const reply = JSON.stringify({ actionable: true, objective: '修复 Y' });
    const r = await createFailureLessonSignal({ recall: () => LESSONS, getAdapter: () => mkAdapter(reply), goalSystem: gs }).runOnce();
    expect(r.ok).toBe(true);
  }));

  it('无教训 → no_lesson', async () => withFlag(async () => {
    const r = await createFailureLessonSignal({ recall: () => [], getAdapter: () => mkAdapter('{}'), goalSystem: mkGoalSystem() }).runOnce();
    expect(r.reason).toBe('no_lesson');
  }));

  it('近重复教训被拒 → 跳过(从失败学,不重复立注定被拒的)', async () => withFlag(async () => {
    const gs = mkGoalSystem();
    const r = await createFailureLessonSignal({ recall: () => LESSONS, getAdapter: () => mkAdapter('{"actionable":true,"objective":"x"}'), goalSystem: gs, recallRejectLessons: () => ({ similar: true }) }).runOnce();
    expect(r.reason).toBe('all_near_duplicate');
    expect(gs.added.length).toBe(0);
  }));

  it('无 brain → no_brain', async () => withFlag(async () => {
    const r = await createFailureLessonSignal({ recall: () => LESSONS, getAdapter: () => null, goalSystem: mkGoalSystem() }).runOnce();
    expect(r.skipped).toBe('no_brain');
  }));

  it('LLM 抛错 → fail-open ok:false 不崩', async () => withFlag(async () => {
    const adapter = { chat: async () => { throw new Error('model down'); } };
    const r = await createFailureLessonSignal({ recall: () => LESSONS, getAdapter: () => adapter, goalSystem: mkGoalSystem() }).runOnce();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('model down');
  }));

  it('LLM 带解释文字 → 鲁棒提取 JSON', async () => withFlag(async () => {
    const gs = mkGoalSystem();
    const reply = '分析后：\n{"actionable":true,"objective":"修复 Z 模块的空指针"}\n以上。';
    const r = await createFailureLessonSignal({ recall: () => LESSONS, getAdapter: () => mkAdapter(reply), goalSystem: gs }).runOnce();
    expect(r.ok).toBe(true);
    expect(gs.added[0].title).toContain('Z 模块');
  }));

  it('LLM incomplete(截断) → brain_incomplete 不立(下轮重试)', async () => withFlag(async () => {
    const gs = mkGoalSystem();
    const r = await createFailureLessonSignal({ recall: () => LESSONS, getAdapter: () => mkAdapter('{', { incomplete: true }), goalSystem: gs }).runOnce();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('brain_incomplete');
    expect(gs.added.length).toBe(0);
  }));

  it('recall 抛错 → recall_failed 不崩', async () => withFlag(async () => {
    const r = await createFailureLessonSignal({ recall: () => { throw new Error('db'); }, getAdapter: () => mkAdapter('{}'), goalSystem: mkGoalSystem() }).runOnce();
    expect(r.reason).toBe('recall_failed');
  }));

  it('add 返 null(同名去重) → add_rejected', async () => withFlag(async () => {
    const gs = mkGoalSystem({ addReturnsNull: true });
    const r = await createFailureLessonSignal({ recall: () => LESSONS, getAdapter: () => mkAdapter('{"actionable":true,"objective":"x 改进"}'), goalSystem: gs }).runOnce();
    expect(r.reason).toBe('add_rejected');
  }));
});
