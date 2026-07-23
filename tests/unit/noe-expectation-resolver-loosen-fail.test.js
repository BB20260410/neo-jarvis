// @ts-check
import { describe, expect, it } from 'vitest';
import { createExpectationResolver, buildEventsEvidence } from '../../src/cognition/NoeExpectationResolver.js';

// NOE_EXPECT_LOOSEN_FAIL：放宽「失败结果信号」识别，让真实落空（终态负面同义词）能被据实判成 0。
// 不依赖 process.env：loosenFail 显式注入 boolean。不碰真库真模型（mock ledger + mock adapter）。
// 关键不变量：放宽只扩 FAILED-信号提示覆盖面；是否真落账成 0 仍要模型确认（不伪造结算）。

function makeExp(over = {}) { return { id: 1, claim: '完成自我观察', p: 0.75, created_at: 1000, due_at: 2000, ...over }; }
function makeLedger(dueRows = []) {
  const resolved = [];
  return { resolved, due: () => dueRows, resolve: (id, outcome, t) => { resolved.push({ id, outcome, t }); return { id, outcome }; } };
}
function adapterReplying(reply) { return { chat: async () => ({ reply }) }; }
function adapterReplyingSequence(replies = []) {
  let i = 0;
  const calls = [];
  return {
    calls,
    chat: async (messages, opts) => {
      calls.push({ messages, opts });
      const reply = replies[Math.min(i, replies.length - 1)] || '';
      i += 1;
      return { reply };
    },
  };
}

// result=cancelled：跑了但被取消（终态负面）。BASE 正则不认；LOOSE 认。claim 与 stdoutSummary 语义直连。
const CANCELLED_EVENT = [{
  ts: 1700000000000,
  kind: 'activity',
  payload: { action: 'noe.goal_step.act', status: 'cancelled', result: 'cancelled', details: { stdoutSummary: '完成自我观察 任务被取消' } },
}];

describe('NOE_EXPECT_LOOSEN_FAIL（保守放宽失败信号识别）', () => {
  it('OFF（BASE，默认）：result=cancelled 不被认成失败信号', async () => {
    const ledger = makeLedger([makeExp()]);
    const resolver = createExpectationResolver({
      ledger, getAdapter: () => adapterReplying('UNKNOWN'),
      evidence: buildEventsEvidence(() => CANCELLED_EVENT), loosenFail: false,
    });
    const r = await resolver.tick();
    expect(r.judged[0].evidenceDecisionHint.profile.failureSignals).toBe(0);
    expect(r.judged[0].evidenceDecisionHint.label).not.toBe('action_failure_signal');
  });

  it('ON（LOOSE）：result=cancelled 出 action_failure_signal + FAILED 提示', async () => {
    const ledger = makeLedger([makeExp()]);
    const resolver = createExpectationResolver({
      ledger, getAdapter: () => adapterReplying('UNKNOWN'),
      evidence: buildEventsEvidence(() => CANCELLED_EVENT), loosenFail: true,
    });
    const r = await resolver.tick();
    expect(r.judged[0].evidenceDecisionHint.label).toBe('action_failure_signal');
    expect(r.judged[0].evidenceDecisionHint.suggestedVerdict).toBe('FAILED');
    expect(r.judged[0].evidenceDecisionHint.profile.failureSignals).toBeGreaterThan(0);
  });

  it('ON 且模型据证回 FAILED：真落账 outcome=0（据实结算，非伪造）', async () => {
    const ledger = makeLedger([makeExp()]);
    const resolver = createExpectationResolver({
      ledger, getAdapter: () => adapterReplying('FAILED'),
      evidence: buildEventsEvidence(() => CANCELLED_EVENT), loosenFail: true,
    });
    const r = await resolver.tick();
    expect(r.resolved).toBe(1);
    expect(ledger.resolved[0].outcome).toBe(0);
  });

  it('ON 且第一轮 UNKNOWN 覆盖失败提示：二次裁判 FAILED 后真落账 outcome=0', async () => {
    const ledger = makeLedger([makeExp()]);
    const adapter = adapterReplyingSequence([
      '{"verdict":"UNKNOWN","reasonCode":"insufficient_direct_evidence","hintAgreement":"override"}',
      '{"verdict":"FAILED","reasonCode":"direct_failure","hintAgreement":"agree"}',
    ]);
    const harvestCalls = [];
    const resolver = createExpectationResolver({
      ledger,
      getAdapter: () => adapter,
      goalSystem: { harvestSurprise: (arg) => { harvestCalls.push(arg); return 'surprise-goal-1'; } },
      evidence: buildEventsEvidence(() => CANCELLED_EVENT),
      loosenFail: true,
      decisiveReask: true,
    });
    const r = await resolver.tick();
    expect(r.resolved).toBe(1);
    expect(ledger.resolved[0].outcome).toBe(0);
    expect(adapter.calls).toHaveLength(2);
    expect(harvestCalls).toEqual([{ claim: '完成自我观察', surprise: undefined, origin: 'loosen_fail' }]); // P1-C 整改 F1：仅 loosen 放宽(cancelled)才认的落空标 loosen_fail 噪声桶
    expect(r.judged[0]).toMatchObject({
      outcome: 0,
      reason: 'llm_failed',
      decisiveReask: {
        attempted: true,
        firstReasonCode: 'insufficient_direct_evidence',
        secondReasonCode: 'direct_failure',
        outcome: 0,
      },
    });
  });

  it('ON 但模型仍回 UNKNOWN：不落账（提示不替代裁决，绝不伪造结算）', async () => {
    const ledger = makeLedger([makeExp()]);
    const resolver = createExpectationResolver({
      ledger, getAdapter: () => adapterReplying('UNKNOWN'),
      evidence: buildEventsEvidence(() => CANCELLED_EVENT), loosenFail: true,
    });
    const r = await resolver.tick();
    expect(r.resolved).toBe(0);
    expect(ledger.resolved).toHaveLength(0);
  });

  it('ON 但 result=not_found（证据缺位≠落空）：不被认成失败信号', async () => {
    const NF = [{ ts: 1700000000000, kind: 'activity', payload: { action: 'noe.goal_step.act', status: 'not_found', result: 'not_found', details: { stdoutSummary: '完成自我观察 未检索到' } } }];
    const ledger = makeLedger([makeExp()]);
    const resolver = createExpectationResolver({
      ledger, getAdapter: () => adapterReplying('UNKNOWN'),
      evidence: buildEventsEvidence(() => NF), loosenFail: true,
    });
    const r = await resolver.tick();
    // not_found 在 LOOSE 下也不算失败：要么无失败信号、要么根本不出 action_failure_signal
    const hint = r.judged[0].evidenceDecisionHint;
    if (hint) {
      expect(hint.profile.failureSignals).toBe(0);
      expect(hint.label).not.toBe('action_failure_signal');
    }
    expect(r.resolved).toBe(0);
  });

  it('OFF 与既有真实成功证据路径无关（成功仍走 APPLIED 提示，证明只动 failure 支路）', async () => {
    const SUCCESS = [{ ts: 1700000000000, kind: 'activity', payload: { action: 'noe.goal_step.act', status: 'succeeded', ok: true, result: 'done', details: { stdoutSummary: '完成自我观察' } } }];
    const ledger = makeLedger([makeExp()]);
    const resolver = createExpectationResolver({
      ledger, getAdapter: () => adapterReplying('UNKNOWN'),
      evidence: buildEventsEvidence(() => SUCCESS), loosenFail: false,
    });
    const r = await resolver.tick();
    expect(r.judged[0].evidenceDecisionHint.label).toBe('action_success_signal');
    expect(r.judged[0].evidenceDecisionHint.suggestedVerdict).toBe('APPLIED');
  });
});
