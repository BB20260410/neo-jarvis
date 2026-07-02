// TelegramInbound — T34 入站试点组装件（波次2/6 接线）。
//
// 链路：getUpdates 长轮询(InboundChannels.createTelegramPoller, 退避重连)
//   → normalize + mention-gating（私聊直达，群聊需 @bot，allowFrom 白名单）
//   → createFencedResponder（同会话连发压制旧回复，防连击）
//   → chatBrain（注入；生产 = voiceSession.chatText，复用 BrainRouter/记忆/承诺全链路）
//   → sendMessage 回 Telegram。
// 全注入式（fetchImpl/chatBrain），可单测；server 侧配 TELEGRAM_BOT_TOKEN 才通电，默认零影响。

import { createTelegramPoller } from './InboundChannels.js';
import { createFencedResponder } from '../runtime/NoeInboundGateway.js';

export function createTelegramInbound({
  token,
  chatBrain,                      // (text, opts) => Promise<{ok, reply, error}>（VoiceSession.chatText 契约）
  botUsername = '',
  allowFrom = [],
  fetchImpl = fetch,
  log = () => {},
} = {}) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN required');
  if (typeof chatBrain !== 'function') throw new TypeError('chatBrain(text, opts) required');
  const api = `https://api.telegram.org/bot${token}`;

  async function sendMessage(chatId, text) {
    const resp = await fetchImpl(`${api}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: String(text || '').slice(0, 4000) }),
    });
    const data = typeof resp?.json === 'function' ? await resp.json().catch(() => ({})) : resp;
    if (data?.ok === false) throw new Error(`telegram sendMessage failed: ${data?.description || 'unknown'}`);
    return data;
  }

  // 单道栅栏：在入站层防连击（chatBrain 调用时 fence:false 关掉 VoiceSession 内层栅栏，避免双重压制语义混乱）
  const handle = createFencedResponder({
    respond: async (m) => {
      const r = await chatBrain(m.text, { noTts: true, fence: false, channel: 'telegram', sessionKey: m.sessionKey });
      return r?.ok ? (r.reply || '（空回复）') : `⚠️ ${r?.error || '回复失败'}`;
    },
    deliver: async (reply, m) => { await sendMessage(m.chatId, reply); },
  });

  const poller = createTelegramPoller({
    token,
    botUsername,
    gating: { allowFrom },
    fetcher: (url) => Promise.resolve(fetchImpl(url)).then((r) => (typeof r?.json === 'function' ? r.json() : r)),
    onMessage: (msg) => handle({ ...msg, sessionKey: `telegram:${msg.chatId}:${msg.userId}`, peer: msg.chatId }),
    log,
  });

  return {
    poller,
    handle,        // 暴露供测试/手动注入消息
    sendMessage,
    start() { poller.start(); return this; },
    stop() { poller.stop(); },
  };
}
