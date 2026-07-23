// @ts-check
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, getDb, initSqlite } from '../../src/storage/SqliteStore.js';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { NoeMemoryAuditLog } from '../../src/memory/NoeMemoryAuditLog.js';
import { NoeMemoryWriteGate } from '../../src/memory/NoeMemoryWriteGate.js';
import { createLearningHook } from '../../src/cognition/NoeLearningHook.js';

function makeAdapter(reply) { return { chat: async () => ({ reply }) }; }
// 生产形态 mock（治三方 C6 假绿）：commit 返回 {ok, memory:{id}}（非裸 id），recall 带 project 维度。
function makeWriteGate(id = 'mem-1', ok = true) {
  const calls = [];
  return { calls, commit: (m) => { calls.push(m); return ok ? { ok: true, memory: { id } } : { ok: false, reason: 'source_evidence_required', memory: null }; } };
}
const GOAL = { source: 'surprise', id: 'g1', title: '搞明白为什么没料到：API 鉴权方式', why: '预测落空 2.3bit' };

describe('createLearningHook · mock 逻辑分支（生产形态 mock 防假绿）', () => {
  beforeEach(() => { process.env.NOE_LEARNING_HOOK = '1'; });
  afterEach(() => { delete process.env.NOE_LEARNING_HOOK; });

  it('flag OFF → null', async () => {
    delete process.env.NOE_LEARNING_HOOK;
    const hook = createLearningHook({ adapter: makeAdapter('x'), memory: { recall: () => [], get: () => null }, writeGate: makeWriteGate() });
    expect(await hook.onSurpriseGoalDone(GOAL)).toBeNull();
  });

  it('非 surprise 目标 → null', async () => {
    const hook = createLearningHook({ adapter: makeAdapter('x'), memory: { recall: () => [], get: () => null }, writeGate: makeWriteGate() });
    expect(await hook.onSurpriseGoalDone({ source: 'owner', title: 'X' })).toBeNull();
  });

  it('surprise → 具体 lesson + commit(insight+evidenceRefs) + get 命中 → persisted=true', async () => {
    const lesson = '我以为这个 API 接受 GET，实际是 POST，下次先查文档再调用';
    const memory = { recall: () => [], get: (id) => (id === 'mem-1' ? { id, body: lesson } : null) };
    const writeGate = makeWriteGate('mem-1');
    const hook = createLearningHook({ adapter: makeAdapter(lesson), memory, writeGate });
    const r = await hook.onSurpriseGoalDone(GOAL);
    expect(writeGate.calls[0]).toMatchObject({ kind: 'insight', sourceType: 'surprise_lesson' });
    expect(writeGate.calls[0].evidenceRefs).toContain('goal:g1'); // G1：带证据才能过生产 gate
    expect(writeGate.calls[0].body).toContain('POST');
    expect(r.persisted).toBe(true);
    expect(r.memId).toBe('mem-1'); // G2：memId 取自 c.memory.id
  });

  it('commit 被拒(ok:false) → persisted=false + reason=commit_rejected（G2/LH-FATAL-4：写失败显式可见）', async () => {
    const writeGate = makeWriteGate('mem-1', false);
    const hook = createLearningHook({ adapter: makeAdapter('具体 lesson 内容 xxxxx'), memory: { recall: () => [], get: () => null }, writeGate });
    const r = await hook.onSurpriseGoalDone(GOAL);
    expect(r.persisted).toBe(false);
    expect(r.reason).toBe('source_evidence_required');
  });

  it('lesson=SKIP → persisted=false 不写', async () => {
    const writeGate = makeWriteGate();
    const hook = createLearningHook({ adapter: makeAdapter('SKIP'), memory: { recall: () => [], get: () => null }, writeGate });
    const r = await hook.onSurpriseGoalDone(GOAL);
    expect(r.persisted).toBe(false);
    expect(r.reason).toBe('no_lesson');
    expect(writeGate.calls).toHaveLength(0);
  });

  it('isRelearn：同 topic 已有 surprise_lesson → 标空耗预警', async () => {
    const lesson = '另一条具体认知修正 abcdefghij';
    const related = [{ id: 'old-1', body: '旧 lesson', sourceType: 'surprise_lesson', tags: ['lesson'] }];
    const memory = { recall: () => related, get: () => ({ id: 'mem-2', body: lesson }) };
    const hook = createLearningHook({ adapter: makeAdapter(lesson), memory, writeGate: makeWriteGate('mem-2') });
    const r = await hook.onSurpriseGoalDone(GOAL);
    expect(r.isRelearn).toBe(true);
    expect(r.priorLessons).toBe(1);
  });

  it('fail-open：adapter 抛错不崩', async () => {
    const adapter = { chat: async () => { throw new Error('brain down'); } };
    const hook = createLearningHook({ adapter, memory: { recall: () => [], get: () => null }, writeGate: makeWriteGate() });
    const r = await hook.onSurpriseGoalDone(GOAL);
    expect(r.persisted).toBe(false);
  });
});

// 真 sqlite + 真 MemoryCore + 真 NoeMemoryWriteGate 端到端（治 C6：mock 假绿掩盖 G1/G2/D1 三致命）。
// 这是「learningHook 在生产 writeGate 下到底写不写得进」的铁证测试——三方实测旧版 noe_memory 行数=0。
describe('createLearningHook · 真 sqlite 端到端（生产 gate 不放水）', () => {
  let dir = null;
  beforeEach(() => { process.env.NOE_LEARNING_HOOK = '1'; });
  afterEach(() => { delete process.env.NOE_LEARNING_HOOK; close(); if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

  function realStack() {
    dir = mkdtempSync(join(tmpdir(), 'noe-learning-hook-e2e-'));
    initSqlite(join(dir, 'panel.db'));
    const memory = new MemoryCore({ logger: { warn: () => {} } });
    const auditLog = new NoeMemoryAuditLog({ db: () => getDb(), now: () => 1000 });
    // 模拟生产：requireEvidenceForAuto 默认 true（server.js:884 不传该参）
    const writeGate = new NoeMemoryWriteGate({ memory, auditLog, now: () => 1000, logger: { warn: () => {} } });
    return { memory, writeGate };
  }

  it('lesson 真写进 noe_memory（kind:insight+evidenceRefs 过生产 gate）+ persisted=true', async () => {
    const { memory, writeGate } = realStack();
    const lesson = '我以为 OAuth token 永不过期，实际 1 小时失效，下次先刷新再请求';
    const hook = createLearningHook({ adapter: makeAdapter(lesson), memory, writeGate });
    const r = await hook.onSurpriseGoalDone(GOAL);
    // 铁证：真 gate 下 noe_memory 真有行（旧版三方实测=0）
    const rows = getDb().prepare("SELECT id, body, project_id FROM noe_memory WHERE project_id='noe'").all();
    expect(rows.length).toBe(1);
    expect(rows[0].body).toContain('OAuth');
    expect(r.persisted).toBe(true); // 真 memory.get(memId) 命中
    expect(r.memId).toBe(rows[0].id);
  });

  it('反向 probe：无 evidence 的裸 fact 写不进（证明 gate 真在校验、测试没放水）', () => {
    const { writeGate } = realStack();
    const bad = writeGate.commit({ kind: 'fact', projectId: 'noe', body: '没证据的卡', confidence: 0.8 });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe('source_evidence_required');
    expect(getDb().prepare('SELECT count(*) c FROM noe_memory').get().c).toBe(0);
  });
});
