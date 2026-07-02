// @ts-check
// P0.5 done outcome 门——治 checkbox≠outcome 的公共根因：研究步空产出不再刷假 done。
// flag NOE_LEARNING_OUTCOME_GATE 门控，默认 OFF（逐字零回归）。
import { describe, expect, it } from 'vitest';
import { createWorkspace } from '../../src/cognition/NoeWorkspace.js';

const T0 = 1_700_000_000_000;
function makeKv() {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => { m.set(k, v); } };
}

function researchWorkspace({ report, outcomeGate, progress }) {
  return createWorkspace({
    timeline: { recent: () => [] },
    goalSystem: {
      arbitrate: () => {},
      nextStep: () => ({ goalId: 'g-r', title: '自主学习：X', stepIndex: 0, step: '上网搜索并学习：X', kind: 'research', priority: 0.99 }),
      recordStepCheckpoint: () => {},
      recordStepResult: (goalId, idx, payload) => { progress.push({ goalId, idx, ...payload }); return { goalDone: false }; },
    },
    runResearch: async () => ({ report, sources: report ? [{ url: 'x' }] : [] }),
    learningOutcomeGate: outcomeGate,
    kv: makeKv(), appendJournal: () => {}, now: () => T0, deepThreshold: 0,
  });
}

describe('P0.5 done outcome 门（空产出研究步不算完成）', () => {
  it('门 ON + 研究产出空报告 → 步骤标 blocked，不计 done（不刷假 done）', async () => {
    const progress = [];
    const ws = researchWorkspace({ report: '', outcomeGate: true, progress });
    ws.step();
    await new Promise((r) => setTimeout(r, 30));
    const rec = progress.filter((p) => p.goalId === 'g-r').pop();
    expect(rec).toBeTruthy();
    expect(rec.done).not.toBe(true);
    expect(rec.status).toBe('blocked');
  });

  it('门 ON + 研究产出真报告 → 正常 done（真学到才算完成）', async () => {
    const progress = [];
    const ws = researchWorkspace({ report: '这是一份有实质内容的研究报告，讲清了 X 的机制与常见坑。', outcomeGate: true, progress });
    ws.step();
    await new Promise((r) => setTimeout(r, 30));
    const rec = progress.filter((p) => p.goalId === 'g-r').pop();
    expect(rec.done).toBe(true);
  });

  it('门 OFF（默认）→ 空报告仍 done:true（逐字零回归）', async () => {
    const progress = [];
    const ws = researchWorkspace({ report: '', outcomeGate: false, progress });
    ws.step();
    await new Promise((r) => setTimeout(r, 30));
    const rec = progress.filter((p) => p.goalId === 'g-r').pop();
    expect(rec.done).toBe(true);
  });
});
