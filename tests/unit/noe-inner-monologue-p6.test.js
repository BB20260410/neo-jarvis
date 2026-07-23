import { describe, expect, it } from 'vitest';
import { createInnerMonologue } from '../../src/loop/InnerMonologue.js';

const T0 = 1_781_252_600_000;

function makeTimeline(episodes = [{ id: 1, ts: 1, type: 'interaction', summary: '主人给了一个真实任务' }]) {
  const recorded = [];
  return {
    recorded,
    recent: () => episodes,
    record: (event) => { recorded.push(event); return recorded.length; },
  };
}

function adapterWith(reply, marks = []) {
  return {
    calls: [],
    chat: async (messages) => {
      marks.push('chat');
      adapter.calls.push(messages);
      return { reply };
    },
  };
}

let adapter;

describe('InnerMonologue P6 outcome wiring', () => {
  it('generates proposalId before model generation and commits outcome after timeline write', async () => {
    const marks = [];
    const timeline = makeTimeline();
    adapter = adapterWith('我想把这个任务落成一个小目标', marks);
    const outcomes = [];
    const reflect = createInnerMonologue({
      timeline,
      getAdapter: () => adapter,
      proposalIdFactory: () => { marks.push('proposal'); return 'p6-inner-001'; },
      outcomeSink: (outcome) => outcomes.push(outcome),
      now: () => T0,
    });

    const result = await reflect();
    expect(marks).toEqual(['proposal', 'chat']);
    expect(result.reflected).toBe(true);
    expect(timeline.recorded).toHaveLength(1);
    expect(timeline.recorded[0].meta.streamType).toBe('self_talk');
    expect(outcomes[0].proposal.proposalId).toBe('p6-inner-001');
    expect(outcomes[0].commit).toMatchObject({
      proposalId: 'p6-inner-001',
      committed: true,
      eventId: 1,
    });
  });

  it('blocks self-talk immediately in off mode without calling the model', async () => {
    const timeline = makeTimeline();
    adapter = adapterWith('不应该被调用');
    const audits = [];
    const reflect = createInnerMonologue({
      timeline,
      getAdapter: () => adapter,
      innerMode: 'off',
      proposalIdFactory: () => 'p6-inner-off',
      auditSink: (entry) => audits.push(entry),
      now: () => T0,
    });

    const result = await reflect();
    expect(result.reason).toBe('inner_mode_off');
    expect(adapter.calls).toHaveLength(0);
    expect(timeline.recorded).toHaveLength(0);
    expect(result.outcome.commit.committed).toBe(false);
    expect(result.outcome.commit.blockedReason).toBe('inner_mode_off');
    expect(audits.some((entry) => entry.channel === 'rumination_guard')).toBe(true);
  });

  it('audit mode records redacted outcome and shadow guard diagnostics while allowing commit', async () => {
    const timeline = makeTimeline([
      { id: 2, ts: 2, type: 'inner_monologue', summary: '主人最近好像卡住了', meta: { streamType: 'self_talk' } },
      { id: 1, ts: 1, type: 'interaction', summary: '主人刚说项目卡住了' },
    ]);
    adapter = adapterWith('主人刚说项目卡住了，我想把它拆成一步');
    const audits = [];
    const reflect = createInnerMonologue({
      timeline,
      getAdapter: () => adapter,
      innerMode: 'audit',
      proposalIdFactory: () => 'p6-inner-audit',
      auditSink: (entry) => audits.push(entry),
      textSimilarity: () => 0.8,
      now: () => T0,
    });

    const result = await reflect();
    expect(result.reflected).toBe(true);
    expect(result.guardDecision.state).toBe('anchor');
    expect(result.guardDecision.wouldBlock).toBe(false);
    expect(audits[0].thought).toBe(null);
    expect(audits[0].redactionPolicy).toBe('strict');
    expect(audits.some((entry) => entry.channel === 'rumination_guard' && entry.rawMetrics.semanticSim === 0.8)).toBe(true);
  });

  it('defaults P6 wiring to audit mode so guard trips shadow without blocking', async () => {
    const timeline = makeTimeline([
      { id: 4, ts: 4, type: 'inner_monologue', summary: '今天还在想 A', meta: { streamType: 'self_talk' } },
      { id: 3, ts: 3, type: 'inner_monologue', summary: '今天还在想 B', meta: { streamType: 'self_talk' } },
      { id: 2, ts: 2, type: 'inner_monologue', summary: '今天还在想 C', meta: { streamType: 'self_talk' } },
      { id: 1, ts: 1, type: 'interaction', summary: '主人发来一个真实需求' },
    ]);
    adapter = adapterWith('我改想另一个具体执行步骤');
    const outcomes = [];
    const reflect = createInnerMonologue({
      timeline,
      getAdapter: () => adapter,
      proposalIdFactory: () => 'p6-inner-default-audit',
      landingStreakProvider: () => 6,
      outcomeSink: (outcome) => outcomes.push(outcome),
      now: () => T0,
    });

    const result = await reflect();
    expect(result.reflected).toBe(true);
    expect(result.guardDecision).toMatchObject({
      mode: 'audit',
      state: 'cooldown',
      action: 'allow',
      wouldBlock: false,
      shadowWouldBlock: true,
    });
    expect(timeline.recorded).toHaveLength(1);
    expect(outcomes[0].commit.committed).toBe(true);
  });

  it('normal mode cooldown blocks commit after generation when thoughts have not landed', async () => {
    const timeline = makeTimeline([
      { id: 4, ts: 4, type: 'inner_monologue', summary: '今天还在想 A', meta: { streamType: 'self_talk' } },
      { id: 3, ts: 3, type: 'inner_monologue', summary: '今天还在想 B', meta: { streamType: 'self_talk' } },
      { id: 2, ts: 2, type: 'inner_monologue', summary: '今天还在想 C', meta: { streamType: 'self_talk' } },
      { id: 1, ts: 1, type: 'interaction', summary: '主人发来一个真实需求' },
    ]);
    adapter = adapterWith('我改想另一个具体执行步骤');
    const outcomes = [];
    const reflect = createInnerMonologue({
      timeline,
      getAdapter: () => adapter,
      innerMode: 'normal',
      proposalIdFactory: () => 'p6-inner-block',
      landingStreakProvider: () => 6,
      outcomeSink: (outcome) => outcomes.push(outcome),
      now: () => T0,
    });

    const result = await reflect();
    expect(result.reason).toBe('rumination_guard_blocked');
    expect(result.guardDecision.state).toBe('cooldown');
    expect(timeline.recorded).toHaveLength(0);
    expect(outcomes[0].commit.committed).toBe(false);
    expect(outcomes[0].commit.blockedReason).toBe('rumination_guard:cooldown');
    expect(outcomes[0].landing).toMatchObject({
      proposalId: 'p6-inner-block',
      type: 'silent',
      delivery: { status: 'not_attempted' },
    });
  });

  it('records early semantic repetition blocks as rumination guard audit records', async () => {
    const timeline = makeTimeline([
      { id: 2, ts: 2, type: 'inner_monologue', summary: '我还在想同一个项目卡点', meta: { streamType: 'self_talk' } },
      { id: 1, ts: 1, type: 'interaction', summary: '主人发来一个真实需求' },
    ]);
    adapter = adapterWith('我还是在想同一个项目卡点');
    const audits = [];
    const reflect = createInnerMonologue({
      timeline,
      getAdapter: () => adapter,
      proposalIdFactory: () => 'p6-inner-semantic-block',
      auditSink: (entry) => audits.push(entry),
      mindVitals: {
        similarity: async () => 0.91,
      },
      now: () => T0,
    });

    const result = await reflect();
    expect(result.reason).toBe('semantic_repetitive');
    expect(result.outcome.landing).toMatchObject({
      proposalId: 'p6-inner-semantic-block',
      type: 'silent',
      delivery: { status: 'not_attempted' },
    });
    expect(result.guardDecision).toMatchObject({ state: 'anchor', action: 'block', wouldBlock: true });
    expect(audits.some((entry) => entry.channel === 'rumination_guard' && entry.state === 'anchor')).toBe(true);
  });
});
