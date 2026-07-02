import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';
import { createGoalSystem } from '../../src/cognition/NoeGoalSystem.js';
import { createExpectationResolver } from '../../src/cognition/NoeExpectationResolver.js';

// rank4 好奇回路端到端真实可用：真 sqlite + 真 goalSystem + resolver（mock ledger 出 surprise / mock adapter 出 FAILED）。
// 证明「预测落空 → 真在 noe_goals 立出 source=surprise 研究目标」——被现实纠正后真的会主动学。

let tmp;
let goalSystem;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'noe-curiosity-'));
  initSqlite(join(tmp, 'panel.db'));
  goalSystem = createGoalSystem({});
});

afterEach(() => {
  close();
  rmSync(tmp, { recursive: true, force: true });
});

function mockLedger(dueRows, surprise) {
  return { due: () => dueRows, resolve: (id, outcome) => ({ id, outcome, surprise }) };
}

function adapterReplying(reply) {
  return { chat: async () => ({ reply }) };
}

function openSurpriseGoals() {
  return goalSystem.list({ status: 'open', limit: 200 }).filter((g) => g.source === 'surprise');
}

describe('好奇回路端到端：预测落空 → 真立 source=surprise 研究目标', () => {
  it('outcome=0 + 惊奇≥2bit → noe_goals 真多一条 source=surprise「搞明白为什么没料到」', async () => {
    expect(openSurpriseGoals()).toHaveLength(0);
    const resolver = createExpectationResolver({
      ledger: mockLedger([{ id: 1, claim: '主人今晚会回消息', p: 0.95, created_at: 0, due_at: 0 }], 4.3),
      goalSystem,
      getAdapter: () => adapterReplying('FAILED'),
      evidence: () => '证据：主人整晚没回消息',
    });
    await resolver.tick(5000);
    const goals = openSurpriseGoals();
    expect(goals).toHaveLength(1);
    expect(goals[0].title).toContain('搞明白为什么没料到');
  });

  it('惊奇 < 2bit（低意外）→ 不立目标（harvestSurprise 门槛真生效）', async () => {
    const resolver = createExpectationResolver({
      ledger: mockLedger([{ id: 2, claim: '抛硬币是正面', p: 0.5, created_at: 0, due_at: 0 }], 1.0),
      goalSystem,
      getAdapter: () => adapterReplying('FAILED'),
      evidence: () => '证据：是反面',
    });
    await resolver.tick(5000);
    expect(openSurpriseGoals()).toHaveLength(0);
  });

  it('预测应验(outcome=1) → 不立好奇目标（只有落空才驱动学习）', async () => {
    const resolver = createExpectationResolver({
      ledger: mockLedger([{ id: 3, claim: '能完成任务', p: 0.6, created_at: 0, due_at: 0 }], 0.7),
      goalSystem,
      getAdapter: () => adapterReplying('APPLIED'),
      evidence: () => '证据：任务完成了',
    });
    await resolver.tick(5000);
    expect(openSurpriseGoals()).toHaveLength(0);
  });
});
