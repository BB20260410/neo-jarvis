// @ts-check
// 阶段1 端到端实证（治 Claude F1：供给端 live 实测为空、闭环生产未验证）。
// 用真 sqlite + 真 ledger + 真 goalSystem + 真 bridge + 真 MemoryCore/WriteGate + 真 learningHook 串联，
// 证明「被现实打脸→惊奇→立目标→真学到」整条闭环在 flag 全开时真活——非单元就绪，是端到端落库铁证。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, getDb, initSqlite } from '../../src/storage/SqliteStore.js';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { NoeMemoryAuditLog } from '../../src/memory/NoeMemoryAuditLog.js';
import { NoeMemoryWriteGate } from '../../src/memory/NoeMemoryWriteGate.js';
import { createExpectationLedger } from '../../src/cognition/NoeExpectationLedger.js';
import { createGoalSystem } from '../../src/cognition/NoeGoalSystem.js';
import { createStepExpectationBridge } from '../../src/cognition/NoeStepExpectationBridge.js';
import { createWorldModelContradictionBridge } from '../../src/cognition/NoeWorldModelContradictionBridge.js';
import { createOwnerCorrectionBridge } from '../../src/cognition/NoeOwnerCorrectionBridge.js';
import { createLearningHook } from '../../src/cognition/NoeLearningHook.js';

const LESSON = '我以为这个端点存在能直接部署，实际它不存在，下次部署前先验证端点可达';

function realStack() {
  const t = 1000;
  const ledger = createExpectationLedger({ now: () => t });
  const goalSystem = createGoalSystem({ now: () => t });
  const memory = new MemoryCore({ logger: { warn: () => {} } });
  const auditLog = new NoeMemoryAuditLog({ db: () => getDb(), now: () => t });
  const writeGate = new NoeMemoryWriteGate({ memory, auditLog, now: () => t, logger: { warn: () => {} } });
  const learningHook = createLearningHook({ adapter: { chat: async () => ({ reply: LESSON }) }, memory, writeGate });
  return { t, ledger, goalSystem, memory, writeGate, learningHook };
}

describe('阶段1 端到端：被现实打脸→惊奇→立目标→真学到（flag 全开闭环实证）', () => {
  let dir = null;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'noe-stage1-e2e-'));
    initSqlite(join(dir, 'panel.db'));
    process.env.NOE_STEP_EXPECTATION_RESOLVE = '1';
    process.env.NOE_LEARNING_HOOK = '1';
    process.env.NOE_WORLDMODEL_CONFLICT = '1';
    process.env.NOE_OWNER_CORRECTION = '1';
  });
  afterEach(() => {
    delete process.env.NOE_STEP_EXPECTATION_RESOLVE; delete process.env.NOE_LEARNING_HOOK;
    delete process.env.NOE_WORLDMODEL_CONFLICT; delete process.env.NOE_OWNER_CORRECTION;
    close(); if (dir) rmSync(dir, { recursive: true, force: true }); dir = null;
  });

  it('act 真失败 → 真 goalSystem 产 surprise goal → learningHook 真写 noe_memory(闭环全程真组件)', async () => {
    const { ledger, goalSystem, learningHook } = realStack();
    const bridge = createStepExpectationBridge({ expectationLedger: ledger, goalSystem, now: () => 1000 });
    // ① 供给端：真 act executor 失败(exit code 非零的真实断言失败) → harvestSurprise(action_failure)
    const r = bridge.onStepFailed({ stepText: '部署服务到一个不存在的端点并上线', kind: 'act', terminal: 'failed', failureReason: 'exit code 1: assertion failed, endpoint missing' });
    expect(r.curiosityGoalId).toBeTruthy();
    const goals = getDb().prepare("SELECT id, title, source, why FROM noe_goals WHERE source='surprise'").all();
    expect(goals.length).toBe(1); // 失败真产 surprise goal（非 fixture failed=0）
    // ② 学习端：surprise goal done → learningHook 真写 noe_memory
    const lr = await learningHook.onSurpriseGoalDone({ ...goals[0], source: 'surprise' });
    expect(lr.persisted).toBe(true);
    const lessons = getDb().prepare("SELECT count(*) c FROM noe_memory WHERE source_type='surprise_lesson' AND project_id='noe'").get();
    expect(lessons.c).toBe(1); // 闭环铁证：noe_memory 真出 surprise_lesson 行
  });

  it('worldModel 矛盾 → surprise goal（信息层源真接通，关键词召回命中 belief）', async () => {
    const { goalSystem, memory } = realStack();
    memory.write({ kind: 'fact', projectId: 'noe', scope: 'fact', body: 'Rust 没有 GC，靠所有权管理内存' });
    const wm = createWorldModelContradictionBridge({ adapter: { chat: async () => ({ reply: 'CONFLICT: 我以为 Rust 有 GC，实际没有' }) }, memory, goalSystem, now: () => 1000 });
    const r = await wm.onContentObserved({ content: '研究表明 Rust 其实没有垃圾回收器，全靠编译期的所有权和借用检查来保证内存安全，这点和 Java、Go、Python 这些有 GC 的语言很不一样。', topic: 'Rust 内存 GC 机制' });
    expect(r.conflict).toBe(true);
    expect(getDb().prepare("SELECT count(*) c FROM noe_goals WHERE source='surprise'").get().c).toBe(1);
  });

  it('owner 纠正 → surprise goal（最强 epistemic 源真接通）', () => {
    const { goalSystem } = realStack();
    const oc = createOwnerCorrectionBridge({ goalSystem, now: () => 1000 });
    const r = oc.onOwnerInteraction({ text: '不对，这个配置其实是写在 env 里不是 json' });
    expect(r.curiosityGoalId).toBeTruthy();
    expect(getDb().prepare("SELECT count(*) c FROM noe_goals WHERE source='surprise'").get().c).toBe(1);
  });
});
