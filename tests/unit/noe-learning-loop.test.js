import { describe, it, expect, vi } from 'vitest';
import { createNoeLearningLoop } from '../../src/cognition/NoeLearningLoop.js';

describe('createNoeLearningLoop（P1-4 整合）', () => {
  function makeLoop() {
    const memoryWrite = vi.fn(() => ({ id: 'mem' }));
    const skillUpsert = vi.fn((c) => ({ name: c.name }));
    const appendLine = vi.fn();
    const loop = createNoeLearningLoop({ memoryWrite, skillUpsert, appendLine, now: () => 1 });
    return { loop, memoryWrite, skillUpsert, appendLine };
  }

  it('onActFailed → 写失败教训（计数+1）', () => {
    const { loop, memoryWrite } = makeLoop();
    const r = loop.onActFailed({ action: 'noe.self_evolution.implementation', status: 'failed', error: 'no_patch_plan' });
    expect(r.created).toBe(true);
    expect(memoryWrite).toHaveBeenCalledTimes(1);
    expect(loop.stats().lessons).toBe(1);
  });

  it('onGoalDone → 蒸馏技能（计数+1）', () => {
    const { loop, skillUpsert } = makeLoop();
    const goal = { id: 'g1', title: '修复并测试', plan: [{ step: '改代码', kind: 'act' }, { step: '跑测试', kind: 'act' }] };
    const r = loop.onGoalDone(goal);
    expect(r.created).toBe(true);
    expect(skillUpsert).toHaveBeenCalledTimes(1);
    expect(loop.stats().skills).toBe(1);
  });

  it('同 goal 多次 onGoalDone → 技能计数不虚高（去重，红队修复）', () => {
    const { loop, skillUpsert } = makeLoop();
    const goal = { id: 'g-dup', title: '修复并测试', plan: [{ step: '改代码', kind: 'act' }, { step: '跑测试', kind: 'act' }] };
    loop.onGoalDone(goal);
    loop.onGoalDone(goal);
    loop.onGoalDone(goal);
    expect(skillUpsert).toHaveBeenCalledTimes(1);
    expect(loop.stats().skills).toBe(1);
  });

  it('onPreference → 采集偏好对（计数+1）', () => {
    const { loop, appendLine } = makeLoop();
    const r = loop.onPreference({ prompt: '怎么改前缀判据', chosen: 'startsWith(root+sep)', rejected: 'startsWith(root)', source: 'owner_correction' });
    expect(r.written).toBe(true);
    expect(appendLine).toHaveBeenCalledTimes(1);
    expect(loop.stats().prefs).toBe(1);
  });

  it('钩子对依赖缺失/异常 graceful no-op，不抛错', () => {
    const loop = createNoeLearningLoop({}); // 无 memoryWrite/skillUpsert/appendLine
    expect(() => loop.onActFailed({ status: 'failed', error: 'x' })).not.toThrow();
    expect(loop.onActFailed({ status: 'failed', error: 'x' }).ok).toBe(false); // memory_write_unavailable
    expect(loop.onGoalDone({ id: 'g', title: 't', plan: [{ step: 'a', kind: 'act' }, { step: 'b', kind: 'act' }] }).ok).toBe(false);
  });

  it('tick 返回学习成效快照', () => {
    const { loop } = makeLoop();
    loop.onActFailed({ action: 'a', status: 'failed', error: 'error 61 network' });
    const t = loop.tick();
    expect(t.ok).toBe(true);
    expect(t.counters.lessons).toBe(1);
    expect(t.prefStats).toBeTruthy();
  });

  it('可注入已建子器（精确 stub）', () => {
    const failureLessons = { observe: vi.fn(() => ({ ok: true, created: true })) };
    const loop = createNoeLearningLoop({ failureLessons });
    loop.onActFailed({ status: 'failed' });
    expect(failureLessons.observe).toHaveBeenCalledTimes(1);
    expect(loop.stats().lessons).toBe(1);
  });
});
