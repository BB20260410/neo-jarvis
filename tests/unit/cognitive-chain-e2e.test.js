// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { SoloChatDispatcher } from '../../src/room/SoloChatDispatcher.js';
import { NoeTurnContextEngine } from '../../src/context/NoeTurnContextEngine.js';
import { createInnerStateProvider } from '../../src/context/NoeInnerStateProvider.js';

// P1.4 认知链路 E2E：用【真】createInnerStateProvider + 拟真探针，经【真】SoloChatDispatcher 出口，
// 断言 inner-state(VAD心情/GWT焦点)真实文案出现在发给 LLM 的 messages[0].content。
// 补上既有测试的缺口——契约/注入/翻译三层各自用 stub provider 证明过，但缺"真 provider→真数据→dispatcher.messages 字符串"这一根端到端断言。
// 并锁死 persona 的 owner 闸门（默认 OFF / NOE_MEMORY_PERSONA_PIN=1 kickstart 后真下沉 prompt）。

function makeRoom() {
  return {
    id: 'room-1', mode: 'chat', name: '测试房', cwd: '/tmp',
    members: [{ adapterId: 'fake', displayName: 'Neo', enabled: true }], conversation: [],
  };
}
function makeDispatcher(room, contextEngine) {
  let capturedSystem = '';
  const store = { get: () => room, update: (id, patch) => Object.assign(room, patch) };
  const adapters = new Map([['fake', { chat: async (messages) => { capturedSystem = messages[0].content; return { reply: '好', tokensIn: 1, tokensOut: 1 }; } }]]);
  const dispatcher = new SoloChatDispatcher({ store, adapters, broadcast: () => {}, metrics: { record: () => {} }, contextEngine });
  return { dispatcher, system: () => capturedSystem };
}

// 拟真探针：shape 与 NoeAffectEngine.snapshot()/NoeWorkspace.currentFocus() 对齐，走真 createInnerStateProvider 翻译。
const affectProbe = () => ({ ts: 1, v: 0.4, a: 0.7, d: 0.2 });                       // v≥0.25+a≥0.55+highControl → "状态很在线、挺来劲"
const focusProvider = () => ({ text: '推进 P1.4 认知态注入', source: 'goal_step' }); // goal_step → "在推进：…"
const innerStateProvider = createInnerStateProvider({ affectProbe, focusProvider });
const personaPinProvider = () => '〔我是谁〕沉稳可靠的 Jarvis';

describe('P1.4 认知链路 E2E：inner-state/persona 真进主聊天 prompt', () => {
  it('inner-state(VAD心情+GWT焦点)真出现在发给 LLM 的 system(真 provider→真翻译→dispatcher.messages)', async () => {
    const engine = new NoeTurnContextEngine({ innerStateProvider, logger: { warn: () => {} } });
    const { dispatcher, system } = makeDispatcher(makeRoom(), engine);
    await dispatcher.sendMessage('room-1', '你现在怎么样');
    expect(system()).toContain('〔此刻的我〕');         // 真 provider 前缀（非 stub）
    expect(system()).toContain('状态很在线');           // 真 VAD 翻译(v0.4/a0.7/d0.2)
    expect(system()).toContain('推进 P1.4 认知态注入'); // 真 GWT 焦点文案
  });

  it('反向 probe：NOE_TURN_INNER_STATE=0 → inner-state 段不进 prompt', async () => {
    const prev = process.env.NOE_TURN_INNER_STATE;
    process.env.NOE_TURN_INNER_STATE = '0';
    try {
      const engine = new NoeTurnContextEngine({ innerStateProvider, logger: { warn: () => {} } });
      const { dispatcher, system } = makeDispatcher(makeRoom(), engine);
      await dispatcher.sendMessage('room-1', '你好');
      expect(system()).not.toContain('〔此刻的我〕');
    } finally {
      if (prev === undefined) delete process.env.NOE_TURN_INNER_STATE; else process.env.NOE_TURN_INNER_STATE = prev;
    }
  });

  it('persona owner 闸门：默认 OFF（不设 NOE_MEMORY_PERSONA_PIN）→ 人设不进 prompt', async () => {
    const prev = process.env.NOE_MEMORY_PERSONA_PIN;
    delete process.env.NOE_MEMORY_PERSONA_PIN;
    try {
      const engine = new NoeTurnContextEngine({ personaPinProvider, logger: { warn: () => {} } });
      const { dispatcher, system } = makeDispatcher(makeRoom(), engine);
      await dispatcher.sendMessage('room-1', '你是谁');
      expect(system()).not.toContain('沉稳可靠的 Jarvis');
    } finally {
      if (prev !== undefined) process.env.NOE_MEMORY_PERSONA_PIN = prev;
    }
  });

  it('persona owner 闸门：NOE_MEMORY_PERSONA_PIN=1 kickstart 后人设真下沉 prompt', async () => {
    const prev = process.env.NOE_MEMORY_PERSONA_PIN;
    process.env.NOE_MEMORY_PERSONA_PIN = '1';
    try {
      const engine = new NoeTurnContextEngine({ personaPinProvider, logger: { warn: () => {} } });
      const { dispatcher, system } = makeDispatcher(makeRoom(), engine);
      await dispatcher.sendMessage('room-1', '你是谁');
      expect(system()).toContain('沉稳可靠的 Jarvis');
    } finally {
      if (prev === undefined) delete process.env.NOE_MEMORY_PERSONA_PIN; else process.env.NOE_MEMORY_PERSONA_PIN = prev;
    }
  });
});
