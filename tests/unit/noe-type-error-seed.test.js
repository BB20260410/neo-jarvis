import { describe, it, expect } from 'vitest';
import { createTypeErrorSeed } from '../../src/room/NoeTypeErrorSeed.js';

// type_error_fix 域信号源:跑 typecheck → parseTypecheckTargets → 立 type_error goal。
//   仿 NoeSelfDirectionSeed 范式(DI + 单坑位 + protected 排除 + fail-open)。
const TC = [
  "src/a.js(1,1): error TS2339: Property 'x' does not exist.",
  "src/b.js(1,1): error TS2322: Type mismatch.",
  "src/b.js(2,1): error TS2339: foo.",
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
});
