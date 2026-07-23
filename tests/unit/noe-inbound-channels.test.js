import { describe, expect, it } from 'vitest';
import {
  createTelegramPoller,
  decorrelatedJitter,
  normalizeFeishuWebhookEvent,
  normalizeWeChatClawbotMessage,
  normalizeWeChatOfficialMessage,
  normalizeWeComWebhookMessage,
  normalizeTelegramUpdate,
  shouldWakeAgent,
} from '../../src/channels/InboundChannels.js';

describe('decorrelatedJitter', () => {
  it('返回值不低于 base', () => {
    expect(decorrelatedJitter(0, { base: 800, rand: () => 0 })).toBe(800);
  });
  it('随 prevDelay 增长，不超过 cap', () => {
    expect(decorrelatedJitter(1000, { base: 800, cap: 30000, rand: () => 1 })).toBe(3800);
    expect(decorrelatedJitter(100000, { base: 800, cap: 30000, rand: () => 1 })).toBe(30000);
  });
});

describe('normalizeTelegramUpdate', () => {
  const base = { update_id: 5, message: { chat: { id: 1, type: 'private' }, from: { id: 9, username: 'bob' }, text: 'hi' } };
  it('私聊消息归一为标准格式', () => {
    expect(normalizeTelegramUpdate(base)).toMatchObject({
      channel: 'telegram', chatId: '1', chatType: 'private', userId: '9', userName: 'bob', text: 'hi', mentionsBot: false, isReplyToBot: false, updateId: 5,
    });
  });
  it('识别 @bot mention', () => {
    const u = { update_id: 6, message: { chat: { id: 1, type: 'group' }, from: { id: 9 }, text: '@noebot 在吗' } };
    expect(normalizeTelegramUpdate(u, { botUsername: 'noebot' }).mentionsBot).toBe(true);
    expect(normalizeTelegramUpdate(u, { botUsername: '@noebot' }).mentionsBot).toBe(true);
  });
  it('识别 reply to bot', () => {
    const u = { update_id: 7, message: { chat: { id: 1, type: 'group' }, from: { id: 9 }, text: 'ok', reply_to_message: { from: { is_bot: true } } } };
    expect(normalizeTelegramUpdate(u).isReplyToBot).toBe(true);
  });
  it('非消息 update 返回 null，支持 edited_message', () => {
    expect(normalizeTelegramUpdate({ update_id: 8 })).toBeNull();
    expect(normalizeTelegramUpdate({ update_id: 9, edited_message: base.message })).not.toBeNull();
  });
});

describe('BaiLongma-style social inbound normalizers', () => {
  it('normalizes WeChat ClawBot text and keeps context token as a boolean only', () => {
    const msg = normalizeWeChatClawbotMessage({
      from_user_id: 'wx-user-1',
      context_token: 'secret-context-token-value',
      item_list: [{ type: 1, text_item: { text: '主人，在吗' } }],
    });
    expect(msg).toMatchObject({
      channel: 'wechat_clawbot',
      chatId: 'wx-user-1',
      userId: 'wx-user-1',
      text: '主人，在吗',
      platform: 'wechat-clawbot',
      contextTokenPresent: true,
    });
    expect(JSON.stringify(msg)).not.toContain('secret-context-token-value');
  });

  it('normalizes WeChat official account messages without requiring XML parsing here', () => {
    expect(normalizeWeChatOfficialMessage({
      FromUserName: 'openid-1',
      MsgType: 'text',
      Content: '公众号消息',
    })).toMatchObject({
      channel: 'wechat_official',
      chatId: 'openid-1',
      userId: 'openid-1',
      text: '公众号消息',
      platform: 'wechat-official',
      msgType: 'text',
    });
  });

  it('normalizes WeCom webhook messages into the standard inbound shape', () => {
    expect(normalizeWeComWebhookMessage({
      from_id: 'wecom:webhook:default',
      text: { content: '企业微信消息' },
    })).toMatchObject({
      channel: 'wecom',
      chatId: 'wecom:webhook:default',
      userId: 'wecom:webhook:default',
      text: '企业微信消息',
      platform: 'wecom-webhook',
    });
  });

  it('normalizes Feishu events and strips verification token fields from the output', () => {
    const msg = normalizeFeishuWebhookEvent({
      token: 'secret-feishu-verify-token',
      event: {
        sender: { sender_id: { open_id: 'ou-1' } },
        message: { chat_id: 'oc-1', message_id: 'om-1', content: JSON.stringify({ text: '飞书消息' }) },
      },
    });
    expect(msg).toMatchObject({
      channel: 'feishu',
      chatId: 'oc-1',
      userId: 'ou-1',
      text: '飞书消息',
      platform: 'feishu',
      messageId: 'om-1',
    });
    expect(JSON.stringify(msg)).not.toContain('secret-feishu-verify-token');
  });
});

describe('shouldWakeAgent (mention-gating)', () => {
  it('空消息不唤醒', () => {
    expect(shouldWakeAgent({ text: '  ' }).wake).toBe(false);
  });
  it('allowFrom 白名单外不唤醒', () => {
    expect(shouldWakeAgent({ text: 'hi', userId: '9', chatType: 'private' }, { allowFrom: ['1'] })).toMatchObject({ wake: false, reason: 'not-in-allowlist' });
  });
  it('私聊直接唤醒', () => {
    expect(shouldWakeAgent({ text: 'hi', userId: '9', chatType: 'private' }).wake).toBe(true);
  });
  it('群聊需 @bot 或 reply，否则不唤醒', () => {
    expect(shouldWakeAgent({ text: 'hi', chatType: 'group', mentionsBot: false, isReplyToBot: false })).toMatchObject({ wake: false, reason: 'group-no-mention' });
    expect(shouldWakeAgent({ text: 'hi', chatType: 'group', mentionsBot: true }).wake).toBe(true);
    expect(shouldWakeAgent({ text: 'hi', chatType: 'group', isReplyToBot: true }).wake).toBe(true);
  });
});

describe('createTelegramPoller.handleUpdates', () => {
  it('normalize → gating → onMessage，并推进 offset', () => {
    const woke = [];
    const poller = createTelegramPoller({ token: 't', onMessage: (m) => woke.push(m), gating: {} });
    const n = poller.handleUpdates({ result: [
      { update_id: 5, message: { chat: { id: 1, type: 'private' }, from: { id: 9 }, text: 'hi' } },
      { update_id: 6, message: { chat: { id: 2, type: 'group' }, from: { id: 8 }, text: '群聊无at' } }, // 被 gating 拦
    ] });
    expect(n).toBe(1);
    expect(woke).toHaveLength(1);
    expect(woke[0].chatId).toBe('1');
    expect(poller.offset).toBe(7); // max update_id + 1
  });
});
