// @ts-check
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, getDb, initSqlite } from '../../src/storage/SqliteStore.js';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { NoeMemoryAuditLog } from '../../src/memory/NoeMemoryAuditLog.js';
import { NoeMemoryWriteGate } from '../../src/memory/NoeMemoryWriteGate.js';
import { textSimilarity } from '../../src/memory/NoeMemoryDedup.js';
import { createThinkLessonPersist } from '../../src/cognition/NoeThinkLessonPersist.js';

// 生产形态 commit mock：返回 {ok, memory:{id}}（非裸 id），仿 NoeMemoryWriteGate 真实契约，防假绿。
function makeWriteGate(id = 'mem-1', ok = true, reason = 'source_evidence_required') {
  const calls = [];
  return { calls, commit: (m) => { calls.push(m); return ok ? { ok: true, memory: { id } } : { ok: false, reason, memory: null }; } };
}
const fakeTimeline = { record: () => 'ep-1' };
// getDb mock：exact 命中走 .get，近重列表走 .all。
function makeDb({ exact = null, recent = [] } = {}) {
  return () => ({ prepare: () => ({ get: () => exact, all: () => recent.map((b) => ({ body: b })) }) });
}
const GOOD = '我原以为这个库要自己管冲突，实际 Letta 用 sleep-time compute 后台合并，下次直接调它的 API';
const TOPIC = 'agent memory conflict temporal knowledge';

describe('NoeThinkLessonPersist.persist · 逻辑分支（生产形态 mock 防假绿）', () => {
  it('writeGate 缺失 → no_write_gate，不抛', () => {
    const p = createThinkLessonPersist({ writeGate: null });
    expect(p.persist(GOOD, TOPIC)).toEqual({ persisted: false, reason: 'no_write_gate' });
  });

  it('太短(<15) → too_short，不 commit', () => {
    const wg = makeWriteGate();
    const p = createThinkLessonPersist({ writeGate: wg, timeline: fakeTimeline });
    expect(p.persist('短', TOPIC)).toEqual({ persisted: false, reason: 'too_short' });
    expect(wg.calls).toHaveLength(0);
  });

  it('SKIP 开头(≥15) → skip，不 commit', () => {
    const wg = makeWriteGate();
    const p = createThinkLessonPersist({ writeGate: wg, timeline: fakeTimeline });
    const r = p.persist('SKIP：这次没有任何具体的新认知修正内容', TOPIC);
    expect(r).toEqual({ persisted: false, reason: 'skip' });
    expect(wg.calls).toHaveLength(0);
  });

  it('裸 SKIP(4字) → skip 而非 too_short（三方互评修复：SKIP 判定提到长度判定前，reason 语义正确）', () => {
    const wg = makeWriteGate();
    const p = createThinkLessonPersist({ writeGate: wg, timeline: fakeTimeline });
    expect(p.persist('SKIP', TOPIC)).toEqual({ persisted: false, reason: 'skip' });
    expect(p.persist('  SKIP  ', TOPIC)).toEqual({ persisted: false, reason: 'skip' });
    expect(wg.calls).toHaveLength(0);
  });

  it('markdown/列表/引号包裹的 SKIP(**SKIP**/- SKIP/「SKIP」/> SKIP) → skip（codex 互评盲区）', () => {
    const wg = makeWriteGate();
    const p = createThinkLessonPersist({ writeGate: wg, timeline: fakeTimeline });
    for (const s of ['**SKIP**', '- SKIP', '「SKIP」', '> SKIP']) {
      expect(p.persist(s, TOPIC).reason).toBe('skip');
    }
    expect(wg.calls).toHaveLength(0);
  });

  it('timeline.record 用白名单内 type=milestone（非 insight，否则退化成 interaction——codex 互评真 bug）', () => {
    const wg = makeWriteGate();
    let recordedType = null;
    const spyTimeline = { record: (e) => { recordedType = e && e.type; return 'ep-x'; } };
    const p = createThinkLessonPersist({ writeGate: wg, timeline: spyTimeline });
    expect(p.persist(GOOD, TOPIC).persisted).toBe(true);
    expect(recordedType).toBe('milestone');
  });

  it('topic 太短(<4) → no_topic，不 commit', () => {
    const wg = makeWriteGate();
    const p = createThinkLessonPersist({ writeGate: wg, timeline: fakeTimeline });
    expect(p.persist(GOOD, 'ab')).toEqual({ persisted: false, reason: 'no_topic' });
    expect(wg.calls).toHaveLength(0);
  });

  it('正常 → commit(kind:insight/scope:insight/sourceType:learning_lesson) + 带 evidence 过 gate + persisted=true', () => {
    const wg = makeWriteGate('mem-9');
    const p = createThinkLessonPersist({ writeGate: wg, timeline: fakeTimeline });
    const r = p.persist(GOOD, TOPIC);
    expect(r).toEqual({ persisted: true, memId: 'mem-9' });
    const c = wg.calls[0];
    expect(c).toMatchObject({ kind: 'insight', scope: 'insight', sourceType: 'learning_lesson', projectId: 'noe' });
    expect(c.tags).toContain('lesson');
    expect(c.salience).toBe(4);
    expect(c.sourceEpisodeId).toBe('ep-1');
    expect(c.evidenceRefs).toContain('episode:ep-1'); // kind=insight 需 source evidence，否则真 gate 拒
    expect(c.body).toContain('Letta');
    expect(c.confidence).toBeGreaterThanOrEqual(0.35); // 高于 gate minConfidence
  });

  it('无 timeline → evidenceRefs 用 topic 兜底（仍非空，过 evidence 门）', () => {
    const wg = makeWriteGate();
    const p = createThinkLessonPersist({ writeGate: wg, timeline: null });
    const r = p.persist(GOOD, TOPIC);
    expect(r.persisted).toBe(true);
    expect(wg.calls[0].evidenceRefs.length).toBeGreaterThan(0);
    expect(wg.calls[0].evidenceRefs[0]).toContain('topic:');
  });

  it('exact-body 已存在 → exact_dup，不 commit（治灌水分母）', () => {
    const wg = makeWriteGate();
    const p = createThinkLessonPersist({ writeGate: wg, timeline: fakeTimeline, getDb: makeDb({ exact: { id: 'old' } }) });
    expect(p.persist(GOOD, TOPIC)).toEqual({ persisted: false, reason: 'exact_dup' });
    expect(wg.calls).toHaveLength(0);
  });

  it('近重(>0.9) → near_dup，不 commit', () => {
    const wg = makeWriteGate();
    const p = createThinkLessonPersist({
      writeGate: wg, timeline: fakeTimeline,
      getDb: makeDb({ recent: ['某条很相似的旧 lesson'] }),
      dedupTextSimilarity: () => 0.95,
    });
    expect(p.persist(GOOD, TOPIC)).toEqual({ persisted: false, reason: 'near_dup' });
    expect(wg.calls).toHaveLength(0);
  });

  it('近重判定 ≤0.9 → 正常落库（不误杀）', () => {
    const wg = makeWriteGate();
    const p = createThinkLessonPersist({
      writeGate: wg, timeline: fakeTimeline,
      getDb: makeDb({ recent: ['完全不同的旧卡'] }),
      dedupTextSimilarity: () => 0.3,
    });
    expect(p.persist(GOOD, TOPIC).persisted).toBe(true);
    expect(wg.calls).toHaveLength(1);
  });

  it('commit 被拒(ok:false) → persisted=false + 透出 reason（写失败显式可见，不静默吞）', () => {
    const wg = makeWriteGate('mem-1', false, 'source_evidence_required');
    const p = createThinkLessonPersist({ writeGate: wg, timeline: fakeTimeline });
    expect(p.persist(GOOD, TOPIC)).toEqual({ persisted: false, reason: 'source_evidence_required' });
  });

  it('commit 抛错 → fail-open 返回 commit_failed，不崩', () => {
    const wg = { commit: () => { throw new Error('db locked'); } };
    const p = createThinkLessonPersist({ writeGate: wg, timeline: fakeTimeline });
    const r = p.persist(GOOD, TOPIC);
    expect(r.persisted).toBe(false);
    expect(r.reason).toContain('commit_failed');
  });

  it('去重查询抛错 → fail-open 继续落库（不阻断）', () => {
    const wg = makeWriteGate();
    const p = createThinkLessonPersist({
      writeGate: wg, timeline: fakeTimeline,
      getDb: () => { throw new Error('db gone'); },
    });
    expect(p.persist(GOOD, TOPIC).persisted).toBe(true);
  });
});

// 端到端集成（真 SqliteStore + 真 MemoryCore + 真 NoeMemoryWriteGate，临时库不碰生产）：
//   证明断点2 修复——深思认知修正真过 gate(kind:insight)落库、且对话召回器能按主题召回。防 mock 假绿。
describe('NoeThinkLessonPersist · 真库端到端（落库→可召回，断点2 闭环硬证据）', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'noe-p1-tll-')); initSqlite(join(dir, 't.db')); });
  afterEach(() => { try { close(); } catch { /* ignore */ } rmSync(dir, { recursive: true, force: true }); });

  function makePersist() {
    const memory = new MemoryCore({});
    const gate = new NoeMemoryWriteGate({ memory, auditLog: new NoeMemoryAuditLog({ db: getDb }) });
    const p = createThinkLessonPersist({ writeGate: gate, getDb, dedupTextSimilarity: textSimilarity, timeline: { record: () => `ep-${Math.floor(0)}` } });
    return { memory, persist: p.persist };
  }

  it('真过 gate(kind:insight) 落库 + MemoryCore 按主题召回到 learning_lesson', () => {
    const { memory, persist } = makePersist();
    const r = persist('我原以为记忆冲突要自己处理，实际 Letta 用 sleep-time compute 后台合并，下次直接调它的 reconcile API', 'agent memory conflict reconcile');
    expect(r.persisted).toBe(true);
    expect(r.memId).toBeTruthy();
    const recalled = memory.recall({ projectId: 'noe', q: 'memory conflict reconcile', limit: 5, bumpHits: false });
    expect(recalled.some((m) => String(m.sourceType || m.source_type) === 'learning_lesson')).toBe(true);
  });

  it('exact-body 去重在真库生效：同 lesson 写两次只入库一张', () => {
    const { persist } = makePersist();
    const lesson = '我学到 Graphiti 用 bi-temporal 模型存知识，事实有有效期和记录期两个时间轴，查询要带 as_of 时间点';
    const r1 = persist(lesson, 'temporal knowledge graph');
    const r2 = persist(lesson, 'temporal knowledge graph');
    expect(r1.persisted).toBe(true);
    expect(r2).toEqual({ persisted: false, reason: 'exact_dup' });
  });
});
