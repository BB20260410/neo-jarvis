import { describe, it, expect } from 'vitest';
import { createTypeErrorSeed } from '../../src/room/NoeTypeErrorSeed.js';

// type_error_fix 域信号源:跑 typecheck → parseTypecheckTargets → 立 type_error goal。
//   仿 NoeSelfDirectionSeed 范式(DI + 单坑位 + protected 排除 + fail-open)。
// P4 救域后夹具改用简单 error 码(TS2531/TS2554)——默认 denyCodes 排除 TS2339/TS2322(M3 修不动),
//   deny 行为单独在下方 describe 覆盖。
const TC = [
  'src/a.js(1,1): error TS2531: Object is possibly null.',
  'src/b.js(1,1): error TS2554: Expected 2 arguments, but got 1.',
  'src/b.js(2,1): error TS2531: Object is possibly null.',
].join('\n');

function mkGoalSystem(existing = []) {
  const added = [];
  return {
    add: (g) => { added.push(g); return 'goal-' + added.length; },
    list: ({ status }) => existing.filter((g) => g.status === status),
    _added: added,
  };
}

describe('createTypeErrorSeed', () => {
  it('跑 typecheck → 立 type_error goal(低 error 文件优先,meta 正确)', async () => {
    const gs = mkGoalSystem();
    const seed = createTypeErrorSeed({ runTypecheck: () => TC, goalSystem: gs });
    const r = await seed.runOnce();
    expect(r.ok).toBe(true);
    expect(r.targetFile).toBe('src/a.js'); // 1 error < b 的 2 error
    const goal = gs._added[0];
    expect(goal.source).toBe('self_evolution');
    expect(goal.meta.signal).toBe('type_error');
    expect(goal.meta.targetFile).toBe('src/a.js');
    expect(goal.meta.expectedVerdict).toBe('logic_changed');
    expect(goal.steps[0].kind).toBe('think');
  });

  it('单坑位:已有 type_error goal 在飞 → 跳过(防刷屏)', async () => {
    const gs = mkGoalSystem([{ status: 'active', meta: { signal: 'type_error', targetFile: 'src/z.js' } }]);
    const seed = createTypeErrorSeed({ runTypecheck: () => TC, goalSystem: gs });
    const r = await seed.runOnce();
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe('in_flight');
  });

  it('protected 文件排除,选下一个', async () => {
    const gs = mkGoalSystem();
    const seed = createTypeErrorSeed({ runTypecheck: () => TC, goalSystem: gs, isProtected: (f) => f === 'src/a.js' });
    const r = await seed.runOnce();
    expect(r.ok).toBe(true);
    expect(r.targetFile).toBe('src/b.js');
  });

  it('排除最近 dropped 的文件(防反复立 M3 修不对的,转向能修的)', async () => {
    const gs = mkGoalSystem();
    const seed = createTypeErrorSeed({ runTypecheck: () => TC, goalSystem: gs, isRecentlyDropped: (f) => f === 'src/a.js' });
    const r = await seed.runOnce();
    expect(r.ok).toBe(true);
    expect(r.targetFile).toBe('src/b.js'); // a 最近 dropped(M3 修不对)→ 跳过,选 b
  });

  it('typecheck 抛错 → skipped(fail-open 不崩)', async () => {
    const gs = mkGoalSystem();
    const seed = createTypeErrorSeed({ runTypecheck: () => { throw new Error('tsc boom'); }, goalSystem: gs });
    const r = await seed.runOnce();
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe('typecheck_failed');
  });

  it('无 src 目标(空输出) → skipped no_target', async () => {
    const gs = mkGoalSystem();
    const seed = createTypeErrorSeed({ runTypecheck: () => '', goalSystem: gs });
    const r = await seed.runOnce();
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe('no_target');
  });

  it('maxErrorsPerFile 限制:只立低 error 目标', async () => {
    const gs = mkGoalSystem();
    // 只允许 1 error → b(2 error) 被滤,a(1) 入选
    const seed = createTypeErrorSeed({ runTypecheck: () => TC, goalSystem: gs, maxErrorsPerFile: 1 });
    const r = await seed.runOnce();
    expect(r.targetFile).toBe('src/a.js');
  });

  it('无 goalSystem → skipped(fail-open)', async () => {
    const seed = createTypeErrorSeed({ runTypecheck: () => TC });
    const r = await seed.runOnce();
    expect(r.ok).toBe(false);
  });

  // 飞轮 stuck 根因修复(2026-07-03)：错误详情(行号/错误码/消息)此前只进 steps[0].step 截 120 字，
  //   goal.title→cycle→implementer prompt 全程丢失 → 模型盲猜修不对 → 价值锚拒 → 5 拍 drop。
  //   meta.errors 让 trigger 能把「到底哪行什么错」喂给 implementer。
  it('meta.errors 带结构化错误详情(line/code/message)，供 implementer 精确定位', async () => {
    const gs = mkGoalSystem();
    const seed = createTypeErrorSeed({ runTypecheck: () => TC, goalSystem: gs });
    const r = await seed.runOnce();
    expect(r.ok).toBe(true);
    const goal = gs._added[0];
    expect(Array.isArray(goal.meta.errors)).toBe(true);
    expect(goal.meta.errors[0]).toMatchObject({ line: 1, code: 'TS2531' });
    expect(goal.meta.errors[0].message).toContain('possibly null');
  });

  it('meta.errors 上限 5 条 + message 截断（防 meta 膨胀）', async () => {
    const out = Array.from({ length: 8 }, (_, i) => `src/many.js(${i + 1},1): error TS2531: ${'x'.repeat(300)}`).join('\n');
    const gs = mkGoalSystem();
    const seed = createTypeErrorSeed({ runTypecheck: () => out, goalSystem: gs, maxErrorsPerFile: 99 });
    const r = await seed.runOnce();
    expect(r.ok).toBe(true);
    const goal = gs._added[0];
    expect(goal.meta.errors.length).toBe(5);
    expect(goal.meta.errors[0].message.length).toBeLessThanOrEqual(200);
  });
});

describe('P4 救域：默认 denyCodes 生效', () => {
  it('默认排除含 TS2339/TS2322 的文件，只立全简单 error 的目标', async () => {
    const out = [
      "src/hard.js(1,1): error TS2339: Property 'x' does not exist.",
      'src/easy.js(1,1): error TS2531: Object is possibly null.',
    ].join('\n');
    const gs = { add: (g) => { gs._g = g; return 'goal-1'; }, list: () => [] };
    const seed = createTypeErrorSeed({ runTypecheck: () => out, goalSystem: gs });
    const r = await seed.runOnce();
    expect(r.ok).toBe(true);
    expect(r.targetFile).toBe('src/easy.js');
  });

  it('denyCodes: [] 显式关闭排除（零回归口径）', async () => {
    const out = "src/hard.js(1,1): error TS2339: Property 'x' does not exist.";
    const gs = { add: () => 'goal-1', list: () => [] };
    const seed = createTypeErrorSeed({ runTypecheck: () => out, goalSystem: gs, denyCodes: [] });
    const r = await seed.runOnce();
    expect(r.ok).toBe(true);
    expect(r.targetFile).toBe('src/hard.js');
  });
});
