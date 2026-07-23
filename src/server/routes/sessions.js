// @ts-check
// Noe — sessions 域核心 routes (S23)
// 从 server.js 提取 12 条路由（核心 CRUD+消息+删除 6 条、中断/强制释放 2 条、导出/收藏/fork 4 条），行为完全一致。
// sessions Map / sendMessageToClaude / broadcastSession / debouncedSave / saveData / checkSessionsCapacity
// 是 server.js 核心闭包（WS 层等多处共用）只能 deps 注入；watcherDispatcher 是 let 后期赋值，用 getWatcherDispatcher getter 注入。
// 分 3 个 register 函数：server.js 在各原位置分别调用，保持 Express 注册顺序与拆前逐条一致。
// ctx/snapshot/handoff/external/spawn-batch 7 条在 sessionsContinuum.js（同域分文件，守 <500 行规则）。

import { randomUUID } from 'crypto';
import { statSync } from 'fs';
import { requireOwnerToken } from '../auth/owner-token.js';

// v0.49 N-06: 字段长度限制（仅 sessions 创建/PATCH 使用，随迁）
const MAX_NAME_LEN = 200;
const MAX_GOAL_LEN = 4000;
const MAX_CWD_LEN = 1024;
// 发消息
// v0.49 N-16: 单条消息文本上限（防 spawn payload 失控）
const MAX_USER_MESSAGE_LEN = 2 * 1024 * 1024; // 2MB 文本，覆盖文件附入 + 长 prompt

// ① sessions 核心 CRUD + 消息 + 删除（server.js 原 1240-1436 位置调用）
export function registerSessionsCoreRoutes(app, deps) {
  const {
    sessions, checkSessionsCapacity, safeResolveFsPath, sendMessageToClaude,
    debouncedSave, saveData, watcherAdapterPool, getWatcherDispatcher,
    onSessionCreated = () => {}, onSessionDeleted = () => {}, onSessionArchivedChange = () => {},
  } = deps;

  // 创建 session（I-01/B-01 修：加 cwd 路径合法性校验；v0.49 N-06: 字段长度限制；v0.51 R-13: 全局上限）
  app.post('/api/sessions', requireOwnerToken, (req, res) => {
    try {
      if (!checkSessionsCapacity(res)) return;
      const { name, cwd, mainGoal } = req.body || {};
      if (typeof name === 'string' && name.length > MAX_NAME_LEN) {
        return res.status(400).json({ error: `name 过长（>${MAX_NAME_LEN}）` });
      }
      if (typeof mainGoal === 'string' && mainGoal.length > MAX_GOAL_LEN) {
        return res.status(400).json({ error: `mainGoal 过长（>${MAX_GOAL_LEN}）` });
      }
      if (typeof cwd === 'string' && cwd.length > MAX_CWD_LEN) {
        return res.status(400).json({ error: `cwd 过长（>${MAX_CWD_LEN}）` });
      }
      const rawCwd = cwd && typeof cwd === 'string' && cwd.trim() ? cwd.trim() : process.env.HOME;
      // Round 5 H#7 fix: cwd 走 safeResolveFsPath 沙箱（与 rooms 一致），拒绝敏感目录与越权路径
      const workingDir = safeResolveFsPath(rawCwd);
      if (!workingDir) {
        return res.status(403).json({ error: 'cwd 越权或敏感目录' });
      }
      // 必须存在且是目录
      try {
        const st = statSync(workingDir);
        if (!st.isDirectory()) {
          return res.status(400).json({ error: `cwd 不是目录：${workingDir}` });
        }
      } catch {
        return res.status(400).json({ error: `cwd 不存在：${workingDir}` });
      }

      const id = randomUUID();
      const session = {
        id,
        name: name?.trim() || `Session ${sessions.size + 1}`,
        cwd: workingDir,
        claudeSessionId: null,
        createdAt: new Date().toISOString(),
        child: null,
        pid: null,
        busy: false,
        messages: [],
        clients: new Set(),
        usage: { inputTokens: 0, outputTokens: 0 },  // I-05
        projectContextPrimed: false,
        projectContextSummary: null,
        // v0.5 思维镜融合
        mainGoal: (mainGoal && typeof mainGoal === 'string') ? mainGoal.trim() : null,
        runState: 'idle',
        guardLevel: 'standard',
        model: null,
      };
      sessions.set(id, session);
      onSessionCreated(session);
      debouncedSave();
      res.json({
        id, name: session.name, cwd: session.cwd,
        createdAt: session.createdAt, busy: false,
        messages: [], claudeSessionId: null,
        usage: session.usage,
        projectContextSummary: session.projectContextSummary,
      });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 列 sessions（query: ?archived=1 只列归档；不传则只列活跃）
  app.get('/api/sessions', requireOwnerToken, (req, res) => {
    try {
      const wantArchived = req.query.archived === '1' || req.query.archived === 'true';
      const list = [...sessions.values()]
        .filter(s => !!s.archived === wantArchived)
        .map(s => ({
          id: s.id, name: s.name, cwd: s.cwd,
          pid: s.pid, createdAt: s.createdAt, busy: s.busy,
          msgCount: s.messages.length,
          claudeSessionId: s.claudeSessionId,
          archived: !!s.archived,
          archivedAt: s.archivedAt,
          chainDepth: s.chainDepth || 0,
          // v0.5
          mainGoal: s.mainGoal,
          runState: s.runState || 'idle',
          model: s.model,
          totalUSD: s.costTracker ? s.costTracker.totalUSD() : 0,
          projectContextSummary: s.projectContextSummary || null,
          watcherEnabled: !!s.watcherEnabled,
          // v0.51 R-14: 列表也返收藏数量，前端 state.sessions 缓存可同步 ★
          starredCount: Array.isArray(s.starredIndices) ? s.starredIndices.length : 0,
        }));
      res.json(list);
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // PATCH session（目前支持 toggle archived）
  app.patch('/api/sessions/:id', requireOwnerToken, (req, res) => {
    try {
      const s = sessions.get(req.params.id);
      if (!s) return res.status(404).json({ error: 'not found' });
      if (typeof req.body?.archived === 'boolean') {
        const wasArchived = !!s.archived;
        s.archived = req.body.archived;
        s.archivedAt = req.body.archived ? new Date().toISOString() : null;
        onSessionArchivedChange(s, !!s.archived, wasArchived);
        // v0.51 T-37 fix: 归档时停掉运行中的 child（资源不浪费 + UI 状态一致）
        if (req.body.archived && s.child && !s.child.killed) {
          try { s.child.kill('SIGTERM'); } catch {}
          s.child = null;
          s.busy = false;
          s.pid = null;
        }
      }
      if (typeof req.body?.name === 'string' && req.body.name.trim()) {
        if (req.body.name.length > MAX_NAME_LEN) return res.status(400).json({ error: `name 过长（>${MAX_NAME_LEN}）` });
        s.name = req.body.name.trim();
      }
      if (typeof req.body?.mainGoal === 'string') {
        if (req.body.mainGoal.length > MAX_GOAL_LEN) return res.status(400).json({ error: `mainGoal 过长（>${MAX_GOAL_LEN}）` });
        s.mainGoal = req.body.mainGoal.trim() || null;
      }
      if (typeof req.body?.guardLevel === 'string' && ['strict', 'standard', 'loose'].includes(req.body.guardLevel)) {
        s.guardLevel = req.body.guardLevel;
      }
      // v0.34 Watcher per-session toggle
      if (typeof req.body?.watcherEnabled === 'boolean') {
        s.watcherEnabled = req.body.watcherEnabled;
      }
      // v0.40 Watcher per-session provider 选择
      if (typeof req.body?.watcherProviderId === 'string') {
        // v0.51 Z-01 fix: 校验 providerId 在 pool 中或为空（清除）
        const pid = req.body.watcherProviderId.trim();
        if (pid && !watcherAdapterPool.has(pid)) {
          return res.status(400).json({ error: `watcherProviderId 不在 pool 中：${pid}` });
        }
        s.watcherProviderId = pid || null;
      }
      // v0.36 真测 P1 fix: PATCH 立即 save（不 debounce 避免 kill 时丢数据）
      saveData();
      res.json({ ok: true, archived: !!s.archived, name: s.name, mainGoal: s.mainGoal, guardLevel: s.guardLevel, watcherEnabled: !!s.watcherEnabled, watcherProviderId: s.watcherProviderId || null });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 拿 session 详情（含历史）
  app.get('/api/sessions/:id', requireOwnerToken, (req, res) => {
    try {
      const s = sessions.get(req.params.id);
      if (!s) return res.status(404).json({ error: 'not found' });
      res.json({
        id: s.id, name: s.name, cwd: s.cwd, pid: s.pid,
        createdAt: s.createdAt, busy: s.busy,
        messages: s.messages,
        claudeSessionId: s.claudeSessionId,
        // v0.31 真测 P2.3 fix: 加全字段返回
        mainGoal: s.mainGoal || null,
        runState: s.runState || 'idle',
        guardLevel: s.guardLevel || 'standard',
        model: s.model || null,
        totalUSD: s.costTracker ? s.costTracker.totalUSD() : 0,
        chainDepth: s.chainDepth || 0,
        parentSessionId: s.parentSessionId || null,
        archived: !!s.archived,
        archivedAt: s.archivedAt || null,
        handoffPrimed: !!s.handoffPrimed,
        projectContextPrimed: !!s.projectContextPrimed,
        projectContextSummary: s.projectContextSummary || null,
        watcherEnabled: !!s.watcherEnabled,
        watcherProviderId: s.watcherProviderId || null,
        watcherHistory: (s.watcherHistory || []).slice(-20),
        // v0.51 R-14 fix: 返回收藏索引，前端 appendMessage 才能正确显示 ★ 状态
        starredIndices: Array.isArray(s.starredIndices) ? s.starredIndices : [],
      });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/sessions/:id/messages', requireOwnerToken, (req, res) => {
    try {
      const text = req.body?.text;
      if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'empty text' });
      if (text.length > MAX_USER_MESSAGE_LEN) {
        return res.status(413).json({ error: `text 过长（>${MAX_USER_MESSAGE_LEN} 字符）` });
      }
      const s = sessions.get(req.params.id);
      if (!s) return res.status(404).json({ error: 'not found' });
      // v0.51 T-46 fix: 归档 session 不允许发消息（避免 spawn child 浪费）
      if (s.archived) return res.status(409).json({ ok: false, error: 'archived', message: '会话已归档，先恢复（cmdk → 归档列表）再发消息' });
      const r = sendMessageToClaude(s, text.trim());
      // v0.31 真测 P2.2 fix: busy / loop_guard 不算 HTTP error，200 + ok=false 让前端能正常解析
      res.json(r);
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 关闭 session
  app.delete('/api/sessions/:id', requireOwnerToken, (req, res) => {
    try {
      const s = sessions.get(req.params.id);
      if (!s) return res.status(404).json({ error: 'not found' });
      if (s.child) {
        try { s.child.kill('SIGTERM'); } catch {}
      }
      // v0.49 N-20 fix: 关掉所有连到这个 session 的 WS，清 watcher sessionState
      for (const ws of s.clients) {
        try { ws.close(); } catch {}
      }
      s.clients.clear();
      const watcherDispatcher = getWatcherDispatcher();
      if (watcherDispatcher) {
        try { watcherDispatcher.resetSession(req.params.id); } catch {}
      }
      sessions.delete(req.params.id);
      onSessionDeleted(s);
      debouncedSave();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
}

// ② 中断 busy / 强制释放（server.js 原 1492-1540 位置调用——在 hooks/docs register 之后，保序）
export function registerSessionsControlRoutes(app, deps) {
  const { sessions, broadcastSession, getWatcherDispatcher } = deps;

  app.post('/api/sessions/:id/interrupt', requireOwnerToken, (req, res) => {
    try {
      const s = sessions.get(req.params.id);
      if (!s) return res.status(404).json({ error: 'not found' });
      // v0.38 P0-B: 标记此次退出是用户中断，exit handler 应跳过 watcher 判定
      s._lastInterrupted = true;
      // v0.51 A-02 fix: 中断后清 autoPromptCount，让用户重新触发 watcher autoMode 不被旧计数阻塞
      try { getWatcherDispatcher()?.clearAutoPromptCount?.(req.params.id); } catch {}
      // v0.49 B-03 fix: 丢弃残余 stdout 消息，避免 child 退出前继续广播 assistant
      s._dropOutput = true;
      if (!s.child || s.child.killed) {
        // child 已经死了，直接清状态并广播
        s.busy = false;
        s._dropOutput = false;
        broadcastSession(s, { type: 'busy', busy: false });
        return res.json({ ok: true, alreadyDead: true });
      }
      try { s.child.kill('SIGINT'); } catch {}
      // 1s 内不退就 SIGTERM 兜底
      setTimeout(() => {
        if (s.child && !s.child.killed) {
          try { s.child.kill('SIGTERM'); } catch {}
        }
      }, 1000);
      // 立即广播 busy=false 让前端解锁 UI；stdout 残余 message 由 _dropOutput 拦截不会再推送
      s.busy = false;
      broadcastSession(s, { type: 'busy', busy: false, interrupted: true });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // v0.20 强制释放卡住的 busy 状态（child 已死但 busy 没复位的兜底）
  app.post('/api/sessions/:id/reset-busy', requireOwnerToken, (req, res) => {
    try {
      const s = sessions.get(req.params.id);
      if (!s) return res.status(404).json({ error: 'not found' });
      const wasChildAlive = s.child && !s.child.killed;
      // v0.38 P0-B: 强制释放也算用户干预，exit handler 跳 watcher
      s._lastInterrupted = true;
      // v0.51 A-02 fix: 同 interrupt — 清 autoPromptCount
      try { getWatcherDispatcher()?.clearAutoPromptCount?.(req.params.id); } catch {}
      // v0.51 S-26 fix: 一并清 _dropOutput，避免下次发消息前 stdout 被错误 drop
      s._dropOutput = false;
      if (s.child) {
        try { s.child.kill('SIGKILL'); } catch {}
        s.child = null;
      }
      s.busy = false;
      s.pid = null;
      broadcastSession(s, { type: 'busy', busy: false, forced: true });
      res.json({ ok: true, hadChild: wasChildAlive });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
}

// ③ 导出 / 收藏 / fork（server.js 原 4010-4107 位置调用）
export function registerSessionsExtrasRoutes(app, deps) {
  const { sessions, checkSessionsCapacity, debouncedSave, onSessionCreated = () => {} } = deps;

  // ============ v0.50 导出 session 为 markdown（F2）============
  app.get('/api/sessions/:id/export', requireOwnerToken, (req, res) => {
    try {
      const s = sessions.get(req.params.id);
      if (!s) return res.status(404).json({ error: 'not found' });
      const lines = [];
      lines.push(`# ${s.name}`, '');
      lines.push(`- **cwd**: \`${s.cwd}\``);
      lines.push(`- **created**: ${s.createdAt}`);
      if (s.mainGoal) lines.push(`- **goal**: ${s.mainGoal}`);
      if (s.model) lines.push(`- **model**: ${s.model}`);
      lines.push(`- **messages**: ${s.messages.length}`);
      if (s.costTracker) lines.push(`- **total USD**: $${s.costTracker.totalUSD().toFixed(4)}`);
      lines.push('', '---', '');
      for (const m of s.messages) {
        const roleLabel = m.role === 'user' ? '👤 User' :
                          m.role === 'assistant' ? '🤖 Assistant' :
                          m.role === 'tool_use' ? '🔧 Tool' :
                          m.role === 'system' ? '⚙️ System' : m.role;
        const time = m.ts ? ` _(${new Date(m.ts).toLocaleString('zh-CN')})_` : '';
        lines.push(`## ${roleLabel}${time}`, '', String(m.content || ''), '');
      }
      const safeName = (s.name || 'session').replace(/[\\/<>:"|?*\x00-\x1f]/g, '_').slice(0, 80);
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      // v0.51 S-19 fix: RFC 5987 编码，让浏览器正确显示中文文件名（而非 URL 编码字串）
      const asciiFallback = safeName.replace(/[^\x20-\x7e]/g, '_');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asciiFallback}.md"; filename*=UTF-8''${encodeURIComponent(safeName)}.md`
      );
      res.send(lines.join('\n'));
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ============ v0.50 收藏消息（F5）============
  app.post('/api/sessions/:id/star', requireOwnerToken, (req, res) => {
    try {
      const s = sessions.get(req.params.id);
      if (!s) return res.status(404).json({ error: 'not found' });
      const idx = parseInt(req.body?.msgIndex, 10);
      if (!Number.isInteger(idx) || idx < 0 || idx >= (s.messages || []).length) {
        return res.status(400).json({ error: 'invalid msgIndex' });
      }
      if (!Array.isArray(s.starredIndices)) s.starredIndices = [];
      const pos = s.starredIndices.indexOf(idx);
      if (pos >= 0) s.starredIndices.splice(pos, 1);
      else s.starredIndices.push(idx);
      s.starredIndices.sort((a, b) => a - b);
      debouncedSave();
      res.json({ ok: true, starredIndices: s.starredIndices });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.get('/api/sessions/:id/stars', requireOwnerToken, (req, res) => {
    try {
      const s = sessions.get(req.params.id);
      if (!s) return res.status(404).json({ error: 'not found' });
      const starred = (s.starredIndices || []).map(i => ({
        msgIndex: i,
        message: s.messages[i] || null,
      })).filter(x => x.message);
      res.json({ ok: true, count: starred.length, starred });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ============ v0.50 Session forking（F7）============
  app.post('/api/sessions/:id/fork', requireOwnerToken, (req, res) => {
    try {
      // v0.51 R-13: fork 也走 sessions 上限检查
      if (!checkSessionsCapacity(res)) return;
      const s = sessions.get(req.params.id);
      if (!s) return res.status(404).json({ error: 'not found' });
      const fromIndex = parseInt(req.body?.fromIndex, 10);
      if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= (s.messages || []).length) {
        return res.status(400).json({ error: 'invalid fromIndex' });
      }
      // 复制 [0..fromIndex] 消息（含目标消息）
      const copiedMessages = s.messages.slice(0, fromIndex + 1).map(m => ({ ...m }));
      const newId = randomUUID();
      const newSession = {
        id: newId,
        name: `${s.name} (fork @${fromIndex})`,
        cwd: s.cwd,
        claudeSessionId: null, // 新 session 走 fresh claude（不继承原 claude session）
        createdAt: new Date().toISOString(),
        child: null, pid: null, busy: false,
        messages: copiedMessages,
        clients: new Set(),
        handoffPrimed: false,
        projectContextPrimed: false,
        projectContextSummary: null,
        parentSessionId: s.id,
        chainDepth: (s.chainDepth || 0) + 1,
        archived: false,
        mainGoal: s.mainGoal || null,
        runState: 'idle',
        guardLevel: s.guardLevel || 'standard',
        model: s.model || null,
        starredIndices: (s.starredIndices || []).filter(i => i <= fromIndex),
      };
      sessions.set(newId, newSession);
      onSessionCreated(newSession);
      debouncedSave();
      res.json({ ok: true, newSessionId: newId, copiedCount: copiedMessages.length });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
}
