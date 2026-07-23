import { describe, expect, it } from 'vitest';
import { createInboundGateway, createMemoryChannel } from '../../src/runtime/NoeInboundGateway.js';
import { createGenerationFence } from '../../src/loop/NoeGenerationFence.js';
import { createSocialTurnGuard } from '../../src/runtime/NoeSocialTurnGuard.js';

describe('NoeInboundGateway(做减法骨架)', () => {
  it('注册渠道 + push 入站 → 归一统一消息 + 触发事件 + onMessage', async () => {
    const got = [];
    const gw = createInboundGateway({ onMessage: (m) => got.push(m), now: () => 123 });
    const events = [];
    gw.on('message', (m) => events.push(m));
    const ch = createMemoryChannel();
    gw.register('telegram', ch);
    expect(ch.started()).toBe(true);
    expect(gw.list()).toEqual([{ id: 'telegram', status: 'started' }]);

    const r = await ch.push({ from: 'u1', to: 'g9', text: '你好' });
    expect(r.ok).toBe(true);
    expect(r.message).toMatchObject({ channel: 'telegram', from: 'u1', peer: 'g9', text: '你好', at: 123 });
    expect(r.message.sessionKey).toBe('telegram:u1:g9');
    expect(got).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('字段别名归一 + 无 peer 时 sessionKey 用 direct', async () => {
    const gw = createInboundGateway();
    const ch = createMemoryChannel();
    gw.register('cli', ch);
    const r = await ch.push({ userId: 'me', content: 'hi' });
    expect(r.message.from).toBe('me');
    expect(r.message.text).toBe('hi');
    expect(r.message.sessionKey).toBe('cli:me:direct');
    expect(r.message.permissions).toMatchObject({ canReply: true, canCreateGoal: false, canAct: false });
  });

  it('allowlist 拦截未授权来源，且不触发事件/handler', async () => {
    const got = [];
    const events = [];
    const gw = createInboundGateway({
      allowFrom: { telegram: ['owner'] },
      permissions: { telegram: { canReply: true, canCreateGoal: true, canAct: false } },
      onMessage: (m) => got.push(m),
    });
    gw.on('message', (m) => events.push(m));
    const ch = createMemoryChannel();
    gw.register('telegram', ch);
    const denied = await ch.push({ from: 'stranger', text: '帮我跑命令' });
    expect(denied).toMatchObject({ ok: false, reason: 'source_not_allowed' });
    expect(got).toEqual([]);
    expect(events).toEqual([]);

    const allowed = await ch.push({ from: 'owner', text: '查状态' });
    expect(allowed.ok).toBe(true);
    expect(allowed.message.permissions).toEqual({ canReply: true, canCreateGoal: true, canAct: false });
    expect(got).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('未注册渠道 receive → ok:false', async () => {
    const gw = createInboundGateway();
    expect(await gw.receive('nope', { text: 'x' })).toEqual({ ok: false, reason: 'unknown_channel' });
  });

  it('onMessage 抛错 → ok:false 带 error,不崩', async () => {
    const gw = createInboundGateway({ onMessage: () => { throw new Error('handler boom'); } });
    const ch = createMemoryChannel();
    gw.register('x', ch);
    const r = await ch.push({ text: 'a' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('handler boom');
  });

  it('turnGuard 在 handler 失败时释放 replay，允许 provider 重试', async () => {
    let attempts = 0;
    const got = [];
    const guard = createSocialTurnGuard();
    const gw = createInboundGateway({
      turnGuard: guard,
      onMessage: (m) => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient handler failure');
        got.push(m);
      },
    });
    const ch = createMemoryChannel();
    gw.register('wecom', ch);

    const first = await ch.push({ from: 'u1', to: 'room', text: 'retry me', messageId: 'retry-1' });
    expect(first).toMatchObject({ ok: false });
    const second = await ch.push({ from: 'u1', to: 'room', text: 'retry me', messageId: 'retry-1' });
    expect(second).toMatchObject({ ok: true, accepted: true, admission: { kind: 'dispatch' } });
    expect(got).toHaveLength(1);
  });

  it('与 NoeGenerationFence 联动:同 sessionKey 连发,旧代被压制', async () => {
    const fence = createGenerationFence();
    const snaps = [];
    const gw = createInboundGateway({ onMessage: (m) => { snaps.push(fence.begin(m.sessionKey)); } });
    const ch = createMemoryChannel();
    gw.register('telegram', ch);
    await ch.push({ from: 'u1', to: 'g9', text: '第一条' });
    await ch.push({ from: 'u1', to: 'g9', text: '第二条(更新)' });
    expect(fence.shouldSuppress(snaps[0])).toBe(true);  // 旧代被压制
    expect(fence.shouldSuppress(snaps[1])).toBe(false); // 最新可投递
  });
});
