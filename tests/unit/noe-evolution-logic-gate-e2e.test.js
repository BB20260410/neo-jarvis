import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerNoeSelfEvolutionExecutors } from '../../src/loop/NoeSelfEvolutionExecutors.js';
import { createEvolutionOutcome } from '../../src/cognition/NoeEvolutionOutcome.js';
import { createEvolutionLogicGate } from '../../src/loop/NoeEvolutionLogicGate.js';

// P3 受控逻辑改进门 端到端：真 NoePatchApplyExecutor + 真 P0 度量 + 真 gate + 临时 root。
//   证明：改 src 逻辑默认被挡（flag OFF）+ flag ON 过双绿门才保留 + baseline 不绿拒 + 非逻辑改动(neutral)放行。
//   这是 P0/P2/P3 联动的真实机证据：P2 产改逻辑信号 → 飞轮 implement → P3 门按 P0 verdict 分流。

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'noe-p3-')); mkdirSync(join(root, 'src'), { recursive: true }); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function writePatchPlan(targetRel, content) {
  const ref = 'output/noe-self-evolution/test/patch-plan.json';
  mkdirSync(join(root, 'output/noe-self-evolution/test'), { recursive: true });
  writeFileSync(join(root, ref), JSON.stringify({
    kind: 'noe_patch_plan',
    operations: [{ id: 'op1', op: 'write_file', path: targetRel, content }],
  }));
  return ref;
}

// verifySeq：按调用顺序返回 ok（flag ON 时 baseline=第1次、verify=第2次；用尽取最后一个）。
function mkExec({ logicEnabled, verifySeq }) {
  let i = 0;
  const runtimeVerify = async () => {
    const ok = verifySeq[Math.min(i, verifySeq.length - 1)];
    i += 1;
    return { ok, reportRef: 'output/noe-self-evolution/runtime-verify/v.json' };
  };
  const evolutionOutcome = createEvolutionOutcome({
    scanner: { scan: () => ({ signals: [] }) },
    fsReadFile: (p) => readFileSync(p, 'utf8'),
    projectRoot: root,
    recordOutcome: () => {},
  });
  const evolutionLogicGate = createEvolutionLogicGate({ logicEnabled: () => logicEnabled });
  const executors = registerNoeSelfEvolutionExecutors(new Map(), {
    root,
    evaluateGrant: () => ({ authorized: true }),
    runtimeVerify,
    now: () => new Date('2026-06-27T00:00:00.000Z'),
    evolutionOutcome,
    evolutionLogicGate,
  });
  return executors.get('noe.self_evolution.implementation');
}

const run = (exec, ref, id) => exec({ act: { id, payload: { selfEvolutionGate: { ok: true }, selfEvolution: { patchPlanRef: ref } } } });

describe('P3 受控逻辑改进门 端到端（真 apply + 真度量 + 真 gate）', () => {
  it('改 src 逻辑 + flag OFF → logic_change_blocked(pre_verify)，文件原子回滚', async () => {
    writeFileSync(join(root, 'src/foo.js'), 'export const x = 1;\n');
    const ref = writePatchPlan('src/foo.js', 'export const x = 1;\nexport const y = 2;\n');
    const exec = mkExec({ logicEnabled: false, verifySeq: [true] });
    let err = null;
    try { await run(exec, ref, 'p3-off'); } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.message).toBe('self_evolution_logic_change_blocked');
    expect(err.selfEvolution.reason).toBe('logic_change_disabled');
    expect(err.selfEvolution.phase).toBe('pre_verify');
    expect(err.selfEvolution.rolledBack).toBe(true);
    expect(readFileSync(join(root, 'src/foo.js'), 'utf8')).toBe('export const x = 1;\n'); // 回滚铁证
  });

  it('改 src 逻辑 + flag ON + 双绿 → 真改了（受控重构保留）', async () => {
    writeFileSync(join(root, 'src/foo.js'), 'export const x = 1;\n');
    const ref = writePatchPlan('src/foo.js', 'export const x = 1;\nexport const y = 2;\n');
    const exec = mkExec({ logicEnabled: true, verifySeq: [true, true] }); // baseline ok + verify ok
    const out = await run(exec, ref, 'p3-on');
    expect(out.applied).toBe(true);
    expect(readFileSync(join(root, 'src/foo.js'), 'utf8')).toBe('export const x = 1;\nexport const y = 2;\n');
  });

  it('改 src 逻辑 + flag ON + baseline 不绿 → blocked(baseline_not_green, post_verify)，回滚', async () => {
    writeFileSync(join(root, 'src/foo.js'), 'export const x = 1;\n');
    const ref = writePatchPlan('src/foo.js', 'export const x = 1;\nexport const y = 2;\n');
    const exec = mkExec({ logicEnabled: true, verifySeq: [false, true] }); // baseline 不绿 + verify 绿
    let err = null;
    try { await run(exec, ref, 'p3-base'); } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.message).toBe('self_evolution_logic_change_blocked');
    expect(err.selfEvolution.reason).toBe('baseline_not_green');
    expect(err.selfEvolution.phase).toBe('post_verify');
    expect(readFileSync(join(root, 'src/foo.js'), 'utf8')).toBe('export const x = 1;\n');
  });

  it('加注释(neutral，代码行不变) + flag OFF → 放行 applied（doc/neutral 不受门限，零回归）', async () => {
    writeFileSync(join(root, 'src/foo.js'), 'export const x = 1;\n');
    const ref = writePatchPlan('src/foo.js', '// added note\nexport const x = 1;\n');
    const exec = mkExec({ logicEnabled: false, verifySeq: [true] });
    const out = await run(exec, ref, 'p3-neutral');
    expect(out.applied).toBe(true);
    expect(readFileSync(join(root, 'src/foo.js'), 'utf8')).toBe('// added note\nexport const x = 1;\n');
  });
});

// 根因修复：outcome 按最终结局标 applied —— 被拦/回滚的改逻辑 applied:false，真保留的 applied:true。
//   防 P4 把失败尝试当成功蒸馏、P5 把空转诊断成「健康」（度量层自欺）。
describe('P0 根因修复：evolution_outcome 按最终结局标 applied', () => {
  function mkExecWithRecorder({ logicEnabled, verifySeq }) {
    const recorded = [];
    let i = 0;
    const runtimeVerify = async () => { const ok = verifySeq[Math.min(i, verifySeq.length - 1)]; i += 1; return { ok, reportRef: 'r.json' }; };
    const evolutionOutcome = createEvolutionOutcome({ scanner: { scan: () => ({ signals: [] }) }, fsReadFile: (p) => readFileSync(p, 'utf8'), projectRoot: root, recordOutcome: (s) => recorded.push(s) });
    const evolutionLogicGate = createEvolutionLogicGate({ logicEnabled: () => logicEnabled });
    const executors = registerNoeSelfEvolutionExecutors(new Map(), { root, evaluateGrant: () => ({ authorized: true }), runtimeVerify, now: () => new Date('2026-06-27T00:00:00.000Z'), evolutionOutcome, evolutionLogicGate });
    return { exec: executors.get('noe.self_evolution.implementation'), recorded };
  }

  it('改逻辑 + flag OFF 被拦 → 落账 applied:false（记了"尝试"但标明"没保留"）', async () => {
    writeFileSync(join(root, 'src/foo.js'), 'export const x = 1;\n');
    const ref = writePatchPlan('src/foo.js', 'export const x = 1;\nexport const y = 2;\n');
    const { exec, recorded } = mkExecWithRecorder({ logicEnabled: false, verifySeq: [true] });
    try { await run(exec, ref, 'a1'); } catch { /* 预期 throw logic_change_blocked */ }
    expect(recorded.length).toBe(1);
    expect(recorded[0].verdict).toBe('logic_changed'); // 真改了逻辑
    expect(recorded[0].applied).toBe(false);           // 但被拦回滚，没保留
  });

  it('改逻辑 + flag ON 双绿通过 → 落账 applied:true（真保留的成功）', async () => {
    writeFileSync(join(root, 'src/foo.js'), 'export const x = 1;\n');
    const ref = writePatchPlan('src/foo.js', 'export const x = 1;\nexport const y = 2;\n');
    const { exec, recorded } = mkExecWithRecorder({ logicEnabled: true, verifySeq: [true, true] });
    await run(exec, ref, 'a2');
    expect(recorded[recorded.length - 1].applied).toBe(true);
    expect(recorded[recorded.length - 1].verdict).toBe('logic_changed');
  });

  it('改逻辑 + flag ON + verify 失败回滚 → 落账 applied:false', async () => {
    writeFileSync(join(root, 'src/foo.js'), 'export const x = 1;\n');
    const ref = writePatchPlan('src/foo.js', 'export const x = 1;\nexport const y = 2;\n');
    const { exec, recorded } = mkExecWithRecorder({ logicEnabled: true, verifySeq: [true, false] }); // baseline 绿 + verify 挂
    try { await run(exec, ref, 'a3'); } catch { /* 可能 throw 或返回 ok:false */ }
    expect(recorded[recorded.length - 1].applied).toBe(false);
  });
});
