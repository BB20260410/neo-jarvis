import { describe, expect, it } from 'vitest';
import { SoloChatDispatcher } from '../../src/room/SoloChatDispatcher.js';
import { NoeTurnContextEngine } from '../../src/context/NoeTurnContextEngine.js';
import { NoeUiSignalStore } from '../../src/runtime/NoeUiSignalStore.js';
import { NoeAcuiCardStore } from '../../src/runtime/NoeAcuiCardStore.js';

// 方向一（文字聊天拉齐）：SoloChatDispatcher 注入 NoeTurnContextEngine 后，
// 聊天室 1v1 也能召回记忆/查人物库/跑工具桥；未注入完全旧行为；引擎失败不阻断聊天。

function makeRoom(overrides = {}) {
  return {
    id: 'room-1',
    mode: 'chat',
    name: '测试聊天房',
    cwd: '/tmp',
    members: [{ adapterId: 'fake', displayName: '假搭子', enabled: true }],
    conversation: [],
    ...overrides,
  };
}

function makeDispatcher(room, { contextEngine, adapter } = {}) {
  let capturedSystem = '';
  const store = { get: () => room, update: (id, patch) => Object.assign(room, patch) };
  const defaultAdapter = { chat: async (messages) => { capturedSystem = messages[0].content; return { reply: '好', tokensIn: 1, tokensOut: 1 }; } };
  const wrappedAdapter = adapter
    ? { chat: async (messages, opts) => { capturedSystem = messages[0].content; return adapter.chat(messages, opts); } }
    : defaultAdapter;
  const adapters = new Map([['fake', wrappedAdapter]]);
  const dispatcher = new SoloChatDispatcher({
    store, adapters, broadcast: () => {}, metrics: { record: () => {} },
    ...(contextEngine !== undefined ? { contextEngine } : {}),
  });
  return { dispatcher, system: () => capturedSystem };
}

describe('SoloChatDispatcher × NoeTurnContextEngine（方向一）', () => {
  it('注入引擎后：聊天室能召回记忆+查人物库+收工具桥结果', async () => {
    const engine = new NoeTurnContextEngine({
      memory: { recall: () => [{ body: '主人喜欢美式', scope: 'fact' }] },
      personStore: { list: () => [{ displayName: '老王', relation: '老友' }] },
      toolRegistry: { invoke: async () => ({}) },
      queryToolsRunner: async () => '【真实查询结果】命中A',
      logger: { warn: () => {} },
    });
    const { dispatcher, system } = makeDispatcher(makeRoom(), { contextEngine: engine });
    await dispatcher.sendMessage('room-1', '还记得我喝什么吗');
    expect(system()).toContain('你是 假搭子'); // 原 system 头不变
    expect(system()).toContain('主人喜欢美式');
    expect(system()).toContain('老王（老友）');
    expect(system()).toContain('【真实查询结果】命中A');
  });

  it('聊天室不带语音专属段：self-knowledge/到期承诺/动作桥都不注入、副作用不发生', async () => {
    let actionDetected = 0;
    const engine = new NoeTurnContextEngine({
      memory: { recall: () => [] },
      commitmentStore: { due: () => [{ text: '提醒吃药' }] },
      actionDetect: () => { actionDetected += 1; return { type: 'remember', text: 'x' }; },
      logger: { warn: () => {} },
    });
    const { dispatcher, system } = makeDispatcher(makeRoom(), { contextEngine: engine });
    await dispatcher.sendMessage('room-1', '记住我喝拿铁');
    expect(system()).not.toContain('noe-self-knowledge');
    expect(system()).not.toContain('到期承诺');
    expect(actionDetected).toBe(0);
  });

  it('未注入引擎：system 头与旧行为逐字一致、无引擎注入段（skillInjector 的追加属既有行为）', async () => {
    const { dispatcher, system } = makeDispatcher(makeRoom());
    await dispatcher.sendMessage('room-1', '你好');
    expect(system().startsWith('你是 假搭子，正在和用户进行 1 对 1 对话。请用中文清晰回答。如有具体任务（写代码/查信息/做计算）请尽量真的去做。')).toBe(true);
    expect(system()).not.toContain('主人的人物库');
    expect(system()).not.toContain('你记得这些相关的事');
  });

  it('引擎抛错不阻断聊天（fail-open，回旧 system）', async () => {
    const broken = { supplyTurnContext: async () => { throw new Error('engine down'); } };
    const { dispatcher, system } = makeDispatcher(makeRoom(), { contextEngine: broken });
    const msg = await dispatcher.sendMessage('room-1', '你好');
    expect(msg.content).toBe('好');
    expect(system()).toContain('你是 假搭子');
  });

  it('前台聊天云端模式下，本地房间成员会改走可用云端 adapter', async () => {
    const room = makeRoom({ members: [{ adapterId: 'lmstudio', displayName: '本地脑', enabled: true }] });
    const store = { get: () => room, update: (id, patch) => Object.assign(room, patch) };
    const used = [];
    const adapters = new Map([
      ['lmstudio', { displayName: '本地脑', chat: async () => { used.push('lmstudio'); return { reply: 'local' }; } }],
      ['minimax', { displayName: 'MiniMax 云端', chat: async () => { used.push('minimax'); return { reply: 'cloud', tokensIn: 1, tokensOut: 1 }; } }],
    ]);
    const dispatcher = new SoloChatDispatcher({
      store,
      adapters,
      broadcast: () => {},
      metrics: { record: () => {} },
      foregroundChatRouting: { cloudOnly: true, cloudAdapterChain: ['minimax'], localAdapterIds: ['ollama', 'lmstudio'] },
    });
    const msg = await dispatcher.sendMessage('room-1', '你好');
    expect(msg.from).toBe('minimax');
    expect(msg.content).toBe('cloud');
    expect(used).toEqual(['minimax']);
  });

  // 两开关组合（门控在 server.js 装配点，这里按装配形态复刻）：
  // NOE_CHAT_CONTEXT=0 → contextEngine=null（上方"未注入引擎"测试已覆盖）；
  // NOE_CHAT_CONTEXT=1 + NOE_CHAT_UISIGNALS=0 → 引擎不带 ui store；双开 → 引擎带两个共享 store。
  it('双开（NOE_CHAT_CONTEXT=1+NOE_CHAT_UISIGNALS=1 装配形态）：UI 信号/卡片注入聊天，且议会消费路径不被饿死', async () => {
    const uiSignalStore = new NoeUiSignalStore();
    const acuiCardStore = new NoeAcuiCardStore();
    uiSignalStore.record({ event: 'card.action', component: 'LocalCouncilPanel', action: 'open-ledger' });
    acuiCardStore.show({ type: 'task', title: '整理证据链', status: 'running', message: '进行中' });
    const engine = new NoeTurnContextEngine({ uiSignalStore, acuiCardStore, logger: { warn: () => {} } });
    const { dispatcher, system } = makeDispatcher(makeRoom(), { contextEngine: engine });
    await dispatcher.sendMessage('room-1', '我刚在面板上点了什么');
    expect(system()).toContain('<noe-ui-signals');
    expect(system()).toContain('open-ledger');
    expect(system()).toContain('<noe-acui-cards');
    expect(system()).toContain('整理证据链');
    // 聊天注入是非消费式 peek：信号仍未消费，noeLocalCouncil 的 consume() 不会被饿死
    expect(uiSignalStore.snapshot()).toMatchObject({ unconsumed: 1, consumed: 0 });
    expect(uiSignalStore.consume().count).toBe(1);
  });

  it('单开 NOE_CHAT_CONTEXT=1（NOE_CHAT_UISIGNALS=0 装配形态）：不注入 UI 信号/卡片段', async () => {
    const engine = new NoeTurnContextEngine({ logger: { warn: () => {} } });
    const { dispatcher, system } = makeDispatcher(makeRoom(), { contextEngine: engine });
    await dispatcher.sendMessage('room-1', '我刚在面板上点了什么');
    expect(system()).toContain('你是 假搭子');
    expect(system()).not.toContain('<noe-ui-signals');
    expect(system()).not.toContain('<noe-acui-cards');
  });

  it('超长输入截 2000 再喂引擎（与语音转写同口径）', async () => {
    let seenTranscript = '';
    const probe = { supplyTurnContext: async ({ transcript }) => { seenTranscript = transcript; return { text: '', dropped: [] }; } };
    const { dispatcher } = makeDispatcher(makeRoom(), { contextEngine: probe });
    await dispatcher.sendMessage('room-1', '长'.repeat(5000));
    expect(seenTranscript.length).toBe(2000);
  });

  it('finish_reason=length 时不把半截回复保存成聊天室 AI 消息', async () => {
    const room = makeRoom();
    const { dispatcher } = makeDispatcher(room, {
      adapter: {
        chat: async () => ({
          reply: '半截回答不应该保存',
          tokensIn: 1,
          tokensOut: 8192,
          incomplete: true,
          finishReason: 'length',
          continuationRequired: true,
        }),
      },
    });

    await expect(dispatcher.sendMessage('room-1', '请生成长报告')).rejects.toThrow(/截断|incomplete/);
    expect(room.conversation).toHaveLength(2);
    expect(room.conversation[0]).toMatchObject({ from: 'user', content: '请生成长报告' });
    expect(room.conversation[1]).toMatchObject({ from: 'fake', error: true });
    expect(room.conversation.map((m) => m.content).join('\n')).not.toContain('半截回答不应该保存');
  });
});

// P3 学 owner：owner 偏好常驻注入（三方互评 M3+codex+Claude 后定稿）。
// 覆盖：flag 门控（默认 OFF 零回归）+ 段级白名单守卫（不再裸 if 绕过 CHAT_CONTEXT_SECTIONS）
//   + SQL project_id/expires_at/隐私黑名单过滤 + 召回率不限「用户」前缀 + 聊天室全链路 + 空结果防御。
describe('P3 owner-profile 常驻注入（段级白名单契约 + flag + 隐私/project/expires 过滤）', () => {
  function makeOwnerEngine(rows = [
    { title: '用户偏好中文回复且倾向于长句式表达（3-5句）' },
    { title: 'Noe偏好用中文进行简短的、非列表式的描述性回答' },
  ]) {
    let sql = '';
    let args = null;
    const memory = {
      recall: () => [],
      db: () => ({ prepare: (q) => { sql = q; return { all: (...a) => { args = a; return rows; } }; } }),
    };
    const engine = new NoeTurnContextEngine({ memory, logger: { warn: () => {} } });
    return { engine, getSql: () => sql, getArgs: () => args };
  }
  function withFlag(value, fn) {
    const prev = process.env.NOE_OWNER_PROFILE;
    if (value === undefined) delete process.env.NOE_OWNER_PROFILE; else process.env.NOE_OWNER_PROFILE = value;
    return Promise.resolve(fn()).finally(() => {
      if (prev === undefined) delete process.env.NOE_OWNER_PROFILE; else process.env.NOE_OWNER_PROFILE = prev;
    });
  }

  it('flag ON + 段在白名单：注入 owner 偏好（含 owner 亲述 + Noe偏好，不限「用户」前缀）', async () => {
    await withFlag('1', async () => {
      const { engine } = makeOwnerEngine();
      const r = await engine.supplyTurnContext({ transcript: '你好', sections: ['owner-profile'], systemPrompt: '' });
      expect(r.text).toContain('我已知的主人偏好');
      expect(r.text).toContain('用户偏好中文回复');
      expect(r.text).toContain('Noe偏好用中文'); // 召回率：不以「用户」开头也召回（Claude/codex 互评指出旧白名单漏召回）
    });
  });

  it('SQL 带 project_id + expires_at 过滤 + this.now() 参数 + 隐私黑名单（codex 互评）', async () => {
    await withFlag('1', async () => {
      const { engine, getSql, getArgs } = makeOwnerEngine();
      await engine.supplyTurnContext({ transcript: '你好', sections: ['owner-profile'], systemPrompt: '' });
      expect(getSql()).toContain("project_id='noe'");
      expect(getSql()).toContain('expires_at IS NULL OR expires_at >');
      expect(getSql()).toContain("NOT LIKE '%密码%'");
      expect(getSql()).toContain("NOT LIKE '%手机%'");
      expect(getArgs()).toHaveLength(1); // this.now() 作为 expires_at 比较参数传入
      expect(typeof getArgs()[0]).toBe('number');
    });
  });

  it('flag OFF（默认）：即使 memory.db 有偏好也不注入，SQL 根本不跑（零回归）', async () => {
    await withFlag(undefined, async () => {
      const { engine, getSql } = makeOwnerEngine();
      const r = await engine.supplyTurnContext({ transcript: '你好', sections: ['owner-profile'], systemPrompt: '' });
      expect(r.text).not.toContain('我已知的主人偏好');
      expect(getSql()).toBe('');
    });
  });

  it('段级白名单守卫：flag ON 但 sections 不含 owner-profile → 不注入 + SQL 不跑（修复裸 if 绕过 CHAT_CONTEXT_SECTIONS，Claude/codex 互评）', async () => {
    await withFlag('1', async () => {
      const { engine, getSql } = makeOwnerEngine();
      const r = await engine.supplyTurnContext({ transcript: '你好', sections: ['recall'], systemPrompt: '' });
      expect(r.text).not.toContain('我已知的主人偏好');
      expect(getSql()).toBe(''); // on('owner-profile')=false，整段 short-circuit
    });
  });

  it('聊天室全链路：flag ON 时 SoloChatDispatcher 注入 owner 偏好（验 CHAT_CONTEXT_SECTIONS 已含 owner-profile）', async () => {
    await withFlag('1', async () => {
      const { engine } = makeOwnerEngine();
      const { dispatcher, system } = makeDispatcher(makeRoom(), { contextEngine: engine });
      await dispatcher.sendMessage('room-1', '你好');
      expect(system()).toContain('我已知的主人偏好');
    });
  });

  it('memory.db 返回空 → 不注入空段（prefs.length 防御）', async () => {
    await withFlag('1', async () => {
      const { engine } = makeOwnerEngine([]);
      const r = await engine.supplyTurnContext({ transcript: '你好', sections: ['owner-profile'], systemPrompt: '' });
      expect(r.text).not.toContain('我已知的主人偏好');
    });
  });
});
