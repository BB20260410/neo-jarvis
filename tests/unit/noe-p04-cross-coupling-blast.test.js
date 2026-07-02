// @ts-check
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  registerNoeSelfEvolutionExecutors,
  makeNoeSelfEvolutionRuntimeVerify,
  SELF_EVOLUTION_GRANT_SCOPE,
} from '../../src/loop/NoeSelfEvolutionExecutors.js';

// P0.4 反向 probe：自改引入的【跨文件耦合破坏】被 runtimeVerify(真跑测试) 捕获 → verify 失败硬门 →
//   cycle 不推进 complete(executor throw + 文件 rollback)。
// 真实机制全留(applyAndVerify 的 apply→verify→rollback→throw 链、真改临时文件、真 runtimeVerify 判据)；
//   唯一注入是 spawnFn——它【真读被改后的盘上文件 + 真 import consumer】判耦合是否被打断，不是伪造判决。
//   若 verify 硬门被改坏/移除，下面"破坏耦合→必须 throw + 必须 rollback"的反向断言会立刻变红。

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noe-p04-blast-'));
  mkdirSync(resolve(root, 'src'), { recursive: true });
  // 跨文件耦合：consumer 静态依赖 provider 导出的 MAGIC。
  writeFileSync(resolve(root, 'src/provider.js'), 'export const MAGIC = 42;\n');
  writeFileSync(resolve(root, 'src/consumer.js'), "import { MAGIC } from './provider.js';\nexport const doubled = MAGIC * 2;\n");
});
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

// 真 spawnFn：真读被改后的盘上文件 + 真动态 import consumer 触发模块解析；耦合断 → import 抛 →
//   写真实 vitest 形状 JSON(numFailedTests>0) 并返回非零 exitCode。判决来自真实模块解析，非伪造。
async function realCouplingSpawn(_cmd, args) {
  const outFlag = args.find((a) => String(a).startsWith('--outputFile='));
  const jsonPath = String(outFlag).slice('--outputFile='.length);
  let numFailedTests = 0;
  let stderr = '';
  try {
    const url = `${pathToFileURL(resolve(root, 'src/consumer.js')).href}?t=${Date.now()}-${Math.random()}`;
    const mod = await import(url);
    if (mod.doubled !== 84) { numFailedTests = 1; stderr = `coupling assertion failed: doubled=${String(mod.doubled)}`; }
  } catch (e) {
    numFailedTests = 1;
    stderr = `module resolution broke: ${e && e.message ? e.message : String(e)}`;
  }
  const report = { numTotalTests: 1, numPassedTests: 1 - numFailedTests, numFailedTests, success: numFailedTests === 0 };
  writeFileSync(jsonPath, JSON.stringify(report));
  return { exitCode: numFailedTests === 0 ? 0 : 1, stdout: 'ran', stderr };
}

function makeDeps() {
  const runtimeVerify = makeNoeSelfEvolutionRuntimeVerify({
    cwd: root,
    now: () => new Date('2026-06-22T00:00:00Z'),
    spawnFn: realCouplingSpawn, // 仅注入进程边界；verify 判据/落盘/可信度全是真实生产代码
  });
  return {
    root,
    evaluateGrant: () => ({ authorized: true, scope: SELF_EVOLUTION_GRANT_SCOPE }),
    runtimeVerify,
    now: () => new Date('2026-06-22T00:00:00Z'),
  };
}

// 写真实 patch-plan(write_file 整体重写 provider.js)；breakCoupling=true 改导出名 → 打断 consumer 的 import。
function writePatchPlan(breakCoupling) {
  const content = breakCoupling
    ? 'export const RENAMED = 42;\n' // MAGIC 没了 → consumer 的 import { MAGIC } 解析失败
    : 'export const MAGIC = 42; // touched but coupling intact\n';
  const ref = 'output/noe-self-evolution/patch-plan.json';
  const file = resolve(root, ref);
  mkdirSync(resolve(root, 'output/noe-self-evolution'), { recursive: true });
  writeFileSync(file, JSON.stringify({
    kind: 'noe_patch_plan',
    objective: breakCoupling ? '破坏跨文件耦合' : '改 provider 但不破坏耦合',
    operations: [{ id: 'op-1', op: 'write_file', path: 'src/provider.js', content }],
  }));
  return ref;
}

function makeAct(patchPlanRef) {
  return {
    id: 'act-blast-1',
    action: 'noe.self_evolution.implementation',
    projectId: 'noe',
    payload: { selfEvolutionGate: { ok: true }, selfEvolution: { patchPlanRef } },
  };
}

function impl(deps) {
  return registerNoeSelfEvolutionExecutors(new Map(), deps).get('noe.self_evolution.implementation');
}

describe('P0.4 跨耦合 blast 回归捕获（反向 probe，真实 apply→verify→rollback 链）', () => {
  // 反向断言①(核心)：破坏耦合 → 真 runtimeVerify 捕获 → executor 必须 throw 硬门(cycle 绝不推进 complete)。
  //   若 verify 硬门被移除/改坏，此 throw 不再发生 → 测试红。
  it('破坏跨文件耦合 → verify 失败硬门 → throw needs_self_repair（不推进 complete）', async () => {
    const deps = makeDeps();
    const ref = writePatchPlan(true);
    let caught = null;
    try { await impl(deps)({ act: makeAct(ref) }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toBe('self_evolution_verify_failed_rolled_back_needs_self_repair');
    expect(caught.selfEvolution.needsSelfRepair).toBe(true);
  });

  // 反向断言②：破坏后必须真 rollback——盘上 provider.js 还原回原耦合内容(含 MAGIC，不含 RENAMED)。
  //   验"危险操作被正确恢复"而非 happy path；rollback 链断 → 文件停在坏内容 → 测试红。
  it('破坏耦合触发 rollback → 盘上 provider.js 真还原（坏改动不落地）', async () => {
    const deps = makeDeps();
    const ref = writePatchPlan(true);
    await expect(impl(deps)({ act: makeAct(ref) })).rejects.toThrow(/needs_self_repair/);
    const onDisk = readFileSync(resolve(root, 'src/provider.js'), 'utf8');
    expect(onDisk).toContain('export const MAGIC = 42');
    expect(onDisk).not.toContain('RENAMED');
    expect(existsSync(resolve(root, 'src/consumer.js'))).toBe(true);
  });

  // 对照断言(机制活性证明)：同样的真 apply→真 verify 链，但 patch 不破坏耦合 → verify 真通过 → 不 throw、applied=true。
  //   证上面的红不是"verify 永远 fail"假象——机制确实在按耦合是否破坏区分；若硬门误杀正常 patch，此用例会红。
  it('对照：改 provider 但保留耦合 → verify 通过 → applied=true，不 throw', async () => {
    const deps = makeDeps();
    const ref = writePatchPlan(false);
    const out = await impl(deps)({ act: makeAct(ref) });
    expect(out.applied).toBe(true);
    expect(out.runtimeOk).toBe(true);
    expect(out.secretValuesReturned).toBe(false);
  });
});
