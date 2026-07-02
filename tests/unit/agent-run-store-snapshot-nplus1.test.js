// @ts-check
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRunStore } from '../../src/agents/AgentRunStore.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'noe-agent-runs-nplus1-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

// 用计数代理包住底层 audit.list，统计“全量近期审计”查询（无 entityType/entityId、limit:1000）次数。
function instrumentAudit(store) {
  const realList = store.audit.list.bind(store.audit);
  const calls = { total: 0, recent: 0, byRunId: 0 };
  store.audit.list = (query = {}) => {
    calls.total += 1;
    const isRecent = !query.entityType && !query.entityId && !query.sessionId && Number(query.limit) === 1000;
    const isByRun = query.entityType === 'agent_run' && !!query.entityId;
    if (isRecent) calls.recent += 1;
    if (isByRun) calls.byRunId += 1;
    return realList(query);
  };
  return { calls, restore: () => { store.audit.list = realList; } };
}

function seedSessionRuns(store, sessionId, count) {
  const runs = [];
  for (let i = 0; i < count; i += 1) {
    const run = store.create({
      roomId: 'room-snap',
      sessionId,
      taskId: `task-${i}`,
      agentProfileId: 'xike-builder',
      status: 'running',
    });
    store.appendMessage(run.id, { kind: 'decision', role: 'agent', summary: `decision ${i}` });
    store.appendToolResult(run.id, { toolName: 'npm test', status: 'passed', outputSummary: `ok ${i}` });
    // 给每个 run 关联一条跨实体审计事件（走 recentEvents 通道才能命中），
    // 验证合并后仍能正确按 run 归并各自的事件。
    store.audit.recordSafe({
      action: 'approval.created',
      entityType: 'approval',
      entityId: `approval-${i}`,
      status: 'pending',
      sessionId,
      details: { agentRunId: run.id, approvalId: `approval-${i}` },
    });
    store.transition(run.id, 'succeeded', { reason: 'verified' });
    runs.push(run);
  }
  return runs;
}

describe('AgentRunStore.getSessionSnapshot N+1 audit query', () => {
  it('collapses the per-run "recent activity" full scan into one batched query', () => {
    const store = new AgentRunStore({ logger: null });
    const sessionId = 'session-nplus1';
    const RUN_COUNT = 12;
    seedSessionRuns(store, sessionId, RUN_COUNT);

    const { calls, restore } = instrumentAudit(store);
    const snapshot = store.getSessionSnapshot(sessionId);
    restore();

    expect(snapshot).toBeTruthy();
    expect(snapshot.counts.runs).toBe(RUN_COUNT);

    // 核心断言：原实现每个 run 各拉一次“全量近期审计”=> RUN_COUNT 次；
    // 优化后整次 snapshot 只拉 1 次（getSessionSnapshot 不再单独拉 recent，由共享 cache 承担）。
    expect(calls.recent).toBe(1);
    // 直接按 run 维度的查询仍是每 run 一次（带索引、廉价、保持精确归并）。
    expect(calls.byRunId).toBe(RUN_COUNT);
  });

  it('keeps snapshot result equivalent: every run + its related events are present and sorted', () => {
    const store = new AgentRunStore({ logger: null });
    const sessionId = 'session-equiv';
    const RUN_COUNT = 6;
    const runs = seedSessionRuns(store, sessionId, RUN_COUNT);

    const snapshot = store.getSessionSnapshot(sessionId);
    expect(snapshot.counts.runs).toBe(RUN_COUNT);
    expect(snapshot.counts.messages).toBe(RUN_COUNT);
    expect(snapshot.counts.toolResults).toBe(RUN_COUNT);

    // 每个 run 的 id 都在
    const snapRunIds = snapshot.runs.map((r) => r.id).sort();
    expect(snapRunIds).toEqual(runs.map((r) => r.id).sort());

    // 每个 run 关联的 approval 事件都被正确归并进 activityEvents（证明 recent 合并未丢/未错配）
    const actions = snapshot.activityEvents.map((e) => e.action);
    for (let i = 0; i < RUN_COUNT; i += 1) {
      expect(actions).toContain('approval.created');
    }
    const approvalEntities = snapshot.activityEvents
      .filter((e) => e.entityType === 'approval')
      .map((e) => e.entityId)
      .sort();
    expect(approvalEntities).toEqual(runs.map((_, i) => `approval-${i}`).sort());

    // activityEvents 升序（ts/createdAt 单调不减）——排序行为与原实现一致
    const ts = snapshot.activityEvents.map((e) => Number(e.ts || e.createdAt || 0));
    for (let i = 1; i < ts.length; i += 1) {
      expect(ts[i]).toBeGreaterThanOrEqual(ts[i - 1]);
    }
  });

  it('cached vs uncached getTimeline produce identical activityEvents (per-run equivalence)', () => {
    const store = new AgentRunStore({ logger: null });
    const sessionId = 'session-cache-eq';
    const runs = seedSessionRuns(store, sessionId, 4);

    for (const run of runs) {
      const uncached = store.getTimeline(run.id); // 默认单 run 路径（无 cache）
      const cached = store.getTimeline(run.id, { recentEvents: store.audit.list({ order: 'ASC', limit: 1000 }) });
      // 关联事件集合（按 id 排序后）应完全一致
      const ids = (tl) => (tl.activityEvents || []).map((e) => e.id).sort();
      expect(ids(cached)).toEqual(ids(uncached));
      expect(cached.activityEvents.map((e) => e.action).sort())
        .toEqual(uncached.activityEvents.map((e) => e.action).sort());
    }
  });

  it('snapshot still works when audit.list is unavailable (no cache crash)', () => {
    const store = new AgentRunStore({ logger: null, audit: {} });
    const sessionId = 'session-no-audit';
    // 不能用 seed（依赖 recordSafe），直接建最小 run
    store.audit = {}; // 无 list / 无 recordSafe
    const run = store.create({ roomId: 'r', sessionId, status: 'running' });
    store.appendMessage(run.id, { kind: 'decision', role: 'agent', summary: 'x' });
    const snapshot = store.getSessionSnapshot(sessionId);
    expect(snapshot.counts.runs).toBe(1);
    expect(Array.isArray(snapshot.activityEvents)).toBe(true);
  });
});
