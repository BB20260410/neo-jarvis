import { describe, it, expect } from 'vitest';
import { createWorkspace } from '../../src/cognition/NoeWorkspace.js';
import { textSimilarity } from '../../src/memory/NoeMemoryDedup.js';

const T0 = 1_780_000_000_000;

function makeKv() {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v), m };
}

function baseDeps(over = {}) {
  const journal = [];
  return {
    journal,
    deps: {
      timeline: { recent: () => [{ id: 1, ts: T0 - 1000, type: 'inner_monologue', summary: '昨晚想到的一个念头' }] },
      kv: makeKv(),
      appendJournal: (date, obj) => journal.push({ date, ...obj }),
      now: () => T0,
      textSimilarity,
      ...over,
    },
  };
}

describe('NoeWorkspace 注意力竞争', () => {
  it('到期承诺压过上一念（紧迫×主人相关），赢家成为焦点并写意识日志（含落选者）', () => {
    const { deps, journal } = baseDeps({
      commitmentStore: { due: () => [{ text: '提醒主人 8 点开会' }] },
    });
    const ws = createWorkspace(deps);
    const r = ws.step({ tickId: 7 });
    expect(r.winner.source).toBe('commitment_due');
    expect(ws.currentFocus().text).toContain('提醒主人 8 点开会');
    const line = journal.find((j) => j.kind === 'attend');
    expect(line.tickId).toBe(7);
    expect(line.winner.source).toBe('commitment_due');
    expect(line.runnerUps.some((c) => c.source === 'last_thought')).toBe(true); // 落选者留痕
  });

  it('novelty 惩罚：同一内容连续夺冠后得分下降，让位给新内容', () => {
    let vision = { summary: '主人在写代码' };
    const { deps } = baseDeps({
      timeline: { recent: () => [] },
      peekVision: () => vision,
    });
    const ws = createWorkspace(deps);
    const s1 = ws.step().winner.score;
    const s2 = ws.step().winner.score; // 同画面再次广播 → novelty≈0
    expect(s2).toBeLessThan(s1);
    vision = { summary: '主人切到了游戏画面开始玩' };
    const s3 = ws.step().winner.score; // 新画面 → novelty 回升
    expect(s3).toBeGreaterThan(s2);
  });

  it('视觉候选携带结构化处境，供内心/任务广播消费', () => {
    const { deps } = baseDeps({
      timeline: { recent: () => [] },
      peekVision: () => ({
        summary: '主人在多个窗口之间频繁切换任务',
        situation: { activity: 'task_switching', attention: 'distracted', possibleNeed: 'task_refocus', shouldInterrupt: true, confidence: 0.8 },
      }),
    });
    const ws = createWorkspace(deps);
    const r = ws.step();
    expect(r.winner.text).toContain('处境=task_switching/distracted');
    expect(r.winner.text).toContain('可能需要=task_refocus');
    expect(ws.currentFocus().text).toContain('建议轻触提醒');
  });

  it('深思升级：高分焦点触发 deliberate，预算耗尽后不再升级', async () => {
    const topics = [];
    const { deps } = baseDeps({
      commitmentStore: { due: () => [{ text: '到点提醒一件事' }] },
      deliberate: async ({ topic }) => { topics.push(topic); return { deliberated: true }; },
      deliberationsPerDay: 2,
      deepThreshold: 0.5,
    });
    const ws = createWorkspace(deps);
    expect(ws.step().escalated).toBe(true);
    expect(ws.step().escalated).toBe(true);
    expect(ws.step().escalated).toBe(false); // 日预算 2 用完
    await new Promise((r) => setTimeout(r, 0));
    expect(topics.length).toBe(2);
  });

  it('last_thought 永不升级深思（再入念头自由联想即可，省深思预算）', () => {
    const { deps } = baseDeps({
      deliberate: async () => ({ deliberated: true }),
      deepThreshold: 0,
    });
    const ws = createWorkspace(deps);
    const r = ws.step();
    expect(r.winner.source).toBe('last_thought');
    expect(r.escalated).toBe(false);
  });

  it('审议"想说"过浮现门：门放行 → 走升华通道；门拦截 → 留痕不出声', async () => {
    const sublimated = [];
    const mk = (gatePass) => {
      const { deps, journal } = baseDeps({
        commitmentStore: { due: () => [{ text: '到点的事' }] },
        deliberate: async () => ({ deliberated: true, share: '心跳已平稳运行一天' }),
        surfacingGate: { tryPass: () => ({ pass: gatePass, reason: gatePass ? 'ok' : 'budget_exhausted' }) },
        sublimate: async (text) => { sublimated.push(text); },
        deepThreshold: 0.5,
      });
      return { ws: createWorkspace(deps), journal };
    };
    const a = mk(true);
    a.ws.step();
    await new Promise((r) => setTimeout(r, 0));
    expect(sublimated[0]).toBe('想跟主人说：心跳已平稳运行一天');
    expect(a.journal.find((j) => j.kind === 'surfacing').pass).toBe(true);

    sublimated.length = 0;
    const b = mk(false);
    b.ws.step();
    await new Promise((r) => setTimeout(r, 0));
    expect(sublimated.length).toBe(0);
    expect(b.journal.find((j) => j.kind === 'surfacing').reason).toBe('budget_exhausted');
  });

  it('所有信号源抛错：step 仍完成（fail-open），无候选时焦点为 null', () => {
    const { deps, journal } = baseDeps({
      timeline: { recent: () => { throw new Error('炸'); } },
      commitmentStore: { due: () => { throw new Error('炸'); } },
      peekVision: () => { throw new Error('炸'); },
      driveBrief: () => { throw new Error('炸'); },
      affectProbe: () => { throw new Error('炸'); },
    });
    const ws = createWorkspace(deps);
    const r = ws.step();
    expect(r.winner).toBe(null);
    expect(ws.currentFocus()).toBe(null);
    expect(journal.find((j) => j.kind === 'attend').winner).toBe(null);
  });
});
