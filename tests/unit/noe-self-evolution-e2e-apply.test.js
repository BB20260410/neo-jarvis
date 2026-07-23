import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerNoeSelfEvolutionExecutors } from '../../src/loop/NoeSelfEvolutionExecutors.js';

// self-evolution 端到端真实可用证明：用真 NoePatchApplyExecutor（不 mock）+ 真文件操作 + 临时 root，
// 验证 executor 真能改代码、verify 失败真能回滚、gate 未过真能挡住。证明「不是纸上谈兵」。

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noe-se-e2e-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writePatchPlan(targetRel, content) {
  const ref = 'output/noe-self-evolution/test/patch-plan.json';
  mkdirSync(join(root, 'output/noe-self-evolution/test'), { recursive: true });
  writeFileSync(join(root, ref), JSON.stringify({
    kind: 'noe_patch_plan',
    operations: [{ id: 'op1', op: 'write_file', path: targetRel, content }],
  }));
  return ref;
}

function implementationExecutor({ verifyOk }) {
  const executors = registerNoeSelfEvolutionExecutors(new Map(), {
    root,
    evaluateGrant: () => ({ authorized: true }),
    runtimeVerify: async () => ({ ok: verifyOk, reportRef: 'output/noe-self-evolution/runtime-verify/v.json' }),
    now: () => new Date('2026-06-14T00:00:00.000Z'),
  });
  return executors.get('noe.self_evolution.implementation');
}

describe('self-evolution 端到端：真改代码 + 真回滚（真 NoePatchApplyExecutor，临时 root）', () => {
  it('verify 通过 → 真把目标文件改了（真实可用）', async () => {
    writeFileSync(join(root, 'target.txt'), 'ORIGINAL\n');
    const ref = writePatchPlan('target.txt', 'CHANGED_BY_SELF_EVOLUTION\n');
    const exec = implementationExecutor({ verifyOk: true });
    const out = await exec({
      act: { id: 'a1', payload: { selfEvolutionGate: { ok: true }, selfEvolution: { patchPlanRef: ref } } },
    });
    expect(out.applied).toBe(true);
    expect(out.secretValuesReturned).toBe(false);
    expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('CHANGED_BY_SELF_EVOLUTION\n');
    expect(out.changedFiles.length).toBeGreaterThan(0);
  });

  it('verify 失败 → 真自动回滚，目标文件恢复原样（安全网真实可用）', async () => {
    writeFileSync(join(root, 'target.txt'), 'ORIGINAL\n');
    const ref = writePatchPlan('target.txt', 'BAD_CHANGE\n');
    const exec = implementationExecutor({ verifyOk: false });
    let err = null;
    try {
      await exec({ act: { id: 'a2', payload: { selfEvolutionGate: { ok: true }, selfEvolution: { patchPlanRef: ref } } } });
    } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.message).toBe('self_evolution_verify_failed_rolled_back_needs_self_repair');
    expect(err.selfEvolution.needsSelfRepair).toBe(true);
    expect(err.selfEvolution.rolledBack).toBe(true);
    // 真实回滚证明：文件回到原样
    expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('ORIGINAL\n');
  });

  it('gate 未过 → executor 拒绝执行，文件不动（纵深防御真实可用）', async () => {
    writeFileSync(join(root, 'target.txt'), 'ORIGINAL\n');
    const ref = writePatchPlan('target.txt', 'SHOULD_NOT_APPLY\n');
    const exec = implementationExecutor({ verifyOk: true });
    await expect(exec({
      act: { id: 'a3', payload: { selfEvolutionGate: { ok: false }, selfEvolution: { patchPlanRef: ref } } },
    })).rejects.toThrow('gate_not_passed_in_executor');
    expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('ORIGINAL\n');
  });

  it('standing grant 未授权 → 拒绝执行，文件不动（P1-3 真实可用）', async () => {
    writeFileSync(join(root, 'target.txt'), 'ORIGINAL\n');
    const ref = writePatchPlan('target.txt', 'NO_GRANT\n');
    const executors = registerNoeSelfEvolutionExecutors(new Map(), {
      root,
      evaluateGrant: () => ({ authorized: false }),
      runtimeVerify: async () => ({ ok: true }),
      now: () => new Date('2026-06-14T00:00:00.000Z'),
    });
    await expect(executors.get('noe.self_evolution.implementation')({
      act: { id: 'a4', payload: { selfEvolutionGate: { ok: true }, selfEvolution: { patchPlanRef: ref } } },
    })).rejects.toThrow('self_evolution_apply_requires_standing_grant');
    expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('ORIGINAL\n');
  });
});

// P0-5 安全门时序：先停火再装弹——dry-run 预检必须在「写盘前」拦住禁区文件（policy/tests/退路/自身源码），
//   blocker 字符串固定为 patch_path_policy_protected:<path>。证明 REAL_APPLY=1 也无法越权改禁区。
describe('P0-5 安全门时序：dry-run 改禁区文件被 patch_path_policy_protected 拦（真实 NoePatchApplyExecutor）', () => {
  async function expectBlocked(targetRel, original, sabotage, actId) {
    const ref = writePatchPlan(targetRel, sabotage);
    const exec = implementationExecutor({ verifyOk: true });
    let err = null;
    try {
      await exec({ act: { id: actId, payload: { selfEvolutionGate: { ok: true }, selfEvolution: { patchPlanRef: ref } } } });
    } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.message).toBe('self_evolution_apply_preflight_blocked');
    expect(Array.isArray(err.selfEvolution.blockers)).toBe(true);
    expect(err.selfEvolution.blockers.some((b) => b.startsWith('patch_path_policy_protected:'))).toBe(true);
    // 安全门时序铁证：preflight 拦在写盘前 → 禁区文件原样未动
    expect(readFileSync(join(root, targetRel), 'utf8')).toBe(original);
  }

  it('改 package.json（policy 文件）→ preflight_blocked，文件不动', async () => {
    writeFileSync(join(root, 'package.json'), '{"name":"victim"}\n');
    await expectBlocked('package.json', '{"name":"victim"}\n', '{"name":"hacked"}\n', 'p5-1');
  });

  it('改 tests/ 退路文件（改测试骗 verify = reward hack）→ preflight_blocked，文件不动', async () => {
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'tests/foo.test.js'), 'expect(true).toBe(true)\n');
    await expectBlocked('tests/foo.test.js', 'expect(true).toBe(true)\n', 'expect(true).toBe(false) // sabotaged\n', 'p5-2');
  });

  it('改自改链自身源码（NoeSelfEvolutionExecutors.js = 改掉自己退路）→ preflight_blocked，文件不动', async () => {
    const target = 'src/loop/NoeSelfEvolutionExecutors.js';
    mkdirSync(join(root, 'src/loop'), { recursive: true });
    writeFileSync(join(root, target), '// original self-evolution code\n');
    await expectBlocked(target, '// original self-evolution code\n', '// neutered\n', 'p5-3');
  });
});

// 红队修复：软链写穿 + 目录/特殊文件崩溃（NoePatchTransaction 层 lstat 闭掉）。
describe('P0 红队修复：软链写穿 / 目录 path 防护（真实 fs）', () => {
  it('软链（指向受保护文件）→ preflight_blocked(patch_path_is_symlink)，软链指向的文件原样不动', async () => {
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'tests/guard.test.js'), 'REAL\n'); // 受保护真文件
    mkdirSync(join(root, 'src/feature'), { recursive: true });
    symlinkSync(join(root, 'tests/guard.test.js'), join(root, 'src/feature/shim.js')); // 允许路径=软链
    const ref = writePatchPlan('src/feature/shim.js', 'HACKED\n');
    const exec = implementationExecutor({ verifyOk: true });
    let err = null;
    try { await exec({ act: { id: 'sl', payload: { selfEvolutionGate: { ok: true }, selfEvolution: { patchPlanRef: ref } } } }); }
    catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.message).toBe('self_evolution_apply_preflight_blocked');
    expect(err.selfEvolution.blockers.some((b) => b.startsWith('patch_path_is_symlink:'))).toBe(true);
    expect(readFileSync(join(root, 'tests/guard.test.js'), 'utf8')).toBe('REAL\n'); // 写穿被挡
  });

  it('目标是已存在目录 → preflight_blocked(patch_path_not_a_file)，不崩 EISDIR', async () => {
    mkdirSync(join(root, 'src/loop'), { recursive: true });
    const ref = writePatchPlan('src/loop', 'whatever\n');
    const exec = implementationExecutor({ verifyOk: true });
    let err = null;
    try { await exec({ act: { id: 'dir', payload: { selfEvolutionGate: { ok: true }, selfEvolution: { patchPlanRef: ref } } } }); }
    catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.message).toBe('self_evolution_apply_preflight_blocked');
    expect(err.selfEvolution.blockers.some((b) => b.startsWith('patch_path_not_a_file:'))).toBe(true);
  });

  // round-2 红队#1：父目录是软链（指向沙箱外）→ lstat 末段看不出，但 realpath 祖先校验拦住，不写穿沙箱外。
  it('父目录软链（指向沙箱外）→ preflight_blocked(patch_path_outside_root)，沙箱外文件不被写穿', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'noe-outside-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      symlinkSync(outside, join(root, 'src/evil')); // root/src/evil -> 沙箱外目录
      const ref = writePatchPlan('src/evil/pwned.txt', 'PWNED_OUTSIDE\n');
      const exec = implementationExecutor({ verifyOk: true });
      let err = null;
      try { await exec({ act: { id: 'pe', payload: { selfEvolutionGate: { ok: true }, selfEvolution: { patchPlanRef: ref } } } }); }
      catch (e) { err = e; }
      expect(err).toBeTruthy();
      expect(err.message).toBe('self_evolution_apply_preflight_blocked');
      expect(err.selfEvolution.blockers.some((b) => b.startsWith('patch_path_outside_root:'))).toBe(true);
      expect(existsSync(join(outside, 'pwned.txt'))).toBe(false); // 没写穿到沙箱外
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
