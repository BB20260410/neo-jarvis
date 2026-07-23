// @ts-check
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';
import { createGoalSystem } from '../../src/cognition/NoeGoalSystem.js';

// S0.7 好奇 surprise 阈值抽注入式参数（GoalSystem.harvestSurprise）：
//  · 默认（不传 curiositySurpriseThreshold、不设 env）→ 门槛仍为 2bit（逐字零行为变化）。
//  · 注入 opts.curiositySurpriseThreshold → 真生效（既能调高也能调低）。
// 全确定性：独立临时 sqlite、显式注入阈值、不依赖 process.env、不触网/时钟。

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'noe-goal-surprise-'));
  initSqlite(join(tmp, 'panel.db'));
});
afterEach(() => {
  close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('harvestSurprise surprise 阈值 — 默认零回归（=2bit）', () => {
  it('默认实例：surprise=2.0 立项、surprise=1.999 不立项（门槛逐字为 2）', () => {
    const gs = createGoalSystem({});
    expect(gs.harvestSurprise({ claim: '恰好命中阈值', surprise: 2.0 })).toBeTruthy();
    expect(gs.harvestSurprise({ claim: '刚好差一点', surprise: 1.999 })).toBe(null);
  });

  it('默认实例：高惊奇 4.3bit 立 source=surprise 研究目标（旧行为）', () => {
    const gs = createGoalSystem({});
    const id = gs.harvestSurprise({ claim: '主人今晚会回消息', surprise: 4.3 });
    expect(id).toBeTruthy();
    expect(gs.get(id).source).toBe('surprise');
  });
});

describe('harvestSurprise surprise 阈值 — 注入覆盖真生效', () => {
  it('调高到 5bit：原本会立项的 4.3bit 现在被拦下', () => {
    const gs = createGoalSystem({ curiositySurpriseThreshold: 5 });
    expect(gs.harvestSurprise({ claim: '4.3 在高门槛下不够', surprise: 4.3 })).toBe(null);
    expect(gs.harvestSurprise({ claim: '5.0 恰好够', surprise: 5.0 })).toBeTruthy();
  });

  it('调低到 1bit：原本被拦的 1.5bit 现在能立项', () => {
    const gs = createGoalSystem({ curiositySurpriseThreshold: 1 });
    const id = gs.harvestSurprise({ claim: '低门槛放行', surprise: 1.5 });
    expect(id).toBeTruthy();
    expect(gs.get(id).source).toBe('surprise');
  });
});

describe('harvestSurprise — P1-D 去重边界（add 层防膨胀，已有 open 相同目标不重立、closed 后可重立）', () => {
  it('相同 claim 已有 open 目标时不重复立项（add 层去重防膨胀，无需 harvestSurprise 再加指纹去重）', () => {
    const gs = createGoalSystem({});
    const id1 = gs.harvestSurprise({ claim: 'owner 纠正了我的判断：API 是 POST', surprise: 3 });
    expect(id1).toBeTruthy();
    // 相同 claim 且 id1 仍 open → add 层去重，不膨胀
    expect(gs.harvestSurprise({ claim: 'owner 纠正了我的判断：API 是 POST', surprise: 3 })).toBeFalsy();
    // 不同 claim → 正常另立（不同认知维度分别立项合理）
    const id2 = gs.harvestSurprise({ claim: '完全不同的另一条预测落空', surprise: 3 });
    expect(id2).toBeTruthy();
    expect(id2).not.toBe(id1);
  });
});

describe('harvestSurprise — 步骤2 Goodhart origin 门（多模型安全方案·防 self_evolution 刷假落空）', () => {
  it('NOE_CURIOSITY_ORIGIN_GATE=1：只放行外部锚真负反馈(owner_*/action_failure/world_model_conflict)，拒 Neo 自评/虚构任务/内省落空', () => {
    const prev = process.env.NOE_CURIOSITY_ORIGIN_GATE;
    process.env.NOE_CURIOSITY_ORIGIN_GATE = '1';
    try {
      const gs = createGoalSystem({});
      expect(gs.harvestSurprise({ claim: 'owner 纠正了我的判断A', surprise: 3, origin: 'owner_correction' })).toBeTruthy();
      expect(gs.harvestSurprise({ claim: '动手真失败B', surprise: 3, origin: 'action_failure' })).toBeTruthy();
      expect(gs.harvestSurprise({ claim: '读到与认知矛盾C', surprise: 3, origin: 'world_model_conflict' })).toBeTruthy();
      // 噪声 origin（Neo 自评/深思虚构任务/内省念头落空）→ 拒，防刷假学习
      expect(gs.harvestSurprise({ claim: '深思虚构任务没兑现D', surprise: 3, origin: 'reflection_miss' })).toBe(null);
      expect(gs.harvestSurprise({ claim: '内省念头落空E', surprise: 3, origin: 'expectation_miss' })).toBe(null);
      expect(gs.harvestSurprise({ claim: '放宽正则才认的落空F', surprise: 3, origin: 'loosen_fail' })).toBe(null);
      expect(gs.harvestSurprise({ claim: '无originG', surprise: 3 })).toBe(null);
    } finally { if (prev === undefined) delete process.env.NOE_CURIOSITY_ORIGIN_GATE; else process.env.NOE_CURIOSITY_ORIGIN_GATE = prev; }
  });

  it('NOE_CURIOSITY_ORIGIN_GATE OFF（默认）：门不拦，任意 origin 照常立项（零回归）', () => {
    const gs = createGoalSystem({});
    expect(gs.harvestSurprise({ claim: 'reflection 落空照立H', surprise: 3, origin: 'reflection_miss' })).toBeTruthy();
    expect(gs.harvestSurprise({ claim: '无 origin 照立I', surprise: 3 })).toBeTruthy();
  });
});
