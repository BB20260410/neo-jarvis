// @ts-check
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { createWorldModelContradictionBridge } from '../../src/cognition/NoeWorldModelContradictionBridge.js';

function makeAdapter(reply) { return { chat: async () => ({ reply }) }; }
function makeGoalSystem() { const calls = []; return { calls, harvestSurprise: (a) => { calls.push(a); return 'cg-1'; } }; }
const LONG = '关于这个主题我读到一段足够长的新内容，用来触发本地脑的事实矛盾判断，至少四十个字符。';
const BELIEF = [{ id: 'm1', body: '我原以为人工智能对齐是已解决的简单问题' }]; // 含 topic 关键词，过 WM-OVERRECALL 相关性过滤

describe('createWorldModelContradictionBridge（阶段1 P1 信息层 epistemic 源）', () => {
  beforeEach(() => { process.env.NOE_WORLDMODEL_CONFLICT = '1'; });
  afterEach(() => { delete process.env.NOE_WORLDMODEL_CONFLICT; });

  it('flag OFF → null（零行为）', async () => {
    delete process.env.NOE_WORLDMODEL_CONFLICT;
    const b = createWorldModelContradictionBridge({ adapter: makeAdapter('CONFLICT: x'), memory: { recall: () => BELIEF }, goalSystem: makeGoalSystem() });
    expect(await b.onContentObserved({ content: LONG, topic: '人工智能对齐' })).toBeNull();
  });

  it('无已有认知(related 空) → skip:no_belief（初次学非被打脸，不产 surprise）', async () => {
    const b = createWorldModelContradictionBridge({ adapter: makeAdapter('CONFLICT: x'), memory: { recall: () => [] }, goalSystem: makeGoalSystem() });
    expect(await b.onContentObserved({ content: LONG, topic: '人工智能对齐' })).toMatchObject({ skipped: 'no_belief' });
  });

  it('本地脑判 NONE（无矛盾/只是补充）→ 不产 surprise', async () => {
    const gs = makeGoalSystem();
    const b = createWorldModelContradictionBridge({ adapter: makeAdapter('NONE'), memory: { recall: () => BELIEF }, goalSystem: gs });
    const r = await b.onContentObserved({ content: LONG, topic: '人工智能对齐' });
    expect(r.conflict).toBe(false);
    expect(gs.calls).toHaveLength(0);
  });

  it('本地脑输出「NO CONFLICT」→ 不被误判为冲突（治 codex 漏洞4 未锚定正则）', async () => {
    const gs = makeGoalSystem();
    const b = createWorldModelContradictionBridge({ adapter: makeAdapter('NO CONFLICT: 新内容只是补充细节，与已有认知一致'), memory: { recall: () => BELIEF }, goalSystem: gs });
    const r = await b.onContentObserved({ content: LONG, topic: '人工智能对齐' });
    expect(r.conflict).toBe(false); // 行首锚定后 NO CONFLICT 不匹配 ^CONFLICT
    expect(gs.calls).toHaveLength(0);
  });

  it('本地脑判 CONFLICT → harvestSurprise(world_model_conflict)', async () => {
    const gs = makeGoalSystem();
    const b = createWorldModelContradictionBridge({ adapter: makeAdapter('CONFLICT: 我原以为A，实际是B'), memory: { recall: () => BELIEF }, goalSystem: gs });
    const r = await b.onContentObserved({ content: LONG, topic: '人工智能对齐', source: 'research' });
    expect(r.conflict).toBe(true);
    expect(r.conflictPoint).toContain('实际是B');
    expect(gs.calls[0]).toMatchObject({ origin: 'world_model_conflict', surprise: 2.5 });
    expect(r.curiosityGoalId).toBe('cg-1');
  });

  it('去重：同 topic 短窗只判一次（防一段内容反复刷）', async () => {
    const gs = makeGoalSystem();
    const b = createWorldModelContradictionBridge({ adapter: makeAdapter('CONFLICT: 矛盾点XYZ'), memory: { recall: () => BELIEF }, goalSystem: gs, now: () => 5000 });
    await b.onContentObserved({ content: LONG, topic: '人工智能对齐' });
    expect(await b.onContentObserved({ content: LONG, topic: '人工智能对齐' })).toMatchObject({ skipped: 'deduped' });
    expect(gs.calls).toHaveLength(1);
  });

  it('内容太短 → null（无从判矛盾）', async () => {
    const b = createWorldModelContradictionBridge({ adapter: makeAdapter('CONFLICT: x'), memory: { recall: () => BELIEF }, goalSystem: makeGoalSystem() });
    expect(await b.onContentObserved({ content: '短', topic: '人工智能对齐' })).toBeNull();
  });

  it('recall 带 projectId:noe（治 learningHook D1 同坑——召回 belief 用 noe 项目）', async () => {
    let recallArg = null;
    const memory = { recall: (a) => { recallArg = a; return BELIEF; } };
    const b = createWorldModelContradictionBridge({ adapter: makeAdapter('NONE'), memory, goalSystem: makeGoalSystem() });
    await b.onContentObserved({ content: LONG, topic: '人工智能对齐' });
    expect(recallArg.projectId).toBe('noe');
  });

  it('fail-open：adapter 抛错不崩', async () => {
    const b = createWorldModelContradictionBridge({ adapter: { chat: async () => { throw new Error('down'); } }, memory: { recall: () => BELIEF }, goalSystem: makeGoalSystem() });
    expect(await b.onContentObserved({ content: LONG, topic: '人工智能对齐' })).toBeNull();
  });
});

// 真 sqlite 端到端（治 Claude WM-FATAL-1：整条自然语言 topic 子串召回恒 0；治 mock recall 假绿掩盖 recall 缺陷）。
describe('createWorldModelContradictionBridge · 真 sqlite（关键词召回 vs 整条子串）', () => {
  let dir = null;
  beforeEach(() => { process.env.NOE_WORLDMODEL_CONFLICT = '1'; });
  afterEach(() => { delete process.env.NOE_WORLDMODEL_CONFLICT; close(); if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

  it('自然语言 topic：整条子串召回恒 0，但关键词召回命中 belief→判矛盾→harvestSurprise', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noe-wm-e2e-'));
    initSqlite(join(dir, 'panel.db'));
    const memory = new MemoryCore({ logger: { warn: () => {} } });
    memory.write({ kind: 'fact', projectId: 'noe', scope: 'fact', body: 'Rust 靠所有权和借用管理内存，运行时没有 GC 垃圾回收器' });
    // 反向证明 WM-FATAL-1：整条自然语言 topic 做子串匹配召回恒 0
    expect((memory.recall({ query: 'Rust 内存管理 GC 机制对比研究', projectId: 'noe' }) || []).length).toBe(0);
    // bridge 关键词召回（Rust/内存/GC…）命中 belief → 不死在 no_belief
    const gs = { calls: [], harvestSurprise(a) { this.calls.push(a); return 'cg-1'; } };
    const b = createWorldModelContradictionBridge({ adapter: { chat: async () => ({ reply: 'CONFLICT: 我以为 Rust 有 GC，实际它没有' }) }, memory, goalSystem: gs });
    const r = await b.onContentObserved({ content: '研究发现 Rust 其实没有垃圾回收器，全靠编译期所有权检查保证内存安全，这点和 Java/Go 很不一样。', topic: 'Rust 内存管理 GC 机制对比研究' });
    expect(r.skipped).not.toBe('no_belief'); // 关键词召回命中，没死在子串病
    expect(r.conflict).toBe(true);
    expect(gs.calls[0]).toMatchObject({ origin: 'world_model_conflict' });
  });

  it('召回到但只共享 1 个泛词的无关 belief→相关性过滤挡掉(no_relevant_belief，治 WM-OVERRECALL)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noe-wm-rel-'));
    initSqlite(join(dir, 'panel.db'));
    const memory = new MemoryCore({ logger: { warn: () => {} } });
    memory.write({ kind: 'fact', projectId: 'noe', scope: 'fact', body: '机器学习的模型容易过拟合需要正则化处理' });
    const gs = { calls: [], harvestSurprise(a) { this.calls.push(a); return 'g'; } };
    // adapter 若被喂会瞎编 CONFLICT——但相关性过滤应在喂脑前挡掉
    const b = createWorldModelContradictionBridge({ adapter: { chat: async () => ({ reply: 'CONFLICT: 瞎编的矛盾' }) }, memory, goalSystem: gs });
    const r = await b.onContentObserved({ content: '关于服务部署和推理加速的研究：用量化和蒸馏可以让推理速度提升很多倍的详细分析报告', topic: '模型 部署 推理 加速' });
    expect(r?.skipped).toBe('no_relevant_belief'); // 召回到含「模型」的 belief 但只 1 泛词→挡掉，不喂脑
    expect(gs.calls).toHaveLength(0); // 不产假矛盾
  });
});
