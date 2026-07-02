import { describe, expect, it } from 'vitest';
import { createNoeWorkMapPanel } from '../../public/src/web/noe-work-map-ui.js';

function node(id) {
  return {
    id,
    className: '',
    textContent: '',
    dataset: {},
    scrollTop: 0,
    _innerHTML: '',
    set innerHTML(value) { this._innerHTML = value; },
    get innerHTML() { return this._innerHTML; },
  };
}

function makePanel(apiResult) {
  const nodes = new Map([
    ['workMapStatus', node('workMapStatus')],
    ['workMapSummary', node('workMapSummary')],
    ['workMapStats', node('workMapStats')],
    ['workMapFilters', node('workMapFilters')],
    ['workMapItems', node('workMapItems')],
  ]);
  const panel = createNoeWorkMapPanel({
    api: async () => apiResult,
    $: (id) => nodes.get(id),
    esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    rel: () => '刚刚',
    short: (s, n = 80) => String(s || '').slice(0, n),
    renderRecentList: (box, html, firstKey) => {
      box.innerHTML = html;
      box.dataset.firstKey = firstKey;
    },
  });
  return { panel, nodes };
}

describe('Noe work map UI', () => {
  it('renders counts and escapes work item text', async () => {
    const { panel, nodes } = makePanel({
      ok: true,
      generatedAt: '2026-06-13T02:00:00.000Z',
      sources: { sqlite: { available: true } },
      counts: {
        sessions: { active: 0, busy: 0 },
        rooms: { activeCount: 1, archivedCount: 0 },
        goals: { active: 2, total: 3, hygiene: { checkpointBacked: 1, withoutCheckpoints: 1 } },
        missions: { active: 1, total: 4 },
        reportbacks: { active: 1, current: 2, staleActive: 1 },
        delegations: { total: 0 },
        autopilot: { total: 1 },
        observationStatus: {
          status: 'wait_for_expectation_due',
          blockerCount: 2,
          readyForNextStageReview: false,
          p8DailyObservation: {
            available: true,
            observationDayIndex: 1,
            minObservationDays: 7,
            daysRemaining: 6.58,
            doNotStartNextStage: true,
          },
          followup: { status: 'waiting_for_natural_judgement', completionGate: { canMarkComplete: false }, resumeProtocol: { canRunNow: false, waitingForNaturalJudgement: true }, scheduler: { available: true, state: 'not running', logs: { stdout: { exists: true } } }, schedulerExpectation: { lastEvidenceAtLocal: '2026-06-13T12:00:00+08:00', expectedNextRunAtLocal: '2026-06-13T12:15:00+08:00', staleIfNoRunAfterLocal: '2026-06-13T12:30:00+08:00' } },
        },
        activeWorkItems: 3,
        blockedWorkItems: 1,
      },
      workItems: [
        {
          id: 'goal-1',
          kind: 'goal',
          title: '<script>alert(1)</script>',
          status: 'open',
          tone: 'active',
          source: 'self_learning',
          detail: 'evidence ready',
          updatedAt: '2026-06-13T02:00:00.000Z',
          evidenceCount: 2,
        },
        {
          id: 'trb-stale',
          kind: 'reportback',
          title: '卡住的执行回报',
          status: 'running',
          tone: 'blocked',
          source: 'workspace',
          detail: 'stale 2.0h · next confirm_progress_or_mark_blocked',
          updatedAt: '2026-06-13T00:00:00.000Z',
          stale: true,
          staleAgeMinutes: 120,
          nextAction: 'confirm_progress_or_mark_blocked',
        },
        {
          id: 'noe-observation-status',
          kind: 'observation',
          title: '长期观察门仍在等待',
          status: 'blocked',
          tone: 'blocked',
          source: 'observation_status',
          detail: 'expectation 10/20 · soak 4/7d',
          updatedAt: '2026-06-13T02:00:00.000Z',
          evidenceCount: 2,
          ref: 'output/noe-observation-status/latest.json',
        },
      ],
    });

    await panel.load();

    expect(nodes.get('workMapStatus').textContent).toBe('阻塞 · 活跃 3');
    expect(nodes.get('workMapStats').innerHTML).toContain('<b>2</b>');
    expect(nodes.get('workMapStats').innerHTML).toContain('目标链路');
    expect(nodes.get('workMapStats').innerHTML).toContain('已检查 1');
    expect(nodes.get('workMapFilters').innerHTML).toContain('data-work-map-filter="active"');
    expect(nodes.get('workMapFilters').innerHTML).toContain('data-work-map-filter="observation"');
    expect(nodes.get('workMapFilters').innerHTML).toContain('目标 1');
    expect(nodes.get('workMapFilters').innerHTML).toContain('长任务 0');
    expect(nodes.get('workMapFilters').innerHTML).toContain('观察门 1');
    expect(nodes.get('workMapStats').innerHTML).toContain('等期望到期');
    expect(nodes.get('workMapStats').innerHTML).toContain('跟进 等自然判证');
    expect(nodes.get('workMapStats').innerHTML).toContain('P8 1/7天');
    expect(nodes.get('workMapStats').innerHTML).toContain('剩 6.6天');
    expect(nodes.get('workMapStats').innerHTML).toContain('禁止P9/R');
    expect(nodes.get('workMapStats').innerHTML).toContain('完成门 不可完成');
    expect(nodes.get('workMapStats').innerHTML).toContain('续跑 等判证');
    expect(nodes.get('workMapStats').innerHTML).toContain('调度 未运行');
    expect(nodes.get('workMapStats').innerHTML).toContain('日志 ok');
    expect(nodes.get('workMapStats').innerHTML).toContain('证据 2026-06-13T12:');
    expect(nodes.get('workMapStats').innerHTML).toContain('下次 2026-06-13T12:');
    expect(nodes.get('workMapStats').innerHTML).toContain('超时 2026-06-13T12:30');
    expect(nodes.get('workMapStats').innerHTML).toContain('过期 1');
    expect(nodes.get('workMapItems').innerHTML).toContain('目标已记录');
    expect(nodes.get('workMapItems').innerHTML).toContain('卡住的执行回报');
    expect(nodes.get('workMapItems').innerHTML).toContain('过期 120 分钟');
    expect(nodes.get('workMapItems').innerHTML).toContain('下一步已记录');
    expect(nodes.get('workMapItems').innerHTML).toContain('长期观察门仍在等待');
    expect(nodes.get('workMapItems').innerHTML).not.toContain('confirm_progress_or_mark_blocked');
    expect(nodes.get('workMapItems').innerHTML).not.toContain('<script>');
  });
});
