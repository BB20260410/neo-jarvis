// @ts-check
import { describe, it, expect } from 'vitest';
import { createWorkspace } from '../../src/cognition/NoeWorkspace.js';
import { textSimilarity } from '../../src/memory/NoeMemoryDedup.js';

// S0.3：NoeWorkspace 广播前思维回环守卫。全确定性：注入 now / loopGuardGate / 念头流，不依赖真实时钟/网络/模型/process.env。

const T0 = 1_780_000_000_000;
function makeKv() { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v), m }; }
// 同主题 vision 连续夺冠 → recentWinners 堆满共享关键词「意识」「自由」→ 触发回环。
function loopingVisionDeps(over = {}) {
  const journal = [];
  const variants = ['我又在想意识和自由的关系', '意识到底是不是自由的前提呢', '自由意识这个问题又冒出来了', '关于意识与自由我还是没头绪', '意识、自由，绕来绕去就这俩', '意识和自由的纠葛再次浮现'];
  let i = 0;
  return { journal, deps: { timeline: { recent: () => [] }, kv: makeKv(), appendJournal: (date, obj) => journal.push({ date, ...obj }), now: () => T0 + i * 1000, textSimilarity, peekVision: () => ({ summary: variants[Math.min(i, variants.length - 1)] }), ...over }, advance: () => { i += 1; } };
}

describe('NoeWorkspace 思维回环守卫（NOE_THOUGHT_LOOP_GUARD）', () => {
  it('ON：同一批主题词打转 → 写 thought_loop 日志 + 暴露信号', () => {
    const { deps, journal, advance } = loopingVisionDeps({ loopGuardGate: { enabled: true } });
    const ws = createWorkspace(deps);
    for (let k = 0; k < 6; k++) { ws.step({ tickId: k }); advance(); }
    const loopLines = journal.filter((j) => j.kind === 'thought_loop');
    expect(loopLines.length).toBeGreaterThanOrEqual(1);
    const last = loopLines[loopLines.length - 1];
    const kws = new Set((last.sharedKeywords || []).map((k) => k.keyword));
    expect(kws.has('意识')).toBe(true);
    expect(kws.has('自由')).toBe(true);
    expect(typeof last.suggestion).toBe('string');
    expect(last.suggestion.length).toBeGreaterThan(0);
    const sig = ws.getThoughtLoopSignal();
    expect(sig).not.toBeNull();
    expect(sig.consideredCount).toBeGreaterThanOrEqual(5);
  });
  it('ON 但不打转（每次不同主题）→ 不写 thought_loop，信号 null', () => {
    const journal = [];
    const distinct = ['修一个登录 bug', '给主人回一封邮件', '研究新的渲染管线', '整理上周会议纪要', '盘算晚饭吃什么', '看看窗外天气'];
    let i = 0;
    const ws = createWorkspace({ timeline: { recent: () => [] }, kv: makeKv(), appendJournal: (date, obj) => journal.push({ date, ...obj }), now: () => T0 + i * 1000, textSimilarity, peekVision: () => ({ summary: distinct[Math.min(i, distinct.length - 1)] }), loopGuardGate: { enabled: true } });
    for (let k = 0; k < 6; k++) { ws.step({ tickId: k }); i += 1; }
    expect(journal.some((j) => j.kind === 'thought_loop')).toBe(false);
    expect(ws.getThoughtLoopSignal()).toBeNull();
  });
  it('OFF（enabled=false）：严重打转也零变化——无日志、信号 null', () => {
    const { deps, journal, advance } = loopingVisionDeps({ loopGuardGate: { enabled: false } });
    const ws = createWorkspace(deps);
    for (let k = 0; k < 6; k++) { ws.step({ tickId: k }); advance(); }
    expect(journal.some((j) => j.kind === 'thought_loop')).toBe(false);
    expect(ws.getThoughtLoopSignal()).toBeNull();
  });
  it('未注入 loopGuardGate（默认 null）：等同 OFF 零回归', () => {
    const { deps, journal, advance } = loopingVisionDeps();
    const ws = createWorkspace(deps);
    for (let k = 0; k < 6; k++) { ws.step({ tickId: k }); advance(); }
    expect(journal.some((j) => j.kind === 'thought_loop')).toBe(false);
    expect(ws.getThoughtLoopSignal()).toBeNull();
  });
  it('OFF 时赢家选择不受守卫影响', () => {
    const { deps, journal, advance } = loopingVisionDeps({ loopGuardGate: { enabled: false } });
    const ws = createWorkspace(deps);
    const r = ws.step({ tickId: 0 }); advance();
    expect(r.winner.source).toBe('percept');
    expect(journal.find((j) => j.kind === 'attend').winner.source).toBe('percept');
  });
});
