// LoopGuard 单元测试 — 4 道熔断 + 正常不触发
// 严格断言真实输出，无恒真断言

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LoopGuard, DEFAULT_LOOP_GUARD_CONFIG } from '../../../src/safety/LoopGuard.js';

describe('DEFAULT_LOOP_GUARD_CONFIG', () => {
  it('包含所有必需字段且类型正确', () => {
    expect(typeof DEFAULT_LOOP_GUARD_CONFIG.maxStepsPerTask).toBe('number');
    expect(typeof DEFAULT_LOOP_GUARD_CONFIG.maxRepeatedInstructions).toBe('number');
    expect(typeof DEFAULT_LOOP_GUARD_CONFIG.costSurgeWindowMs).toBe('number');
    expect(typeof DEFAULT_LOOP_GUARD_CONFIG.costSurgeThresholdUSD).toBe('number');
    expect(typeof DEFAULT_LOOP_GUARD_CONFIG.maxFileChurnIn10Min).toBe('number');
    expect(DEFAULT_LOOP_GUARD_CONFIG.maxStepsPerTask).toBe(30);
    expect(DEFAULT_LOOP_GUARD_CONFIG.maxRepeatedInstructions).toBe(3);
    expect(DEFAULT_LOOP_GUARD_CONFIG.costSurgeThresholdUSD).toBe(0.5);
    expect(DEFAULT_LOOP_GUARD_CONFIG.maxFileChurnIn10Min).toBe(8);
  });
});

describe('LoopGuard — steps_exceeded 熔断', () => {
  let guard;

  beforeEach(() => {
    guard = new LoopGuard({ maxStepsPerTask: 3, maxRepeatedInstructions: 99 });
  });

  it('未超限时 recordInstruction 返回 null', () => {
    expect(guard.recordInstruction('a')).toBeNull();
    expect(guard.recordInstruction('b')).toBeNull();
    expect(guard.recordInstruction('c')).toBeNull();
  });

  it('第 maxStepsPerTask+1 次触发 steps_exceeded', () => {
    guard.recordInstruction('x');
    guard.recordInstruction('x');
    guard.recordInstruction('x');
    const result = guard.recordInstruction('x'); // 第 4 次
    expect(result).not.toBeNull();
    expect(result.type).toBe('steps_exceeded');
    expect(result.current).toBe(4);
    expect(result.max).toBe(3);
  });

  it('熔断后继续调用 current 继续递增', () => {
    for (let i = 0; i < 5; i++) guard.recordInstruction('z');
    const result = guard.recordInstruction('z');
    expect(result.type).toBe('steps_exceeded');
    expect(result.current).toBe(6);
  });

  it('resetTask 后计步器归零', () => {
    guard.recordInstruction('a');
    guard.recordInstruction('b');
    guard.recordInstruction('c');
    guard.resetTask();
    // 重置后前 3 次不触发
    expect(guard.recordInstruction('a')).toBeNull();
    expect(guard.recordInstruction('b')).toBeNull();
    expect(guard.recordInstruction('c')).toBeNull();
    // 第 4 次再触发
    const r = guard.recordInstruction('d');
    expect(r.type).toBe('steps_exceeded');
  });
});

describe('LoopGuard — repeated_instruction 熔断', () => {
  let guard;

  beforeEach(() => {
    // maxStepsPerTask 足够大不干扰
    guard = new LoopGuard({ maxStepsPerTask: 100, maxRepeatedInstructions: 3 });
  });

  it('相同指令未达阈值时不触发', () => {
    expect(guard.recordInstruction('do_thing')).toBeNull();
    expect(guard.recordInstruction('do_thing')).toBeNull();
    // 只有 2 次，尚未达到 3 次
  });

  it('连续相同指令达到 maxRepeatedInstructions 触发', () => {
    guard.recordInstruction('do_thing');
    guard.recordInstruction('do_thing');
    const result = guard.recordInstruction('do_thing');
    expect(result).not.toBeNull();
    expect(result.type).toBe('repeated_instruction');
    expect(result.count).toBe(3);
    expect(result.text).toBe('do_thing');
  });

  it('中间穿插不同指令不触发重复熔断', () => {
    guard.recordInstruction('aaa');
    guard.recordInstruction('bbb'); // 不同，打断连续
    const r = guard.recordInstruction('aaa');
    expect(r).toBeNull(); // 没有连续 3 次
  });

  it('超长 text 被截断到 200 字符', () => {
    const longText = 'x'.repeat(300);
    guard.recordInstruction(longText);
    guard.recordInstruction(longText);
    const result = guard.recordInstruction(longText);
    expect(result.type).toBe('repeated_instruction');
    expect(result.text.length).toBe(200);
  });

  it('recentInstructions 最多保留 10 条', () => {
    for (let i = 0; i < 15; i++) {
      guard.recordInstruction(`unique_${i}`);
    }
    const snap = guard.snapshot();
    expect(snap.recentInstructionsCount).toBeLessThanOrEqual(10);
  });
});

describe('LoopGuard — cost_surge 熔断', () => {
  let guard;

  beforeEach(() => {
    guard = new LoopGuard({ costSurgeThresholdUSD: 0.5 });
  });

  it('窗口 USD 未超阈值时返回 null', () => {
    expect(guard.recordCost(0.3)).toBeNull();
    expect(guard.recordCost(0.5)).toBeNull(); // 等于阈值不触发（严格大于）
  });

  it('窗口 USD 超过阈值触发 cost_surge', () => {
    const result = guard.recordCost(0.51);
    expect(result).not.toBeNull();
    expect(result.type).toBe('cost_surge');
    expect(result.threshold).toBe(0.5);
    expect(result.usdInWindow).toBe(0.51);
  });

  it('usdInWindow 四舍五入到两位小数', () => {
    const result = guard.recordCost(0.6789);
    expect(result.type).toBe('cost_surge');
    expect(result.usdInWindow).toBe(0.68);
  });

  it('多次调用 recordCost 各自独立判断，不累计', () => {
    expect(guard.recordCost(0.4)).toBeNull();
    expect(guard.recordCost(0.4)).toBeNull(); // 0.4+0.4 不累计，每次独立
    const r = guard.recordCost(0.6);
    expect(r.type).toBe('cost_surge'); // 0.6 本身超阈值
  });
});

describe('LoopGuard — file_churn 熔断', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('10 分钟内同文件改动未超限时返回 null', () => {
    const guard = new LoopGuard({ maxFileChurnIn10Min: 8 });
    for (let i = 0; i < 8; i++) {
      const r = guard.recordFileChange('src/foo.js');
      expect(r).toBeNull();
    }
  });

  it('10 分钟内同文件超过 maxFileChurnIn10Min 触发 file_churn', () => {
    const guard = new LoopGuard({ maxFileChurnIn10Min: 8 });
    for (let i = 0; i < 8; i++) guard.recordFileChange('src/foo.js');
    const result = guard.recordFileChange('src/foo.js'); // 第 9 次
    expect(result).not.toBeNull();
    expect(result.type).toBe('file_churn');
    expect(result.file).toBe('src/foo.js');
    expect(result.churnCount).toBe(9);
  });

  it('超过 10 分钟的旧记录不计入 churn', () => {
    const guard = new LoopGuard({ maxFileChurnIn10Min: 3 });
    // 先写 3 次（恰好在限制边缘）
    guard.recordFileChange('a.js');
    guard.recordFileChange('a.js');
    guard.recordFileChange('a.js');
    // 推进 11 分钟，旧记录超时
    vi.advanceTimersByTime(11 * 60 * 1000);
    // 这次是窗口内第 1 次，不触发
    const result = guard.recordFileChange('a.js');
    expect(result).toBeNull();
  });

  it('不同文件的 churn 互不干扰', () => {
    const guard = new LoopGuard({ maxFileChurnIn10Min: 3 });
    for (let i = 0; i < 3; i++) guard.recordFileChange('fileA.js');
    // fileA 改了 3 次未超（churn>3 才触发），fileB 不受影响
    for (let i = 0; i < 3; i++) {
      expect(guard.recordFileChange('fileB.js')).toBeNull();
    }
    // fileA 第 4 次才触发
    const r = guard.recordFileChange('fileA.js');
    expect(r.type).toBe('file_churn');
    expect(r.file).toBe('fileA.js');
  });

  it('churnedFiles snapshot 只计窗口内条数', () => {
    const guard = new LoopGuard({ maxFileChurnIn10Min: 100 });
    guard.recordFileChange('a.js');
    guard.recordFileChange('b.js');
    // 推进到超时
    vi.advanceTimersByTime(11 * 60 * 1000);
    guard.recordFileChange('c.js'); // 触发一次过滤
    const snap = guard.snapshot();
    // 旧的 a.js / b.js 超时被清，只剩 c.js
    expect(snap.churnedFiles).toBe(1);
  });
});

describe('LoopGuard — 正常情况不触发任何熔断', () => {
  let guard;

  beforeEach(() => {
    vi.useFakeTimers();
    guard = new LoopGuard();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('各种不同指令正常记录，无熔断', () => {
    const instructions = ['step1', 'step2', 'step3', 'step4', 'step5'];
    for (const inst of instructions) {
      expect(guard.recordInstruction(inst)).toBeNull();
    }
  });

  it('低成本调用不触发熔断', () => {
    expect(guard.recordCost(0.1)).toBeNull();
    expect(guard.recordCost(0.2)).toBeNull();
    expect(guard.recordCost(0.49)).toBeNull();
  });

  it('少量文件改动不触发熔断', () => {
    const files = ['a.js', 'b.js', 'c.js'];
    for (const f of files) {
      expect(guard.recordFileChange(f)).toBeNull();
    }
  });
});

describe('LoopGuard — snapshot()', () => {
  it('返回当前状态快照', () => {
    const guard = new LoopGuard({ maxStepsPerTask: 10 });
    guard.recordInstruction('x');
    guard.recordInstruction('y');
    const snap = guard.snapshot();
    expect(snap.stepsThisTask).toBe(2);
    expect(snap.recentInstructionsCount).toBe(2);
    expect(snap.config.maxStepsPerTask).toBe(10);
    expect(typeof snap.churnedFiles).toBe('number');
  });
});

describe('LoopGuard — 自定义 config 覆盖默认值', () => {
  it('自定义 maxStepsPerTask 生效', () => {
    const guard = new LoopGuard({ maxStepsPerTask: 2 });
    guard.recordInstruction('a');
    guard.recordInstruction('b');
    const r = guard.recordInstruction('c');
    expect(r.type).toBe('steps_exceeded');
    expect(r.max).toBe(2);
  });

  it('自定义 costSurgeThresholdUSD 生效', () => {
    const guard = new LoopGuard({ costSurgeThresholdUSD: 1.0 });
    expect(guard.recordCost(0.99)).toBeNull();
    expect(guard.recordCost(1.01).type).toBe('cost_surge');
  });

  it('未指定字段回退到默认值', () => {
    const guard = new LoopGuard({ maxStepsPerTask: 5 });
    expect(guard.snapshot().config.maxRepeatedInstructions).toBe(DEFAULT_LOOP_GUARD_CONFIG.maxRepeatedInstructions);
  });
});
