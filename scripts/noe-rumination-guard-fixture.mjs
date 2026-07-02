#!/usr/bin/env node
// Offline fixture report for P6 RuminationGuard. No model, DB, port, or secret access.

import {
  computeRuminationMetrics,
  createRuminationAuditRecord,
  decideRuminationGuard,
} from '../src/cognition/RuminationGuard.js';

const baseEpisodes = [
  { type: 'interaction', summary: '主人交代了一个真实任务' },
  { type: 'observation', summary: '终端里测试刚刚通过' },
  { type: 'inner_monologue', summary: '我想把任务拆成一个小目标', meta: { streamType: 'self_talk' } },
];

const scenarios = [
  {
    name: 'healthy_normal',
    mode: 'normal',
    expectedState: 'normal',
    metrics: computeRuminationMetrics({
      recentEpisodes: baseEpisodes,
      candidate: '我先记录一个可执行的小目标',
      groundingScore: 0.82,
      abstractDensity: 0.1,
      landingStreak: 1,
    }),
  },
  {
    name: 'anchored_repetition_rotates_early',
    mode: 'anchored',
    expectedState: 'rotate',
    metrics: computeRuminationMetrics({
      recentEpisodes: baseEpisodes,
      candidate: '我想把任务拆成一个小目标',
      textSimilarity: () => 0.45,
      groundingScore: 0.8,
      abstractDensity: 0.1,
      landingStreak: 0,
    }),
  },
  {
    name: 'low_grounding_anchors',
    mode: 'normal',
    expectedState: 'anchor',
    metrics: computeRuminationMetrics({
      recentEpisodes: baseEpisodes,
      candidate: '自由意识和存在边界又进入抽象循环',
      groundingScore: 0.2,
      abstractDensity: 0.7,
      landingStreak: 1,
    }),
  },
  {
    name: 'unlanded_streak_cools_down',
    mode: 'normal',
    expectedState: 'cooldown',
    metrics: computeRuminationMetrics({
      recentEpisodes: [
        ...baseEpisodes,
        { type: 'inner_monologue', summary: '自说自话 A', meta: { streamType: 'self_talk' } },
        { type: 'inner_monologue', summary: '自说自话 B', meta: { streamType: 'self_talk' } },
        { type: 'inner_monologue', summary: '自说自话 C', meta: { streamType: 'self_talk' } },
      ],
      candidate: '这次还没有落地',
      groundingScore: 0.7,
      abstractDensity: 0.1,
      landingStreak: 6,
    }),
  },
  {
    name: 'off_silent_blocks',
    mode: 'off',
    expectedState: 'silent',
    metrics: {},
  },
  {
    name: 'audit_shadows_without_blocking',
    mode: 'audit',
    expectedState: 'cooldown',
    expectedWouldBlock: false,
    expectedShadowWouldBlock: true,
    metrics: computeRuminationMetrics({
      recentEpisodes: baseEpisodes,
      candidate: '审计模式只记录不拦截',
      groundingScore: 0.7,
      abstractDensity: 0.1,
      landingStreak: 6,
    }),
  },
];

const rows = scenarios.map((scenario, index) => {
  const decision = decideRuminationGuard({ mode: scenario.mode, metrics: scenario.metrics });
  const audit = createRuminationAuditRecord({
    proposalId: `fixture-${index + 1}`,
    mode: scenario.mode,
    decision,
  });
  const passed = decision.state === scenario.expectedState
    && (scenario.expectedWouldBlock == null || decision.wouldBlock === scenario.expectedWouldBlock)
    && (scenario.expectedShadowWouldBlock == null || decision.shadowWouldBlock === scenario.expectedShadowWouldBlock);
  return {
    name: scenario.name,
    passed,
    expectedState: scenario.expectedState,
    state: decision.state,
    action: decision.action,
    wouldBlock: decision.wouldBlock,
    shadowWouldBlock: decision.shadowWouldBlock,
    reasons: decision.reasons,
    rawMetrics: audit.rawMetrics,
  };
});

const failed = rows.filter((row) => !row.passed);
const tripped = rows.filter((row) => row.state !== 'normal');
const report = {
  ok: failed.length === 0,
  checked: rows.length,
  failed: failed.length,
  ruminationGuardTripRate: Number((tripped.length / rows.length).toFixed(3)),
  rows,
};

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
