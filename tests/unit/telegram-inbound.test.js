import { describe, expect, it } from 'vitest';
import { createTelegramInbound } from '../../src/channels/TelegramInbound.js';

// T34 接线测试：Telegram 入站组装件（fetch/chatBrain 全注入，不碰真网络）。

function makeFetch(sent) {
  return async (url, init) => {
    if (String(url).includes('/sendMessage')) {
      sent.push(JSON.parse(init.body));
      return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
    }
    return { json: async () => ({ ok: true, result: [] }) };
  };
}

const msg = (text, { chatId = '100', userId = 'u1' } = {}) => ({
  channel: 'telegram', chatId, chatType: 'private', userId, userName: 'owner', text,
  mentionsBot: false, isReplyToBot: false, sessionKey: `telegram:${chatId}:${userId}`, peer: chatId,
});

describe('createTelegramInbound', () => {
  it('入站消息 → chatBrain 回复 → sendMessage 回 Telegram', async () => {
    const sent = [];
    const tg = createTelegramInbound({
      token: 'T', fetchImpl: makeFetch(sent),
      chatBrain: async (text) => ({ ok: true, reply: `回:${text}` }),
    });
    const r = await tg.handle(msg('在吗'));
    expect(r.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].chat_id).toBe('100');
    expect(sent[0].text).toBe('回:在吗');
  });

  it('chatBrain 失败 → 回 ⚠️ 错误提示（用户有感知）', async () => {
    const sent = [];
    const tg = createTelegramInbound({ token: 'T', fetchImpl: makeFetch(sent), chatBrain: async () => ({ ok: false, error: '大脑不可用' }) });
    await tg.handle(msg('在吗'));
    expect(sent[0].text).toContain('⚠️');
    expect(sent[0].text).toContain('大脑不可用');
  });

  it('chatBrain 收到 fence:false（避免双重栅栏）+ telegram channel 标记', async () => {
    let gotOpts = null;
    const tg = createTelegramInbound({ token: 'T', fetchImpl: makeFetch([]), chatBrain: async (text, opts) => { gotOpts = opts; return { ok: true, reply: 'r' }; } });
    await tg.handle(msg('在吗'));
    expect(gotOpts.fence).toBe(false);
    expect(gotOpts.channel).toBe('telegram');
    expect(gotOpts.noTts).toBe(true);
  });

  it('同会话连发：旧回复被栅栏压制，只回最新', async () => {
    const sent = [];
    let releaseFirst;
    const gate = new Promise((r) => { releaseFirst = r; });
    const tg = createTelegramInbound({
      token: 'T', fetchImpl: makeFetch(sent),
      chatBrain: async (text) => { if (text === '一') await gate; return { ok: true, reply: `回:${text}` }; },
    });
    const p1 = tg.handle(msg('一'));
    const p2 = tg.handle(msg('二'));
    await p2;
    releaseFirst();
    const r1 = await p1;
    expect(r1.suppressed).toBe(true);
    expect(sent.map((s) => s.text)).toEqual(['回:二']);
  });

  it('回复超长截 4000 字符（Telegram 上限内）', async () => {
    const sent = [];
    const tg = createTelegramInbound({ token: 'T', fetchImpl: makeFetch(sent), chatBrain: async () => ({ ok: true, reply: 'x'.repeat(9000) }) });
    await tg.handle(msg('长文'));
    expect(sent[0].text.length).toBe(4000);
  });

  it('sendMessage 被 Telegram 拒绝 → handle 返回 ok:false', async () => {
    const tg = createTelegramInbound({
      token: 'T',
      fetchImpl: async () => ({ json: async () => ({ ok: false, description: 'chat not found' }) }),
      chatBrain: async () => ({ ok: true, reply: 'r' }),
    });
    const r = await tg.handle(msg('在吗'));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('chat not found');
  });

  it('缺 token / chatBrain 抛错', () => {
    expect(() => createTelegramInbound({ chatBrain: () => {} })).toThrow(/TOKEN/);
    expect(() => createTelegramInbound({ token: 'T' })).toThrow(TypeError);
  });
});
