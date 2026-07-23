import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildClusterEngineeringTaskList,
  buildPriorStageContext,
  buildClusterAcceptanceReport,
  buildClusterRetrospectiveReport,
  buildClusterWorkflowAudit,
  buildClusterDeliveryManifest,
  buildClusterDeliveryPackage,
  buildClusterObjectiveCompletionAudit,
  buildClusterStageArtifact,
  buildClusterRuntimeState,
  isolateClusterNativeCapabilities,
  CLUSTER_ENGINEERING_STAGES,
  CrossVerifyDispatcher,
  prepareGoalModeDeliveryRework,
  prepareGoalModeStageRework,
  recoverDroppedMembersForResume,
  recoverStartupTimeoutMembers,
} from '../../src/room/CrossVerifyDispatcher.js';
import { CodexSpawnAdapter } from '../../src/room/CodexSpawnAdapter.js';
import { ClaudeSpawnAdapter } from '../../src/room/ClaudeSpawnAdapter.js';
import { GeminiSpawnAdapter } from '../../src/room/GeminiSpawnAdapter.js';

// 集群协同:2+ 成员显式签字。单测覆盖 ack 解析容错 + 一致达成 + 不一致升级。

const makeStubAdapter = (replies) => {
  let i = 0;
  return {
    id: 'stub-' + Math.random().toString(36).slice(2, 8),
    displayName: 'Stub',
    async chat() {
      const reply = replies[i % replies.length];
      i++;
      return { reply, tokensIn: 1, tokensOut: 1 };
    },
  };
};

const makeRecordingAdapter = (id, prompts) => ({
  id,
  displayName: id,
  async chat(messages) {
    const prompt = messages[messages.length - 1]?.content || '';
    prompts.push(prompt);
    if (prompt.includes('评审输出')) {
      return { reply: JSON.stringify({ agree: true, reasoning: '同意', suggestions: [], critical_issues: [] }), tokensIn: 1, tokensOut: 1 };
    }
    return { reply: `# ${id} 方案\nFIRST_STAGE_CONSENSUS_MARKER\nnpm test -- tests/unit/example.test.js\n### 文件落地验证\ncat src/example.js`, tokensIn: 1, tokensOut: 1 };
  },
});

const makeStore = () => ({
  _rooms: new Map(),
  get(id) { return this._rooms.get(id); },
  update(id, patch) { const r = this._rooms.get(id); if (r) Object.assign(r, patch); return r; },
  setStatus(id, status) { const r = this._rooms.get(id); if (r) r.status = status; return r; },
  flush() {},
});

const makeFakeAgentRunStore = () => ({
  _runs: new Map(),
  _toolResults: new Map(),
  _seq: 0,
  create(input = {}) {
    this._seq += 1;
    const run = {
      id: `fake-agent-run-${this._seq}`,
      status: 'running',
      roomId: input.roomId || '',
      taskId: input.taskId || '',
      adapterId: input.adapterId || '',
      sourceType: input.sourceType || '',
    };
    this._runs.set(run.id, run);
    this._toolResults.set(run.id, []);
    return run;
  },
  appendToolResult(runId, input = {}) {
    const item = { id: `${runId}-tool-${this._toolResults.get(runId)?.length || 0}`, ...input };
    this._toolResults.get(runId)?.push(item);
    return item;
  },
  transition(runId, status, details = {}) {
    const run = this._runs.get(runId);
    if (run) Object.assign(run, { status, details });
    return run;
  },
  getTimeline(runId) {
    return {
      run: this._runs.get(runId),
      toolResults: this._toolResults.get(runId) || [],
      archives: [],
      artifacts: [],
    };
  },
});

const makeSingleTaskList = () => [{
  id: 'T1',
  title: '单任务',
  desc: '单任务',
  rounds: [],
  status: 'pending',
}];

const waitForCondition = async (condition, timeoutMs = 1000) => {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitForCondition timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('CrossVerifyDispatcher', () => {
  let store, broadcasts;
  beforeEach(() => { store = makeStore(); broadcasts = []; });

  it('目标模式:交付门禁未通过时重置代码驱动阶段和验收阶段继续返工', () => {
    const taskList = buildClusterEngineeringTaskList('做一个可运行游戏');
    for (const task of taskList) {
      task.status = 'done';
      task.consensus = { finalPlan: 'done', stageArtifact: { evidence: [], gates: [{ status: 'passed' }], signoffs: [{ agree: true }, { agree: true }] } };
      task.stageArtifact = task.consensus.stageArtifact;
    }
    const rework = prepareGoalModeDeliveryRework({
      taskList,
      topic: '做一个可运行游戏',
      goalMode: { enabled: true, lastReworkDigest: 'not-this-one', repeatedBlockerCount: 3 },
      manifest: {
        deliveryGate: {
          status: 'blocked',
          blockers: ['agent_run_evidence_incomplete=0/4'],
          failedStages: [],
          evidenceInsufficientStages: [],
          incompleteStages: [],
          signoffIncompleteStages: [],
        },
      },
    });

    expect(rework).toMatchObject({
      reason: expect.stringContaining('目标模式第 1 次自动返工'),
      targetStageIds: expect.arrayContaining(['implementation', 'unit_test', 'integration_test', 'functional_validation', 'acceptance', 'retrospective']),
      goalMode: { enabled: true, deliveryReworks: 1, repeatedBlockerCount: 1 },
    });
    expect(taskList.find((task) => task.stageId === 'idea').status).toBe('done');
    expect(taskList.find((task) => task.stageId === 'implementation')).toMatchObject({
      status: 'pending',
      blocking: false,
      qualityGateRepairs: 0,
    });
    expect(taskList.find((task) => task.stageId === 'implementation').consensus).toBeUndefined();
    expect(taskList.find((task) => task.stageId === 'acceptance').status).toBe('pending');
  });

  it('目标模式:相同 blocker 重复出现时把重复次数写入返工反馈', () => {
    const taskList = buildClusterEngineeringTaskList('做一个可运行游戏');
    for (const task of taskList) task.status = 'done';
    const manifest = {
      deliveryGate: {
        status: 'blocked',
        blockers: ['agent_run_evidence_incomplete=0/4'],
        failedStages: [],
        evidenceInsufficientStages: [],
        incompleteStages: [],
        signoffIncompleteStages: [],
      },
    };
    const first = prepareGoalModeDeliveryRework({
      taskList,
      topic: '做一个可运行游戏',
      goalMode: { enabled: true },
      manifest,
    });
    const second = prepareGoalModeDeliveryRework({
      taskList,
      topic: '做一个可运行游戏',
      goalMode: first.goalMode,
      manifest,
    });

    expect(second.goalMode.repeatedBlockerCount).toBe(2);
    expect(second.reason).toContain('同一组阻断第 2 次出现');
    expect(taskList.find((task) => task.stageId === 'implementation').qualityGateFeedback).toContain('必须改变策略');
  });

  it('目标模式:阶段轮数耗尽或输出不完整导致阻断时重置该阶段继续跑', () => {
    const taskList = buildClusterEngineeringTaskList('做一个可运行游戏');
    const blockedTask = taskList.find((task) => task.stageId === 'implementation');
    blockedTask.status = 'escalated';
    blockedTask.blocking = true;
    blockedTask.escalateReason = '3 轮集群未达成一致,需用户裁定';
    blockedTask.consensus = { finalPlan: 'incomplete' };
    const rework = prepareGoalModeStageRework({
      taskList,
      blockedTask,
      topic: '做一个可运行游戏',
      goalMode: { enabled: true },
    });

    expect(rework).toMatchObject({
      reason: expect.stringContaining('不允许因轮数/输出上限停止'),
      restartIndex: blockedTask.stageIndex - 1,
      goalMode: { enabled: true, stageReworks: 1 },
    });
    expect(blockedTask.status).toBe('pending');
    expect(blockedTask.blocking).toBe(false);
    expect(blockedTask.consensus).toBeUndefined();
    expect(blockedTask.qualityGateFeedback).toContain('目标模式第 1 次阶段返工');
  });

  it('实例化:必备方法 start/abort/resume', () => {
    const d = new CrossVerifyDispatcher({ store, adapters: new Map(), broadcast: () => {} });
    expect(typeof d.start).toBe('function');
    expect(typeof d.abort).toBe('function');
    expect(typeof d.resume).toBe('function');
  });

  it('dispatcher 内部拒绝同房间 activeAborts 残留时的第二条启动流', async () => {
    const adapterA = makeRecordingAdapter('active-a', []);
    const adapterB = makeRecordingAdapter('active-b', []);
    store._rooms.set('cv-active-abort-guard', {
      id: 'cv-active-abort-guard',
      mode: 'cross_verify',
      status: 'idle',
      cwd: '/tmp',
      members: [{ adapterId: adapterA.id, enabled: true }, { adapterId: adapterB.id, enabled: true }],
      taskList: makeSingleTaskList(),
    });
    const d = new CrossVerifyDispatcher({
      store,
      adapters: new Map([[adapterA.id, adapterA], [adapterB.id, adapterB]]),
      broadcast: (id, msg) => broadcasts.push({ roomId: id, ...msg }),
    });
    d.activeAborts.set('cv-active-abort-guard', new AbortController());

    await expect(d.start('cv-active-abort-guard', '重复启动')).rejects.toThrow(/room already running/);

    expect(store._rooms.get('cv-active-abort-guard').status).toBe('idle');
    expect(store._rooms.get('cv-active-abort-guard').taskList[0].status).toBe('pending');
    expect(broadcasts).toEqual([]);
  });

  it('dispatcher 会清理已 aborted 的 activeAborts 残留并允许重新启动', async () => {
    const prompts = [];
    const adapterA = makeRecordingAdapter('stale-a', prompts);
    const adapterB = makeRecordingAdapter('stale-b', prompts);
    store._rooms.set('cv-stale-active-abort', {
      id: 'cv-stale-active-abort',
      mode: 'cross_verify',
      status: 'idle',
      cwd: '/tmp',
      members: [{ adapterId: adapterA.id, enabled: true }, { adapterId: adapterB.id, enabled: true }],
      taskList: makeSingleTaskList(),
    });
    const d = new CrossVerifyDispatcher({
      store,
      adapters: new Map([[adapterA.id, adapterA], [adapterB.id, adapterB]]),
      broadcast: (id, msg) => broadcasts.push({ roomId: id, ...msg }),
    });
    const staleAborter = new AbortController();
    staleAborter.abort();
    d.activeAborts.set('cv-stale-active-abort', staleAborter);

    await d.start('cv-stale-active-abort', '恢复启动');

    expect(store._rooms.get('cv-stale-active-abort').status).toBe('done');
    expect(d.activeAborts.has('cv-stale-active-abort')).toBe(false);
    expect(prompts.length).toBeGreaterThan(0);
    expect(broadcasts.some((msg) => msg.type === 'cross_verify_done')).toBe(true);
  });

  it('正常完成会立即落盘 done 终态', async () => {
    const adapterA = makeRecordingAdapter('done-a', []);
    const adapterB = makeRecordingAdapter('done-b', []);
    store._rooms.set('cv-done-flush', {
      id: 'cv-done-flush',
      mode: 'cross_verify',
      status: 'idle',
      cwd: '/tmp',
      members: [{ adapterId: adapterA.id, enabled: true }, { adapterId: adapterB.id, enabled: true }],
      taskList: makeSingleTaskList(),
    });
    store.flush = vi.fn();
    const d = new CrossVerifyDispatcher({
      store,
      adapters: new Map([[adapterA.id, adapterA], [adapterB.id, adapterB]]),
      broadcast: (id, msg) => broadcasts.push({ roomId: id, ...msg }),
    });

    await d.start('cv-done-flush', '完成后立即落盘');

    expect(store._rooms.get('cv-done-flush').status).toBe('done');
    expect(store.flush).toHaveBeenCalled();
    expect(broadcasts.some((msg) => msg.type === 'cross_verify_done')).toBe(true);
  });

  it('没有可用成员进入 error 时立即落盘', async () => {
    store._rooms.set('cv-no-member-error-flush', {
      id: 'cv-no-member-error-flush',
      mode: 'cross_verify',
      status: 'idle',
      cwd: '/tmp',
      members: [{ adapterId: 'missing', enabled: false }],
      taskList: makeSingleTaskList(),
    });
    store.flush = vi.fn();
    const d = new CrossVerifyDispatcher({
      store,
      adapters: new Map(),
      broadcast: (id, msg) => broadcasts.push({ roomId: id, ...msg }),
    });

    await expect(d.start('cv-no-member-error-flush', '无可用成员')).rejects.toThrow(/至少需要 1 个可用成员/);

    expect(store._rooms.get('cv-no-member-error-flush').status).toBe('error');
    expect(store.flush).toHaveBeenCalled();
    expect(broadcasts.some((msg) => msg.type === 'cross_verify_error')).toBe(true);
  });

  it('允许多个不同房间同时运行集群协同,不使用全局单房间运行锁', async () => {
    const ack = JSON.stringify({ agree: true, reasoning: '同意', suggestions: [], critical_issues: [] });
    let releaseProposals;
    const proposalGate = new Promise((resolve) => { releaseProposals = resolve; });
    const proposalCalls = [];
    const makeConcurrentAdapter = (id) => ({
      id,
      displayName: id,
      async chat(messages, opts = {}) {
        const prompt = messages[messages.length - 1]?.content || '';
        if (prompt.includes('评审输出')) return { reply: ack, tokensIn: 1, tokensOut: 1 };
        proposalCalls.push({ adapterId: id, roomId: opts.budgetContext?.roomId });
        await proposalGate;
        if (opts.abortSignal?.aborted) throw new Error(`${id} aborted`);
        return { reply: `# ${id} ${opts.budgetContext?.roomId} 方案\n本步未写文件`, tokensIn: 1, tokensOut: 1 };
      },
    });
    const adapterA = makeConcurrentAdapter('parallel-a');
    const adapterB = makeConcurrentAdapter('parallel-b');
    store._rooms.set('cv-parallel-1', {
      id: 'cv-parallel-1',
      mode: 'cross_verify',
      cwd: '/tmp',
      members: [{ adapterId: adapterA.id, enabled: true }, { adapterId: adapterB.id, enabled: true }],
      taskList: makeSingleTaskList(),
    });
    store._rooms.set('cv-parallel-2', {
      id: 'cv-parallel-2',
      mode: 'cross_verify',
      cwd: '/tmp',
      members: [{ adapterId: adapterA.id, enabled: true }, { adapterId: adapterB.id, enabled: true }],
      taskList: makeSingleTaskList(),
    });
    const d = new CrossVerifyDispatcher({
      store,
      adapters: new Map([[adapterA.id, adapterA], [adapterB.id, adapterB]]),
      broadcast: (id, msg) => broadcasts.push({ roomId: id, ...msg }),
    });

    const run1 = d.start('cv-parallel-1', '并发任务 1');
    const run2 = d.start('cv-parallel-2', '并发任务 2');
    await waitForCondition(() => proposalCalls.length === 4);

    expect(store._rooms.get('cv-parallel-1').status).toBe('running');
    expect(store._rooms.get('cv-parallel-2').status).toBe('running');
    expect(d.activeAborts.has('cv-parallel-1')).toBe(true);
    expect(d.activeAborts.has('cv-parallel-2')).toBe(true);
    expect(new Set(proposalCalls.map((item) => item.roomId))).toEqual(new Set(['cv-parallel-1', 'cv-parallel-2']));

    releaseProposals();
    await Promise.all([run1, run2]);

    expect(store._rooms.get('cv-parallel-1').status).toBe('done');
    expect(store._rooms.get('cv-parallel-2').status).toBe('done');
    expect(broadcasts.filter((msg) => msg.type === 'cross_verify_start')).toHaveLength(2);
    expect(broadcasts.filter((msg) => msg.type === 'cross_verify_done')).toHaveLength(2);
  });

  it('中断一个运行中的集群协同房间不会中断其他并行房间', async () => {
    const ack = JSON.stringify({ agree: true, reasoning: '同意', suggestions: [], critical_issues: [] });
    let releaseProposals;
    const proposalGate = new Promise((resolve) => { releaseProposals = resolve; });
    const proposalCalls = [];
    const makeConcurrentAdapter = (id) => ({
      id,
      displayName: id,
      async chat(messages, opts = {}) {
        const prompt = messages[messages.length - 1]?.content || '';
        if (prompt.includes('评审输出')) return { reply: ack, tokensIn: 1, tokensOut: 1 };
        proposalCalls.push({ adapterId: id, roomId: opts.budgetContext?.roomId });
        await proposalGate;
        if (opts.abortSignal?.aborted) throw new Error(`${id} aborted`);
        return { reply: `# ${id} ${opts.budgetContext?.roomId} 方案\n本步未写文件`, tokensIn: 1, tokensOut: 1 };
      },
    });
    const adapterA = makeConcurrentAdapter('isolated-a');
    const adapterB = makeConcurrentAdapter('isolated-b');
    store._rooms.set('cv-abort-isolated-1', {
      id: 'cv-abort-isolated-1',
      mode: 'cross_verify',
      cwd: '/tmp',
      members: [{ adapterId: adapterA.id, enabled: true }, { adapterId: adapterB.id, enabled: true }],
      taskList: makeSingleTaskList(),
    });
    store._rooms.set('cv-abort-isolated-2', {
      id: 'cv-abort-isolated-2',
      mode: 'cross_verify',
      cwd: '/tmp',
      members: [{ adapterId: adapterA.id, enabled: true }, { adapterId: adapterB.id, enabled: true }],
      taskList: makeSingleTaskList(),
    });
    const d = new CrossVerifyDispatcher({
      store,
      adapters: new Map([[adapterA.id, adapterA], [adapterB.id, adapterB]]),
      broadcast: (id, msg) => broadcasts.push({ roomId: id, ...msg }),
    });

    const run1 = d.start('cv-abort-isolated-1', '会被中断的任务');
    const run2 = d.start('cv-abort-isolated-2', '继续运行的任务');
    await waitForCondition(() => proposalCalls.length === 4);

    expect(d.abort('cv-abort-isolated-1')).toBe(true);
    expect(d.activeAborts.has('cv-abort-isolated-2')).toBe(true);

    releaseProposals();
    await Promise.all([run1, run2]);

    expect(store._rooms.get('cv-abort-isolated-1').status).toBe('paused');
    expect(store._rooms.get('cv-abort-isolated-2').status).toBe('done');
    expect(broadcasts.some((msg) => msg.roomId === 'cv-abort-isolated-1' && msg.type === 'cross_verify_paused')).toBe(true);
    expect(broadcasts.some((msg) => msg.roomId === 'cv-abort-isolated-2' && msg.type === 'cross_verify_done')).toBe(true);
  });

  it('续跑时会把服务重启残留的 running 任务转回可执行状态', async () => {
    const prompts = [];
    const adapterA = makeRecordingAdapter('a', prompts);
    const adapterB = makeRecordingAdapter('b', prompts);
    const taskList = makeSingleTaskList();
    taskList[0].status = 'running';
    store._rooms.set('cv-stale-running-resume', {
      id: 'cv-stale-running-resume',
      mode: 'cross_verify',
      status: 'paused',
      topic: '恢复旧任务',
      members: [{ adapterId: 'a', enabled: true }, { adapterId: 'b', enabled: true }],
      taskList,
    });
    const d = new CrossVerifyDispatcher({
      store,
      adapters: new Map([['a', adapterA], ['b', adapterB]]),
      broadcast: (id, msg) => broadcasts.push({ roomId: id, ...msg }),
    });

    await d.resume('cv-stale-running-resume', { goalMode: true });

    const room = store._rooms.get('cv-stale-running-resume');
    expect(room.status).toBe('done');
    expect(room.goalMode).toMatchObject({ enabled: true });
    expect(prompts.some((prompt) => prompt.includes('上次运行在服务重启/中断时停留在 running 状态'))).toBe(true);
  });

  it('自动续跑会遵守停滞恢复限流,但不阻断人工续跑', async () => {
    const prompts = [];
    const adapterA = makeRecordingAdapter('resume-a', prompts);
    const adapterB = makeRecordingAdapter('resume-b', prompts);
    const taskList = makeSingleTaskList();
    store._rooms.set('cv-auto-resume-policy', {
      id: 'cv-auto-resume-policy',
      mode: 'cross_verify',
      status: 'paused',
      topic: '恢复被限流任务',
      members: [{ adapterId: 'resume-a', enabled: true }, { adapterId: 'resume-b', enabled: true }],
      taskList,
      clusterRuntimeResumePolicy: {
        statusVersion: 'cluster-runtime-resume-policy-v1',
        autoResumeAllowed: false,
        manualResumeAllowed: true,
        stallRecoveryCount: 3,
        maxStallRecoveries: 3,
        nextAction: 'manual_review_required_before_resume',
      },
    });
    const d = new CrossVerifyDispatcher({
      store,
      adapters: new Map([['resume-a', adapterA], ['resume-b', adapterB]]),
      broadcast: (id, msg) => broadcasts.push({ roomId: id, ...msg }),
    });

    await expect(d.resume('cv-auto-resume-policy', { autoResume: true })).rejects.toMatchObject({
      code: 'cluster_auto_resume_blocked',
    });

    await d.resume('cv-auto-resume-policy');

    expect(store._rooms.get('cv-auto-resume-policy').status).toBe('done');
    expect(prompts.length).toBeGreaterThan(0);
  });

  it('人工续跑会恢复曾经全部掉线的成员,避免 dropped 记录永久卡死房间', async () => {
    const prompts = [];
    const adapterA = makeRecordingAdapter('recover-a', prompts);
    const adapterB = makeRecordingAdapter('recover-b', prompts);
    store._rooms.set('cv-recover-all-dropped', {
      id: 'cv-recover-all-dropped',
      mode: 'cross_verify',
      status: 'paused',
      topic: '恢复所有成员掉线的任务',
      cwd: '/tmp',
      members: [
        { adapterId: 'recover-a', enabled: true },
        { adapterId: 'recover-b', enabled: true },
      ],
      taskList: makeSingleTaskList(),
      clusterDroppedMembers: [
        { adapterId: 'recover-a', memberKey: 'recover-a#1', memberIndex: 1, recoverable: false, reason: 'timeout' },
        { adapterId: 'recover-b', memberKey: 'recover-b#2', memberIndex: 2, recoverable: false, reason: 'quota' },
      ],
    });
    const d = new CrossVerifyDispatcher({
      store,
      adapters: new Map([[adapterA.id, adapterA], [adapterB.id, adapterB]]),
      broadcast: (id, msg) => broadcasts.push({ roomId: id, ...msg }),
    });

    await d.resume('cv-recover-all-dropped');

    const room = store._rooms.get('cv-recover-all-dropped');
    expect(room.status).toBe('done');
    expect(room.clusterDroppedMembers.every((item) => item.recoverable === true)).toBe(true);
    expect(room.clusterMemberRecoveryEvents).toHaveLength(1);
    expect(room.clusterMemberRecoveryEvents[0]).toMatchObject({
      reason: 'manual_resume_all_members_previously_dropped',
      recoveredAdapterIds: ['recover-a', 'recover-b'],
    });
    expect(broadcasts.some((msg) => msg.type === 'cv_dropped_members_recovered')).toBe(true);
    expect(prompts.length).toBeGreaterThan(0);
  });

  it('recoverDroppedMembersForResume 只有在 dropped 记录导致无成员可用时才恢复', () => {
    const room = {
      members: [
        { adapterId: 'recover-a', enabled: true },
        { adapterId: 'recover-b', enabled: true },
      ],
      clusterDroppedMembers: [
        { adapterId: 'recover-a', memberKey: 'recover-a#1', memberIndex: 1, recoverable: false },
      ],
    };

    expect(recoverDroppedMembersForResume(room, { resume: true }).changed).toBe(false);
    expect(recoverDroppedMembersForResume({
      ...room,
      clusterDroppedMembers: [
        ...room.clusterDroppedMembers,
        { adapterId: 'recover-b', memberKey: 'recover-b#2', memberIndex: 2, recoverable: false },
      ],
    }, { resume: true })).toMatchObject({
      changed: true,
      recoveredAdapterIds: ['recover-a', 'recover-b'],
    });
  });

  it('运行中预算超过硬阈值时记录阻断并暂停房间', () => {
    store._rooms.set('cv-runtime-budget', {
      id: 'cv-runtime-budget',
      mode: 'cross_verify',
      status: 'running',
      clusterRuntimeTelemetry: null,
    });
    const d = new CrossVerifyDispatcher({
      store,
      adapters: new Map(),
      broadcast: (id, msg) => broadcasts.push({ roomId: id, ...msg }),
      runtimeBudgetLimits: {
        warnCalls: 1,
        blockCalls: 2,
        warnTokens: 5,
        blockTokens: 10,
        warnAvgLatencyMs: 1000,
        blockAvgLatencyMs: 2000,
      },
    });
    store.flush = vi.fn();
    const aborter = new AbortController();
    d.activeAborts.set('cv-runtime-budget', aborter);

    d._recordRuntimeMetric('cv-runtime-budget', {
      adapterId: 'codex',
      status: 'succeeded',
      tokensIn: 8,
      tokensOut: 5,
      latencyMs: 100,
      taskId: 'CE05',
      turn: 'propose-1-r1',
    });

    const room = store._rooms.get('cv-runtime-budget');
    expect(room.status).toBe('paused');
    expect(aborter.signal.aborted).toBe(true);
    expect(room.clusterRuntimeBudgetStatus).toMatchObject({
      statusVersion: 'cluster-runtime-budget-status-v1',
      status: 'blocked',
      blockers: ['tokens_gt_10'],
    });
    expect(store.flush).toHaveBeenCalled();
    expect(broadcasts.some((msg) => msg.type === 'cluster_runtime_budget' && msg.status === 'blocked')).toBe(true);
    expect(broadcasts.some((msg) => msg.type === 'cross_verify_paused' && msg.reason === 'runtime_budget_blocked')).toBe(true);
  });

  it('abort 用户中断会立即落盘 paused 状态', () => {
    store._rooms.set('cv-abort-flush', {
      id: 'cv-abort-flush',
      mode: 'cross_verify',
      status: 'running',
      taskList: makeSingleTaskList(),
    });
    store.flush = vi.fn();
    const d = new CrossVerifyDispatcher({
      store,
      adapters: new Map(),
      broadcast: (id, msg) => broadcasts.push({ roomId: id, ...msg }),
    });
    d.activeAborts.set('cv-abort-flush', new AbortController());

    expect(d.abort('cv-abort-flush')).toBe(true);

    expect(store._rooms.get('cv-abort-flush').status).toBe('paused');
    expect(store.flush).toHaveBeenCalled();
    expect(broadcasts.some((msg) => msg.type === 'cross_verify_paused' && msg.reason === 'user_abort')).toBe(true);
  });

  it('运行期写入心跳,供 watchdog 判定房间是否真实推进', async () => {
    const prompts = [];
    const adapterA = makeRecordingAdapter('heartbeat-a', prompts);
    const adapterB = makeRecordingAdapter('heartbeat-b', prompts);
    store._rooms.set('cv-heartbeat', {
      id: 'cv-heartbeat',
      mode: 'cross_verify',
      cwd: '/tmp',
      members: [{ adapterId: 'heartbeat-a', enabled: true }, { adapterId: 'heartbeat-b', enabled: true }],
      taskList: makeSingleTaskList(),
    });
    const d = new CrossVerifyDispatcher({
      store,
      adapters: new Map([['heartbeat-a', adapterA], ['heartbeat-b', adapterB]]),
      broadcast: (id, msg) => broadcasts.push({ roomId: id, ...msg }),
    });

    await d.start('cv-heartbeat', '验证运行心跳');

    const heartbeat = store._rooms.get('cv-heartbeat').clusterRuntimeHeartbeat;
    expect(heartbeat).toMatchObject({
      statusVersion: 'cluster-runtime-heartbeat-v1',
      lastEvent: 'done',
      topic: '验证运行心跳',
    });
    expect(Number.isFinite(Date.parse(heartbeat.startedAt))).toBe(true);
    expect(Number.isFinite(Date.parse(heartbeat.lastProgressAt))).toBe(true);
    expect(prompts.length).toBeGreaterThan(0);
  });

  it('运行态快照会把 running 房间里的旧交付报告标记为 stale', () => {
    const state = buildClusterRuntimeState({
      status: 'running',
      taskList: [{ id: 'CE02', stageId: 'requirements', stageLabel: '需求分析与拆解', status: 'running' }],
      clusterDeliveryPackage: { status: 'blocked', readyForArchive: false },
      clusterDeliveryReportMarkdown: '# old blocked report',
      clusterRuntimeHeartbeat: {
        lastEvent: 'review_start',
        taskId: 'CE02',
        stageId: 'requirements',
        round: 2,
      },
    }, { event: 'unit_test' });

    expect(state).toMatchObject({
      statusVersion: 'cluster-runtime-state-v1',
      event: 'unit_test',
      roomStatus: 'running',
      phase: 'running',
      isRunning: true,
      canStart: false,
      taskSummary: {
        total: 1,
        counts: { running: 1 },
        activeTaskId: 'CE02',
        activeStageId: 'requirements',
      },
      delivery: {
        present: true,
        stale: true,
      },
    });
  });

  it('正常完成会落盘统一运行态快照,UI 可从单一来源判断终态', async () => {
    const adapterA = makeRecordingAdapter('runtime-state-a', []);
    const adapterB = makeRecordingAdapter('runtime-state-b', []);
    store._rooms.set('cv-runtime-state-done', {
      id: 'cv-runtime-state-done',
      mode: 'cross_verify',
      status: 'idle',
      cwd: '/tmp',
      members: [{ adapterId: adapterA.id, enabled: true }, { adapterId: adapterB.id, enabled: true }],
      taskList: makeSingleTaskList(),
    });
    const d = new CrossVerifyDispatcher({
      store,
      adapters: new Map([[adapterA.id, adapterA], [adapterB.id, adapterB]]),
      broadcast: (id, msg) => broadcasts.push({ roomId: id, ...msg }),
    });

    await d.start('cv-runtime-state-done', '验证统一运行态快照');

    expect(store._rooms.get('cv-runtime-state-done').clusterRuntimeState).toMatchObject({
      statusVersion: 'cluster-runtime-state-v1',
      roomStatus: 'done',
      phase: 'done',
      isRunning: false,
      canStart: true,
      taskSummary: {
        total: 1,
        counts: { done: 1 },
      },
      delivery: {
        present: true,
        stale: false,
      },
    });
  });

  it('_persist 落盘失败时标记 pending,交给 watchdog 后续自修复', () => {
    const failingStore = makeStore();
    failingStore.flush = vi.fn(() => {
      throw new Error('disk full');
    });
    failingStore._rooms.set('cv-persist-pending', {
      id: 'cv-persist-pending',
      mode: 'cross_verify',
      status: 'running',
      taskList: makeSingleTaskList(),
    });
    const d = new CrossVerifyDispatcher({
      store: failingStore,
      adapters: new Map(),
      broadcast: (id, msg) => broadcasts.push({ roomId: id, ...msg }),
    });

    d._persist('cv-persist-pending');

    const room = failingStore._rooms.get('cv-persist-pending');
    expect(room.clusterRuntimeRecoveryPersistPending).toMatchObject({
      reason: 'cross_verify_runtime_persist_failed',
      flushError: 'disk full',
    });
    expect(broadcasts.some((msg) => (
      msg.type === 'cross_verify_persist_pending'
      && msg.roomId === 'cv-persist-pending'
      && msg.flushError === 'disk full'
    ))).toBe(true);
  });

  it('_persist 成功落盘时清除旧 pending 标记', () => {
    store._rooms.set('cv-persist-clear', {
      id: 'cv-persist-clear',
      mode: 'cross_verify',
      status: 'running',
      taskList: makeSingleTaskList(),
      clusterRuntimeRecoveryPersistPending: {
        reason: 'cross_verify_runtime_persist_failed',
        flushError: 'previous failure',
        at: '2026-06-01T00:00:00.000Z',
      },
    });
    const d = new CrossVerifyDispatcher({
      store,
      adapters: new Map(),
      broadcast: (id, msg) => broadcasts.push({ roomId: id, ...msg }),
    });

    d._persist('cv-persist-clear');

    expect(store._rooms.get('cv-persist-clear').clusterRuntimeRecoveryPersistPending).toBeUndefined();
  });

  it('代码驱动阶段自动绑定成功 Agent Run 证据', () => {
    store._rooms.set('cv-auto-link', {
      id: 'cv-auto-link',
      mode: 'cross_verify',
      status: 'running',
      clusterEvidenceLinks: [],
    });
    const d = new CrossVerifyDispatcher({
      store,
      adapters: new Map(),
      broadcast: (id, msg) => broadcasts.push({ roomId: id, ...msg }),
      agentRunStore: {
        getTimeline: (id) => ({
          run: { id, status: 'succeeded' },
          toolResults: [{ id: 'tool-1' }],
          archives: [],
          artifacts: [{ id: 'artifact-1' }],
        }),
      },
    });

    const link = d._autoLinkAgentRunEvidence('cv-auto-link', {
      stageId: 'implementation',
      stageLabel: '代码开发',
      taskId: 'CE05',
      turn: 'propose-1-r1',
      adapterId: 'codex',
      agentRunId: 'agent-run-auto-1',
    });
    const duplicate = d._autoLinkAgentRunEvidence('cv-auto-link', {
      stageId: 'implementation',
      stageLabel: '代码开发',
      taskId: 'CE05',
      turn: 'propose-1-r1',
      adapterId: 'codex',
      agentRunId: 'agent-run-auto-1',
    });

    const room = store._rooms.get('cv-auto-link');
    expect(link).toMatchObject({
      source: 'cross_verify_dispatcher_auto_link',
      stageId: 'implementation',
      agentRunId: 'agent-run-auto-1',
      verified: true,
      evidenceCount: 2,
      toolResultCount: 1,
      artifactCount: 1,
    });
    expect(duplicate).toBeNull();
    expect(room.clusterEvidenceLinks).toHaveLength(1);
    expect(broadcasts.some((msg) => msg.type === 'cluster_evidence_auto_linked' && msg.agentRunId === 'agent-run-auto-1')).toBe(true);
  });

  it('代码驱动阶段会执行安全 node --check 并把真实结果绑定为交付证据', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cluster-auto-verification-'));
    try {
      writeFileSync(join(cwd, 'game.js'), 'const score = 1;\n');
      store._rooms.set('cv-auto-verify', {
        id: 'cv-auto-verify',
        mode: 'cross_verify',
        status: 'running',
        cwd,
        topic: '做一个文字游戏',
        clusterEvidenceLinks: [],
      });
      const agentRunStore = makeFakeAgentRunStore();
      const d = new CrossVerifyDispatcher({
        store,
        adapters: new Map(),
        broadcast: (id, msg) => broadcasts.push({ roomId: id, ...msg }),
        agentRunStore,
      });
      const artifact = {
        stageId: 'implementation',
        stageLabel: '代码开发',
        evidenceRequirement: { required: true, status: 'passed' },
        evidence: [{ memberId: 'a#1', commands: ['node --check game.js'], signals: ['command_evidence'] }],
      };

      const result = await d._runStageAutoVerification('cv-auto-verify', {
        id: 'CE05',
        stageId: 'implementation',
        stageLabel: '代码开发',
      }, artifact);

      const room = store._rooms.get('cv-auto-verify');
      const timeline = agentRunStore.getTimeline(result.agentRunId);
      expect(result).toMatchObject({ status: 'passed', commandCount: 1 });
      expect(timeline.run).toMatchObject({
        status: 'succeeded',
        roomId: 'cv-auto-verify',
        taskId: 'CE05',
      });
      expect(timeline.toolResults[0]).toMatchObject({
        toolName: 'node --check',
        command: 'node --check game.js',
        status: 'passed',
        exitCode: 0,
      });
      expect(room.clusterEvidenceLinks).toHaveLength(1);
      expect(room.clusterEvidenceLinks[0]).toMatchObject({
        source: 'cross_verify_dispatcher_auto_link',
        stageId: 'implementation',
        taskId: 'CE05',
        adapterId: 'cluster-auto-verifier',
        verified: true,
        toolResultCount: 1,
        evidenceCount: 1,
      });
      expect(broadcasts.some((msg) => msg.type === 'cluster_evidence_auto_linked' && msg.stageId === 'implementation')).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('代码驱动阶段自动验证失败时不绑定交付证据', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cluster-auto-verification-fail-'));
    try {
      writeFileSync(join(cwd, 'broken.js'), 'const = ;\n');
      store._rooms.set('cv-auto-verify-fail', {
        id: 'cv-auto-verify-fail',
        mode: 'cross_verify',
        status: 'running',
        cwd,
        topic: '做一个文字游戏',
        clusterEvidenceLinks: [],
      });
      const agentRunStore = makeFakeAgentRunStore();
      const d = new CrossVerifyDispatcher({
        store,
        adapters: new Map(),
        broadcast: (id, msg) => broadcasts.push({ roomId: id, ...msg }),
        agentRunStore,
      });
      const artifact = {
        stageId: 'implementation',
        stageLabel: '代码开发',
        evidenceRequirement: { required: true, status: 'passed' },
        evidence: [{ memberId: 'a#1', commands: ['node --check broken.js'], signals: ['command_evidence'] }],
      };

      const result = await d._runStageAutoVerification('cv-auto-verify-fail', {
        id: 'CE05',
        stageId: 'implementation',
        stageLabel: '代码开发',
      }, artifact);

      const room = store._rooms.get('cv-auto-verify-fail');
      const timeline = agentRunStore.getTimeline(result.agentRunId);
      expect(result.status).toBe('failed');
      expect(timeline.run.status).toBe('failed');
      expect(timeline.toolResults[0]).toMatchObject({
        toolName: 'node --check',
        command: 'node --check broken.js',
        status: 'failed',
      });
      expect(room.clusterEvidenceLinks).toHaveLength(0);
      expect(broadcasts.some((msg) => msg.type === 'cluster_evidence_auto_linked')).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('自动绑定 Agent Run 证据时拒绝跨房间或跨任务证据', () => {
    store._rooms.set('cv-auto-link-owner', {
      id: 'cv-auto-link-owner',
      mode: 'cross_verify',
      status: 'running',
      clusterEvidenceLinks: [],
    });
    const timelines = {
      'agent-run-other-room': {
        run: { id: 'agent-run-other-room', status: 'succeeded', roomId: 'other-room', taskId: 'CE05' },
        toolResults: [{ id: 'tool-1' }],
        archives: [],
        artifacts: [],
      },
      'agent-run-other-task': {
        run: { id: 'agent-run-other-task', status: 'succeeded', roomId: 'cv-auto-link-owner', taskId: 'CE06' },
        toolResults: [{ id: 'tool-2' }],
        archives: [],
        artifacts: [],
      },
    };
    const d = new CrossVerifyDispatcher({
      store,
      adapters: new Map(),
      broadcast: (id, msg) => broadcasts.push({ roomId: id, ...msg }),
      agentRunStore: {
        getTimeline: (id) => timelines[id],
      },
    });

    const otherRoom = d._autoLinkAgentRunEvidence('cv-auto-link-owner', {
      stageId: 'implementation',
      stageLabel: '代码开发',
      taskId: 'CE05',
      adapterId: 'codex',
      agentRunId: 'agent-run-other-room',
    });
    const otherTask = d._autoLinkAgentRunEvidence('cv-auto-link-owner', {
      stageId: 'implementation',
      stageLabel: '代码开发',
      taskId: 'CE05',
      adapterId: 'codex',
      agentRunId: 'agent-run-other-task',
    });

    const room = store._rooms.get('cv-auto-link-owner');
    expect(otherRoom).toBeNull();
    expect(otherTask).toBeNull();
    expect(room.clusterEvidenceLinks).toHaveLength(0);
    expect(broadcasts.some((msg) => msg.type === 'cluster_evidence_auto_linked')).toBe(false);
  });

  it('自动绑定 Agent Run 证据时拒绝只有失败工具结果的运行', () => {
    store._rooms.set('cv-auto-link-failed-tool', {
      id: 'cv-auto-link-failed-tool',
      mode: 'cross_verify',
      status: 'running',
      clusterEvidenceLinks: [],
    });
    const d = new CrossVerifyDispatcher({
      store,
      adapters: new Map(),
      broadcast: (id, msg) => broadcasts.push({ roomId: id, ...msg }),
      agentRunStore: {
        getTimeline: (id) => ({
          run: { id, status: 'succeeded', roomId: 'cv-auto-link-failed-tool', taskId: 'CE05' },
          toolResults: [{ id: 'tool-failed', status: 'failed' }],
          archives: [],
          artifacts: [],
        }),
      },
    });

    const link = d._autoLinkAgentRunEvidence('cv-auto-link-failed-tool', {
      stageId: 'implementation',
      stageLabel: '代码开发',
      taskId: 'CE05',
      adapterId: 'codex',
      agentRunId: 'agent-run-failed-tool',
    });

    const room = store._rooms.get('cv-auto-link-failed-tool');
    expect(link).toBeNull();
    expect(room.clusterEvidenceLinks).toHaveLength(0);
    expect(broadcasts.some((msg) => msg.type === 'cluster_evidence_auto_linked')).toBe(false);
  });

  it('_call 把当前任务写入 Agent Run budgetContext 方便证据追踪', async () => {
    store._rooms.set('cv-call-task-context', {
      id: 'cv-call-task-context',
      mode: 'cross_verify',
      status: 'running',
      cwd: '/tmp/project',
    });
    let capturedOptions = null;
    let capturedMessages = null;
    const adapter = {
      getNativeCapabilities() {
        return {
          providerId: 'codex',
          displayName: 'GPT',
          runtime: 'Codex CLI (`codex exec`)',
          nativeRuntime: true,
          tools: ['Codex 原生工具调用链'],
          plugins: ['Codex CLI profiles/plugins'],
          bridges: ['Codex App 插件桥接: 保留 Codex CLI base config'],
          requestProtocol: 'CODEX_APP_PLUGIN_REQUEST\nEND_CODEX_APP_PLUGIN_REQUEST',
        };
      },
      async chat(_messages, opts) {
        capturedMessages = _messages;
        capturedOptions = opts;
        return { reply: 'ok', tokensIn: 1, tokensOut: 1 };
      },
    };
    const d = new CrossVerifyDispatcher({
      store,
      adapters: new Map([['codex', adapter]]),
      broadcast: (id, msg) => broadcasts.push({ roomId: id, ...msg }),
    });

    const reply = await d._call(
      { adapterId: 'codex', model: 'gpt-5.5' },
      'prompt',
      new AbortController().signal,
      {
        room: store._rooms.get('cv-call-task-context'),
        taskId: 'CE05',
        stageId: 'implementation',
        turn: 'propose-1-r1',
      },
    );

    expect(reply).toBe('ok');
    expect(capturedOptions?.budgetContext).toMatchObject({
      roomId: 'cv-call-task-context',
      taskId: 'CE05',
      adapterId: 'codex',
    });
    expect(capturedOptions?.nativeCapabilities).toMatchObject({
      providerId: 'codex',
      nativeRuntime: true,
    });
    expect(capturedOptions?.disableMcp).toBe(true);
    expect(capturedOptions?.capabilityIsolation).toMatchObject({
      mode: 'cluster_native_only',
      sharedMcpDisabled: true,
    });
    expect(capturedMessages.find((message) => message.role === 'system')?.content).toContain('成员原生能力边界: GPT');
    expect(capturedMessages.find((message) => message.role === 'system')?.content).toContain('Codex 原生工具调用链');
    expect(capturedMessages.find((message) => message.role === 'system')?.content).toContain('Codex App 插件桥接');
    expect(capturedMessages.find((message) => message.role === 'system')?.content).toContain('CODEX_APP_PLUGIN_REQUEST');
  });

  it('Codex adapter 声明 Codex App 插件桥接能力,但不伪造桌面插件调用结果', () => {
    const adapter = new CodexSpawnAdapter();
    const capabilities = adapter.getNativeCapabilities();

    expect(capabilities.nativeRuntime).toBe(true);
    expect(capabilities.bridges.some((item) => item.includes('Codex App 插件桥接'))).toBe(true);
    expect(capabilities.bridges.some((item) => item.includes('不覆盖用户原配置'))).toBe(true);
    expect(capabilities.requestProtocol).toContain('CODEX_APP_PLUGIN_REQUEST');
    expect(capabilities.notes.some((item) => item.includes('不会被面板凭空伪造'))).toBe(true);
  });

  it('三种原生 adapter 能力隔离:GPT/Claude/Gemini 不共享同一个插件桥', () => {
    const codex = new CodexSpawnAdapter().getNativeCapabilities();
    const claude = new ClaudeSpawnAdapter().getNativeCapabilities();
    const gemini = new GeminiSpawnAdapter().getNativeCapabilities();

    expect(codex.providerId).toBe('codex');
    expect(claude.providerId).toBe('claude');
    expect(gemini.providerId).toBe('gemini-cli');
    expect(codex.runtime).toContain('Codex CLI');
    expect(claude.runtime).toContain('Claude Code CLI');
    expect(gemini.runtime).toContain('Gemini CLI');
    expect(codex.bridges.some((item) => item.includes('Codex App 插件桥接'))).toBe(true);
    expect(claude.bridges.some((item) => item.includes('Codex App 插件桥接'))).toBe(false);
    expect(gemini.bridges.some((item) => item.includes('Codex App 插件桥接'))).toBe(false);
    expect(codex.requestProtocol).toContain('CODEX_APP_PLUGIN_REQUEST');
    expect(claude.requestProtocol).toBe('');
    expect(gemini.requestProtocol).toBe('');
    expect(claude.mcp.some((item) => item.includes('Claude CLI 原生 MCP'))).toBe(true);
    expect(gemini.tools.some((item) => item.includes('Gemini CLI'))).toBe(true);
  });

  it('集群协同原生能力隔离会剔除面板共享 MCP 描述,避免多个模型共抢同一插件', () => {
    const isolated = isolateClusterNativeCapabilities({
      providerId: 'codex',
      displayName: 'GPT',
      mcp: [
        'Codex base config 中已有的 MCP servers',
        '面板启用的 stdio MCP 会通过临时 --profile 叠加给 Codex',
      ],
      bridges: [
        'Codex App 插件桥接: 面板临时 profile 只做叠加',
        '面板已叠加 MCP: browser',
      ],
      notes: ['原说明'],
    });

    expect(isolated.mcp).toEqual(['Codex base config 中已有的 MCP servers']);
    expect(isolated.bridges.join('\n')).not.toContain('面板已叠加 MCP');
    expect(isolated.bridges.join('\n')).not.toContain('面板临时 profile');
    expect(isolated.bridges.join('\n')).toContain('Codex App 插件桥接');
    expect(isolated.notes.join('\n')).toContain('禁用面板共享 MCP 注入');
  });

  it('集群协同调用时按成员注入各自原生能力,不会串用同一个插件协议', async () => {
    store._rooms.set('cv-native-isolation', {
      id: 'cv-native-isolation',
      mode: 'cross_verify',
      status: 'running',
      cwd: '/tmp/project',
      skills: ['codex', 'qa', 'shared-room-skill'],
    });
    const captured = {};
    const makeAdapter = (id, capabilities) => ({
      getNativeCapabilities: () => capabilities,
      async chat(messages, opts) {
        captured[id] = { messages, opts };
        return { reply: `${id} ok`, tokensIn: 1, tokensOut: 1 };
      },
    });
    const d = new CrossVerifyDispatcher({
      store,
      adapters: new Map([
        ['codex', makeAdapter('codex', new CodexSpawnAdapter().getNativeCapabilities())],
        ['claude', makeAdapter('claude', new ClaudeSpawnAdapter().getNativeCapabilities())],
        ['gemini-cli', makeAdapter('gemini-cli', new GeminiSpawnAdapter().getNativeCapabilities())],
      ]),
      broadcast: () => {},
    });
    const signal = new AbortController().signal;
    const room = store._rooms.get('cv-native-isolation');

    await d._call({ adapterId: 'codex', model: 'gpt-5.5' }, 'prompt', signal, { room, taskId: 'CE05', stageId: 'implementation' });
    await d._call({ adapterId: 'claude', model: 'claude-opus-4-8' }, 'prompt', signal, { room, taskId: 'CE05', stageId: 'implementation' });
    await d._call({ adapterId: 'gemini-cli', model: 'gemini-3.5-flash' }, 'prompt', signal, { room, taskId: 'CE05', stageId: 'implementation' });

    const systemText = (id) => captured[id].messages.find((message) => message.role === 'system')?.content || '';
    expect(systemText('codex')).toContain('Codex App 插件桥接');
    expect(systemText('codex')).toContain('CODEX_APP_PLUGIN_REQUEST');
    expect(systemText('codex')).toContain('禁用面板共享 MCP 注入');
    expect(systemText('codex')).not.toContain('面板启用的 stdio MCP');
    expect(systemText('codex')).toContain('Installed bound skills for this turn: none installed');
    expect(systemText('codex')).not.toContain('shared-room-skill');
    expect(systemText('codex')).not.toContain('qa [room]');
    expect(systemText('claude')).toContain('Claude Code CLI');
    expect(systemText('claude')).not.toContain('CODEX_APP_PLUGIN_REQUEST');
    expect(systemText('claude')).toContain('禁用面板共享 MCP 注入');
    expect(systemText('claude')).not.toContain('面板启用的 stdio MCP');
    expect(systemText('claude')).toContain('Installed bound skills for this turn: none installed');
    expect(systemText('claude')).not.toContain('shared-room-skill');
    expect(systemText('gemini-cli')).toContain('Gemini CLI');
    expect(systemText('gemini-cli')).not.toContain('CODEX_APP_PLUGIN_REQUEST');
    expect(systemText('gemini-cli')).toContain('Installed bound skills for this turn: none installed');
    expect(systemText('gemini-cli')).not.toContain('shared-room-skill');
    expect(captured.codex.opts.nativeCapabilities.providerId).toBe('codex');
    expect(captured.claude.opts.nativeCapabilities.providerId).toBe('claude');
    expect(captured['gemini-cli'].opts.nativeCapabilities.providerId).toBe('gemini-cli');
    expect(captured.codex.opts.disableMcp).toBe(true);
    expect(captured.claude.opts.disableMcp).toBe(true);
    expect(captured['gemini-cli'].opts.disableMcp).toBe(true);
  });

  it('成员掉线或额度耗尽时,剩余成员自动接手并继续达成共识', async () => {
    const ack = JSON.stringify({ agree: true, reasoning: '接手后同意', suggestions: [], critical_issues: [] });
    const makeAdapter = (id, { failOnce = false } = {}) => {
      let failed = false;
      return {
        id,
        displayName: id,
        async chat(messages) {
          const prompt = messages[messages.length - 1]?.content || '';
          if (failOnce && !failed) {
            failed = true;
            throw new Error('quota 429 RESOURCE_EXHAUSTED');
          }
          if (prompt.includes('评审输出')) return { reply: ack, tokensIn: 1, tokensOut: 1 };
          return { reply: `# ${id} 接手方案\n本步未写文件`, tokensIn: 1, tokensOut: 1 };
        },
      };
    };
    const adapterA = makeAdapter('failover-a');
    const adapterB = makeAdapter('failover-b', { failOnce: true });
    const adapterC = makeAdapter('failover-c');
    store._rooms.set('cv-failover', {
      id: 'cv-failover',
      mode: 'cross_verify',
      cwd: '/tmp',
      members: [
        { adapterId: adapterA.id, enabled: true },
        { adapterId: adapterB.id, enabled: true },
        { adapterId: adapterC.id, enabled: true },
      ],
      taskList: makeSingleTaskList(),
    });
    const d = new CrossVerifyDispatcher({
      store,
      adapters: new Map([[adapterA.id, adapterA], [adapterB.id, adapterB], [adapterC.id, adapterC]]),
      broadcast: (id, msg) => broadcasts.push({ roomId: id, ...msg }),
    });

    await d.start('cv-failover', '做一个小项目');

    const room = store._rooms.get('cv-failover');
    expect(room.status).toBe('done');
    expect(room.clusterDroppedMembers).toHaveLength(1);
    expect(room.clusterDroppedMembers[0]).toMatchObject({
      adapterId: 'failover-b',
      phase: 'propose',
      soloTakeover: false,
    });
    expect(room.clusterDroppedMembers[0].reason).toContain('额度/限流');
    expect(room.taskList[0].status).toBe('done');
    expect(room.taskList[0].memberFailovers).toHaveLength(1);
    expect(room.taskList[0].consensus.byMembers).toEqual(['failover-a#1', 'failover-c#3']);
    expect(broadcasts.some((msg) => msg.type === 'cv_member_failover' && msg.adapterId === 'failover-b')).toBe(true);
    expect(broadcasts.some((msg) => msg.type === 'cv_failover_takeover' && msg.remainingMembers.length === 2)).toBe(true);
  });

  it('成员调用卡死超过运行期超时后,剩余成员自动接手而不是让房间永久 running', async () => {
    let hangingSignalAborted = false;
    const hangingAdapter = {
      id: 'timeout-hanging',
      displayName: 'timeout-hanging',
      async chat(_messages, opts = {}) {
        opts.abortSignal?.addEventListener?.('abort', () => {
          hangingSignalAborted = true;
        }, { once: true });
        return new Promise(() => {});
      },
    };
    const survivorAdapter = {
      id: 'timeout-survivor',
      displayName: 'timeout-survivor',
      async chat(messages) {
        const prompt = messages[messages.length - 1]?.content || '';
        if (prompt.includes('评审输出')) {
          return { reply: JSON.stringify({ agree: true, reasoning: '超时成员剔除后同意', suggestions: [], critical_issues: [] }), tokensIn: 1, tokensOut: 1 };
        }
        return { reply: '# timeout-survivor 接手方案\n本步未写文件', tokensIn: 1, tokensOut: 1 };
      },
    };
    store._rooms.set('cv-member-timeout-failover', {
      id: 'cv-member-timeout-failover',
      mode: 'cross_verify',
      cwd: '/tmp',
      members: [
        { adapterId: hangingAdapter.id, enabled: true },
        { adapterId: survivorAdapter.id, enabled: true },
      ],
      taskList: makeSingleTaskList(),
    });
    const d = new CrossVerifyDispatcher({
      store,
      adapters: new Map([[hangingAdapter.id, hangingAdapter], [survivorAdapter.id, survivorAdapter]]),
      broadcast: (id, msg) => broadcasts.push({ roomId: id, ...msg }),
      memberCallTimeoutMs: 20,
    });

    await d.start('cv-member-timeout-failover', '做一个小项目');

    const room = store._rooms.get('cv-member-timeout-failover');
    expect(room.status).toBe('done');
    expect(hangingSignalAborted).toBe(true);
    expect(d.activeAborts.has('cv-member-timeout-failover')).toBe(false);
    expect(room.clusterDroppedMembers).toHaveLength(1);
    expect(room.clusterDroppedMembers[0]).toMatchObject({
      adapterId: 'timeout-hanging',
      phase: 'propose',
      soloTakeover: true,
    });
    expect(room.clusterDroppedMembers[0].reason).toContain('cluster_member_call_timeout');
    expect(room.taskList[0].status).toBe('done');
    expect(room.taskList[0].consensus.byMembers).toEqual(['timeout-survivor#2']);
    expect(room.clusterRuntimeTelemetry.failedCalls).toBeGreaterThanOrEqual(1);
    expect(broadcasts.some((msg) => msg.type === 'cluster_member_call_timeout' && msg.adapterId === 'timeout-hanging')).toBe(true);
    expect(broadcasts.some((msg) => msg.type === 'cv_solo_takeover' && msg.remainingMembers.length === 1)).toBe(true);
  });

  it('只剩一个成员时进入单模型接管并坚持完成当前任务', async () => {
    const makeAdapter = (id, { fail = false } = {}) => ({
      id,
      displayName: id,
      async chat(messages) {
        if (fail) throw new Error('adapter offline');
        const prompt = messages[messages.length - 1]?.content || '';
        expect(prompt).toContain('集群协同开发者');
        return { reply: `# ${id} 单模型接管方案\n本步未写文件`, tokensIn: 1, tokensOut: 1 };
      },
    });
    const adapterA = makeAdapter('solo-a', { fail: true });
    const adapterB = makeAdapter('solo-b', { fail: true });
    const adapterC = makeAdapter('solo-c');
    store._rooms.set('cv-solo-takeover', {
      id: 'cv-solo-takeover',
      mode: 'cross_verify',
      cwd: '/tmp',
      members: [
        { adapterId: adapterA.id, enabled: true },
        { adapterId: adapterB.id, enabled: true },
        { adapterId: adapterC.id, enabled: true },
      ],
      taskList: makeSingleTaskList(),
    });
    const d = new CrossVerifyDispatcher({
      store,
      adapters: new Map([[adapterA.id, adapterA], [adapterB.id, adapterB], [adapterC.id, adapterC]]),
      broadcast: (id, msg) => broadcasts.push({ roomId: id, ...msg }),
    });

    await d.start('cv-solo-takeover', '做一个小项目');

    const room = store._rooms.get('cv-solo-takeover');
    expect(room.status).toBe('done');
    expect(room.clusterDroppedMembers).toHaveLength(2);
    expect(room.clusterDroppedMembers.every((item) => item.soloTakeover === true)).toBe(true);
    expect(room.taskList[0].status).toBe('done');
    expect(room.taskList[0].consensus.byMembers).toEqual(['solo-c#3']);
    expect(room.taskList[0].consensus.stageArtifact.signoffs).toHaveLength(1);
    expect(room.taskList[0].consensus.stageArtifact.signoffs[0]).toMatchObject({
      memberId: 'solo-c#3',
      agree: true,
    });
    expect(broadcasts.some((msg) => msg.type === 'cv_solo_takeover' && msg.remainingMembers.length === 1)).toBe(true);
    expect(broadcasts.some((msg) => msg.type === 'cross_verify_done')).toBe(true);
  });

  it('_parseAck:正常 JSON', () => {
    const d = new CrossVerifyDispatcher({ store, adapters: new Map(), broadcast: () => {} });
    const ack = d._parseAck('{"agree":true,"reasoning":"OK","suggestions":["s1"],"critical_issues":[]}');
    expect(ack).toMatchObject({ agree: true, reasoning: 'OK' });
    expect(ack.suggestions).toEqual(['s1']);
  });

  it('_parseAck:含 ```json 围栏', () => {
    const d = new CrossVerifyDispatcher({ store, adapters: new Map(), broadcast: () => {} });
    const ack = d._parseAck('```json\n{"agree":false,"reasoning":"X","critical_issues":["bad"]}\n```');
    expect(ack.agree).toBe(false);
    expect(ack.critical_issues).toEqual(['bad']);
  });

  it('_parseAck:解析失败 → agree=false + 把原文当 reasoning', () => {
    const d = new CrossVerifyDispatcher({ store, adapters: new Map(), broadcast: () => {} });
    const ack = d._parseAck('这不是 JSON');
    expect(ack.agree).toBe(false);
    expect(ack.reasoning).toContain('ack 解析失败');
  });

  it('recoverStartupTimeoutMembers:恢复启动期 live_ping_timeout 误禁用成员', () => {
    const result = recoverStartupTimeoutMembers({
      members: [
        { adapterId: 'claude', enabled: true },
        { adapterId: 'codex', enabled: false, failoverDisabled: true, failoverReason: 'startup_live_check_failed' },
        { adapterId: 'gemini-cli', enabled: false, failoverDisabled: true, failoverReason: 'startup_live_check_failed' },
      ],
      clusterStartupLiveCheck: {
        checks: [
          { adapterId: 'codex', passed: false, blockers: ['live_ping_timeout'] },
          { adapterId: 'gemini-cli', passed: false, blockers: ['live_ping_timeout'] },
        ],
      },
      clusterDroppedMembers: [
        { adapterId: 'codex', reason: 'startup_live_check_failed' },
        { adapterId: 'gemini-cli', reason: 'startup_live_check_failed' },
      ],
      clusterStartupDegradedMembers: [
        { adapterId: 'codex', reason: 'startup_live_check_failed' },
        { adapterId: 'gemini-cli', reason: 'startup_live_check_failed' },
      ],
    });

    expect(result.changed).toBe(true);
    expect(result.patch.members.map((member) => member.enabled)).toEqual([true, true, true]);
    expect(result.patch.members[1].failoverReason).toBeUndefined();
    expect(result.patch.clusterDroppedMembers).toEqual([]);
    expect(result.patch.clusterStartupDegradedMembers).toEqual([]);
  });

  it('没有可用成员 → 抛错并 setStatus error', async () => {
    store._rooms.set('r1', { id: 'r1', mode: 'cross_verify', members: [] });
    const d = new CrossVerifyDispatcher({ store, adapters: new Map(), broadcast: (id, msg) => broadcasts.push(msg) });
    await expect(d.start('r1', 'topic')).rejects.toThrow();
    expect(store._rooms.get('r1').status).toBe('error');
    expect(broadcasts.some((m) => m.type === 'cross_verify_error')).toBe(true);
  });

  it('A/B 双方第一轮都同意 → 1 round 达成一致 + status=done', async () => {
    const planA = '# 实现\n实际代码 X';
    const planB = '# 实现\n实际代码 X';
    const ack = JSON.stringify({ agree: true, reasoning: '同意', suggestions: [], critical_issues: [] });
    const adapterA = makeStubAdapter([planA, ack]); // 第 1 调:propose,第 2 调:review
    const adapterB = makeStubAdapter([planB, ack]);
    store._rooms.set('cv1', {
      id: 'cv1', mode: 'cross_verify', cwd: '/tmp',
      members: [{ adapterId: adapterA.id, enabled: true }, { adapterId: adapterB.id, enabled: true }],
      taskList: makeSingleTaskList(),
    });
    const adapters = new Map([[adapterA.id, adapterA], [adapterB.id, adapterB]]);
    const d = new CrossVerifyDispatcher({ store, adapters, broadcast: (id, msg) => broadcasts.push(msg) });

    await d.start('cv1', '写一个 hello world');

    const room = store._rooms.get('cv1');
    expect(room.status).toBe('done');
    expect(room.taskList).toHaveLength(1);
    expect(room.taskList[0].status).toBe('done');
    expect(room.taskList[0].consensus).toBeDefined();
    expect(room.taskList[0].consensus.totalRounds).toBe(1);
    expect(broadcasts.some((m) => m.type === 'cv_consensus')).toBe(true);
  });

  it('新建集群协同默认生成 11 个工程闭环阶段任务并逐项达成共识', async () => {
    const ack = JSON.stringify({ agree: true, reasoning: '同意', suggestions: [], critical_issues: [] });
    const adapterA = makeStubAdapter(['# A 阶段方案\nnpm test -- tests/unit/example.test.js\n### 文件落地验证\ncat src/example.js', ack]);
    const adapterB = makeStubAdapter(['# B 阶段方案\nnpm test -- tests/unit/example.test.js\n### 文件落地验证\ncat src/example.js', ack]);
    store._rooms.set('cv-workflow', {
      id: 'cv-workflow', mode: 'cross_verify', cwd: '/tmp',
      members: [{ adapterId: adapterA.id, enabled: true }, { adapterId: adapterB.id, enabled: true }],
    });
    const adapters = new Map([[adapterA.id, adapterA], [adapterB.id, adapterB]]);
    const d = new CrossVerifyDispatcher({ store, adapters, broadcast: (id, msg) => broadcasts.push(msg) });

    await d.start('cv-workflow', '做一个游戏项目');

    const room = store._rooms.get('cv-workflow');
    expect(room.taskList).toHaveLength(CLUSTER_ENGINEERING_STAGES.length);
    expect(room.taskList.map((t) => t.stageId)).toEqual(CLUSTER_ENGINEERING_STAGES.map((s) => s.id));
    expect(room.taskList.every((t) => t.status === 'done')).toBe(true);
    expect(room.taskList.every((t) => t.consensus?.stageArtifact?.gates?.[0]?.status === 'passed')).toBe(true);
    expect(room.taskList[9].stageId).toBe('acceptance');
    expect(room.taskList[9].acceptanceReport.summary.total).toBe(9);
    expect(room.taskList[9].consensus.stageArtifact.acceptanceReport.summary.total).toBe(9);
    expect(room.taskList[10].stageId).toBe('retrospective');
    expect(room.taskList[10].retrospectiveReport.scopeStageCount).toBe(10);
    expect(room.taskList[10].consensus.stageArtifact.retrospectiveReport.scopeStageCount).toBe(10);
    expect(room.clusterWorkflowAudit).toMatchObject({
      overallStatus: 'complete',
      counts: { total: 11, blocking: 0 },
    });
    expect(room.clusterWorkflowAudit.acceptanceSummary.total).toBe(9);
    expect(room.clusterWorkflowAudit.retrospectiveSummary.totalBacklog).toBeGreaterThanOrEqual(0);
    expect(room.clusterDeliveryManifest).toMatchObject({
      manifestVersion: 'cluster-delivery-v1',
      mode: 'cluster_collaboration',
      overallStatus: 'complete',
      stageCount: 11,
      doneStageCount: 11,
      readyForDelivery: false,
      deliveryGate: { status: 'blocked', blockers: ['agent_run_evidence_incomplete=0/4'] },
    });
    expect(room.clusterDeliveryManifest.acceptance.summary.total).toBe(9);
    expect(room.clusterDeliveryManifest.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(room.clusterDeliveryManifest.evidenceMatrix).toHaveLength(11);
    expect(room.clusterDeliveryManifest.evidenceMatrix.find((row) => row.stageId === 'unit_test').commandEvidenceCount).toBeGreaterThan(0);
    expect(room.clusterDeliveryManifest.evidenceMatrix.find((row) => row.stageId === 'implementation').fileEvidenceCount).toBeGreaterThan(0);
    expect(room.clusterDeliveryManifest.evidenceCoverage).toMatchObject({
      codeDrivenStageCount: 4,
      codeDrivenCoveredStageCount: 4,
    });
    expect(room.clusterRuntimeTelemetry).toMatchObject({
      telemetryVersion: 'cluster-runtime-telemetry-v1',
      calls: 44,
      succeededCalls: 44,
      failedCalls: 0,
      tokensIn: 44,
      tokensOut: 44,
      totalTokens: 88,
    });
    expect(Object.keys(room.clusterRuntimeTelemetry.byAdapter)).toHaveLength(2);
    expect(broadcasts.filter((m) => m.type === 'cluster_runtime_metric')).toHaveLength(44);
    expect(room.clusterDeliveryManifest.evidenceIntegrity).toMatchObject({
      integrityVersion: 'cluster-evidence-integrity-v1',
      status: 'declared_hard_evidence',
      verifiedRunEvidenceStageCount: 0,
    });
    expect(room.clusterDeliveryManifest.evidenceIntegrity.declaredHardEvidenceStageCount).toBeGreaterThan(0);
    expect(room.clusterDeliveryManifest.evidenceCoverage.commandEvidenceCount).toBeGreaterThan(0);
    expect(room.clusterDeliveryManifest.evidenceCoverage.fileEvidenceCount).toBeGreaterThan(0);
    expect(room.clusterDeliveryManifest.memberSignoffMatrix).toHaveLength(11);
    expect(room.clusterDeliveryManifest.memberSignoffMatrix.every((row) => row.complete)).toBe(true);
    expect(room.clusterDeliveryManifest.objectiveCompletionAudit).toMatchObject({
      auditVersion: 'cluster-objective-completion-v1',
      status: 'blocked',
      passedCount: 4,
      total: 6,
    });
    expect(room.clusterDeliveryManifest.objectiveCompletionAudit.items.find((item) => item.id === 'code_driven_evidence')?.blockers).toContain('agent_run_evidence_incomplete');
    expect(room.clusterDeliveryManifest.objectiveCompletionAudit.items.map((item) => item.id)).toEqual([
      'single_project_goal',
      'full_lifecycle_11_stages',
      'multi_ai_peer_signoff',
      'code_driven_evidence',
      'acceptance_closed_loop',
      'automatic_rework_traceability',
    ]);
    expect(room.clusterDeliveryReportMarkdown).toContain('# 集群协同交付报告');
    expect(room.clusterDeliveryReportMarkdown).toContain('## 目标完成度审计');
    expect(room.clusterDeliveryReportMarkdown).toContain('## 阶段交付矩阵');
    expect(room.clusterDeliveryReportMarkdown).toContain(room.clusterDeliveryManifest.fingerprint);
    expect(room.clusterDeliveryPackage).toMatchObject({
      packageVersion: 'cluster-delivery-package-v1',
      status: 'blocked',
      readyForArchive: false,
      manifestFingerprint: room.clusterDeliveryManifest.fingerprint,
      deliveryGateStatus: 'blocked',
    });
    expect(room.clusterDeliveryPackage.artifacts.map((item) => item.kind)).toEqual([
      'delivery_manifest_json',
      'delivery_report_markdown',
    ]);
    expect(room.clusterDeliveryPackage.reportFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(room.taskList[0].desc).toContain('用户想法');
    expect(room.taskList.at(-1).desc).toContain('复盘优化');
    expect(broadcasts.filter((m) => m.type === 'cv_consensus')).toHaveLength(CLUSTER_ENGINEERING_STAGES.length);
  });

  it('dry-run: 使用真实 ChatRoomStore 跑完整 11 阶段并落盘 clusterWorkflowAudit', async () => {
    const oldHome = process.env.HOME;
    const tempHome = mkdtempSync(join(tmpdir(), 'noe-cv-dryrun-'));
    process.env.HOME = tempHome;
    vi.resetModules();
    try {
      const { ChatRoomStore } = await import('../../src/room/ChatRoomStore.js');
      const realStore = new ChatRoomStore();
      const ack = JSON.stringify({ agree: true, reasoning: '同意', suggestions: [], critical_issues: [] });
      const plan = '# 阶段方案\nnpm test -- tests/unit/example.test.js\n### 文件落地验证\ncat src/example.js';
      const adapterA = makeStubAdapter([plan, ack]);
      const adapterB = makeStubAdapter([plan, ack]);
      const room = realStore.create({
        name: 'dry-run 集群协同小游戏',
        mode: 'cross_verify',
        cwd: tempHome,
        members: [{ adapterId: adapterA.id, enabled: true }, { adapterId: adapterB.id, enabled: true }],
      });
      const adapters = new Map([[adapterA.id, adapterA], [adapterB.id, adapterB]]);
      const d = new CrossVerifyDispatcher({ store: realStore, adapters, broadcast: (id, msg) => broadcasts.push(msg) });

      await d.start(room.id, '做一个最小游戏项目 dry-run');
      realStore.flush();

      const data = JSON.parse(readFileSync(join(tempHome, '.noe-panel', 'rooms.json'), 'utf8'));
      const saved = data.rooms.find((item) => item.id === room.id);
      expect(saved.status).toBe('paused');
      expect(saved.taskList).toHaveLength(11);
      expect(saved.clusterWorkflowAudit).toMatchObject({
        overallStatus: 'complete',
        counts: { total: 11, blocking: 0 },
      });
      expect(saved.clusterWorkflowAudit.acceptanceSummary.total).toBe(9);
      expect(saved.clusterWorkflowAudit.retrospectiveSummary.totalBacklog).toBeGreaterThanOrEqual(0);
      expect(saved.clusterDeliveryManifest).toMatchObject({
        manifestVersion: 'cluster-delivery-v1',
        mode: 'cluster_collaboration',
        overallStatus: 'complete',
        stageCount: 11,
        readyForDelivery: false,
        deliveryGate: { status: 'blocked', blockers: ['agent_run_evidence_incomplete=0/4'] },
      });
      expect(saved.clusterDeliveryManifest.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(saved.clusterDeliveryManifest.evidenceMatrix).toHaveLength(11);
      expect(saved.clusterDeliveryManifest.evidenceIntegrity).toMatchObject({
        status: 'declared_hard_evidence',
        verifiedRunEvidenceStageCount: 0,
      });
      expect(saved.clusterDeliveryManifest.memberSignoffMatrix).toHaveLength(11);
      expect(saved.clusterDeliveryManifest.memberSignoffMatrix.every((row) => row.complete)).toBe(true);
      expect(saved.clusterDeliveryManifest.objectiveCompletionAudit).toMatchObject({
        status: 'blocked',
        passedCount: 4,
        total: 6,
      });
      expect(saved.clusterDeliveryManifest.objectiveCompletionAudit.items.find((item) => item.id === 'code_driven_evidence')?.blockers).toContain('agent_run_evidence_incomplete');
      expect(saved.clusterDeliveryReportMarkdown).toContain('# 集群协同交付报告');
      expect(saved.clusterDeliveryReportMarkdown).toContain('## 目标完成度审计');
      expect(saved.clusterDeliveryReportMarkdown).toContain('## 阶段交付矩阵');
      expect(saved.clusterDeliveryPackage).toMatchObject({
        packageVersion: 'cluster-delivery-package-v1',
        status: 'blocked',
        readyForArchive: false,
        manifestFingerprint: saved.clusterDeliveryManifest.fingerprint,
      });
      expect(saved.taskList[9].consensus.stageArtifact.acceptanceReport.summary.total).toBe(9);
      expect(saved.taskList[10].consensus.stageArtifact.retrospectiveReport.scopeStageCount).toBe(10);
      expect(broadcasts.filter((m) => m.type === 'cv_consensus')).toHaveLength(11);
    } finally {
      process.env.HOME = oldHome;
      rmSync(tempHome, { recursive: true, force: true });
      vi.resetModules();
    }
  });

  it('buildClusterWorkflowAudit:生成完整链路和阻断链路的审计摘要', () => {
    const doneTasks = buildClusterEngineeringTaskList('项目目标').slice(0, 2);
    doneTasks[0].status = 'done';
    doneTasks[0].stageArtifact = {
      gates: [{ status: 'passed' }],
      evidence: [{ memberId: 'a#1', signals: ['natural_language_only'] }],
      signoffs: [{ memberId: 'a#1', agree: true }],
      risks: [],
    };
    doneTasks[1].status = 'escalated';
    doneTasks[1].blocking = true;
    doneTasks[1].stageArtifact = {
      gates: [{ status: 'passed' }],
      evidenceRequirement: { required: true, status: 'insufficient' },
      evidence: [{ memberId: 'a#1', signals: ['natural_language_only'] }],
      signoffs: [{ memberId: 'a#1', agree: true }],
      risks: [],
    };

    const audit = buildClusterWorkflowAudit(doneTasks);

    expect(audit.overallStatus).toBe('blocked');
    expect(audit.counts).toMatchObject({ total: 2, blocking: 1, evidenceInsufficient: 1 });
    expect(audit.blockers).toHaveLength(1);
    expect(audit.stages[1]).toMatchObject({ stageId: 'requirements', status: 'escalated', blocking: true });
  });

  it('关键代码驱动阶段证据不足会阻断后续阶段并暂停房间', async () => {
    const ack = JSON.stringify({ agree: true, reasoning: '同意', suggestions: [], critical_issues: [] });
    const adapterA = makeStubAdapter(['# 只有自然语言方案', ack]);
    const adapterB = makeStubAdapter(['# 也只有自然语言方案', ack]);
    const taskList = buildClusterEngineeringTaskList('做一个游戏项目').slice(0, 6);
    store._rooms.set('cv-quality-block', {
      id: 'cv-quality-block', mode: 'cross_verify', cwd: '/tmp',
      members: [{ adapterId: adapterA.id, enabled: true }, { adapterId: adapterB.id, enabled: true }],
      taskList,
    });
    const adapters = new Map([[adapterA.id, adapterA], [adapterB.id, adapterB]]);
    const d = new CrossVerifyDispatcher({ store, adapters, broadcast: (id, msg) => broadcasts.push(msg) });

    await d.start('cv-quality-block', '做一个游戏项目');

    const room = store._rooms.get('cv-quality-block');
    const implementationTask = room.taskList.find((task) => task.stageId === 'implementation');
    const unitTestTask = room.taskList.find((task) => task.stageId === 'unit_test');
    expect(room.status).toBe('paused');
    expect(room.clusterWorkflowAudit).toMatchObject({
      overallStatus: 'blocked',
      counts: { blocking: 1, evidenceInsufficient: 1 },
    });
    expect(implementationTask.status).toBe('escalated');
    expect(implementationTask.blocking).toBe(true);
    expect(implementationTask.escalateReason).toContain('代码驱动证据不足');
    expect(implementationTask.consensus.stageArtifact.evidenceRequirement.status).toBe('insufficient');
    expect(implementationTask.qualityGateRepairs).toBe(1);
    expect(unitTestTask.status).toBe('pending');
    expect(broadcasts.some((m) => m.type === 'cv_quality_gate_repair')).toBe(true);
    expect(broadcasts.some((m) => m.type === 'cv_quality_gate_failed')).toBe(true);
    expect(broadcasts.some((m) => m.type === 'cross_verify_paused' && m.reason === 'quality_gate_failed')).toBe(true);
  });

  it('交付验收存在 failed/insufficient 项时会自动回到失败阶段返工并重新验收', async () => {
    const ack = JSON.stringify({ agree: true, reasoning: '同意', suggestions: [], critical_issues: [] });
    const plan = '# 返工方案\nnpm test -- tests/unit/example.test.js\n截图 UI 验证\n### 文件落地验证\ncat src/example.js';
    const adapterA = makeStubAdapter([plan, ack]);
    const adapterB = makeStubAdapter([plan, ack]);
    const taskList = buildClusterEngineeringTaskList('做一个游戏项目').slice(0, 10);
    const makeArtifact = (stageId, gateStatus = 'passed') => ({
      stageId,
      gates: [{ status: gateStatus }],
      evidenceRequirement: { required: false, status: 'not_required' },
      evidence: [{ memberId: 'a#1', signals: ['natural_language_only'] }],
      signoffs: [{ memberId: 'a#1', agree: true }, { memberId: 'b#2', agree: true }],
      risks: [],
    });
    for (const task of taskList.slice(0, 9)) {
      task.status = 'done';
      task.consensus = { finalPlan: `# ${task.stageLabel} 已完成`, stageArtifact: makeArtifact(task.stageId) };
      task.stageArtifact = task.consensus.stageArtifact;
    }
    const brokenTask = taskList.find((task) => task.stageId === 'requirements');
    brokenTask.consensus.stageArtifact = makeArtifact('requirements', 'failed');
    brokenTask.stageArtifact = brokenTask.consensus.stageArtifact;

    store._rooms.set('cv-acceptance-block', {
      id: 'cv-acceptance-block', mode: 'cross_verify', cwd: '/tmp',
      members: [{ adapterId: adapterA.id, enabled: true }, { adapterId: adapterB.id, enabled: true }],
      taskList,
    });
    const adapters = new Map([[adapterA.id, adapterA], [adapterB.id, adapterB]]);
    const d = new CrossVerifyDispatcher({ store, adapters, broadcast: (id, msg) => broadcasts.push(msg) });

    await d.start('cv-acceptance-block', '做一个游戏项目');

    const room = store._rooms.get('cv-acceptance-block');
    const requirementsTask = room.taskList.find((task) => task.stageId === 'requirements');
    const acceptanceTask = room.taskList.find((task) => task.stageId === 'acceptance');
    expect(room.status).toBe('done');
    expect(room.acceptanceAutoRemediations).toBe(1);
    expect(room.acceptanceRemediationHistory).toHaveLength(1);
    expect(room.acceptanceRemediationHistory[0]).toMatchObject({
      automatic: true,
      targetStageId: 'requirements',
      verdict: 'failed',
    });
    expect(room.acceptanceRemediationHistory[0].invalidated.map((item) => item.stageId)).toContain('technical_design');
    expect(room.clusterWorkflowAudit.overallStatus).toBe('complete');
    expect(room.clusterWorkflowAudit.remediationSummary).toMatchObject({
      total: 1,
      automatic: 1,
    });
    expect(room.clusterWorkflowAudit.remediationSummary.invalidatedStages).toBeGreaterThanOrEqual(1);
    expect(requirementsTask.status).toBe('done');
    expect(acceptanceTask.status).toBe('done');
    expect(acceptanceTask.blocking).toBe(false);
    expect(acceptanceTask.acceptanceReport.summary.failed).toBe(0);
    expect(acceptanceTask.consensus.stageArtifact.acceptanceRequirement).toMatchObject({
      required: true,
      status: 'passed',
      failed: 0,
    });
    const remediationEvent = broadcasts.find((m) => m.type === 'cv_acceptance_remediation' && m.automatic === true && m.stageId === 'requirements');
    const autoReworkEvent = broadcasts.find((m) => m.type === 'cv_acceptance_auto_rework' && m.stageId === 'requirements');
    expect(remediationEvent?.invalidated?.map((item) => item.stageId)).toContain('technical_design');
    expect(remediationEvent?.invalidated?.map((item) => item.stageId)).toContain('documentation');
    expect(autoReworkEvent?.maxPasses).toBe(5);
    expect(autoReworkEvent?.invalidated?.map((item) => item.stageId)).toContain('technical_design');
    expect(broadcasts.some((m) => m.type === 'cross_verify_done')).toBe(true);
  });

  it('验收返工阶段自身硬证据仍不足时会暂停,等待用户续跑', async () => {
    const ack = JSON.stringify({ agree: true, reasoning: '同意', suggestions: [], critical_issues: [] });
    const makeAdapter = (id) => ({
      id,
      displayName: id,
      async chat(messages) {
        const prompt = messages[messages.length - 1]?.content || '';
        if (prompt.includes('评审输出')) return { reply: ack, tokensIn: 1, tokensOut: 1 };
        return { reply: `# ${id} 仍缺硬证据\n本步未写文件`, tokensIn: 1, tokensOut: 1 };
      },
    });
    const adapterA = makeAdapter('acceptance-resume-a');
    const adapterB = makeAdapter('acceptance-resume-b');
    const taskList = buildClusterEngineeringTaskList('做一个游戏项目').slice(0, 10);
    const makeArtifact = (stageId, gateStatus = 'passed') => ({
      stageId,
      gates: [{ status: gateStatus }],
      evidenceRequirement: { required: false, status: 'not_required' },
      evidence: [{ memberId: 'a#1', signals: ['natural_language_only'] }],
      signoffs: [{ memberId: 'a#1', agree: true }, { memberId: 'b#2', agree: true }],
      risks: [],
    });
    for (const task of taskList.slice(0, 9)) {
      task.status = 'done';
      task.consensus = { finalPlan: `# ${task.stageLabel} 已完成`, stageArtifact: makeArtifact(task.stageId) };
      task.stageArtifact = task.consensus.stageArtifact;
    }
    const brokenTask = taskList.find((task) => task.stageId === 'implementation');
    brokenTask.consensus.stageArtifact = makeArtifact('implementation', 'failed');
    brokenTask.stageArtifact = brokenTask.consensus.stageArtifact;

    store._rooms.set('cv-acceptance-resume', {
      id: 'cv-acceptance-resume', mode: 'cross_verify', cwd: '/tmp',
      members: [{ adapterId: adapterA.id, enabled: true }, { adapterId: adapterB.id, enabled: true }],
      taskList,
    });
    const adapters = new Map([[adapterA.id, adapterA], [adapterB.id, adapterB]]);
    const d = new CrossVerifyDispatcher({ store, adapters, broadcast: (id, msg) => broadcasts.push(msg) });

    await d.start('cv-acceptance-resume', '做一个游戏项目');

    const room = store._rooms.get('cv-acceptance-resume');
    const implementationTask = room.taskList.find((task) => task.stageId === 'implementation');
    const acceptanceTask = room.taskList.find((task) => task.stageId === 'acceptance');
    expect(room.status).toBe('paused');
    expect(room.acceptanceAutoRemediations).toBe(1);
    expect(room.acceptanceRemediationHistory).toHaveLength(1);
    expect(room.acceptanceRemediationHistory[0]).toMatchObject({
      automatic: true,
      targetStageId: 'implementation',
      verdict: 'failed',
    });
    expect(room.clusterWorkflowAudit.overallStatus).toBe('blocked');
    expect(implementationTask.status).toBe('escalated');
    expect(implementationTask.blocking).toBe(true);
    expect(implementationTask.escalateReason).toContain('代码驱动证据不足');
    expect(acceptanceTask.status).toBe('pending');
    const autoReworkEvent = broadcasts.find((m) => m.type === 'cv_acceptance_auto_rework' && m.stageId === 'implementation');
    expect(autoReworkEvent?.maxPasses).toBe(5);
    expect(autoReworkEvent?.invalidated?.map((item) => item.stageId)).toContain('unit_test');
    expect(broadcasts.some((m) => m.type === 'cv_quality_gate_failed' && m.stageId === 'implementation')).toBe(true);
    expect(broadcasts.some((m) => m.type === 'cross_verify_paused' && m.reason === 'quality_gate_failed')).toBe(true);
  });

  it('关键阶段首轮证据不足时会自动修复,修复成功后继续后续阶段', async () => {
    const ack = JSON.stringify({ agree: true, reasoning: '同意', suggestions: [], critical_issues: [] });
    const fixedPlan = '# 修复后方案\nnpm test -- tests/unit/example.test.js\n### 文件落地验证\ncat src/example.js';
    const makeRepairAdapter = (id) => ({
      id,
      displayName: id,
      async chat(messages) {
        const prompt = messages[messages.length - 1]?.content || '';
        if (prompt.includes('评审输出')) return { reply: ack, tokensIn: 1, tokensOut: 1 };
        if (prompt.includes('当前阶段: 代码开发') && !prompt.includes('质量门自动修复要求')) {
          return { reply: '# 首轮只有自然语言方案', tokensIn: 1, tokensOut: 1 };
        }
        return { reply: fixedPlan, tokensIn: 1, tokensOut: 1 };
      },
    });
    const adapterA = makeRepairAdapter('repair-a');
    const adapterB = makeRepairAdapter('repair-b');
    const taskList = buildClusterEngineeringTaskList('做一个游戏项目').slice(0, 6);
    store._rooms.set('cv-quality-repair-ok', {
      id: 'cv-quality-repair-ok', mode: 'cross_verify', cwd: '/tmp',
      members: [{ adapterId: adapterA.id, enabled: true }, { adapterId: adapterB.id, enabled: true }],
      taskList,
    });
    const adapters = new Map([[adapterA.id, adapterA], [adapterB.id, adapterB]]);
    const d = new CrossVerifyDispatcher({ store, adapters, broadcast: (id, msg) => broadcasts.push(msg) });

    await d.start('cv-quality-repair-ok', '做一个游戏项目');

    const room = store._rooms.get('cv-quality-repair-ok');
    const implementationTask = room.taskList.find((task) => task.stageId === 'implementation');
    const unitTestTask = room.taskList.find((task) => task.stageId === 'unit_test');
    expect(room.status).toBe('done');
    expect(room.clusterWorkflowAudit).toMatchObject({
      overallStatus: 'complete',
      counts: { blocking: 0 },
    });
    expect(implementationTask.status).toBe('done');
    expect(implementationTask.blocking).toBe(false);
    expect(implementationTask.qualityGateRepairs).toBe(1);
    expect(implementationTask.consensus.totalRounds).toBe(2);
    expect(implementationTask.consensus.stageArtifact.evidenceRequirement.status).toBe('passed');
    expect(unitTestTask.status).toBe('done');
    expect(broadcasts.some((m) => m.type === 'cv_quality_gate_repair')).toBe(true);
    expect(broadcasts.some((m) => m.type === 'cross_verify_done')).toBe(true);
  });

  it('质量门失败暂停后 resume 会带失败原因继续修复并跑完后续阶段', async () => {
    const ack = JSON.stringify({ agree: true, reasoning: '同意', suggestions: [], critical_issues: [] });
    let mode = 'weak';
    const prompts = [];
    const makeResumeAdapter = (id) => ({
      id,
      displayName: id,
      async chat(messages) {
        const prompt = messages[messages.length - 1]?.content || '';
        prompts.push(prompt);
        if (prompt.includes('评审输出')) return { reply: ack, tokensIn: 1, tokensOut: 1 };
        if (mode === 'weak' && prompt.includes('当前阶段: 代码开发')) {
          return { reply: '# 仍然只有自然语言方案', tokensIn: 1, tokensOut: 1 };
        }
        return { reply: '# 修复后方案\nnpm test -- tests/unit/example.test.js\n### 文件落地验证\ncat src/example.js', tokensIn: 1, tokensOut: 1 };
      },
    });
    const adapterA = makeResumeAdapter('resume-a');
    const adapterB = makeResumeAdapter('resume-b');
    const taskList = buildClusterEngineeringTaskList('做一个游戏项目').slice(0, 6);
    store._rooms.set('cv-quality-resume', {
      id: 'cv-quality-resume', mode: 'cross_verify', cwd: '/tmp',
      members: [{ adapterId: adapterA.id, enabled: true }, { adapterId: adapterB.id, enabled: true }],
      taskList,
    });
    const adapters = new Map([[adapterA.id, adapterA], [adapterB.id, adapterB]]);
    const d = new CrossVerifyDispatcher({ store, adapters, broadcast: (id, msg) => broadcasts.push(msg) });

    await d.start('cv-quality-resume', '做一个游戏项目');
    expect(store._rooms.get('cv-quality-resume').status).toBe('paused');
    expect(store._rooms.get('cv-quality-resume').taskList.find((task) => task.stageId === 'implementation').blocking).toBe(true);

    mode = 'fixed';
    await d.resume('cv-quality-resume');

    const room = store._rooms.get('cv-quality-resume');
    const implementationTask = room.taskList.find((task) => task.stageId === 'implementation');
    const unitTestTask = room.taskList.find((task) => task.stageId === 'unit_test');
    expect(room.status).toBe('done');
    expect(room.clusterWorkflowAudit.overallStatus).toBe('complete');
    expect(implementationTask.status).toBe('done');
    expect(implementationTask.blocking).toBe(false);
    expect(implementationTask.consensus.stageArtifact.evidenceRequirement.status).toBe('passed');
    expect(unitTestTask.status).toBe('done');
    expect(broadcasts.some((m) => m.type === 'cv_quality_gate_resume')).toBe(true);
    expect(prompts.some((prompt) => prompt.includes('质量门自动修复要求') && prompt.includes('代码驱动证据不足'))).toBe(true);
  });

  it('buildClusterEngineeringTaskList:每个阶段都有可执行契约', () => {
    const tasks = buildClusterEngineeringTaskList('项目目标');
    expect(tasks).toHaveLength(11);
    expect(tasks[0]).toMatchObject({ id: 'CE01', stageId: 'idea', stageIndex: 1, status: 'pending' });
    expect(tasks[0].desc).toContain('交付物');
    expect(tasks[0].desc).toContain('完成门槛');
    expect(tasks[10]).toMatchObject({ id: 'CE11', stageId: 'retrospective', stageIndex: 11 });
  });

  it('buildClusterStageArtifact:把阶段交付物/证据/签字/风险结构化保存', () => {
    const task = buildClusterEngineeringTaskList('项目目标')[5];
    const artifact = buildClusterStageArtifact(task, [
      { memberId: 'gpt#1', adapterId: 'gpt', displayName: 'GPT', plan: '执行 npm test -- tests/unit/a.test.js\n### 文件落地验证\ncat src/a.js' },
      { memberId: 'claude#2', adapterId: 'claude', displayName: 'Claude', plan: '本步未写文件' },
    ], [
      { memberId: 'gpt#1', adapterId: 'gpt', displayName: 'GPT', ack: { agree: true, reasoning: '通过', suggestions: ['补 e2e'] } },
      { memberId: 'claude#2', adapterId: 'claude', displayName: 'Claude', ack: { agree: true, reasoning: '通过', critical_issues: [] } },
    ]);
    expect(artifact).toMatchObject({
      stageId: 'unit_test',
      stageLabel: '单元测试',
      stageIndex: 6,
      gates: [{ status: 'passed' }],
    });
    expect(artifact.deliverables[0]).toContain('单测');
    expect(artifact.evidence[0].signals).toEqual(expect.arrayContaining(['filesystem_evidence', 'command_evidence']));
    expect(artifact.evidence[0].commands[0]).toContain('npm test');
    expect(artifact.evidence[0].fileChecks[0]).toContain('cat src/a.js');
    expect(artifact.evidence[1].signals).toContain('declared_no_file_write');
    expect(artifact.evidenceRequirement).toMatchObject({ required: true, status: 'passed' });
    expect(artifact.signoffs).toHaveLength(2);
    expect(artifact.risks).toContain('补 e2e');
  });

  it('代码驱动阶段缺少硬证据时自动标为 evidence insufficient', () => {
    const tasks = buildClusterEngineeringTaskList('项目目标');
    const implementationTask = tasks.find((task) => task.stageId === 'implementation');
    implementationTask.status = 'done';
    implementationTask.stageArtifact = buildClusterStageArtifact(implementationTask, [
      { memberId: 'gpt#1', adapterId: 'gpt', displayName: 'GPT', plan: '这里只描述方案,没有命令也没有文件证据' },
    ], [
      { memberId: 'gpt#1', adapterId: 'gpt', displayName: 'GPT', ack: { agree: true, reasoning: '同意' } },
    ]);
    const acceptanceTask = tasks.find((task) => task.stageId === 'unit_test');
    const report = buildClusterAcceptanceReport(tasks.slice(0, 6), acceptanceTask);
    const implementationItem = report.items.find((item) => item.stageId === 'implementation');

    expect(implementationTask.stageArtifact.evidenceRequirement).toMatchObject({
      required: true,
      status: 'insufficient',
    });
    expect(implementationItem.verdict).toBe('insufficient');
    expect(implementationItem.evidenceSignals).toContain('natural_language_only');
  });

  it('buildClusterAcceptanceReport:自动核对前序阶段账本并给出验收判定', () => {
    const tasks = buildClusterEngineeringTaskList('项目目标').slice(0, 4);
    tasks[0].status = 'done';
    tasks[0].stageArtifact = {
      deliverables: ['目标说明'],
      gates: [{ label: '目标一致', status: 'passed' }],
      evidence: [{ memberId: 'a#1', signals: ['natural_language_only'] }],
      signoffs: [{ memberId: 'a#1', agree: true }],
      risks: [],
    };
    tasks[1].status = 'done';
    tasks[1].stageArtifact = {
      deliverables: ['需求清单'],
      gates: [{ label: '需求可验收', status: 'passed' }],
      evidence: [{ memberId: 'a#1', signals: ['filesystem_evidence'] }],
      signoffs: [{ memberId: 'a#1', agree: true }],
      risks: ['仍需补 e2e'],
    };
    tasks[2].status = 'done';
    tasks[2].stageArtifact = {
      deliverables: ['技术方案'],
      gates: [{ label: '方案可落地', status: 'pending' }],
      evidence: [],
      signoffs: [{ memberId: 'a#1', agree: true }],
      risks: [],
    };
    const report = buildClusterAcceptanceReport(tasks, tasks[3]);

    expect(report.scopeStageCount).toBe(3);
    expect(report.items.map((item) => item.verdict)).toEqual(['passed', 'passed_with_risks', 'failed']);
    expect(report.summary).toMatchObject({ total: 3, passed: 1, passed_with_risks: 1, failed: 1 });
    expect(report.items[1].riskCount).toBe(1);
    expect(report.items[1].evidenceSignals).toContain('filesystem_evidence');
  });

  it('buildClusterRetrospectiveReport:把失败/风险/弱证据转成优化 backlog', () => {
    const tasks = buildClusterEngineeringTaskList('项目目标').slice(0, 4);
    tasks[0].status = 'done';
    tasks[0].stageArtifact = {
      deliverables: ['目标说明'],
      gates: [{ label: '目标一致', status: 'passed' }],
      evidence: [{ memberId: 'a#1', signals: ['natural_language_only'] }],
      signoffs: [{ memberId: 'a#1', agree: true }],
      risks: [],
    };
    tasks[1].status = 'done';
    tasks[1].stageArtifact = {
      deliverables: ['需求清单'],
      gates: [{ label: '需求可验收', status: 'passed' }],
      evidence: [{ memberId: 'a#1', signals: ['filesystem_evidence'] }],
      signoffs: [{ memberId: 'a#1', agree: true }],
      risks: ['需求边界仍需补充'],
    };
    tasks[2].status = 'done';
    tasks[2].stageArtifact = {
      deliverables: ['技术方案'],
      gates: [{ label: '方案可落地', status: 'pending' }],
      evidence: [],
      signoffs: [{ memberId: 'a#1', agree: true }],
      risks: [],
    };
    const report = buildClusterRetrospectiveReport(tasks, tasks[3]);

    expect(report.scopeStageCount).toBe(3);
    expect(report.summary.totalBacklog).toBeGreaterThanOrEqual(3);
    expect(report.summary.byPriority.P0).toBeGreaterThanOrEqual(1);
    expect(report.backlog.map((item) => item.kind)).toEqual(expect.arrayContaining([
      'replace_weak_evidence',
      'resolve_risk',
      'fix_failed_gate',
    ]));
  });

  it('buildClusterDeliveryPackage:生成可归档交付包索引', () => {
    const manifest = {
      mode: 'cluster_collaboration',
      roomId: 'room-1',
      topic: '项目目标',
      readyForDelivery: true,
      fingerprint: 'a'.repeat(64),
      deliveryGate: { status: 'passed', blockers: [] },
      objectiveCompletionAudit: { status: 'passed', passedCount: 6, total: 6, items: [] },
      evidenceCoverage: { codeDrivenStageCount: 4 },
      evidenceIntegrity: { status: 'declared_hard_evidence', declaredHardEvidenceStageCount: 4, verifiedRunEvidenceStageCount: 0 },
      evidenceMatrix: [],
      memberSignoffMatrix: [],
      remediation: { history: [] },
    };

    const pkg = buildClusterDeliveryPackage(manifest, '# 集群协同交付报告');

    expect(pkg).toMatchObject({
      packageVersion: 'cluster-delivery-package-v1',
      status: 'ready',
      readyForArchive: true,
      manifestFingerprint: manifest.fingerprint,
      deliveryGateStatus: 'passed',
      objectiveCompletionAudit: {
        status: 'passed',
        passedCount: 6,
        total: 6,
      },
      evidenceIntegrity: {
        status: 'declared_hard_evidence',
        declaredHardEvidenceStageCount: 4,
        verifiedRunEvidenceStageCount: 0,
        requiresAgentRunBinding: true,
      },
    });
    expect(pkg.artifacts).toHaveLength(2);
    expect(pkg.artifacts.map((item) => item.kind)).toEqual([
      'delivery_manifest_json',
      'delivery_report_markdown',
    ]);
    expect(pkg.artifacts[0].filename).toContain('room-1-cluster-delivery-aaaaaaaaaaaa.json');
    expect(pkg.artifacts[1].filename).toContain('room-1-cluster-report-aaaaaaaaaaaa.md');
    expect(pkg.reportFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(pkg.archivePlan.requiredArtifacts).toEqual([
      'delivery_manifest_json',
      'delivery_report_markdown',
    ]);
    expect(pkg.archivePlan.objectiveCompletionAuditIncluded).toBe(true);
  });

  it('buildClusterDeliveryManifest:识别已绑定的 Agent Run 阶段证据', () => {
    const tasks = buildClusterEngineeringTaskList('项目目标');
    for (const task of tasks) {
      task.status = 'done';
      task.stageArtifact = {
        gates: [{ status: 'passed' }],
        evidenceRequirement: { required: Boolean(task.stageId && ['implementation', 'unit_test', 'integration_test', 'functional_validation'].includes(task.stageId)), status: 'passed' },
        evidence: [{ memberId: 'a#1', signals: ['command_evidence'], commands: ['npm test'] }],
        signoffs: [{ memberId: 'a#1', agree: true }, { memberId: 'b#2', agree: true }],
        risks: [],
      };
      task.consensus = { finalPlan: `# ${task.stageLabel}`, stageArtifact: task.stageArtifact };
    }
    const audit = buildClusterWorkflowAudit(tasks);
    const manifest = buildClusterDeliveryManifest({
      room: {
        id: 'room-agent-run-links',
        topic: '项目目标',
        members: [{ enabled: true }, { enabled: true }],
        clusterEvidenceLinks: [
          { verified: true, stageId: 'implementation', stageLabel: '代码开发', agentRunId: 'run-1', evidenceCount: 2, toolResultCount: 1, archiveCount: 0, artifactCount: 1 },
          { verified: true, stageId: 'unit_test', stageLabel: '单元测试', agentRunId: 'run-2', evidenceCount: 1, toolResultCount: 1, archiveCount: 0, artifactCount: 0 },
        ],
      },
      taskList: tasks,
      audit,
      topic: '项目目标',
    });

    expect(manifest.evidenceIntegrity).toMatchObject({
      status: 'mixed',
      verifiedRunEvidenceStageCount: 2,
    });
    expect(manifest.evidenceIntegrity.verifiedRunEvidenceStages).toEqual(['implementation', 'unit_test']);
    expect(manifest.evidenceIntegrity.verifiedRunEvidenceLinks[0]).toMatchObject({
      stageId: 'implementation',
      agentRunId: 'run-1',
      evidenceCount: 2,
    });
    expect(manifest.readyForDelivery).toBe(false);
    expect(manifest.deliveryGate.blockers).toContain('agent_run_evidence_incomplete=2/4');
    expect(manifest.objectiveCompletionAudit.items.find((item) => item.id === 'code_driven_evidence')?.blockers).toContain('agent_run_evidence_incomplete');
  });

  it('buildClusterDeliveryManifest:非代码阶段 Agent Run 证据不能替代代码驱动阶段', () => {
    const tasks = buildClusterEngineeringTaskList('项目目标');
    for (const task of tasks) {
      task.status = 'done';
      task.stageArtifact = {
        gates: [{ status: 'passed' }],
        evidenceRequirement: { required: Boolean(task.stageId && ['implementation', 'unit_test', 'integration_test', 'functional_validation'].includes(task.stageId)), status: 'passed' },
        evidence: [{ memberId: 'a#1', signals: ['command_evidence'], commands: ['npm test'] }],
        signoffs: [{ memberId: 'a#1', agree: true }, { memberId: 'b#2', agree: true }],
        risks: [],
      };
      if (task.stageId === 'acceptance') {
        task.stageArtifact.acceptanceRequirement = { status: 'passed' };
        task.stageArtifact.acceptanceReport = { summary: { total: 11, passed: 11, passed_with_risks: 0, insufficient: 0, failed: 0 } };
      }
      task.consensus = { finalPlan: `# ${task.stageLabel}`, stageArtifact: task.stageArtifact };
    }
    const audit = buildClusterWorkflowAudit(tasks);
    const manifest = buildClusterDeliveryManifest({
      room: {
        id: 'room-agent-run-wrong-stage',
        topic: '项目目标',
        members: [{ enabled: true }, { enabled: true }],
        clusterEvidenceLinks: [
          { verified: true, stageId: 'idea', stageLabel: '用户想法', agentRunId: 'run-idea', evidenceCount: 1, toolResultCount: 1 },
          { verified: true, stageId: 'requirements', stageLabel: '需求分析与拆解', agentRunId: 'run-req', evidenceCount: 1, toolResultCount: 1 },
          { verified: true, stageId: 'technical_design', stageLabel: '技术方案设计', agentRunId: 'run-design', evidenceCount: 1, toolResultCount: 1 },
          { verified: true, stageId: 'task_planning', stageLabel: '任务分配与排期', agentRunId: 'run-plan', evidenceCount: 1, toolResultCount: 1 },
        ],
      },
      taskList: tasks,
      audit,
      topic: '项目目标',
    });

    expect(manifest.evidenceIntegrity).toMatchObject({
      status: 'declared_hard_evidence',
      verifiedRunEvidenceStageCount: 0,
      nonCodeVerifiedRunEvidenceStageCount: 4,
    });
    expect(manifest.evidenceIntegrity.verifiedRunEvidenceStages).toEqual([]);
    expect(manifest.evidenceIntegrity.nonCodeVerifiedRunEvidenceStages).toEqual([
      'idea',
      'requirements',
      'technical_design',
      'task_planning',
    ]);
    expect(manifest.readyForDelivery).toBe(false);
    expect(manifest.deliveryGate.blockers).toContain('agent_run_evidence_incomplete=0/4');
  });

  it('buildClusterDeliveryManifest:代码驱动阶段全部绑定 Agent Run 后才允许交付', () => {
    const tasks = buildClusterEngineeringTaskList('项目目标');
    for (const task of tasks) {
      task.status = 'done';
      task.stageArtifact = {
        gates: [{ status: 'passed' }],
        evidenceRequirement: { required: Boolean(task.stageId && ['implementation', 'unit_test', 'integration_test', 'functional_validation'].includes(task.stageId)), status: 'passed' },
        evidence: [{ memberId: 'a#1', signals: ['command_evidence'], commands: ['npm test'] }],
        signoffs: [{ memberId: 'a#1', agree: true }, { memberId: 'b#2', agree: true }],
        risks: [],
      };
      if (task.stageId === 'acceptance') {
        task.stageArtifact.acceptanceRequirement = { status: 'passed' };
        task.stageArtifact.acceptanceReport = { summary: { total: 11, passed: 11, passed_with_risks: 0, insufficient: 0, failed: 0 } };
      }
      task.consensus = { finalPlan: `# ${task.stageLabel}`, stageArtifact: task.stageArtifact };
    }
    const audit = buildClusterWorkflowAudit(tasks);
    const manifest = buildClusterDeliveryManifest({
      room: {
        id: 'room-agent-run-complete',
        topic: '项目目标',
        members: [{ enabled: true }, { enabled: true }],
        clusterEvidenceLinks: [
          { verified: true, stageId: 'implementation', stageLabel: '代码开发', agentRunId: 'run-1', evidenceCount: 2, toolResultCount: 1, archiveCount: 0, artifactCount: 1 },
          { verified: true, stageId: 'unit_test', stageLabel: '单元测试', agentRunId: 'run-2', evidenceCount: 1, toolResultCount: 1, archiveCount: 0, artifactCount: 0 },
          { verified: true, stageId: 'integration_test', stageLabel: '集成测试', agentRunId: 'run-3', evidenceCount: 1, toolResultCount: 1, archiveCount: 0, artifactCount: 0 },
          { verified: true, stageId: 'functional_validation', stageLabel: '功能验证', agentRunId: 'run-4', evidenceCount: 1, toolResultCount: 1, archiveCount: 0, artifactCount: 0 },
        ],
      },
      taskList: tasks,
      audit,
      topic: '项目目标',
    });

    expect(manifest.readyForDelivery).toBe(true);
    expect(manifest.deliveryGate.status).toBe('passed');
    expect(manifest.deliveryGate.blockers).not.toContain('agent_run_evidence_incomplete=2/4');
    expect(manifest.evidenceIntegrity).toMatchObject({
      status: 'agent_run_verified',
      verifiedRunEvidenceStageCount: 4,
    });
    expect(manifest.objectiveCompletionAudit.items.find((item) => item.id === 'code_driven_evidence')?.passed).toBe(true);
  });

  it('buildClusterDeliveryManifest:忽略零证据或失败状态的历史 Agent Run 链接', () => {
    const tasks = buildClusterEngineeringTaskList('项目目标');
    for (const task of tasks) {
      task.status = 'done';
      task.stageArtifact = {
        gates: [{ status: 'passed' }],
        evidenceRequirement: { required: Boolean(task.stageId && ['implementation', 'unit_test', 'integration_test', 'functional_validation'].includes(task.stageId)), status: 'passed' },
        evidence: [{ memberId: 'a#1', signals: ['command_evidence'], commands: ['npm test'] }],
        signoffs: [{ memberId: 'a#1', agree: true }, { memberId: 'b#2', agree: true }],
        risks: [],
      };
      if (task.stageId === 'acceptance') {
        task.stageArtifact.acceptanceRequirement = { status: 'passed' };
        task.stageArtifact.acceptanceReport = { summary: { total: 11, passed: 11, passed_with_risks: 0, insufficient: 0, failed: 0 } };
      }
      task.consensus = { finalPlan: `# ${task.stageLabel}`, stageArtifact: task.stageArtifact };
    }
    const audit = buildClusterWorkflowAudit(tasks);
    const manifest = buildClusterDeliveryManifest({
      room: {
        id: 'room-agent-run-dirty-links',
        topic: '项目目标',
        members: [{ enabled: true }, { enabled: true }],
        clusterEvidenceLinks: [
          { verified: true, stageId: 'implementation', stageLabel: '代码开发', agentRunId: 'run-1', runStatus: 'succeeded', evidenceCount: 1, toolResultCount: 1 },
          { verified: true, stageId: 'unit_test', stageLabel: '单元测试', agentRunId: 'run-2', runStatus: 'failed', evidenceCount: 1, toolResultCount: 1 },
          { verified: true, stageId: 'integration_test', stageLabel: '集成测试', agentRunId: 'run-3', runStatus: 'succeeded', evidenceCount: 0, toolResultCount: 0, archiveCount: 0, artifactCount: 0 },
          { verified: true, stageId: 'functional_validation', stageLabel: '功能验证', agentRunId: 'run-4', runStatus: 'succeeded', evidenceCount: 1, toolResultCount: 1 },
        ],
      },
      taskList: tasks,
      audit,
      topic: '项目目标',
    });

    expect(manifest.readyForDelivery).toBe(false);
    expect(manifest.evidenceIntegrity).toMatchObject({
      status: 'mixed',
      verifiedRunEvidenceStageCount: 2,
    });
    expect(manifest.evidenceIntegrity.verifiedRunEvidenceStages).toEqual(['implementation', 'functional_validation']);
    expect(manifest.deliveryGate.blockers).toContain('agent_run_evidence_incomplete=2/4');
  });

  it('buildClusterObjectiveCompletionAudit:缺证据时给出阻断项', () => {
    const audit = buildClusterObjectiveCompletionAudit({
      topic: '',
      stages: [{ stageId: 'idea', status: 'pending' }],
      requiredStageIds: ['idea', 'requirements'],
      presentStageIds: new Set(['idea']),
      readyForDelivery: false,
      deliveryBlockers: ['workflow_status=incomplete'],
      evidenceCoverage: { codeDrivenStageCount: 4, codeDrivenCoveredStageCount: 2 },
      memberSignoffMatrix: [{ stageId: 'idea', expectedMemberCount: 2, complete: false }],
      acceptanceSummary: { total: 1, failed: 1, insufficient: 0 },
      acceptanceRequirementStatus: 'failed',
      remediationSummary: null,
    });

    expect(audit.status).toBe('blocked');
    expect(audit.passedCount).toBeLessThan(audit.total);
    expect(audit.items.find((item) => item.id === 'single_project_goal')?.blockers).toContain('topic_missing');
    expect(audit.items.find((item) => item.id === 'code_driven_evidence')?.blockers).toContain('code_driven_stage_evidence_incomplete');
  });

  it('buildClusterRetrospectiveReport:把验收返工历史转成复盘改进项', () => {
    const tasks = buildClusterEngineeringTaskList('项目目标');
    for (const task of tasks.slice(0, 10)) {
      task.status = 'done';
      task.stageArtifact = {
        gates: [{ status: 'passed' }],
        evidenceRequirement: { required: false, status: 'not_required' },
        evidence: [{ memberId: 'a#1', signals: ['command_evidence'] }],
        signoffs: [{ memberId: 'a#1', agree: true }],
        risks: [],
      };
      task.consensus = { finalPlan: `# ${task.stageLabel}`, stageArtifact: task.stageArtifact };
    }
    const acceptanceTask = tasks.find((task) => task.stageId === 'acceptance');
    acceptanceTask.remediationHistory = [{
      automatic: true,
      targetStageId: 'requirements',
      targetStageLabel: '需求分析与拆解',
      verdict: 'failed',
      reason: '验收失败自动返工',
      invalidated: [
        { stageId: 'technical_design', stageLabel: '技术方案设计' },
        { stageId: 'task_planning', stageLabel: '任务分配与排期' },
        { stageId: 'implementation', stageLabel: '代码开发' },
        { stageId: 'unit_test', stageLabel: '单元测试' },
      ],
    }];

    const report = buildClusterRetrospectiveReport(tasks, tasks.find((task) => task.stageId === 'retrospective'));

    expect(report.backlog.some((item) => item.kind === 'stabilize_acceptance_rework_loop')).toBe(true);
    expect(report.backlog.some((item) => item.kind === 'reduce_downstream_rework_churn')).toBe(true);
    expect(report.backlog.find((item) => item.kind === 'reduce_downstream_rework_churn')?.priority).toBe('P1');
  });

  it('后续阶段 prompt 会继承前序阶段共识链', async () => {
    const prompts = [];
    const adapterA = makeRecordingAdapter('agent-a', prompts);
    const adapterB = makeRecordingAdapter('agent-b', prompts);
    const taskList = buildClusterEngineeringTaskList('做一个游戏项目').slice(0, 2);
    store._rooms.set('cv-stage-memory', {
      id: 'cv-stage-memory', mode: 'cross_verify', cwd: '/tmp',
      members: [{ adapterId: adapterA.id, enabled: true }, { adapterId: adapterB.id, enabled: true }],
      taskList,
    });
    const adapters = new Map([[adapterA.id, adapterA], [adapterB.id, adapterB]]);
    const d = new CrossVerifyDispatcher({ store, adapters, broadcast: (id, msg) => broadcasts.push(msg) });

    await d.start('cv-stage-memory', '做一个游戏项目');

    const room = store._rooms.get('cv-stage-memory');
    expect(room.taskList).toHaveLength(2);
    expect(room.taskList.every((task) => task.status === 'done')).toBe(true);
    expect(buildPriorStageContext(room.taskList, room.taskList[1])).toContain('FIRST_STAGE_CONSENSUS_MARKER');
    expect(buildPriorStageContext(room.taskList, room.taskList[1])).toContain('结构化交付物账本');
    expect(buildPriorStageContext(room.taskList, room.taskList[1])).toContain('command_evidence');
    expect(prompts.some((prompt) => (
      prompt.includes('前序阶段共识链') &&
      prompt.includes('FIRST_STAGE_CONSENSUS_MARKER') &&
      prompt.includes('结构化交付物账本') &&
      prompt.includes('不得无理由推翻')
    ))).toBe(true);
  });

  it('交付验收阶段 prompt 会收到系统自动验收表', async () => {
    const prompts = [];
    const adapterA = makeRecordingAdapter('agent-a', prompts);
    const adapterB = makeRecordingAdapter('agent-b', prompts);
    const taskList = buildClusterEngineeringTaskList('做一个游戏项目').slice(0, 10);
    store._rooms.set('cv-acceptance-report', {
      id: 'cv-acceptance-report', mode: 'cross_verify', cwd: '/tmp',
      members: [{ adapterId: adapterA.id, enabled: true }, { adapterId: adapterB.id, enabled: true }],
      taskList,
    });
    const adapters = new Map([[adapterA.id, adapterA], [adapterB.id, adapterB]]);
    const d = new CrossVerifyDispatcher({ store, adapters, broadcast: (id, msg) => broadcasts.push(msg) });

    await d.start('cv-acceptance-report', '做一个游戏项目');

    const room = store._rooms.get('cv-acceptance-report');
    const acceptanceTask = room.taskList[9];
    expect(acceptanceTask.stageId).toBe('acceptance');
    expect(acceptanceTask.acceptanceReport.summary.total).toBe(9);
    expect(acceptanceTask.consensus.stageArtifact.acceptanceReport.summary.total).toBe(9);
    expect(prompts.some((prompt) => (
      prompt.includes('系统自动验收表') &&
      prompt.includes('"scopeStageCount": 9') &&
      prompt.includes('"stageId": "idea"')
    ))).toBe(true);
  });

  it('复盘优化阶段 prompt 会收到系统自动改进 backlog', async () => {
    const prompts = [];
    const adapterA = makeRecordingAdapter('agent-a', prompts);
    const adapterB = makeRecordingAdapter('agent-b', prompts);
    const taskList = buildClusterEngineeringTaskList('做一个游戏项目');
    store._rooms.set('cv-retrospective-report', {
      id: 'cv-retrospective-report', mode: 'cross_verify', cwd: '/tmp',
      members: [{ adapterId: adapterA.id, enabled: true }, { adapterId: adapterB.id, enabled: true }],
      taskList,
    });
    const adapters = new Map([[adapterA.id, adapterA], [adapterB.id, adapterB]]);
    const d = new CrossVerifyDispatcher({ store, adapters, broadcast: (id, msg) => broadcasts.push(msg) });

    await d.start('cv-retrospective-report', '做一个游戏项目');

    const room = store._rooms.get('cv-retrospective-report');
    const retrospectiveTask = room.taskList[10];
    expect(retrospectiveTask.stageId).toBe('retrospective');
    expect(retrospectiveTask.retrospectiveReport.scopeStageCount).toBe(10);
    expect(retrospectiveTask.consensus.stageArtifact.retrospectiveReport.scopeStageCount).toBe(10);
    expect(prompts.some((prompt) => (
      prompt.includes('系统自动复盘改进 backlog') &&
      prompt.includes('"scopeStageCount": 10') &&
      prompt.includes('"totalBacklog"')
    ))).toBe(true);
  });

  it('3 个成员第一轮都同意 → 集群协同达成一致并保留闭环阶段', async () => {
    const ack = JSON.stringify({ agree: true, reasoning: '同意', suggestions: [], critical_issues: [] });
    const adapterA = makeStubAdapter(['# A 方案', ack]);
    const adapterB = makeStubAdapter(['# B 方案', ack]);
    const adapterC = makeStubAdapter(['# C 方案', ack]);
    store._rooms.set('cv-cluster-3', {
      id: 'cv-cluster-3', mode: 'cross_verify', cwd: '/tmp',
      members: [
        { adapterId: adapterA.id, displayName: 'Claude', enabled: true },
        { adapterId: adapterB.id, displayName: 'GPT', enabled: true },
        { adapterId: adapterC.id, displayName: 'Gemini', enabled: true },
      ],
      taskList: makeSingleTaskList(),
    });
    const adapters = new Map([[adapterA.id, adapterA], [adapterB.id, adapterB], [adapterC.id, adapterC]]);
    const d = new CrossVerifyDispatcher({ store, adapters, broadcast: (id, msg) => broadcasts.push(msg) });

    await d.start('cv-cluster-3', '做一个游戏');

    const task = store._rooms.get('cv-cluster-3').taskList[0];
    expect(task.status).toBe('done');
    expect(Object.keys(task.rounds[0].proposals)).toHaveLength(3);
    expect(Object.keys(task.rounds[0].reviews)).toHaveLength(3);
    expect(task.consensus.byMembers).toHaveLength(3);
    expect(task.consensus.workflowStages).toEqual(CLUSTER_ENGINEERING_STAGES);
    expect(task.consensus.finalPlan).toContain('闭环交付流程');
    expect(broadcasts.find((m) => m.type === 'cv_consensus')?.memberCount).toBe(3);
  });

  it('同一 adapterId 的多个成员不会覆盖彼此方案', async () => {
    const ack = JSON.stringify({ agree: true, reasoning: '同意', suggestions: [], critical_issues: [] });
    const sharedAdapter = makeStubAdapter(['# Claude A 方案', '# Claude B 方案', ack, ack]);
    sharedAdapter.id = 'claude';
    store._rooms.set('cv-duplicate-adapter', {
      id: 'cv-duplicate-adapter', mode: 'cross_verify', cwd: '/tmp',
      members: [
        { adapterId: 'claude', displayName: 'Claude A', enabled: true },
        { adapterId: 'claude', displayName: 'Claude B', enabled: true },
      ],
      taskList: makeSingleTaskList(),
    });
    const adapters = new Map([['claude', sharedAdapter]]);
    const d = new CrossVerifyDispatcher({ store, adapters, broadcast: (id, msg) => broadcasts.push(msg) });

    await d.start('cv-duplicate-adapter', '同类模型双实例互审');

    const task = store._rooms.get('cv-duplicate-adapter').taskList[0];
    expect(task.status).toBe('done');
    expect(Object.keys(task.rounds[0].proposals)).toEqual(['claude#1', 'claude#2']);
    expect(task.rounds[0].proposals['claude#1']).toContain('Claude A');
    expect(task.rounds[0].proposals['claude#2']).toContain('Claude B');
    expect(task.consensus.byMembers).toEqual(['claude#1', 'claude#2']);
  });

  it('3 轮全不一致 → task.status=escalated 且阻塞房间,避免假完成', async () => {
    const planA = '# 实现 A';
    const planB = '# 实现 B(不同)';
    const ackDisagree = JSON.stringify({ agree: false, reasoning: '不一致', critical_issues: ['关键不同'] });
    // 每个 adapter 被调 6 次:3 round × (propose + review)
    const adapterA = makeStubAdapter([planA, ackDisagree, planA, ackDisagree, planA, ackDisagree]);
    const adapterB = makeStubAdapter([planB, ackDisagree, planB, ackDisagree, planB, ackDisagree]);
    store._rooms.set('cv2', {
      id: 'cv2', mode: 'cross_verify', cwd: '/tmp',
      members: [{ adapterId: adapterA.id, enabled: true }, { adapterId: adapterB.id, enabled: true }],
      taskList: makeSingleTaskList(),
    });
    const adapters = new Map([[adapterA.id, adapterA], [adapterB.id, adapterB]]);
    const d = new CrossVerifyDispatcher({ store, adapters, broadcast: (id, msg) => broadcasts.push(msg), maxRounds: 3 });

    await d.start('cv2', '写代码');

    const room = store._rooms.get('cv2');
    expect(room.status).toBe('paused');
    expect(room.taskList[0].status).toBe('escalated');
    expect(room.taskList[0].blocking).toBe(true);
    expect(room.taskList[0].escalateReason).toContain('3 轮集群未达成一致');
    expect(room.taskList[0].rounds).toHaveLength(3);
    expect(broadcasts.some((m) => m.type === 'cv_escalated')).toBe(true);
    expect(broadcasts.some((m) => m.type === 'cross_verify_paused' && m.reason === 'quality_gate_failed')).toBe(true);
  });

  it('abort 在 propose 阶段时,task.status=paused 不卡 running(确保 resume 能续跑)', async () => {
    // adapter 故意 hang 让 propose 卡住,然后 abort
    let resolveHang;
    const hangPromise = new Promise((r) => { resolveHang = r; });
    const hangAdapter = {
      id: 'hang-' + Math.random().toString(36).slice(2, 8),
      displayName: 'Hang',
      async chat(_msgs, opts) {
        // 模拟 codex spawn 中:监听 abort,abort 时 throw
        return new Promise((res, rej) => {
          opts?.abortSignal?.addEventListener('abort', () => rej(new Error('aborted')));
          hangPromise.then(() => res({ reply: 'never', tokensIn: 0, tokensOut: 0 }));
        });
      },
    };
    const adapter2 = makeStubAdapter(['xx']);
    store._rooms.set('cv-abort', {
      id: 'cv-abort', mode: 'cross_verify', cwd: '/tmp',
      members: [{ adapterId: hangAdapter.id, enabled: true }, { adapterId: adapter2.id, enabled: true }],
      taskList: makeSingleTaskList(),
    });
    const adapters = new Map([[hangAdapter.id, hangAdapter], [adapter2.id, adapter2]]);
    const d = new CrossVerifyDispatcher({ store, adapters, broadcast: (id, msg) => broadcasts.push(msg) });

    const startPromise = d.start('cv-abort', 'topic');
    // 让 dispatcher 进入 propose phase
    await new Promise((r) => setTimeout(r, 50));
    // abort
    d.abort('cv-abort');
    // 等 start promise reject
    try { await startPromise; } catch { /* expected */ }

    const room = store._rooms.get('cv-abort');
    expect(room.status).toBe('paused');
    expect(room.taskList?.[0]?.status).toBe('paused'); // 关键:task.status 不卡 running
    resolveHang?.();
  });

  it('快速 abort 后 resume 不会被旧 run 的 finally 清掉新 activeAbort', async () => {
    const ack = JSON.stringify({ agree: true, reasoning: '同意', suggestions: [], critical_issues: [] });
    let resolveFirstStarted;
    let resolveOldAbortSeen;
    let releaseOldAbort;
    let resolveSecondProposalStarted;
    let releaseSecondProposal;
    const firstStarted = new Promise((resolve) => { resolveFirstStarted = resolve; });
    const oldAbortSeen = new Promise((resolve) => { resolveOldAbortSeen = resolve; });
    const oldAbortRelease = new Promise((resolve) => { releaseOldAbort = resolve; });
    const secondProposalStarted = new Promise((resolve) => { resolveSecondProposalStarted = resolve; });
    const secondProposalRelease = new Promise((resolve) => { releaseSecondProposal = resolve; });
    let raceAdapterProposalCalls = 0;
    const raceAdapter = {
      id: 'race-resume-a',
      displayName: 'Race Resume A',
      async chat(messages, opts = {}) {
        const prompt = messages[messages.length - 1]?.content || '';
        if (prompt.includes('评审输出')) return { reply: ack, tokensIn: 1, tokensOut: 1 };
        raceAdapterProposalCalls += 1;
        if (raceAdapterProposalCalls === 1) {
          resolveFirstStarted();
          return new Promise((_resolve, reject) => {
            opts.abortSignal?.addEventListener('abort', () => {
              resolveOldAbortSeen();
              oldAbortRelease.then(() => reject(new Error('old run aborted')));
            }, { once: true });
          });
        }
        resolveSecondProposalStarted();
        await secondProposalRelease;
        if (opts.abortSignal?.aborted) throw new Error('second run aborted');
        return { reply: '# resume proposal\n继续完成任务', tokensIn: 1, tokensOut: 1 };
      },
    };
    const stableAdapter = {
      id: 'race-resume-b',
      displayName: 'Race Resume B',
      async chat(messages) {
        const prompt = messages[messages.length - 1]?.content || '';
        if (prompt.includes('评审输出')) return { reply: ack, tokensIn: 1, tokensOut: 1 };
        return { reply: '# stable proposal\n本轮同意继续', tokensIn: 1, tokensOut: 1 };
      },
    };
    store._rooms.set('cv-abort-resume-race', {
      id: 'cv-abort-resume-race',
      mode: 'cross_verify',
      cwd: '/tmp',
      members: [{ adapterId: raceAdapter.id, enabled: true }, { adapterId: stableAdapter.id, enabled: true }],
      taskList: makeSingleTaskList(),
    });
    const d = new CrossVerifyDispatcher({
      store,
      adapters: new Map([[raceAdapter.id, raceAdapter], [stableAdapter.id, stableAdapter]]),
      broadcast: (id, msg) => broadcasts.push({ roomId: id, ...msg }),
    });

    const firstRun = d.start('cv-abort-resume-race', '快速中断后续跑').catch((error) => error);
    await firstStarted;
    expect(d.abort('cv-abort-resume-race')).toBe(true);
    await oldAbortSeen;

    const resumeRun = d.resume('cv-abort-resume-race');
    await secondProposalStarted;
    expect(store._rooms.get('cv-abort-resume-race').status).toBe('running');
    expect(d.activeAborts.has('cv-abort-resume-race')).toBe(true);

    releaseOldAbort();
    const oldResult = await firstRun;
    expect(oldResult).toBeUndefined();
    expect(store._rooms.get('cv-abort-resume-race').status).toBe('running');
    expect(d.activeAborts.has('cv-abort-resume-race')).toBe(true);

    releaseSecondProposal();
    await resumeRun;

    expect(store._rooms.get('cv-abort-resume-race').status).toBe('done');
    expect(d.activeAborts.has('cv-abort-resume-race')).toBe(false);
    expect(broadcasts.some((msg) => msg.type === 'cross_verify_done')).toBe(true);
  });

  it('一方同意一方不同意 → 不算一致,进下一轮', async () => {
    const planA = '# A';
    const planB = '# B';
    const ackYes = JSON.stringify({ agree: true, reasoning: '同意' });
    const ackNo = JSON.stringify({ agree: false, reasoning: '不同意', critical_issues: ['x'] });
    // round 1: A 同意 B 但 B 不同意 A → 进 round 2
    // round 2: 双方都不同意 → 进 round 3
    // round 3: 双方都同意 → 一致
    const ackYesYes = ackYes;
    const adapterA = makeStubAdapter([planA, ackYes, planA, ackNo, planA, ackYesYes]);
    const adapterB = makeStubAdapter([planB, ackNo, planB, ackNo, planB, ackYesYes]);
    store._rooms.set('cv3', {
      id: 'cv3', mode: 'cross_verify', cwd: '/tmp',
      members: [{ adapterId: adapterA.id, enabled: true }, { adapterId: adapterB.id, enabled: true }],
      taskList: makeSingleTaskList(),
    });
    const adapters = new Map([[adapterA.id, adapterA], [adapterB.id, adapterB]]);
    const d = new CrossVerifyDispatcher({ store, adapters, broadcast: (id, msg) => broadcasts.push(msg), maxRounds: 3 });

    await d.start('cv3', '任务');

    const room = store._rooms.get('cv3');
    expect(room.taskList[0].status).toBe('done');
    expect(room.taskList[0].consensus.totalRounds).toBe(3);
    expect(broadcasts.filter((m) => m.type === 'cv_disagree')).toHaveLength(2); // round 1 和 round 2 都不一致
  });
});
