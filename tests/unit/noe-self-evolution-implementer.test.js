import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeNoeSelfEvolutionImplementer } from '../../src/loop/NoeSelfEvolutionExecutors.js';

// 补测缺口：executor 测试用 spawnImplementer stub 绕过，真 makeNoeSelfEvolutionImplementer 此前没单独测。
// 同时验 rank7 接入（noeStructuredCall 三档降级，向后兼容 parseNoeLlmJson）。

let root;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'noe-impl-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function adapterReplying(reply) {
  const calls = [];
  return { calls, chat: async (messages, opts) => { calls.push(opts || {}); return { reply }; } };
}

const route = () => ({ adapterId: 'codex' });

describe('makeNoeSelfEvolutionImplementer（rank7 接入 + 补测缺口）', () => {
  it('模型出 patch plan → 写 patch-plan.json（脱敏 payload）+ 返回 patchPlanRef/adapterId', async () => {
    const adapter = adapterReplying('{"kind":"noe_patch_plan","operations":[{"op":"write_file","path":"x.js","content":"// hi"}]}');
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter: () => adapter, route, root, now: () => new Date('2026-06-14T00:00:00.000Z') });
    const out = await impl({ objective: '改进 X' });
    expect(out.patchPlanRef).toMatch(/patch-plan\.json$/);
    expect(out.adapterId).toBe('codex');
    const file = join(root, out.patchPlanRef);
    expect(existsSync(file)).toBe(true);
    const payload = JSON.parse(readFileSync(file, 'utf8'));
    expect(payload.kind).toBe('noe_patch_plan');
    expect(payload.patchPlan.operations[0].path).toBe('x.js');
    expect(payload.secretValuesReturned).toBe(false);
    // rank7：首档传了 json_schema response_format（不支持的 adapter 会被忽略 → 降级 parseNoeLlmJson 兜底）
    expect(adapter.calls[0].response_format?.type).toBe('json_schema');
  });

  it('模型出废话（无 patch plan）→ throw self_evolution_no_patch_plan_in_reply', async () => {
    const adapter = adapterReplying('我不知道怎么改');
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter: () => adapter, route, root });
    await expect(impl({ objective: 'x' })).rejects.toThrow('self_evolution_no_patch_plan_in_reply');
  });

  it('route/getAdapter 未注入 → throw self_evolution_implementer_not_wired', async () => {
    const impl = makeNoeSelfEvolutionImplementer({});
    await expect(impl({ objective: 'x' })).rejects.toThrow('self_evolution_implementer_not_wired');
  });

  it('adapter 无 chat → throw self_evolution_implementer_no_adapter', async () => {
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter: () => ({}), route, root });
    await expect(impl({ objective: 'x' })).rejects.toThrow('self_evolution_implementer_no_adapter');
  });

  it('向后兼容：adapter 忽略 response_format 但回纯文本含 JSON → parseNoeLlmJson 兜底仍出 plan', async () => {
    const adapter = { chat: async () => ({ reply: '方案如下：\n```json\n{"kind":"noe_patch_plan","operations":[{"op":"write_file","path":"y.js","content":"x"}]}\n```' }) };
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter: () => adapter, route, root });
    const out = await impl({ objective: 'x' });
    const payload = JSON.parse(readFileSync(join(root, out.patchPlanRef), 'utf8'));
    expect(payload.patchPlan.operations[0].path).toBe('y.js');
  });

  // 根因修复(2026-07-01):self_directed 方向的 objective 只有模块名(如"CircuitBreaker")、无 src/ 完整路径，
  //   readTargetFileContext 正则匹配不到 → fileContext 空 → minimax 猜路径 → patch_replace_file_missing → dropped。
  //   修:透传方向 meta.targetFile(完整路径)，spawnImplementer 拼进让正则匹配真实文件 + userContent 明确 path。
  it('targetFile 透传 → userContent 明确真实路径 + 读到真实文件内容(治 minimax 猜路径 file_missing)', async () => {
    mkdirSync(join(root, 'src/safety'), { recursive: true });
    writeFileSync(join(root, 'src/safety/CircuitBreaker.js'), 'export class CircuitBreaker { constructor(o) { this.threshold = o; } }');
    const seen = [];
    const adapter = { chat: async (messages) => { seen.push(messages); return { reply: '{"kind":"noe_patch_plan","operations":[{"op":"write_file","path":"src/safety/CircuitBreaker.js","content":"x"}]}' }; } };
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter: () => adapter, route, root });
    // objective 只有模块名(无 src/ 完整路径)——self_directed 方向实况；targetFile 给真实完整路径
    await impl({ objective: 'Add input validation to CircuitBreaker constructor', targetFile: 'src/safety/CircuitBreaker.js' });
    const userMsg = seen[0].find((m) => m.role === 'user').content;
    expect(userMsg).toContain('src/safety/CircuitBreaker.js'); // 明确真实路径给 minimax
    expect(userMsg).toContain('this.threshold'); // readTargetFileContext 读到真实文件内容(拼 targetFile 后正则匹配)
  });

  it('无 targetFile + objective 只模块名 → 逐字现状(只 Objective,不加路径段)，零回归', async () => {
    const seen = [];
    const adapter = { chat: async (messages) => { seen.push(messages); return { reply: '{"kind":"noe_patch_plan","operations":[{"op":"write_file","path":"x.js","content":"x"}]}' }; } };
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter: () => adapter, route, root });
    await impl({ objective: 'Add validation to CircuitBreaker' }); // 无 targetFile
    const userMsg = seen[0].find((m) => m.role === 'user').content;
    expect(userMsg).toContain('Objective: Add validation to CircuitBreaker');
    expect(userMsg).not.toContain('目标文件（patch operations'); // 无 targetFile 不加明确路径段
  });

  // P0-2 codex 失败降级本地兜底（云端 API 单点故障消除）：route 选 codex，codex 出不了 → 降级 lmstudio。
  it('降级兜底：codex（route 选）空回无 patch → 降级 lmstudio 出 patch，adapterId=lmstudio', async () => {
    const codex = adapterReplying('连接失败，没有方案');
    const lmstudio = adapterReplying('{"kind":"noe_patch_plan","operations":[{"op":"write_file","path":"z.js","content":"// ok"}]}');
    const getAdapter = (id) => (id === 'lmstudio' ? lmstudio : codex);
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter, route: () => ({ adapterId: 'codex' }), root });
    const out = await impl({ objective: '改进 Z' });
    expect(out.adapterId).toBe('lmstudio'); // 报告真实出 patch 的 adapter（降级可观测）
    const payload = JSON.parse(readFileSync(join(root, out.patchPlanRef), 'utf8'));
    expect(payload.patchPlan.operations[0].path).toBe('z.js');
    expect(payload.routedAdapterId).toBe('codex'); // route 原选仍记录
    expect(codex.calls.length).toBeGreaterThan(0); // codex 先被试（重试+三档降级后才降级 lmstudio；重试次数由专门测试覆盖）
  });

  it('降级兜底：codex chat throw（网络 error 61 类）→ 降级 lmstudio 仍出 patch', async () => {
    const codex = { chat: async () => { throw new Error('error 61 wss://chatgpt.com connect refused'); } };
    const lmstudio = adapterReplying('{"kind":"noe_patch_plan","operations":[{"op":"write_file","path":"w.js","content":"x"}]}');
    const getAdapter = (id) => (id === 'lmstudio' ? lmstudio : codex);
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter, route: () => ({ adapterId: 'codex' }), root });
    const out = await impl({ objective: 'x' });
    expect(out.adapterId).toBe('lmstudio');
  });

  it('红队修复：codex 返回空 operations({operations:[]}) → 不算可用 patch，降级 lmstudio', async () => {
    const codex = adapterReplying('{"kind":"noe_patch_plan","operations":[]}');
    const lmstudio = adapterReplying('{"kind":"noe_patch_plan","operations":[{"op":"write_file","path":"e.js","content":"x"}]}');
    const getAdapter = (id) => (id === 'lmstudio' ? lmstudio : codex);
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter, route: () => ({ adapterId: 'codex' }), root });
    const out = await impl({ objective: 'x' });
    expect(out.adapterId).toBe('lmstudio');
    const payload = JSON.parse(readFileSync(join(root, out.patchPlanRef), 'utf8'));
    expect(payload.patchPlan.operations[0].path).toBe('e.js');
  });

  it('红队修复：两端都空 operations → throw no_patch_plan（不把空当成功）', async () => {
    const empty = adapterReplying('{"kind":"noe_patch_plan","operations":[]}');
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter: () => empty, route: () => ({ adapterId: 'codex' }), root });
    await expect(impl({ objective: 'x' })).rejects.toThrow('self_evolution_no_patch_plan_in_reply');
  });

  it('重试 K 次：codex 第一次空回、第二次出 patch → 不降级，adapterId=codex', async () => {
    let n = 0;
    const codex = { calls: [], chat: async (_m, opts) => { n += 1; codex.calls.push(opts || {}); return n === 1 ? { reply: '稍等' } : { reply: '{"kind":"noe_patch_plan","operations":[{"op":"write_file","path":"r.js","content":"x"}]}' }; } };
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter: () => codex, route: () => ({ adapterId: 'codex' }), root });
    const out = await impl({ objective: 'x' });
    expect(out.adapterId).toBe('codex');
    expect(n).toBe(2); // 第一次失败→重试一次成功，未降级
  });

  // #26 本地优先（owner 选 A·消除 codex 单点）：localFirst ON → 本地 lmstudio 先试（不会 token 失效、localhost 不卡 401
  //   认证循环；根因=codex token revoked 时 codex exec 卡 401 重试→selfEvolve tick 卡 running 几小时→飞轮停摆）。
  //   codex 降为可选兜底。flag 默认 OFF=现状(codex 先)逐字零回归，server 按 NOE_SELFEVO_LOCAL_FIRST 注入。
  it('#26 本地优先 ON：route 选 codex 但 localFirst → 先试 lmstudio 出 patch，codex 完全不被调，adapterId=lmstudio', async () => {
    const codex = adapterReplying('{"kind":"noe_patch_plan","operations":[{"op":"write_file","path":"c.js","content":"//codex"}]}');
    const lmstudio = adapterReplying('{"kind":"noe_patch_plan","operations":[{"op":"write_file","path":"l.js","content":"//local"}]}');
    const getAdapter = (id) => (id === 'lmstudio' ? lmstudio : codex);
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter, route: () => ({ adapterId: 'codex' }), root, localFirst: true });
    const out = await impl({ objective: 'x' });
    expect(out.adapterId).toBe('lmstudio'); // 本地先出 patch
    expect(codex.calls.length).toBe(0); // 本地成功 → codex 完全不被调（消除 codex 依赖，token 失效也不影响）
  });

  it('#26 本地优先 ON：lmstudio 出不了 → 降级 codex 兜底（保留 fallback，codex 可选）', async () => {
    const codex = adapterReplying('{"kind":"noe_patch_plan","operations":[{"op":"write_file","path":"c.js","content":"//codex"}]}');
    const lmstudio = adapterReplying('本地出不了 patch');
    const getAdapter = (id) => (id === 'lmstudio' ? lmstudio : codex);
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter, route: () => ({ adapterId: 'codex' }), root, localFirst: true });
    const out = await impl({ objective: 'x' });
    expect(out.adapterId).toBe('codex'); // 本地失败 → 降级 codex 兜底（fallback 仍在，双向韧性）
  });

  it('#26 反向 localFirst OFF（默认）：route 选 codex → codex 先试，lmstudio 不被调（逐字零回归）', async () => {
    const codex = adapterReplying('{"kind":"noe_patch_plan","operations":[{"op":"write_file","path":"c.js","content":"//codex"}]}');
    const lmstudio = adapterReplying('{"kind":"noe_patch_plan","operations":[{"op":"write_file","path":"l.js","content":"//local"}]}');
    const getAdapter = (id) => (id === 'lmstudio' ? lmstudio : codex);
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter, route: () => ({ adapterId: 'codex' }), root });
    const out = await impl({ objective: 'x' });
    expect(out.adapterId).toBe('codex'); // 现状：codex 先（零回归）
    expect(lmstudio.calls.length).toBe(0); // codex 成功 → lmstudio 不被调
  });
});

describe('任务2: 可配本地 code adapter（implement 本地优先用专用 code 模型而非借主脑）', () => {
  it('localFirst 默认本地 adapter id=lmstudio（零回归）', async () => {
    const seen = [];
    const getAdapter = (id) => { seen.push(id); return adapterReplying('{"kind":"noe_patch_plan","operations":[{"op":"write_file","path":"x.js","content":"//"}]}'); };
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter, route: () => ({ adapterId: 'minimax' }), root, localFirst: true });
    await impl({ objective: 'x' });
    expect(seen[0]).toBe('lmstudio'); // 本地优先第一个试 lmstudio
  });

  it('注入 localCodeAdapterId 时本地优先试它（如 lmstudio-code=专用27b）', async () => {
    const seen = [];
    const getAdapter = (id) => { seen.push(id); return adapterReplying('{"kind":"noe_patch_plan","operations":[{"op":"write_file","path":"x.js","content":"//"}]}'); };
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter, route: () => ({ adapterId: 'minimax' }), root, localFirst: true, localCodeAdapterId: 'lmstudio-code' });
    const out = await impl({ objective: 'x' });
    expect(seen[0]).toBe('lmstudio-code'); // 本地优先第一个试专用 code adapter
    expect(out.adapterId).toBe('lmstudio-code');
  });

  it('localCodeAdapterId 失败 → 降级云端兜底（本地 miss 云端救场）', async () => {
    const getAdapter = (id) => id === 'lmstudio-code'
      ? adapterReplying('我不会') // 本地产废话
      : adapterReplying('{"kind":"noe_patch_plan","operations":[{"op":"write_file","path":"y.js","content":"//"}]}'); // 云端出 patch
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter, route: () => ({ adapterId: 'minimax' }), root, localFirst: true, localCodeAdapterId: 'lmstudio-code' });
    const out = await impl({ objective: 'x' });
    expect(out.adapterId).toBe('minimax'); // 降级到云端
  });
})

describe('阶段二B: findFabricatedReplaceFroms(检测编造from,供re-ask纠正)', () => {
  it('from在content里→不算编造;from找不到→编造', async () => {
    const { findFabricatedReplaceFroms } = await import('../../src/loop/NoeSelfEvolutionExecutors.js');
    const content = 'export function add(a, b) {\n  return a + b;\n}\n';
    const ops = [
      { op: 'replace', from: 'export function add(a, b) {', to: 'x' }, // 真实存在
      { op: 'replace', from: 'function multiply(x, y) {', to: 'y' },    // 编造
    ];
    const fab = findFabricatedReplaceFroms(ops, content);
    expect(fab).toHaveLength(1);
    expect(fab[0]).toContain('multiply');
  });

  it('write_file 永不算编造(无from)', async () => {
    const { findFabricatedReplaceFroms } = await import('../../src/loop/NoeSelfEvolutionExecutors.js');
    expect(findFabricatedReplaceFroms([{ op: 'write_file', path: 'x', content: 'y' }], 'anything')).toHaveLength(0);
  });

  it('空/非法输入→[](fail-open)', async () => {
    const { findFabricatedReplaceFroms } = await import('../../src/loop/NoeSelfEvolutionExecutors.js');
    expect(findFabricatedReplaceFroms(null, 'x')).toEqual([]);
    expect(findFabricatedReplaceFroms([], 'x')).toEqual([]);
    expect(findFabricatedReplaceFroms([{ op: 'replace', from: 'a' }], '')).toEqual([]); // 无content不误判
  });
});

describe('阶段二B: 编造from触发re-ask纠正(端到端)', () => {
  const CONTENT_FILE = 'src/x.js';
  function adapterSeq(replies) {
    const calls = [];
    let i = 0;
    return { calls, chat: async (messages) => { calls.push(messages[messages.length - 1].content); return { reply: replies[Math.min(i++, replies.length - 1)] }; } };
  }
  it('首次编造from → re-ask附纠正 → 第二次逐字正确 → 接受', async () => {
    // fileContext 来自真实文件:写一个 targetFile 让 readTargetFileContext 读到
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const abs = join(root, CONTENT_FILE);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'export function realFn(a) {\n  return a;\n}\n');
    const adapter = adapterSeq([
      '{"kind":"noe_patch_plan","operations":[{"op":"replace","path":"src/x.js","from":"function FAKE(z) {","to":"x"}]}', // 编造
      '{"kind":"noe_patch_plan","operations":[{"op":"replace","path":"src/x.js","from":"export function realFn(a) {","to":"y"}]}', // 纠正后逐字
    ]);
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter: () => adapter, route: () => ({ adapterId: 'codex' }), root, fromReask: true });
    const out = await impl({ objective: '改 realFn', targetFile: CONTENT_FILE });
    expect(out.patchPlanRef).toBeTruthy();
    expect(adapter.calls).toHaveLength(2);                 // 触发了 re-ask
    expect(adapter.calls[1]).toContain('逐字找不到');       // 第二次带纠正提示
    const payload = JSON.parse((await import('node:fs')).readFileSync(join(root, out.patchPlanRef), 'utf8'));
    expect(payload.patchPlan.operations[0].from).toContain('realFn'); // 最终用的是逐字正确的
  });

  it('flag OFF(默认) → 不检测不re-ask(零回归):编造from直接接受走下游', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const abs = join(root, 'src/y.js');
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'export function foo() {}\n');
    const adapter = adapterSeq(['{"kind":"noe_patch_plan","operations":[{"op":"replace","path":"src/y.js","from":"function FAKE(){","to":"x"}]}']);
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter: () => adapter, route: () => ({ adapterId: 'codex' }), root, fromReask: false });
    await impl({ objective: 'x', targetFile: 'src/y.js' });
    expect(adapter.calls).toHaveLength(1); // 没 re-ask
  });
})

describe('阶段二: KG推理上下文注入implement(记忆图谱参与推理)', () => {
  it('注入 kgContext → 出现在给模型的 user 消息里(带着图谱知识改)', async () => {
    let seenMsg = '';
    const adapter = { chat: async (messages) => { seenMsg = messages[messages.length - 1].content; return { reply: '{"kind":"noe_patch_plan","operations":[{"op":"write_file","path":"x.js","content":"//"}]}' }; } };
    const impl = makeNoeSelfEvolutionImplementer({
      getAdapter: () => adapter, route: () => ({ adapterId: 'codex' }), root,
      kgContext: (q) => `\n\n[KG]关于 ${q} 的关联知识: ModuleA, ModuleB`,
    });
    await impl({ objective: '改进 MemoryCore' });
    expect(seenMsg).toContain('[KG]关于 改进 MemoryCore 的关联知识');
    expect(seenMsg).toContain('ModuleA');
  });

  it('默认 kgContext=()=>"" → user 消息无 KG 段(零回归)', async () => {
    let seenMsg = '';
    const adapter = { chat: async (messages) => { seenMsg = messages[messages.length - 1].content; return { reply: '{"kind":"noe_patch_plan","operations":[{"op":"write_file","path":"x.js","content":"//"}]}' }; } };
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter: () => adapter, route: () => ({ adapterId: 'codex' }), root });
    await impl({ objective: 'x' });
    expect(seenMsg).not.toContain('[KG]');
  });
})

describe('阶段二: 难目标分解注入implement(复杂目标约束最小第一步)', () => {
  it('flag ON + 复杂目标(多子句) → user消息含「最小第一步」约束', async () => {
    let seenMsg = '';
    const adapter = { chat: async (messages) => { seenMsg = messages[messages.length - 1].content; return { reply: '{"kind":"noe_patch_plan","operations":[{"op":"write_file","path":"x.js","content":"//"}]}' }; } };
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter: () => adapter, route: () => ({ adapterId: 'codex' }), root, decompose: true });
    await impl({ objective: '加校验并且抽常量还要补测试' });
    expect(seenMsg).toContain('最小第一步');
  });

  it('flag ON + 简单目标 → 不加约束(零成本直做)', async () => {
    let seenMsg = '';
    const adapter = { chat: async (messages) => { seenMsg = messages[messages.length - 1].content; return { reply: '{"kind":"noe_patch_plan","operations":[{"op":"write_file","path":"x.js","content":"//"}]}' }; } };
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter: () => adapter, route: () => ({ adapterId: 'codex' }), root, decompose: true });
    await impl({ objective: '给函数补JSDoc' });
    expect(seenMsg).not.toContain('最小第一步');
  });

  it('flag OFF(默认) → 复杂目标也不加约束(零回归)', async () => {
    let seenMsg = '';
    const adapter = { chat: async (messages) => { seenMsg = messages[messages.length - 1].content; return { reply: '{"kind":"noe_patch_plan","operations":[{"op":"write_file","path":"x.js","content":"//"}]}' }; } };
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter: () => adapter, route: () => ({ adapterId: 'codex' }), root });
    await impl({ objective: '加校验并且抽常量还要补测试' });
    expect(seenMsg).not.toContain('最小第一步');
  });
})

// repair 升级模型链(2026-07-03,飞轮stuck修复后续)：self_repair 拍=本地已败过一次且失败证据已拼进 objective(A2),
//   再让同一个本地模型盲试是浪费(实证:本地 27b 对 TS18046 修不动/TS2741 靠 :any 作弊被锚拦)。escalate 时云端
//   (route 选的 M3)优先、本地降为兜底。flag repairEscalate(NOE_SELFEVO_REPAIR_ESCALATE)默认 OFF 逐字零回归。
describe('repair 升级模型链（repairEscalate flag）', () => {
  const PATCH = '{"kind":"noe_patch_plan","operations":[{"op":"write_file","path":"x.js","content":"//"}]}';

  it('flag ON + escalate（repair 拍）：云端先试出 patch，本地不被调', async () => {
    const cloud = adapterReplying(PATCH);
    const local = adapterReplying(PATCH);
    const getAdapter = (id) => (id === 'minimax' ? cloud : (id === 'lmstudio-code' || id === 'lmstudio' ? local : null));
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter, route: () => ({ adapterId: 'minimax' }), root, localFirst: true, localCodeAdapterId: 'lmstudio-code', repairEscalate: true });
    const out = await impl({ objective: 'x', escalate: true });
    expect(out.adapterId).toBe('minimax'); // 云端优先
    expect(local.calls.length).toBe(0); // 本地不被调
  });

  it('flag ON + escalate + 云端出不了 → 降级本地兜底（双向韧性不丢）', async () => {
    const cloud = adapterReplying('我不会');
    const local = adapterReplying(PATCH);
    const getAdapter = (id) => (id === 'minimax' ? cloud : (id === 'lmstudio-code' || id === 'lmstudio' ? local : null));
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter, route: () => ({ adapterId: 'minimax' }), root, localFirst: true, localCodeAdapterId: 'lmstudio-code', repairEscalate: true });
    const out = await impl({ objective: 'x', escalate: true });
    expect(out.adapterId).toBe('lmstudio-code'); // 云端失败 → 本地兜底
  });

  it('flag OFF（默认）+ escalate → 顺序不变本地先（零回归）', async () => {
    const seen = [];
    const getAdapter = (id) => { seen.push(id); return adapterReplying(PATCH); };
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter, route: () => ({ adapterId: 'minimax' }), root, localFirst: true, localCodeAdapterId: 'lmstudio-code' });
    await impl({ objective: 'x', escalate: true });
    expect(seen[0]).toBe('lmstudio-code'); // flag OFF：escalate 无效，本地仍先
  });

  it('flag ON + 不带 escalate（implementation 拍）→ 本地仍先（只对 repair 拍生效）', async () => {
    const seen = [];
    const getAdapter = (id) => { seen.push(id); return adapterReplying(PATCH); };
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter, route: () => ({ adapterId: 'minimax' }), root, localFirst: true, localCodeAdapterId: 'lmstudio-code', repairEscalate: true });
    await impl({ objective: 'x' });
    expect(seen[0]).toBe('lmstudio-code'); // implementation 拍不升级
  });

  it('flag ON + escalate + route 无 adapterId，默认云候选可用 → 仍保持 cloud-first', async () => {
    const seen = [];
    const cloud = adapterReplying(PATCH);
    const local = adapterReplying(PATCH);
    const getAdapter = (id) => {
      seen.push(id);
      if (id === 'minimax') return cloud;
      if (id === 'lmstudio-code' || id === 'lmstudio') return local;
      return null;
    };
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter, route: () => ({}), root, localFirst: true, localCodeAdapterId: 'lmstudio-code', repairEscalate: true });
    const out = await impl({ objective: 'x', escalate: true });
    expect(out.adapterId).toBe('minimax');
    expect(seen[0]).toBe('minimax');
    expect(local.calls.length).toBe(0);
  });

  it('flag ON + escalate + 所有云候选都不可用 → 本地兜底不崩（fail-open）', async () => {
    const seen = [];
    const local = adapterReplying(PATCH);
    const getAdapter = (id) => {
      seen.push(id);
      return id === 'lmstudio-code' || id === 'lmstudio' ? local : null;
    };
    const impl = makeNoeSelfEvolutionImplementer({ getAdapter, route: () => ({}), root, localFirst: true, localCodeAdapterId: 'lmstudio-code', repairEscalate: true });
    const out = await impl({ objective: 'x', escalate: true });
    expect(out.adapterId).toBe('lmstudio-code');
    expect(seen[0]).toBe('minimax');
    expect(seen).toContain('lmstudio-code');
  });
});
