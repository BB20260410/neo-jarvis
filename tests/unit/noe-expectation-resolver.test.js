import { describe, expect, it } from 'vitest';
import { buildClaimLinkNeedles, buildEventsEvidence, createExpectationResolver, parseVerdict, parseVerdictDetail, scoreCandidateClaimLink } from '../../src/cognition/NoeExpectationResolver.js';
import { normalizeNoeAutoModel } from '../../src/model/NoeLocalModelPolicy.js';

// NoeExpectationResolver：期望到期自动判证（宁缺勿错判）。
// mock ledger + mock adapter.chat 直接测 tick/judgeOne 分支，不碰真库真模型。

function makeExp(over = {}) {
  return { id: 1, claim: '三天内能列出至少 5 个原始念头', p: 0.75, created_at: 1000, due_at: 2000, ...over };
}

function makeLedger(dueRows = []) {
  const resolved = [];
  return {
    resolved,
    due: () => dueRows,
    resolve: (id, outcome, t) => { resolved.push({ id, outcome, t }); return { id, outcome }; },
  };
}

function adapterReplying(reply) {
  const calls = [];
  return {
    calls,
    chat: async (messages, opts) => { calls.push({ messages, opts }); return { reply }; },
  };
}

function adapterReplyingSequence(replies = []) {
  const calls = [];
  let i = 0;
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

const POSITIVE_EVIDENCE = () => '- [thought] 已列出 6 个原始念头';

describe('parseVerdict', () => {
  it('识别三种裁决词', () => {
    expect(parseVerdict('APPLIED')).toBe(1);
    expect(parseVerdict('failed')).toBe(0);
    expect(parseVerdict('UNKNOWN')).toBe(null);
    expect(parseVerdict('裁决：已应验')).toBe(1);
    expect(parseVerdict('结论：未应验')).toBe(0);
    expect(parseVerdict('无法判断')).toBe(null);
  });

  it('容忍思维链废话：取最后一个关键词', () => {
    expect(parseVerdict('先想想…可能 FAILED？不对，证据里明确做到了。最终：APPLIED')).toBe(1);
  });

  it('无关键词视为 UNKNOWN', () => {
    expect(parseVerdict('我觉得大概是吧')).toBe(null);
    expect(parseVerdict('不能判断是否应验')).toBe(null);
    expect(parseVerdict('')).toBe(null);
  });

  it('返回 parser 来源用于区分明确 unknown 与未解析回复', () => {
    expect(parseVerdictDetail('UNKNOWN')).toEqual({ outcome: null, parser: 'en_unknown' });
    expect(parseVerdictDetail('裁决：已完成')).toEqual({ outcome: 1, parser: 'zh_applied' });
    expect(parseVerdictDetail('结果：不成立')).toEqual({ outcome: 0, parser: 'zh_failed' });
    expect(parseVerdictDetail('我觉得大概是吧')).toEqual({ outcome: null, parser: 'unparsed' });
  });

  it('优先解析严格 JSON 裁决并保留安全 reason code', () => {
    expect(parseVerdictDetail('{"verdict":"APPLIED","reasonCode":"direct_success","hintAgreement":"agree"}')).toEqual({
      outcome: 1,
      parser: 'json_applied',
      verdictReasonCode: 'direct_success',
      hintAgreement: 'agree',
    });
    expect(parseVerdictDetail('{"verdict":"UNKNOWN","reason_code":"claim mismatch<script>","hint_agreement":"override"}')).toEqual({
      outcome: null,
      parser: 'json_unknown',
      verdictReasonCode: 'claim_mismatch_script',
      hintAgreement: 'override',
    });
  });
});

describe('createExpectationResolver.tick', () => {
  it('无到期期望时零调用零结算', async () => {
    const ledger = makeLedger([]);
    const adapter = adapterReplying('APPLIED');
    const resolver = createExpectationResolver({ ledger, getAdapter: () => adapter });
    const r = await resolver.tick();
    expect(r).toEqual({ checked: 0, resolved: 0 });
    expect(adapter.calls).toHaveLength(0);
  });

  it('APPLIED 裁决落账 outcome=1', async () => {
    const ledger = makeLedger([makeExp()]);
    const resolver = createExpectationResolver({ ledger, getAdapter: () => adapterReplying('APPLIED'), evidence: POSITIVE_EVIDENCE });
    const r = await resolver.tick(5000);
    expect(r.resolved).toBe(1);
    expect(ledger.resolved).toEqual([{ id: 1, outcome: 1, t: 5000 }]);
  });

  it('FAILED 裁决落账 outcome=0', async () => {
    const ledger = makeLedger([makeExp()]);
    const resolver = createExpectationResolver({ ledger, getAdapter: () => adapterReplying('FAILED'), evidence: POSITIVE_EVIDENCE });
    const r = await resolver.tick();
    expect(r.resolved).toBe(1);
    expect(ledger.resolved[0].outcome).toBe(0);
  });

  it('UNKNOWN 不落账（留给人工/7 天 sweep）', async () => {
    const ledger = makeLedger([makeExp()]);
    const resolver = createExpectationResolver({ ledger, getAdapter: () => adapterReplying('UNKNOWN'), evidence: POSITIVE_EVIDENCE });
    const r = await resolver.tick();
    expect(r.resolved).toBe(0);
    expect(ledger.resolved).toHaveLength(0);
    expect(r.judged[0].reason).toBe('llm_unknown');
    expect(r.judged[0].evidenceStats).toEqual({ chars: POSITIVE_EVIDENCE().length, lines: 1 });
    expect(r.judged[0].replyStats).toEqual({ chars: 'UNKNOWN'.length, lines: 1 });
    expect(r.judged[0].verdictParser).toBe('en_unknown');
  });

  it('抗刷假学习不变量(多模型安全方案步骤1)：空证据→no_evidence，即便 adapter 想判 FAILED 也绝不落 outcome=0、根本不调模型——钉死 judge「宁缺勿错判」防线防未来放宽', async () => {
    const ledger = makeLedger([makeExp()]);
    const adapter = adapterReplying('FAILED'); // adapter 故意想判 FAILED
    const resolver = createExpectationResolver({ ledger, getAdapter: () => adapter, evidence: () => '' }); // 空证据
    const r = await resolver.tick();
    expect(ledger.resolved).toHaveLength(0); // 空证据绝不结算
    expect(ledger.resolved.every((c) => c.outcome !== 0)).toBe(true); // 绝不判 FAILED(刷假落空)
    expect(adapter.calls).toHaveLength(0); // no_evidence 提前 return，根本不调模型(无从误判)
    expect(r.judged?.[0]?.reason).toBe('no_evidence');
  });

  it('中文明确裁决词可落账，但含糊中文说明仍不落账', async () => {
    const ledger = makeLedger([makeExp()]);
    const resolver = createExpectationResolver({ ledger, getAdapter: () => adapterReplying('裁决：已应验'), evidence: POSITIVE_EVIDENCE });
    const applied = await resolver.tick(5000);
    expect(applied.resolved).toBe(1);
    expect(applied.judged[0]).toMatchObject({ outcome: 1, reason: 'llm_applied', verdictParser: 'zh_applied' });

    const ledger2 = makeLedger([makeExp()]);
    const resolver2 = createExpectationResolver({ ledger: ledger2, getAdapter: () => adapterReplying('不能判断是否应验'), evidence: POSITIVE_EVIDENCE });
    const unknown = await resolver2.tick(6000);
    expect(unknown.resolved).toBe(0);
    expect(ledger2.resolved).toHaveLength(0);
    expect(unknown.judged[0]).toMatchObject({ outcome: null, reason: 'llm_unparsed', verdictParser: 'unparsed' });
    expect(unknown.judged[0].replyStats).toEqual({ chars: '不能判断是否应验'.length, lines: 1 });
  });

  it('空证据直接留账，不调用模型', async () => {
    const ledger = makeLedger([makeExp()]);
    const adapter = adapterReplying('APPLIED');
    const resolver = createExpectationResolver({ ledger, getAdapter: () => adapter, evidence: () => '   ' });
    const r = await resolver.tick();
    expect(r.resolved).toBe(0);
    expect(r.judged[0]).toMatchObject({ id: 1, outcome: null, reason: 'no_evidence', evidenceStats: { chars: 0, lines: 0 } });
    expect(adapter.calls).toHaveLength(0);
  });

  it('模型抛错不落账不阻断', async () => {
    const ledger = makeLedger([makeExp()]);
    const adapter = { chat: async () => { throw new Error('LM Studio 没开'); } };
    const resolver = createExpectationResolver({ ledger, getAdapter: () => adapter, evidence: POSITIVE_EVIDENCE });
    const r = await resolver.tick();
    expect(r.resolved).toBe(0);
    expect(r.judged[0].reason).toBe('brain_error');
  });

  it('finish_reason=length 时不落账，报告 brain_incomplete', async () => {
    const ledger = makeLedger([makeExp()]);
    const adapter = { chat: async () => ({ reply: 'APPLIED', incomplete: true, finishReason: 'length' }) };
    const resolver = createExpectationResolver({ ledger, getAdapter: () => adapter, evidence: POSITIVE_EVIDENCE });
    const r = await resolver.tick();
    expect(r.resolved).toBe(0);
    expect(ledger.resolved).toHaveLength(0);
    expect(r.judged[0]).toMatchObject({ outcome: null, reason: 'brain_incomplete', finishReason: 'length' });
  });

  it('无 adapter（脑没接）整体留账', async () => {
    const ledger = makeLedger([makeExp()]);
    const resolver = createExpectationResolver({ ledger, getAdapter: () => null });
    const r = await resolver.tick();
    expect(r.resolved).toBe(0);
    expect(r.judged[0].reason).toBe('no_brain');
  });

  it('maxPerTick 限流：3 条到期只判 2 条', async () => {
    const ledger = makeLedger([makeExp({ id: 1 }), makeExp({ id: 2 }), makeExp({ id: 3 })]);
    const adapter = adapterReplying('APPLIED');
    const resolver = createExpectationResolver({ ledger, getAdapter: () => adapter, maxPerTick: 2, evidence: POSITIVE_EVIDENCE });
    const r = await resolver.tick();
    expect(r.checked).toBe(2);
    expect(adapter.calls).toHaveLength(2);
  });

  it('最早 due 持续 UNKNOWN 时会临时让路，避免后续 due 饥饿', async () => {
    const ledger = makeLedger([makeExp({ id: 1 }), makeExp({ id: 2 })]);
    const replies = ['UNKNOWN', 'APPLIED'];
    const adapter = {
      calls: [],
      chat: async (messages, opts) => {
        adapter.calls.push({ messages, opts });
        return { reply: replies.shift() || 'UNKNOWN' };
      },
    };
    const resolver = createExpectationResolver({ ledger, getAdapter: () => adapter, maxPerTick: 1, evidence: POSITIVE_EVIDENCE });

    const first = await resolver.tick(5_000);
    expect(first.judged[0]).toMatchObject({ id: 1, outcome: null, reason: 'llm_unknown', evidenceStats: { chars: POSITIVE_EVIDENCE().length, lines: 1 } });
    expect(ledger.resolved).toHaveLength(0);

    const second = await resolver.tick(6_000);
    expect(second.judged[0]).toMatchObject({ id: 2, outcome: 1, reason: 'llm_applied', evidenceStats: { chars: POSITIVE_EVIDENCE().length, lines: 1 } });
    expect(ledger.resolved).toEqual([{ id: 2, outcome: 1, t: 6_000 }]);
  });

  it('只有一条 due 时 UNKNOWN 冷却内跳过模型，冷却后再重试', async () => {
    const ledger = makeLedger([makeExp({ id: 1 })]);
    const adapter = adapterReplying('UNKNOWN');
    const resolver = createExpectationResolver({ ledger, getAdapter: () => adapter, maxPerTick: 1, unresolvedCooldownMs: 1000, evidence: POSITIVE_EVIDENCE });

    expect((await resolver.tick(5_000)).judged[0].id).toBe(1);
    expect(await resolver.tick(5_500)).toMatchObject({
      checked: 0,
      resolved: 0,
      judged: [],
      reason: 'cooldown',
      cooldownOnly: true,
      cooldownCount: 1,
      nextReadyAt: 6_000,
    });
    expect((await resolver.tick(6_001)).judged[0].id).toBe(1);
    expect(adapter.calls).toHaveLength(2);
  });

  it('不会用冷却中的 UNKNOWN 项补满剩余判证名额', async () => {
    const ledger = makeLedger([makeExp({ id: 1 }), makeExp({ id: 2 }), makeExp({ id: 3 })]);
    const replies = ['UNKNOWN', 'UNKNOWN', 'APPLIED'];
    const adapter = {
      calls: [],
      chat: async (messages, opts) => {
        adapter.calls.push({ messages, opts });
        return { reply: replies.shift() || 'UNKNOWN' };
      },
    };
    const resolver = createExpectationResolver({ ledger, getAdapter: () => adapter, maxPerTick: 2, unresolvedCooldownMs: 3600_000, evidence: POSITIVE_EVIDENCE });

    const first = await resolver.tick(5_000);
    expect(first.judged.map((item) => item.id)).toEqual([1, 2]);
    expect(first.resolved).toBe(0);

    const second = await resolver.tick(6_000);
    expect(second.judged.map((item) => item.id)).toEqual([3]);
    expect(second.cooldownSkipped).toBe(2);
    expect(second.resolved).toBe(1);
    expect(ledger.resolved).toEqual([{ id: 3, outcome: 1, t: 6_000 }]);
    expect(adapter.calls).toHaveLength(3);
  });

  it('证据函数结果注入 prompt；证据抛错留账不调用模型', async () => {
    const ledger = makeLedger([makeExp()]);
    const adapter = adapterReplying('APPLIED');
    const resolver = createExpectationResolver({
      ledger,
      getAdapter: () => adapter,
      evidence: () => '- [thought] 已列出 6 个原始念头',
    });
    await resolver.tick();
    expect(adapter.calls[0].messages[1].content).toContain('已列出 6 个原始念头');

    const ledger2 = makeLedger([makeExp()]);
    const adapter2 = adapterReplying('UNKNOWN');
    const resolver2 = createExpectationResolver({
      ledger2: null, ledger: ledger2, getAdapter: () => adapter2, evidence: () => { throw new Error('证据库崩'); },
    });
    const r2 = await resolver2.tick();
    expect(r2.checked).toBe(1);
    expect(r2.resolved).toBe(0);
    expect(r2.judged[0].reason).toBe('evidence_error');
    expect(adapter2.calls).toHaveLength(0);
  });

  it('结构化 evidenceSummary 会进入判证结果但不暴露证据原文', async () => {
    const events = [
      {
        ts: 1700000000000,
        kind: 'noe_act_executed',
        payload: {
          text: '今天列出了原始念头清单，共 6 个 Authorization: Bearer event-secret-value',
          status: 'completed',
          ok: true,
          result: 'done',
        },
      },
      {
        ts: 1700000005000,
        kind: 'noe_thought',
        payload: { text: '原始念头复盘完成', completed: true },
      },
    ];
    const ledger = makeLedger([makeExp()]);
    const resolver = createExpectationResolver({
      ledger,
      getAdapter: () => adapterReplying('UNKNOWN'),
      evidence: buildEventsEvidence(() => events),
    });
    const r = await resolver.tick();
    expect(r.resolved).toBe(0);
    expect(r.judged[0].evidenceSummary).toEqual({
      scanned: 2,
      matched: 2,
      kinds: [{ kind: 'noe_act_executed', count: 1 }, { kind: 'noe_thought', count: 1 }],
      signals: [
        { signal: 'completed=true', count: 1 },
        { signal: 'ok=true', count: 1 },
        { signal: 'result=done', count: 1 },
        { signal: 'status=completed', count: 1 },
      ],
      hasActionEvent: true,
      hasObservationEvent: true,
      hasResultSignal: true,
    });
    expect(JSON.stringify(r.judged[0].evidenceSummary)).not.toContain('原始念头');
    expect(JSON.stringify(r.judged[0].evidenceSummary)).not.toContain('event-secret-value');
  });

  it('decisive action success metadata 会注入安全判证提示但 UNKNOWN 仍不落账', async () => {
    const events = [
      {
        ts: 1700000000000,
        kind: 'activity',
        payload: {
          action: 'noe.goal_step.act',
          status: 'succeeded',
          ok: true,
          result: 'done',
          details: { stdoutSummary: '完成自我观察 Authorization: Bearer action-secret-value' },
        },
      },
    ];
    const ledger = makeLedger([makeExp({ claim: '完成自我观察' })]);
    const adapter = adapterReplying('UNKNOWN');
    const resolver = createExpectationResolver({
      ledger,
      getAdapter: () => adapter,
      evidence: buildEventsEvidence(() => events),
    });
    const r = await resolver.tick();
    expect(r.resolved).toBe(0);
    expect(ledger.resolved).toHaveLength(0);
    expect(r.judged[0].evidenceDecisionHint).toMatchObject({
      label: 'action_success_signal',
      confidence: 'high',
      suggestedVerdict: 'APPLIED',
      caution: 'direct_action_semantic_link_present_strict_conflict_check',
      profile: {
        matched: 1,
        actionKinds: 1,
        successSignals: 3,
        failureSignals: 0,
        claimGrams: 5,
        actionEvents: 1,
        resultActionEvents: 1,
        semanticLinkedActionEvents: 1,
        semanticActionMaxCoverage: 1,
      },
    });
    expect(r.judged[0].evidenceClaimAlignment).toMatchObject({
      method: 'claim_bigram_overlap_v2_semantic_fields',
      matchedEvents: 1,
      actionEvents: 1,
      resultActionEvents: 1,
      linkedActionEvents: 1,
      actionMaxCoverage: 1,
      semanticActionEvents: 1,
      semanticResultActionEvents: 1,
      semanticLinkedActionEvents: 1,
      semanticActionMaxCoverage: 1,
    });
    const prompt = adapter.calls[0].messages[1].content;
    expect(prompt).toContain('安全判证提示');
    expect(prompt).toContain('"label":"action_success_signal"');
    expect(prompt).toContain('"suggestedVerdict":"APPLIED"');
    expect(prompt).toContain('"semanticLinkedActionEvents":1');
    expect(prompt).toContain('直接行动对齐计数：actionEvents=1, resultActionEvents=1, semanticLinkedActionEvents=1');
    expect(prompt).toContain('不要仅因覆盖率偏低或观察噪声裁成 claim_mismatch');
    expect(JSON.stringify(r.judged[0].evidenceDecisionHint)).not.toContain('完成自我观察');
    expect(JSON.stringify(r.judged[0].evidenceDecisionHint)).not.toContain('action-secret-value');
    expect(JSON.stringify(r.judged[0].evidenceClaimAlignment)).not.toContain('完成自我观察');
    expect(JSON.stringify(r.judged[0].evidenceClaimAlignment)).not.toContain('action-secret-value');
  });

  it('decisive action success 第一轮 UNKNOWN 时会二次裁判，二次 APPLIED 才落账', async () => {
    const events = [
      {
        ts: 1700000000000,
        kind: 'activity',
        payload: {
          action: 'noe.goal_step.act',
          status: 'succeeded',
          ok: true,
          result: 'done',
          details: { stdoutSummary: '完成自我观察 Authorization: Bearer reask-secret-value' },
        },
      },
    ];
    const ledger = makeLedger([makeExp({ claim: '完成自我观察' })]);
    const adapter = adapterReplyingSequence([
      '{"verdict":"UNKNOWN","reasonCode":"insufficient_direct_evidence","hintAgreement":"override"}',
      '{"verdict":"APPLIED","reasonCode":"direct_success","hintAgreement":"agree"}',
    ]);
    const resolver = createExpectationResolver({
      ledger,
      getAdapter: () => adapter,
      evidence: buildEventsEvidence(() => events),
      decisiveReask: true,
    });
    const r = await resolver.tick(5000);
    expect(r.resolved).toBe(1);
    expect(ledger.resolved).toEqual([{ id: 1, outcome: 1, t: 5000 }]);
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1].opts.budgetContext.taskId).toBe('noe-expectation-decisive-reask');
    expect(adapter.calls[1].messages[1].content).toContain('第一轮裁判元数据');
    expect(adapter.calls[1].messages[1].content).toContain('"reasonCode":"insufficient_direct_evidence"');
    expect(adapter.calls[1].messages[1].content).toContain('"label":"action_success_signal"');
    expect(adapter.calls[1].messages[1].content).not.toContain('reask-secret-value');
    expect(r.judged[0]).toMatchObject({
      outcome: 1,
      reason: 'llm_applied',
      verdictParser: 'json_applied',
      decisiveReask: {
        attempted: true,
        firstParser: 'json_unknown',
        firstReasonCode: 'insufficient_direct_evidence',
        firstHintAgreement: 'override',
        secondParser: 'json_applied',
        secondReasonCode: 'direct_success',
        secondHintAgreement: 'agree',
        outcome: 1,
      },
    });
  });

  it('decisive action success 二次裁判仍 UNKNOWN 时保持不落账', async () => {
    const events = [
      {
        ts: 1700000000000,
        kind: 'activity',
        payload: {
          action: 'noe.goal_step.act',
          status: 'succeeded',
          ok: true,
          result: 'done',
          details: { stdoutSummary: '完成自我观察' },
        },
      },
    ];
    const ledger = makeLedger([makeExp({ claim: '完成自我观察' })]);
    const adapter = adapterReplyingSequence([
      '{"verdict":"UNKNOWN","reasonCode":"insufficient_direct_evidence","hintAgreement":"override"}',
      '{"verdict":"UNKNOWN","reasonCode":"claim_mismatch","hintAgreement":"override"}',
    ]);
    const resolver = createExpectationResolver({
      ledger,
      getAdapter: () => adapter,
      evidence: buildEventsEvidence(() => events),
      decisiveReask: true,
    });
    const r = await resolver.tick();
    expect(r.resolved).toBe(0);
    expect(ledger.resolved).toHaveLength(0);
    expect(adapter.calls).toHaveLength(2);
    expect(r.judged[0]).toMatchObject({
      outcome: null,
      reason: 'llm_unknown',
      verdictParser: 'json_unknown',
      verdictReasonCode: 'insufficient_direct_evidence',
      hintAgreement: 'override',
      decisiveReask: {
        attempted: true,
        secondParser: 'json_unknown',
        secondReasonCode: 'claim_mismatch',
        secondHintAgreement: 'override',
        outcome: null,
      },
    });
  });

  it('action/checkpoint semanticTrace rows 会优先进入安全 claim alignment 但不自动结算', async () => {
    const events = [
      {
        ts: 1700000000000,
        kind: 'noe_episode',
        payload: {
          text: 'owner expects confirmed delivery sample 只是旧观察，不是 action',
          meta: { streamType: 'self_talk' },
        },
      },
    ];
    const actionRows = [
      {
        ts: 1700000005000,
        kind: 'noe_act_semantic_trace',
        payload: {
          status: 'completed',
          completed: true,
          ok: true,
          result: 'done',
          action: 'noe.focus.review',
          title: 'semantic trace proof',
          actionEvidence: {
            semanticTrace: {
              summary: ['owner expects confirmed delivery sample Authorization: Bearer trace-secret-value'],
              action: ['noe.focus.review'],
              title: ['semantic trace proof'],
              fingerprint: 'abcdefabcdefabcdefabcdef',
            },
          },
        },
      },
    ];
    const ledger = makeLedger([makeExp({ claim: 'owner expects confirmed delivery sample' })]);
    const adapter = adapterReplying('UNKNOWN');
    const resolver = createExpectationResolver({
      ledger,
      getAdapter: () => adapter,
      evidence: buildEventsEvidence(() => events, {
        maxLines: 1,
        listActionEvidence: () => actionRows,
      }),
    });
    const r = await resolver.tick();
    expect(r.resolved).toBe(0);
    expect(ledger.resolved).toHaveLength(0);
    expect(r.judged[0].evidenceSummary).toMatchObject({
      matched: 1,
      hasActionEvent: true,
      hasResultSignal: true,
    });
    expect(r.judged[0].evidenceClaimAlignment).toMatchObject({
      method: 'claim_bigram_overlap_v2_semantic_fields',
      matchedEvents: 1,
      actionEvents: 1,
      resultActionEvents: 1,
      semanticTraceEvents: 1,
      semanticTraceActionEvents: 1,
      semanticTraceResultActionEvents: 1,
      semanticTraceLinkedActionEvents: 1,
      semanticTraceMaxCoverage: 1,
    });
    expect(JSON.stringify(r.judged[0].evidenceClaimAlignment)).not.toContain('confirmed delivery sample');
    expect(JSON.stringify(r.judged[0].evidenceClaimAlignment)).not.toContain('trace-secret-value');
    expect(adapter.calls[0].messages[1].content).toContain('semanticTraceActionEvents=1');
    expect(adapter.calls[0].messages[1].content).not.toContain('trace-secret-value');
  });

  it('中文交付 claim 可通过安全 semanticTrace terms 对齐且不泄露 claim 文本', async () => {
    const claim = '主人需要看到可见交付证据并收到任务回报';
    const needles = [...buildClaimLinkNeedles(claim)];
    expect(needles.some((needle) => String(needle).startsWith('safe:'))).toBe(true);

    const payload = {
      status: 'completed',
      completed: true,
      ok: true,
      result: 'done',
      actionEvidence: {
        semanticTrace: {
          summary: ['owner visible confirmedDelivery evidence task reportback'],
          title: ['delivery proof'],
          fingerprint: 'abcdefabcdefabcdefabcdef',
        },
      },
    };
    const link = scoreCandidateClaimLink(payload, needles, 2);
    expect(link.semanticTraceLabel).toBe('linked');
    expect(link.semanticTraceCoverage).toBe(1);
    expect(JSON.stringify(link)).not.toContain('主人需要看到');
    expect(JSON.stringify(link)).not.toContain('owner visible confirmedDelivery');

    const ledger = makeLedger([makeExp({ claim })]);
    const adapter = adapterReplying('UNKNOWN');
    const resolver = createExpectationResolver({
      ledger,
      getAdapter: () => adapter,
      evidence: buildEventsEvidence(() => [], {
        listActionEvidence: () => [{
          ts: 1700000005000,
          kind: 'noe_act_semantic_trace',
          payload,
        }],
      }),
    });
    const r = await resolver.tick();
    expect(r.resolved).toBe(0);
    expect(r.judged[0].evidenceSummary).toMatchObject({
      matched: 1,
      hasActionEvent: true,
      hasResultSignal: true,
    });
    expect(r.judged[0].evidenceClaimAlignment).toMatchObject({
      semanticTraceActionEvents: 1,
      semanticTraceResultActionEvents: 1,
      semanticTraceLinkedActionEvents: 1,
      semanticTraceMaxCoverage: 1,
    });
    expect(JSON.stringify(r.judged[0].evidenceClaimAlignment)).not.toContain('主人需要看到');
    expect(JSON.stringify(r.judged[0].evidenceClaimAlignment)).not.toContain('owner visible confirmedDelivery');
  });

  it('有 claim-linked trace route 时不会把无关 semanticTrace 混进直接证据', async () => {
    const actionRows = [
      {
        ts: 1700000005000,
        kind: 'noe_act_semantic_trace',
        payload: {
          status: 'completed',
          completed: true,
          ok: true,
          result: 'done',
          action: 'noe.focus.review',
          title: 'linked trace proof',
          actionEvidence: {
            semanticTrace: {
              summary: ['owner expects confirmed delivery sample'],
              title: ['linked trace proof'],
              fingerprint: 'abcdefabcdefabcdefabcdef',
            },
          },
        },
      },
      {
        ts: 1700000006000,
        kind: 'noe_act_semantic_trace',
        payload: {
          status: 'completed',
          completed: true,
          ok: true,
          result: 'done',
          action: 'noe.focus.review',
          title: 'zzz qqq',
          debugOnly: 'owner expects confirmed delivery sample',
          actionEvidence: {
            semanticTrace: {
              summary: ['zzz qqq'],
              title: ['zzz qqq'],
              fingerprint: '1234567890abcdef12345678',
            },
          },
        },
      },
    ];
    const ledger = makeLedger([makeExp({ claim: 'owner expects confirmed delivery sample' })]);
    const adapter = adapterReplying('UNKNOWN');
    const resolver = createExpectationResolver({
      ledger,
      getAdapter: () => adapter,
      evidence: buildEventsEvidence(() => [], {
        listActionEvidence: () => actionRows,
      }),
    });
    const r = await resolver.tick();
    expect(r.judged[0].evidenceSummary).toMatchObject({
      matched: 1,
      hasActionEvent: true,
      hasResultSignal: true,
    });
    expect(r.judged[0].evidenceClaimAlignment).toMatchObject({
      semanticTraceActionEvents: 1,
      semanticTraceLinkedActionEvents: 1,
      semanticTraceUnlinkedActionEvents: 0,
      semanticTraceMaxCoverage: 1,
    });
    const prompt = adapter.calls[0].messages[1].content;
    expect(prompt).toContain('linked trace proof');
    expect(prompt).not.toContain('zzz qqq');
    expect(prompt).not.toContain('debugOnly');
  });

  it('weak trace 不会挤掉更强的 legacy summary linked action evidence', async () => {
    const actionRows = [
      {
        ts: 1700000005000,
        kind: 'noe_act_semantic_trace',
        payload: {
          status: 'completed',
          completed: true,
          ok: true,
          result: 'done',
          action: 'noe.focus.review',
          title: 'weak trace proof',
          debugOnly: 'owner expects',
          actionEvidence: {
            semanticTrace: {
              summary: ['ow'],
              title: ['weak trace proof'],
            },
          },
        },
      },
      {
        ts: 1700000006000,
        kind: 'noe_act_evidence_summary',
        payload: {
          status: 'completed',
          completed: true,
          ok: true,
          result: 'done',
          action: 'noe.focus.review',
          title: 'legacy summary linked proof',
          goal: 'owner expects confirmed delivery sample',
          actionEvidence: {
            action: 'noe.focus.review',
            title: 'legacy summary linked proof',
            goal: 'owner expects confirmed delivery sample',
          },
        },
      },
    ];
    const ledger = makeLedger([makeExp({ claim: 'owner expects confirmed delivery sample' })]);
    const adapter = adapterReplying('UNKNOWN');
    const resolver = createExpectationResolver({
      ledger,
      getAdapter: () => adapter,
      evidence: buildEventsEvidence(() => [], {
        maxLines: 1,
        listActionEvidence: () => actionRows,
      }),
    });
    const r = await resolver.tick();
    expect(r.judged[0].evidenceSummary).toMatchObject({
      matched: 1,
      hasActionEvent: true,
      hasResultSignal: true,
      kinds: [{ kind: 'noe_act_evidence_summary', count: 1 }],
    });
    expect(r.judged[0].evidenceClaimAlignment).toMatchObject({
      semanticActionEvents: 1,
      semanticLinkedActionEvents: 1,
      semanticTraceActionEvents: 0,
    });
    const prompt = adapter.calls[0].messages[1].content;
    expect(prompt).toContain('legacy summary linked proof');
    expect(prompt).not.toContain('weak trace proof');
  });

  it('高命中 observation 不会把唯一 linked action result 挤出证据窗口', async () => {
    const events = Array.from({ length: 4 }, (_, i) => ({
      ts: 1700000000000 + i,
      kind: 'noe_episode',
      payload: {
        text: `owner expects confirmed delivery sample observation repeat ${i}`,
        meta: { streamType: 'self_talk' },
      },
    }));
    const actionRows = [
      {
        ts: 1700000009000,
        kind: 'noe_act_evidence_summary',
        payload: {
          status: 'completed',
          completed: true,
          ok: true,
          result: 'done',
          action: 'noe.focus.review',
          title: 'retained action result',
          goal: 'owner expects confirmed delivery sample',
        },
      },
    ];
    const ledger = makeLedger([makeExp({ claim: 'owner expects confirmed delivery sample' })]);
    const adapter = adapterReplying('UNKNOWN');
    const resolver = createExpectationResolver({
      ledger,
      getAdapter: () => adapter,
      evidence: buildEventsEvidence(() => events, {
        maxLines: 2,
        listActionEvidence: () => actionRows,
      }),
    });
    const r = await resolver.tick();
    expect(r.judged[0].evidenceSummary).toMatchObject({
      matched: 2,
      hasActionEvent: true,
      hasObservationEvent: true,
      hasResultSignal: true,
    });
    expect(r.judged[0].evidenceClaimAlignment).toMatchObject({
      actionEvents: 1,
      resultActionEvents: 1,
      semanticLinkedActionEvents: 1,
    });
    const prompt = adapter.calls[0].messages[1].content;
    expect(prompt).toContain('noe_act_evidence_summary');
    expect(prompt).toContain('"label":"action_success_signal"');
  });

  it('JSON UNKNOWN reason code 会持久化为安全元数据但不落账', async () => {
    const events = [
      {
        ts: 1700000000000,
        kind: 'activity',
        payload: {
          action: 'noe.goal_step.act',
          status: 'succeeded',
          ok: true,
          result: 'done',
          details: { stdoutSummary: '完成自我观察' },
        },
      },
    ];
    const ledger = makeLedger([makeExp({ claim: '完成自我观察' })]);
    const resolver = createExpectationResolver({
      ledger,
      getAdapter: () => adapterReplying('{"verdict":"UNKNOWN","reasonCode":"claim_mismatch","hintAgreement":"override"}'),
      evidence: buildEventsEvidence(() => events),
    });
    const r = await resolver.tick();
    expect(r.resolved).toBe(0);
    expect(ledger.resolved).toHaveLength(0);
    expect(r.judged[0]).toMatchObject({
      outcome: null,
      reason: 'llm_unknown',
      verdictParser: 'json_unknown',
      verdictReasonCode: 'claim_mismatch',
      hintAgreement: 'override',
    });
  });

  it('noe_episode 事件会提供观察类 action/result 信号但不伪装成 act', async () => {
    const events = [
      {
        ts: 1700000000000,
        kind: 'noe_episode',
        payload: {
          summary: '自我观察完成 Authorization: Bearer episode-secret-value',
          detail: '完成自我观察',
          episodeType: 'inner_monologue',
          meta: {
            streamType: 'self_talk',
            guard: { action: 'allow', state: 'normal' },
            grounding: { score: 0.82 },
          },
        },
      },
    ];
    const ledger = makeLedger([makeExp({ claim: '完成自我观察' })]);
    const resolver = createExpectationResolver({
      ledger,
      getAdapter: () => adapterReplying('UNKNOWN'),
      evidence: buildEventsEvidence(() => events),
    });
    const r = await resolver.tick();
    expect(r.resolved).toBe(0);
    expect(r.judged[0].evidenceSummary).toEqual({
      scanned: 1,
      matched: 1,
      kinds: [{ kind: 'noe_episode', count: 1 }],
      signals: [
        { signal: 'episodeType=inner_monologue', count: 1 },
        { signal: 'grounding.score_bucket=high', count: 1 },
        { signal: 'guard.action=allow', count: 1 },
        { signal: 'guard.state=normal', count: 1 },
        { signal: 'streamType=self_talk', count: 1 },
      ],
      hasActionEvent: false,
      hasObservationEvent: true,
      hasResultSignal: true,
    });
    expect(JSON.stringify(r.judged[0].evidenceSummary)).not.toContain('自我观察完成');
    expect(JSON.stringify(r.judged[0].evidenceSummary)).not.toContain('episode-secret-value');
  });

  it('observation-only 证据会附带邻近结果候选但不伪装成直接 action evidence', async () => {
    const events = [
      {
        ts: 1700000000000,
        kind: 'noe_episode',
        payload: {
          summary: '自我观察完成',
          detail: '完成自我观察',
          episodeType: 'inner_monologue',
          meta: {
            streamType: 'self_talk',
            guard: { action: 'allow', state: 'normal' },
            grounding: { score: 0.82 },
          },
        },
      },
      {
        ts: 1700000001000,
        kind: 'activity',
        payload: {
          action: 'noe.goal_step.act',
          status: 'succeeded',
          details: { stdoutSummary: 'nearby action text should not be exposed here' },
        },
      },
    ];
    const ledger = makeLedger([makeExp({ claim: '完成自我观察' })]);
    const resolver = createExpectationResolver({
      ledger,
      getAdapter: () => adapterReplying('UNKNOWN'),
      evidence: buildEventsEvidence(() => events),
    });
    const r = await resolver.tick();
    expect(r.resolved).toBe(0);
    expect(r.judged[0].evidenceSummary).toMatchObject({
      matched: 1,
      kinds: [{ kind: 'noe_episode', count: 1 }],
      hasActionEvent: false,
      hasObservationEvent: true,
      hasResultSignal: true,
    });
    expect(r.judged[0].evidenceCandidateSummary).toEqual({
      scanned: 2,
      candidates: 1,
      windowMs: 900000,
      kinds: [{ kind: 'activity', count: 1 }],
      signals: [{ signal: 'status=succeeded', count: 1 }],
      linkStats: {
        method: 'claim_bigram_overlap_v2_semantic_fields',
        claimGrams: 5,
        scoredCandidates: 1,
        linkedCandidates: 0,
        weakCandidates: 0,
        unlinkedCandidates: 1,
        maxHits: 0,
        maxCoverage: 0,
        semanticLinkedCandidates: 0,
        semanticWeakCandidates: 0,
        semanticUnlinkedCandidates: 1,
        semanticMaxHits: 0,
        semanticMaxCoverage: 0,
        semanticTraceLinkedCandidates: 0,
        semanticTraceWeakCandidates: 0,
        semanticTraceUnlinkedCandidates: 1,
        semanticTraceMaxHits: 0,
        semanticTraceMaxCoverage: 0,
      },
      nearestDeltaMs: { min: 1000, max: 1000, avg: 1000 },
    });
    expect(JSON.stringify(r.judged[0].evidenceSummary)).not.toContain('nearby action text');
    expect(JSON.stringify(r.judged[0].evidenceCandidateSummary)).not.toContain('nearby action text');
  });

  it('邻近结果候选会记录安全语义链接强度但不输出候选文本', async () => {
    const events = [
      {
        ts: 1700000000000,
        kind: 'noe_episode',
        payload: {
          summary: '自我观察完成',
          detail: '完成自我观察',
          episodeType: 'inner_monologue',
          meta: {
            streamType: 'self_talk',
            guard: { action: 'allow', state: 'normal' },
            grounding: { score: 0.82 },
          },
        },
      },
      {
        ts: 1700000001000,
        kind: 'activity',
        payload: {
          action: 'noe.goal_step.act',
          status: 'succeeded',
          details: { stdoutSummary: '完成自我观察 linked candidate text should not be exposed' },
        },
      },
    ];
    const ledger = makeLedger([makeExp({ claim: '完成自我观察' })]);
    const resolver = createExpectationResolver({
      ledger,
      getAdapter: () => adapterReplying('UNKNOWN'),
      evidence: buildEventsEvidence(() => events, { maxLines: 1 }),
    });
    const r = await resolver.tick();
    expect(r.resolved).toBe(0);
    expect(r.judged[0].evidenceSummary).toMatchObject({
      matched: 1,
      hasActionEvent: false,
      hasObservationEvent: true,
    });
    expect(r.judged[0].evidenceCandidateSummary).toMatchObject({
      candidates: 1,
      kinds: [{ kind: 'activity', count: 1 }],
      signals: [{ signal: 'status=succeeded', count: 1 }],
      linkStats: {
        method: 'claim_bigram_overlap_v2_semantic_fields',
        claimGrams: 5,
        scoredCandidates: 1,
        linkedCandidates: 1,
        weakCandidates: 0,
        unlinkedCandidates: 0,
        maxHits: 5,
        maxCoverage: 1,
        semanticLinkedCandidates: 1,
        semanticWeakCandidates: 0,
        semanticUnlinkedCandidates: 0,
        semanticMaxHits: 5,
        semanticMaxCoverage: 1,
        semanticTraceLinkedCandidates: 0,
        semanticTraceWeakCandidates: 0,
        semanticTraceUnlinkedCandidates: 1,
        semanticTraceMaxHits: 0,
        semanticTraceMaxCoverage: 0,
      },
    });
    expect(r.judged[0].evidenceDecisionHint).toMatchObject({
      label: 'candidate_result_linked_hint',
      suggestedVerdict: 'UNKNOWN',
      caution: 'candidate_requires_promotion_audit',
      profile: {
        matched: 1,
        linkedCandidates: 1,
      },
    });
    expect(JSON.stringify(r.judged[0].evidenceCandidateSummary)).not.toContain('linked candidate text');
    expect(JSON.stringify(r.judged[0].evidenceCandidateSummary)).not.toContain('完成自我观察');
  });

  it('判证 prompt 会清洗 claim 与 evidence 中的 secret-shaped 文本', async () => {
    const ledger = makeLedger([makeExp({
      claim: '三天内能列出至少 5 个原始念头 OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz',
    })]);
    const adapter = adapterReplying('APPLIED');
    const resolver = createExpectationResolver({
      ledger,
      getAdapter: () => adapter,
      evidence: () => '- [thought] 已列出原始念头，Authorization: Bearer bearer-secret-value',
    });
    await resolver.tick();
    const prompt = adapter.calls[0].messages[1].content;
    expect(prompt).toContain('OPENAI_API_KEY=[redacted]');
    expect(prompt).toContain('Authorization: Bearer [redacted]');
    expect(prompt).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(prompt).not.toContain('bearer-secret-value');
  });

  it('缺 ledger 时空转不崩', async () => {
    const resolver = createExpectationResolver({ getAdapter: () => adapterReplying('APPLIED') });
    expect(await resolver.tick()).toEqual({ checked: 0, resolved: 0 });
  });

  it('tickDetached 快速返回，后台完成后再落账', async () => {
    const ledger = makeLedger([makeExp()]);
    const adapter = adapterReplying('APPLIED');
    const resolver = createExpectationResolver({ ledger, getAdapter: () => adapter, evidence: POSITIVE_EVIDENCE });
    const r = resolver.tickDetached(5000);
    expect(r).toMatchObject({ checked: 0, resolved: 0, detached: true, reason: 'started_background' });
    expect(ledger.resolved).toHaveLength(0);

    const idle = await resolver.waitForIdle();
    expect(idle.inFlight).toBe(false);
    expect(idle.lastDetachedResult.result.resolved).toBe(1);
    expect(ledger.resolved).toEqual([{ id: 1, outcome: 1, t: 5000 }]);
  });

  it('tickDetached 下次返回会带上上一轮后台判证摘要', async () => {
    const ledger = makeLedger([makeExp()]);
    const adapter = adapterReplying('UNKNOWN');
    const resolver = createExpectationResolver({ ledger, getAdapter: () => adapter, evidence: POSITIVE_EVIDENCE });
    expect(resolver.tickDetached(5000).reason).toBe('started_background');
    await resolver.waitForIdle();

    const r2 = resolver.tickDetached(6000);
    expect(r2).toMatchObject({
      checked: 0,
      resolved: 0,
      detached: true,
      reason: 'started_background',
      previousResult: {
        ok: true,
        checked: 1,
        resolved: 0,
        judged: [{ id: 1, outcome: null, reason: 'llm_unknown', evidenceStats: { chars: POSITIVE_EVIDENCE().length, lines: 1 } }],
      },
    });
    await resolver.waitForIdle();
  });

  it('tickDetached 后台完成回调返回 compact trace alignment 摘要', async () => {
    const ledger = makeLedger([makeExp({ claim: '完成自我观察语义追踪' })]);
    const adapter = adapterReplying('UNKNOWN');
    const callbacks = [];
    const resolver = createExpectationResolver({
      ledger,
      getAdapter: () => adapter,
      evidence: buildEventsEvidence(
        () => [],
        {
          listActionEvidence: () => [
            {
              ts: 1700000000000,
              kind: 'noe_act_semantic_trace',
              payload: {
                status: 'completed',
                ok: true,
                result: 'done',
                action: 'shell.exec',
                actionEvidence: {
                  semanticTrace: {
                    summary: '完成自我观察语义追踪 trace-secret-value',
                    action: '完成自我观察语义追踪',
                    fingerprint: 'trace-fingerprint',
                  },
                },
              },
            },
          ],
        },
      ),
    });

    const r = resolver.tickDetached(5000, { onResult: (previousResult) => callbacks.push(previousResult) });
    expect(r.reason).toBe('started_background');
    await resolver.waitForIdle();

    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]).toMatchObject({ ok: true, checked: 1, resolved: 0 });
    expect(callbacks[0].judged[0].evidenceClaimAlignment).toMatchObject({
      semanticTraceActionEvents: 1,
      semanticTraceResultActionEvents: 1,
      semanticTraceLinkedActionEvents: 1,
    });
    expect(callbacks[0].judged[0].evidenceSummary).toMatchObject({
      matched: 1,
      hasActionEvent: true,
      hasResultSignal: true,
    });
    expect(callbacks[0].judged[0].evidenceDecisionHint).toMatchObject({
      label: 'action_success_signal',
      suggestedVerdict: 'APPLIED',
    });
    expect(callbacks[0].judged[0].evidenceCandidateSummary).toBeUndefined();
    expect(JSON.stringify(callbacks[0])).not.toContain('trace-secret-value');
  });

  it('tickDetached compact 回调在多条 judgement 下保持 heartbeat outcome 可解析尺寸', async () => {
    const ledger = makeLedger([
      makeExp({ id: 145, claim: '完成自我观察语义追踪' }),
      makeExp({ id: 148, claim: '把后台判证结果写入心跳台账' }),
      makeExp({ id: 149, claim: '让行动证据带有语义摘要' }),
    ]);
    const adapter = adapterReplying('{"verdict":"UNKNOWN","reasonCode":"insufficient_direct_evidence","hintAgreement":"override"}');
    const callbacks = [];
    const traces = [
      '完成自我观察语义追踪 trace-secret-value',
      '把后台判证结果写入心跳台账 trace-secret-value',
      '让行动证据带有语义摘要 trace-secret-value',
      '完成后台判证并产生结果',
      '心跳台账 background completed',
      '行动证据 semantic summary done',
    ];
    const resolver = createExpectationResolver({
      ledger,
      getAdapter: () => adapter,
      evidence: buildEventsEvidence(
        () => [],
        {
          listActionEvidence: () => traces.map((summary, idx) => ({
            ts: 1700000000000 + idx,
            kind: idx % 2 ? 'noe_goal_checkpoint_semantic_trace' : 'noe_act_semantic_trace',
            payload: {
              status: 'completed',
              ok: true,
              result: 'done',
              action: 'shell.exec',
              actionEvidence: {
                semanticTrace: {
                  summary,
                  action: summary,
                  title: `trace ${idx}`,
                  fingerprint: `trace-fingerprint-${idx}`,
                },
              },
            },
          })),
        },
      ),
    });

    expect(resolver.tickDetached(5000, { onResult: (previousResult) => callbacks.push(previousResult) }).reason).toBe('started_background');
    await resolver.waitForIdle();

    const wrappedOutcome = {
      checked: 0,
      resolved: 0,
      judged: [],
      detached: true,
      reason: 'background_completed',
      previousResult: callbacks[0],
    };
    const packed = JSON.stringify(wrappedOutcome);
    expect(callbacks[0].judged).toHaveLength(3);
    expect(callbacks[0].judged.every((j) => j.evidenceSummary?.matched > 0)).toBe(true);
    expect(callbacks[0].judged.reduce((sum, j) => sum + Number(j.evidenceClaimAlignment?.semanticTraceActionEvents || 0), 0)).toBeGreaterThan(0);
    expect(packed.length).toBeLessThan(3600);
    expect(JSON.parse(packed).previousResult.judged).toHaveLength(3);
    expect(packed).not.toContain('trace-secret-value');
    expect(callbacks[0].judged[0].evidenceCandidateSummary).toBeUndefined();
  });

  it('tickDetached 运行中不叠加第二个模型调用', async () => {
    const ledger = makeLedger([makeExp()]);
    let release;
    const adapter = {
      calls: [],
      chat: async (messages, opts) => {
        adapter.calls.push({ messages, opts });
        return new Promise((resolve) => { release = () => resolve({ reply: 'UNKNOWN' }); });
      },
    };
    const resolver = createExpectationResolver({ ledger, getAdapter: () => adapter, evidence: POSITIVE_EVIDENCE });
    expect(resolver.tickDetached(5000).reason).toBe('started_background');
    for (let i = 0; i < 10 && adapter.calls.length === 0; i += 1) await Promise.resolve();
    expect(adapter.calls).toHaveLength(1);
    const r2 = resolver.tickDetached(5001);
    expect(r2.reason).toBe('in_flight');
    expect(adapter.calls).toHaveLength(1);
    release();
    await resolver.waitForIdle();
    expect(ledger.resolved).toHaveLength(0);
  });

  it('buildEventsEvidence：关键词命中过滤、限行数、异常返回空串', () => {
    const events = [
      {
        ts: 1700000000000,
        kind: 'noe_act_executed',
        payload: {
          text: '今天列出了原始念头清单，共 6 个 Authorization: Bearer event-secret-value',
          status: 'completed',
          ok: true,
          result: 'done',
        },
      },
      {
        ts: 1700000005000,
        kind: 'noe_thought',
        payload: {
          text: '原始念头复盘完成',
          completed: true,
          reason: 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz',
        },
      },
      { ts: 1700000010000, kind: 'other', payload: { text: '完全无关的事件' } },
    ];
    const ev = buildEventsEvidence(() => events)({ claim: '三天内能列出至少 5 个原始念头', created_at: 1000 });
    expect(ev).toContain('证据摘要');
    expect(ev).toContain('证据元数据');
    expect(ev).toContain('scanned=3');
    expect(ev).toContain('matched=2');
    expect(ev).toContain('kinds=noe_act_executed:1, noe_thought:1');
    expect(ev).toContain('signals=');
    expect(ev).toContain('status=completed:1');
    expect(ev).toContain('ok=true:1');
    expect(ev).toContain('result=done:1');
    expect(ev).toContain('completed=true:1');
    expect(ev).toContain('OPENAI_API_KEY=[redacted]');
    expect(ev).toContain('相关时间线');
    expect(ev).toContain('2023-11-14T22:13:20.000Z [noe_act_executed] hits=');
    expect(ev).toContain('2023-11-14T22:13:25.000Z [noe_thought] hits=');
    expect(ev).toContain('原始念头');
    expect(ev).toContain('Authorization: Bearer [redacted]');
    expect(ev).not.toContain('event-secret-value');
    expect(ev).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(ev).not.toContain('完全无关');

    expect(buildEventsEvidence(() => events)({ claim: '。，！', created_at: 0 })).toBe('');
    expect(buildEventsEvidence(() => { throw new Error('库崩'); })({ claim: '三天内列出原始念头', created_at: 0 })).toBe('');
  });

  it('模型调用带本地预算上下文且指定 model 时透传', async () => {
    const ledger = makeLedger([makeExp()]);
    const adapter = adapterReplying('APPLIED');
    const resolver = createExpectationResolver({ ledger, getAdapter: () => adapter, model: 'manual-explicit-model', evidence: POSITIVE_EVIDENCE });
    await resolver.tick();
    expect(adapter.calls[0].opts.budgetContext.taskId).toBe('noe-expectation-resolve');
    expect(adapter.calls[0].opts).toMatchObject({ temperature: 0, top_p: 1, maxTokens: 4096 });
    expect(adapter.calls[0].opts.model).toBe('manual-explicit-model');
  });

  it('显式模型会按当前自动模型策略归一化', async () => {
    const ledger = makeLedger([makeExp()]);
    const adapter = adapterReplying('APPLIED');
    const requestedModel = 'qwen/qwen3.6-35b-a3b';
    const resolver = createExpectationResolver({ ledger, getAdapter: () => adapter, model: requestedModel, evidence: POSITIVE_EVIDENCE });
    await resolver.tick();
    expect(adapter.calls[0].opts.model).toBe(normalizeNoeAutoModel(requestedModel, { allowEmpty: true }));
  });
});
