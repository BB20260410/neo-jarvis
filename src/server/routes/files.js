// @ts-check
// Noe — 文件浏览/预览/目录浏览/全局搜索 routes (S23)
// 从 server.js 提取 /api/files、/api/file、/api/browse、/api/search，行为完全一致
// sessions Map 由 server.js 注入（/api/search 跨 session 搜 messages）

import { readdirSync, statSync, readFileSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { requireOwnerToken } from '../auth/owner-token.js';

export function registerFilesRoutes(app, deps) {
  const { safeResolveFsPath, send500, sessions } = deps;

  // 列 cwd 下文件（文件浏览器用）— v0.49 B-02 fix: 路径沙箱
  app.get('/api/files', requireOwnerToken, (req, res) => {
    const reqPath = req.query.path || '~';
    const path = safeResolveFsPath(reqPath);
    if (!path) return res.status(403).json({ error: 'forbidden: 路径越权或敏感目录' });
    // v0.51 T-17 fix: 检查是否为目录，文件传入应 400 而非 500
    try {
      const st = statSync(path);
      if (!st.isDirectory()) return res.status(400).json({ error: 'not a directory' });
    } catch {
      return res.status(404).json({ error: 'not found' });
    }
    try {
      const items = readdirSync(path)
        .filter(n => !n.startsWith('.'))
        .map(name => {
          const full = join(path, name);
          try {
            const st = statSync(full);
            return { name, path: full, isDir: st.isDirectory(), size: st.size, mtime: st.mtime };
          } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
      res.json({ path, items });
    } catch (e) {
      send500(res, e);
    }
  });

  // 读文件预览 — v0.49 B-02/B-05 fix: 沙箱 + 真实前 1MB 截断
  app.get('/api/file', requireOwnerToken, (req, res) => {
    if (!req.query.path) return res.status(400).json({ error: 'no path' });
    const path = safeResolveFsPath(req.query.path);
    if (!path) return res.status(403).json({ error: 'forbidden: 路径越权或敏感目录' });
    try {
      const st = statSync(path);
      if (!st.isFile()) return res.status(400).json({ error: 'not a regular file' });
      // v0.51 ZZZ-01 fix: 先读前 4KB sniff binary（看 NUL byte），是 binary 则拒绝
      // 避免把 .png/.jpg/.pdf 当 utf-8 解码产生乱码 ufffd 替换字符
      const SNIFF_BYTES = Math.min(4096, st.size);
      if (SNIFF_BYTES > 0) {
        const sniffBuf = Buffer.alloc(SNIFF_BYTES);
        const fd0 = openSync(path, 'r');
        let sniffRead = 0;
        try { sniffRead = readSync(fd0, sniffBuf, 0, SNIFF_BYTES, 0); }
        finally { try { closeSync(fd0); } catch {} }
        for (let i = 0; i < sniffRead; i++) {
          if (sniffBuf[i] === 0) {
            return res.status(415).json({ error: 'binary file not supported (含 NUL byte)', size: st.size });
          }
        }
      }
      const MAX = 1024 * 1024;
      if (st.size > MAX) {
        const buf = Buffer.alloc(MAX);
        const fd = openSync(path, 'r');
        let bytesRead = 0;
        try { bytesRead = readSync(fd, buf, 0, MAX, 0); }
        finally { try { closeSync(fd); } catch {} }
        const content = buf.subarray(0, bytesRead).toString('utf-8');
        return res.json({ path, size: st.size, truncated: true, truncatedBytes: bytesRead, content });
      }
      const content = readFileSync(path, 'utf-8');
      res.json({ path, size: st.size, content });
    } catch (e) {
      send500(res, e);
    }
  });

  // 浏览目录 — v0.49 N-03 fix: 加沙箱（与 /api/files 同沙箱）
  app.get('/api/browse', requireOwnerToken, (req, res) => {
    const path = safeResolveFsPath(req.query.path || '~');
    if (!path) return res.status(403).json({ error: 'forbidden: 路径越权或敏感目录' });
    // v0.51 T-18 fix: 检查是否目录
    try {
      const st = statSync(path);
      if (!st.isDirectory()) return res.status(400).json({ error: 'not a directory' });
    } catch {
      return res.status(404).json({ error: 'not found' });
    }
    try {
      const items = readdirSync(path)
        .filter(n => !n.startsWith('.'))
        .map(name => {
          const full = join(path, name);
          try {
            const st = statSync(full);
            return { name, path: full, isDir: st.isDirectory() };
          } catch { return null; }
        })
        .filter(i => i && i.isDir)
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({ path, items });
    } catch (e) {
      send500(res, e);
    }
  });

  // ============ v0.50 全局搜索（F1）：跨 session 搜 messages ============
  app.get('/api/search', requireOwnerToken, (req, res) => {
    const q = req.query.q;
    if (!q || typeof q !== 'string' || !q.trim()) return res.status(400).json({ error: 'q required' });
    if (q.length > 200) return res.status(400).json({ error: 'q 过长（>200）' });
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30));
    const needle = q.toLowerCase();
    // v0.51 R-02 fix: per-session cap，避免第一个 session 命中过多导致其他 session 完全搜不到
    const perSessionCap = Math.max(3, Math.ceil(limit / 4));
    const hardCap = limit * 5; // 全局硬上限防内存爆
    const hits = [];
    outer: for (const s of sessions.values()) {
      if (s.archived && req.query.includeArchived !== '1') continue;
      const msgs = s.messages || [];
      let perSessionHits = 0;
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        const content = String(m.content || '');
        const idx = content.toLowerCase().indexOf(needle);
        if (idx >= 0) {
          const start = Math.max(0, idx - 60);
          const end = Math.min(content.length, idx + needle.length + 60);
          hits.push({
            sessionId: s.id,
            sessionName: s.name,
            cwd: s.cwd,
            msgIndex: i,
            role: m.role,
            ts: m.ts,
            snippet: (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : ''),
            matchAt: idx,
          });
          perSessionHits++;
          if (perSessionHits >= perSessionCap) break;
          if (hits.length >= hardCap) break outer;
        }
      }
    }
    // 按 timestamp 倒序（最近的优先）+ 截到 limit
    hits.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
    const finalHits = hits.slice(0, limit);
    res.json({ ok: true, query: q, count: finalHits.length, total: hits.length, hits: finalHits });
  });
}
