// @ts-check
// NoeHeartbeat — 持久心跳调度器（设计文档《AI自我意识实现方案》§3，结构性缺口一）。
//
// 问题：Noe 的"主动性"原本依赖前端轮询（浏览器一关主动陪伴就死）+ 各子系统散装 setInterval
//   （重启相位归零、互不知晓、无台账）。机制六"不被观察也在"要求心跳是服务端的、持久的。
// 设计：单 setTimeout 链（串行是特性：同一时刻只有一个认知 tick 在泵里跑，对应全局工作区的
//   串行广播）；游标持久化（重启续相位）；tick 台账（写前 intent / 写后 outcome / 失败留痕）；
//   租约判死；欠账策略 drop/once/all；启动滞后回调 onRecovery（→"我断了一会儿"恢复情景）。
// 纪律：job 抛错只标 failed 不影响心跳本身（fail-open）；台账写失败也不阻断作业；
//   注入式全可测（store/now/setTimer/clearTimer 注入，pumpOnce 暴露给单测手动驱动）。

import { createActiveJobGuard } from '../runtime/NoeActiveJobGuard.js';
import { readEmergencyStop, emergencyStopShouldSkip } from '../security/NoeEmergencyStop.js';

/**
 * @typedef {object} HeartbeatJob
 * @property {number} cadenceMs 节奏周期（ms）
 * @property {(ctx: {tickId: number, now: number, updateOutcome: (outcome: any) => boolean}) => any} run 执行体（可 async；抛错→failed）
 * @property {'drop'|'once'|'all'} [catchUp] 欠账策略：drop=不补只留痕 / once=只补1次(默认) / all=补到上限
 * @property {number} [maxCatchUp] catchUp='all' 时本轮最多连跑次数（默认 2）
 * @property {() => any} [intent] 写前日志内容生成器（可选）
 */

export function createHeartbeat({
  store,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  leaseMs = 10 * 60_000,             // 租约：超时视为死 tick（本地模型作业可达数分钟，给足）
  minWakeMs = 1_000,
  maxWakeMs = 60_000,
  recoveryThresholdMs = 10 * 60_000, // 启动滞后超过此值才算"断过一阵"（快速重启不打扰）
  onRecovery = null,                 // (lagMs:number)=>void：启动检测到长滞后时回调一次
  activeJobGuard = createActiveJobGuard(),
  emergencyStop = readEmergencyStop,   // P0.5：() => {stopped, source, reason}；停时跳过自主 kind（注入式可测）
  log = console,
} = {}) {
  if (!store) throw new Error('createHeartbeat: store(NoeHeartbeatStore) required');
  /** @type {Map<string, HeartbeatJob>} */
  const jobs = new Map();
  let timer = /** @type {any} */ (null);
  let running = false;
  let pumping = false;
  const activeTickIds = new Set();
  const interruptedTickIds = new Set();

  /** 注册一类 tick 作业（start 前后均可；游标在 start/下一轮泵时播种）。 */
  function register(kind, job) {
    if (!kind || typeof job?.run !== 'function' || !Number.isFinite(job.cadenceMs) || job.cadenceMs <= 0) {
      throw new Error(`heartbeat.register: 非法 job（kind=${kind}）`);
    }
    jobs.set(String(kind), { catchUp: 'once', maxCatchUp: 2, ...job });
  }

  function safeIntent(job) { try { return job.intent ? job.intent() : null; } catch { return null; } }

  function heartbeatJobKey(kind) {
    return `heartbeat:${String(kind)}`;
  }

  function activeSkipOutcome(kind) {
    return { skipped: true, reason: 'active_job_already_running', activeJobKey: heartbeatJobKey(kind) };
  }

  function trackTick(tickId) {
    if (tickId) activeTickIds.add(tickId);
  }

  function finishTrackedTick(tickId, write) {
    if (!tickId) return;
    try {
      if (!interruptedTickIds.has(tickId)) write();
    } finally {
      activeTickIds.delete(tickId);
      interruptedTickIds.delete(tickId);
    }
  }

  function buildRunContext(tickId, t1) {
    return {
      tickId,
      now: t1,
      updateOutcome(outcome) {
        if (!tickId || interruptedTickIds.has(tickId)) return false;
        try {
          // 反映真实写入：tick 若已落终态（如租约过期被标 failed），store.finishTick 守卫会拒写，
          // 返回 0 → 此处 false，让 detached 回填方得知结果未被采纳（不抹失败留痕）。
          const changed = store.finishTick(tickId, outcome ?? null, now());
          return changed == null ? true : changed > 0;
        } catch {
          return false;
        }
      },
    };
  }

  async function runGuardedJob(kind, job, tickId, t1) {
    const key = heartbeatJobKey(kind);
    const guarded = await activeJobGuard.run(key, () => job.run(buildRunContext(tickId, t1)), {
      onSkip: () => log?.warn?.(`[noe-heartbeat] ${kind} 已在运行，跳过重复触发`),
    });
    if (guarded.skipped) return activeSkipOutcome(kind);
    return guarded.result;
  }

  function interruptRunningTicks(reason = 'heartbeat_interrupted') {
    let changed = 0;
    const t = now();
    for (const tickId of [...activeTickIds]) {
      interruptedTickIds.add(tickId);
      try {
        if (typeof store.interruptTick === 'function') changed += Number(store.interruptTick(tickId, reason, t) || 0);
      } catch { /* 停机打断失败不阻断后续落盘 */ }
    }
    return changed;
  }

  /** 单轮泵：恢复死 tick → 跑所有到期 kind → 推进游标。串行 await；单测可直接调用。 */
  async function pumpOnce() {
    const t0 = now();
    try { store.recoverDeadTicks(t0); } catch (e) { log?.warn?.(`[noe-heartbeat] recoverDeadTicks 失败：${e?.message || e}`); }
    // P0.5 emergency stop：owner 一键停时，本轮跳过所有自主 kind（保留基础设施维护 kind）。每轮读一次信号。
    const stop = (() => { try { return emergencyStop(); } catch { return { stopped: false, source: '', reason: '' }; } })();
    let due = [];
    try { due = store.dueCursors(t0); } catch (e) { log?.warn?.(`[noe-heartbeat] dueCursors 失败：${e?.message || e}`); return; }
    for (const cur of due) {
      const job = jobs.get(cur.kind);
      if (!job) continue; // 库里有游标但本进程没注册（开关半开/旧库）：不推进，留给注册方
      if (stop.stopped && emergencyStopShouldSkip(cur.kind, stop)) {
        log?.warn?.(`[noe-heartbeat] ⛔ emergency-stop(${stop.source}) 跳过自主作业 ${cur.kind}：${stop.reason}`);
        // 跳过时仍推游标：避免解除停机后 catchUp 把停机期间所有 missed tick 疯狂补跑。
        try { store.advanceCursor(cur.kind, now() + cur.cadence_ms, now()); } catch { /* 留痕失败不阻断 */ }
        continue;
      }
      const missed = Math.max(0, Math.floor((now() - cur.next_due) / cur.cadence_ms));
      let runs = 1;
      if (job.catchUp === 'all') runs = Math.min(missed + 1, Math.max(1, job.maxCatchUp ?? 2));
      else if (job.catchUp === 'drop' && missed > 0) { try { store.markCoalesced(cur.kind, missed, now()); } catch { /* 留痕失败不阻断 */ } }
      for (let i = 0; i < runs; i++) {
        const t1 = now();
        let tickId = 0;
        try { tickId = store.beginTick(cur.kind, t1, t1 + leaseMs, safeIntent(job)); }
        catch (e) { log?.warn?.(`[noe-heartbeat] beginTick(${cur.kind}) 失败：${e?.message || e}`); }
        trackTick(tickId);
        try {
          const out = await runGuardedJob(cur.kind, job, tickId, t1);
          finishTrackedTick(tickId, () => { try { store.finishTick(tickId, out ?? null, now()); } catch { /* 台账失败不阻断 */ } });
        } catch (e) {
          finishTrackedTick(tickId, () => { try { store.failTick(tickId, e?.message || String(e), now()); } catch { /* 同上 */ } });
        }
      }
      try { store.advanceCursor(cur.kind, now() + cur.cadence_ms, now()); } catch (e) { log?.warn?.(`[noe-heartbeat] advanceCursor(${cur.kind}) 失败：${e?.message || e}`); }
    }
  }

  function nextWakeDelay() {
    try {
      const cursors = store.allCursors().filter((c) => jobs.has(c.kind));
      if (!cursors.length) return maxWakeMs;
      const soonest = Math.min(...cursors.map((c) => c.next_due));
      return Math.max(minWakeMs, Math.min(maxWakeMs, soonest - now()));
    } catch { return maxWakeMs; }
  }

  async function pump() {
    if (!running || pumping) return;
    pumping = true;
    try { await pumpOnce(); } finally { pumping = false; }
    if (!running) return;
    timer = setTimer(pump, nextWakeDelay());
    timer?.unref?.();
  }

  return {
    register,
    pumpOnce,
    /** 启动：先量启动滞后（onRecovery 在播种前，量的是真实停机时长）→ 播种游标 → 进泵循环。 */
    start() {
      if (running) return;
      running = true;
      const t = now();
      let lag = 0;
      try { lag = store.bootLagMs(t); } catch { lag = 0; }
      for (const [kind, job] of jobs) {
        try { store.ensureCursor(kind, job.cadenceMs, t); } catch (e) { log?.warn?.(`[noe-heartbeat] ensureCursor(${kind}) 失败：${e?.message || e}`); }
      }
      if (lag > recoveryThresholdMs && typeof onRecovery === 'function') {
        try { onRecovery(lag); } catch { /* 恢复回调失败不阻断心跳 */ }
      }
      pump();
    },
    stop(options = {}) {
      const opts = typeof options === 'object' && options ? options : {};
      running = false;
      if (timer) { try { clearTimer(timer); } catch { /* noop */ } timer = null; }
      if (opts.interruptRunning) interruptRunningTicks(opts.reason || 'heartbeat_stopped');
    },
    /** 手动踩一拍（透视页按钮/实机验证用）：立即执行该 kind 一次，记台账（intent.manual），不动游标。 */
    async runNow(kind) {
      const job = jobs.get(String(kind));
      if (!job) return { ok: false, error: `未注册的作业：${kind}` };
      const t1 = now();
      let tickId = 0;
      try { tickId = store.beginTick(String(kind), t1, t1 + leaseMs, { manual: true }); } catch { /* 台账失败不阻断 */ }
      trackTick(tickId);
      try {
        const out = await runGuardedJob(String(kind), job, tickId, t1);
        finishTrackedTick(tickId, () => { try { store.finishTick(tickId, out ?? null, now()); } catch { /* 同上 */ } });
        if (out?.skipped) return { ok: true, tickId, skipped: true, reason: out.reason };
        return { ok: true, tickId };
      } catch (e) {
        finishTrackedTick(tickId, () => { try { store.failTick(tickId, e?.message || String(e), now()); } catch { /* 同上 */ } });
        return { ok: false, error: e?.message || String(e) };
      }
    },
    status() {
      let cursors = [];
      try { cursors = store.allCursors().filter((c) => jobs.has(c.kind)); } catch { cursors = []; }
      const activeJobKeys = typeof activeJobGuard?.activeKeys === 'function'
        ? activeJobGuard.activeKeys().filter((key) => key.startsWith('heartbeat:'))
        : [];
      return { running, kinds: [...jobs.keys()], cursors, activeJobKeys };
    },
  };
}
