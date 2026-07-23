import { appendEvent } from '../storage/SqliteStore.js';
import { BudgetLimitExceededError } from '../budget/BudgetPolicyStore.js';
import { finalizeTurn } from '../autopilot/NoeTurnFinalizer.js';

const DEFAULT_TICK_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30_000;

function nowMs() {
  return Date.now();
}

function safeString(value, max = 1000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

export class NoeLoop {
  constructor({
    tickMs = DEFAULT_TICK_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    projectId = 'default',
    memory = null,
    focus = null,
    budget = null,
    audit = null,
    broadcast = null,
    clusterBusy = () => false,
    tickHandler = null,
    actHandler = null,
    hangAlert = null,
    logger = console,
  } = {}) {
    this.tickMs = Math.max(1000, Math.trunc(Number(tickMs) || DEFAULT_TICK_MS));
    this.timeoutMs = Math.max(1000, Math.trunc(Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    this.projectId = safeString(projectId, 240) || 'default';
    this.memory = memory;
    this.focus = focus;
    this.budget = budget;
    this.audit = audit;
    this.broadcast = typeof broadcast === 'function' ? broadcast : null;
    this.clusterBusy = typeof clusterBusy === 'function' ? clusterBusy : () => false;
    this.tickHandler = typeof tickHandler === 'function' ? tickHandler : null;
    this.actHandler = typeof actHandler === 'function' ? actHandler : null;
    this.hangAlert = hangAlert; // NoeHangAlert（波次6 接线）：每 tick 巡检长跑任务心跳，超阈值「告警非杀」
    this.logger = logger;
    this.timer = null;
    this.running = false;
    this.enabled = false;
    this.actMode = false;
    this.state = 'stopped';
    this.pauseReason = null;
    this.tickCount = 0;
    this.lastTickAt = null;
    this.nextRunAt = null;
    this.lastError = null;
    this.errorCount = 0;
    this.abortController = null;
  }

  status() {
    return {
      state: this.state,
      enabled: this.enabled,
      actMode: this.actMode,
      running: this.running,
      tickCount: this.tickCount,
      lastTickAt: this.lastTickAt,
      nextRunAt: this.nextRunAt,
      lastError: this.lastError,
      errorCount: this.errorCount,
      pauseReason: this.pauseReason,
      tickMs: this.tickMs,
    };
  }

  start(options = {}) {
    if (Object.prototype.hasOwnProperty.call(options, 'actMode')) this.actMode = Boolean(options.actMode);
    this.enabled = true;
    this.pauseReason = null;
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.tick().catch((e) => this.logger?.warn?.('[noe-loop] tick failed:', e?.message || e));
      }, this.tickMs);
      this.timer.unref?.();
    }
    this.state = 'idle';
    this.nextRunAt = nowMs() + this.tickMs;
    this.#broadcast({ type: 'noe_loop_status', status: this.status() });
    return this.status();
  }

  stop({ reason = 'manual' } = {}) {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try { this.abortController?.abort?.(); } catch {}
    this.abortController = null;
    this.enabled = false;
    this.running = false;
    this.state = 'stopped';
    this.pauseReason = reason;
    this.nextRunAt = null;
    this.#broadcast({ type: 'noe_loop_status', status: this.status() });
    return this.status();
  }

  pause(reason = 'manual') {
    this.enabled = false;
    this.pauseReason = safeString(reason, 120) || 'manual';
    this.state = this.pauseReason === 'budget' ? 'paused_budget' : 'paused';
    this.nextRunAt = null;
    this.#broadcast({ type: 'noe_loop_status', status: this.status() });
    return this.status();
  }

  resume(options = {}) {
    return this.start(options);
  }

  async tick(options = {}) {
    if (this.running) return { ok: true, skipped: 'already_running', status: this.status() };
    if (!this.enabled && !options.force) return { ok: true, skipped: 'disabled', status: this.status() };

    this.running = true;
    this.state = 'ticking';
    const startedAt = nowMs();
    this.abortController = new AbortController();
    const timeoutMs = Math.max(1000, Math.trunc(Number(options.timeoutMs) || this.timeoutMs));
    let timeoutId;
    try {
      const result = await Promise.race([
        this.#runTick({ ...options, signal: this.abortController.signal, startedAt }),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            this.abortController?.abort?.();
            const err = new Error(`NoeLoop tick timeout after ${timeoutMs}ms`);
            err.name = 'AbortError';
            reject(err);
          }, timeoutMs);
        }),
      ]);
      this.errorCount = 0;
      this.lastError = null;
      if (!['paused', 'paused_budget', 'stopped'].includes(this.state)) {
        this.state = this.enabled ? 'idle' : 'stopped';
      }
      this.running = false;
      if (this.enabled) this.nextRunAt = nowMs() + this.tickMs;
      return { ...result, status: this.status() };
    } catch (e) {
      this.errorCount += 1;
      this.lastError = e?.message || String(e);
      this.state = this.enabled ? 'idle' : 'stopped';
      this.audit?.recordSafe?.({
        action: 'noe.loop.tick_error',
        actorType: 'system',
        entityType: 'noe_loop',
        entityId: this.projectId,
        severity: this.errorCount >= 3 ? 'error' : 'warn',
        status: 'failed',
        details: { error: this.lastError, errorCount: this.errorCount },
      });
      if (this.errorCount >= 3) {
        this.audit?.recordSafe?.({
          action: 'noe.loop.autostop',
          actorType: 'system',
          entityType: 'noe_loop',
          entityId: this.projectId,
          severity: 'error',
          status: 'stopped',
          details: { reason: 'consecutive_tick_errors', lastError: this.lastError },
        });
        this.stop({ reason: 'error' });
      }
      this.running = false;
      if (this.enabled) this.nextRunAt = nowMs() + this.tickMs;
      return { ok: false, error: this.lastError, status: this.status() };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      this.running = false;
      this.abortController = null;
      if (this.enabled) this.nextRunAt = nowMs() + this.tickMs;
    }
  }

  async #runTick({ signal, startedAt } = {}) {
    if (signal?.aborted) throw new Error('tick aborted before start');
    const focusItems = this.focus?.list ? this.focus.list({ projectId: this.projectId, limit: 10 }) : [];
    const memoryStats = this.memory?.stats ? this.memory.stats({ projectId: this.projectId }) : null;
    let acted = false;
    let skippedAct = null;
    if (this.actMode) {
      if (this.clusterBusy()) {
        skippedAct = 'cluster_busy';
      } else {
        try {
          this.budget?.preflight?.({
            projectId: this.projectId,
            adapterId: 'noe-loop',
            taskId: 'noe-loop',
            estimateCalls: 1,
            estimateUSD: 0,
            estimateTokens: 0,
          });
        } catch (e) {
          if (e instanceof BudgetLimitExceededError || e?.code === 'BUDGET_LIMIT_EXCEEDED') {
            // 死前交接（波次6 接线 NoeTurnFinalizer）：预算硬停前把当前焦点留痕成可接力交接，
            // 写进长期记忆（salience 4 防 GC），下个会话召回就能接着干，而不是从头摸。
            await this.#finalizeBudgetDeath({ focusItems, memoryStats, error: e });
            this.pause('budget');
            return { ok: true, skipped: 'budget', status: this.status() };
          }
          throw e;
        }
        if (this.actHandler) {
          await this.actHandler({ signal, loop: this, focusItems, memoryStats });
          acted = true;
        }
      }
    }
    if (this.tickHandler) {
      await this.tickHandler({ signal, loop: this, focusItems, memoryStats });
    }
    // 长跑任务心跳巡检（波次6 接线 NoeHangAlert）：超阈值告警「提醒人看一眼」，绝不自动杀（守不设超时铁律）
    if (this.hangAlert?.check) {
      try {
        for (const alert of this.hangAlert.check()) {
          if (!alert.firstAlert) continue;   // 只在首次告警广播，防刷屏
          this.#broadcast({ type: 'noe_hang_alert', alert });
          this.audit?.recordSafe?.({
            action: 'noe.loop.hang_alert', actorType: 'system', entityType: 'noe_act', entityId: String(alert.taskId),
            severity: 'warn', status: 'alerted',
            details: { silentMs: alert.silentMs, runningMs: alert.runningMs, meta: alert.meta },
          });
        }
      } catch { /* 巡检失败不阻断 tick */ }
    }
    this.tickCount += 1;
    this.lastTickAt = nowMs();
    const event = {
      kind: 'noe_loop_tick',
      ts: this.lastTickAt,
      tag: 'noe.loop.tick',
      entityType: 'noe_loop',
      entityId: this.projectId,
      projectId: this.projectId,
      tickCount: this.tickCount,
      durationMs: this.lastTickAt - startedAt,
      focusDepth: focusItems.length,
      memoryVisible: memoryStats?.visible ?? null,
      acted,
      skippedAct,
    };
    const eventId = appendEvent(event);
    this.#broadcast({ type: 'noe_loop_tick', eventId: Number(eventId), event });
    return { ok: true, eventId: Number(eventId), event, status: this.status() };
  }

  #broadcast(message) {
    try { this.broadcast?.(message); } catch {}
  }

  /** 预算硬停死前交接：当前焦点 → 确定性交接文本（不再烧 LLM）→ 写长期记忆 + 广播。失败静默不阻断 pause。 */
  async #finalizeBudgetDeath({ focusItems = [], memoryStats = null, error = null } = {}) {
    try {
      const msgs = focusItems.map((f) => ({ role: 'system', content: `[焦点] ${f.title || f.text || f.id || ''}` }));
      if (memoryStats) msgs.push({ role: 'system', content: `[记忆状态] 可见 ${memoryStats.visible ?? '?'} 条` });
      const fin = await finalizeTurn(msgs, { reason: 'budget_hard_stop', keepTail: 10 });
      const body = `${fin.summary}\n\n（触发：${error?.message || 'budget limit'}；NoeLoop 已暂停，恢复后从上述焦点接力。）`;
      this.memory?.write?.({
        projectId: this.projectId, scope: 'handoff', sourceType: 'turn_finalizer',
        title: 'NoeLoop 预算硬停死前交接', body, tags: ['handoff', 'budget', 'turn_finalizer'], salience: 4,
      });
      this.#broadcast({ type: 'noe_turn_finalized', reason: 'budget_hard_stop', summary: fin.summary });
      this.audit?.recordSafe?.({
        action: 'noe.loop.turn_finalized', actorType: 'system', entityType: 'noe_loop', entityId: this.projectId,
        severity: 'warn', status: 'finalized', details: { reason: 'budget_hard_stop', messageCount: fin.messageCount },
      });
    } catch (e) {
      this.logger?.warn?.('[noe-loop] 死前交接失败(不阻断暂停):', e?.message || e);
    }
  }
}
