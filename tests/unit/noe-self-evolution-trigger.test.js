import { describe, it, expect, vi, beforeEach } from 'vitest';

// loop 求值器有自己的测试；这里 mock 它来精确控制 stage，验 trigger 的 stage→action 映射与控制流。
vi.mock('../../src/room/NoeSelfEvolutionLoop.js', () => ({
  evaluateNoeSelfEvolutionLoop: vi.fn(() => ({ stage: 'consensus_blocked', nextAction: 'refresh_four_model_consensus' })),
}));

import { evaluateNoeSelfEvolutionLoop } from '../../src/room/NoeSelfEvolutionLoop.js';
import {
  createNoeSelfEvolutionTrigger,
  classifySelfEvolutionSignal,
  classifySelfEvolutionObjectiveQuality,
  buildSelfEvolutionGoal,
} from '../../src/room/NoeSelfEvolutionTrigger.js';

function mockGoalSystem({ openGoals = [], addReturns = 'goal-new', getReturns = null } = {}) {
  return {
    list: vi.fn(({ status } = {}) => (status === 'open' ? openGoals : [])),
    add: vi.fn(() => addReturns),
    get: vi.fn(() => getReturns),
  };
}

function mockCycleStore({ getByGoal = null, cycle = { cycleId: 'c-1', goal: 'g', goalId: 'goal-1' } } = {}) {
  return {
    getByGoal: vi.fn(() => getByGoal),
    upsert: vi.fn(() => ({ ok: true, cycle, stage: 'consensus_blocked' })),
  };
}

beforeEach(() => {
  evaluateNoeSelfEvolutionLoop.mockReset();
  evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'consensus_blocked', nextAction: 'refresh_four_model_consensus' });
});

describe('classifySelfEvolutionSignal', () => {
  it('命中「改自身/自我进化」意图', () => {
    expect(classifySelfEvolutionSignal('你应该改进自己的代码').isSelfEvolution).toBe(true);
    expect(classifySelfEvolutionSignal('启动自我进化').isSelfEvolution).toBe(true);
    expect(classifySelfEvolutionSignal('run self-evolution now').isSelfEvolution).toBe(true);
  });
  it('普通文本不命中', () => {
    expect(classifySelfEvolutionSignal('今天天气不错').isSelfEvolution).toBe(false);
    expect(classifySelfEvolutionSignal('').isSelfEvolution).toBe(false);
  });
});

describe('buildSelfEvolutionGoal', () => {
  it('source=self_evolution + 用 objective 作 title', () => {
    const g = buildSelfEvolutionGoal({ objective: '改进期望结算率' });
    expect(g.source).toBe('self_evolution');
    expect(g.title).toBe('改进期望结算率');
  });
  it('空 objective 用兜底文案', () => {
    expect(buildSelfEvolutionGoal({}).title).toBe('自我进化：改进自身代码');
  });
});

describe('classifySelfEvolutionObjectiveQuality（P0-4 目标质量闸）', () => {
  it('情绪碎片无技术锚 → hasTechnicalTarget false', () => {
    expect(classifySelfEvolutionObjectiveQuality('LangGraph 踏实感').hasTechnicalTarget).toBe(false);
    expect(classifySelfEvolutionObjectiveQuality('想要更安心').hasTechnicalTarget).toBe(false);
    expect(classifySelfEvolutionObjectiveQuality('改进自己').hasTechnicalTarget).toBe(false);
    expect(classifySelfEvolutionObjectiveQuality('').hasTechnicalTarget).toBe(false);
  });
  it('缺陷词 → 永远算技术目标（缺陷天然具体）', () => {
    expect(classifySelfEvolutionObjectiveQuality('修复前缀越界 bug').hasTechnicalTarget).toBe(true);
    expect(classifySelfEvolutionObjectiveQuality('内存泄漏导致崩溃').hasTechnicalTarget).toBe(true);
  });
  it('技术对象 + 动作 / 文件路径 / 可量化指标 → 技术目标', () => {
    expect(classifySelfEvolutionObjectiveQuality('重构 NoeGoalSystem 的状态机逻辑').hasTechnicalTarget).toBe(true);
    expect(classifySelfEvolutionObjectiveQuality('优化 src/loop/ActPipeline.js 的并发').hasTechnicalTarget).toBe(true);
    expect(classifySelfEvolutionObjectiveQuality('改进自身的期望结算率').hasTechnicalTarget).toBe(true);
  });
  // 红队修复：情绪句塞单个泛技术词（率/机制/流程/接口/配置）不再穿透质量闸（无强锚 → 拒）。
  it('红队修复：情绪句 + 单个泛词（无强锚）→ 拒（堵泛词穿透）', () => {
    const reject = [
      '改自己，让这个机制给我更踏实的安全感',
      '改自己，提高我的幸福率和满足率',
      '改进自身，优化陪伴流程让我更安心',
      '改进自己，给我一个温柔的接口陪我聊天',
      '改自己的配置让我更安心',
    ];
    for (const o of reject) expect(classifySelfEvolutionObjectiveQuality(o).hasTechnicalTarget).toBe(false);
  });
  it('强锚（文件路径 / 函数调用 / snake_case）即便带情绪也立项（有具体对象就放手）', () => {
    expect(classifySelfEvolutionObjectiveQuality('改进自己 src/feel/warmth.js 让我更温柔').hasTechnicalTarget).toBe(true);
    expect(classifySelfEvolutionObjectiveQuality('改自己，修 computeReward() 让我更踏实').hasTechnicalTarget).toBe(true);
    expect(classifySelfEvolutionObjectiveQuality('改自己的 task_reportback 队列').hasTechnicalTarget).toBe(true);
  });
});

// Step 1（飞轮停摆修复·两方审 finding 4）：autoseed 质量闸堵「诗性观感词 + 泛技术词」穿透。
//   实测 bug：'看着技能卡，想看 Noe 敲代码指尖起落的节奏' 旧判 tech_object（泛词"代码"命中、情绪正则未挡）→
//   立成注定被 post_review 拒绝的诗性目标、占坑堵死供给链（2026-06-24 飞轮停摆铁证 cycle）。
//   strictPoetic（server 按 flag NOE_SELFEVO_STRICT_AUTOSEED 传）ON 时堵掉；默认 OFF 零回归。
describe('classifySelfEvolutionObjectiveQuality strictPoetic（堵诗性词穿透·flag 默认 OFF）', () => {
  const POETIC = '看着技能卡，想看 Noe 敲代码指尖起落的节奏';
  it('strictPoetic=true：诗性观感目标（含泛技术词、无强锚）→ 情绪碎片不立项', () => {
    const r = classifySelfEvolutionObjectiveQuality(POETIC, { strictPoetic: true });
    expect(r.hasTechnicalTarget).toBe(false);
    expect(r.reason).toBe('poetic_fragment');
  });
  it('strictPoetic=true：真技术目标（强锚/缺陷/动作）不误杀', () => {
    expect(classifySelfEvolutionObjectiveQuality('修复 src/room/NoeSelfEvolutionTrigger.js 的 observe 去重 bug', { strictPoetic: true }).hasTechnicalTarget).toBe(true);
    expect(classifySelfEvolutionObjectiveQuality('重构 NoeGoalSystem 的状态机逻辑', { strictPoetic: true }).hasTechnicalTarget).toBe(true);
    expect(classifySelfEvolutionObjectiveQuality('优化 src/loop/ActPipeline.js 的并发', { strictPoetic: true }).hasTechnicalTarget).toBe(true);
  });
  // 多模型审 P2-4：诗性词 + 技术动作（无强锚的自然语言技术目标）不该被误杀——诗性检测须让位于「有可执行动作」。
  it('strictPoetic=true：技术动作词+诗性词（"优化…节奏算法"）不误杀（有 action 放行）', () => {
    expect(classifySelfEvolutionObjectiveQuality('改进自身：优化目标调度节奏算法', { strictPoetic: true }).hasTechnicalTarget).toBe(true);
    expect(classifySelfEvolutionObjectiveQuality('重构请求节奏控制的限流逻辑', { strictPoetic: true }).hasTechnicalTarget).toBe(true);
  });
  it('strictPoetic=false（默认）：行为与现状逐字一致（诗性目标仍穿透 = 零回归）', () => {
    const r = classifySelfEvolutionObjectiveQuality(POETIC);
    expect(r.hasTechnicalTarget).toBe(true);
    expect(r.reason).toBe('tech_object');
  });

  // 立项闸 #24（互审否决·诚实备书）：曾试 meta_bookkeeping 关键词判据拦 skill-card 目标，三子代理+主线亲核一致证明
  //   关键词黑名单判价值弊大于利——①裸词"里程碑"误伤真技术("重构里程碑状态机"被误杀,里程碑是本库一等概念)②顺序错误杀
  //   "把召回率优化记成技能卡"③鸡肋(纯记账无技术词本就落 no_technical_anchor,增量全在该交盖章点的灰色地带)。已撤回——
  //   skill-card 假进化交盖章点 substance 闸拦(产物 docs/skill-cards/*.md 实测 4/5)。立项闸本职=判"有无技术着力点"非"判价值"。
  it('立项闸不误伤含"里程碑"的真技术目标（撤回 meta_bookkeeping 后·strictPoetic ON 也放行）', () => {
    expect(classifySelfEvolutionObjectiveQuality('重构里程碑状态机', { strictPoetic: true }).hasTechnicalTarget).toBe(true);
    expect(classifySelfEvolutionObjectiveQuality('把召回率优化记成技能卡', { strictPoetic: true }).hasTechnicalTarget).toBe(true);
    expect(classifySelfEvolutionObjectiveQuality('给版本发布流程加里程碑校验机制', { strictPoetic: true }).hasTechnicalTarget).toBe(true);
  });
  it('skill-card 自指目标立项闸放行（含泛技术词"代码"→tech_object，交盖章点 substance 闸拦产物 docs/skill-cards/*.md）', () => {
    expect(classifySelfEvolutionObjectiveQuality('把「系统自修复：语音链路」记成技能卡，这比单纯跑通代码更让我踏实', { strictPoetic: true }).hasTechnicalTarget).toBe(true);
  });
});

describe('observe — 立项 + 防上瘾', () => {
  it('非信号 → not_self_evolution_signal', () => {
    const t = createNoeSelfEvolutionTrigger({ goalSystem: mockGoalSystem(), now: () => 10_000_000 });
    expect(t.observe({ text: '今天吃什么' })).toEqual({ ok: false, reason: 'not_self_evolution_signal' });
  });

  it('信号 + 无 open + add 成功 → ok + goalId', () => {
    const gs = mockGoalSystem({ addReturns: 'g-1' });
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, now: () => 10_000_000 });
    const r = t.observe({ objective: '改进自身的期望结算率' });
    expect(r).toEqual({ ok: true, goalId: 'g-1' });
    expect(gs.add).toHaveBeenCalledTimes(1);
    expect(gs.add.mock.calls[0][0].source).toBe('self_evolution');
  });

  it('cooldown：同窗口内第二次信号被拦', () => {
    const gs = mockGoalSystem({ addReturns: 'g-1' });
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, now: () => 10_000_000, cooldownMs: 30 * 60_000 });
    expect(t.observe({ objective: '改进自己' }).ok).toBe(true);
    expect(t.observe({ objective: '再改进自己' })).toMatchObject({ ok: false, reason: 'cooldown' });
    expect(gs.add).toHaveBeenCalledTimes(1);
  });

  it('open 去重：已有未完成自进化目标则不新立', () => {
    const gs = mockGoalSystem({ openGoals: [{ id: 'g-open', source: 'self_evolution', status: 'open' }] });
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, now: () => 10_000_000 });
    expect(t.observe({ objective: '改进自己' })).toMatchObject({ ok: false, reason: 'open_self_evolution_goal_exists', goalId: 'g-open' });
    expect(gs.add).not.toHaveBeenCalled();
  });

  it('add 被拒（同名/积压）→ goal_add_rejected，不消耗 cooldown', () => {
    const gs = mockGoalSystem({ addReturns: null });
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, now: () => 10_000_000 });
    expect(t.observe({ objective: '改进自己' })).toMatchObject({ ok: false, reason: 'goal_add_rejected' });
    // 未成功立项 → cooldown 未起，下次仍能尝试（这里再给个 open，验证 lastObserveAt 没被设）
    expect(t.observe({ objective: '改进自己' }).reason).toBe('goal_add_rejected');
  });

  // P0-4 质量闸：requireTechnicalTarget=true 时情绪目标不立项、返回 clarification（不静默丢）。
  it('requireTechnicalTarget=true：情绪目标 → no_technical_target + clarification（不立项、不耗 cooldown）', () => {
    const gs = mockGoalSystem({ addReturns: 'g-x' });
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, now: () => 10_000_000, requireTechnicalTarget: true });
    const r = t.observe({ objective: '改进自己让自己更踏实' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_technical_target');
    expect(typeof r.clarification).toBe('string');
    expect(gs.add).not.toHaveBeenCalled();
    // 不耗 cooldown：随后给技术目标仍能立项
    expect(t.observe({ objective: '改进自身：修复 NoeMissionStore 前缀越界 bug' })).toEqual({ ok: true, goalId: 'g-x' });
  });

  it('requireTechnicalTarget=true：技术目标 → 正常立项', () => {
    const gs = mockGoalSystem({ addReturns: 'g-y' });
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, now: () => 10_000_000, requireTechnicalTarget: true });
    expect(t.observe({ objective: '改进自身：优化 src/loop/ActPipeline.js 并发' })).toEqual({ ok: true, goalId: 'g-y' });
  });

  it('默认 requireTechnicalTarget=false：情绪目标仍按旧逻辑立项（向后兼容）', () => {
    const gs = mockGoalSystem({ addReturns: 'g-z' });
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, now: () => 10_000_000 });
    expect(t.observe({ objective: '改进自己' })).toEqual({ ok: true, goalId: 'g-z' });
  });

  // Step 1（飞轮停摆 finding 4）：strictAutoseed=true 时 observe 把 strictPoetic 透传质量闸，堵诗性目标穿透立项。
  it('strictAutoseed=true + requireTechnicalTarget：诗性目标被堵（no_technical_target，不立项）', () => {
    const gs = mockGoalSystem({ addReturns: 'g-1' });
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, now: () => 10_000_000, requireTechnicalTarget: true, strictAutoseed: true });
    const r = t.observe({ objective: '改自己：看着技能卡想看 Noe 敲代码指尖起落的节奏' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_technical_target');
    expect(gs.add).not.toHaveBeenCalled();
  });
  it('strictAutoseed=true：真技术目标不误杀（仍正常立项）', () => {
    const gs = mockGoalSystem({ addReturns: 'g-2' });
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, now: () => 10_000_000, requireTechnicalTarget: true, strictAutoseed: true });
    expect(t.observe({ objective: '改进自身：修复 src/room/NoeSelfEvolutionTrigger.js observe 去重 bug' })).toEqual({ ok: true, goalId: 'g-2' });
  });
  it('strictAutoseed=false（默认）：诗性目标仍按旧逻辑穿透立项（零回归）', () => {
    const gs = mockGoalSystem({ addReturns: 'g-3' });
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, now: () => 10_000_000, requireTechnicalTarget: true });
    expect(t.observe({ objective: '改自己：看着技能卡想看 Noe 敲代码指尖起落的节奏' })).toEqual({ ok: true, goalId: 'g-3' });
  });

  // 改动3（learning 反馈闭环）：lessonAwareAutoseed ON 时 observe 在质量闸后召回近重复 reject lesson → hard block。
  it('改动3: ON + 近重复被拒 → similar_to_rejected_lesson（不立项,不耗 cooldown）', () => {
    const gs = mockGoalSystem({ addReturns: 'g-1' });
    // stub 按 objective 区分：仅 ActPipeline 类判近重复，其余放行——以验证「被拦不耗 cooldown，换目标仍能立」。
    const recallRejectLessons = vi.fn((obj) => (String(obj).includes('ActPipeline')
      ? { similar: true, lessonObjective: '优化 ActPipeline 并发调度', reason: 'near_duplicate_rejected' }
      : { similar: false }));
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, now: () => 10_000_000, requireTechnicalTarget: true, lessonAwareAutoseed: true, recallRejectLessons });
    const r = t.observe({ objective: '改进自身：优化 ActPipeline 的并发调度算法' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('similar_to_rejected_lesson');
    expect(typeof r.clarification).toBe('string');
    expect(gs.add).not.toHaveBeenCalled();
    expect(recallRejectLessons).toHaveBeenCalledTimes(1);
    expect(t.observe({ objective: '改进自身：修复 src/foo.js 的越界 bug' }).ok).toBe(true); // 不耗 cooldown
  });
  it('改动3: ON + 不同(similar:false) → 正常立项', () => {
    const gs = mockGoalSystem({ addReturns: 'g-2' });
    const recallRejectLessons = vi.fn(() => ({ similar: false }));
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, now: () => 10_000_000, requireTechnicalTarget: true, lessonAwareAutoseed: true, recallRejectLessons });
    expect(t.observe({ objective: '改进自身：优化 src/bar.js 性能' })).toEqual({ ok: true, goalId: 'g-2' });
  });
  it('改动3: OFF(默认) → 不调 recall，正常立项（零回归）', () => {
    const gs = mockGoalSystem({ addReturns: 'g-3' });
    const recallRejectLessons = vi.fn(() => ({ similar: true }));
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, now: () => 10_000_000, requireTechnicalTarget: true, recallRejectLessons });
    expect(t.observe({ objective: '改进自身：优化 src/baz.js' }).ok).toBe(true);
    expect(recallRejectLessons).not.toHaveBeenCalled();
  });
  it('改动3: ON + recall 抛错 → fail-open 正常立项（不阻断飞轮）', () => {
    const gs = mockGoalSystem({ addReturns: 'g-4' });
    const recallRejectLessons = vi.fn(() => { throw new Error('boom'); });
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, now: () => 10_000_000, requireTechnicalTarget: true, lessonAwareAutoseed: true, recallRejectLessons });
    expect(t.observe({ objective: '改进自身：优化 src/qux.js' }).ok).toBe(true);
  });
});

describe('tick — 单 writer 推进 Cycle', () => {
  it('无 goalId → goal_id_required', async () => {
    const t = createNoeSelfEvolutionTrigger({ cycleStore: mockCycleStore() });
    expect(await t.tick({})).toMatchObject({ ok: false, reason: 'goal_id_required' });
  });

  it('cycle 不存在 → 建草案；loop=consensus_blocked → 不 propose', async () => {
    const cs = mockCycleStore({ getByGoal: null });
    const propose = vi.fn();
    const t = createNoeSelfEvolutionTrigger({ goalSystem: mockGoalSystem(), cycleStore: cs, propose });
    const r = await t.tick({ goalId: 'goal-1' });
    expect(cs.upsert).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: true, proposed: false, stage: 'consensus_blocked' });
    expect(propose).not.toHaveBeenCalled();
  });

  it('loop=implementation_ready → propose noe.self_evolution.implementation', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'implementation_ready', nextAction: 'codex_minimal_implementation' });
    const cs = mockCycleStore({ getByGoal: { cycleId: 'c-9', goalId: 'goal-1', goal: 'g', ledger: {}, authorization: {} } });
    const propose = vi.fn(async () => ({ ok: true, act: { id: 'act-1' } }));
    const t = createNoeSelfEvolutionTrigger({ cycleStore: cs, propose });
    const r = await t.tick({ goalId: 'goal-1' });
    expect(r).toMatchObject({ ok: true, proposed: true, action: 'noe.self_evolution.implementation', cycleId: 'c-9' });
    expect(propose).toHaveBeenCalledTimes(1);
    const input = propose.mock.calls[0][0];
    expect(input.action).toBe('noe.self_evolution.implementation');
    expect(input.selfEvolution.action).toBe('implementation');
    expect(input.proposedBy).toBe('noe-self-evolution-trigger');
  });

  it('P2：propose 的 selfEvolution.objective 始终从 cycle.goal 灌（非空，修历史 drill 空 objective）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'implementation_ready', nextAction: 'codex_minimal_implementation' });
    // 复现历史空 objective 条件：cycle 只有 goal 字段、无 objective 字段。
    const cs = mockCycleStore({ getByGoal: { cycleId: 'c-obj', goalId: 'goal-1', goal: '修复 NoeMissionRunner 前缀越界' } });
    const propose = vi.fn(async () => ({ ok: true }));
    const t = createNoeSelfEvolutionTrigger({ cycleStore: cs, propose });
    await t.tick({ goalId: 'goal-1' });
    const input = propose.mock.calls[0][0];
    expect(input.selfEvolution.objective).toBe('修复 NoeMissionRunner 前缀越界'); // 从 cycle.goal 灌 → implementer 不再拿空目标
  });

  it('P2 闭环：post_review_required + assembleCompletion ok → advance cycle（自驱解锁 stuck stage）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'post_review_required', nextAction: 'request_non_implementer_post_review' });
    const cycle = { cycleId: 'c-pr', goalId: 'goal-1', goal: 'g' };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn(() => ({ ok: true, cycle: { ...cycle, postReview: { ok: true } } })) };
    const assembleCompletion = vi.fn(async () => ({ ok: true, patch: { postReview: { ok: true, reviews: [] } } }));
    const t = createNoeSelfEvolutionTrigger({ cycleStore: cs, assembleCompletion });
    await t.tick({ goalId: 'goal-1' });
    expect(assembleCompletion).toHaveBeenCalledWith({ stage: 'post_review_required', cycle });
    expect(cs.advance).toHaveBeenCalledWith('c-pr', { postReview: { ok: true, reviews: [] } });
  });

  it('P2 安全：assembleCompletion ok:false（post_review 拒）→ 不 advance，保持 blocked（坏 cycle 不盖章）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'post_review_required', nextAction: 'request_non_implementer_post_review' });
    const cycle = { cycleId: 'c-pr2', goalId: 'goal-1', goal: 'g' };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn() };
    const assembleCompletion = vi.fn(async () => ({ ok: false, reason: 'post_review_not_approved' }));
    const t = createNoeSelfEvolutionTrigger({ cycleStore: cs, assembleCompletion });
    const r = await t.tick({ goalId: 'goal-1' });
    expect(cs.advance).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, proposed: false, stage: 'post_review_required' });
  });

  // Step 2'（飞轮停摆核心）：post_review 真拒（reviewer 明确 reject/request_changes）→ 学习 + 写 terminal artifact + 快速释放坑位，
  //   不再卡死重试到 60 拍 drop（浪费 cycle + 占坑 28h 堵供给链）。区分真拒 vs 暂时失败（复核器不可用/网络）。flag rejectLearning 默认 OFF。
  it('Step2: rejectLearning ON + reviewer reject → recordFailureLesson + terminal artifact + drop goal(快速释放)', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'post_review_required', nextAction: 'x' });
    const cycle = { cycleId: 'c-rej', goalId: 'goal-1', goal: 'g', objective: '诗性目标' };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn(() => ({ ok: true, cycle })) };
    const gs = { list: vi.fn(() => []), add: vi.fn(), get: vi.fn(), setStatus: vi.fn(() => true) };
    const assembleCompletion = vi.fn(async () => ({ ok: false, reason: 'post_review_not_approved', reviews: [{ model: 'm3', decision: 'reject' }, { model: 'local-qwen', decision: 'approve' }], errors: ['目标模糊', '无测试'] }));
    const recordFailureLesson = vi.fn();
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, assembleCompletion, recordFailureLesson, rejectLearning: true });
    const r = await t.tick({ goalId: 'goal-1' });
    expect(recordFailureLesson).toHaveBeenCalledTimes(1);
    expect(recordFailureLesson.mock.calls[0][0]).toMatchObject({ cycleId: 'c-rej', goalId: 'goal-1', reason: 'post_review_not_approved' });
    expect(cs.advance).toHaveBeenCalledWith('c-rej', expect.objectContaining({ postReviewFailure: expect.objectContaining({ terminal: true }) }));
    expect(gs.setStatus).toHaveBeenCalledWith('goal-1', 'dropped');
    expect(r).toMatchObject({ goalDropped: true, reason: 'post_review_rejected_learned' });
  });
  it('Step2: rejectLearning ON + 暂时失败(post_review_failed,无reject decision) → 不学习不drop,保留重试', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'post_review_required', nextAction: 'x' });
    const cycle = { cycleId: 'c-tmp', goalId: 'goal-1', goal: 'g' };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn() };
    const gs = { list: vi.fn(() => []), add: vi.fn(), get: vi.fn(), setStatus: vi.fn(() => true) };
    const assembleCompletion = vi.fn(async () => ({ ok: false, reason: 'post_review_failed', error: 'TLS' }));
    const recordFailureLesson = vi.fn();
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, assembleCompletion, recordFailureLesson, rejectLearning: true });
    await t.tick({ goalId: 'goal-1' });
    expect(recordFailureLesson).not.toHaveBeenCalled();
    expect(gs.setStatus).not.toHaveBeenCalled();
  });
  it('Step2: rejectLearning ON + quorum因unavailable不足(无明确reject decision) → 不学习不drop,保留重试', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'post_review_required', nextAction: 'x' });
    const cycle = { cycleId: 'c-unavail', goalId: 'goal-1', goal: 'g' };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn() };
    const gs = { list: vi.fn(() => []), add: vi.fn(), get: vi.fn(), setStatus: vi.fn(() => true) };
    const assembleCompletion = vi.fn(async () => ({ ok: false, reason: 'post_review_not_approved', reviews: [{ model: 'local-qwen', decision: 'approve' }, { model: 'm3', decision: 'unavailable' }] }));
    const recordFailureLesson = vi.fn();
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, assembleCompletion, recordFailureLesson, rejectLearning: true });
    await t.tick({ goalId: 'goal-1' });
    expect(recordFailureLesson).not.toHaveBeenCalled();
    expect(gs.setStatus).not.toHaveBeenCalled();
  });
  it('Step2: rejectLearning OFF(默认) + reviewer reject → 行为与现状一致(不advance/不学习/不drop,保持blocked)', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'post_review_required', nextAction: 'x' });
    const cycle = { cycleId: 'c-off2', goalId: 'goal-1', goal: 'g' };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn() };
    const gs = { list: vi.fn(() => []), add: vi.fn(), get: vi.fn(), setStatus: vi.fn(() => true) };
    const assembleCompletion = vi.fn(async () => ({ ok: false, reason: 'post_review_not_approved', reviews: [{ decision: 'reject' }] }));
    const recordFailureLesson = vi.fn();
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, assembleCompletion, recordFailureLesson });
    const r = await t.tick({ goalId: 'goal-1' });
    expect(recordFailureLesson).not.toHaveBeenCalled();
    expect(gs.setStatus).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, proposed: false, stage: 'post_review_required' });
  });

  // 多模型审 P1-3：request_changes 是返工信号（非"不可救"），不该和 reject 一起 terminal 学习+丢弃。
  it('Step2 审P1-3: request_changes 不算 terminal reject → 不学习不drop（留返工）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'post_review_required', nextAction: 'x' });
    const cycle = { cycleId: 'c-rc', goalId: 'goal-1', goal: 'g' };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn(() => ({ ok: true, cycle })) };
    const gs = { list: vi.fn(() => []), add: vi.fn(), get: vi.fn(), setStatus: vi.fn(() => true) };
    const assembleCompletion = vi.fn(async () => ({ ok: false, reason: 'post_review_not_approved', reviews: [{ model: 'm3', decision: 'request_changes' }] }));
    const recordFailureLesson = vi.fn();
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, assembleCompletion, recordFailureLesson, rejectLearning: true });
    await t.tick({ goalId: 'goal-1' });
    expect(recordFailureLesson).not.toHaveBeenCalled();
    expect(gs.setStatus).not.toHaveBeenCalled();
  });
  // 多模型审 P0-2：terminal artifact 写入失败时不得释放 goal（否则 goal 已 drop 但 postReviewFailure 没落库，审计链断）。
  it('Step2 审P0-2: terminal artifact(advance) 写入失败 → 不drop（保留cycle，审计不断）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'post_review_required', nextAction: 'x' });
    const cycle = { cycleId: 'c-advfail', goalId: 'goal-1', goal: 'g' };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn(() => ({ ok: false, errors: ['db_lock'] })) };
    const gs = { list: vi.fn(() => []), add: vi.fn(), get: vi.fn(), setStatus: vi.fn(() => true) };
    const assembleCompletion = vi.fn(async () => ({ ok: false, reason: 'post_review_not_approved', reviews: [{ decision: 'reject' }] }));
    const recordFailureLesson = vi.fn();
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, assembleCompletion, recordFailureLesson, rejectLearning: true });
    const r = await t.tick({ goalId: 'goal-1' });
    expect(gs.setStatus).not.toHaveBeenCalledWith('goal-1', 'dropped');
    expect(r.goalDropped).not.toBe(true);
  });

  it('A4 realApply=OFF（默认）+ implementation_ready → propose 不带 realExecute（维持 dry-run）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'implementation_ready', nextAction: 'codex_minimal_implementation' });
    const cycle = { cycleId: 'c-off', goalId: 'g-off', goal: 'g' };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn(() => ({ ok: true, cycle })) };
    const propose = vi.fn(async () => ({ ok: true, act: { id: 'a' } }));
    const t = createNoeSelfEvolutionTrigger({ cycleStore: cs, propose });
    await t.tick({ goalId: 'g-off' });
    expect(propose.mock.calls[0][0].realExecute).toBeUndefined();
    expect(cs.advance).not.toHaveBeenCalled();
  });

  it('A4 realApply=ON + implementation_ready → propose 带 realExecute(不传 riskLevel)，B5 从 executorResult 回写 cycle', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'implementation_ready', nextAction: 'codex_minimal_implementation' });
    const cycle = { cycleId: 'c-ra', goalId: 'g-ra', goal: 'g' };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn(() => ({ ok: true, cycle })) };
    // 真实 ActPipeline.#executeReal 返回形状：{ok, act, executorResult}，ref 在 executorResult 顶层（不在 act.result）
    const propose = vi.fn(async () => ({ ok: true, act: { id: 'a' }, executorResult: { applyReportRef: 'output/ap.json', runtimeReportRef: 'output/rt.json' } }));
    const t = createNoeSelfEvolutionTrigger({ cycleStore: cs, propose, realApply: true });
    const r = await t.tick({ goalId: 'g-ra' });
    expect(propose.mock.calls[0][0].realExecute).toBe(true);
    expect(propose.mock.calls[0][0].riskLevel).toBeUndefined();
    expect(cs.advance).toHaveBeenCalled();
    expect(cs.advance.mock.calls[0][1].implementation).toMatchObject({ ok: true, applyReportRef: 'output/ap.json' });
    expect(cs.advance.mock.calls[0][1].runtimeVerification).toMatchObject({ reportRef: 'output/rt.json' });
    expect(r.advancedByResult).toBe(true);
  });

  // Finding 3（总验收三轮·多模型）：executor 返回的真实 patchPlanRef（原始 patch plan，≠ applyReportRef）须被保留进
  //   cycle.implementation.patchPlanRef（可追溯性），原回写丢弃。
  it('Finding3：implementation 成功回写保留 executor 的 patchPlanRef（可追溯性）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'implementation_ready', nextAction: 'codex_minimal_implementation' });
    const cycle = { cycleId: 'c-pp', goalId: 'g-pp', goal: 'g' };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn(() => ({ ok: true, cycle })) };
    const propose = vi.fn(async () => ({ ok: true, act: { id: 'a' }, executorResult: { patchPlanRef: 'output/patch-plan/pp-abc.json', applyReportRef: 'output/ap.json', diffRef: 'output/ap.json', runtimeReportRef: 'output/rt.json', runtimeOk: true, touchedFiles: ['x.js'] } }));
    const t = createNoeSelfEvolutionTrigger({ cycleStore: cs, propose, realApply: true });
    await t.tick({ goalId: 'g-pp' });
    expect(cs.advance.mock.calls[0][1].implementation).toMatchObject({ patchPlanRef: 'output/patch-plan/pp-abc.json', applyReportRef: 'output/ap.json', diffRef: 'output/ap.json' });
  });

  // Finding 2（complete 控制链根因）：原代码 memory_writeback 非改码动作 → 不带 realExecute → 永远 dry-run
  //   （executor 不跑、记忆不写、cycle.memoryWriteback 永不回填）→ cycle 永不到 complete、DB complete=0。
  //   修复：realApply=ON 时 memory_writeback 也真执行（写脱敏记忆）+ 灌 summary + 成功回写 memoryWriteback done。
  it('Finding2：realApply=ON + memory_writeback → 带 realExecute、灌脱敏 summary、成功回写 memoryWriteback done（→complete）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'memory_writeback_ready', nextAction: 'write_confirmed_memory_summary' });
    const cycle = { cycleId: 'c-mw', goalId: 'g-mw', goal: '修 X', implementation: { touchedFiles: ['a.js'] }, runtimeVerification: { ok: true }, postReview: { ok: true } };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn(() => ({ ok: true, cycle })) };
    const propose = vi.fn(async () => ({ ok: true, act: {}, executorResult: { memoryId: 'm-1', summaryRef: 'output/noe-self-evolution/memory-writeback/s.md' } }));
    const t = createNoeSelfEvolutionTrigger({ cycleStore: cs, propose, realApply: true });
    const r = await t.tick({ goalId: 'g-mw' });
    expect(propose.mock.calls[0][0].realExecute).toBe(true);
    // 灌入脱敏 summary（仅元信息，无 diff/secret）；否则 executor throw self_evolution_memory_summary_required
    expect(propose.mock.calls[0][0].selfEvolution.memoryWriteback.summary).toContain('自我进化');
    expect(propose.mock.calls[0][0].selfEvolution.memoryWriteback.summary).not.toContain('a.js'); // 只写文件数不写路径
    // 成功 → 回写 memoryWriteback done（含 summaryRef，满足 complete 完整校验 cycle_memory_summary_ref）→ cycle 推进到 complete
    //   （cycle.memoryWriteback 此处无 prior → 合并后仅 ok/done/memoryId/summaryRef）
    expect(cs.advance).toHaveBeenCalledWith('c-mw', { memoryWriteback: { ok: true, done: true, memoryId: 'm-1', summaryRef: 'output/noe-self-evolution/memory-writeback/s.md' } });
    expect(r.advancedByResult).toBe(true);
  });

  it('Finding2 反向 probe：memory_writeback act 失败（ok:false）→ 绝不回写（不假绿到 complete）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'memory_writeback_ready', nextAction: 'write_confirmed_memory_summary' });
    const cycle = { cycleId: 'c-mwf', goalId: 'g-mwf', goal: 'g' };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn(() => ({ ok: true, cycle })) };
    const propose = vi.fn(async () => ({ ok: false, error: 'self_evolution_memory_summary_required' }));
    const t = createNoeSelfEvolutionTrigger({ cycleStore: cs, propose, realApply: true });
    const r = await t.tick({ goalId: 'g-mwf' });
    expect(cs.advance).not.toHaveBeenCalled();
    expect(r.advancedByResult).toBe(false);
  });

  it('Finding2 反向 probe：realApply=OFF（shadow）+ memory_writeback → 不带 realExecute、不回写（零回归）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'memory_writeback_ready', nextAction: 'write_confirmed_memory_summary' });
    const cycle = { cycleId: 'c-mws', goalId: 'g-mws', goal: 'g' };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn(() => ({ ok: true, cycle })) };
    const propose = vi.fn(async () => ({ ok: true, act: {} }));
    const t = createNoeSelfEvolutionTrigger({ cycleStore: cs, propose }); // realApply 未开
    await t.tick({ goalId: 'g-mws' });
    expect(propose.mock.calls[0][0].realExecute).toBeUndefined();
    expect(cs.advance).not.toHaveBeenCalled();
  });

  // Finding 3（complete 控制链）：implementation verify 失败时 executor 自动 rollback 并 throw needsSelfRepair，
  //   ActPipeline catch 保留结构化字段到 actResult.selfEvolution → trigger 回写 impl done+runtime:false →
  //   loop 转 self_repair_ready（原：cycle 不记录 → 卡 implementation_ready 反复重试，永不进 self_repair）。
  it('Finding3：realApply=ON + implementation verify 失败(needsSelfRepair) → 回写 impl done+runtime:false（→self_repair_ready）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'implementation_ready', nextAction: 'codex_minimal_implementation' });
    const cycle = { cycleId: 'c-sr', goalId: 'g-sr', goal: 'g' };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn(() => ({ ok: true, cycle })) };
    const propose = vi.fn(async () => ({ ok: false, error: 'self_evolution_verify_failed_rolled_back_needs_self_repair', selfEvolution: { needsSelfRepair: true, applyReportRef: 'output/ap.json', runtimeReportRef: 'output/rt.json' } }));
    const t = createNoeSelfEvolutionTrigger({ cycleStore: cs, propose, realApply: true });
    const r = await t.tick({ goalId: 'g-sr' });
    // CRITICAL-2：advance 必带 repairReturnsToConsensus:true + failedVerificationRef，否则 self_repair gate 恒 false →
    //   loop 算 self_repair_BLOCKED（不可达）→ Finding-3 路由到死胡同。
    // Perception ring: also persists lastImproveSignal (verify_not_green) for self_repair anchors.
    expect(cs.advance).toHaveBeenCalledWith('c-sr', expect.objectContaining({
      implementation: { ok: true, applyReportRef: 'output/ap.json', diffRef: 'output/ap.json' },
      runtimeVerification: { ok: false, reportRef: 'output/rt.json' },
      repairReturnsToConsensus: true,
      failedVerificationRef: 'output/rt.json',
      lastImproveSignal: expect.objectContaining({
        signal: 'verify_not_green',
        kind: 'neo.self-evolution.improve-signal.v1',
      }),
    }));
    expect(r.advancedByResult).toBe(true); // cycle 真前进 → 算进展不卡死
  });

  it('Finding3/M3：self_repair 自身失败(needsConsensus,非 needsSelfRepair)→ 不 advance、计卡死→drop（有界,无无限循环）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'self_repair_ready', nextAction: 'return_to_consensus_for_repair' });
    const cs = mockCycleStore({ getByGoal: { cycleId: 'c-srf', goalId: 'g-srf', goal: 'g', implementation: { ok: true }, runtimeVerification: { ok: false } } });
    cs.advance = vi.fn(() => ({ ok: true }));
    const gs = { ...mockGoalSystem(), setStatus: vi.fn(() => true) };
    // self_repair 执行器失败 throw self_repair_failed_needs_consensus（needsConsensus，非 needsSelfRepair）
    const propose = vi.fn(async () => ({ ok: false, error: 'self_repair_failed_needs_consensus', selfEvolution: { needsConsensus: true, applyReportRef: 'output/ap2.json' } }));
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, propose, realApply: true, maxNonProgressTicks: 2 });
    expect((await t.tick({ goalId: 'g-srf' })).goalDropped).toBeUndefined(); // count=1（needsConsensus 不进 Finding-3 分支 → 不 advance）
    expect(cs.advance).not.toHaveBeenCalled();
    const r2 = await t.tick({ goalId: 'g-srf' }); // count=2 → drop（有界，证伪 M3 的「无限循环」）
    expect(r2.goalDropped).toBe(true);
  });

  it('M3 防假绿：memory_writeback executor 落盘失败(summaryWritten=false)→ summaryRef 回退到 retrospective 设的 priorMw.summaryRef', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'memory_writeback_ready', nextAction: 'write_confirmed_memory_summary' });
    const cycle = { cycleId: 'c-mwfb', goalId: 'g-mwfb', goal: 'g', memoryWriteback: { consensusAck: true, summaryRef: 'output/retro.md' } };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn(() => ({ ok: true, cycle })) };
    // executor 真写记忆成功但 artifact 落盘失败：summaryWritten=false + 仍返回一个 summaryRef（指向没写成的文件）
    const propose = vi.fn(async () => ({ ok: true, act: {}, executorResult: { memoryId: 'm-9', summaryRef: 'output/missing.md', summaryWritten: false } }));
    const t = createNoeSelfEvolutionTrigger({ cycleStore: cs, propose, realApply: true });
    await t.tick({ goalId: 'g-mwfb' });
    // 不用没写成的 missing.md，回退到 retrospective 的真实存在 ref（防 complete 虚高）
    expect(cs.advance).toHaveBeenCalledWith('c-mwfb', { memoryWriteback: { consensusAck: true, ok: true, done: true, memoryId: 'm-9', summaryRef: 'output/retro.md' } });
  });

  it('Finding3 反向 probe：implementation 硬失败(无 needsSelfRepair，如 preflight blocked) → 不路由 self_repair、照常计卡死', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'implementation_ready', nextAction: 'codex_minimal_implementation' });
    const cs = mockCycleStore({ getByGoal: { cycleId: 'c-hf', goalId: 'g-hf', goal: 'g' } });
    cs.advance = vi.fn(() => ({ ok: true }));
    const gs = { ...mockGoalSystem(), setStatus: vi.fn(() => true) };
    const propose = vi.fn(async () => ({ ok: false, error: 'self_evolution_apply_preflight_blocked', selfEvolution: { blockers: ['x'] } }));
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, propose, realApply: true, maxNonProgressTicks: 2 });
    expect((await t.tick({ goalId: 'g-hf' })).goalDropped).toBeUndefined(); // count=1
    const r2 = await t.tick({ goalId: 'g-hf' }); // count=2 → drop
    expect(cs.advance).not.toHaveBeenCalled();
    expect(r2.goalDropped).toBe(true);
  });

  it('realApply=ON + complete → 带 realExecute（complete executor 真记完成事件）+ 成功关 goal', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'complete', nextAction: 'handoff_or_continue_next_goal' });
    const cs = mockCycleStore({ getByGoal: { cycleId: 'c-cr', goalId: 'goal-cr', goal: 'g' } });
    const gs = { ...mockGoalSystem(), setStatus: vi.fn(() => true) };
    const propose = vi.fn(async () => ({ ok: true, executorResult: { completed: true } }));
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, propose, realApply: true });
    const r = await t.tick({ goalId: 'goal-cr' });
    expect(propose.mock.calls[0][0].realExecute).toBe(true);
    expect(gs.setStatus).toHaveBeenCalledWith('goal-cr', 'done');
    expect(r.goalClosed).toBe(true);
  });

  it('loop=complete → propose noe.self_evolution.complete', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'complete', nextAction: 'handoff_or_continue_next_goal' });
    const cs = mockCycleStore({ getByGoal: { cycleId: 'c-10', goalId: 'goal-2', goal: 'g' } });
    const propose = vi.fn(async () => ({ ok: true }));
    const t = createNoeSelfEvolutionTrigger({ cycleStore: cs, propose });
    const r = await t.tick({ goalId: 'goal-2' });
    expect(r.action).toBe('noe.self_evolution.complete');
  });

  // P0-2 生命周期闭环：self_evolution goal 被通用 close/nextStep 豁免（防 bootstrap 步切断心跳），
  //   故必须由 cycle 走到 complete 时显式关 goal，否则 goal 永 open、心跳无限重提 complete。
  it('loop=complete + complete act 成功 → 关 goal（setStatus done）+ goalClosed:true', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'complete', nextAction: 'handoff_or_continue_next_goal' });
    const cs = mockCycleStore({ getByGoal: { cycleId: 'c-cl', goalId: 'goal-cl', goal: 'g' } });
    const gs = { ...mockGoalSystem(), setStatus: vi.fn(() => true) };
    const propose = vi.fn(async () => ({ ok: true }));
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, propose });
    const r = await t.tick({ goalId: 'goal-cl' });
    expect(r.action).toBe('noe.self_evolution.complete');
    expect(gs.setStatus).toHaveBeenCalledWith('goal-cl', 'done');
    expect(r.goalClosed).toBe(true);
  });

  it('loop=complete 但 complete act 失败 → 不关 goal（goalClosed:false，留给下一拍重试）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'complete', nextAction: 'handoff_or_continue_next_goal' });
    const cs = mockCycleStore({ getByGoal: { cycleId: 'c-cf', goalId: 'goal-cf', goal: 'g' } });
    const gs = { ...mockGoalSystem(), setStatus: vi.fn(() => true) };
    const propose = vi.fn(async () => ({ ok: false }));
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, propose });
    const r = await t.tick({ goalId: 'goal-cf' });
    expect(gs.setStatus).not.toHaveBeenCalled();
    expect(r.goalClosed).toBe(false);
  });

  it('loop=implementation_ready（非 complete）→ 不关 goal（goal 保持 active 让 cycle 继续推进）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'implementation_ready', nextAction: 'codex_minimal_implementation' });
    const cs = mockCycleStore({ getByGoal: { cycleId: 'c-ir', goalId: 'goal-ir', goal: 'g' } });
    const gs = { ...mockGoalSystem(), setStatus: vi.fn(() => true) };
    const propose = vi.fn(async () => ({ ok: true, act: { id: 'a' } }));
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, propose });
    const r = await t.tick({ goalId: 'goal-ir' });
    expect(gs.setStatus).not.toHaveBeenCalled();
    expect(r.goalClosed).toBe(false);
  });

  it('ready 阶段但 propose 缺失 → propose_unavailable', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'implementation_ready', nextAction: 'codex_minimal_implementation' });
    const cs = mockCycleStore({ getByGoal: { cycleId: 'c-11', goalId: 'goal-3', goal: 'g' } });
    const t = createNoeSelfEvolutionTrigger({ cycleStore: cs, propose: null });
    expect(await t.tick({ goalId: 'goal-3' })).toMatchObject({ ok: false, reason: 'propose_unavailable' });
  });

  // P0-4 卡死解锁：连续 N 拍停在非可执行阶段（consensus_blocked 无 autodrive）→ 第 N 拍自动 drop 解锁。
  it('卡死解锁：连续 maxNonProgressTicks 拍 consensus_blocked → drop goal（stuck_unlocked）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'consensus_blocked', nextAction: 'refresh_four_model_consensus' });
    const cs = mockCycleStore({ getByGoal: { cycleId: 'c-stuck', goalId: 'goal-stuck', goal: 'g' } });
    const gs = { ...mockGoalSystem(), setStatus: vi.fn(() => true) };
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, maxNonProgressTicks: 3 });
    expect((await t.tick({ goalId: 'goal-stuck' })).goalDropped).toBeUndefined();
    expect((await t.tick({ goalId: 'goal-stuck' })).goalDropped).toBeUndefined();
    const r3 = await t.tick({ goalId: 'goal-stuck' });
    expect(r3.goalDropped).toBe(true);
    expect(r3.reason).toBe('stuck_unlocked');
    expect(gs.setStatus).toHaveBeenCalledWith('goal-stuck', 'dropped');
  });

  it('卡死解锁默认关闭（maxNonProgressTicks=0）→ 永不 drop（向后兼容）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'consensus_blocked', nextAction: 'x' });
    const cs = mockCycleStore({ getByGoal: { cycleId: 'c-nd', goalId: 'goal-nd', goal: 'g' } });
    const gs = { ...mockGoalSystem(), setStatus: vi.fn(() => true) };
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs });
    for (let i = 0; i < 10; i += 1) await t.tick({ goalId: 'goal-nd' });
    expect(gs.setStatus).not.toHaveBeenCalled();
  });

  it('卡死计数：中途有进展（propose）→ 重置，不累积到 drop', async () => {
    const cs = mockCycleStore({ getByGoal: { cycleId: 'c-rs', goalId: 'goal-rs', goal: 'g' } });
    const gs = { ...mockGoalSystem(), setStatus: vi.fn(() => true) };
    const propose = vi.fn(async () => ({ ok: true, act: { id: 'a' } }));
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, propose, maxNonProgressTicks: 2 });
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'consensus_blocked', nextAction: 'x' }); // count=1
    await t.tick({ goalId: 'goal-rs' });
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'implementation_ready', nextAction: 'y' }); // propose → reset
    await t.tick({ goalId: 'goal-rs' });
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'consensus_blocked', nextAction: 'x' }); // count=1 again
    const r3 = await t.tick({ goalId: 'goal-rs' });
    expect(r3.goalDropped).toBeUndefined();
    expect(gs.setStatus).not.toHaveBeenCalled();
  });

  // 红队#2 修复：autodrive.ok 但 cycleStore.advance 失败（cycle 未真前进）→ 不算进展，照常累积到 drop。
  it('卡死解锁：autodrive.ok 但 advance 失败（cycle 未推进）→ 仍计无进展、照常 drop', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'consensus_blocked', nextAction: 'x' });
    const cycle = { cycleId: 'c-fp', goalId: 'goal-fp', goal: 'g' };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn(() => ({ ok: false })) };
    const assembleConsensus = vi.fn(() => ({ ok: true, consensusLedgerRef: 'l', authorization: {}, rollback: {} }));
    const gs = { ...mockGoalSystem(), setStatus: vi.fn(() => true) };
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, assembleConsensus, maxNonProgressTicks: 2 });
    expect((await t.tick({ goalId: 'goal-fp' })).goalDropped).toBeUndefined();
    const r2 = await t.tick({ goalId: 'goal-fp' });
    expect(r2.goalDropped).toBe(true);
    expect(gs.setStatus).toHaveBeenCalledWith('goal-fp', 'dropped');
  });

  it('卡死解锁：autodrive 真推进 cycle（advance.ok）→ 重置计数、不 drop', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'consensus_blocked', nextAction: 'x' });
    const cycle = { cycleId: 'c-tp', goalId: 'goal-tp', goal: 'g' };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn(() => ({ ok: true, cycle: { ...cycle } })) };
    const assembleConsensus = vi.fn(() => ({ ok: true, consensusLedgerRef: 'l', authorization: {}, rollback: {} }));
    const gs = { ...mockGoalSystem(), setStatus: vi.fn(() => true) };
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, assembleConsensus, maxNonProgressTicks: 2 });
    for (let i = 0; i < 5; i += 1) await t.tick({ goalId: 'goal-tp' });
    expect(gs.setStatus).not.toHaveBeenCalled();
  });

  // 红队 round-2#2：implementation_ready 上 implementer 持续失败（actResult.ok=false）也要累积卡死 → drop。
  it('卡死解锁：implementation_ready 上 act 持续失败 → 照常累积到 drop（不被「提出成功」误重置）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'implementation_ready', nextAction: 'codex_minimal_implementation' });
    const cs = mockCycleStore({ getByGoal: { cycleId: 'c-fa', goalId: 'goal-fa', goal: 'g' } });
    const gs = { ...mockGoalSystem(), setStatus: vi.fn(() => true) };
    const propose = vi.fn(async () => ({ ok: false })); // implementer 持续失败
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, propose, maxNonProgressTicks: 3 });
    expect((await t.tick({ goalId: 'goal-fa' })).goalDropped).toBeUndefined();
    expect((await t.tick({ goalId: 'goal-fa' })).goalDropped).toBeUndefined();
    const r3 = await t.tick({ goalId: 'goal-fa' });
    expect(r3.goalDropped).toBe(true);
    expect(r3.reason).toBe('stuck_unlocked');
    expect(gs.setStatus).toHaveBeenCalledWith('goal-fa', 'dropped');
  });

  it('卡死解锁：implementation_ready 上 act 成功 → 重置计数、不 drop', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'implementation_ready', nextAction: 'x' });
    const cs = mockCycleStore({ getByGoal: { cycleId: 'c-sa', goalId: 'goal-sa', goal: 'g' } });
    const gs = { ...mockGoalSystem(), setStatus: vi.fn(() => true) };
    const propose = vi.fn(async () => ({ ok: true, act: { id: 'a' } }));
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, propose, maxNonProgressTicks: 2 });
    for (let i = 0; i < 5; i += 1) await t.tick({ goalId: 'goal-sa' });
    expect(gs.setStatus).not.toHaveBeenCalled();
  });

  // code-reviewer 修复：drop 失败（setStatus 返 false）时保留计数，下拍重试，不会清零导致永远 drop 不掉。
  it('卡死解锁：drop 失败（setStatus false）→ 保留计数，下拍重试成功仍能 drop', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'consensus_blocked', nextAction: 'x' });
    const cs = mockCycleStore({ getByGoal: { cycleId: 'c-df', goalId: 'goal-df', goal: 'g' } });
    const setStatus = vi.fn().mockReturnValueOnce(false).mockReturnValue(true); // 第一次 drop 失败，第二次成功
    const gs = { ...mockGoalSystem(), setStatus };
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, maxNonProgressTicks: 2 });
    await t.tick({ goalId: 'goal-df' }); // count=1
    const r2 = await t.tick({ goalId: 'goal-df' }); // count=2 → 尝试 drop，失败，保留计数
    expect(r2.goalDropped).toBeUndefined();
    const r3 = await t.tick({ goalId: 'goal-df' }); // count 仍≥2 → 再 drop，成功
    expect(r3.goalDropped).toBe(true);
    expect(setStatus).toHaveBeenCalledTimes(2);
  });
});

describe('tick — consensus 死锁最小推进（autodrive）', () => {
  it('consensus_blocked + 注入 autodrive → 装配 ledger、advance cycle、重算后 propose implementation', async () => {
    // 第一次 loop = consensus_blocked；advance 后第二次 loop = implementation_ready
    evaluateNoeSelfEvolutionLoop
      .mockReturnValueOnce({ stage: 'consensus_blocked', nextAction: 'refresh_four_model_consensus' })
      .mockReturnValueOnce({ stage: 'implementation_ready', nextAction: 'codex_minimal_implementation' });
    const cycle = { cycleId: 'c-ad', goalId: 'goal-ad', goal: '修复 startsWith' };
    const advancedCycle = { ...cycle, consensusLedgerRef: 'output/x/ledger.json', authorization: { consensusApproved: true }, rollback: { planRef: 'output/x/rb.json' } };
    const cs = {
      getByGoal: vi.fn(() => cycle),
      upsert: vi.fn(() => ({ ok: true, cycle, stage: 'consensus_blocked' })),
      advance: vi.fn(() => ({ ok: true, cycle: advancedCycle, stage: 'implementation_ready' })),
    };
    const assembleConsensus = vi.fn(() => ({ ok: true, consensusLedgerRef: 'output/x/ledger.json', authorization: { consensusApproved: true }, rollback: { planRef: 'output/x/rb.json' } }));
    const propose = vi.fn(async () => ({ ok: true, act: { id: 'act-ad' } }));
    const t = createNoeSelfEvolutionTrigger({ cycleStore: cs, propose, assembleConsensus });
    const r = await t.tick({ goalId: 'goal-ad' });
    expect(assembleConsensus).toHaveBeenCalledTimes(1);
    expect(cs.advance).toHaveBeenCalledTimes(1);
    expect(cs.advance.mock.calls[0][1]).toMatchObject({ consensusLedgerRef: 'output/x/ledger.json' });
    expect(r).toMatchObject({ ok: true, proposed: true, action: 'noe.self_evolution.implementation', cycleId: 'c-ad' });
    expect(r.autodrive.ok).toBe(true);
    // propose 的 selfEvolution 应带上 advance 后的 consensusLedgerRef
    expect(propose.mock.calls[0][0].selfEvolution.consensusLedgerRef).toBe('output/x/ledger.json');
  });

  it('consensus_blocked + autodrive 失败 → 不 advance，仍返回 consensus_blocked', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'consensus_blocked', nextAction: 'refresh_four_model_consensus' });
    const cycle = { cycleId: 'c-ad2', goalId: 'goal-ad2', goal: 'g' };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn() };
    const assembleConsensus = vi.fn(() => ({ ok: false, reason: 'standing_grant_required_for_consensus_autodrive' }));
    const propose = vi.fn();
    const t = createNoeSelfEvolutionTrigger({ cycleStore: cs, propose, assembleConsensus });
    const r = await t.tick({ goalId: 'goal-ad2' });
    expect(cs.advance).not.toHaveBeenCalled();
    expect(propose).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, proposed: false, stage: 'consensus_blocked' });
    expect(r.autodrive).toMatchObject({ ok: false, reason: 'standing_grant_required_for_consensus_autodrive' });
  });

  it('consensus_blocked + 无 autodrive 注入 → 行为与现状逐字一致（不 advance、不 propose）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'consensus_blocked', nextAction: 'refresh_four_model_consensus' });
    const cs = mockCycleStore({ getByGoal: { cycleId: 'c-ad3', goalId: 'goal-ad3', goal: 'g' } });
    cs.advance = vi.fn();
    const propose = vi.fn();
    const t = createNoeSelfEvolutionTrigger({ cycleStore: cs, propose });
    const r = await t.tick({ goalId: 'goal-ad3' });
    expect(cs.advance).not.toHaveBeenCalled();
    expect(propose).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, proposed: false, stage: 'consensus_blocked' });
    expect(r.autodrive).toBeUndefined();
  });
});

// Step3（飞轮闭环最后一块）：post_review 列 request_changes（非 reject）→ 不卡死/不占坑，
//   清证据回 implementation 携 reviewer blocker 重做；返工有上限（reworkRounds 持久化 cycle），超限转 terminal 学习+释放。
//   flag reworkEnabled 默认 OFF（生产由 D 步透传）；loop 单测已验 reworkEnabled→rework_ready，此处验 trigger 对该 stage 的处理。
describe('tick — Step3 request_changes 返工（reworkEnabled）', () => {
  it('reworkEnabled ON + loop=post_review_rework_ready → 清证据advance(reworkRounds+1)+重算+propose，objective带blocker', async () => {
    // 第一次 loop=rework_ready；清证据 advance 后第二次 loop=implementation_ready（同 consensus autodrive 同拍推进模式）
    evaluateNoeSelfEvolutionLoop
      .mockReturnValueOnce({ stage: 'post_review_rework_ready', nextAction: 'rework_implementation_with_reviewer_blockers', blocked: false, evidence: { postReviewBlockers: ['Tests array is empty', 'No diff'] } })
      .mockReturnValueOnce({ stage: 'implementation_ready', nextAction: 'codex_minimal_implementation' });
    const cycle = { cycleId: 'c-rw', goalId: 'goal-1', goal: 'g', objective: '改进调度', reworkRounds: 0 };
    const advancedCycle = { ...cycle, reworkRounds: 1, reworkBlockers: ['Tests array is empty', 'No diff'], implementation: {}, runtimeVerification: {}, postReview: {} };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn(() => ({ ok: true, cycle: advancedCycle })) };
    const propose = vi.fn(async () => ({ ok: true, act: { id: 'a' } }));
    const t = createNoeSelfEvolutionTrigger({ cycleStore: cs, propose, reworkEnabled: true, maxReworkRounds: 2 });
    const r = await t.tick({ goalId: 'goal-1' });
    // 清旧阶段产物（防假循环用旧 postReview）+ reworkRounds+1
    expect(cs.advance).toHaveBeenCalledWith('c-rw', expect.objectContaining({
      implementation: {}, runtimeVerification: {}, postReview: {}, reworkRounds: 1,
    }));
    // 重算到 implementation_ready → propose；objective 带 blocker（implementer 才看得到要改什么）
    expect(propose).toHaveBeenCalledTimes(1);
    expect(propose.mock.calls[0][0].selfEvolution.objective).toContain('Tests array is empty');
    expect(r).toMatchObject({ ok: true, proposed: true, cycleId: 'c-rw' });
  });

  it('reworkEnabled ON + loop=rework_ready + 清证据advance失败 → 不propose（stuck跟踪，不带病前进）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'post_review_rework_ready', nextAction: 'rework_implementation_with_reviewer_blockers', blocked: false, evidence: {} });
    const cycle = { cycleId: 'c-rwf', goalId: 'goal-1', goal: 'g', reworkRounds: 0 };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn(() => ({ ok: false, errors: ['db_lock'] })) };
    const propose = vi.fn(async () => ({ ok: true }));
    const t = createNoeSelfEvolutionTrigger({ cycleStore: cs, propose, reworkEnabled: true, maxReworkRounds: 2 });
    const r = await t.tick({ goalId: 'goal-1' });
    expect(propose).not.toHaveBeenCalled();
    expect(r.proposed).toBe(false);
  });

  it('Step3超限：reworkEnabled+rejectLearning ON + request_changes + reworkRounds>=max → 学习+drop(rework_exhausted)', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'post_review_required', nextAction: 'x' });
    const cycle = { cycleId: 'c-exh', goalId: 'goal-1', goal: 'g', objective: 'x', reworkRounds: 2 };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn(() => ({ ok: true, cycle })) };
    const gs = { list: vi.fn(() => []), add: vi.fn(), get: vi.fn(), setStatus: vi.fn(() => true) };
    const assembleCompletion = vi.fn(async () => ({ ok: false, reason: 'post_review_not_approved', reviews: [{ model: 'm3', decision: 'request_changes' }], errors: ['blocker 仍未解决'] }));
    const recordFailureLesson = vi.fn();
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, assembleCompletion, recordFailureLesson, rejectLearning: true, reworkEnabled: true, maxReworkRounds: 2 });
    const r = await t.tick({ goalId: 'goal-1' });
    expect(recordFailureLesson).toHaveBeenCalledTimes(1);
    expect(cs.advance).toHaveBeenCalledWith('c-exh', expect.objectContaining({ postReviewFailure: expect.objectContaining({ terminal: true, reason: 'rework_exhausted' }) }));
    expect(gs.setStatus).toHaveBeenCalledWith('goal-1', 'dropped');
    expect(r).toMatchObject({ goalDropped: true });
  });

  it('多模型审P1-3：reworkEnabled ON + rejectLearning OFF + 超限 → rework_exhausted 仍学习+drop（收口独立于 rejectLearning，防只开 REWORK 退化 60 拍 stuck-drop）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'post_review_required', nextAction: 'x' });
    const cycle = { cycleId: 'c-exh2', goalId: 'goal-1', goal: 'g', objective: 'x', reworkRounds: 2 };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn(() => ({ ok: true, cycle })) };
    const gs = { list: vi.fn(() => []), add: vi.fn(), get: vi.fn(), setStatus: vi.fn(() => true) };
    const assembleCompletion = vi.fn(async () => ({ ok: false, reason: 'post_review_not_approved', reviews: [{ model: 'm3', decision: 'request_changes' }], errors: ['blocker 仍未解决'] }));
    const recordFailureLesson = vi.fn();
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, assembleCompletion, recordFailureLesson, rejectLearning: false, reworkEnabled: true, maxReworkRounds: 2 });
    const r = await t.tick({ goalId: 'goal-1' });
    expect(recordFailureLesson).toHaveBeenCalledTimes(1); // rework_exhausted 收口不依赖 rejectLearning
    expect(cs.advance).toHaveBeenCalledWith('c-exh2', expect.objectContaining({ postReviewFailure: expect.objectContaining({ terminal: true, reason: 'rework_exhausted' }) }));
    expect(r).toMatchObject({ goalDropped: true });
  });
  it('多模型审P1-3 反向：reject(非rework) + rejectLearning OFF → 仍不学习（只拆 rework_exhausted，reject 学习仍受 rejectLearning 门控，零回归）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'post_review_required', nextAction: 'x' });
    const cycle = { cycleId: 'c-rej-off', goalId: 'goal-1', goal: 'g', reworkRounds: 0 };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn() };
    const gs = { list: vi.fn(() => []), add: vi.fn(), get: vi.fn(), setStatus: vi.fn(() => true) };
    const assembleCompletion = vi.fn(async () => ({ ok: false, reason: 'post_review_not_approved', reviews: [{ decision: 'reject' }] }));
    const recordFailureLesson = vi.fn();
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, assembleCompletion, recordFailureLesson, reworkEnabled: true, maxReworkRounds: 2 }); // rejectLearning 未传=OFF
    await t.tick({ goalId: 'goal-1' });
    expect(recordFailureLesson).not.toHaveBeenCalled(); // reject 学习仍受 rejectLearning 门控（拆只动 rework_exhausted）
  });

  it('Step3反向：reworkEnabled ON + request_changes + reworkRounds<max(未超限) → 不学习不drop（未到上限不terminal）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'post_review_required', nextAction: 'x' });
    const cycle = { cycleId: 'c-notexh', goalId: 'goal-1', goal: 'g', reworkRounds: 0 };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn() };
    const gs = { list: vi.fn(() => []), add: vi.fn(), get: vi.fn(), setStatus: vi.fn(() => true) };
    const assembleCompletion = vi.fn(async () => ({ ok: false, reason: 'post_review_not_approved', reviews: [{ decision: 'request_changes' }] }));
    const recordFailureLesson = vi.fn();
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, assembleCompletion, recordFailureLesson, rejectLearning: true, reworkEnabled: true, maxReworkRounds: 2 });
    await t.tick({ goalId: 'goal-1' });
    expect(recordFailureLesson).not.toHaveBeenCalled();
    expect(gs.setStatus).not.toHaveBeenCalled();
  });

  it('边界：reworkEnabled ON 但 maxReworkRounds=0（矛盾配置）+ request_changes → 不返工不学习（视为返工关闭，维持原 stuck 行为）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'post_review_required', nextAction: 'x' });
    const cycle = { cycleId: 'c-max0', goalId: 'goal-1', goal: 'g', reworkRounds: 0 };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn() };
    const gs = { list: vi.fn(() => []), add: vi.fn(), get: vi.fn(), setStatus: vi.fn(() => true) };
    const assembleCompletion = vi.fn(async () => ({ ok: false, reason: 'post_review_not_approved', reviews: [{ decision: 'request_changes' }] }));
    const recordFailureLesson = vi.fn();
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, assembleCompletion, recordFailureLesson, rejectLearning: true, reworkEnabled: true, maxReworkRounds: 0 });
    await t.tick({ goalId: 'goal-1' });
    expect(recordFailureLesson).not.toHaveBeenCalled(); // max=0 不当超限学习
    expect(gs.setStatus).not.toHaveBeenCalled(); // 不 drop
    expect(cs.advance).not.toHaveBeenCalled(); // 不返工
  });

  it('FINDING1：completion request_changes 大写变体(REQUEST_CHANGES) → 仍触发返工（normalize 口径，不静默失效）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'post_review_required', nextAction: 'x' });
    const cycle = { cycleId: 'c-variant', goalId: 'goal-1', goal: 'g', reworkRounds: 0 };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn(() => ({ ok: true, cycle: { ...cycle, reworkRounds: 1 } })) };
    const propose = vi.fn(async () => ({ ok: true, act: { id: 'a' } }));
    const assembleCompletion = vi.fn(async () => ({ ok: false, reason: 'post_review_not_approved', reviews: [{ model: 'm3', decision: 'REQUEST_CHANGES' }], errors: ['fix it'] }));
    const t = createNoeSelfEvolutionTrigger({ cycleStore: cs, propose, assembleCompletion, reworkEnabled: true, maxReworkRounds: 2 });
    await t.tick({ goalId: 'goal-1' });
    expect(cs.advance).toHaveBeenCalledWith('c-variant', expect.objectContaining({ reworkRounds: 1 })); // 变体也触发返工
  });

  it('FINDING1：completion reject 连字符变体不存在但大写(REJECT)超限 → 仍走学习（normalize 口径）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'post_review_required', nextAction: 'x' });
    const cycle = { cycleId: 'c-rejvar', goalId: 'goal-1', goal: 'g', reworkRounds: 0 };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn(() => ({ ok: true, cycle })) };
    const gs = { list: vi.fn(() => []), add: vi.fn(), get: vi.fn(), setStatus: vi.fn(() => true) };
    const assembleCompletion = vi.fn(async () => ({ ok: false, reason: 'post_review_not_approved', reviews: [{ model: 'm3', decision: 'REJECT' }], errors: ['no'] }));
    const recordFailureLesson = vi.fn();
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, assembleCompletion, recordFailureLesson, rejectLearning: true, reworkEnabled: true, maxReworkRounds: 2 });
    await t.tick({ goalId: 'goal-1' });
    expect(recordFailureLesson).toHaveBeenCalledTimes(1); // REJECT 变体被识别为 reject → 学习
  });

  it('P1-4：blocker 含 URL query token → reworkBlockers 不泄漏 token 明文（守 secret 不入 db/不传 implementer）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'post_review_required', nextAction: 'x' });
    const cycle = { cycleId: 'c-tok', goalId: 'goal-1', goal: 'g', reworkRounds: 0 };
    let savedPatch = null;
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn((id, patch) => { savedPatch = patch; return { ok: true, cycle: { ...cycle, ...patch } }; }) };
    const assembleCompletion = vi.fn(async () => ({ ok: false, reason: 'post_review_not_approved', reviews: [{ model: 'm3', decision: 'request_changes' }], errors: ['回调见 https://api.example.com/cb?token=secretToken1234567890&x=1'] }));
    const t = createNoeSelfEvolutionTrigger({ cycleStore: cs, propose: vi.fn(async () => ({ ok: true, act: {} })), assembleCompletion, reworkEnabled: true, maxReworkRounds: 2 });
    await t.tick({ goalId: 'goal-1' });
    expect(JSON.stringify((savedPatch && savedPatch.reworkBlockers) || [])).not.toContain('secretToken1234567890');
  });
});

// #19 holdout 接飞轮 complete 盖章点（根治假进化）：把已有 holdout 差分评测接进 complete 判定，shadow 观测、绝不拦。
//   飞轮现状不产 holdout 证据 → 评估器记 unverified/no_holdout_evidence，量化"有多少 complete 是无外部验证的盖章"。
//   注入式（holdoutShadow，server 按 flag NOE_SELFEVO_HOLDOUT_SHADOW 注入）；OFF 时不注入 → 零回归。
describe('#19 holdout shadow 接 complete 盖章点（观测不拦·flag 默认 OFF）', () => {
  it('complete 盖章 + holdoutShadow 注入 → 评估并 advance 记账 cycle.holdoutShadow，绝不拦（goalClosed 仍 true）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'complete', nextAction: 'handoff_or_continue_next_goal' });
    const cs = mockCycleStore({ getByGoal: { cycleId: 'c-hs', goalId: 'goal-hs', goal: 'g' } });
    const advancePatches = [];
    cs.advance = vi.fn((id, patch) => { advancePatches.push(patch); return { ok: true }; });
    const gs = { ...mockGoalSystem(), setStatus: vi.fn(() => true) };
    const holdoutShadow = vi.fn(() => ({ verdict: 'unverified', reason: 'no_holdout_evidence', shadowWouldBlock: true }));
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, propose: vi.fn(async () => ({ ok: true })), holdoutShadow });
    const r = await t.tick({ goalId: 'goal-hs' });
    expect(holdoutShadow).toHaveBeenCalledTimes(1);
    expect(holdoutShadow.mock.calls[0][0]).toMatchObject({ cycleId: 'c-hs' }); // 评估的是当前 cycle
    expect(advancePatches.some((p) => p && p.holdoutShadow && p.holdoutShadow.verdict === 'unverified')).toBe(true);
    expect(r.goalClosed).toBe(true); // 绝不拦：观测不影响盖章
    expect(r.holdoutShadow?.verdict).toBe('unverified');
  });

  it('反向 flag OFF：不注入 holdoutShadow → 不评估、不写 holdoutShadow patch（零回归）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'complete', nextAction: 'handoff_or_continue_next_goal' });
    const cs = mockCycleStore({ getByGoal: { cycleId: 'c-off', goalId: 'goal-off', goal: 'g' } });
    const advancePatches = [];
    cs.advance = vi.fn((id, patch) => { advancePatches.push(patch); return { ok: true }; });
    const gs = { ...mockGoalSystem(), setStatus: vi.fn(() => true) };
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, propose: vi.fn(async () => ({ ok: true })) });
    const r = await t.tick({ goalId: 'goal-off' });
    expect(r.goalClosed).toBe(true);
    expect(r.holdoutShadow).toBeUndefined();
    expect(advancePatches.every((p) => !(p && 'holdoutShadow' in p))).toBe(true);
  });

  it('反向 complete act 失败（actResult.ok=false）→ 不评估 holdout shadow（只在真盖章时记账）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'complete', nextAction: 'handoff_or_continue_next_goal' });
    const cs = mockCycleStore({ getByGoal: { cycleId: 'c-fail', goalId: 'goal-fail', goal: 'g' } });
    cs.advance = vi.fn(() => ({ ok: true }));
    const gs = { ...mockGoalSystem(), setStatus: vi.fn(() => true) };
    const holdoutShadow = vi.fn(() => ({ verdict: 'pass' }));
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, propose: vi.fn(async () => ({ ok: false })), holdoutShadow });
    const r = await t.tick({ goalId: 'goal-fail' });
    expect(holdoutShadow).not.toHaveBeenCalled();
    expect(r.goalClosed).toBe(false);
  });

  it('反向 非 complete action（implementation_ready）→ 不评估 holdout shadow', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'implementation_ready', nextAction: 'codex_minimal_implementation' });
    const cs = mockCycleStore({ getByGoal: { cycleId: 'c-impl', goalId: 'goal-impl', goal: 'g' } });
    cs.advance = vi.fn(() => ({ ok: true }));
    const gs = { ...mockGoalSystem(), setStatus: vi.fn(() => true) };
    const holdoutShadow = vi.fn(() => ({ verdict: 'pass' }));
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, propose: vi.fn(async () => ({ ok: true, act: { id: 'a' } })), holdoutShadow, realApply: true });
    await t.tick({ goalId: 'goal-impl' });
    expect(holdoutShadow).not.toHaveBeenCalled();
  });

  it('shadow 评估器抛错 → fail-open 吞掉，绝不因观测器搞挂飞轮盖章', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'complete', nextAction: 'handoff_or_continue_next_goal' });
    const cs = mockCycleStore({ getByGoal: { cycleId: 'c-throw', goalId: 'goal-throw', goal: 'g' } });
    cs.advance = vi.fn(() => ({ ok: true }));
    const gs = { ...mockGoalSystem(), setStatus: vi.fn(() => true) };
    const holdoutShadow = vi.fn(() => { throw new Error('boom'); });
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, propose: vi.fn(async () => ({ ok: true })), holdoutShadow });
    const r = await t.tick({ goalId: 'goal-throw' });
    expect(r.goalClosed).toBe(true); // 观测器炸了也不拦
    expect(r.holdoutShadow).toBeUndefined(); // 抛错 → 无结果
  });
});

describe('openSelfEvolutionGoals — 合并后按 priority 排序(真信号优先于诗性,修 open 插队)', () => {
  it('高优先 active 真信号排在低优先 open 诗性前(修根因:selfEvolve[0]不再被诗性占)', () => {
    const gs = {
      list: vi.fn(({ status }) => (status === 'open'
        ? [{ id: 'poetic', source: 'self_evolution', status: 'open', priority: 0.75 }]
        : [{ id: 'realsignal', source: 'self_evolution', status: 'active', priority: 0.85, meta: { signal: 'high_complexity' } }])),
      add: vi.fn(), get: vi.fn(),
    };
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, now: () => 10_000_000 });
    const goals = t.openSelfEvolutionGoals();
    expect(goals[0].id).toBe('realsignal'); // selfEvolve 选 [0] = 高优先真信号,不是诗性
    expect(goals[0].priority).toBe(0.85);
  });

  it('纯按 priority(不按 status):open 高优先也排前', () => {
    const gs = {
      list: vi.fn(({ status }) => (status === 'open'
        ? [{ id: 'open-hi', source: 'self_evolution', status: 'open', priority: 0.9 }]
        : [{ id: 'active-lo', source: 'self_evolution', status: 'active', priority: 0.5 }])),
      add: vi.fn(), get: vi.fn(),
    };
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, now: () => 10_000_000 });
    expect(t.openSelfEvolutionGoals()[0].id).toBe('open-hi');
  });

  it('只保留 self_evolution source(过滤其他来源)', () => {
    const gs = {
      list: vi.fn(({ status }) => (status === 'open'
        ? [{ id: 'other', source: 'drive', status: 'open', priority: 9 }, { id: 'se', source: 'self_evolution', status: 'open', priority: 0.5 }]
        : [])),
      add: vi.fn(), get: vi.fn(),
    };
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, now: () => 10_000_000 });
    const goals = t.openSelfEvolutionGoals();
    expect(goals.every((g) => g.source === 'self_evolution')).toBe(true);
    expect(goals[0].id).toBe('se');
  });
});

describe('轴4: verify/self_repair 反复失败被 stuck-drop 也学习(治 370 回滚仅 1-2 教训)', () => {
  it('rejectLearning ON + stuck-drop → recordFailureLesson(reason=stuck_repeated_failure + objective)', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'consensus_blocked', nextAction: 'x' });
    const cycle = { cycleId: 'c-stuck', goalId: 'goal-1', goal: 'g', objective: '改不动的复杂重构' };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn() };
    const gs = { list: vi.fn(() => []), add: vi.fn(), get: vi.fn(), setStatus: vi.fn(() => true) };
    const recordFailureLesson = vi.fn();
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, recordFailureLesson, rejectLearning: true, maxNonProgressTicks: 1 });
    const r = await t.tick({ goalId: 'goal-1' });
    expect(r.goalDropped).toBe(true);
    expect(recordFailureLesson).toHaveBeenCalledTimes(1);
    expect(recordFailureLesson.mock.calls[0][0]).toMatchObject({ goalId: 'goal-1', objective: '改不动的复杂重构', reason: 'stuck_repeated_failure' });
  });

  it('rejectLearning OFF(默认) → stuck 仍 drop 解锁,但不学习(零回归)', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'consensus_blocked', nextAction: 'x' });
    const cycle = { cycleId: 'c-stuck2', goalId: 'goal-1', goal: 'g', objective: 'x' };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn() };
    const gs = { list: vi.fn(() => []), add: vi.fn(), get: vi.fn(), setStatus: vi.fn(() => true) };
    const recordFailureLesson = vi.fn();
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, recordFailureLesson, rejectLearning: false, maxNonProgressTicks: 1 });
    const r = await t.tick({ goalId: 'goal-1' });
    expect(r.goalDropped).toBe(true);
    expect(recordFailureLesson).not.toHaveBeenCalled();
  });

  it('未达阈值(未drop) → 不学习(只在真放弃目标时留教训,非每拍)', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'consensus_blocked', nextAction: 'x' });
    const cycle = { cycleId: 'c-stuck3', goalId: 'goal-1', goal: 'g', objective: 'x' };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn() };
    const gs = { list: vi.fn(() => []), add: vi.fn(), get: vi.fn(), setStatus: vi.fn(() => true) };
    const recordFailureLesson = vi.fn();
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, recordFailureLesson, rejectLearning: true, maxNonProgressTicks: 3 });
    await t.tick({ goalId: 'goal-1' }); // 第1拍,未达3
    expect(recordFailureLesson).not.toHaveBeenCalled();
  });
});

describe('阶段二A: 按信号保留率加权选目标(治test_gap黑洞,留探索地板)', () => {
  it('orderSelfEvolutionGoalsByEffectivePriority: 默认权重1→按原优先级(零回归)', async () => {
    const { orderSelfEvolutionGoalsByEffectivePriority } = await import('../../src/room/NoeSelfEvolutionTrigger.js');
    const goals = [
      { priority: 0.7, meta: { signal: 'high_complexity' } },
      { priority: 0.9, meta: { signal: 'test_gap' } },
    ];
    const r = orderSelfEvolutionGoalsByEffectivePriority(goals);
    expect(r[0].priority).toBe(0.9); // 默认按原优先级,test_gap在前
  });

  it('低保留信号(test_gap)降权后,高保留信号即使原优先级略低也排前', async () => {
    const { orderSelfEvolutionGoalsByEffectivePriority } = await import('../../src/room/NoeSelfEvolutionTrigger.js');
    const goals = [
      { priority: 0.8, meta: { signal: 'high_complexity' } }, // 高保留 权重1 → 0.8
      { priority: 0.9, meta: { signal: 'test_gap' } },        // 低保留 权重0.4 → 0.36
    ];
    const weight = (sig) => sig === 'test_gap' ? 0.4 : 1;
    const r = orderSelfEvolutionGoalsByEffectivePriority(goals, weight);
    expect(r[0].meta.signal).toBe('high_complexity'); // 高保留排前
  });

  it('探索地板:权重非0,test_gap 不被完全饿死(仍在列表,只是靠后)', async () => {
    const { orderSelfEvolutionGoalsByEffectivePriority } = await import('../../src/room/NoeSelfEvolutionTrigger.js');
    const goals = [{ priority: 0.9, meta: { signal: 'test_gap' } }];
    const weight = () => 0.3; // 地板
    const r = orderSelfEvolutionGoalsByEffectivePriority(goals, weight);
    expect(r).toHaveLength(1); // 没被过滤,只是降权
  });

  it('weight抛错/非法→回退1(fail-open)', async () => {
    const { orderSelfEvolutionGoalsByEffectivePriority } = await import('../../src/room/NoeSelfEvolutionTrigger.js');
    const goals = [{ priority: 0.5, meta: { signal: 'x' } }, { priority: 0.8, meta: { signal: 'y' } }];
    const r = orderSelfEvolutionGoalsByEffectivePriority(goals, () => { throw new Error('boom'); });
    expect(r[0].priority).toBe(0.8);
  });
});

// 飞轮 stuck 根因修复(2026-07-03)·A1：type_error 错误详情喂给 implementer。
//   实证根因：seed 造的「行号:错误码」只进 steps[0].step 截 120 字，cycle.goal 只有 title
//   「修 X 的类型 error」→ implementer prompt 零错误信息 → 盲猜 → 价值锚拒 → 5 拍 drop（70 尸体 cycle）。
//   flag typeErrDetail（NOE_SELFEVO_TYPEERR_DETAIL）默认 OFF = objective 逐字现状零回归。
describe('A1 type_error 错误详情透传（typeErrDetail flag）', () => {
  const typeErrGoal = {
    id: 'goal-te', title: '修 src/x.js 的类型 error',
    meta: {
      signal: 'type_error', targetFile: 'src/x.js', errorCount: 2,
      errors: [
        { line: 12, code: 'TS2531', message: 'Object is possibly null.' },
        { line: 34, code: 'TS2554', message: 'Expected 2 arguments, but got 1.' },
      ],
    },
  };

  function mkTick({ typeErrDetail }) {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'implementation_ready', nextAction: 'codex_minimal_implementation' });
    const cs = mockCycleStore({ getByGoal: { cycleId: 'c-te', goal: '修 src/x.js 的类型 error', goalId: 'goal-te' } });
    const propose = vi.fn(async () => ({ ok: true, act: { id: 'a' } }));
    const gs = mockGoalSystem({ getReturns: typeErrGoal });
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, propose, typeErrDetail });
    return { t, propose };
  }

  it('flag ON：objective 拼「哪行什么错」详情（implementer 不再盲猜）', async () => {
    const { t, propose } = mkTick({ typeErrDetail: true });
    await t.tick({ goalId: 'goal-te' });
    const se = propose.mock.calls[0][0].selfEvolution;
    expect(se.objective).toContain('L12 TS2531');
    expect(se.objective).toContain('possibly null');
    expect(se.objective).toContain('L34 TS2554');
    expect(se.targetFile).toBe('src/x.js'); // 既有透传不受影响
    expect(se.beforeErrorCount).toBe(2);
  });

  it('flag OFF（默认）：objective 逐字现状（零回归）', async () => {
    const { t, propose } = mkTick({ typeErrDetail: false });
    await t.tick({ goalId: 'goal-te' });
    const se = propose.mock.calls[0][0].selfEvolution;
    expect(se.objective).toBe('修 src/x.js 的类型 error');
    expect(se.objective).not.toContain('TS2531');
  });

  it('flag ON 但 meta.errors 缺失/非数组 → 不拼不崩（fail-open）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'implementation_ready', nextAction: 'codex_minimal_implementation' });
    const cs = mockCycleStore({ getByGoal: { cycleId: 'c-te2', goal: '修 src/y.js 的类型 error', goalId: 'goal-te2' } });
    const propose = vi.fn(async () => ({ ok: true, act: { id: 'a' } }));
    const gs = mockGoalSystem({ getReturns: { id: 'goal-te2', meta: { signal: 'type_error', targetFile: 'src/y.js', errorCount: 1 } } });
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, propose, typeErrDetail: true });
    await t.tick({ goalId: 'goal-te2' });
    expect(propose.mock.calls[0][0].selfEvolution.objective).toBe('修 src/y.js 的类型 error');
  });
});

// A2 失败证据回灌(2026-07-03)：self_repair 此前是盲重试（implementer 输入与上次完全相同，实证 359 次
//   needs_consensus 全烧在盲猜上）。flag repairHintsEnabled（NOE_SELFEVO_REPAIR_HINTS）默认 OFF 零回归：
//   ON 时 ①needsSelfRepair 回写把 verifyReason 存 cycle.repairHints（脱敏） ②self_repair act 的 objective
//   拼「上轮验证失败原因」让 implementer 针对性修。
describe('A2 self_repair 失败证据回灌（repairHintsEnabled flag）', () => {
  it('flag ON：needsSelfRepair 回写携带 repairHints（存 verifyReason）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'implementation_ready', nextAction: 'codex_minimal_implementation' });
    const cycle = { cycleId: 'c-rh', goalId: 'g-rh', goal: '修 X' };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn(() => ({ ok: true, cycle })) };
    const propose = vi.fn(async () => ({ ok: false, error: 'self_evolution_verify_failed_rolled_back_needs_self_repair', selfEvolution: { needsSelfRepair: true, applyReportRef: 'output/ap.json', runtimeReportRef: 'output/rt.json', verifyReason: 'type_error_fix_rejected: error 未减少' } }));
    const t = createNoeSelfEvolutionTrigger({ cycleStore: cs, propose, realApply: true, repairHintsEnabled: true });
    await t.tick({ goalId: 'g-rh' });
    const patch = cs.advance.mock.calls[0][1];
    // First hint is always verifyReason; optional second is ImproveSignal objective anchor.
    expect(patch.repairHints[0]).toBe('type_error_fix_rejected: error 未减少');
    expect(patch.repairHints.length).toBeGreaterThanOrEqual(1);
    expect(patch.lastImproveSignal?.signal).toBe('verify_not_green');
  });

  it('flag OFF（默认）：needsSelfRepair 回写不带 repairHints（零回归）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'implementation_ready', nextAction: 'codex_minimal_implementation' });
    const cycle = { cycleId: 'c-rh0', goalId: 'g-rh0', goal: '修 X' };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn(() => ({ ok: true, cycle })) };
    const propose = vi.fn(async () => ({ ok: false, error: 'x', selfEvolution: { needsSelfRepair: true, verifyReason: 'boom' } }));
    const t = createNoeSelfEvolutionTrigger({ cycleStore: cs, propose, realApply: true });
    await t.tick({ goalId: 'g-rh0' });
    expect(cs.advance.mock.calls[0][1].repairHints).toBeUndefined();
  });

  it('flag ON + self_repair act：objective 拼「上轮验证失败原因」', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'self_repair_ready', nextAction: 'return_to_consensus_for_repair' });
    const cycle = { cycleId: 'c-rh2', goalId: 'g-rh2', goal: '修 X', repairHints: ['type_error_fix_rejected: error 未减少'] };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn(() => ({ ok: true, cycle })) };
    const propose = vi.fn(async () => ({ ok: true, act: { id: 'a' } }));
    const t = createNoeSelfEvolutionTrigger({ cycleStore: cs, propose, repairHintsEnabled: true });
    await t.tick({ goalId: 'g-rh2' });
    const se = propose.mock.calls[0][0].selfEvolution;
    expect(se.objective).toContain('上轮验证失败');
    expect(se.objective).toContain('error 未减少');
  });

  it('flag OFF + cycle 已有 repairHints（历史数据）：objective 不拼（零回归）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'self_repair_ready', nextAction: 'return_to_consensus_for_repair' });
    const cycle = { cycleId: 'c-rh3', goalId: 'g-rh3', goal: '修 X', repairHints: ['boom'] };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn(() => ({ ok: true, cycle })) };
    const propose = vi.fn(async () => ({ ok: true, act: { id: 'a' } }));
    const t = createNoeSelfEvolutionTrigger({ cycleStore: cs, propose });
    await t.tick({ goalId: 'g-rh3' });
    expect(propose.mock.calls[0][0].selfEvolution.objective).toBe('修 X');
  });

  it('flag ON + implementation act（非 self_repair）：objective 不拼 repairHints（只喂给修复动作）', async () => {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'implementation_ready', nextAction: 'codex_minimal_implementation' });
    const cycle = { cycleId: 'c-rh4', goalId: 'g-rh4', goal: '修 X', repairHints: ['old hint'] };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn(() => ({ ok: true, cycle })) };
    const propose = vi.fn(async () => ({ ok: true, act: { id: 'a' } }));
    const t = createNoeSelfEvolutionTrigger({ cycleStore: cs, propose, repairHintsEnabled: true });
    await t.tick({ goalId: 'g-rh4' });
    expect(propose.mock.calls[0][0].selfEvolution.objective).toBe('修 X');
  });
});

// 飞轮 stuck 根因修复(2026-07-03)·B：fail-fast 同因连败 + stuck-drop cycle 终态 artifact。
//   实证根因：①同因失败盲重试烧满 NOE_SELF_EVOLUTION_MAX_STUCK_TICKS 拍（生产=5）才 drop——同一 failure
//   reason 连续出现说明是确定性失败（逻辑门拒/needs_consensus），重试同输入不可能成功；②drop 后 cycle 停尸在
//   self_repair_ready/implementation_ready（DB 实测 139 个），复盘统计误读为「卡在半路」。
//   flag failFast（NOE_SELFEVO_FAILFAST）默认 OFF 零回归。
describe('B fail-fast 同因连败 + stuckDrop 终态 artifact（failFast flag）', () => {
  function mkFailTick({ failFast = true, maxSameFailureRetries = 2, error = 'self_repair_failed_needs_consensus', rejectLearning = false, recordFailureLesson = null, advanceOk = true } = {}) {
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'self_repair_ready', nextAction: 'return_to_consensus_for_repair' });
    const cycle = { cycleId: 'c-ff', goalId: 'g-ff', goal: '修 X' };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn(() => (advanceOk ? { ok: true, cycle } : { ok: false, errors: ['db_locked'] })) };
    const gs = { list: vi.fn(() => []), add: vi.fn(), get: vi.fn(() => null), setStatus: vi.fn(() => true) };
    const propose = vi.fn(async () => ({ ok: false, error, selfEvolution: { needsConsensus: true } }));
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, propose, failFast, maxSameFailureRetries, rejectLearning, recordFailureLesson });
    return { t, cs, gs, propose };
  }

  it('flag ON：同因连败达阈值(2) → 第2拍写 stuckDrop 终态 artifact + drop goal', async () => {
    const { t, cs, gs } = mkFailTick({});
    const r1 = await t.tick({ goalId: 'g-ff' });
    expect(r1.goalDropped).toBeUndefined(); // 第1拍只记 streak
    const r2 = await t.tick({ goalId: 'g-ff' });
    expect(r2.goalDropped).toBe(true);
    expect(r2.reason).toBe('failfast_same_failure');
    const artifactCall = cs.advance.mock.calls.find((c) => c[1] && c[1].stuckDrop);
    expect(artifactCall[1].stuckDrop).toMatchObject({ terminal: true, atStage: 'self_repair_ready', repeats: 2 });
    expect(artifactCall[1].stuckDrop.reason).toContain('needs_consensus');
    expect(gs.setStatus).toHaveBeenCalledWith('g-ff', 'dropped');
  });

  it('flag ON：失败原因不同 → streak 重置不 drop（不同失败=新信息，值得再试）', async () => {
    const { t, cs, propose } = mkFailTick({});
    await t.tick({ goalId: 'g-ff' });
    propose.mockResolvedValueOnce({ ok: false, error: 'self_evolution_apply_preflight_blocked' });
    const r2 = await t.tick({ goalId: 'g-ff' });
    expect(r2.goalDropped).toBeUndefined();
    expect(cs.advance.mock.calls.find((c) => c[1] && c[1].stuckDrop)).toBeUndefined();
  });

  it('flag ON：中间成功一拍 → streak 清零', async () => {
    const { t, propose } = mkFailTick({});
    await t.tick({ goalId: 'g-ff' });
    propose.mockResolvedValueOnce({ ok: true, act: { id: 'a' } });
    await t.tick({ goalId: 'g-ff' }); // 成功，清零
    const r3 = await t.tick({ goalId: 'g-ff' }); // 再失败=streak 1
    expect(r3.goalDropped).toBeUndefined();
  });

  it('flag OFF（默认）：同因连败不 fail-fast、不写 stuckDrop（零回归）', async () => {
    const { t, cs } = mkFailTick({ failFast: false });
    await t.tick({ goalId: 'g-ff' });
    await t.tick({ goalId: 'g-ff' });
    const r3 = await t.tick({ goalId: 'g-ff' });
    expect(r3.goalDropped).toBeUndefined();
    expect(cs.advance.mock.calls.find((c) => c[1] && c[1].stuckDrop)).toBeUndefined();
  });

  it('flag ON + artifact 落库失败 → 不 drop（保留 cycle 下拍重试，防「goal 释放但终态没落库」审计断）', async () => {
    const { t, gs } = mkFailTick({ advanceOk: false });
    await t.tick({ goalId: 'g-ff' });
    const r2 = await t.tick({ goalId: 'g-ff' });
    expect(r2.goalDropped).toBeUndefined();
    expect(gs.setStatus).not.toHaveBeenCalledWith('g-ff', 'dropped');
  });

  it('flag ON + rejectLearning ON：fail-fast drop 时记失败教训（reason=failfast_same_failure_repeated）', async () => {
    const lesson = vi.fn();
    const { t } = mkFailTick({ rejectLearning: true, recordFailureLesson: lesson });
    await t.tick({ goalId: 'g-ff' });
    await t.tick({ goalId: 'g-ff' });
    expect(lesson).toHaveBeenCalledTimes(1);
    expect(lesson.mock.calls[0][0].reason).toBe('failfast_same_failure_repeated');
  });

  it('flag ON + noteStuck 常规 drop（maxNonProgressTicks 达阈值）→ 也补写 stuckDrop artifact（best-effort）', async () => {
    // stage 无 action（consensus_blocked）→ 走 !action 分支 noteStuck；maxNonProgressTicks=1 一拍即 drop
    evaluateNoeSelfEvolutionLoop.mockReturnValue({ stage: 'consensus_blocked', nextAction: 'refresh_four_model_consensus' });
    const cycle = { cycleId: 'c-ns', goalId: 'g-ns', goal: '修 Y' };
    const cs = { getByGoal: vi.fn(() => cycle), upsert: vi.fn(), advance: vi.fn(() => ({ ok: true, cycle })) };
    const gs = { list: vi.fn(() => []), add: vi.fn(), get: vi.fn(() => null), setStatus: vi.fn(() => true) };
    const t = createNoeSelfEvolutionTrigger({ goalSystem: gs, cycleStore: cs, propose: vi.fn(), failFast: true, maxNonProgressTicks: 1 });
    const r = await t.tick({ goalId: 'g-ns' });
    expect(r.goalDropped).toBe(true);
    expect(r.reason).toBe('stuck_unlocked');
    const artifactCall = cs.advance.mock.calls.find((c) => c[1] && c[1].stuckDrop);
    expect(artifactCall[1].stuckDrop).toMatchObject({ terminal: true, atStage: 'consensus_blocked' });
  });
});
