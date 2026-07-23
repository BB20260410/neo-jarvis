import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GROWTH_INNER_INTERVAL_MS,
  DEFAULT_IDLE_INNER_INTERVAL_MS,
  decideMesoInnerRhythm,
  normalizeAdaptiveIntervalMs,
} from '../../src/cognition/NoeAdaptiveRhythm.js';

const T0 = 1_780_000_000_000;

function wr(source, score = 0.4, extra = {}) {
  return { winner: { source, score, text: source }, ...extra };
}

describe('NoeAdaptiveRhythm', () => {
  it('默认节奏是连续自主档：成长焦点 5 秒、空闲焦点 15 秒', () => {
    expect(DEFAULT_GROWTH_INNER_INTERVAL_MS).toBe(5_000);
    expect(DEFAULT_IDLE_INNER_INTERVAL_MS).toBe(15_000);
  });

  it('没有工作区时保持旧行为：每个 inner tick 都允许重模型反刍', () => {
    const r = decideMesoInnerRhythm({ workspaceResult: null, now: T0, lastHeavyAt: T0 - 1000 });
    expect(r.runHeavy).toBe(true);
    expect(r.reason).toBe('ungated_no_workspace');
  });

  it('主人互动/到期牵挂/目标步骤等强焦点立即重想', () => {
    for (const source of ['owner_interaction', 'commitment_due', 'expectation_due', 'goal_step']) {
      const r = decideMesoInnerRhythm({ workspaceResult: wr(source, 0.1), now: T0, lastHeavyAt: T0 - 10_000 });
      expect(r.runHeavy).toBe(true);
      expect(r.reason).toBe('force_focus');
      expect(r.source).toBe(source);
    }
  });

  it('工作区已升级深思时，本轮也允许内心反刍接住焦点', () => {
    const r = decideMesoInnerRhythm({
      workspaceResult: wr('fresh_insight', 0.42, { escalated: true }),
      now: T0,
      lastHeavyAt: T0 - 1000,
    });
    expect(r.runHeavy).toBe(true);
    expect(r.reason).toBe('workspace_escalated');
  });

  it('成长型焦点限速：默认最多每 5 秒重想一次', () => {
    const cooling = decideMesoInnerRhythm({
      workspaceResult: wr('drive', 0.42),
      now: T0,
      lastHeavyAt: T0 - DEFAULT_GROWTH_INNER_INTERVAL_MS + 1000,
    });
    expect(cooling.runHeavy).toBe(false);
    expect(cooling.reason).toBe('growth_focus_cooldown');

    const ready = decideMesoInnerRhythm({
      workspaceResult: wr('drive', 0.42),
      now: T0,
      lastHeavyAt: T0 - DEFAULT_GROWTH_INNER_INTERVAL_MS,
    });
    expect(ready.runHeavy).toBe(true);
    expect(ready.reason).toBe('growth_focus_interval');
  });

  it('上一念头/系统状态这类低信号默认按 15 秒空闲间隔重想', () => {
    const cooling = decideMesoInnerRhythm({
      workspaceResult: wr('last_thought', 0.22),
      now: T0,
      lastHeavyAt: T0 - DEFAULT_IDLE_INNER_INTERVAL_MS + 1000,
    });
    expect(cooling.runHeavy).toBe(false);
    expect(cooling.reason).toBe('idle_focus_cooldown');

    const ready = decideMesoInnerRhythm({
      workspaceResult: wr('last_thought', 0.22),
      now: T0,
      lastHeavyAt: T0 - DEFAULT_IDLE_INNER_INTERVAL_MS,
    });
    expect(ready.runHeavy).toBe(true);
    expect(ready.reason).toBe('idle_focus_interval');
  });

  it('高显著度未知焦点也会重想，避免新来源被节律门误伤', () => {
    const r = decideMesoInnerRhythm({ workspaceResult: wr('new_signal', 0.72), now: T0, lastHeavyAt: T0 - 1000 });
    expect(r.runHeavy).toBe(true);
    expect(r.reason).toBe('salient_focus');
  });

  it('本地模型正在跑时不并发堆叠下一次重反刍', () => {
    const r = decideMesoInnerRhythm({
      workspaceResult: wr('owner_interaction', 0.9),
      now: T0,
      lastHeavyAt: T0 - 300_000,
      heavyInFlight: true,
    });
    expect(r.runHeavy).toBe(false);
    expect(r.reason).toBe('heavy_in_flight');
  });

  it('间隔归一化允许开发者下调到 5 秒，但不会低于 tick 基准', () => {
    expect(normalizeAdaptiveIntervalMs('5000', 120_000, 5_000)).toBe(5_000);
    expect(normalizeAdaptiveIntervalMs('1000', 120_000, 5_000)).toBe(5_000);
    expect(normalizeAdaptiveIntervalMs('bad', 120_000, 5_000)).toBe(120_000);
  });
});
