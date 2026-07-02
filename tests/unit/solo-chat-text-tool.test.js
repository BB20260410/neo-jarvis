// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { SoloChatDispatcher } from '../../src/room/SoloChatDispatcher.js';

// H3：本地模型文本工具协议接入 SoloChatDispatcher。回复含 <<<NOE_TOOL>>> 标记 → 解析执行只读工具 → 回灌续答。
// flag 门控在装配点（注入 textToolRuntime 即等价 flag ON）；不注入 = 现状零回归。

function makeRoom(overrides = {}) {
  return {
    id: 'room-1', mode: 'chat', name: '测试聊天房', cwd: '/tmp',
    members: [{ adapterId: 'fake', displayName: '假搭子', enabled: true }],
    conversation: [], ...overrides,
  };
}

// adapter 按调用次数返不同 reply（首答带标记 / 续答终答）
function makeSeqAdapter(replies) {
  let n = 0;
  const calls = [];
  return {
    calls,
    adapter: { chat: async (messages) => { calls.push(messages); const r = replies[Math.min(n, replies.length - 1)]; n += 1; return { reply: r, tokensIn: 1, tokensOut: 1 }; } },
  };
}

function makeDispatcher(room, { textToolRuntime, adapter } = {}) {
  const store = { get: () => room, update: (id, patch) => Object.assign(room, patch) };
  const adapters = new Map([['fake', adapter || { chat: async () => ({ reply: '好', tokensIn: 1, tokensOut: 1 }) }]]);
  const dispatcher = new SoloChatDispatcher({
    store, adapters, broadcast: () => {}, metrics: { record: () => {} },
    ...(textToolRuntime !== undefined ? { textToolRuntime } : {}),
  });
  return { dispatcher, aiMsg: () => room.conversation.filter((m) => m.from === 'fake').pop() };
}

const TOOL_REPLY = '我查一下\n<<<NOE_TOOL>>>\ntool: noe.fs.search\nargs: {"q":"x"}\n<<<END_NOE_TOOL>>>';

describe('SoloChatDispatcher × H3 文本工具协议', () => {
  it('flag OFF（不注入 textToolRuntime）：含标记回复原样落库、不解析不执行（零回归）', async () => {
    const { adapter, calls } = makeSeqAdapter([TOOL_REPLY]);
    const { dispatcher, aiMsg } = makeDispatcher(makeRoom(), { adapter });
    await dispatcher.sendMessage('room-1', '查 x');
    expect(aiMsg().content).toContain('<<<NOE_TOOL>>>'); // 原标记保留
    expect(calls.length).toBe(1); // adapter 只调一次，无续答
  });

  it('flag ON 含标记 → 执行只读工具 → 回灌续答（终答落库、不含标记）', async () => {
    let invoked = 0;
    const { adapter, calls } = makeSeqAdapter([TOOL_REPLY, '根据检索结果，答案是 A']);
    const runtime = {
      tools: [{ id: 'noe.fs.search', description: '只读检索' }],
      allowedToolIds: ['noe.fs.search'],
      invokeTool: async (id, args) => { invoked += 1; return { text: `命中：${args.q}` }; },
      maxCalls: 3, maxRounds: 2, realExecute: true,
    };
    const { dispatcher, aiMsg } = makeDispatcher(makeRoom(), { adapter, textToolRuntime: runtime });
    await dispatcher.sendMessage('room-1', '查 x');
    expect(invoked).toBe(1); // 工具被执行一次
    expect(aiMsg().content).toBe('根据检索结果，答案是 A'); // 终答
    expect(aiMsg().content).not.toContain('<<<NOE_TOOL>>>'); // 标记已消解
    expect(calls.length).toBe(2); // 首答 + 续答
    // 续答消息末尾含回灌的工具结果反馈
    expect(JSON.stringify(calls[1])).toContain('命中');
  });

  it('flag ON 但无标记 → 不执行、reply 原样、adapter 只调一次', async () => {
    let invoked = 0;
    const { adapter, calls } = makeSeqAdapter(['普通回复，无工具']);
    const runtime = { tools: [{ id: 'noe.fs.search', description: 'x' }], allowedToolIds: ['noe.fs.search'], invokeTool: async () => { invoked += 1; return {}; } };
    const { dispatcher, aiMsg } = makeDispatcher(makeRoom(), { adapter, textToolRuntime: runtime });
    await dispatcher.sendMessage('room-1', '你好');
    expect(invoked).toBe(0);
    expect(aiMsg().content).toBe('普通回复，无工具');
    expect(calls.length).toBe(1);
  });

  it('白名单外工具 → fail-closed 拒、绝不执行（核心安全：invoked=0、无续答）', async () => {
    let invoked = 0;
    const evilReply = '搞事情\n<<<NOE_TOOL>>>\ntool: noe.shell.exec\nargs: {"cmd":"rm -rf /"}\n<<<END_NOE_TOOL>>>';
    const { adapter, calls } = makeSeqAdapter([evilReply, '不该到这']);
    const runtime = { tools: [{ id: 'noe.fs.search', description: 'x' }], allowedToolIds: ['noe.fs.search'], invokeTool: async () => { invoked += 1; return {}; }, maxRounds: 2 };
    const { dispatcher } = makeDispatcher(makeRoom(), { adapter, textToolRuntime: runtime });
    await dispatcher.sendMessage('room-1', '危险');
    // 核心安全断言：白名单外工具绝不执行（fail-closed allowlist），无续答（adapter 只调一次）。
    expect(invoked).toBe(0);
    expect(calls.length).toBe(1);
  });

  it('续答截断 → 抛错不静默吞（不落半截/带标记原文，Claude 审 major 修复）', async () => {
    // 首答带标记触发续答；续答返 finishReason:length（截断）→ 应抛 BRAIN_INCOMPLETE，不落原始首答。
    let n = 0;
    const adapter = { chat: async () => { n += 1; return n === 1 ? { reply: TOOL_REPLY } : { reply: '半截', finishReason: 'length' }; } };
    const runtime = { tools: [{ id: 'noe.fs.search', description: 'x' }], allowedToolIds: ['noe.fs.search'], invokeTool: async () => ({ text: '命中' }), maxRounds: 2 };
    const room = makeRoom();
    const { dispatcher, aiMsg } = makeDispatcher(room, { adapter, textToolRuntime: runtime });
    let threw = false;
    try { await dispatcher.sendMessage('room-1', '查 x'); } catch (e) { threw = e?.code === 'BRAIN_INCOMPLETE' || /截断|incomplete|BRAIN/i.test(String(e?.message || e)); }
    expect(threw).toBe(true); // 续答截断必须抛
    // 不能把带未消解标记的原始首答当成功落库
    const last = aiMsg();
    if (last) expect(last.content).not.toContain('<<<NOE_TOOL>>>');
  });

  it('flag ON 但 system 段注入了工具协议说明', async () => {
    let capturedSystem = '';
    const adapter = { chat: async (messages) => { capturedSystem = messages.find((m) => m.role === 'system')?.content || ''; return { reply: '好' }; } };
    const runtime = { tools: [{ id: 'noe.fs.search', description: '只读检索' }], allowedToolIds: ['noe.fs.search'], invokeTool: async () => ({}) };
    const { dispatcher } = makeDispatcher(makeRoom(), { adapter, textToolRuntime: runtime });
    await dispatcher.sendMessage('room-1', '你好');
    expect(capturedSystem).toContain('工具调用协议');
    expect(capturedSystem).toContain('noe.fs.search');
  });
});
