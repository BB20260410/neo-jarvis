// @ts-check
// Noe — 方案 B 项目监控 routes (S23)
// 从 server.js 3410-3601 提取（PROJECTS_ROOT + scanProject 全家 + 2 routes），行为完全一致

import { readdirSync, statSync, readFileSync, existsSync, realpathSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { requireOwnerToken } from '../auth/owner-token.js';

const PROJECTS_ROOT = join(homedir(), 'Desktop', '00_项目');

function detectStatusColor(statusContent) {
  if (!statusContent) return 'unknown';
  // STATUS.md 顶部一般有 ## 🟢 绿 / 🟡 黄 / 🔴 红 段头
  const m = statusContent.match(/##\s*(🟢|🟡|🔴)/);
  if (!m) return 'unknown';
  return { '🟢': 'green', '🟡': 'yellow', '🔴': 'red' }[m[1]];
}

function detectAscState(text) {
  if (!text) return null;
  const states = ['READY_FOR_SALE', 'IN_REVIEW', 'WAITING_FOR_REVIEW', 'PENDING_DEVELOPER_RELEASE', 'REJECTED', 'METADATA_REJECTED', 'PREPARE_FOR_SUBMISSION'];
  for (const st of states) {
    if (text.includes(st)) return st;
  }
  return null;
}

function countCycles(progressContent) {
  if (!progressContent) return 0;
  // 找形如 cycle_42 / cycle_42, / cycle_42（…
  const matches = progressContent.match(/cycle_(\d+)/g);
  if (!matches || matches.length === 0) return 0;
  let maxN = 0;
  for (const m of matches) {
    const n = parseInt(m.replace('cycle_', ''), 10);
    if (n > maxN) maxN = n;
  }
  return maxN;
}

function countActiveBlocked(blockedContent) {
  if (!blockedContent) return 0;
  // 找 ### [Task #...] 头，且后面没有 ✅ 或 ~~ 表示已解除
  const lines = blockedContent.split('\n');
  let count = 0;
  for (const line of lines) {
    if (line.match(/^###\s*\[Task\s*#/)) {
      // 同行没 ✅、没 ~~
      if (!line.includes('✅') && !line.includes('~~')) count++;
    }
  }
  return count;
}

// LaunchAgents plist 列表带 5s TTL 缓存：一次 /api/projects 会对 N 个项目各调一次
// scanProject，原本每次都 readdirSync 同一目录（N 次）；plist 变化极低频，缓存到几乎只读 1 次。
let _lagentsCache = { at: 0, plists: [] };
function getLaunchAgentPlists() {
  const now = Date.now();
  if (now - _lagentsCache.at < 5000) return _lagentsCache.plists;
  let plists = [];
  try {
    const lagents = join(homedir(), 'Library', 'LaunchAgents');
    if (existsSync(lagents)) plists = readdirSync(lagents).filter(f => f.endsWith('.plist'));
  } catch {}
  _lagentsCache = { at: now, plists };
  return plists;
}

function scanProject(projDir) {
  const result = {
    name: projDir.split('/').pop(),
    path: projDir,
    hasProgress: false,
  };
  try {
    const st = statSync(projDir);
    if (!st.isDirectory()) return null;
  } catch { return null; }

  const progressPath = join(projDir, 'PROGRESS.md');
  if (!existsSync(progressPath)) return null;
  result.hasProgress = true;

  try {
    const progress = readFileSync(progressPath, 'utf-8');
    result.cycles = countCycles(progress);
  } catch {}

  const statusPath = join(projDir, 'STATUS.md');
  if (existsSync(statusPath)) {
    try {
      const status = readFileSync(statusPath, 'utf-8');
      result.statusColor = detectStatusColor(status);
      result.ascState = detectAscState(status);
      // 抓 STATUS.md 第一段第一行作 headline
      const headline = status.split('\n').find(l => l.trim() && !l.startsWith('#'));
      if (headline) result.headline = headline.replace(/^>?\s*/, '').slice(0, 120);
    } catch {}
  }

  const blockedPath = join(projDir, 'BLOCKED.md');
  if (existsSync(blockedPath)) {
    try {
      result.activeBlocked = countActiveBlocked(readFileSync(blockedPath, 'utf-8'));
    } catch {}
  }

  // 是否在跑（RUNNING_LOCK）
  result.running = existsSync(join(projDir, '.RUNNING_LOCK'));
  // 锁心跳新鲜度
  if (result.running) {
    const hb = join(projDir, '.RUNNING_LOCK', '.heartbeat');
    if (existsSync(hb)) {
      try {
        const last = parseInt(readFileSync(hb, 'utf-8').trim(), 10);
        const age = Math.floor(Date.now() / 1000) - last;
        result.lockAgeSec = age;
        result.lockStale = age > 6000; // 100min
      } catch {}
    }
  }

  // launchd plist 检测（plist 列表走 5s TTL 缓存，避免每项目每请求重复 readdirSync）
  try {
    const plists = getLaunchAgentPlists();
    const nameKey = result.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    result.launchdPlist = plists.find(p => p.toLowerCase().replace(/[^a-z0-9]/g, '').includes(nameKey.slice(0, 8))) || null;
  } catch {}

  // 最近 commit
  try {
    const head = readFileSync(join(projDir, '.git', 'HEAD'), 'utf-8').trim();
    let refPath;
    if (head.startsWith('ref: ')) {
      refPath = join(projDir, '.git', head.slice(5).trim());
    }
    if (refPath && existsSync(refPath)) {
      const st2 = statSync(refPath);
      result.lastCommitAt = st2.mtime;
    }
  } catch {}

  return result;
}

export function registerProjectsRoutes(app, deps) {
  const { send500 } = deps;

  // 端点：列所有方案 B 项目
  app.get('/api/projects', requireOwnerToken, (req, res) => {
    if (!existsSync(PROJECTS_ROOT)) return res.json({ ok: false, reason: 'no-projects-root', root: PROJECTS_ROOT, items: [] });
    try {
      const dirs = readdirSync(PROJECTS_ROOT)
        .filter(n => !n.startsWith('.'))
        .map(n => join(PROJECTS_ROOT, n));
      const items = dirs.map(scanProject).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
      res.json({ ok: true, root: PROJECTS_ROOT, items });
    } catch (e) {
      send500(res, e);
    }
  });

  // 端点：单项目详情（含 STATUS/BLOCKED/最近 PROGRESS）
  // v0.49 N-19 fix: name 严格校验，禁 path traversal
  app.get('/api/projects/:name', requireOwnerToken, (req, res) => {
    const name = req.params.name;
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..') || name.length > 200) {
      return res.status(400).json({ error: 'invalid project name' });
    }
    const projDir = join(PROJECTS_ROOT, name);
    // 二次防御：解析后必须仍在 PROJECTS_ROOT 下
    let real;
    try { real = realpathSync(projDir); } catch { return res.status(404).json({ error: 'project not found' }); }
    let rootReal;
    try { rootReal = realpathSync(PROJECTS_ROOT); } catch { rootReal = PROJECTS_ROOT; }
    if (real !== rootReal && !real.startsWith(rootReal + '/')) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const base = scanProject(projDir);
    if (!base) return res.status(404).json({ error: 'project not found or no PROGRESS.md' });
    const sections = {};
    for (const [key, fname] of [['status', 'STATUS.md'], ['blocked', 'BLOCKED.md'], ['plan', 'PLAN.md'], ['errorLog', 'ERROR_LOG.md']]) {
      const p = join(projDir, fname);
      if (existsSync(p)) {
        try {
          const txt = readFileSync(p, 'utf-8');
          sections[key] = txt.length > 30000 ? txt.slice(0, 30000) + '\n\n...(truncated)' : txt;
        } catch {}
      }
    }
    // PROGRESS.md 只取最后 60 行
    const prog = join(projDir, 'PROGRESS.md');
    if (existsSync(prog)) {
      try {
        const lines = readFileSync(prog, 'utf-8').split('\n');
        sections.progressTail = lines.slice(-60).join('\n');
      } catch {}
    }
    res.json({ ok: true, ...base, sections });
  });
}
