// RoomAdapter — 聊天室成员抽象基类
// 子类实现 _doChat(messages, opts)；外部调 chat() 自动套 CircuitBreaker + Bulkhead + RateLimiter
// messages: [{ role:'system'|'user'|'assistant', content, speaker? }]
// 注意：每个 adapter 自己负责把 messages 数组拍平成各自 CLI/API 能吃的格式
//
// v0.56 Sprint 15：chat() 是个壳，调用 _doChat 时套 3 个 resilience pattern

import { breakers } from '../safety/CircuitBreaker.js';
import { bulkheads } from '../safety/Bulkhead.js';
import { rateLimiters } from '../safety/RateLimiter.js';
import { budgetPolicyStore } from '../budget/BudgetPolicyStore.js';
import { agentRunLifecycle as defaultAgentRunLifecycle } from '../agents/AgentRunLifecycle.js';

function safeCapabilityText(value, max = 300) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeCapabilityList(values, limit = 12) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = safeCapabilityText(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

export function normalizeNativeCapabilities(input = {}) {
  const capability = input && typeof input === 'object' ? input : {};
  return {
    providerId: safeCapabilityText(capability.providerId || capability.adapterId, 80),
    displayName: safeCapabilityText(capability.displayName, 120),
    runtime: safeCapabilityText(capability.runtime, 160),
    nativeRuntime: capability.nativeRuntime === true,
    accountScoped: capability.accountScoped !== false,
    userConfigured: capability.userConfigured !== false,
    toolUse: capability.toolUse !== false,
    skills: safeCapabilityList(capability.skills),
    plugins: safeCapabilityList(capability.plugins),
    tools: safeCapabilityList(capability.tools),
    mcp: safeCapabilityList(capability.mcp),
    bridges: safeCapabilityList(capability.bridges),
    requestProtocol: safeCapabilityText(capability.requestProtocol, 2000),
    notes: safeCapabilityList(capability.notes, 8),
  };
}

export function formatNativeCapabilitiesForPrompt(capabilityInput = null) {
  if (!capabilityInput) return '';
  const capability = normalizeNativeCapabilities(capabilityInput);
  const label = capability.displayName || capability.providerId || '当前成员';
  const rows = [
    `# 成员原生能力边界: ${label}`,
    '',
    `- 运行时: ${capability.runtime || '未声明'}`,
    `- 原生运行时: ${capability.nativeRuntime ? '是' : '否'}`,
    `- 账号/本机配置: ${capability.accountScoped ? '使用该 adapter 自己的账号与本机配置' : '不声明账号级配置'}`,
    `- 工具调用: ${capability.toolUse ? '可使用该 adapter 原生暴露的工具/插件/技能' : '仅普通文本 chat'}`,
  ];
  const listLine = (title, values) => {
    if (!values.length) return;
    rows.push(`- ${title}: ${values.join('；')}`);
  };
  listLine('原生 Skill/能力', capability.skills);
  listLine('原生插件/扩展', capability.plugins);
  listLine('原生工具', capability.tools);
  listLine('MCP/外部工具桥', capability.mcp);
  listLine('桥接能力', capability.bridges);
  listLine('说明', capability.notes);
  if (capability.requestProtocol) {
    rows.push('');
    rows.push('## 插件桥接请求协议');
    rows.push(capability.requestProtocol);
  }
  rows.push('');
  rows.push('执行规则: 你应该优先发挥自己运行时原本具备的工具、插件、Skill、MCP 和账号能力；面板 room.skills 只是额外补充提示,不是把所有成员压成同一套公共技能。不要声称使用了某个工具,除非你的运行时实际执行过；如果原生工具不可用,明确说明阻断原因。');
  return rows.join('\n');
}

export class RoomAdapter {
  constructor({ id, displayName, model, timeout = 0 } = {}) {
    this.id = id;                   // 'claude' | 'codex' | 'minimax' | 'ollama'
    this.displayName = displayName; // '🟣 Claude' / '🟢 GPT' / '🟡 MiniMax' / '🔵 Ollama'
    this.model = model;
    this.timeout = timeout;
  }

  get providerName() { return this.id; }

  getNativeCapabilities() {
    return normalizeNativeCapabilities({
      providerId: this.id,
      displayName: this.displayName,
      runtime: 'generic chat adapter',
      nativeRuntime: false,
      accountScoped: false,
      userConfigured: false,
      toolUse: false,
      notes: ['该 adapter 未声明原生工具/插件能力,只能按普通 chat 能力处理。'],
    });
  }

  /**
   * 公开入口：套 CircuitBreaker（快速失败）+ Bulkhead（并发限制）+ RateLimiter（限速）
   * 子类不要 override 这个；override _doChat
   * v0.56：opts.skipResilience = true 时跳过（report 等内部任务可用）
   *
   * Agent-run anti-zombie (2026-07-23):
   * - startRun may leave status=running if breaker/rate-limit/bulkhead throw before _doChat
   * - every exit path must settle via ensureSettled; finally is the hard safety net
   */
  async chat(messages, opts = {}) {
    const lifecycle = opts.agentRunLifecycle === false
      ? null
      : (opts.agentRunLifecycle || defaultAgentRunLifecycle);
    let agentRun = null;
    let settled = false;
    /** @type {null | (() => void)} */
    let release = null;

    const settleOk = (result) => {
      if (!agentRun?.id || !lifecycle || settled) return;
      try {
        if (typeof lifecycle.ensureSettled === 'function') {
          lifecycle.ensureSettled(agentRun.id, { outcome: 'succeeded', result });
        } else {
          lifecycle.finishRun?.(agentRun.id, result);
        }
        settled = true;
      } catch { /* leave unsettled → finally safety net */ }
    };
    const settleFail = (error, outcome = 'failed') => {
      if (!agentRun?.id || !lifecycle || settled) return;
      try {
        if (typeof lifecycle.ensureSettled === 'function') {
          lifecycle.ensureSettled(agentRun.id, {
            outcome,
            error,
            reason: error?.message || String(error || outcome),
          });
        } else if (outcome === 'cancelled') {
          lifecycle.cancelRun?.(agentRun.id, error);
        } else {
          lifecycle.failRun?.(agentRun.id, error);
        }
        settled = true;
      } catch { /* leave unsettled → finally safety net */ }
    };
    const settleDefer = (reason, payload = {}) => {
      if (!agentRun?.id || !lifecycle || settled) return;
      try {
        if (typeof lifecycle.ensureSettled === 'function') {
          lifecycle.ensureSettled(agentRun.id, { outcome: 'deferred', reason, payload });
        } else {
          lifecycle.deferRun?.(agentRun.id, reason, payload);
        }
        settled = true;
      } catch { /* leave unsettled → finally safety net */ }
    };

    try {
      agentRun = lifecycle?.startRun?.({ adapter: this, messages, opts }) || null;
    } catch (e) {
      console.warn?.('[agent-runs] start failed:', e?.message || e);
    }

    try {
      if (!opts.skipBudget) {
        try {
          budgetPolicyStore.preflight({
            adapterId: this.id,
            projectId: opts.budgetContext?.projectId || opts.cwd || null,
            roomId: opts.budgetContext?.roomId || null,
            sessionId: opts.budgetContext?.sessionId || null,
            taskId: opts.budgetContext?.taskId || null,
            agentProfileId: opts.budgetContext?.agentProfileId || null,
            agentRunId: opts.agentRunId || agentRun?.id || null,
            estimateTokens: this._countTokens(messages),
            estimateCalls: 1,
          });
        } catch (e) {
          if (agentRun?.id) {
            const blocked = Array.isArray(e.blocked) ? e.blocked : [];
            const incidents = blocked.map((item) => item?.incident).filter(Boolean);
            settleDefer('budget_blocked', {
              error: e?.message || String(e),
              budgetIncidentId: incidents[0]?.id || null,
              budgetIncidentIds: incidents.map((incident) => incident.id).filter(Boolean),
              relatedActivityIds: incidents.map((incident) => incident.activityId).filter(Boolean),
            });
            e.agentRunId = agentRun.id;
          }
          throw e;
        }
      }

      if (opts.skipResilience) {
        const result = await this._doChat(messages, opts);
        settleOk(result);
        if (result && typeof result === 'object' && agentRun?.id) result.agentRunId = agentRun.id;
        return result;
      }

      const breaker = breakers.get(this.id);
      const bulkhead = bulkheads.get(this.id);
      const rl = rateLimiters.get(this.id);

      // 1) CircuitBreaker pre-check（OPEN 时直接抛）— must not leave agent_run running
      try {
        breaker.beforeCall();
      } catch (e) {
        settleFail(e, 'failed');
        if (agentRun?.id) e.agentRunId = agentRun.id;
        throw e;
      }
      // 2) RateLimiter 排队等 token
      try {
        await rl.acquire(30_000);
      } catch (e) {
        breaker.onFailure(e);
        settleFail(e, 'failed');
        if (agentRun?.id) e.agentRunId = agentRun.id;
        throw e;
      }
      // 3) Bulkhead 占并发槽
      try {
        release = await bulkhead.acquire();
      } catch (e) {
        breaker.onFailure(e);
        settleFail(e, 'failed');
        if (agentRun?.id) e.agentRunId = agentRun.id;
        throw e;
      }

      try {
        const result = await this._doChat(messages, opts);
        settleOk(result);
        if (result && typeof result === 'object' && agentRun?.id) result.agentRunId = agentRun.id;
        breaker.onSuccess();
        return result;
      } catch (e) {
        // 2026-05：用户/协调器主动 abort 不算 adapter 失败——
        //   否则 debate 整轮被 Gemini 配额拖挂时，连带把 claude/codex 的"被中断"也计入
        //   断路器 failure，几轮后 5 次累计 → claude/codex 整体 OPEN 30s，用户看不懂
        const aborted = opts.abortSignal?.aborted
          || e?.name === 'AbortError'
          || /被中断|aborted|cancelled|canceled/i.test(e?.message || '');
        const providerInputRejected = e?.code === 'PROVIDER_INPUT_REJECTED';
        // 内层熔断器（NoeModelCircuitBreaker，flag NOE_MODEL_CIRCUIT_BREAKER）短路抛 MODEL_CIRCUIT_OPEN：
        //   它本身就是"已熔断/快速失败"信号，不应再被基类 breaker 计为一次新失败（否则两层熔断同一 adapter
        //   互相污染：基类 breaker 被内层短路推向 OPEN，再用 beforeCall 挡掉内层半开探针，恢复变慢）。
        //   豁免它，与 abort / PROVIDER_INPUT_REJECTED 同理。flag OFF 时不会出现此 code，零回归。
        const circuitOpen = e?.code === 'MODEL_CIRCUIT_OPEN';
        if (!aborted && !providerInputRejected && !circuitOpen) breaker.onFailure(e);
        settleFail(e, aborted ? 'cancelled' : 'failed');
        if (agentRun?.id) e.agentRunId = agentRun.id;
        throw e;
      }
    } finally {
      // Hard safety net: never leave adapter_chat rows stuck in running (zombie anti-pattern).
      if (agentRun?.id && !settled && lifecycle) {
        try {
          lifecycle.ensureSettled?.(agentRun.id, {
            outcome: 'failed',
            reason: 'unterminated_run_settled_in_finally',
            error: new Error('unterminated_run_settled_in_finally'),
          });
        } catch { /* ignore */ }
        settled = true;
      }
      try { if (typeof release === 'function') release(); } catch { /* ignore */ }
    }
  }

  /** 子类实现这个；不要 override chat() */
  async _doChat(messages, _opts = {}) {
    throw new Error('RoomAdapter._doChat() must be implemented by subclass');
  }

  /** 拍平 messages 成单 prompt 字符串（spawn CLI 用） */
  flattenMessages(messages) {
    return messages.map(m => {
      const speaker = m.speaker || (m.role === 'user' ? '👤 用户' : m.role === 'system' ? '⚙️ 系统' : '🤖 ' + (m.role || 'assistant'));
      return `${speaker}:\n${m.content}`;
    }).join('\n\n---\n\n');
  }

  // ─── v0.9.x B-002：8 adapter 共用方法（学自 W3 LibreChat BaseClient）─────

  /** 估算单条 messages 数组的 token 数（粗算，中英分开）
   * 学自 W3 historyTrimmer.estimateTokens */
  _countTokens(messages) {
    if (!Array.isArray(messages)) return 0;
    let total = 0;
    for (const m of messages) {
      const text = String(m?.content || '');
      const cjk = (text.match(/[一-鿿぀-ゟ゠-ヿ]/g) || []).length;
      const nonCjk = text.length - cjk;
      total += cjk + Math.ceil(nonCjk / 4);
    }
    return total;
  }

  /** 从 messages 末尾反向裁剪到 maxTokens 内（保留 system + 最新 user）
   * 学自 W3 LibreChat getMessagesWithinTokenLimit */
  _truncateMessages(messages, maxTokens = 100000) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;
    // 永远保留 system
    const systems = messages.filter(m => m.role === 'system');
    const others = messages.filter(m => m.role !== 'system');
    const systemTokens = this._countTokens(systems);
    let budget = maxTokens - systemTokens - 4096;  // 留 4K 给响应
    if (budget <= 0) return systems;
    const kept = [];
    for (let i = others.length - 1; i >= 0; i--) {
      const t = this._countTokens([others[i]]);
      if (budget - t <= 0) break;
      kept.unshift(others[i]);
      budget -= t;
    }
    return [...systems, ...kept];
  }

  /** 把 stream chunk 累积成完整 reply（用于 SSE / spawn streaming 收尾）
   * 子类 _doChat 内部可调用 */
  _accumulateStream(chunks) {
    if (!Array.isArray(chunks)) return String(chunks || '');
    return chunks.map(c => typeof c === 'string' ? c : (c?.text || c?.content || '')).join('');
  }

  /** 用户消息加文件附件上下文（学自 W3 LibreChat buildFileContext）
   * panel 当前主要是 topic 内嵌 [附件:xxx]，此方法是 future-ready */
  _buildFileContext(message, attachments = []) {
    if (!attachments.length) return message;
    const ctx = attachments.map(a =>
      `\n\n--- 📎 ${a.name || 'file'}${a.size ? ` (${(a.size / 1024).toFixed(1)}KB)` : ''} ---\n${a.content || ''}\n--- /附件 ---`
    ).join('');
    if (typeof message === 'string') return message + ctx;
    if (message?.content) return { ...message, content: message.content + ctx };
    return message;
  }
}
