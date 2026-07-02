// @ts-check
// Noe — sessions 域 ctx 估算 + 07 Continuum 接力 + 外部 Terminal routes (S23)
// 从 server.js 提取 7 条路由（ctx/snapshot/handoff-history/handoff-meta/handoff/external/spawn-batch），行为完全一致。
// 随迁 helper：CONTINUUM_STATE_ROOT/cwdHash/continuumDir（原 server.js 224-232，使用点全在本文件 5 路由内）、
// findTranscript/maxTokensForModel/_ctxCache/estimateCtx 家族（仅 ctx 路由用）、
// buildClaudeTerminalScript（external 与 spawn-batch 共享）。
// sessions Map / checkSessionsCapacity / debouncedSave / send500 是 server.js 闭包，deps 注入。
// spawn-batch 单独成 register 函数：原注册顺序里 POST /api/login-claude（ops 域，留 server.js）夹在 external 与
// spawn-batch 之间，分两个调用点才能保持 Express 注册顺序与拆前逐条一致。

import { spawn } from 'child_process';
import { randomUUID, createHash } from 'crypto';
import { join } from 'path';
import { homedir } from 'os';
import {
  statSync, existsSync, readFileSync, readdirSync, mkdirSync,
  copyFileSync, writeFileSync, renameSync, appendFileSync, realpathSync,
} from 'fs';
import { requireOwnerToken } from '../auth/owner-token.js';
import { markHandoffSummaryAsReference } from '../../autopilot/NoeTurnFinalizer.js';

// 07 Continuum 状态目录：每个 cwd 对应 md5(cwd) 前 12 位的子目录
const CONTINUUM_STATE_ROOT = join(homedir(), '.claude', 'state');
function cwdHash(cwd) {
  let real = cwd;
  try { real = realpathSync(cwd); } catch {}
  return createHash('md5').update(real).digest('hex').slice(0, 12);
}
function continuumDir(cwd) {
  return join(CONTINUUM_STATE_ROOT, cwdHash(cwd));
}

// ============ ctx 估算：从 claude transcript 反推当前上下文占用率 ============

// 找到 session 对应的 transcript jsonl（session_id.jsonl 在 ~/.claude/projects/<flat>/）
function findTranscript(sessionId) {
  if (!sessionId) return null;
  const projectsRoot = join(homedir(), '.claude', 'projects');
  if (!existsSync(projectsRoot)) return null;
  try {
    const dirs = readdirSync(projectsRoot).filter(d => {
      try { return statSync(join(projectsRoot, d)).isDirectory(); } catch { return false; }
    });
    for (const d of dirs) {
      const p = join(projectsRoot, d, `${sessionId}.jsonl`);
      if (existsSync(p)) return p;
    }
  } catch {}
  return null;
}

// 根据 model 判定 max ctx tokens
function maxTokensForModel(model) {
  if (!model) return 200000;
  if (model.includes('opus')) return 1000000;        // opus 4.7 long context
  if (model.includes('sonnet-4')) return 1000000;    // sonnet 4.x 1M beta
  if (model.includes('haiku')) return 200000;        // haiku 默认 200k
  return 200000;
}

// transcript 未变（mtime 不变）则跳过全量 read+parse，直接返回上次结果
const _ctxCache = new Map(); // transcriptPath -> { mtimeMs, result }
// 解析 transcript 最后一条 assistant.usage 估算 ctx
function estimateCtx(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return { ok: false, reason: 'no-transcript' };
  }
  let _mtimeMs = 0;
  try { _mtimeMs = statSync(transcriptPath).mtimeMs; } catch {}
  const _cached = _ctxCache.get(transcriptPath);
  if (_cached && _mtimeMs && _cached.mtimeMs === _mtimeMs) return _cached.result;
  try {
    const content = readFileSync(transcriptPath, 'utf-8');
    const lines = content.split('\n');
    let lastUsage = null;
    let lastModel = null;
    let assistantCount = 0;
    // 反向找最后一条 assistant.usage（跳过 <synthetic> 这种内部桩）
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'assistant' && obj.message?.usage) {
          const m = obj.message.model || '';
          if (m.startsWith('<')) continue; // skip synthetic
          if (!lastUsage) {
            lastUsage = obj.message.usage;
            lastModel = m;
          }
          assistantCount++;
        }
      } catch {}
    }
    if (!lastUsage) return { ok: false, reason: 'no-usage' };
    const inputTokens = lastUsage.input_tokens || 0;
    const cacheRead = lastUsage.cache_read_input_tokens || 0;
    const cacheCreation = lastUsage.cache_creation_input_tokens || 0;
    const output = lastUsage.output_tokens || 0;
    // ctx = 这次 turn claude 看到的总输入（近似上下文已填充量）
    const ctxTotal = inputTokens + cacheRead + cacheCreation;
    const maxTokens = maxTokensForModel(lastModel);
    const pct = Math.min(100, (ctxTotal / maxTokens) * 100);
    const result = {
      ok: true,
      model: lastModel,
      inputTokens, cacheRead, cacheCreation, output,
      ctxTotal,
      maxTokens,
      pct: Math.round(pct * 10) / 10,
      assistantTurns: assistantCount,
    };
    if (_mtimeMs) _ctxCache.set(transcriptPath, { mtimeMs: _mtimeMs, result });
    return result;
  } catch (e) {
    return { ok: false, reason: 'parse-fail', error: e.message };
  }
}

// 在外部 Terminal 启动 claude（真·独立 GUI 窗口）
// v0.49 N-05 fix: AppleScript do script 注入加固——用 quoted form 构造 shell 命令避免双引号破外层字符串
function buildClaudeTerminalScript(cwd, resumeId) {
  // shell 单引号闭合转义
  const cwdSh = cwd.replace(/'/g, "'\\''");
  const resumeStr = resumeId && /^[A-Za-z0-9_\-]{1,64}$/.test(String(resumeId))
    ? ` --resume ${resumeId}` : '';
  const shellCmd = `cd '${cwdSh}' && claude --dangerously-skip-permissions${resumeStr}`;
  // AppleScript 字符串转义：反斜杠先于双引号
  const asEsc = shellCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `tell application "Terminal"\n    activate\n    do script "${asEsc}"\nend tell`;
}

// ① ctx + Continuum snapshot/handoff 三件 + external（server.js 原 3474-3810 位置调用）
export function registerSessionsContinuumRoutes(app, deps) {
  const { sessions, checkSessionsCapacity, debouncedSave, send500, onSessionCreated = () => {} } = deps;

  // 端点：返回该 session 的 ctx 估算
  app.get('/api/sessions/:id/ctx', requireOwnerToken, (req, res) => {
    try {
      const s = sessions.get(req.params.id);
      if (!s) return res.status(404).json({ error: 'not found' });
      if (!s.claudeSessionId) {
        return res.json({ ok: false, reason: 'no-session-yet', pct: 0 });
      }
      const tp = findTranscript(s.claudeSessionId);
      const result = estimateCtx(tp);
      result.transcriptPath = tp;
      res.json(result);
    } catch (e) { send500(res, e); }
  });

  // ============ 07 Continuum 集成：snapshot / meta / handoff ============

  // 读该 session cwd 对应的事实快照
  app.get('/api/sessions/:id/snapshot', requireOwnerToken, (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    const dir = continuumDir(s.cwd);
    const snapPath = join(dir, 'snapshot.md');
    if (!existsSync(snapPath)) {
      return res.json({
        ok: false,
        reason: 'no-snapshot',
        hint: '07 Continuum hook 还没生成 snapshot。装 hook：cd ~/Desktop/00_项目/07_Continuum_会话接力工具 && ./install.sh',
        cwd: s.cwd,
        cwdHash: cwdHash(s.cwd),
      });
    }
    try {
      const content = readFileSync(snapPath, 'utf-8');
      const stat = statSync(snapPath);
      res.json({
        ok: true,
        cwd: s.cwd,
        cwdHash: cwdHash(s.cwd),
        bytes: stat.size,
        mtime: stat.mtime,
        content,
      });
    } catch (e) {
      send500(res, e);
    }
  });

  // 读 chain history 归档列表（用 ?file=<name> 取具体某次归档全文）
  app.get('/api/sessions/:id/handoff-history', requireOwnerToken, (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    const histDir = join(continuumDir(s.cwd), 'history');
    if (!existsSync(histDir)) return res.json({ ok: true, items: [], cwd: s.cwd });
    const fileQuery = req.query.file;
    if (fileQuery) {
      // 取具体一次归档的全文（防越权：只允许 snapshot_*.md 文件名）
      if (!/^snapshot_[\w_.-]+\.md$/.test(fileQuery)) return res.status(400).json({ error: 'bad filename' });
      const p = join(histDir, fileQuery);
      if (!existsSync(p)) return res.status(404).json({ error: 'archive not found' });
      try {
        const content = readFileSync(p, 'utf-8');
        const stat = statSync(p);
        return res.json({ ok: true, file: fileQuery, bytes: stat.size, mtime: stat.mtime, content });
      } catch (e) { return send500(res, e); }
    }
    // 默认：列表
    try {
      const items = readdirSync(histDir)
        .filter(n => n.endsWith('.md'))
        .map(name => {
          try {
            const st = statSync(join(histDir, name));
            // 从文件名抓 trigger（_PANEL.md / _MANUAL.md / _AUTO.md / 无后缀）
            let trigger = 'auto';
            if (name.includes('_PANEL.md')) trigger = 'panel';
            else if (name.includes('_MANUAL.md')) trigger = 'manual';
            return { name, bytes: st.size, mtime: st.mtime, trigger };
          } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime);
      res.json({ ok: true, cwd: s.cwd, count: items.length, items });
    } catch (e) {
      send500(res, e);
    }
  });

  // 读 meta（chain_depth / handoff_count / project_mode / origin）
  app.get('/api/sessions/:id/handoff-meta', requireOwnerToken, (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    const metaPath = join(continuumDir(s.cwd), 'meta.json');
    if (!existsSync(metaPath)) {
      return res.json({ ok: false, reason: 'no-meta', cwd: s.cwd });
    }
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      res.json({ ok: true, cwd: s.cwd, meta });
    } catch (e) {
      send500(res, e);
    }
  });

  // 触发逻辑接力：归档当前 snapshot + 在 panel 内新建同 cwd 的 session
  // 新 session 第一条消息预置 HANDOFF 内容，让新 claude 自动接手
  app.post('/api/sessions/:id/handoff', requireOwnerToken, (req, res) => {
    try {
      // v0.51 T-23 fix: handoff 也创建新 session，需走 capacity check
      if (!checkSessionsCapacity(res)) return;
      const s = sessions.get(req.params.id);
      if (!s) return res.status(404).json({ error: 'not found' });

      const dir = continuumDir(s.cwd);
      const snapPath = join(dir, 'snapshot.md');
      if (!existsSync(snapPath)) {
        return res.status(409).json({
          ok: false,
          error: 'no-snapshot',
          hint: '07 Continuum 还没在这个 cwd 跑过 hook，无 snapshot 可接力',
        });
      }

      // 1) 归档当前 snapshot 到 history/
      let archiveName = null;
      try {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19).replace('T', '_');
        archiveName = `snapshot_${ts}_PANEL.md`;
        const histDir = join(dir, 'history');
        if (!existsSync(histDir)) mkdirSync(histDir, { recursive: true });
        copyFileSync(snapPath, join(histDir, archiveName));
      } catch (e) {
        console.error('archive snapshot fail:', e.message);
      }

      // 2) 读 snapshot 内容作为新 session 的种子消息 + 写 ~/HANDOFF_LATEST.md 与 07 对齐
      let snapContent = '';
      try { snapContent = readFileSync(snapPath, 'utf-8'); } catch {}
      const guardedSnapContent = markHandoffSummaryAsReference(snapContent, {
        source: 'panel_continuum_handoff',
      });
      try {
        writeFileSync(join(homedir(), 'HANDOFF_LATEST.md'), guardedSnapContent);
      } catch (e) {
        console.error('write HANDOFF_LATEST.md fail:', e.message);
      }

      // 3) 更新 meta：chain_depth + 1, handoff_count + 1
      const metaPath = join(dir, 'meta.json');
      let chainDepth = 1;
      try {
        const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf-8')) : {};
        meta.handoff_count = (meta.handoff_count || 0) + 1;
        meta.chain_depth = (meta.chain_depth || 0) + 1;
        meta.last_handoff_at = new Date().toISOString();
        meta.last_handoff_trigger = 'panel';
        chainDepth = meta.chain_depth;
        // v0.51 Y-06 fix: meta.json 原子写
        const tmp = metaPath + '.tmp';
        writeFileSync(tmp, JSON.stringify(meta, null, 2));
        renameSync(tmp, metaPath);
      } catch (e) {
        console.error('update meta fail:', e.message);
      }

      // 4) 写 handoff_log.jsonl（与 07 兼容）
      try {
        const logPath = join(CONTINUUM_STATE_ROOT, 'handoff_log.jsonl');
        const entry = {
          ts: new Date().toISOString(),
          trigger: 'panel',
          ctx_pct: null,
          snapshot_bytes: snapContent.length,
          cwd: s.cwd,
          cwd_hash: cwdHash(s.cwd),
          session_id: s.claudeSessionId || 'panel-no-session',
          panel_session_id: s.id,
        };
        // S26 B1：handoff_log.jsonl 含 cwd_hash + session_id 等 PII，加 0o600 mode
        appendFileSync(logPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
      } catch {}

      // 5) 在 panel 里建一个新 session（同 cwd，新名字，messages 区记一条"接力起点"）
      const newId = randomUUID();
      const handoffNote = `🔁 接力自 「${s.name}」（chain depth: ${chainDepth}）\n\n--- HANDOFF Snapshot ---\n\n${guardedSnapContent}`;
      const newSession = {
        id: newId,
        name: `${s.name} ▸ #${chainDepth}`,
        cwd: s.cwd,
        claudeSessionId: null,
        createdAt: new Date().toISOString(),
        child: null,
        pid: null,
        busy: false,
        messages: [{
          role: 'system',
          content: handoffNote,
          ts: new Date().toISOString(),
        }],
        clients: new Set(),
        usage: { inputTokens: 0, outputTokens: 0 },
        parentSessionId: s.id,
        chainDepth,
        // v0.31 fix: 补全字段，让 newSession 跟普通 session 字段一致
        mainGoal: s.mainGoal || null, // 继承父 session 主目标
        runState: 'idle',
        guardLevel: s.guardLevel || 'standard',
        model: null,
        dangerHistory: [],
        loopGuardHistory: [],
        archived: false,
        archivedAt: null,
        handoffPrimed: false,
        projectContextPrimed: false,
        projectContextSummary: null,
      };
      sessions.set(newId, newSession);
      onSessionCreated(newSession);
      debouncedSave();

      res.json({
        ok: true,
        newSessionId: newId,
        chainDepth,
        archivedAs: archiveName,
        snapshotBytes: snapContent.length,
      });
    } catch (e) { send500(res, e); }
  });

  app.post('/api/sessions/:id/external', requireOwnerToken, (req, res) => {
    try {
      const s = sessions.get(req.params.id);
      if (!s) return res.status(404).json({ error: 'not found' });
      // cwd 来自 session 创建时校验过的真实目录，但稳妥起见拒绝含控制字符的
      if (/[\x00-\x1f]/.test(s.cwd)) return res.status(400).json({ error: 'cwd 含非法字符' });
      const script = buildClaudeTerminalScript(s.cwd, s.claudeSessionId);
      const proc = spawn('osascript', ['-e', script]);
      // v0.51 W-11 fix: spawn error / stdio error 防御
      proc.on('error', (e) => console.warn('osascript spawn fail:', e.message));
      proc.stdout?.on('error', () => {});
      proc.stderr?.on('error', () => {});
      proc.on('exit', code => {
        if (code !== 0) console.error('osascript exit', code);
      });
      res.json({ ok: true, cwd: s.cwd });
    } catch (e) { send500(res, e); }
  });
}

// ② 批量 spawn Terminal（server.js 原 3833-3851 位置调用——在 POST /api/login-claude 之后，保序）
export function registerSessionsSpawnBatchRoutes(app, deps) {
  const { sessions } = deps;

  // 同时 spawn 多个 Terminal 窗口（批量）— v0.49 N-05 fix: 同 external 端点的 AppleScript 加固
  app.post('/api/spawn-batch', requireOwnerToken, (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 20) : [];
      const result = [];
      for (const id of ids) {
        // v0.51 U-15 fix: id 必须 string，避免 sessions.get(非 string) 异常 / 误命中
        if (typeof id !== 'string') continue;
        const s = sessions.get(id);
        if (!s) continue;
        if (/[\x00-\x1f]/.test(s.cwd)) continue;
        const script = buildClaudeTerminalScript(s.cwd, s.claudeSessionId);
        // v0.51 W-11 fix: 同样防 spawn error
        const p = spawn('osascript', ['-e', script]);
        p.on('error', (e) => console.warn('spawn-batch osascript fail:', e.message));
        p.stdout?.on('error', () => {});
        p.stderr?.on('error', () => {});
        result.push({ id, cwd: s.cwd });
      }
      res.json({ ok: true, spawned: result });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
}
