// NoeInboundGateway — 多渠道入站网关(刻意做减法版)。
//
// 战略取舍(见 docs/决策_OS还是Agent平台):真实多平台入站(微信/Telegram/Discord…)是
//   "做大会死 + 单人维护不动" 的坑,**故意不一次铺开**。本文件只提供:
//   ① 渠道无关的统一抽象(注册渠道 → 入站消息归一成统一事件 → 路由给 handler)
//   ② 一个内存渠道(试点/测试用)。真实渠道照 createMemoryChannel 的 start(deliver) 接口实现即可,
//   一次只接一个、验证再加下一个,不堆砌。
//
// 纯逻辑、注入式时钟、可单测。配合 NoeGenerationFence(已建)按 sessionKey 防连击。
import { EventEmitter } from 'node:events';
import { createGenerationFence, resolveFenceKey } from '../loop/NoeGenerationFence.js';

export function createInboundGateway({
  onMessage = null,
  now = () => Date.now(),
  allowFrom = null,
  permissions = null,
  turnGuard = null,
} = {}) {
  const emitter = new EventEmitter();
  const channels = new Map(); // id -> { adapter, status }
  let seq = 0;

  function permissionsFor(channelId, raw = {}) {
    if (typeof permissions === 'function') return permissions(channelId, raw) || {};
    if (permissions && typeof permissions === 'object') return permissions[channelId] || permissions.default || {};
    return { canReply: true, canCreateGoal: false, canAct: false };
  }

  function isAllowed(channelId, raw = {}, from = '') {
    if (!allowFrom) return true;
    if (typeof allowFrom === 'function') return allowFrom({ channelId, raw, from }) === true;
    const list = Array.isArray(allowFrom) ? allowFrom : allowFrom[channelId] || allowFrom.default || [];
    return list.map((x) => String(x)).includes(String(from));
  }

  function normalize(channelId, raw = {}) {
    const text = String(raw.text ?? raw.content ?? raw.body ?? '').slice(0, 16000);
    const from = String(raw.from ?? raw.userId ?? raw.sender ?? 'unknown').slice(0, 240).trim() || 'unknown';
    const peer = String(raw.to ?? raw.peer ?? raw.chatId ?? '').slice(0, 240).trim();
    return {
      id: `in-${++seq}`,
      channel: channelId,
      from,
      peer,
      sessionKey: `${channelId}:${from}:${peer || 'direct'}`, // 与 NoeGenerationFence 的 key 维度对齐
      text,
      at: now(),
      permissions: permissionsFor(channelId, raw),
      raw,
    };
  }

  async function receive(channelId, raw) {
    if (!channels.has(channelId)) return { ok: false, reason: 'unknown_channel' };
    const message = normalize(channelId, raw);
    if (!isAllowed(channelId, raw, message.from)) return { ok: false, reason: 'source_not_allowed', message };
    const turn = typeof turnGuard?.admit === 'function' ? turnGuard.admit(message) : null;
    if (turn?.accepted === false || turn?.admission?.kind === 'drop') {
      return {
        ok: true,
        accepted: false,
        reason: turn.admission?.reason || 'turn_dropped',
        admission: turn.admission,
        turn,
        message,
      };
    }
    emitter.emit('message', message);
    let handlerResult;
    if (typeof onMessage === 'function') {
      try { handlerResult = await onMessage(message); } catch (e) {
        if (turn?.accepted === true && typeof turnGuard?.release === 'function') turnGuard.release(turn);
        return { ok: false, error: e?.message || String(e), message };
      }
    }
    return {
      ok: true,
      accepted: true,
      message,
      ...(turn ? { admission: turn.admission, turn } : {}),
      ...(handlerResult !== undefined ? { handlerResult } : {}),
    };
  }

  function register(channelId, adapter = {}) {
    const id = String(channelId || '').trim();
    if (!id) throw new Error('channelId required');
    channels.set(id, { adapter, status: 'registered' });
    if (typeof adapter.start === 'function') {
      try { adapter.start((raw) => receive(id, raw)); channels.get(id).status = 'started'; }
      catch { channels.get(id).status = 'error'; }
    }
    return id;
  }

  return {
    register,
    receive,
    on(event, fn) { emitter.on(event, fn); return this; },
    list() { return [...channels.entries()].map(([id, v]) => ({ id, status: v.status })); },
    has(id) { return channels.has(id); },
  };
}

/**
 * 带代际栅栏的入站应答器（T1 接线）：同一 sessionKey 连发多条时，旧回复被压制、只投递最新一代。
 * 用法：把返回值作为 gateway 的 onMessage；respond(message)→reply 生成回复，deliver(reply, message) 真投递。
 * message.sessionKey 即 normalize() 产出的 `${channel}:${from}:${peer||'direct'}`（与 fence key 维度对齐）。
 */
export function createFencedResponder({ fence = null, respond, deliver } = {}) {
  if (typeof respond !== 'function' || typeof deliver !== 'function') throw new TypeError('createFencedResponder 需要 respond 与 deliver 函数');
  const f = fence || createGenerationFence();
  return async function handleInbound(message) {
    const snapshot = f.begin(resolveFenceKey({ sessionKey: message?.sessionKey, channel: message?.channel, to: message?.peer }));
    let consumed = !snapshot;   // 快照恰好消费一次：markDelivered 或 release 二选一
    try {
      const reply = await respond(message);
      if (snapshot) {
        consumed = true;
        const visible = f.markDelivered(snapshot);   // 单点判定+消费：被更新一代抢先 → 压制本代不投递
        if (!visible) return { ok: true, suppressed: true, message };
      }
      await deliver(reply, message);
      return { ok: true, suppressed: false, reply, message };
    } catch (e) {
      if (!consumed && snapshot) f.release(snapshot);
      return { ok: false, error: e?.message || String(e), message };
    }
  };
}

/** 内存渠道:试点/测试用。push(raw) 模拟一条入站消息。真实渠道照此实现 start(deliver)。 */
export function createMemoryChannel() {
  let deliver = null;
  return {
    start(d) { deliver = d; },
    push(raw) { return deliver ? deliver(raw) : { ok: false, reason: 'not_started' }; },
    started() { return Boolean(deliver); },
  };
}
