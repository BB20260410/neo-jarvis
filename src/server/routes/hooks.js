// Hook 事件接收与查询 —— 从 server.js 抽出（D2）。
// 用户在 ~/.claude/settings.json 配 hooks 指向 POST /api/hooks/:event（详见 docs/HOOKS_USAGE.md）。
// POST 端点在 server.js 的 owner-token 豁免清单内（Claude binary 回调自己进程跑不了 token），
// 靠令牌桶限速防本机 spam；GET 查询需 owner-token。
// 内部状态（事件流/限速/常量）移入本模块；sessions / broadcastSession / safeSlice 由 server.js 注入。

import { requireOwnerToken } from '../auth/owner-token.js';
import { rateLimiters } from '../../safety/RateLimiter.js';

const VALID_HOOK_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'Notification', 'UserPromptSubmit',
  'SessionStart', 'SessionEnd', 'Stop', 'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact', 'SubagentResult',
]);
const HOOK_MAX_PER_SESSION = 200;
const HOOK_MAX_GLOBAL = 2000;
const HOOK_MAX_PAYLOAD_BYTES = 50 * 1024; // 单条 payload 上限 50KB（防 hooks 撑爆 data.json）
const globalHookEvents = []; // 跨 session 全局事件流（限长环形）

function trimHookPayload(body) {
  // 整体序列化估算大小；超限保留关键字段 + 截断标记
  let serialized;
  try { serialized = JSON.stringify(body); } catch { return { _error: 'circular' }; }
  if (serialized.length <= HOOK_MAX_PAYLOAD_BYTES) return body;
  const keep = {};
  for (const k of Object.keys(body || {})) {
    const v = body[k];
    if (v == null || typeof v === 'boolean' || typeof v === 'number') { keep[k] = v; continue; }
    if (typeof v === 'string') {
      keep[k] = v.length > 2000 ? v.slice(0, 2000) + '…<截断>' : v;
      continue;
    }
    try {
      const s = JSON.stringify(v);
      keep[k] = s.length > 4000 ? `<对象已截断 ${s.length}B>` : v;
    } catch { keep[k] = '<不可序列化>'; }
  }
  keep._truncated = true;
  keep._originalBytes = serialized.length;
  return keep;
}

export function registerHooksRoutes(app, { sessions, broadcastSession, safeSlice }) {
  // hooks 端点本机 spam 防御 —— 令牌桶限速（burst 500 / 600 events/min）；超限静默丢弃避免 Claude Code 端报错
  const _hookRateLimiter = rateLimiters.get('hooks-ingest', { perMinute: 600, burst: 500 });

  app.post('/api/hooks/:event', (req, res) => {
    const event = req.params.event;
    if (!VALID_HOOK_EVENTS.has(event)) return res.status(400).json({ error: 'unknown hook event: ' + event });
    if (!_hookRateLimiter.tryAcquire()) {
      return res.json({ ok: true, dropped: 'rate' });
    }
    const body = req.body || {};
    const sessionId = body.session_id || body.sessionId || null;
    const record = {
      at: new Date().toISOString(),
      event,
      sessionId: typeof sessionId === 'string' ? safeSlice(sessionId, 100) : null,
      tool: typeof (body.tool_name || body.tool) === 'string' ? safeSlice(body.tool_name || body.tool, 200) : null,
      cwd: typeof body.cwd === 'string' ? safeSlice(body.cwd, 1024) : null,
      payload: trimHookPayload(body),
    };
    // session 级
    if (sessionId) {
      const s = sessions.get(sessionId);
      if (s) {
        if (!Array.isArray(s.hookEvents)) s.hookEvents = [];
        s.hookEvents.push(record);
        if (s.hookEvents.length > HOOK_MAX_PER_SESSION) {
          s.hookEvents = s.hookEvents.slice(-HOOK_MAX_PER_SESSION);
        }
        broadcastSession(s, { type: 'hook_event', record });
      }
    }
    // 全局环形
    globalHookEvents.push(record);
    if (globalHookEvents.length > HOOK_MAX_GLOBAL) globalHookEvents.shift();
    res.json({ ok: true });
  });

  // 列最近 hook 事件（全局或按 session 过滤）
  app.get('/api/hooks', requireOwnerToken, (req, res) => {
    const sid = req.query.sessionId;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    let events = globalHookEvents;
    if (sid) {
      const s = sessions.get(sid);
      events = s?.hookEvents || [];
    }
    res.json({ ok: true, count: events.length, events: events.slice(-limit) });
  });
}
