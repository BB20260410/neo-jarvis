import { describe, expect, it } from 'vitest';
import {
  RUMINATION_SIGNAL_CONTRACT,
  computeRuminationMetrics,
  createRuminationAuditRecord,
  decideRuminationGuard,
} from '../../src/cognition/RuminationGuard.js';

describe('RuminationGuard P6-C pure contract', () => {
  it('derives self-talk ratio from raw timeline and ignores deliberation entries', () => {
    const metrics = computeRuminationMetrics({
      recentEpisodes: [
        { type: 'inner_monologue', summary: '自说自话 1', meta: { streamType: 'self_talk' } },
        { type: 'inner_monologue', summary: '审议不该计入 self-talk', meta: { streamType: 'deliberation' } },
        { type: 'interaction', summary: '主人给了一个真实任务' },
        { type: 'observation', summary: '看见终端测试通过' },
      ],
      candidate: '我想把这个真实任务拆成下一步',
      groundingScore: 0.8,
      landingStreak: 1,
    });

    expect(metrics.recentSelfTalkRatio).toBe(0.5);
    expect(metrics.rawCounts).toEqual({ selfTalk: 1, realExperiences: 2 });
  });

  it('uses stricter anchored similarity threshold than normal mode', () => {
    const metrics = {
      semanticSim: 0.45,
      groundingScore: 0.8,
      abstractDensity: 0.1,
      recentSelfTalkRatio: 0.2,
      landingStreak: 0,
    };

    expect(decideRuminationGuard({ mode: 'normal', metrics }).state).toBe('normal');
    expect(decideRuminationGuard({ mode: 'anchored', metrics }).state).toBe('rotate');
  });

  it('keeps audit mode shadow-only even when production would block', () => {
    const metrics = {
      semanticSim: 0.2,
      groundingScore: 0.7,
      abstractDensity: 0.2,
      recentSelfTalkRatio: 2.5,
      landingStreak: 6,
    };

    const audit = decideRuminationGuard({ mode: 'audit', metrics });
    expect(audit.state).toBe('cooldown');
    expect(audit.action).toBe('allow');
    expect(audit.wouldBlock).toBe(false);
    expect(audit.shadowWouldBlock).toBe(true);

    const normal = decideRuminationGuard({ mode: 'normal', metrics });
    expect(normal.action).toBe('block');
    expect(normal.wouldBlock).toBe(true);
  });

  it('maps off mode to silent self-talk blocking without touching deliberation schema', () => {
    const decision = decideRuminationGuard({ mode: 'off', metrics: {} });
    expect(decision.state).toBe('silent');
    expect(decision.action).toBe('block');
    expect(decision.reasons).toEqual(['inner_mode_off']);
  });

  it('creates audit records with numeric metrics and no text fields', () => {
    const metrics = computeRuminationMetrics({
      recentEpisodes: [
        { type: 'inner_monologue', summary: '主人最近很焦虑', meta: { streamType: 'self_talk' } },
        { type: 'interaction', summary: '主人说项目卡住了' },
      ],
      candidate: '主人最近很焦虑，我又在想项目卡住了',
      textSimilarity: () => 0.77,
      groundingScore: 0.3,
      abstractDensity: 0.7,
      landingStreak: 4,
    });
    const decision = decideRuminationGuard({ mode: 'audit', metrics });
    const record = createRuminationAuditRecord({
      proposalId: 'p6-guard-001',
      decision,
    });

    expect(record.proposalId).toBe('p6-guard-001');
    expect(record.channel).toBe('rumination_guard');
    expect(record.rawMetrics.semanticSim).toBe(0.77);
    expect(JSON.stringify(record)).not.toContain('主人说项目卡住了');
    expect(record.signalContract).toBe(RUMINATION_SIGNAL_CONTRACT);
  });

  it('documents that guard reads raw timeline signals, not AffectEngine VAD', () => {
    expect(RUMINATION_SIGNAL_CONTRACT).toMatchObject({
      readsVad: false,
      readsRawTimeline: true,
    });
  });
});
