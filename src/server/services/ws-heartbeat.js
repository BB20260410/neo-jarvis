// @ts-check
/**
 * WS 心跳保活 + 死连接周期清扫（VCP 吸收 H1，纯 ws 标准 ping/pong pattern 独立实现，不拷 VCP 源码）。
 *
 * 背景（本机长跑 OS 的真实容灾洞）：
 *   半开 TCP 连接（Wi-Fi 切换 / 笔记本合盖 / Electron 休眠）不会触发 ws 'close' 事件，
 *   死 socket 会永久滞留在 globalWsClients/roomWsClients/terminals/sessions 集合里，
 *   broadcastGlobal/broadcastRoom 每轮都往死连接写 → fd 与内存缓慢泄漏。
 *
 * 机制：周期 ping。上一轮没回 pong（isAlive 仍为 false）的连接判死 terminate()；
 *   否则置 isAlive=false 再 ping()，等下一轮检查是否回了 pong。活连接由 ws 库自动回 pong。
 *
 * DI：集合形态由调用方通过 collectClients() 提供（解耦 server.js 的多种集合结构：Set / Map<id,Set> / Map<id,{clients:Set}>）。
 */

/**
 * @param {object} deps
 * @param {() => Iterable<any>} deps.collectClients 返回当前所有 WS 连接的可迭代对象
 * @param {number} [deps.intervalMs] sweep 周期（毫秒），默认 30000
 * @param {() => number} [deps.now] 时钟（可注入便于测试）
 * @param {(msg: string) => void} [deps.log] 日志
 */
export function createWsHeartbeat({ collectClients, intervalMs = 30_000, now = () => Date.now(), log = () => {} } = {}) {
  if (typeof collectClients !== 'function') {
    throw new TypeError('createWsHeartbeat: collectClients 必须是函数');
  }
  /** @type {any} */
  let timer = null;
  /** @type {number|null} */
  let lastSweep = null;
  const stats = { sweeps: 0, terminated: 0, pinged: 0 };

  /**
   * 连接建立时调用：标记存活 + 挂 pong 复位（幂等，可重复调用）。
   * @param {any} ws
   */
  function track(ws) {
    if (!ws || typeof ws !== 'object') return ws;
    ws.isAlive = true;
    // 幂等：重复 track 同一 ws 只挂一次 pong 监听器，避免监听器堆积 / MaxListenersExceededWarning。
    if (ws.__hbTracked) return ws;
    ws.__hbTracked = true;
    try { ws.on?.('pong', () => { ws.isAlive = true; }); } catch {}
    return ws;
  }

  /**
   * 一轮清扫：死连接 terminate，活连接置疑 + ping。返回本轮统计。
   * 先快照成数组，避免 terminate()→'close' 在遍历中 mutate 源集合。
   */
  function sweepOnce() {
    let terminated = 0;
    let pinged = 0;
    let total = 0;
    /** @type {any[]} */
    let clients;
    try {
      clients = Array.from(collectClients());
    } catch (e) {
      log('[ws-heartbeat] collectClients 失败: ' + (e && e.message ? e.message : String(e)));
      return { terminated: 0, pinged: 0, total: 0 };
    }
    const seen = new Set();
    for (const ws of clients) {
      if (!ws || seen.has(ws)) continue; // H1 multimodel 审：同一 ws 若在多集合只处理一次，防同轮置 false 后又被 terminate
      seen.add(ws);
      total++;
      if (ws.isAlive === false) {
        try { ws.terminate?.(); } catch {}
        terminated++;
        continue;
      }
      ws.isAlive = false;
      try { ws.ping?.(); pinged++; } catch {}
    }
    stats.sweeps++;
    stats.terminated += terminated;
    stats.pinged += pinged;
    lastSweep = now();
    return { terminated, pinged, total };
  }

  /** 启动周期 sweep（幂等）。timer.unref 避免阻塞进程退出。 */
  function start() {
    if (timer) return false;
    timer = setInterval(() => { try { sweepOnce(); } catch {} }, Math.max(1000, Number(intervalMs) || 30_000)); // H1 multimodel 审：clamp 下限防 1ms/负数 ping storm
    try { timer && timer.unref && timer.unref(); } catch {}
    return true;
  }

  /** 停止周期 sweep（幂等，供 gracefulShutdown 调用）。 */
  function stop() {
    if (!timer) return false;
    try { clearInterval(timer); } catch {}
    timer = null;
    return true;
  }

  function getStats() {
    return { ...stats, lastSweep, running: !!timer };
  }

  return { track, sweepOnce, start, stop, getStats };
}
