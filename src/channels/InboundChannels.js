// InboundChannels — 多渠道入站核心：消息标准化 + mention-gating + 退避重连（纯逻辑）。
//
// Noe 此前只有出站（webhook 发通知），零入站。这是「全天候自主可达」的最大缺口（任务2/OpenClaw 共识）：
//   配合 launchd 守护，用户可用 Telegram 随时随地启动任务 / 查状态，真正离人自主运行 + 随时召回。
//
// m3 架构定调（OpenClaw 普查 + Node 工程经验）：
//   - 试点选 Telegram（有官方 bot API；反 iMessage 无 API+macOS 收权；反本地 webhook 验不到群聊）；
//   - mention-gating 放「Bus 订阅层」而非 adapter 层（gate 是业务策略，非渠道内禀行为）；
//   - 退避用 decorrelated jitter（AWS 推荐，比纯指数好）。
//
// 本模块只做可测的纯逻辑；真实网络 I/O（getUpdates 长轮询）由 createTelegramPoller 注入 fetcher，
//   实际连接需配 bot token（接线见 server.js）。

/** 标准入站消息格式（任意渠道归一到这套，业务逻辑绝不读 raw 渠道对象）。 */
export const INBOUND_MESSAGE_SHAPE = Object.freeze({
  channel: '', chatId: '', chatType: '', userId: '', userName: '', text: '', mentionsBot: false, isReplyToBot: false,
});

function cleanText(value, max = 16000) {
  return String(value ?? '').trim().slice(0, max);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = cleanText(value, 2000);
    if (text) return text;
  }
  return '';
}

function inbound({ channel, chatId = '', chatType = 'private', userId = '', userName = '', text = '', meta = {} } = {}) {
  const cleanChannel = cleanText(channel, 80).toLowerCase();
  const cleanUser = cleanText(userId || chatId || 'unknown', 240) || 'unknown';
  const cleanChat = cleanText(chatId || cleanUser, 240);
  const cleanBody = cleanText(text);
  if (!cleanChannel || !cleanBody) return null;
  return {
    channel: cleanChannel,
    chatId: cleanChat,
    chatType: cleanText(chatType, 80) || 'private',
    userId: cleanUser,
    userName: cleanText(userName, 240),
    text: cleanBody,
    mentionsBot: false,
    isReplyToBot: false,
    ...meta,
  };
}

function extractWeChatClawbotText(msg = {}) {
  const direct = firstNonEmpty(msg.text, msg.content, msg.message, msg.body);
  if (direct) return direct;
  const items = Array.isArray(msg.item_list) ? msg.item_list : Array.isArray(msg.itemList) ? msg.itemList : [];
  for (const item of items) {
    const kind = item?.type;
    if (kind === 1 || kind === 'text') {
      const text = firstNonEmpty(item?.text_item?.text, item?.textItem?.text, item?.text);
      if (text) return text;
    }
  }
  return '';
}

// Adapted from BaiLongma's social connector shape (MIT): keep only normalized
// message metadata. Tokens, signatures, and raw credential fields are not copied.
export function normalizeWeChatClawbotMessage(msg = {}) {
  const userId = firstNonEmpty(msg.from_user_id, msg.fromUserId, msg.user_id, msg.userId, msg.sender);
  const messageType = firstNonEmpty(msg.message_type, msg.messageType, msg.msg_type, msg.msgType);
  return inbound({
    channel: 'wechat_clawbot',
    chatId: userId,
    userId,
    userName: firstNonEmpty(msg.nickname, msg.userName, msg.user_name),
    text: extractWeChatClawbotText(msg),
    meta: {
      platform: 'wechat-clawbot',
      contextTokenPresent: Boolean(msg.context_token || msg.contextToken),
      messageId: firstNonEmpty(msg.message_id, msg.messageId, msg.msg_id, msg.msgId, msg.id),
      msgType: messageType,
      senderKind: messageType === '2' || /^bot$/i.test(messageType) ? 'bot' : 'human',
    },
  });
}

export function normalizeWeChatOfficialMessage(msg = {}) {
  const fromUser = firstNonEmpty(msg.FromUserName, msg.fromUserName, msg.from_user, msg.openId, msg.open_id);
  const text = firstNonEmpty(msg.Content, msg.content, msg.text) || `[${firstNonEmpty(msg.MsgType, msg.msgType, 'unknown')} message]`;
  return inbound({
    channel: 'wechat_official',
    chatId: fromUser,
    userId: fromUser,
    text,
    meta: {
      platform: 'wechat-official',
      msgType: firstNonEmpty(msg.MsgType, msg.msgType),
      messageId: firstNonEmpty(msg.MsgId, msg.msgId, msg.msg_id),
    },
  });
}

export function normalizeWeComWebhookMessage(body = {}) {
  const from = firstNonEmpty(body.from_id, body.fromId, body.userId, body.sender, 'wecom:webhook:default');
  return inbound({
    channel: 'wecom',
    chatId: from,
    userId: from,
    text: firstNonEmpty(body.text?.content, body.content, body.text, body.body),
    meta: {
      platform: 'wecom-webhook',
      messageId: firstNonEmpty(body.message_id, body.messageId, body.msgId, body.msg_id),
    },
  });
}

export function normalizeFeishuWebhookEvent(body = {}) {
  const event = body.event || {};
  const message = event.message || body.message || {};
  let text = '';
  try {
    const parsed = typeof message.content === 'string' ? JSON.parse(message.content || '{}') : message.content || {};
    text = firstNonEmpty(parsed.text, parsed.content, message.content);
  } catch {
    text = firstNonEmpty(message.content);
  }
  const sender = event.sender?.sender_id || body.sender?.sender_id || {};
  const openId = firstNonEmpty(sender.open_id, sender.user_id, body.open_id, body.user_id);
  const chatId = firstNonEmpty(message.chat_id, body.chat_id, openId);
  return inbound({
    channel: 'feishu',
    chatId,
    userId: openId || chatId,
    text,
    meta: {
      platform: 'feishu',
      messageId: firstNonEmpty(message.message_id, body.message_id),
    },
  });
}

/**
 * decorrelated jitter 退避：next = clamp(base, min(cap, base + rand*prev*3))。
 * 比纯指数退避更均匀地铺开重试，避免惊群。
 */
export function decorrelatedJitter(prevDelay = 0, { base = 800, cap = 30_000, rand = Math.random } = {}) {
  const r = typeof rand === 'function' ? rand() : 0.5;
  const prev = Math.max(0, Number(prevDelay) || 0);
  const next = Math.min(cap, base + Math.floor(r * prev * 3));
  return Math.max(base, next);
}

/** 把 Telegram update 归一为标准入站消息；非消息 update 返回 null。 */
export function normalizeTelegramUpdate(update, { botUsername = '' } = {}) {
  const msg = update?.message || update?.edited_message;
  if (!msg) return null;
  const text = String(msg.text || msg.caption || '');
  const uname = String(botUsername || '').replace(/^@/, '');
  const mentionsBot = uname ? new RegExp(`@${uname}\\b`, 'i').test(text) : false;
  const isReplyToBot = Boolean(msg.reply_to_message?.from?.is_bot);
  return {
    channel: 'telegram',
    chatId: String(msg.chat?.id ?? ''),
    chatType: msg.chat?.type || 'private',
    userId: String(msg.from?.id ?? ''),
    userName: msg.from?.username || msg.from?.first_name || '',
    text,
    mentionsBot,
    isReplyToBot,
    updateId: update.update_id,
  };
}

/**
 * mention-gating（Bus 订阅层决策）：决定一条入站消息是否唤醒 agent。
 * 规则：① 空消息不唤醒；② allowFrom 白名单（空=允许所有）；③ 私聊直接唤醒，群聊需 @bot 或 reply（防群骚扰）。
 * @returns {{wake:boolean, reason:string}}
 */
export function shouldWakeAgent(message, { allowFrom = [], mentionRequiredInGroups = true } = {}) {
  if (!message || !String(message.text || '').trim()) return { wake: false, reason: 'empty' };
  const allow = (Array.isArray(allowFrom) ? allowFrom : []).map(String).filter(Boolean);
  if (allow.length && !allow.includes(String(message.userId))) {
    return { wake: false, reason: 'not-in-allowlist' };
  }
  if (message.chatType && message.chatType !== 'private' && mentionRequiredInGroups) {
    if (!message.mentionsBot && !message.isReplyToBot) {
      return { wake: false, reason: 'group-no-mention' };
    }
  }
  return { wake: true, reason: 'ok' };
}

/**
 * 创建 Telegram 长轮询器（getUpdates）。fetcher 注入（默认用全局 fetch），纯网络层。
 * 出错走 decorrelatedJitter 退避重连；成功的 update 经 normalize + gating 后回调 onMessage。
 *
 * @param {object} deps
 * @param {string} deps.token bot token
 * @param {(msg:object)=>any} deps.onMessage 唤醒回调（仅 gating 通过的消息）
 * @param {(url:string)=>Promise<any>} [deps.fetcher] 注入 fetch（测试用）
 * @param {object} [deps.gating] mention-gating 配置 { allowFrom, mentionRequiredInGroups }
 * @param {string} [deps.botUsername]
 * @param {(ms:number)=>Promise<void>} [deps.sleep]
 * @param {(...a:any)=>void} [deps.log]
 */
export function createTelegramPoller(deps = {}) {
  const { token, onMessage, gating = {}, botUsername = '' } = deps;
  const fetcher = typeof deps.fetcher === 'function' ? deps.fetcher : (url) => fetch(url).then((r) => r.json());
  const sleep = typeof deps.sleep === 'function' ? deps.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const base = `https://api.telegram.org/bot${token}`;
  let offset = 0;
  let running = false;
  let backoff = 0;

  /** 处理一批 updates：normalize → gating → onMessage。返回唤醒的消息数。 */
  function handleUpdates(result) {
    let woke = 0;
    for (const update of Array.isArray(result?.result) ? result.result : []) {
      offset = Math.max(offset, Number(update.update_id || 0) + 1);
      const msg = normalizeTelegramUpdate(update, { botUsername });
      if (!msg) continue;
      const gate = shouldWakeAgent(msg, gating);
      if (gate.wake) { woke += 1; try { onMessage?.(msg); } catch (e) { log('onMessage error:', e?.message || e); } }
    }
    return woke;
  }

  async function loop() {
    running = true;
    while (running) {
      try {
        const result = await fetcher(`${base}/getUpdates?timeout=30&offset=${offset}`);
        handleUpdates(result);
        backoff = 0; // 成功则重置退避
      } catch (e) {
        backoff = decorrelatedJitter(backoff);
        log(`telegram poll failed, backoff ${backoff}ms:`, e?.message || e);
        await sleep(backoff);
      }
    }
  }

  return {
    start() { if (!running) loop(); return this; },
    stop() { running = false; },
    handleUpdates, // 暴露供测试
    get offset() { return offset; },
  };
}
