import { describe, it, expect } from 'vitest';
import { createSelfDirectionSeed } from '../../src/room/NoeSelfDirectionSeed.js';

// #54 自主定方向：飞轮用 LLM 反思自身状态 → 自主生成进化方向目标（跳出预设信号源）→ 立项执行。
//   价值锚（生成阶段，替代被移除的 P5 advisory-only 墙）：质量闸 hasTechnicalTarget + 可验证(successCriterion+targetFile)
//   + 引用性(非孤儿) + expectedVerdict∈{logic_changed,test_only}(拒浅层) + 去重。执行阶段走完整现有安全网。
//   纯 DI + fail-open。flag NOE_SELF_DIRECTION_SEED 默认 OFF。

const mkGoalSystem = (opts = {}) => {
  const added = [];
  return {
    added,
    add: (g) => { if (opts.addReturnsNull) return null; added.push(g); return `goal-${added.length}`; },
    list: ({ status }) => (opts.openGoals || []).filter((g) => g.status === status),
  };
};

// 合格方向 LLM 输出
const GOOD = { objective: '重构 src/foo.js 的 parseX 降圈复杂度', area: 'parser', targetFile: 'src/foo.js', successCriterion: 'parseX 圈复杂度从 28 降到 <12', expectedVerdict: 'logic_changed', reasoning: 'r' };
const mkStructuredCall = (value, ok = true) => async () => ({ ok, value });
const mkAdapter = () => ({ chat: async () => ({ reply: '{}' }) });
const baseDeps = (over = {}) => ({
  getAdapter: () => mkAdapter(),
  goalSystem: mkGoalSystem(),
  structuredCall: mkStructuredCall(GOOD),
  referenceProbe: () => ({ referenced: true, hits: ['src/bar.js'] }),
  root: '/p',
  ...over,
});

const withFlag = (fn) => {
  const old = process.env.NOE_SELF_DIRECTION_SEED;
  process.env.NOE_SELF_DIRECTION_SEED = '1';
  try { return fn(); } finally {
    if (old === undefined) delete process.env.NOE_SELF_DIRECTION_SEED; else process.env.NOE_SELF_DIRECTION_SEED = old;
  }
};

describe('NoeSelfDirectionSeed', () => {
  it('flag OFF → skipped:flag_off', async () => {
    const old = process.env.NOE_SELF_DIRECTION_SEED; delete process.env.NOE_SELF_DIRECTION_SEED;
    const r = await createSelfDirectionSeed(baseDeps()).runOnce();
    expect(r.skipped).toBe('flag_off');
    if (old !== undefined) process.env.NOE_SELF_DIRECTION_SEED = old;
  });

  it('正常：LLM 产合格方向 → 立项(source=self_evolution, meta.signal=self_directed_evolution, 带 steps + 价值锚 meta)', async () => withFlag(async () => {
    const gs = mkGoalSystem();
    const r = await createSelfDirectionSeed(baseDeps({ goalSystem: gs })).runOnce();
    expect(r.ok).toBe(true);
    expect(gs.added[0].source).toBe('self_evolution');
    expect(gs.added[0].meta.signal).toBe('self_directed_evolution');
    expect(gs.added[0].meta.targetFile).toBe('src/foo.js');
    expect(gs.added[0].meta.expectedVerdict).toBe('logic_changed');
    expect(gs.added[0].meta.successCriterion).toContain('圈复杂度');
    expect(Array.isArray(gs.added[0].steps) && gs.added[0].steps.length).toBeTruthy();
  }));

  it('listSourceFiles 注入 → context 喂真实候选文件清单(让 35b 从中选 targetFile,防编造孤儿)', async () => withFlag(async () => {
    let captured = null;
    const sc = async (args) => { captured = args; return { ok: true, value: GOOD }; };
    await createSelfDirectionSeed(baseDeps({ structuredCall: sc, listSourceFiles: () => ['/p/src/foo.js', '/p/src/bar.js', '/p/tests/x.test.js'] })).runOnce();
    const userMsg = (captured.messages.find((m) => m.role === 'user') || {}).content || '';
    expect(userMsg).toContain('可选目标文件');
    expect(userMsg).toContain('src/foo.js');
    expect(userMsg).not.toContain('x.test.js'); // 测试文件被过滤
  }));

  // 探索偏集中软引导(2026-07-01)：飞轮反复刷少数文件(实测 NoeModelCircuitBreaker 6/15)。注入「最近已立方向的文件」引导拓宽。
  it('recentTargets 注入 → context 引导拓宽覆盖(别反复刷少数文件)', async () => withFlag(async () => {
    let captured = null;
    const sc = async (args) => { captured = args; return { ok: true, value: GOOD }; };
    await createSelfDirectionSeed(baseDeps({ structuredCall: sc, recentTargets: () => ['src/room/NoeModelCircuitBreaker.js', 'src/context/NoeContextBudgeter.js'] })).runOnce();
    const userMsg = (captured.messages.find((m) => m.role === 'user') || {}).content || '';
    expect(userMsg).toContain('最近已立过方向的文件');
    expect(userMsg).toContain('NoeModelCircuitBreaker.js'); // 引导避开已反复刷的
  }));

  it('recentTargets 缺省(null) → 不注入引导(零回归)', async () => withFlag(async () => {
    let captured = null;
    const sc = async (args) => { captured = args; return { ok: true, value: GOOD }; };
    await createSelfDirectionSeed(baseDeps({ structuredCall: sc })).runOnce(); // 无 recentTargets
    const userMsg = (captured.messages.find((m) => m.role === 'user') || {}).content || '';
    expect(userMsg).not.toContain('最近已立过方向的文件');
  }));

  it('单坑位：已有 self_directed_evolution goal 在飞 → 不立(direction_goal_in_flight)', async () => withFlag(async () => {
    const gs = mkGoalSystem({ openGoals: [{ status: 'open', source: 'self_evolution', meta: { signal: 'self_directed_evolution' } }] });
    const r = await createSelfDirectionSeed(baseDeps({ goalSystem: gs })).runOnce();
    expect(r.reason).toBe('direction_goal_in_flight');
  }));

  it('不挡其他信号：已有 test_gap goal → 自主方向照立', async () => withFlag(async () => {
    const gs = mkGoalSystem({ openGoals: [{ status: 'open', source: 'self_evolution', meta: { signal: 'test_gap' } }] });
    const r = await createSelfDirectionSeed(baseDeps({ goalSystem: gs })).runOnce();
    expect(r.ok).toBe(true);
  }));

  it('价值锚 a：诗性无技术着力点 → value_anchor_not_technical(拒)', async () => withFlag(async () => {
    const poetic = { ...GOOD, objective: '愿岁月静好，现世安稳，一切归于圆满' }; // 纯诗性、无技术着力点
    const r = await createSelfDirectionSeed(baseDeps({ structuredCall: mkStructuredCall(poetic) })).runOnce();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('value_anchor_not_technical');
  }));

  it('价值锚 b：缺 successCriterion → value_anchor_unverifiable(拒抽象"变更好")', async () => withFlag(async () => {
    const vague = { ...GOOD, successCriterion: '' };
    const r = await createSelfDirectionSeed(baseDeps({ structuredCall: mkStructuredCall(vague) })).runOnce();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('value_anchor_unverifiable');
  }));

  it('价值锚 d：expectedVerdict 非 logic_changed/test_only → value_anchor_shallow_expected(拒浅层)', async () => withFlag(async () => {
    const shallow = { ...GOOD, expectedVerdict: 'neutral' };
    const r = await createSelfDirectionSeed(baseDeps({ structuredCall: mkStructuredCall(shallow) })).runOnce();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('value_anchor_shallow_expected');
  }));

  it('价值锚 c：targetFile 孤儿(无引用)→ value_anchor_orphan_target(拒)', async () => withFlag(async () => {
    const r = await createSelfDirectionSeed(baseDeps({ referenceProbe: () => ({ referenced: false, hits: [] }) })).runOnce();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('value_anchor_orphan_target');
  }));

  it('价值锚：targetFile 非 src/.js 或指向测试 → value_anchor_bad_target', async () => withFlag(async () => {
    const bad = { ...GOOD, targetFile: 'tests/unit/foo.test.js' };
    const r = await createSelfDirectionSeed(baseDeps({ structuredCall: mkStructuredCall(bad) })).runOnce();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('value_anchor_bad_target');
  }));

  it('价值锚 f：targetFile 是 protected 文件(飞轮安全门)→ value_anchor_protected_target(飞轮不能自主定改自己约束的方向)', async () => withFlag(async () => {
    // 实测:M3 自主提"重构 NoeSelfEvolutionActGuard"(飞轮自己的安全门),implement 注定被 PolicyFileGuard 拦+空转占单坑位。生成阶段就拦掉。
    const r = await createSelfDirectionSeed(baseDeps({ isProtected: (f) => f === 'src/foo.js' })).runOnce();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('value_anchor_protected_target');
  }));

  it('去重：近重复被拒 → near_duplicate', async () => withFlag(async () => {
    const r = await createSelfDirectionSeed(baseDeps({ recallRejectLessons: () => ({ similar: true }) })).runOnce();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('near_duplicate');
  }));

  it('no_brain：adapter 无 chat → skipped:no_brain', async () => withFlag(async () => {
    const r = await createSelfDirectionSeed(baseDeps({ getAdapter: () => ({}) })).runOnce();
    expect(r.skipped).toBe('no_brain');
  }));

  it('LLM 产空/失败 → no_direction(不立模糊目标)', async () => withFlag(async () => {
    const r = await createSelfDirectionSeed(baseDeps({ structuredCall: async () => ({ ok: false }) })).runOnce();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_direction');
  }));

  it('fail-open：structuredCall 抛 → error 不崩', async () => withFlag(async () => {
    const r = await createSelfDirectionSeed(baseDeps({ structuredCall: async () => { throw new Error('x'); } })).runOnce();
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  }));

  it('add 返 null → add_rejected', async () => withFlag(async () => {
    const r = await createSelfDirectionSeed(baseDeps({ goalSystem: mkGoalSystem({ addReturnsNull: true }) })).runOnce();
    expect(r.reason).toBe('add_rejected');
  }));
});
