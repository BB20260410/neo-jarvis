// NoeStickyEvents — 关键事件粘性缓存（T27 波次6 接线）。
//
// 问题：hang 告警 / 死前交接 / 自动暂停这类「一次性广播」，Electron 切窗 / WS 断线期间发出就永久丢了，
//   用户回来完全不知道发生过。
// 方案：广播路径把关键类型事件存进 FIFO(默认50)；新 WS 连接建立时整批补发（标 replay:true 供前端区分）。
// 纯逻辑、可单测；非关键高频事件（metrics/tick）不入缓存，防刷屏。

export const DEFAULT_STICKY_TYPES = [
  'noe_hang_alert',        // 长跑卡死告警（错过 = 不知道卡死）
  'noe_turn_finalized',    // NoeLoop 预算死前交接
  'chat_finalizer',        // 聊天房预算交接
  'room_auto_paused',      // 连续失败自动暂停
  'health_warning',        // panel 健康警告
];

export function createStickyEventBuffer({ capacity = 50, types = DEFAULT_STICKY_TYPES } = {}) {
  const cap = Math.max(1, Math.trunc(Number(capacity) || 50));
  const allow = new Set(Array.isArray(types) ? types : []);
  /** @type {object[]} */
  const buf = [];
  return {
    /** 广播路径调用：是关键类型则入缓存（补 ts），超容量挤掉最旧。返回是否入缓存。 */
    consider(msg) {
      const t = msg?.type;
      if (!t || (allow.size && !allow.has(t))) return false;
      buf.push({ ...msg, ts: msg.ts || Date.now() });
      if (buf.length > cap) buf.shift();
      return true;
    },
    /** 新连接补发：返回快照副本（replay:true 让前端区分补发与实时）。 */
    replay() { return buf.map((m) => ({ ...m, replay: true })); },
    size() { return buf.length; },
    clear() { buf.length = 0; },
  };
}
