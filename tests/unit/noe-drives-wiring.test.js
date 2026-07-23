// @ts-check
// 驱力系统三处接线防回归（意识工程·阶段1）：驱力简报必须真的进 prompt / 自我状态块；
// 未注入或驱力弱时与接线前行为逐字一致；探针抛错绝不阻断原功能（fail-open）。
import { describe, it, expect } from 'vitest';
import { createInnerMonologue } from '../../src/loop/InnerMonologue.js';
import { createProactiveTickHandler } from '../../src/loop/proactiveTick.js';
import { NoeSelfModel } from '../../src/context/NoeSelfModel.js';

/** 捕获式假大脑：记下 messages，回固定话。 */
function captureAdapter(reply = '想到了一件事') {
  /** @type {any[]} */
  const calls = [];
  return {
    calls,
    chat: async (messages) => { calls.push(messages); return { reply }; },
  };
}

const fakeTimeline = () => {
  /** @type {any[]} */
  const recorded = [];
  return {
    recorded,
    recent: () => [{ type: 'interaction', summary: '主人问了天气', ts: Date.now() - 60000, salience: 3 }],
    record: (e) => { recorded.push(e); return recorded.length; },
  };
};

describe('InnerMonologue × driveBrief', () => {
  it('注入驱力简报 → 反刍 prompt 含「我此刻最强的内在驱力」', async () => {
    const adapter = captureAdapter();
    const reflect = createInnerMonologue({
      timeline: fakeTimeline(),
      getAdapter: () => adapter,
      driveBrief: () => '社交：已经 6.0 小时没和主人说话了，挺想他的',
    });
    const r = await reflect();
    expect(r.reflected).toBe(true);
    const userMsg = adapter.calls[0].find((m) => m.role === 'user');
    expect(userMsg.content).toContain('我此刻最强的内在驱力：社交');
    expect(userMsg.content).toContain('挺想他的');
  });

  it('driveBrief 返回 null（驱力弱）→ prompt 不含驱力段（与接线前逐字一致）', async () => {
    const adapter = captureAdapter();
    const reflect = createInnerMonologue({ timeline: fakeTimeline(), getAdapter: () => adapter, driveBrief: () => null });
    await reflect();
    expect(adapter.calls[0].find((m) => m.role === 'user').content).not.toContain('内在驱力');
  });

  it('driveBrief 抛错 → 反刍照常（fail-open）', async () => {
    const adapter = captureAdapter();
    const reflect = createInnerMonologue({
      timeline: fakeTimeline(),
      getAdapter: () => adapter,
      driveBrief: () => { throw new Error('探针炸了'); },
    });
    const r = await reflect();
    expect(r.reflected).toBe(true);
    expect(adapter.calls[0].find((m) => m.role === 'user').content).not.toContain('内在驱力');
  });
});

describe('proactiveTick × driveBrief', () => {
  const mkVision = () => ({ latest: () => ({ summary: '主人在写代码' }) });

  it('注入驱力简报 → 大脑判断的 user 内容含「你此刻的内在状态」', async () => {
    const adapter = captureAdapter('加油哦主人');
    const tick = createProactiveTickHandler({
      visionSession: mkVision(),
      getAdapter: () => adapter,
      driveBrief: () => '社交：想主人了',
    });
    const r = await tick();
    expect(r.spoke).toBe(true);
    const userMsg = adapter.calls[0].find((m) => m.role === 'user');
    expect(userMsg.content).toContain('你此刻的内在状态：社交：想主人了');
  });

  it('未注入 driveBrief → user 内容不含内在状态段（与接线前逐字一致）', async () => {
    const adapter = captureAdapter('加油哦主人');
    const tick = createProactiveTickHandler({ visionSession: mkVision(), getAdapter: () => adapter });
    await tick();
    expect(adapter.calls[0].find((m) => m.role === 'user').content).not.toContain('内在状态');
  });

  it('driveBrief 抛错 → 主动陪伴照常不崩（fail-open）', async () => {
    const adapter = captureAdapter('加油哦主人');
    const tick = createProactiveTickHandler({
      visionSession: mkVision(),
      getAdapter: () => adapter,
      driveBrief: () => { throw new Error('探针炸了'); },
    });
    const r = await tick();
    expect(r.spoke).toBe(true);
  });
});

describe('NoeSelfModel × driveSystem', () => {
  const bareTimeline = { recent: () => [] };

  it('驱力强 → 自我状态块含「内在驱力」行', () => {
    const sm = new NoeSelfModel({
      timeline: /** @type {any} */ (bareTimeline),
      driveSystem: { brief: () => '好奇：最近冒出 8 件新鲜事，想琢磨琢磨', snapshot: () => ({}) },
    });
    expect(sm.buildSelfStateBlock()).toContain('- 内在驱力：好奇：最近冒出 8 件新鲜事');
  });

  it('驱力弱（brief null）/ 未注入 → 块中无此行（与现状逐字一致）', () => {
    const weak = new NoeSelfModel({
      timeline: /** @type {any} */ (bareTimeline),
      driveSystem: { brief: () => null, snapshot: () => ({}) },
    });
    expect(weak.buildSelfStateBlock()).not.toContain('内在驱力');
    const none = new NoeSelfModel({ timeline: /** @type {any} */ (bareTimeline) });
    expect(none.buildSelfStateBlock()).not.toContain('内在驱力');
  });

  it('brief 抛错 → 块照常生成（fail-open）', () => {
    const sm = new NoeSelfModel({
      timeline: /** @type {any} */ (bareTimeline),
      driveSystem: { brief: () => { throw new Error('炸'); }, snapshot: () => ({}) },
    });
    const block = sm.buildSelfStateBlock();
    expect(block).toContain('<noe-self-state>');
    expect(block).not.toContain('内在驱力');
  });
});
