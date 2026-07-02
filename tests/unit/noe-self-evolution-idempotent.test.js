import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

// P3 自进化幂等事务：
//   1) patchPlanId 确定性（同 objective+operations 必同 id；不同 operations 必不同 id）。
//   2) apply 幂等去重（已 applied 同 patchPlanId report → applyAndVerify 跳过真 apply，skipped:true）。
//   3) 事务原子性（verify 失败 → backup+rollback 真还原源文件 + executor throw，主树零残留）。
//   4) DB cycle ↔ apply-report 一致性检查（半截状态 issues 非空；正常态 consistent:true）。
//
// 用 importOriginal 局部 mock NoePatchApplyExecutor：默认走真实 apply/rollback（撑事务原子性真 fs 验证），
//   个别测试用 vi.mocked 覆盖 apply/rollback 以隔离 idempotent/verify-fail 串法。

vi.mock('../../src/runtime/mission/NoePatchApplyExecutor.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runNoePatchApply: vi.fn(actual.runNoePatchApply),
    runNoePatchRollback: vi.fn(actual.runNoePatchRollback),
  };
});

import {
  runNoePatchApply,
  runNoePatchRollback,
} from '../../src/runtime/mission/NoePatchApplyExecutor.js';
import {
  registerNoeSelfEvolutionExecutors,
  noeSelfEvolutionPatchPlanId,
  SELF_EVOLUTION_GRANT_SCOPE,
} from '../../src/loop/NoeSelfEvolutionExecutors.js';
import { checkNoeSelfEvolutionConsistency } from '../../src/loop/NoeSelfEvolutionConsistency.js';

const APPLY_REPORTS_DIR = 'output/noe-patch-transactions/apply-reports';

function writeJson(root, ref, obj) {
  const file = resolve(root, ref);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
  return ref;
}

function makeDeps(root, overrides = {}) {
  return {
    root,
    evaluateGrant: vi.fn(() => ({ authorized: true, scope: SELF_EVOLUTION_GRANT_SCOPE })),
    spawnImplementer: vi.fn(async () => ({ patchPlanRef: 'unused/patch-plan.json' })),
    runtimeVerify: vi.fn(async () => ({ ok: true, reportRef: 'rv.json' })),
    now: () => new Date('2026-06-21T00:00:00.000Z'),
    applyReportsDir: APPLY_REPORTS_DIR,
    ...overrides,
  };
}

function makeAct(action, ctx = {}, gate = { ok: true }) {
  return { id: 'act-1', action, projectId: 'noe', payload: { selfEvolutionGate: gate, selfEvolution: ctx } };
}

function freshExecutors(deps) {
  return registerNoeSelfEvolutionExecutors(new Map(), deps);
}

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noe-idem-'));
  runNoePatchApply.mockReset();
  runNoePatchRollback.mockReset();
});
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('P3-1 patchPlanId 确定性', () => {
  const ops = [{ op: 'replace', path: 'src/x.js', from: 'a', to: 'b' }];

  it('同 objective + 同 operations → 两次算出完全相同的 id', () => {
    const a = noeSelfEvolutionPatchPlanId({ objective: '改进 X', operations: ops });
    const b = noeSelfEvolutionPatchPlanId({ objective: '改进 X', operations: structuredClone(ops) });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{24}$/); // sha256 前 24 hex，确定性、无时间戳
  });

  it('operations 不同 → id 不同', () => {
    const a = noeSelfEvolutionPatchPlanId({ objective: '改进 X', operations: ops });
    const c = noeSelfEvolutionPatchPlanId({ objective: '改进 X', operations: [{ op: 'replace', path: 'src/x.js', from: 'a', to: 'DIFFERENT' }] });
    expect(a).not.toBe(c);
  });

  it('objective 不同 → id 不同', () => {
    const a = noeSelfEvolutionPatchPlanId({ objective: '改进 X', operations: ops });
    const d = noeSelfEvolutionPatchPlanId({ objective: '改进 Y', operations: ops });
    expect(a).not.toBe(d);
  });

  it('无关字段（如 op 上的 id/多余键）不影响 id（只取语义字段规范化）', () => {
    const a = noeSelfEvolutionPatchPlanId({ objective: 'X', operations: [{ op: 'write_file', path: 'a.js', content: 'c' }] });
    const withExtra = noeSelfEvolutionPatchPlanId({ objective: 'X', operations: [{ id: 'op-1', op: 'write_file', path: 'a.js', content: 'c', extra: 'noise' }] });
    expect(a).toBe(withExtra);
  });
});

describe('P3-2 apply 幂等去重（已 applied 同 patchPlanId → 跳过真 apply）', () => {
  it('注入含已 applied 同 patchPlanId report 的目录 → implementation 跳过 apply（skipped:true，runNoePatchApply 不被调）', async () => {
    // 1) 落一份真实 patch-plan.json（带确定性 patchPlanId）。
    const planObjective = '幂等去重目标';
    const planOps = [{ op: 'write_file', path: 'src/dummy.js', content: '// noop' }];
    const patchPlanId = noeSelfEvolutionPatchPlanId({ objective: planObjective, operations: planOps });
    const planRef = writeJson(root, 'output/noe-self-evolution/run-1/patch-plan.json', {
      kind: 'noe_patch_plan', patchPlanId, objective: planObjective, patchPlan: { operations: planOps },
    });
    // 2) 落一份「已 applied」apply-report，指向上面的 plan。
    const reportRef = `${APPLY_REPORTS_DIR}/patch-apply-prior.json`;
    writeJson(root, reportRef, { status: 'applied', applyId: 'prior', patchPlanRef: planRef, reportRef, backupManifestRef: 'b.json', changedFiles: ['src/dummy.js'] });

    const deps = makeDeps(root);
    const executors = freshExecutors(deps);
    const out = await executors.get('noe.self_evolution.implementation')({
      act: makeAct('noe.self_evolution.implementation', { patchPlanRef: planRef }),
    });

    expect(out.skipped).toBe(true);
    expect(out.reason).toBe('already_applied');
    expect(out.patchPlanId).toBe(patchPlanId);
    expect(out.priorApplyReportRef).toBe(reportRef);
    // 不重复 apply（不重复改代码），但 P3 blocker 修复后**仍跑 verify** 确认当前含该 patch 的系统真绿。
    expect(runNoePatchApply).not.toHaveBeenCalled();
    expect(deps.runtimeVerify).toHaveBeenCalledTimes(1);
    // 回填既有 apply 实现证据 + runtimeOk，让 cycle 完成门(diffRef||touchedFiles + runtime ok)能收口
    //   （原 blocker：skip 缺证据 → cycle 卡死 / complete=0）。
    expect(out.applyReportRef).toBe(reportRef);
    expect(out.diffRef).toBe(reportRef);
    expect(out.touchedFiles).toEqual(['src/dummy.js']);
    expect(out.runtimeOk).toBe(true);
    expect(out.runtimeReportRef).toBe('rv.json');
  });

  it('blocker①：skip 但当前 verify 失败 → 不假绿收口，抛 needsSelfRepair', async () => {
    const planObjective = 'skip但当前红';
    const planOps = [{ op: 'write_file', path: 'src/dummy.js', content: '// noop' }];
    const patchPlanId = noeSelfEvolutionPatchPlanId({ objective: planObjective, operations: planOps });
    const planRef = writeJson(root, 'output/noe-self-evolution/run-skipfail/patch-plan.json', {
      kind: 'noe_patch_plan', patchPlanId, objective: planObjective, patchPlan: { operations: planOps },
    });
    const reportRef = `${APPLY_REPORTS_DIR}/patch-apply-skipfail.json`;
    writeJson(root, reportRef, { status: 'applied', applyId: 'sf', patchPlanRef: planRef, reportRef, backupManifestRef: 'b.json', changedFiles: ['src/dummy.js'] });
    // 当前 verify 失败（patch 在但别处坏了）→ 绝不能假绿收口（cycle 层 P0 防假绿）。
    const deps = makeDeps(root, { runtimeVerify: vi.fn(async () => ({ ok: false, reportRef: 'rv-fail.json' })) });
    await expect(freshExecutors(deps).get('noe.self_evolution.implementation')({
      act: makeAct('noe.self_evolution.implementation', { patchPlanRef: planRef }),
    })).rejects.toThrow(/needs_self_repair|verify_failed/);
    expect(runNoePatchApply).not.toHaveBeenCalled(); // 仍未重复 apply
    expect(deps.runtimeVerify).toHaveBeenCalledTimes(1); // 但确实 verify 了当前状态
  });

  it('blocker①：self_repair 绝不被幂等跳过（rollback 后必重新应用 + verify，否则文件停在坏内容）', async () => {
    const planObjective = 'self_repair重应用';
    const planOps = [{ op: 'write_file', path: 'src/dummy.js', content: '// fixed' }];
    const patchPlanId = noeSelfEvolutionPatchPlanId({ objective: planObjective, operations: planOps });
    const planRef = writeJson(root, 'output/noe-self-evolution/run-sr/patch-plan.json', {
      kind: 'noe_patch_plan', patchPlanId, objective: planObjective, patchPlan: { operations: planOps },
    });
    // 存在同 patchPlanId 的既有 applied report —— 旧 bug 会让 self_repair 误跳过、文件停在 rollback 后坏内容。
    const priorAppliedRef = `${APPLY_REPORTS_DIR}/patch-apply-sr-prior.json`;
    writeJson(root, priorAppliedRef, { status: 'applied', applyId: 'srp', patchPlanRef: planRef, reportRef: priorAppliedRef, backupManifestRef: 'b.json', changedFiles: ['src/dummy.js'] });
    runNoePatchApply.mockImplementation(({ dryRun }) => (dryRun
      ? { ok: true, status: 'dry_run_ready', reportRef: 'dry.json' }
      : { ok: true, status: 'applied', reportRef: 'apply.json', backupManifestRef: 'backup.json', changedFiles: ['src/dummy.js'] }));
    runNoePatchRollback.mockReturnValue({ status: 'rolled_back', reportRef: 'rb.json' });
    const deps = makeDeps(root);
    const out = await freshExecutors(deps).get('noe.self_evolution.self_repair')({
      act: makeAct('noe.self_evolution.self_repair', { patchPlanRef: planRef, priorApplyReportRef: `${APPLY_REPORTS_DIR}/failed-prior.json` }),
    });
    // 关键：self_repair 不 skip —— 真重新 apply（dry+real=2 次）+ 真 verify，绝不被既有 applied report 骗跳过。
    expect(out.skipped).toBeUndefined();
    expect(out.repaired).toBe(true);
    expect(runNoePatchApply).toHaveBeenCalledTimes(2);
    expect(deps.runtimeVerify).toHaveBeenCalledTimes(1);
    expect(out.touchedFiles).toEqual(['src/dummy.js']);
    expect(out.runtimeOk).toBe(true);
  });

  it('blocker③：伪造文件内 patchPlanId 不绕过去重（判定一律内容复算，不信文件字段）', async () => {
    const curOps = [{ op: 'write_file', path: 'src/a.js', content: '// a' }];
    const curId = noeSelfEvolutionPatchPlanId({ objective: 'forge', operations: curOps });
    const curRef = writeJson(root, 'output/noe-self-evolution/run-forge/patch-plan.json', {
      kind: 'noe_patch_plan', objective: 'forge', patchPlan: { operations: curOps },
    });
    // prior 真实内容是 src/b.js，但文件**伪造** patchPlanId = 当前的 id 想骗过去重。
    const priorOps = [{ op: 'write_file', path: 'src/b.js', content: '// b' }];
    const priorPlanRef = writeJson(root, 'output/noe-self-evolution/run-forge-prior/patch-plan.json', {
      kind: 'noe_patch_plan', patchPlanId: curId, objective: 'other', patchPlan: { operations: priorOps },
    });
    const priorReportRef = `${APPLY_REPORTS_DIR}/patch-apply-forge.json`;
    writeJson(root, priorReportRef, { status: 'applied', applyId: 'forge', patchPlanRef: priorPlanRef, reportRef: priorReportRef, backupManifestRef: 'b.json', changedFiles: ['src/b.js'] });
    runNoePatchApply.mockImplementation(({ dryRun }) => (dryRun
      ? { ok: true, status: 'dry_run_ready', reportRef: 'dry.json' }
      : { ok: true, status: 'applied', reportRef: 'apply.json', backupManifestRef: 'backup.json', changedFiles: ['src/a.js'] }));
    const deps = makeDeps(root);
    const out = await freshExecutors(deps).get('noe.self_evolution.implementation')({
      act: makeAct('noe.self_evolution.implementation', { patchPlanRef: curRef }),
    });
    // 伪造的 patchPlanId 字段被忽略（复算 prior=src/b.js 的 id ≠ 当前 src/a.js 的 id）→ 不命中 → 正常 apply，不被骗跳过。
    expect(out.skipped).toBeUndefined();
    expect(out.applied).toBe(true);
    expect(runNoePatchApply).toHaveBeenCalledTimes(2);
  });

  it('无既有 applied report → 正常走 apply（幂等不误伤首次执行）', async () => {
    const planObjective = '首次执行';
    const planOps = [{ op: 'write_file', path: 'src/dummy.js', content: '// noop' }];
    const planRef = writeJson(root, 'output/noe-self-evolution/run-2/patch-plan.json', {
      kind: 'noe_patch_plan', patchPlanId: noeSelfEvolutionPatchPlanId({ objective: planObjective, operations: planOps }), objective: planObjective, patchPlan: { operations: planOps },
    });
    // apply-reports 目录为空（无 prior）→ 用 mock 控制 apply 成功，验证确实进了 apply 分支。
    runNoePatchApply.mockImplementation(({ dryRun }) => (dryRun
      ? { ok: true, status: 'dry_run_ready', reportRef: 'dry.json' }
      : { ok: true, status: 'applied', reportRef: 'apply.json', backupManifestRef: 'backup.json', changedFiles: ['src/dummy.js'] }));

    const deps = makeDeps(root);
    const out = await freshExecutors(deps).get('noe.self_evolution.implementation')({
      act: makeAct('noe.self_evolution.implementation', { patchPlanRef: planRef }),
    });
    expect(out.skipped).toBeUndefined();
    expect(out.applied).toBe(true);
    expect(runNoePatchApply).toHaveBeenCalledTimes(2); // dry-run + 真实 apply
    expect(deps.runtimeVerify).toHaveBeenCalledTimes(1);
  });

  it('apply-reports 目录不存在 → fail-open，照常 apply（去重失败绝不漏 apply）', async () => {
    const planOps = [{ op: 'write_file', path: 'src/dummy.js', content: '// noop' }];
    const planRef = writeJson(root, 'output/noe-self-evolution/run-3/patch-plan.json', {
      kind: 'noe_patch_plan', patchPlanId: noeSelfEvolutionPatchPlanId({ objective: 'x', operations: planOps }), objective: 'x', patchPlan: { operations: planOps },
    });
    runNoePatchApply.mockImplementation(({ dryRun }) => (dryRun
      ? { ok: true, status: 'dry_run_ready', reportRef: 'dry.json' }
      : { ok: true, status: 'applied', reportRef: 'apply.json', backupManifestRef: 'backup.json', changedFiles: ['src/dummy.js'] }));
    // 指向一个不存在的目录
    const deps = makeDeps(root, { applyReportsDir: 'output/does-not-exist' });
    const out = await freshExecutors(deps).get('noe.self_evolution.implementation')({
      act: makeAct('noe.self_evolution.implementation', { patchPlanRef: planRef }),
    });
    expect(out.applied).toBe(true);
    expect(out.skipped).toBeUndefined();
    expect(runNoePatchApply).toHaveBeenCalledTimes(2);
  });

  it('不同 patchPlanId 的 prior applied report 不命中 → 仍正常 apply', async () => {
    const myOps = [{ op: 'write_file', path: 'src/mine.js', content: '// mine' }];
    const myRef = writeJson(root, 'output/noe-self-evolution/run-4/patch-plan.json', {
      kind: 'noe_patch_plan', patchPlanId: noeSelfEvolutionPatchPlanId({ objective: 'mine', operations: myOps }), objective: 'mine', patchPlan: { operations: myOps },
    });
    // prior report 指向一个内容不同的 plan（不同 patchPlanId）
    const otherOps = [{ op: 'write_file', path: 'src/other.js', content: '// other' }];
    const otherRef = writeJson(root, 'output/noe-self-evolution/run-other/patch-plan.json', {
      kind: 'noe_patch_plan', patchPlanId: noeSelfEvolutionPatchPlanId({ objective: 'other', operations: otherOps }), objective: 'other', patchPlan: { operations: otherOps },
    });
    const priorReportRef = `${APPLY_REPORTS_DIR}/patch-apply-other.json`;
    writeJson(root, priorReportRef, { status: 'applied', applyId: 'other', patchPlanRef: otherRef, reportRef: priorReportRef, backupManifestRef: 'b.json', changedFiles: ['src/other.js'] });

    runNoePatchApply.mockImplementation(({ dryRun }) => (dryRun
      ? { ok: true, status: 'dry_run_ready', reportRef: 'dry.json' }
      : { ok: true, status: 'applied', reportRef: 'apply.json', backupManifestRef: 'backup.json', changedFiles: ['src/mine.js'] }));
    const deps = makeDeps(root);
    const out = await freshExecutors(deps).get('noe.self_evolution.implementation')({
      act: makeAct('noe.self_evolution.implementation', { patchPlanRef: myRef }),
    });
    expect(out.skipped).toBeUndefined();
    expect(out.applied).toBe(true);
    expect(runNoePatchApply).toHaveBeenCalledTimes(2);
  });
});

describe('P3-3 事务原子性（verify 失败 → 真 backup+rollback 还原源文件 + throw）', () => {
  it('真实 apply 改了源文件 → verify 失败 → rollback 真还原 + executor throw，主树零残留', async () => {
    // 关键：本测试要真改盘 + 真回滚，须用真实 apply/rollback 实现（beforeEach 的 mockReset 已清空 → 这里塞回）。
    const realModule = await vi.importActual('../../src/runtime/mission/NoePatchApplyExecutor.js');
    runNoePatchApply.mockImplementation(realModule.runNoePatchApply);
    runNoePatchRollback.mockImplementation(realModule.runNoePatchRollback);

    // 1) 真实源文件（apply 将改它）。
    const original = 'export const N = 1;\n';
    const srcRef = 'src/atomic-target.js';
    writeJson(root, 'output/.keep', {}); // 确保 output 目录可写
    const srcFile = resolve(root, srcRef);
    mkdirSync(dirname(srcFile), { recursive: true });
    writeFileSync(srcFile, original);

    // 2) 真实 patch-plan：把 N=1 替换成 N=2。
    const planOps = [{ id: 'op-1', op: 'replace', path: srcRef, from: 'export const N = 1;', to: 'export const N = 2;' }];
    const planRef = writeJson(root, 'output/noe-self-evolution/atomic/patch-plan.json', {
      kind: 'noe_patch_plan',
      patchPlanId: noeSelfEvolutionPatchPlanId({ objective: 'atomic', operations: planOps }),
      objective: 'atomic',
      patchPlan: { operations: planOps },
    });

    // 3) 注入一个必失败的 runtimeVerify → 触发自动 rollback。
    const deps = makeDeps(root, { runtimeVerify: vi.fn(async () => ({ ok: false, reportRef: 'rv-fail.json' })) });
    const executors = freshExecutors(deps);

    let caught = null;
    try {
      await executors.get('noe.self_evolution.implementation')({
        act: makeAct('noe.self_evolution.implementation', { patchPlanRef: planRef }),
      });
    } catch (e) { caught = e; }

    // executor 必 throw（ActPipeline 据此标 failed，不会误标 completed）。
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toBe('self_evolution_verify_failed_rolled_back_needs_self_repair');
    expect(caught.selfEvolution.needsSelfRepair).toBe(true);
    expect(caught.selfEvolution.rolledBack).toBe(true);
    // 主树零残留：源文件被真还原成原始内容（apply 中途的 N=2 已被 rollback 抹掉）。
    expect(readFileSync(srcFile, 'utf8')).toBe(original);
    // verify 确实被调用过（apply 成功才会进 verify）；rollback 确实被调用。
    expect(deps.runtimeVerify).toHaveBeenCalledTimes(1);
    expect(runNoePatchRollback).toHaveBeenCalledTimes(1);
  });

  it('反向 probe：verify 成功 → 源文件保留改动（不误回滚）', async () => {
    const realModule = await vi.importActual('../../src/runtime/mission/NoePatchApplyExecutor.js');
    runNoePatchApply.mockImplementation(realModule.runNoePatchApply);
    runNoePatchRollback.mockImplementation(realModule.runNoePatchRollback);

    const original = 'export const M = 10;\n';
    const srcRef = 'src/atomic-ok.js';
    const srcFile = resolve(root, srcRef);
    mkdirSync(dirname(srcFile), { recursive: true });
    writeFileSync(srcFile, original);
    const planOps = [{ id: 'op-1', op: 'replace', path: srcRef, from: 'export const M = 10;', to: 'export const M = 20;' }];
    const planRef = writeJson(root, 'output/noe-self-evolution/atomic-ok/patch-plan.json', {
      kind: 'noe_patch_plan', patchPlanId: noeSelfEvolutionPatchPlanId({ objective: 'ok', operations: planOps }), objective: 'ok', patchPlan: { operations: planOps },
    });
    const deps = makeDeps(root); // 默认 runtimeVerify ok:true
    const out = await freshExecutors(deps).get('noe.self_evolution.implementation')({
      act: makeAct('noe.self_evolution.implementation', { patchPlanRef: planRef }),
    });
    expect(out.applied).toBe(true);
    expect(out.skipped).toBeUndefined();
    expect(readFileSync(srcFile, 'utf8')).toContain('export const M = 20;'); // 改动保留
    expect(runNoePatchRollback).not.toHaveBeenCalled();
    expect(existsSync(resolve(root, out.backupManifestRef))).toBe(true); // backup manifest 真落盘（事务证据）
  });
});

describe('P3-4 DB cycle ↔ apply-report 一致性检查', () => {
  it('正常态：cycle complete + apply applied + 有 backupManifest + runtime ok → consistent:true', () => {
    const cycle = {
      stage: 'complete',
      implementation: { applied: true, applyReportRef: 'r.json' },
      runtimeVerification: { ok: true, reportRef: 'rv.json' },
    };
    const report = { status: 'applied', reportRef: 'r.json', backupManifestRef: 'b.json', changedFiles: ['src/x.js'] };
    const res = checkNoeSelfEvolutionConsistency(cycle, report);
    expect(res.consistent).toBe(true);
    expect(res.issues).toEqual([]);
  });

  it('半截①：cycle 标 complete 但 apply-report status≠applied → issues 含 cycle_complete_but_apply_not_applied', () => {
    const cycle = { stage: 'complete', implementation: { applied: true } };
    const report = { status: 'blocked', reportRef: 'r.json' };
    const res = checkNoeSelfEvolutionConsistency(cycle, report);
    expect(res.consistent).toBe(false);
    expect(res.issues.map((i) => i.code)).toContain('cycle_complete_but_apply_not_applied');
  });

  it('半截②：apply applied 改了文件却无 backupManifestRef → issues 含 applied_without_backup_manifest', () => {
    const cycle = { stage: 'implementation', implementation: { applied: true } };
    const report = { status: 'applied', reportRef: 'r.json', backupManifestRef: '', changedFiles: ['src/x.js'] };
    const res = checkNoeSelfEvolutionConsistency(cycle, report);
    expect(res.consistent).toBe(false);
    expect(res.issues.map((i) => i.code)).toContain('applied_without_backup_manifest');
  });

  it('半截③：apply 成功 + cycle complete 但 runtimeVerification.ok≠true → issues 含 complete_apply_without_passing_runtime_verify', () => {
    const cycle = { stage: 'complete', runtimeVerification: { ok: false } };
    const report = { status: 'applied', reportRef: 'r.json', backupManifestRef: 'b.json', changedFiles: ['src/x.js'] };
    const res = checkNoeSelfEvolutionConsistency(cycle, report);
    expect(res.consistent).toBe(false);
    expect(res.issues.map((i) => i.code)).toContain('complete_apply_without_passing_runtime_verify');
  });

  it('引用错配：cycle.implementation.applyReportRef ≠ apply-report.reportRef → issues 含 apply_report_ref_mismatch', () => {
    const cycle = { stage: 'implementation', implementation: { applied: true, applyReportRef: 'A.json' } };
    const report = { status: 'applied', reportRef: 'B.json', backupManifestRef: 'b.json', changedFiles: ['x'] };
    const res = checkNoeSelfEvolutionConsistency(cycle, report);
    expect(res.issues.map((i) => i.code)).toContain('apply_report_ref_mismatch');
  });

  it('cycle complete 但缺 apply-report 且 requireApplyReport=true → issues 含 apply_report_missing_for_complete_cycle', () => {
    const res = checkNoeSelfEvolutionConsistency({ stage: 'complete' }, null, { requireApplyReport: true });
    expect(res.consistent).toBe(false);
    expect(res.issues.map((i) => i.code)).toContain('apply_report_missing_for_complete_cycle');
  });

  it('fail-open：入参全空不崩，按无法判定处理（不误报）', () => {
    expect(checkNoeSelfEvolutionConsistency(null, null)).toEqual({ consistent: true, issues: [] });
    expect(checkNoeSelfEvolutionConsistency(undefined, undefined)).toEqual({ consistent: true, issues: [] });
    expect(() => checkNoeSelfEvolutionConsistency('bad', 'also-bad')).not.toThrow();
  });

  it('applyOk 收紧：status=applied 但 ok:false → 不算已落地（cycle complete 时报半截）', () => {
    const cycle = { stage: 'complete', implementation: { applied: true } };
    const report = { status: 'applied', ok: false, reportRef: 'r.json', backupManifestRef: 'b.json', changedFiles: ['x'] };
    const res = checkNoeSelfEvolutionConsistency(cycle, report);
    expect(res.consistent).toBe(false);
    expect(res.issues.map((i) => i.code)).toContain('cycle_complete_but_apply_not_applied');
    // 既然不算 applyOk，backupManifest/count 等「applied 前提」的检查不应触发
    expect(res.issues.map((i) => i.code)).not.toContain('applied_without_backup_manifest');
  });

  it('applyOk 收紧：status=applied 但 dryRun:true（预演）→ 不算已落地', () => {
    const cycle = { stage: 'complete', implementation: { applied: true } };
    const report = { status: 'applied', dryRun: true, reportRef: 'r.json', changedFiles: ['x'] };
    const res = checkNoeSelfEvolutionConsistency(cycle, report);
    expect(res.issues.map((i) => i.code)).toContain('cycle_complete_but_apply_not_applied');
  });

  it('fail-open：status=applied 且 ok:true / dryRun:false 显式存在 → 正常算已落地', () => {
    const cycle = {
      stage: 'complete', implementation: { applied: true }, runtimeVerification: { ok: true },
    };
    const report = {
      status: 'applied', ok: true, dryRun: false, reportRef: 'r.json',
      backupManifestRef: 'b.json', changedFiles: ['x'], counts: { changedFiles: 1 },
    };
    const res = checkNoeSelfEvolutionConsistency(cycle, report);
    expect(res.consistent).toBe(true);
    expect(res.issues).toEqual([]);
  });

  it('fail-open：ok/dryRun 字段缺失（旧产物）→ 行为不变，仍按 applied 处理不误报', () => {
    // 旧 apply-report 只有 status，无 ok/dryRun；不应因缺字段被判 not-applied
    const cycle = { stage: 'complete', implementation: { applied: true } };
    const report = { status: 'applied', reportRef: 'r.json', backupManifestRef: 'b.json' };
    const res = checkNoeSelfEvolutionConsistency(cycle, report);
    expect(res.issues.map((i) => i.code)).not.toContain('cycle_complete_but_apply_not_applied');
  });

  it('守恒校验：applied 且 changedFiles 数组长度 ≠ counts.changedFiles → changed_files_count_mismatch(warn)', () => {
    const cycle = { stage: 'implementation', implementation: { applied: true } };
    const report = {
      status: 'applied', ok: true, reportRef: 'r.json', backupManifestRef: 'b.json',
      changedFiles: ['a', 'b', 'c'], counts: { changedFiles: 2 }, // 3 ≠ 2
    };
    const res = checkNoeSelfEvolutionConsistency(cycle, report);
    expect(res.consistent).toBe(false);
    const mismatch = res.issues.find((i) => i.code === 'changed_files_count_mismatch');
    expect(mismatch).toBeTruthy();
    expect(mismatch.severity).toBe('warn');
  });

  it('守恒校验：长度与 counts 一致 → 不报 mismatch', () => {
    const cycle = { stage: 'implementation', implementation: { applied: true } };
    const report = {
      status: 'applied', ok: true, reportRef: 'r.json', backupManifestRef: 'b.json',
      changedFiles: ['a', 'b'], counts: { changedFiles: 2 },
    };
    const res = checkNoeSelfEvolutionConsistency(cycle, report);
    expect(res.issues.map((i) => i.code)).not.toContain('changed_files_count_mismatch');
  });

  it('守恒校验 fail-open：counts.changedFiles 缺失（旧产物）→ 不交叉校验、不误报', () => {
    const cycle = { stage: 'implementation', implementation: { applied: true } };
    const report = {
      status: 'applied', ok: true, reportRef: 'r.json', backupManifestRef: 'b.json',
      changedFiles: ['a', 'b', 'c'], // 无 counts
    };
    const res = checkNoeSelfEvolutionConsistency(cycle, report);
    expect(res.issues.map((i) => i.code)).not.toContain('changed_files_count_mismatch');
  });
});

describe('P3-5 补测试有效性门（堵假性 complete：新增测试必须真增加 vitest 运行用例数）', () => {
  // 实测教训：M3 默认写 test/(单数,vitest include 不收) + node:test(vitest 不收集) → 测试零运行，verify 照绿，假性 complete。
  //   门 = 复用 baseline(NOE_EVOLUTION_LOGIC ON 时跑)的 numTotalTests，apply 后比对；补测试没让用例数增加 → 当 verify 失败回滚。
  // A2 在生产经 plist NOE_ALLOW_NEW_TEST_FILES=1 开启（放行新增 tests/ 测试过 post-apply 守门）；测试里模拟同状态。
  let prevAllow;
  beforeEach(() => { prevAllow = process.env.NOE_ALLOW_NEW_TEST_FILES; process.env.NOE_ALLOW_NEW_TEST_FILES = '1'; });
  afterEach(() => { if (prevAllow === undefined) delete process.env.NOE_ALLOW_NEW_TEST_FILES; else process.env.NOE_ALLOW_NEW_TEST_FILES = prevAllow; });
  const passGate = { enabled: () => true, preCheck: () => ({ block: false }), postCheck: () => ({ allow: true }) };
  const mkApply = (changedFiles) => ({ dryRun }) => (dryRun
    ? { ok: true, status: 'dry_run_ready', reportRef: 'dry.json' }
    : { ok: true, status: 'applied', reportRef: 'apply.json', backupManifestRef: 'b.json', changedFiles });
  const mkPlan = (objective, ops) => writeJson(root, `output/noe-self-evolution/${objective}/patch-plan.json`, {
    kind: 'noe_patch_plan', patchPlanId: noeSelfEvolutionPatchPlanId({ objective, operations: ops }), objective, patchPlan: { operations: ops },
  });

  it('新增 .test.js 但 numTotalTests 没增加(错目录/错框架/空测试)→ throw needs_self_repair + rollback', async () => {
    runNoePatchApply.mockImplementation(mkApply(['test/unit/foo.test.js'])); // test/ 单数,vitest 不收
    runNoePatchRollback.mockReturnValue({ status: 'rolled_back', reportRef: 'rb.json' });
    const runtimeVerify = vi.fn(async () => ({ ok: true, reportRef: 'rv.json', numTotalTests: 100 })); // baseline=verify=100,没增
    const planRef = mkPlan('addtest-nogrow', [{ op: 'write_file', path: 'test/unit/foo.test.js', content: '// t' }]);
    const deps = makeDeps(root, { runtimeVerify, evolutionLogicGate: passGate });
    await expect(freshExecutors(deps).get('noe.self_evolution.implementation')({
      act: makeAct('noe.self_evolution.implementation', { patchPlanRef: planRef }),
    })).rejects.toThrow(/needs_self_repair/);
    expect(runNoePatchRollback).toHaveBeenCalledTimes(1); // 补测试没生效 → 回滚,不假性 complete
  });

  it('反向 probe：新增 .test.js 且 numTotalTests 增加 → 放行(真补对)', async () => {
    runNoePatchApply.mockImplementation(mkApply(['tests/unit/foo.test.js'])); // tests/ 复数,vitest 收
    let calls = 0;
    const runtimeVerify = vi.fn(async () => { calls += 1; return { ok: true, reportRef: `rv-${calls}.json`, numTotalTests: calls === 1 ? 100 : 103 }; }); // 增 3
    const planRef = mkPlan('addtest-grow', [{ op: 'write_file', path: 'tests/unit/foo.test.js', content: '// t' }]);
    const deps = makeDeps(root, { runtimeVerify, evolutionLogicGate: passGate });
    const out = await freshExecutors(deps).get('noe.self_evolution.implementation')({
      act: makeAct('noe.self_evolution.implementation', { patchPlanRef: planRef }),
    });
    expect(out.applied).toBe(true);
    expect(runNoePatchRollback).not.toHaveBeenCalled();
  });

  it('零回归：非测试文件改动 numTotalTests 不变 → 不触发门(放行)', async () => {
    runNoePatchApply.mockImplementation(mkApply(['src/x.js']));
    const runtimeVerify = vi.fn(async () => ({ ok: true, reportRef: 'rv.json', numTotalTests: 100 }));
    const planRef = mkPlan('nontest', [{ op: 'write_file', path: 'src/x.js', content: '// x' }]);
    const deps = makeDeps(root, { runtimeVerify, evolutionLogicGate: passGate });
    const out = await freshExecutors(deps).get('noe.self_evolution.implementation')({
      act: makeAct('noe.self_evolution.implementation', { patchPlanRef: planRef }),
    });
    expect(out.applied).toBe(true);
    expect(runNoePatchRollback).not.toHaveBeenCalled();
  });

  it('fail-open：无 evolutionLogicGate(拿不到 baseline 测试数)→ 门不接入,回退现状放行', async () => {
    runNoePatchApply.mockImplementation(mkApply(['test/unit/foo.test.js']));
    const runtimeVerify = vi.fn(async () => ({ ok: true, reportRef: 'rv.json', numTotalTests: 100 }));
    const planRef = mkPlan('failopen', [{ op: 'write_file', path: 'test/unit/foo.test.js', content: '// t' }]);
    const deps = makeDeps(root, { runtimeVerify }); // 无 logic gate → baseline 不跑 → baselineTotalTests=null
    const out = await freshExecutors(deps).get('noe.self_evolution.implementation')({
      act: makeAct('noe.self_evolution.implementation', { patchPlanRef: planRef }),
    });
    expect(out.applied).toBe(true);
    expect(runNoePatchRollback).not.toHaveBeenCalled();
  });
});
