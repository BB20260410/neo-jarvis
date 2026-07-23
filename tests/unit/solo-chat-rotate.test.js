import { describe, expect, it } from 'vitest';
import { SoloChatDispatcher } from '../../src/room/SoloChatDispatcher.js';

// 卡⑤ session rotate：对话超 token 阈值 → 标 rotateSuggested + 广播一次（只标一次，不自动轮换）

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

function makeDeps(room, { reply = '好的', rotateSuggestTokens } = {}) {
  const updates = [];
  const broadcasts = [];
  const store = {
    get: () => room,
    update: (id, patch) => { updates.push(patch); Object.assign(room, patch); },
  };
  const adapters = new Map([['fake', { chat: async () => ({ reply, tokensIn: 1, tokensOut: 1 }) }]]);
  const dispatcher = new SoloChatDispatcher({
    store,
    adapters,
    broadcast: (roomId, msg) => broadcasts.push(msg),
    metrics: { record: () => {} },
    ...(rotateSuggestTokens ? { rotateSuggestTokens } : {}),
  });
  return { dispatcher, updates, broadcasts };
}

describe('SoloChatDispatcher 轮换建议（卡⑤）', () => {
  it('对话规模超阈值 → 标 rotateSuggested + 广播 chat_rotate_suggested', async () => {
    const room = makeRoom();
    // 阈值 50 token ≈ 200 字符；一来一回就超
    const { dispatcher, broadcasts } = makeDeps(room, { reply: '回'.repeat(150), rotateSuggestTokens: 50 });
    await dispatcher.sendMessage('room-1', '问'.repeat(100));
    expect(room.rotateSuggested).toBe(true);
    const evt = broadcasts.find((b) => b.type === 'chat_rotate_suggested');
    expect(evt).toBeTruthy();
    expect(evt.tokens).toBeGreaterThanOrEqual(50);
    expect(evt.threshold).toBe(50);
  });

  it('已标过 rotateSuggested → 不重复广播', async () => {
    const room = makeRoom({ rotateSuggested: true });
    const { dispatcher, broadcasts } = makeDeps(room, { reply: '回'.repeat(150), rotateSuggestTokens: 50 });
    await dispatcher.sendMessage('room-1', '问'.repeat(100));
    expect(broadcasts.filter((b) => b.type === 'chat_rotate_suggested').length).toBe(0);
  });

  it('规模没超阈值 → 不标', async () => {
    const room = makeRoom();
    const { dispatcher } = makeDeps(room, { reply: '短', rotateSuggestTokens: 24000 });
    await dispatcher.sendMessage('room-1', '你好');
    expect(room.rotateSuggested).toBeUndefined();
  });

  it('生产默认阈值来自构造（可注入），不挂在每次调用上', () => {
    const { dispatcher } = makeDeps(makeRoom(), { rotateSuggestTokens: 12345 });
    expect(dispatcher.rotateSuggestTokens).toBe(12345);
  });
});
