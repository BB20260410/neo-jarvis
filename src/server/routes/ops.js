// @ts-check
// Noe — ops 域运维/健康 routes (S23)
// 从 server.js 提取 4 条路由（GET /api/metrics/health、DELETE /api/metrics、
// GET /api/health/processes、POST /api/login-claude），行为完全一致。
// 4 条在 server.js 里分散四处注册位，照 sessionsContinuum.js 保序先例分 4 个 register
// 函数，server.js 各原位置分别调用，保证 Express 注册顺序与拆前逐条一致。
// 注入说明：send500 是 server.js 闭包、metricsStore/5 个 dispatcher 按既有注入风格走 deps；
// terminals 由文件靠后的 registerTermRoutes 返回值 const 解构（晚于 /api/health/processes
// 注册位，直接传值会 TDZ ReferenceError），必须 getTerminals getter 延迟到请求时求值。
// fileSizeMB 是 /api/metrics/health handler 局部函数随迁；server.js 的 runHealthSweep
// 内另有同名局部实现，二者互不共享。

import { spawn, spawnSync } from 'child_process';
import { statSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { requireOwnerToken } from '../auth/owner-token.js';

// ① 健康摘要（server.js 原 registerMetricsRoutes 之后紧邻位置调用）
export function registerOpsMetricsHealthRoutes(app, deps) {
  const {
    send500, debateDispatcher, squadDispatcher, arenaDispatcher,
    soloChatDispatcher, crossVerifyDispatcher,
  } = deps;

  app.get('/api/metrics/health', requireOwnerToken, (req, res) => {
    try {
      const PANEL_DIR = join(homedir(), '.noe-panel');
      const fileSizeMB = (name) => {
        try { return Math.round((statSync(join(PANEL_DIR, name)).size / 1024 / 1024) * 100) / 100; }
        catch { return 0; }
      };
      let metricsMB = 0;
      try {
        const files = readdirSync(PANEL_DIR).filter((f) => /^metrics-\d{4}-\d{2}\.jsonl/.test(f));
        for (const f of files) metricsMB += statSync(join(PANEL_DIR, f)).size;
        metricsMB = Math.round((metricsMB / 1024 / 1024) * 100) / 100;
      } catch {}
      const mem = process.memoryUsage();
      const rssMB = Math.round((mem.rss / 1024 / 1024) * 100) / 100;
      const heapMB = Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100;
      // 收集所有 dispatcher 在跑的 spawn 子进程数（间接：活跃 abort 数）
      const activeRooms =
        (debateDispatcher.activeAborts?.size || 0) +
        (squadDispatcher.activeAborts?.size || 0) +
        (arenaDispatcher.activeAborts?.size || 0) +
        (soloChatDispatcher.activeAborts?.size || 0) +
        (crossVerifyDispatcher.activeAborts?.size || 0);
      const warnings = [];
      if (rssMB > 1024) warnings.push(`panel 内存占用偏高：${rssMB} MB`);
      if (fileSizeMB('data.json') > 200) warnings.push(`data.json > 200MB`);
      if (fileSizeMB('rooms.json') > 100) warnings.push(`rooms.json > 100MB`);
      if (metricsMB > 500) warnings.push(`metrics 文件总量 > 500MB`);
      res.json({
        ok: true,
        panel: { rssMB, heapMB, uptimeS: Math.round(process.uptime()), pid: process.pid },
        activeRooms,
        files: {
          dataJsonMB: fileSizeMB('data.json'),
          roomsJsonMB: fileSizeMB('rooms.json'),
          watcherJsonMB: fileSizeMB('watcher.json'),
          promptsJsonMB: fileSizeMB('prompts.json'),
          roomAdaptersJsonMB: fileSizeMB('room-adapters.json'),
          metricsMB,
        },
        warnings,
      });
    } catch (e) {
      send500(res, e);
    }
  });
}

// ② v0.53 Sprint 3.5：清理老 metrics 文件（server.js 原 registerRoomsReportRoutes 之后位置调用）
// query: olderThan=YYYY-MM（删该月份及之前的所有 metrics-*.jsonl）
export function registerOpsMetricsDeleteRoutes(app, deps) {
  const { send500, metricsStore } = deps;

  app.delete('/api/metrics', requireOwnerToken, (req, res) => {
    try {
      const cutoff = String(req.query.olderThan || '').trim();
      if (!/^\d{4}-\d{2}$/.test(cutoff)) {
        return res.status(400).json({ ok: false, error: 'olderThan 必须是 YYYY-MM 格式' });
      }
      const PANEL_DIR = join(homedir(), '.noe-panel');
      const deleted = [];
      try {
        const files = readdirSync(PANEL_DIR).filter((f) => /^metrics-\d{4}-\d{2}\.jsonl/.test(f));
        for (const f of files) {
          const m = f.match(/^metrics-(\d{4}-\d{2})\.jsonl/);
          if (m && m[1] <= cutoff) {
            try { unlinkSync(join(PANEL_DIR, f)); deleted.push(f); } catch {}
          }
        }
      } catch {}
      // 内存 cache 跨月时已自动清，这里防御性再清一次：当前月份小于等于 cutoff 才清
      const curMonth = new Date().toISOString().slice(0, 7);
      if (curMonth <= cutoff) metricsStore.clearCache();
      res.json({ ok: true, deleted, count: deleted.length });
    } catch (e) {
      send500(res, e);
    }
  });
}

// ③ v0.53 Sprint 3 阶段 3：进程列表（pgrep -P → ps）+ PTY 终端 + 活跃 dispatcher 数
// （server.js 原 registerRoomTemplatesRoutes 之后位置调用；terminals 必须 getter 注入）
export function registerOpsHealthProcessesRoutes(app, deps) {
  const {
    send500, debateDispatcher, squadDispatcher, arenaDispatcher,
    soloChatDispatcher, crossVerifyDispatcher, getTerminals,
  } = deps;

  app.get('/api/health/processes', requireOwnerToken, (req, res) => {
    try {
      const myPid = process.pid;
      let psRows = [];
      try {
        const r = spawnSync('pgrep', ['-P', String(myPid)], { encoding: 'utf-8' });
        const childPids = (r.stdout || '').trim().split('\n').filter(Boolean);
        if (childPids.length > 0) {
          const ps = spawnSync('ps', ['-p', childPids.join(','), '-o', 'pid=,rss=,etime=,command='], { encoding: 'utf-8' });
          const lines = (ps.stdout || '').trim().split('\n').filter(Boolean);
          psRows = lines.map((l) => {
            const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
            if (!m) return null;
            return {
              pid: parseInt(m[1], 10),
              rssMB: Math.round((parseInt(m[2], 10) / 1024) * 10) / 10,
              etime: m[3],
              command: (m[4] || '').slice(0, 200),
            };
          }).filter(Boolean);
        }
      } catch {
        // pgrep/ps 在某些环境不可用，silent fallback
      }
      const terms = [];
      for (const [id, t] of getTerminals()) {
        terms.push({
          id,
          cwd: t.cwd,
          pid: t.term?.pid || null,
          clients: t.clients.size,
          shell: t.shell,
          createdAt: t.createdAt,
        });
      }
      res.json({
        ok: true,
        panelPid: myPid,
        activeDispatchers: {
          debate: debateDispatcher.activeAborts?.size || 0,
          squad: squadDispatcher.activeAborts?.size || 0,
          arena: arenaDispatcher.activeAborts?.size || 0,
          soloChat: soloChatDispatcher.activeAborts?.size || 0,
          crossVerify: crossVerifyDispatcher.activeAborts?.size || 0,
        },
        children: psRows,
        terminals: terms,
      });
    } catch (e) {
      send500(res, e);
    }
  });
}

// ④ v0.14: 在外部 Terminal 打开 + 自动跑 `claude /login`（OAuth 浏览器跳转流程）
// 不在 panel 内嵌 PTY（macOS arm64 node-pty 有坑），用 osascript 最稳
// （server.js 原位置夹在 sessionsContinuum 两个 register 调用之间，单独调用点保序）
export function registerOpsLoginClaudeRoutes(app, deps) {
  const { send500 } = deps;

  app.post('/api/login-claude', requireOwnerToken, (req, res) => {
    try {
      const script = `tell application "Terminal"
    activate
    do script "echo '🔐 Claude Code 登录' && echo '完成后可关闭此窗口，回到 panel 继续' && echo '' && claude /login"
end tell`;
      const proc = spawn('osascript', ['-e', script]);
      // v0.51 W-11 fix: 同样防御
      proc.on('error', (e) => console.warn('login-claude osascript spawn fail:', e.message));
      proc.stdout?.on('error', () => {});
      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.stderr.on('error', () => {});
      proc.on('exit', code => {
        if (code !== 0 && stderr) console.error('login-claude osascript fail:', stderr);
      });
      res.json({ ok: true, message: '已在 Terminal 打开 claude /login，请完成 OAuth 后回来' });
    } catch (e) {
      send500(res, e);
    }
  });
}
