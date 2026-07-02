// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { createWsHeartbeat } from '../../src/server/services/ws-heartbeat.js';

function makeWs() {
  return {
    isAlive: undefined,
    pingCount: 0,
    terminated: false,
    _h: {},
    on(ev, fn) { this._h[ev] = fn; },
    ping() { this.pingCount++; },
    terminate() { this.terminated = true; },
    pong() { if (this._h.pong) this._h.pong(); }, // 模拟收到对端 pong
  };
}

describe('ws-heartbeat (VCP 吸收 H1)', () => {
  it('构造缺 collectClients 抛 TypeError', () => {
    expect(() => createWsHeartbeat({})).toThrow(TypeError);
    expect(() => createWsHeartbeat()).toThrow(TypeError);
  });

  it('track 标记存活 + 注册 pong 复位', () => {
    const hb = createWsHeartbeat({ collectClients: () => [] });
    const ws = makeWs();
    hb.track(ws);
    expect(ws.isAlive).toBe(true);
    // pong handler 已挂
    expect(typeof ws._h.pong).toBe('function');
  });

  it('track 幂等 + 对 null/非对象不崩', () => {
    const hb = createWsHeartbeat({ collectClients: () => [] });
    expect(() => hb.track(null)).not.toThrow();
    expect(() => hb.track(undefined)).not.toThrow();
    expect(() => hb.track(42)).not.toThrow();
    const ws = makeWs();
    hb.track(ws); hb.track(ws); // 重复
    expect(ws.isAlive).toBe(true);
  });

  it('track 幂等：重复调用只挂一次 pong 监听器（不堆积，防 MaxListenersExceededWarning）', () => {
    const hb = createWsHeartbeat({ collectClients: () => [] });
    let pongHandlers = 0;
    const ws = { isAlive: undefined, on(ev) { if (ev === 'pong') pongHandlers++; } };
    hb.track(ws); hb.track(ws); hb.track(ws);
    expect(pongHandlers).toBe(1);
    expect(ws.isAlive).toBe(true);
  });

  it('sweepOnce 活连接：置 isAlive=false + ping，不 terminate', () => {
    const ws = makeWs();
    const hb = createWsHeartbeat({ collectClients: () => [ws] });
    hb.track(ws); // isAlive=true
    const r = hb.sweepOnce();
    expect(ws.isAlive).toBe(false);
    expect(ws.pingCount).toBe(1);
    expect(ws.terminated).toBe(false);
    expect(r).toEqual({ terminated: 0, pinged: 1, total: 1 });
  });

  it('sweepOnce 死连接（上轮未回 pong）：terminate，不 ping', () => {
    const ws = makeWs();
    ws.isAlive = false; // 上轮 ping 后没回 pong
    const hb = createWsHeartbeat({ collectClients: () => [ws] });
    const r = hb.sweepOnce();
    expect(ws.terminated).toBe(true);
    expect(ws.pingCount).toBe(0);
    expect(r).toEqual({ terminated: 1, pinged: 0, total: 1 });
  });

  it('两轮：回 pong 的连接存活，不回 pong 的第二轮被 terminate', () => {
    const alive = makeWs();
    const dead = makeWs();
    const hb = createWsHeartbeat({ collectClients: () => [alive, dead].filter(w => !w.terminated) });
    hb.track(alive); hb.track(dead);
    // 第一轮：都 ping，isAlive 都置 false
    hb.sweepOnce();
    expect(alive.isAlive).toBe(false);
    expect(dead.isAlive).toBe(false);
    // alive 回了 pong → isAlive 复位 true；dead 没回
    alive.pong();
    expect(alive.isAlive).toBe(true);
    // 第二轮：alive 存活再 ping，dead 判死 terminate
    hb.sweepOnce();
    expect(alive.terminated).toBe(false);
    expect(alive.pingCount).toBe(2);
    expect(dead.terminated).toBe(true);
  });

  it('反向 probe：空集合 sweep 返回全 0 不崩', () => {
    const hb = createWsHeartbeat({ collectClients: () => [] });
    expect(hb.sweepOnce()).toEqual({ terminated: 0, pinged: 0, total: 0 });
  });

  it('反向 probe：collectClients 抛错 → fail-open 不崩', () => {
    const logs = [];
    const hb = createWsHeartbeat({
      collectClients: () => { throw new Error('boom'); },
      log: (m) => logs.push(m),
    });
    expect(() => hb.sweepOnce()).not.toThrow();
    expect(hb.sweepOnce()).toEqual({ terminated: 0, pinged: 0, total: 0 });
    expect(logs.some(l => l.includes('collectClients'))).toBe(true);
  });

  it('反向 probe：集合含 null 元素 → 跳过不计数', () => {
    const ws = makeWs(); hb_track(ws);
    function hb_track(w) { w.isAlive = true; }
    const hb = createWsHeartbeat({ collectClients: () => [null, ws, undefined] });
    const r = hb.sweepOnce();
    expect(r.total).toBe(1);
    expect(ws.pingCount).toBe(1);
  });

  it('反向 probe：单个 ws.ping 抛错不中断其他 ws', () => {
    const bad = makeWs(); bad.isAlive = true; bad.ping = () => { throw new Error('ping fail'); };
    const good = makeWs(); good.isAlive = true;
    const hb = createWsHeartbeat({ collectClients: () => [bad, good] });
    expect(() => hb.sweepOnce()).not.toThrow();
    expect(good.pingCount).toBe(1); // good 仍被处理
  });

  it('反向 probe：单个 ws.terminate 抛错不中断其他 ws', () => {
    const bad = makeWs(); bad.isAlive = false; bad.terminate = () => { throw new Error('term fail'); };
    const good = makeWs(); good.isAlive = false;
    const hb = createWsHeartbeat({ collectClients: () => [bad, good] });
    expect(() => hb.sweepOnce()).not.toThrow();
    expect(good.terminated).toBe(true);
  });

  it('多集合去重(H1 multimodel审)：同一 ws 出现两次只处理一次', () => {
    const ws = makeWs(); ws.isAlive = false;
    const hb = createWsHeartbeat({ collectClients: () => [ws, ws] }); // 模拟同一 ws 在多集合
    const r = hb.sweepOnce();
    expect(r.total).toBe(1); // 去重后只算一次（防同轮置 false 后又 terminate）
    expect(ws.terminated).toBe(true);
  });

  it('intervalMs clamp(H1 multimodel审)：start 不会用 <1000ms(防 ping storm)', () => {
    const realSI = globalThis.setInterval;
    let captured;
    globalThis.setInterval = (fn, ms) => { captured = ms; return { unref() {} }; };
    try {
      const hb = createWsHeartbeat({ collectClients: () => [], intervalMs: 1 });
      hb.start();
      expect(captured).toBeGreaterThanOrEqual(1000);
    } finally {
      globalThis.setInterval = realSI;
    }
  });

  it('反向 probe：遍历中 terminate→close 删源集合元素不崩（快照保护）', () => {
    const set = new Set();
    const a = makeWs(); a.isAlive = false;
    const b = makeWs(); b.isAlive = false;
    // terminate 模拟同步触发 close 删自身
    a.terminate = () => { a.terminated = true; set.delete(a); };
    b.terminate = () => { b.terminated = true; set.delete(b); };
    set.add(a); set.add(b);
    const hb = createWsHeartbeat({ collectClients: () => set });
    const r = hb.sweepOnce();
    expect(r.terminated).toBe(2);
    expect(set.size).toBe(0);
  });

  it('start/stop 幂等', () => {
    const hb = createWsHeartbeat({ collectClients: () => [], intervalMs: 1_000_000 });
    expect(hb.start()).toBe(true);
    expect(hb.start()).toBe(false); // 已启动
    expect(hb.getStats().running).toBe(true);
    expect(hb.stop()).toBe(true);
    expect(hb.stop()).toBe(false); // 已停止
    expect(hb.getStats().running).toBe(false);
  });

  it('getStats 累加统计 + lastSweep', () => {
    const ws = makeWs(); ws.isAlive = true;
    let t = 100;
    const hb = createWsHeartbeat({ collectClients: () => [ws], now: () => t });
    hb.sweepOnce();
    t = 200; ws.isAlive = true; hb.sweepOnce();
    const s = hb.getStats();
    expect(s.sweeps).toBe(2);
    expect(s.pinged).toBe(2);
    expect(s.lastSweep).toBe(200);
  });
});
