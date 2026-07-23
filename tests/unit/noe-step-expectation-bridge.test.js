// @ts-check
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStepExpectationBridge } from '../../src/cognition/NoeStepExpectationBridge.js';

function makeLedger({ addReturns = 1, surprise = 2.32 } = {}) {
  const calls = { add: [], resolve: [] };
  return {
    calls,
    add: (a) => { calls.add.push(a); return addReturns; },
    resolve: (id, oc, t, by) => { calls.resolve.push({ id, oc, by, t }); return { claim: '完成步骤：部署X', surprise, outcome: oc }; },
  };
}
function makeGoalSystem() {
  const calls = [];
  return { calls, harvestSurprise: (a) => { calls.push(a); return 'curiosity-goal-1'; } };
}

describe('createStepExpectationBridge（阶段1 修活好奇回路供给端）', () => {
  beforeEach(() => { process.env.NOE_STEP_EXPECTATION_RESOLVE = '1'; });
  afterEach(() => { delete process.env.NOE_STEP_EXPECTATION_RESOLVE; });

  it('flag OFF → 零行为（onStepFailed return null，不碰 ledger）', () => {
    delete process.env.NOE_STEP_EXPECTATION_RESOLVE;
    const ledger = makeLedger(); const gs = makeGoalSystem();
    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs });
    expect(b.onStepFailed({ stepText: '部署X', kind: 'act', terminal: 'failed' })).toBeNull();
    expect(ledger.calls.add).toHaveLength(0);
  });

  it('act 真失败 → add 预测 + resolve(outcome=0) + harvestSurprise(action_failure)', () => {
    const ledger = makeLedger({ surprise: 2.32 }); const gs = makeGoalSystem();
    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs });
    const r = b.onStepFailed({ stepText: '部署到不存在的服务', kind: 'act', terminal: 'failed' });
    expect(ledger.calls.add[0]).toMatchObject({ p: 0.8, source: 'step_prediction' });
    expect(ledger.calls.resolve[0]).toMatchObject({ oc: 0, by: 'auto' }); // outcome=0 真落空
    expect(gs.calls[0]).toMatchObject({ origin: 'action_failure', surprise: 2.32 }); // 好奇回路有米下锅
    expect(r.curiosityGoalId).toBe('curiosity-goal-1');
  });

  it('research 失败同样触发', () => {
    const ledger = makeLedger(); const gs = makeGoalSystem();
    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs });
    b.onStepFailed({ stepText: '查不到资料', kind: 'research', terminal: 'failed', failureReason: '检索为空' });
    expect(gs.calls[0].origin).toBe('action_failure');
  });

  it('think step 不触发（无客观成败）', () => {
    const ledger = makeLedger(); const gs = makeGoalSystem();
    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs });
    expect(b.onStepFailed({ stepText: '想一想', kind: 'think', terminal: 'failed' })).toBeNull();
    expect(ledger.calls.add).toHaveLength(0);
  });

  it('done/doing 不触发（只认 failed/blocked）', () => {
    const ledger = makeLedger(); const gs = makeGoalSystem();
    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs });
    expect(b.onStepFailed({ stepText: 'X', kind: 'act', terminal: 'done' })).toBeNull();
    expect(b.onStepFailed({ stepText: 'X', kind: 'act', terminal: 'doing' })).toBeNull();
  });

  it('surprise < 阈值 → 不立好奇目标（但仍 resolve outcome=0）', () => {
    const ledger = makeLedger({ surprise: 1.0 }); const gs = makeGoalSystem();
    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs, surpriseThreshold: 2 });
    const r = b.onStepFailed({ stepText: '低 p 步骤失败', kind: 'act', terminal: 'failed' });
    expect(ledger.calls.resolve[0].oc).toBe(0); // 仍判落空
    expect(gs.calls).toHaveLength(0); // 但不够惊奇，不立目标
    expect(r.curiosityGoalId).toBeNull();
  });

  it('add 去重命中（return null）→ 不重复 resolve/harvest（防反复刷同一失败）', () => {
    const ledger = makeLedger({ addReturns: null }); const gs = makeGoalSystem(); // add 返回 null = 去重命中
    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs });
    expect(b.onStepFailed({ stepText: '重复失败', kind: 'act', terminal: 'failed' })).toBeNull();
    expect(ledger.calls.resolve).toHaveLength(0);
    expect(gs.calls).toHaveLength(0);
  });

  it('fail-open：ledger.resolve 抛错不崩', () => {
    const gs = makeGoalSystem();
    const ledger = { add: () => 1, resolve: () => { throw new Error('db boom'); } };
    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs });
    expect(b.onStepFailed({ stepText: 'X', kind: 'act', terminal: 'failed' })).toBeNull();
  });

  it('RH-1：系统自拦（安全门/无 executor/上下文不足）排除，零 surprise（防奖励「故意提会被拦的 act」）', () => {
    const ledger = makeLedger(); const gs = makeGoalSystem();
    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs });
    expect(b.onStepFailed({ stepText: '危险命令', kind: 'act', terminal: 'blocked', failureReason: 'blocked_safety' })).toMatchObject({ skipped: 'system_gate' });
    expect(b.onStepFailed({ stepText: '无 executor', kind: 'act', terminal: 'blocked', failureReason: 'executor_not_registered' })).toMatchObject({ skipped: 'system_gate' });
    expect(b.onStepFailed({ stepText: '上下文不足', kind: 'act', terminal: 'blocked', failureReason: 'context_sufficiency_not_met' })).toMatchObject({ skipped: 'system_gate' });
    expect(gs.calls).toHaveLength(0); // 系统拦一律不产 surprise
  });

  it('RH-1：真执行失败（非系统拦）仍产 surprise', () => {
    const ledger = makeLedger(); const gs = makeGoalSystem();
    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs });
    const r = b.onStepFailed({ stepText: '真跑了但失败', kind: 'act', terminal: 'failed', failureReason: 'exit code 1: assertion failed' });
    expect(r.curiosityGoalId).toBe('curiosity-goal-1');
  });

  it('RH-1：瞬时环境噪声（timeout/network/限流/5xx）skip:transient（不是认知缺口，M3 漏洞 B）', () => {
    const ledger = makeLedger(); const gs = makeGoalSystem();
    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs });
    expect(b.onStepFailed({ stepText: '拉取数据', kind: 'act', terminal: 'failed', failureReason: 'request timeout after 30s' })).toMatchObject({ skipped: 'transient' });
    expect(b.onStepFailed({ stepText: '调接口', kind: 'act', terminal: 'failed', failureReason: 'ECONNRESET on socket' })).toMatchObject({ skipped: 'transient' });
    expect(b.onStepFailed({ stepText: '查询', kind: 'act', terminal: 'failed', failureReason: 'HTTP 503 temporarily unavailable' })).toMatchObject({ skipped: 'transient' });
    expect(gs.calls).toHaveLength(0); // 噪声一律不产 surprise
  });

  it('P1-E（修三方审查 minor）：中文瞬时错误（超时/网络异常/服务不可用/稍后重试/限流）skip:transient（\\b 词边界对中文无效，英文 RE 漏判）', () => {
    const ledger = makeLedger(); const gs = makeGoalSystem();
    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs });
    expect(b.onStepFailed({ stepText: '拉数据', kind: 'act', terminal: 'failed', failureReason: '请求超时，请稍后重试' })).toMatchObject({ skipped: 'transient' });
    expect(b.onStepFailed({ stepText: '调模型', kind: 'act', terminal: 'failed', failureReason: '网络异常，连接中断' })).toMatchObject({ skipped: 'transient' });
    expect(b.onStepFailed({ stepText: '查接口', kind: 'act', terminal: 'failed', failureReason: '服务暂不可用' })).toMatchObject({ skipped: 'transient' });
    expect(b.onStepFailed({ stepText: '发请求', kind: 'act', terminal: 'failed', failureReason: '请求过于频繁，已限流' })).toMatchObject({ skipped: 'transient' });
    expect(gs.calls).toHaveLength(0); // 中文噪声同样不产 surprise
  });

  it('P1-E 反向 probe：中文真失败（断言/解析/校验失败）不被中文瞬时 RE 误杀，仍产 surprise', () => {
    const ledger = makeLedger(); const gs = makeGoalSystem();
    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs });
    const r = b.onStepFailed({ stepText: '执行数据校验', kind: 'act', terminal: 'failed', failureReason: '断言失败：期望值与实际值不符' });
    expect(r.curiosityGoalId).toBe('curiosity-goal-1'); // 真失败照产 surprise，没被中文瞬时 RE 误杀
  });

  it('RH-1：含 not_met/budget 子串的真失败(failed 路)不再被裸子串误杀（治三方 RH-1 漏洞）', () => {
    const ledger = makeLedger(); const gs = makeGoalSystem();
    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs });
    const r = b.onStepFailed({ stepText: '执行数据校验断言步骤', kind: 'act', terminal: 'failed', failureReason: 'assertion failed: requirement not_met by runtime' });
    expect(r.curiosityGoalId).toBe('curiosity-goal-1'); // 真失败照产 surprise，没被 not_met 子串误杀
  });

  it('RH-2：同步骤不同失败措辞落同桶(klass=real)→ 去重生效（治措辞绕过）', () => {
    const ledger = makeLedger(); const gs = makeGoalSystem();
    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs, now: () => 2000 });
    b.onStepFailed({ stepText: '研究AI对齐', kind: 'act', terminal: 'failed', failureReason: 'parse error in line 5' });
    // 同步骤换 real 失败措辞——旧版 reason 前40字不同会绕过，新版 klass 同=real → 去重
    expect(b.onStepFailed({ stepText: '研究AI对齐', kind: 'act', terminal: 'failed', failureReason: 'unexpected token at position 12' })).toMatchObject({ skipped: 'deduped' });
    expect(gs.calls).toHaveLength(1);
  });

  it('RH-2：同指纹短窗去重（防措辞变化反复刷 surprise）', () => {
    const ledger = makeLedger(); const gs = makeGoalSystem();
    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs, now: () => 1000 });
    b.onStepFailed({ stepText: '同一个失败', kind: 'act', terminal: 'failed' });
    expect(b.onStepFailed({ stepText: '同一个失败', kind: 'act', terminal: 'failed' })).toMatchObject({ skipped: 'deduped' });
    expect(gs.calls).toHaveLength(1);
  });

  it('RH-2：每小时限速（防一波失败刷爆 surprise 账本）', () => {
    const ledger = makeLedger(); const gs = makeGoalSystem();
    let t = 1000;
    const b = createStepExpectationBridge({ expectationLedger: ledger, goalSystem: gs, now: () => t, maxPerHour: 2 });
    b.onStepFailed({ stepText: '失败A', kind: 'act', terminal: 'failed' }); t += 100;
    b.onStepFailed({ stepText: '失败B', kind: 'act', terminal: 'failed' }); t += 100;
    expect(b.onStepFailed({ stepText: '失败C', kind: 'act', terminal: 'failed' })).toMatchObject({ skipped: 'rate_limited' });
    expect(gs.calls).toHaveLength(2);
  });
});
