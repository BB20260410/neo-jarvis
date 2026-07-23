import { describe, expect, it } from 'vitest';
import { createFencedResponder, createInboundGateway, createMemoryChannel } from '../../src/runtime/NoeInboundGateway.js';

const msg = (text, sessionKey = 'tg:u1:direct') => ({ sessionKey, channel: 'telegram', peer: 'u1', text });

describe('createFencedResponder（T1 入站接线）', () => {
  it('同 sessionKey 连发：旧回复不投递，只投最新一代', async () => {
    const delivered = [];
    let releaseFirst;
    const gate = new Promise((r) => { releaseFirst = r; });
    const handle = createFencedResponder({
      respond: async (m) => { if (m.text === '一') await gate; return `回:${m.text}`; },
      deliver: async (reply) => { delivered.push(reply); },
    });
    const p1 = handle(msg('一'));
    const p2 = handle(msg('二'));
    const r2 = await p2;
    expect(r2.ok).toBe(true);
    expect(r2.suppressed).toBe(false);
    releaseFirst();
    const r1 = await p1;
    expect(r1.ok).toBe(true);
    expect(r1.suppressed).toBe(true);
    expect(delivered).toEqual(['回:二']);   // 旧回复绝不落到用户面前
  });

  it('respond 抛错 → ok:false 且代际释放（后续同 key 正常投递）', async () => {
    const delivered = [];
    let fail = true;
    const handle = createFencedResponder({
      respond: async () => { if (fail) throw new Error('boom'); return 'ok回复'; },
      deliver: async (reply) => { delivered.push(reply); },
    });
    const r1 = await handle(msg('x'));
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain('boom');
    fail = false;
    const r2 = await handle(msg('y'));
    expect(r2.ok).toBe(true);
    expect(delivered).toEqual(['ok回复']);
  });

  it('deliver 抛错 → ok:false 且不重复消费快照（后续正常）', async () => {
    let failDeliver = true;
    const delivered = [];
    const handle = createFencedResponder({
      respond: async (m) => `回:${m.text}`,
      deliver: async (reply) => { if (failDeliver) throw new Error('net down'); delivered.push(reply); },
    });
    const r1 = await handle(msg('一'));
    expect(r1.ok).toBe(false);
    failDeliver = false;
    const r2 = await handle(msg('二'));
    expect(r2.ok).toBe(true);
    expect(delivered).toEqual(['回:二']);
  });

  it('message 缺关键维度（无 sessionKey/channel/peer）→ 无法栅栏，默认放行投递', async () => {
    const delivered = [];
    const handle = createFencedResponder({ respond: async () => 'r', deliver: async (reply) => { delivered.push(reply); } });
    const r = await handle({ text: 'x' });
    expect(r.ok).toBe(true);
    expect(delivered).toEqual(['r']);
  });

  it('缺 respond/deliver 抛 TypeError', () => {
    expect(() => createFencedResponder({})).toThrow(TypeError);
  });

  it('与 gateway + memory channel 集成：onMessage 挂 fencedResponder 可用', async () => {
    const delivered = [];
    const handle = createFencedResponder({ respond: async (m) => `回:${m.text}`, deliver: async (reply) => { delivered.push(reply); } });
    const gateway = createInboundGateway({ onMessage: handle });
    const channel = createMemoryChannel();
    gateway.register('mem', channel);
    const r = await channel.push({ text: '你好', from: 'u1' });
    expect(r.ok).toBe(true);
    expect(delivered).toEqual(['回:你好']);
  });
});
