// @ts-check
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeNoeSelfEvolutionImplementer } from '../../src/loop/NoeSelfEvolutionExecutors.js';

// P0.4 反向 probe：implementer 所有 adapter 都出不了 patch 时，绝不静默吞成成功。
//   必须 (a) 抛 self_evolution_no_patch_plan_in_reply 而非 return；
//        (b) 落 diag 文件到 output/noe-self-evolution/implementer-fail/*.json（失败可见、可取证）。
//   只注入【环境侧】依赖（route/getAdapter/structuredCall = 模型调用边界），被测机制本身（失败判定 +
//   diag 落盘 + 显式上抛，约在 NoeSelfEvolutionExecutors.js:571-597）不 mock —— 改坏它这个测试必红。

const route = () => ({ adapterId: 'codex' });
// 真 adapter 形状（含 chat fn），让候选循环真正进入 structuredCall 分支，而非走 adapter_unavailable 短路。
const codexAdapter = { id: 'codex', chat: () => {} };
const lmAdapter = { id: 'lmstudio', chat: () => {} };
const getAdapter = (aid) => (aid === 'lmstudio' ? lmAdapter : codexAdapter);
const FAIL_DIR = 'output/noe-self-evolution/implementer-fail';
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const listFails = (root) => {
  const dir = resolve(root, FAIL_DIR);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
};

describe('P0.4 反向 probe：no_patch 必显式抛 + 落 diag，绝不静默吞成成功', () => {
  it('两候选都出不了 patch → 必抛(不 return) + diag 文件真落盘 implementer-fail/*.json', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-p04-'));
    try {
      // 模型调用边界全失败（codex 硬网络断 + lmstudio 也离线）——被测的是"全失败时系统怎么收口"。
      const sc = async ({ adapter }) => ({ ok: false, error: adapter.id === 'codex' ? 'connect error 61' : 'lmstudio offline ECONNREFUSED' });
      const impl = makeNoeSelfEvolutionImplementer({ getAdapter, route, root, now: () => new Date('2026-06-22T00:00:00Z'), structuredCall: sc });

      let caught;
      let returned = Symbol('not-returned');
      try { returned = await impl({ objective: '给 src/x.js 加输入校验' }); } catch (e) { caught = e; }

      // 反向核心①：失败必须以异常上抛，绝不静默 return 一个"成功"对象（吞错=假绿，这条挡死）。
      //   returned 仍是哨兵 symbol（未被赋值）才证明 impl 抛了而非 return 了。
      expect(typeof returned).toBe('symbol');
      expect(caught).toBeInstanceOf(Error);
      expect(caught.message).toBe('self_evolution_no_patch_plan_in_reply');

      // 反向核心②：diag 文件真落到 implementer-fail/ 目录（失败可取证，不黑盒）。机制移除→此处 0 个文件→红。
      const diagRef = caught?.selfEvolution?.diagRef;
      expect(diagRef).toContain(FAIL_DIR);
      const diagAbs = resolve(root, diagRef);
      expect(existsSync(diagAbs)).toBe(true);
      expect(listFails(root).length).toBeGreaterThanOrEqual(1);

      const diag = readJson(diagAbs);
      expect(diag.kind).toBe('noe_self_evolution_implementer_fail');
      expect(diag.resultOk).toBe(false); // 显式标记失败，而非含糊
      // 两候选的真实尝试都在 diag 里（黑洞修复：lmstudio 兜底试没试也可见）。
      expect(diag.attemptedCandidates.map((c) => c.id).sort()).toEqual(['codex', 'lmstudio']);
      expect(diag.attemptedCandidates.every((c) => c.ok === false)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('静默成功诱饵：ok 但 operations:[] → 不得当成功 return，仍抛 no_patch_plan(防"空 patch 假绿")', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-p04-'));
    try {
      // 红队诱饵：结构化调用 ok:true 但 operations 为空。若 isUsablePatchPlan/失败判定被弱化成"有 ok 就算成功"，
      //   impl 会 return 一个 patchPlanRef（假绿）；正确机制必须识破空 plan、继续降级、最终抛错。
      const sc = async () => ({ ok: true, value: { kind: 'noe_patch_plan', operations: [] } });
      const impl = makeNoeSelfEvolutionImplementer({ getAdapter, route, root, now: () => new Date('2026-06-22T00:00:00Z'), structuredCall: sc });

      let caught;
      let returned = null;
      try { returned = await impl({ objective: 'x' }); } catch (e) { caught = e; }

      // 反向核心③：空 operations 的"假成功"绝不能变成真 return —— 必须抛错。机制被改成"ok 即成功"→ returned 有值 → 红。
      expect(returned).toBeNull();
      expect(caught?.message).toBe('self_evolution_no_patch_plan_in_reply');
      // 候选记下确切失败因（non_usable_patch_plan），不是"失败但无因"的黑洞。
      const diag = readJson(resolve(root, caught.selfEvolution.diagRef));
      expect(diag.attemptedCandidates.every((c) => c.ok === false && c.error === 'non_usable_patch_plan')).toBe(true);
      // rawReplyExcerpt 保留真实空操作回复（非 [object Object]），让人能看清模型到底回了啥。
      expect(diag.rawReplyExcerpt).toContain('operations');
      expect(diag.rawReplyExcerpt).not.toContain('[object Object]');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
