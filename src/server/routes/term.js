// @ts-check
// Noe — PTY 内嵌真终端 routes (S23)
// v0.22 起的 /api/term 三路由，从 server.js 4378-4454 提取，行为完全一致
//
// terminals Map 在这里创建并返回给 server.js —— WS 升级 (/ws/term/:id)、
// /api/health/processes、优雅停机三处仍需要它（单一数据源不变，只挪了出生地）。

import { randomUUID } from 'crypto';
import { statSync } from 'fs';
import { homedir } from 'os';
import * as defaultPty from '@homebridge/node-pty-prebuilt-multiarch';
import { requireOwnerToken } from '../auth/owner-token.js';

// v0.51 S-05 fix: PTY 终端总数上限（每个 PTY = 一个 shell 进程，资源消耗大）
const MAX_TERMINALS = 20;

export function registerTermRoutes(app, deps) {
  const { safeResolveFsPath, send500 } = deps;
  const pty = deps.pty || defaultPty; // 测试可注入假 pty
  const terminals = new Map(); // termId → { term, clients: Set, cwd, createdAt }

  // 改：owner-token 保护 — 创建 PTY 直接拿到 shell 进程 = 任意命令执行
  app.post('/api/term', requireOwnerToken, (req, res) => {
    if (terminals.size >= MAX_TERMINALS) {
      return res.status(429).json({ error: `已达终端总数上限（${MAX_TERMINALS}）。先关掉不用的终端` });
    }
    const { cwd, cols = 80, rows = 24, shell } = req.body || {};
    const termId = randomUUID();
    // v0.49 N-04 fix: cwd 走沙箱（仅 home 子树或 /tmp，禁敏感目录），非法回退到 home
    let workDir = homedir();
    if (cwd && typeof cwd === 'string' && cwd.trim()) {
      const safe = safeResolveFsPath(cwd.trim());
      if (safe) {
        try {
          const st = statSync(safe);
          if (st.isDirectory()) workDir = safe;
        } catch {}
      }
    }
    // shell 只允许常见 binary，防注入
    const ALLOWED_SHELLS = new Set(['/bin/zsh', '/bin/bash', '/bin/sh', '/usr/bin/zsh', '/usr/bin/bash']);
    const requestedShell = (typeof shell === 'string' && shell.trim()) ? shell.trim() : (process.env.SHELL || '/bin/zsh');
    const shellBin = ALLOWED_SHELLS.has(requestedShell) ? requestedShell : '/bin/zsh';
    try {
      const term = pty.spawn(shellBin, [], {
        name: 'xterm-256color',
        cols: Math.max(20, Math.min(500, cols | 0)),
        rows: Math.max(5, Math.min(200, rows | 0)),
        cwd: workDir,
        env: { ...process.env, TERM: 'xterm-256color', LANG: 'zh_CN.UTF-8' },
      });
      const clients = new Set();
      term.onData(d => {
        for (const ws of clients) {
          if (ws.readyState === 1) {
            try { ws.send(JSON.stringify({ type: 'data', data: d })); } catch {}
          }
        }
      });
      term.onExit(({ exitCode, signal }) => {
        for (const ws of clients) {
          if (ws.readyState === 1) {
            try { ws.send(JSON.stringify({ type: 'exit', exitCode, signal })); } catch {}
          }
        }
        terminals.delete(termId);
      });
      terminals.set(termId, { term, clients, cwd: workDir, shell: shellBin, createdAt: new Date().toISOString(), approvalInputBuffer: '' });
      res.json({ ok: true, termId, cwd: workDir, shell: shellBin, pid: term.pid });
    } catch (e) {
      send500(res, e, 'pty spawn');
    }
  });

  // 改：owner-token 保护 — 暴露的 termId 是 WS 升级所需的猜测目标，列出来 = 让外部 UID 进程直接 attach
  app.get('/api/term', requireOwnerToken, (req, res) => {
    res.json([...terminals.entries()].map(([id, t]) => ({
      id, pid: t.term.pid, cwd: t.cwd, shell: t.shell, createdAt: t.createdAt,
    })));
  });

  app.delete('/api/term/:id', requireOwnerToken, (req, res) => {
    const t = terminals.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    try { t.term.kill(); } catch {}
    // v0.51 V-05 fix: 主动 close 所有 ws clients，对齐 DELETE session 的清理（N-20）
    for (const ws of t.clients) {
      try { ws.close(); } catch {}
    }
    t.clients.clear();
    terminals.delete(req.params.id);
    res.json({ ok: true });
  });

  return { terminals };
}
