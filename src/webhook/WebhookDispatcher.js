// v0.54 Sprint 4 — Webhook 触发器
//
// 监听 server.js 的 broadcastRoom 事件，把 done/error/auto_paused 转成 outgoing HTTP POST
// 支持 discord / slack / 通用 json 三种 payload 格式

import { webhookStore } from './WebhookStore.js';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';
// SSRF 出站统一走 SsrfGuard.safeFetchPublicUrl（逐跳校验 + pinned dispatcher + redirect:manual），
// 闭合 webhook 目标的 DNS rebinding TOCTOU（原先只 assertPublicUrl 预检后 postJson 裸 fetch 重解析）。
import { safeFetchPublicUrl } from '../security/SsrfGuard.js';

const HTTP_TIMEOUT_MS = 10000;
const MAX_BODY = 32 * 1024;  // 单个 webhook payload 上限 32KB

const EVENT_MAP = {
  debate_done: 'room_done',
  squad_done:  'room_done',
  arena_done:  'room_done',
  debate_error: 'room_error',
  squad_error:  'room_error',
  arena_error:  'room_error',
  chat_error:   'room_error',
  room_auto_paused: 'room_auto_paused',
};

const MODE_EMOJI = { debate: '🗣', squad: '👥', arena: '🏟', chat: '💬', plugin: '🧩' };

export function buildPayload(format, ctx) {
  const { mode, eventCategory, eventType, panelUrl } = ctx;
  // 外发到第三方 URL 前,对所有房间/模型生成文本脱敏(防 secret 随 reply 外泄),与 NoeSocialFinalPublishExecutor 同款标准
  const roomName = redactSensitiveText(ctx.roomName || '');
  const error = redactSensitiveText(ctx.error || '');
  const reason = redactSensitiveText(ctx.reason || '');
  const summary = redactSensitiveText(ctx.summary || '');
  const emoji = MODE_EMOJI[mode] || '🤖';
  const modeLabel = ({ debate: '辩论', squad: '小组', arena: '对决', chat: '闲聊' })[mode] || mode;
  let title, body;
  if (eventCategory === 'room_done') {
    title = `${emoji} ${roomName} · ${modeLabel}完成`;
    body = (summary && summary.length > 0)
      ? summary.slice(0, 1500)
      : '（无摘要）';
  } else if (eventCategory === 'room_error') {
    title = `❌ ${roomName} · ${modeLabel}出错`;
    body = String(error || '未知错误').slice(0, 500);
  } else if (eventCategory === 'room_auto_paused') {
    title = `🛑 ${roomName} · 自动暂停`;
    body = String(reason || '连续失败').slice(0, 500);
  } else {
    title = `${emoji} ${roomName} · ${eventType}`;
    body = '';
  }
  const colorMap = { room_done: 0x2da44e, room_error: 0xdc3545, room_auto_paused: 0xc15f3c };
  const color = colorMap[eventCategory] || 0x6c757d;

  if (format === 'discord') {
    return {
      content: title,
      embeds: [{
        title,
        description: body,
        color,
        url: panelUrl || undefined,
        timestamp: new Date().toISOString(),
        footer: { text: 'Noe' },
      }],
    };
  }
  if (format === 'slack') {
    return {
      text: title,
      attachments: [{
        color: eventCategory === 'room_done' ? 'good' : eventCategory === 'room_error' ? 'danger' : 'warning',
        title,
        text: body,
        ts: Math.floor(Date.now() / 1000),
      }],
    };
  }
  // json
  return { event: eventCategory, eventType, roomName, mode, body, error, reason, summary, at: new Date().toISOString() };
}

async function postJson(url, body, headers = {}) {
  const json = JSON.stringify(body);
  if (json.length > MAX_BODY) throw new Error(`payload 过大 (${json.length} > ${MAX_BODY})`);
  // 逐跳 SSRF 校验 + pinned dispatcher（闭合 DNS rebinding TOCTOU）；超时由 safeFetchPublicUrl 接管。
  const { resp, cleanup } = await safeFetchPublicUrl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: json,
    timeoutMs: HTTP_TIMEOUT_MS,
    maxRedirects: 0, // webhook 不跟随 redirect：防 302 到跨域把 Authorization/X-Api-Key/body 泄漏给攻击者域。
  });
  try {
    if (!resp.ok) {
      const txt = await resp.text?.().catch?.(() => '') ?? '';
      throw new Error(`HTTP ${resp.status}: ${String(txt).slice(0, 200)}`);
    }
    return true;
  } finally {
    cleanup?.();
  }
}

/** 由 server.js 的 broadcastRoom 调用 */
export async function fireWebhooks(roomId, msg, room) {
  const eventCategory = EVENT_MAP[msg.type];
  if (!eventCategory) return;  // 不是我们关心的事件

  const ctx = {
    roomId,
    roomName: room?.name || '',
    mode: room?.mode || '',
    eventCategory,
    eventType: msg.type,
    error: msg.error,
    reason: msg.reason,
    summary: room?.finalConsensus || msg.content || '',
    panelUrl: `http://localhost:${process.env.PORT || 51835}`,
  };

  const candidates = webhookStore.list({ mask: false }).filter((w) => {
    if (!w.enabled) return false;
    if (!w.events.includes(eventCategory)) return false;
    if (w.roomFilter !== '*' && Array.isArray(w.roomFilter) && !w.roomFilter.includes(roomId)) return false;
    return true;
  });
  if (candidates.length === 0) return;

  // 并行 fire（fire-and-forget，不阻塞 broadcastRoom）
  for (const w of candidates) {
    const payload = buildPayload(w.format, ctx);
    // SSRF/DNS-rebinding 校验由 postJson→safeFetchPublicUrl 逐跳完成（连接锁定已校验公网 IP，挡借房间内容打内网）。
    Promise.resolve()
      .then(() => postJson(w.url, payload, w.headers || {}))
      .then(() => webhookStore.bumpStats(w.id, true))
      .catch((e) => {
        webhookStore.bumpStats(w.id, false, e.message);
        console.warn(`[webhook] ${w.name} fire failed:`, e.message);
      });
  }
}

/** 测试一个 webhook（用户在 UI 点"测试连接"时调） */
export async function testWebhook(w) {
  const payload = buildPayload(w.format, {
    roomName: '(测试)',
    mode: 'debate',
    eventCategory: 'room_done',
    eventType: 'debate_done',
    summary: '这是来自 Noe的测试推送 — 看到这条说明 webhook 工作正常',
    panelUrl: `http://localhost:${process.env.PORT || 51835}`,
  });
  // SSRF 校验由 postJson→safeFetchPublicUrl 逐跳完成（含 DNS rebinding 防护），避免被用来探测内网。
  await postJson(w.url, payload, w.headers || {});
  return { ok: true };
}
