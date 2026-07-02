// NoeNtfyPush — 关键事件推手机（Top100 #63 ntfy，波次后续小项）。
//
// 与 NoeStickyEvents 互补：Sticky 管「断线重连补发」（人回到电脑前），ntfy 管「人不在电脑前也能收到」——
// hang 告警 / 死前交接 / 自动暂停这类事件直接推到手机（ntfy app 订阅同名 topic 即可，免注册免 key）。
// 用 ntfy 的 JSON publish（POST 到 base 根路径，body 含 topic/title/message，UTF-8 安全）。
// env 门控：NOE_NTFY_TOPIC 配了才通电；自建服务 NOE_NTFY_BASE 覆盖（默认官方 ntfy.sh）。
// fire-and-forget + fail-soft：推送失败只 log，绝不影响广播主链路。

import { redactSensitiveText } from './NoeContextScrubber.js';

export const DEFAULT_PUSH_TYPES = ['noe_hang_alert', 'noe_turn_finalized', 'chat_finalizer', 'room_auto_paused'];

const TITLES = {
  noe_hang_alert: '⚠️ Noe：长跑任务疑似卡住',
  noe_turn_finalized: '📝 Noe：预算耗尽已留死前交接',
  chat_finalizer: '📝 Noe：聊天房预算爆，已留交接',
  room_auto_paused: '⏸ Noe：房间连续失败自动暂停',
};

/** 事件 → 推送消息体（null = 该事件不推）。 */
export function formatNtfyMessage(event, { types = DEFAULT_PUSH_TYPES } = {}) {
  const t = event?.type;
  if (!t || !types.includes(t)) return null;
  const detail = event.alert
    ? `任务 ${event.alert.taskId || '?'} 已 ${Math.round((event.alert.silentMs || 0) / 60000)} 分钟无响应（只告警不杀，去面板看一眼）`
    : (event.summary || event.message?.content || event.reason || '');
  return {
    title: TITLES[t] || `Noe 事件：${t}`,
    message: redactSensitiveText(String(detail || '')).slice(0, 400) || '（无详情，去面板查看）',
    priority: t === 'noe_hang_alert' ? 4 : 3,   // ntfy 1-5，4=高
    tags: ['robot'],
  };
}

/**
 * 建推送器。返回 { push(event), enabled }。
 * @param {object} deps { topic, base='https://ntfy.sh', fetchImpl=fetch, types, log }
 */
export function createNtfyPusher({ topic, base = 'https://ntfy.sh', fetchImpl = fetch, types = DEFAULT_PUSH_TYPES, log = () => {} } = {}) {
  const cleanTopic = String(topic || '').trim();
  if (!cleanTopic) return { enabled: false, push: () => false };
  const url = base.replace(/\/$/, '');
  return {
    enabled: true,
    /** 关键事件 → 异步推手机（fire-and-forget）。返回是否触发了推送。 */
    push(event) {
      const msg = formatNtfyMessage(event, { types });
      if (!msg) return false;
      Promise.resolve(fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: cleanTopic, ...msg }),
      })).catch((e) => log('[noe-ntfy] 推送失败(不影响主链路):', e?.message || e));
      return true;
    },
  };
}
