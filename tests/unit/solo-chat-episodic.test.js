import { describe, expect, it } from 'vitest';
import { SoloChatDispatcher } from '../../src/room/SoloChatDispatcher.js';

// 内在世界（记录覆盖扩展）：聊天室 1v1 成功回复 → 自传体时间线 type:'observation' salience 2。
// type 绝不用 'interaction'：聊天室成员是任意 AI 非 Noe 人格，记 interaction 会污染
// inferMood 的"和主人聊得正起劲"统计与"我和主人"主线叙事。
// 三断言纪律：注入时形状正确 / 未注入零调用零影响 / record 抛错 fail-open 不破坏原返回。
// 全部注入 fake（store/adapters/timeline），绝不连真库。

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

function makeFakeTimeline({ throwOnRecord = false } = {}) {
  const calls = [];
  return {
    calls,
    record(episode) {
      if (throwOnRecord) throw new Error('timeline down');
      calls.push(episode);
      return calls.length;
    },
  };
}

function makeDispatcher(room, { episodicTimeline, adapterFails = false } = {}) {
  const store = { get: () => room, update: (id, patch) => Object.assign(room, patch) };
  const adapters = new Map([['fake', {
    chat: async () => {
      if (adapterFails) throw new Error('adapter down');
      return { reply: '好', tokensIn: 1, tokensOut: 1 };
    },
  }]]);
  return new SoloChatDispatcher({
    store, adapters, broadcast: () => {}, metrics: { record: () => {} },
    ...(episodicTimeline !== undefined ? { episodicTimeline } : {}),
  });
}

describe('SoloChatDispatcher × EpisodicTimeline（内在世界·记录覆盖扩展）', () => {
  it('注入 timeline：成功回复记一条 observation salience 2，summary 含成员名与输入截 30', async () => {
    const timeline = makeFakeTimeline();
    const dispatcher = makeDispatcher(makeRoom(), { episodicTimeline: timeline });
    const longText = '聊'.repeat(80);   // 验证截 30
    await dispatcher.sendMessage('room-1', longText);

    expect(timeline.calls).toHaveLength(1);
    expect(timeline.calls[0]).toEqual({
      type: 'observation',   // 绝不 'interaction'，防污染 inferMood
      summary: `主人在聊天室和 假搭子 聊"${longText.slice(0, 30)}"`,
      salience: 2,
    });
  });

  it('未注入 timeline：零调用，aiMsg 返回与既有行为一致', async () => {
    const bystander = makeFakeTimeline();   // 造了但不注入，断言零调用
    const dispatcher = makeDispatcher(makeRoom());
    const aiMsg = await dispatcher.sendMessage('room-1', '你好');

    expect(bystander.calls).toHaveLength(0);
    expect(aiMsg.content).toBe('好');
    expect(aiMsg.from).toBe('fake');
  });

  it('record 抛错：fail-open，aiMsg 照常返回、conversation 完整', async () => {
    const room = makeRoom();
    const dispatcher = makeDispatcher(room, { episodicTimeline: makeFakeTimeline({ throwOnRecord: true }) });
    const aiMsg = await dispatcher.sendMessage('room-1', '你好');

    expect(aiMsg.content).toBe('好');
    expect(room.conversation).toHaveLength(2);   // 用户消息 + AI 回复都在
  });

  it('adapter 失败路径不记录（只记真实发生的回复）', async () => {
    const timeline = makeFakeTimeline();
    const dispatcher = makeDispatcher(makeRoom(), { episodicTimeline: timeline, adapterFails: true });
    await expect(dispatcher.sendMessage('room-1', '你好')).rejects.toThrow('adapter down');

    expect(timeline.calls).toHaveLength(0);
  });
});
