import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 底座 NoePatchApplyExecutor 会真改文件/真写报告——单测里 mock 掉，只验 executor 的串法与安全网。
vi.mock('../../src/runtime/mission/NoePatchApplyExecutor.js', () => ({
  runNoePatchApply: vi.fn(),
  runNoePatchRollback: vi.fn(),
  extractNoePatchPlan: vi.fn((value) => value),
}));

import {
  runNoePatchApply,
  runNoePatchRollback,
} from '../../src/runtime/mission/NoePatchApplyExecutor.js';
import {
  registerNoeSelfEvolutionExecutors,
  NOE_SELF_EVOLUTION_EXECUTOR_ACTIONS,
  SELF_EVOLUTION_GRANT_SCOPE,
} from '../../src/loop/NoeSelfEvolutionExecutors.js';
import { createSafeActExecutors } from '../../src/loop/SafeActExecutors.js';

function makeDeps(overrides = {}) {
  return {
    root: '/tmp/noe-self-evolution-test-root',
    evaluateGrant: vi.fn(() => ({ authorized: true, scope: SELF_EVOLUTION_GRANT_SCOPE })),
    spawnImplementer: vi.fn(async () => ({ patchPlanRef: 'output/noe-self-evolution/x/patch-plan.json' })),
    runtimeVerify: vi.fn(async () => ({ ok: true, reportRef: 'output/noe-self-evolution/runtime-verify/v1.json' })),
    memoryWrite: vi.fn(() => ({ id: 'mem-1' })),
    appendEvent: vi.fn(() => 'evt-1'),
    now: () => new Date('2026-06-14T00:00:00.000Z'),
    ...overrides,
  };
}

function makeAct(action, ctx = {}, gate = { ok: true }) {
  return {
    id: 'act-1',
    action,
    projectId: 'noe',
    payload: { selfEvolutionGate: gate, selfEvolution: ctx },
  };
}

function freshExecutors(deps) {
  return registerNoeSelfEvolutionExecutors(new Map(), deps);
}

describe('registerNoeSelfEvolutionExecutors — 注册与契约', () => {
  beforeEach(() => {
    runNoePatchApply.mockReset();
    runNoePatchRollback.mockReset();
    // 默认：dry-run 预检 ok；真实 apply 成功 applied。
    runNoePatchApply.mockImplementation(({ dryRun }) => (dryRun
      ? { ok: true, status: 'dry_run_ready', reportRef: 'dry.json' }
      : { ok: true, status: 'applied', reportRef: 'apply.json', backupManifestRef: 'backup.json', changedFiles: ['src/x.js'] }));
    runNoePatchRollback.mockImplementation(() => ({ status: 'rolled_back', reportRef: 'rollback.json' }));
  });

  it('注册四个 self_evolution executor key（与导出常量一致）', () => {
    const executors = freshExecutors(makeDeps());
    for (const action of NOE_SELF_EVOLUTION_EXECUTOR_ACTIONS) {
      expect(typeof executors.get(action)).toBe('function');
    }
    expect(NOE_SELF_EVOLUTION_EXECUTOR_ACTIONS).toContain('noe.self_evolution.implementation');
    expect(NOE_SELF_EVOLUTION_EXECUTOR_ACTIONS.length).toBe(4);
  });

  it('要求传入 Map（防误用）', () => {
    expect(() => registerNoeSelfEvolutionExecutors({}, makeDeps())).toThrow(/requires a Map/);
  });
});

describe('implementation executor — 主路径与安全网', () => {
  beforeEach(() => {
    runNoePatchApply.mockReset();
    runNoePatchRollback.mockReset();
    runNoePatchApply.mockImplementation(({ dryRun }) => (dryRun
      ? { ok: true, status: 'dry_run_ready', reportRef: 'dry.json' }
      : { ok: true, status: 'applied', reportRef: 'apply.json', backupManifestRef: 'backup.json', changedFiles: ['src/x.js'] }));
    runNoePatchRollback.mockImplementation(() => ({ status: 'rolled_back', reportRef: 'rollback.json' }));
  });

  it('成功路径：用已给 patchPlanRef → apply → verify ok → 返回 applied 引用（不泄 secret）', async () => {
    const deps = makeDeps();
    const executors = freshExecutors(deps);
    const out = await executors.get('noe.self_evolution.implementation')({
      act: makeAct('noe.self_evolution.implementation', { patchPlanRef: 'given/patch-plan.json' }),
    });
    expect(out.applied).toBe(true);
    expect(out.patchPlanRef).toBe('given/patch-plan.json');
    expect(out.applyReportRef).toBe('apply.json');
    expect(out.backupManifestRef).toBe('backup.json');
    expect(out.runtimeReportRef).toBe('output/noe-self-evolution/runtime-verify/v1.json');
    expect(out.changedFiles).toEqual(['src/x.js']);
    expect(out.secretValuesReturned).toBe(false);
    // 已给 patchPlanRef 时不应调实施者
    expect(deps.spawnImplementer).not.toHaveBeenCalled();
    // dry-run 预检 + 真实 apply 各一次
    expect(runNoePatchApply).toHaveBeenCalledTimes(2);
    expect(deps.runtimeVerify).toHaveBeenCalledTimes(1);
    expect(runNoePatchRollback).not.toHaveBeenCalled();
  });

  it('无 patchPlanRef → 调实施者生成 patch plan', async () => {
    const deps = makeDeps();
    const executors = freshExecutors(deps);
    const out = await executors.get('noe.self_evolution.implementation')({
      act: makeAct('noe.self_evolution.implementation', { objective: '改进 X' }),
    });
    expect(deps.spawnImplementer).toHaveBeenCalledTimes(1);
    expect(out.patchPlanRef).toBe('output/noe-self-evolution/x/patch-plan.json');
  });

  it('P1-5：verify 失败 → 自动 rollback 并 throw（绝不返回非 throw result 被标 completed）', async () => {
    const deps = makeDeps({ runtimeVerify: vi.fn(async () => ({ ok: false, reportRef: 'v-fail.json' })) });
    const executors = freshExecutors(deps);
    let caught = null;
    try {
      await executors.get('noe.self_evolution.implementation')({
        act: makeAct('noe.self_evolution.implementation', { patchPlanRef: 'p.json' }),
      });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toBe('self_evolution_verify_failed_rolled_back_needs_self_repair');
    expect(caught.selfEvolution.needsSelfRepair).toBe(true);
    expect(caught.selfEvolution.rolledBack).toBe(true);
    expect(caught.selfEvolution.secretValuesReturned).toBe(false);
    expect(runNoePatchRollback).toHaveBeenCalledTimes(1);
  });

  // A2 失败证据回灌(2026-07-03)：verify 失败的「原因」此前随 throw 丢失（只剩 ref），self_repair 的
  //   implementer 拿到与上次完全相同的输入 = 盲重试（实证 359 次 needs_consensus 全烧在盲猜上）。
  //   verifyReason 挂上 selfEvolution 结构化字段，经 ActPipeline 白名单透传给 trigger 存 cycle.repairHints。
  it('A2：verify 失败 throw 携带 verifyReason（reason 优先，回退 error）', async () => {
    const deps = makeDeps({ runtimeVerify: vi.fn(async () => ({ ok: false, reason: 'type_error_fix_rejected: 目标文件 error 未减少', reportRef: 'v-fail.json' })) });
    const executors = freshExecutors(deps);
    let caught = null;
    try {
      await executors.get('noe.self_evolution.implementation')({
        act: makeAct('noe.self_evolution.implementation', { patchPlanRef: 'p.json' }),
      });
    } catch (e) { caught = e; }
    expect(caught.selfEvolution.needsSelfRepair).toBe(true);
    expect(caught.selfEvolution.verifyReason).toContain('type_error_fix_rejected');
    // Perception ring: ImproveSignal attached on verify-fail path.
    expect(caught.selfEvolution.improveSignal?.signal).toBe('verify_not_green');
    expect(caught.selfEvolution.improveSignal?.hasTechnicalAnchor).toBeDefined();
  });

  it('A2：verify 无 reason 只有 error → verifyReason 用 error 兜底', async () => {
    const deps = makeDeps({ runtimeVerify: vi.fn(async () => { throw new Error('vitest spawn ENOENT'); }) });
    const executors = freshExecutors(deps);
    let caught = null;
    try {
      await executors.get('noe.self_evolution.implementation')({
        act: makeAct('noe.self_evolution.implementation', { patchPlanRef: 'p.json' }),
      });
    } catch (e) { caught = e; }
    expect(caught.selfEvolution.verifyReason).toContain('ENOENT');
  });

  it('纵深防御：gate 未放行 → throw gate_not_passed_in_executor', async () => {
    const executors = freshExecutors(makeDeps());
    await expect(executors.get('noe.self_evolution.implementation')({
      act: makeAct('noe.self_evolution.implementation', { patchPlanRef: 'p.json' }, { ok: false }),
    })).rejects.toThrow('gate_not_passed_in_executor');
  });

  it('P1-3：standing grant 未授权 → throw self_evolution_apply_requires_standing_grant', async () => {
    const deps = makeDeps({ evaluateGrant: vi.fn(() => ({ authorized: false })) });
    const executors = freshExecutors(deps);
    await expect(executors.get('noe.self_evolution.implementation')({
      act: makeAct('noe.self_evolution.implementation', { patchPlanRef: 'p.json' }),
    })).rejects.toThrow('self_evolution_apply_requires_standing_grant');
    expect(deps.evaluateGrant).toHaveBeenCalledWith({ scope: SELF_EVOLUTION_GRANT_SCOPE });
  });

  it('apply 预检失败 → throw self_evolution_apply_preflight_blocked（不进真实 apply）', async () => {
    runNoePatchApply.mockImplementation(({ dryRun }) => (dryRun
      ? { ok: false, blocked: [{ blockers: ['patch_path_blocked:.env'] }], reportRef: 'dry.json' }
      : { ok: true, status: 'applied', reportRef: 'apply.json' }));
    const executors = freshExecutors(makeDeps());
    await expect(executors.get('noe.self_evolution.implementation')({
      act: makeAct('noe.self_evolution.implementation', { patchPlanRef: 'p.json' }),
    })).rejects.toThrow('self_evolution_apply_preflight_blocked');
    // 只调了 dry-run，没进真实 apply
    expect(runNoePatchApply).toHaveBeenCalledTimes(1);
  });

  it('真实 apply 非 applied → throw self_evolution_apply_failed', async () => {
    runNoePatchApply.mockImplementation(({ dryRun }) => (dryRun
      ? { ok: true, status: 'dry_run_ready', reportRef: 'dry.json' }
      : { ok: false, status: 'blocked', errors: [{ error: 'patch_transaction_apply_failed' }], reportRef: 'apply.json' }));
    const executors = freshExecutors(makeDeps());
    await expect(executors.get('noe.self_evolution.implementation')({
      act: makeAct('noe.self_evolution.implementation', { patchPlanRef: 'p.json' }),
    })).rejects.toThrow('self_evolution_apply_failed');
  });

  // P0-2 防 reward hack：apply 落盘后再核 changedFiles，任何受 PolicyFileGuard 保护的文件（tests/ 退路等）
  //   被改 = 小模型改测试骗 verify 或绕 preflight 越权写盘 → runtimeVerify 之前 rollback + throw（纵深第二道）。
  it('P0-2 防 reward hack：apply 后 changedFiles 含测试文件 → verify 前 rollback + throw protected_file_mutated_post_apply', async () => {
    runNoePatchApply.mockImplementation(({ dryRun }) => (dryRun
      ? { ok: true, status: 'dry_run_ready', reportRef: 'dry.json' }
      : { ok: true, status: 'applied', reportRef: 'apply.json', backupManifestRef: 'backup.json', changedFiles: ['src/x.js', 'tests/unit/some.test.js'] }));
    const deps = makeDeps();
    const executors = freshExecutors(deps);
    let caught = null;
    try {
      await executors.get('noe.self_evolution.implementation')({
        act: makeAct('noe.self_evolution.implementation', { patchPlanRef: 'p.json' }),
      });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toBe('self_evolution_protected_file_mutated_post_apply');
    expect(caught.selfEvolution.mutatedProtected).toContain('tests/unit/some.test.js');
    expect(caught.selfEvolution.rolledBack).toBe(true);
    // 关键：runtimeVerify 绝不被调用（改完测试再跑出假绿的路被堵死）
    expect(deps.runtimeVerify).not.toHaveBeenCalled();
    expect(runNoePatchRollback).toHaveBeenCalledTimes(1);
  });

  it('P0-2 回归：changedFiles 全为普通源码（src/）→ 正常 verify、不 rollback（二次核不误伤）', async () => {
    const deps = makeDeps();
    const executors = freshExecutors(deps);
    const out = await executors.get('noe.self_evolution.implementation')({
      act: makeAct('noe.self_evolution.implementation', { patchPlanRef: 'p.json' }),
    });
    expect(out.applied).toBe(true);
    expect(deps.runtimeVerify).toHaveBeenCalledTimes(1);
    expect(runNoePatchRollback).not.toHaveBeenCalled();
  });
});

describe('self_repair executor', () => {
  beforeEach(() => {
    runNoePatchApply.mockReset();
    runNoePatchRollback.mockReset();
    runNoePatchApply.mockImplementation(({ dryRun }) => (dryRun
      ? { ok: true, status: 'dry_run_ready', reportRef: 'dry.json' }
      : { ok: true, status: 'applied', reportRef: 'apply.json', backupManifestRef: 'backup.json', changedFiles: ['src/x.js'] }));
    runNoePatchRollback.mockImplementation(() => ({ status: 'rolled_back', reportRef: 'rollback.json' }));
  });

  it('成功路径：先回滚上一轮失败 apply（priorApplyReportRef）再 apply+verify', async () => {
    const deps = makeDeps();
    const executors = freshExecutors(deps);
    const out = await executors.get('noe.self_evolution.self_repair')({
      act: makeAct('noe.self_evolution.self_repair', {
        patchPlanRef: 'p.json',
        priorApplyReportRef: 'prior-apply.json',
      }),
    });
    expect(out.repaired).toBe(true);
    expect(out.priorRollbackRef).toBe('rollback.json');
    // prior 回滚一次（apply+verify 成功，不再触发失败回滚）
    expect(runNoePatchRollback).toHaveBeenCalledTimes(1);
  });

  // C 锚旁路修复(2026-07-03)：self_repair 此前用裸 runtimeVerify（无 type 价值锚）——type_error goal 的
  //   repair 只要 npm test 绿就算成功，没修 error 也盖章 = 假进化。与 implementation 同样包装 typeErrorVerify。
  it('C：type_error goal 的 self_repair 也走 typeErrorVerify 包装（锚不可旁路）', async () => {
    const wrappedVerify = vi.fn(async () => ({ ok: false, reason: 'type_error_fix_rejected: error 未减少', reportRef: 'v.json' }));
    const typeErrorVerify = vi.fn(() => wrappedVerify);
    const deps = makeDeps({ typeErrorVerify });
    const executors = freshExecutors(deps);
    let caught = null;
    try {
      await executors.get('noe.self_evolution.self_repair')({
        act: makeAct('noe.self_evolution.self_repair', {
          patchPlanRef: 'p.json', signal: 'type_error', targetFile: 'src/x.js', beforeErrorCount: 1,
        }),
      });
    } catch (e) { caught = e; }
    expect(typeErrorVerify).toHaveBeenCalledWith(expect.objectContaining({ targetFile: 'src/x.js', beforeErrorCount: 1 }));
    expect(wrappedVerify).toHaveBeenCalledTimes(1);
    expect(deps.runtimeVerify).not.toHaveBeenCalled(); // 裸 verify 不再直用
    expect(caught.message).toBe('self_repair_failed_needs_consensus'); // 锚拒 → 失败（不假成功）
  });

  it('C 零回归：非 type_error goal 的 self_repair 仍用裸 runtimeVerify', async () => {
    const typeErrorVerify = vi.fn(() => vi.fn());
    const deps = makeDeps({ typeErrorVerify });
    const executors = freshExecutors(deps);
    const out = await executors.get('noe.self_evolution.self_repair')({
      act: makeAct('noe.self_evolution.self_repair', { patchPlanRef: 'p.json' }),
    });
    expect(out.repaired).toBe(true);
    expect(typeErrorVerify).not.toHaveBeenCalled();
    expect(deps.runtimeVerify).toHaveBeenCalledTimes(1);
  });

  // repair 升级模型链(2026-07-03)：self_repair 拍要给 spawnImplementer 传 escalate 标记（工厂按
  //   repairEscalate flag 决定是否云端优先）；implementation 拍不传（本地优先省额度不变）。
  it('repair 升级：self_repair 调实施者时传 escalate:true', async () => {
    const deps = makeDeps();
    const executors = freshExecutors(deps);
    await executors.get('noe.self_evolution.self_repair')({
      act: makeAct('noe.self_evolution.self_repair', { objective: '修 X' }),
    });
    expect(deps.spawnImplementer.mock.calls[0][0].escalate).toBe(true);
  });

  it('repair 升级零回归：implementation 调实施者不带 escalate', async () => {
    const deps = makeDeps();
    const executors = freshExecutors(deps);
    await executors.get('noe.self_evolution.implementation')({
      act: makeAct('noe.self_evolution.implementation', { objective: '改进 X' }),
    });
    expect(deps.spawnImplementer.mock.calls[0][0].escalate).toBeFalsy();
  });

  it('self_repair 也要求 standing grant', async () => {
    const deps = makeDeps({ evaluateGrant: vi.fn(() => ({ authorized: false })) });
    const executors = freshExecutors(deps);
    await expect(executors.get('noe.self_evolution.self_repair')({
      act: makeAct('noe.self_evolution.self_repair', { patchPlanRef: 'p.json' }),
    })).rejects.toThrow('self_evolution_apply_requires_standing_grant');
  });
});

describe('memory_writeback executor', () => {
  it('写脱敏 summary（scope=fact, sourceType=self_evolution），返回 memoryId', () => {
    const deps = makeDeps();
    const executors = freshExecutors(deps);
    return executors.get('noe.self_evolution.memory_writeback')({
      act: makeAct('noe.self_evolution.memory_writeback', { memoryWriteback: { summary: '本轮自改：提升期望结算率' }, objective: '期望结算率' }),
    }).then((out) => {
      expect(out.written).toBe(true);
      expect(out.memoryId).toBe('mem-1');
      expect(deps.memoryWrite).toHaveBeenCalledTimes(1);
      const arg = deps.memoryWrite.mock.calls[0][0];
      expect(arg.scope).toBe('fact');
      expect(arg.sourceType).toBe('self_evolution');
      expect(typeof arg.body).toBe('string');
      // P0.1b：返回 summaryRef（cycle 完成完整校验 cycle_memory_summary_ref 要求）+ 真落 artifact（root=/tmp，summaryWritten=true）。
      expect(out.summaryRef).toMatch(/output\/noe-self-evolution\/memory-writeback\/.+\.md$/);
      expect(out.summaryWritten).toBe(true);
    });
  });

  it('缺 summary → throw self_evolution_memory_summary_required', async () => {
    const executors = freshExecutors(makeDeps());
    await expect(executors.get('noe.self_evolution.memory_writeback')({
      act: makeAct('noe.self_evolution.memory_writeback', { memoryWriteback: {} }),
    })).rejects.toThrow('self_evolution_memory_summary_required');
  });

  // M3 防假绿：memoryWrite 是函数却返回 falsy（写持久层失败）→ 抛错，cycle 绝不假绿 advance 到 complete。
  it('memoryWrite 返回 null（写库失败）→ throw self_evolution_memory_write_failed（防假绿）', async () => {
    const deps = makeDeps({ memoryWrite: vi.fn(() => null) });
    const executors = freshExecutors(deps);
    await expect(executors.get('noe.self_evolution.memory_writeback')({
      act: makeAct('noe.self_evolution.memory_writeback', { memoryWriteback: { summary: '本轮自改' } }),
    })).rejects.toThrow('self_evolution_memory_write_failed');
  });

  it('memory_writeback 不要求 standing grant（只写脱敏 summary，无写代码动作）', async () => {
    const deps = makeDeps({ evaluateGrant: vi.fn(() => ({ authorized: false })) });
    const executors = freshExecutors(deps);
    const out = await executors.get('noe.self_evolution.memory_writeback')({
      act: makeAct('noe.self_evolution.memory_writeback', { memoryWriteback: { summary: 'x' } }),
    });
    expect(out.written).toBe(true);
  });
});

describe('complete executor', () => {
  it('追加 noe_self_evolution_completed 事件（projectId 默认 noe），返回脱敏 refs', async () => {
    const deps = makeDeps();
    const executors = freshExecutors(deps);
    const out = await executors.get('noe.self_evolution.complete')({
      act: makeAct('noe.self_evolution.complete', {
        applyReportRef: 'apply.json',
        runtimeReportRef: 'v.json',
        memoryId: 'mem-1',
        retrospectiveRef: 'retro.json',
      }),
    });
    expect(out.completed).toBe(true);
    expect(out.eventId).toBe('evt-1');
    expect(out.refs.retrospectiveRef).toBe('retro.json');
    expect(out.secretValuesReturned).toBe(false);
    expect(deps.appendEvent).toHaveBeenCalledTimes(1);
    const evt = deps.appendEvent.mock.calls[0][0];
    expect(evt.kind).toBe('noe_self_evolution_completed');
    expect(evt.projectId).toBe('noe');
    expect(evt.entityId).toBe('act-1');
    expect(evt.secretValuesReturned).toBe(false);
  });

  it('complete 也走 gate 二次防御', async () => {
    const executors = freshExecutors(makeDeps());
    await expect(executors.get('noe.self_evolution.complete')({
      act: makeAct('noe.self_evolution.complete', {}, { ok: false }),
    })).rejects.toThrow('gate_not_passed_in_executor');
  });
});

describe('createSafeActExecutors — env 门控（零回归核心）', () => {
  const KEY = 'NOE_SELF_EVOLUTION_EXECUTORS';
  let prev;
  beforeEach(() => { prev = process.env[KEY]; });
  afterEach(() => {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  });

  it('env=1 且注入 selfEvolution → Map 含四个 self_evolution executor', () => {
    process.env[KEY] = '1';
    const executors = createSafeActExecutors({ selfEvolution: {} });
    for (const action of NOE_SELF_EVOLUTION_EXECUTOR_ACTIONS) {
      expect(executors.has(action)).toBe(true);
    }
  });

  it('env 未设（默认 OFF）→ Map 无 self_evolution key（与现状逐字一致）', () => {
    delete process.env[KEY];
    const executors = createSafeActExecutors({ selfEvolution: {} });
    for (const action of NOE_SELF_EVOLUTION_EXECUTOR_ACTIONS) {
      expect(executors.has(action)).toBe(false);
    }
  });

  it('env=1 但未注入 selfEvolution → 仍不注册（双条件守门）', () => {
    process.env[KEY] = '1';
    const executors = createSafeActExecutors({});
    for (const action of NOE_SELF_EVOLUTION_EXECUTOR_ACTIONS) {
      expect(executors.has(action)).toBe(false);
    }
  });

  it('开关不影响既有 executor（file.write_text/shell.exec 等照常注册）', () => {
    process.env[KEY] = '1';
    const executors = createSafeActExecutors({ selfEvolution: {} });
    expect(executors.has('file.write_text')).toBe(true);
    expect(executors.has('shell.exec')).toBe(true);
    expect(executors.has('browser.open')).toBe(true);
  });
});

describe('P2 观测：outcome 落账带拦截点 reason + preflight 失败事件', () => {
  const mkOutcomeStub = () => ({
    measure: vi.fn(() => ({ 'src/x.js': { lines: 10, codeLines: 8, missingJsdoc: 0 } })),
    summarize: vi.fn(() => ({ filesChanged: 1, jsdocImproved: 0, codeChanged: 3, verdict: 'logic_changed' })),
    record: vi.fn(),
  });

  beforeEach(() => {
    runNoePatchApply.mockReset();
    runNoePatchRollback.mockReset();
    runNoePatchApply.mockImplementation(({ dryRun }) => (dryRun
      ? { ok: true, status: 'dry_run_ready', reportRef: 'dry.json' }
      : { ok: true, status: 'applied', reportRef: 'apply.json', backupManifestRef: 'backup.json', changedFiles: ['src/x.js'] }));
    runNoePatchRollback.mockImplementation(() => ({ status: 'rolled_back', reportRef: 'rollback.json' }));
  });

  it('verify 不绿回滚 → record 带 reason=verify_not_green + applied:false', async () => {
    const evolutionOutcome = mkOutcomeStub();
    const deps = makeDeps({ runtimeVerify: vi.fn(async () => ({ ok: false, error: 'boom' })), evolutionOutcome });
    const executors = freshExecutors(deps);
    try {
      await executors.get('noe.self_evolution.implementation')({ act: makeAct('noe.self_evolution.implementation', { patchPlanRef: 'plan.json', objective: 'x' }) });
    } catch { /* 失败路径允许 throw */ }
    expect(evolutionOutcome.record).toHaveBeenCalledWith(expect.objectContaining({ applied: false, reason: 'verify_not_green' }));
  });

  it('全门通过保留 → record 带 reason=kept + applied:true', async () => {
    const evolutionOutcome = mkOutcomeStub();
    const deps = makeDeps({ evolutionOutcome });
    const executors = freshExecutors(deps);
    const res = await executors.get('noe.self_evolution.implementation')({ act: makeAct('noe.self_evolution.implementation', { patchPlanRef: 'plan.json', objective: 'x' }) });
    expect(res.applied).toBe(true);
    expect(evolutionOutcome.record).toHaveBeenCalledWith(expect.objectContaining({ applied: true, reason: 'kept' }));
  });

  it('dryRun 预检失败 → appendEvent 落 self_evolution_preflight_blocked 事件（带 reportRef+blockers，可归因）', async () => {
    runNoePatchApply.mockImplementation(({ dryRun }) => (dryRun
      ? { ok: false, status: 'blocked', reportRef: 'dry.json', blocked: [{ blockers: ['policy_file'] }] }
      : { ok: true, status: 'applied', reportRef: 'apply.json', changedFiles: [] }));
    const deps = makeDeps();
    const executors = freshExecutors(deps);
    await expect(
      executors.get('noe.self_evolution.implementation')({ act: makeAct('noe.self_evolution.implementation', { patchPlanRef: 'plan.json', objective: 'x' }) }),
    ).rejects.toThrow();
    expect(deps.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'self_evolution_preflight_blocked',
      reportRef: 'dry.json',
    }));
  });
});
