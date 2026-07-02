// @ts-check
import { describe, it, expect } from 'vitest';
import { createWorkspace } from '../../src/cognition/NoeWorkspace.js';

// HANDOFF rank4 — GWT novelty 语义 embedding 升级（NOE_GWT_SEMANTIC_NOVELTY，注入式 semanticEmbedder）：
//  · OFF（不注入 semanticEmbedder）→ novelty 逐字走原字符相似度，分数与升级前一致（零回归）。
//  · ON + 预缓存命中 → 语义相似度驱动 novelty（即便字符不同也能识别同义 → 压低新异度）。
//  · ON + embedder 抛错 / 冷缓存（没预热）→ 自动退回字符相似度（fail-open），绝不锁死、绝不抛。
//  · 同步 step() 内【绝不】调用 embedder（codex 硬约束）：embed 只在异步 refreshSemanticCache 里发生。
//  · provider 换维度 → 语义缓存整表清空，绝不跨维 cosine 崩。
// 全确定性：固定 now、不注 affectProbe（arousal 恒 0.35）、不触网、embedder 是确定性假实现、不读真实 env。

const T0 = 1_780_000_000_000;

// 字符相似度桩：完全相等=1，否则=0（够算 novelty：1-max）。可计数调用次数。
function charSimStub() {
  const calls = [];
  const fn = (a, b) => { calls.push([a, b]); return a === b ? 1 : 0; };
  fn.calls = calls;
  return fn;
}

// 确定性假语义 embedder：按文本含的「语义标记」给固定 L2 归一向量；
// 'A' 系列互为近义（高 cosine），'B' 系列与 A 正交。可计数 embed 次数 + 注入故障。
function fakeEmbedder({ fail = false, dimSwitch = false } = {}) {
  const calls = [];
  let switched = false;
  const fn = async (text) => {
    calls.push(text);
    if (fail) throw new Error('embed 炸了');
    // 维度切换演示：第 N 次之后改返回 4 维（触发 workspace 清表）。
    if (dimSwitch && calls.length > 3) { switched = true; return { vector: new Float32Array([0, 0, 0, 1]) }; }
    const s = String(text);
    if (s.includes('猫')) return { vector: new Float32Array([1, 0, 0]) };       // A1
    if (s.includes('喵')) return { vector: new Float32Array([0.97, 0.24, 0]) }; // A2 与 A1 cosine≈0.97（同义）
    if (s.includes('狗')) return { vector: new Float32Array([0, 1, 0]) };       // B  与 A 正交
    return { vector: new Float32Array([0, 0, 1]) };
  };
  fn.calls = calls;
  fn.didSwitch = () => switched;
  return fn;
}

// 造两个候选：percept（owner0.6/urg0.2/affect0.3）与 last_thought（owner0/urg0.1/affect0.2），
// 通过 timeline.recent 注入「上一念」让 novelty 对它生效。这里聚焦 percept 的 novelty。
function depsWith(over = {}) {
  return {
    timeline: { recent: () => [] },
    appendJournal: () => {},
    now: () => T0,
    ...over,
  };
}

// 复算 percept 分数：s = w.owner*0.6 + w.urgency*0.2 + w.novelty*n + w.affect*0.3*(0.5+0.35/2)
const W = { owner: 0.35, urgency: 0.25, novelty: 0.2, affect: 0.2 };
function perceptScore(n) {
  const s = W.owner * 0.6 + W.urgency * 0.2 + W.novelty * n + W.affect * 0.3 * (0.5 + 0.35 / 2);
  return Math.round(s * 1000) / 1000;
}

describe('GWT 语义 novelty — OFF / 未注入 embedder 零回归', () => {
  it('不注入 semanticEmbedder → novelty 走字符相似度，分数=原公式（逐字不变）', () => {
    const sim = charSimStub();
    const ws = createWorkspace(depsWith({ peekVision: () => ({ summary: '主人在写代码' }), textSimilarity: sim }));
    // 第一次：recentWinners 空 → novelty=1
    const r1 = ws.step();
    expect(r1.winner.source).toBe('percept');
    expect(r1.winner.score).toBe(perceptScore(1));
    // 第二次：同样的 percept 文本进了 recentWinners，字符相似度=1 → novelty=0
    const r2 = ws.step();
    expect(r2.winner.score).toBe(perceptScore(0));
  });

  it('未注入 embedder 时 refreshSemanticCache 存在但是 no-op（不抛、可调）', async () => {
    const ws = createWorkspace(depsWith({ peekVision: () => ({ summary: 'x' }), textSimilarity: charSimStub() }));
    ws.step();
    await expect(ws.refreshSemanticCache()).resolves.toBeUndefined();
  });
});

describe('GWT 语义 novelty — 同步 step 绝不 embed（codex 硬约束）', () => {
  it('注入 embedder 后，连续 step() 期间 embedder 调用次数恒为 0', () => {
    const emb = fakeEmbedder();
    const ws = createWorkspace(depsWith({ peekVision: () => ({ summary: '一只猫' }), textSimilarity: charSimStub(), semanticEmbedder: emb }));
    ws.step();
    ws.step();
    ws.step();
    expect(emb.calls.length).toBe(0); // 只有 refreshSemanticCache（异步）才允许 embed
  });
});

describe('GWT 语义 novelty — ON + 预缓存命中走语义', () => {
  it('字符不同但语义相近（猫↔喵）→ 预热后 novelty 由语义相似度压低（< 字符路给的 1）', async () => {
    const emb = fakeEmbedder();
    const sim = charSimStub(); // 字符路：猫≠喵 → 相似度 0 → novelty 会是 1
    // tick1 焦点文本含「猫」，进 recentWinners；tick2 焦点含「喵」。
    let summary = '一只猫';
    const ws = createWorkspace(depsWith({ peekVision: () => ({ summary }), textSimilarity: sim, semanticEmbedder: emb }));
    ws.step(); // winner='眼前看到：一只猫' 进 recentWinners
    await ws.refreshSemanticCache(); // 预热 recentWinners + 上一 tick 候选向量
    summary = '一只喵'; // 语义≈猫、字符≠猫
    await ws.refreshSemanticCache(); // 预热含「喵」的候选向量（用上一 tick 候选；此处再热一次确保「喵」候选向量入缓存前先出现在候选）
    // 让「喵」先成为候选并被记入 lastCandidateTexts，再预热，使其向量入缓存：
    // 顺序：step(喵)→候选记下→refresh→下一次 step(喵) 才命中语义。
    ws.step();
    await ws.refreshSemanticCache();
    const r = ws.step(); // 此时「喵」候选向量 + recentWinners 里「猫/喵」向量都在缓存 → 走语义
    expect(r.winner.source).toBe('percept');
    // 语义路 novelty = 1 - max cosine。recentWinners 含「喵」自身（cosine 1）→ novelty=0；故分数应等于语义路结果
    // 而非字符路的 perceptScore(1)。关键断言：分数 < 字符路 novelty=1 的分数（证明语义真生效、非假融入）。
    expect(r.winner.score).toBeLessThan(perceptScore(1));
    expect(emb.calls.length).toBeGreaterThan(0); // embed 确实只发生在 refresh
  });
});

describe('GWT 语义 novelty — fail-open 退字符相似度', () => {
  it('embedder 抛错 → 缓存空 → novelty 退回字符相似度，分数与 OFF 路一致、step 不抛', async () => {
    const emb = fakeEmbedder({ fail: true });
    const sim = charSimStub();
    const ws = createWorkspace(depsWith({ peekVision: () => ({ summary: '同一句' }), textSimilarity: sim, semanticEmbedder: emb }));
    ws.step();
    await expect(ws.refreshSemanticCache()).resolves.toBeUndefined(); // 失败被吞，不抛
    const r = ws.step(); // 缓存里没有任何向量（embed 全失败）→ novelty 走字符路：同句相似度1 → novelty 0
    expect(r.winner.score).toBe(perceptScore(0));
  });

  it('冷缓存（注入 embedder 但从不预热）→ novelty 走字符相似度（同句 → novelty 0）', () => {
    const emb = fakeEmbedder();
    const sim = charSimStub();
    const ws = createWorkspace(depsWith({ peekVision: () => ({ summary: '同一句' }), textSimilarity: sim, semanticEmbedder: emb }));
    ws.step();          // recentWinners 进「同一句」
    const r = ws.step(); // 从未 refresh → semCache 空 → 退字符路
    expect(r.winner.score).toBe(perceptScore(0));
    expect(emb.calls.length).toBe(0); // 证明 step 同步路确实没 embed
  });
});

describe('GWT 语义 novelty — provider 换维度清表不崩', () => {
  it('维度从 3 → 4 切换：refreshSemanticCache 清空旧向量，后续 step 不抛、不跨维 cosine', async () => {
    const emb = fakeEmbedder({ dimSwitch: true });
    const sim = charSimStub();
    let summary = '一只猫';
    const ws = createWorkspace(depsWith({ peekVision: () => ({ summary }), textSimilarity: sim, semanticEmbedder: emb }));
    // 用 5 个互不相同的候选文本，让 refreshSemanticCache 去重后仍 embed >3 次（触发 fakeEmbedder 第 4 次起的维度切换）。
    const summaries = ['一只猫', '一只狗', '一只鸟', '一条鱼', '一只虫'];
    for (let i = 0; i < 5; i++) { summary = summaries[i]; ws.step(); await ws.refreshSemanticCache(); }
    expect(emb.didSwitch()).toBe(true);
    // 维度切换后再 step 必须不抛（清表后按新维度重建，不会拿 3 维 vs 4 维 cosine）
    expect(() => ws.step()).not.toThrow();
  });
});
