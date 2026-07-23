// B-005 v0.9 真做：AI markdown 图片本地缓存（学自 Cherry Studio issue #6972）
//
// 工作方式：
// - 前端 markdown 渲染后扫 img.src 是 http/https 的，改成 /api/img-cache?url=<原 url>
// - 本 endpoint 下载到 ~/.noe-panel/img-cache/<sha1>.<ext>，0o600 权限
// - 后续访问直接返本地文件（避免外链失效）
// - 同 url 复用 hash → 不重复下载
// - 上限：单文件 ≤ 8MB，总目录 ≤ 200MB（超了 LRU 删旧的）

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, unlinkSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
// SSRF 校验/私网判定/pinned 连接统一到 SsrfGuard（本文件曾是强版原产地，现抽成共享单点，实现只此一份防漂移）。
// 注意：必须 import 取本地绑定（下载逻辑内部用 assertPublicUrl/createSafeDispatcher），再 export 重新对外——
//   `export {x} from 'y'` 是纯转发，不在本模块创建绑定，本地调用会 ReferenceError。
import { isPrivateIp, assertPublicUrl, createPinnedLookup, createSafeDispatcher } from '../../security/SsrfGuard.js';
export { isPrivateIp, assertPublicUrl, createPinnedLookup };

const CACHE_DIR = join(homedir(), '.noe-panel', 'img-cache');
const MAX_FILE_SIZE = 8 * 1024 * 1024;       // 8MB / image
const MAX_DIR_SIZE = 200 * 1024 * 1024;      // 200MB 总
const FETCH_TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 3;

// SSRF 私网判定/校验/pinned 连接的实现已抽到 src/security/SsrfGuard.js 并在文件顶部 re-export；
// 下面下载逻辑用 createSafeDispatcher（= SsrfGuard 的 dispatcherForResolution）。

function closeDispatcher(dispatcher) {
  try { dispatcher?.close?.().catch?.(() => {}); } catch {}
}

function ensureDir() {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  }
}

function urlToKey(url) {
  return createHash('sha1').update(url).digest('hex').slice(0, 24);
}

function guessExt(url, contentType = '') {
  const m = url.match(/\.([a-z0-9]{2,5})(?:[?#].*)?$/i);
  if (m) return m[1].toLowerCase().slice(0, 5);
  if (/png/i.test(contentType)) return 'png';
  if (/jpe?g/i.test(contentType)) return 'jpg';
  if (/gif/i.test(contentType)) return 'gif';
  if (/webp/i.test(contentType)) return 'webp';
  if (/svg/i.test(contentType)) return 'svg';
  return 'bin';
}

// B1.4 资源/DoS：流式读取响应体，累计字节超 maxBytes 立即中止并 cancel 流。
// 不信任 Content-Length（可能缺失或伪造）——以真实下载字节为准，防无界缓冲 OOM。
// 抛 RangeError('image too large ...') → 上层转 413。无 body（极端环境）时退回 arrayBuffer 兜底。
const TOO_LARGE = Symbol('too-large');
async function readBodyWithLimit(resp, maxBytes) {
  const body = resp.body;
  if (!body || typeof body.getReader !== 'function') {
    // 兜底：无可读流时退回 arrayBuffer，但仍按真实字节裁定（保留旧的下载后再判逻辑）
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > maxBytes) { const e = new RangeError('image too large'); e.code = TOO_LARGE; throw e; }
    return buf;
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength) {
        total += value.byteLength;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch {}
          const e = new RangeError('image too large'); e.code = TOO_LARGE; throw e;
        }
        chunks.push(Buffer.from(value));
      }
    }
  } finally {
    try { reader.releaseLock?.(); } catch {}
  }
  return Buffer.concat(chunks, total);
}

// B1.4 SVG 存储型 XSS 防护：本 endpoint 在同源面板（127.0.0.1:51835）上，
// 若以 image/svg+xml 顶级文档渲染（如用户直接打开 /api/img-cache?url=<恶意svg>），
// 浏览器会执行 SVG 内嵌 <script> → 窃取同源 cookie/token。
// 防护：attachment 强制下载（不顶级渲染）+ CSP(script-src 'none'; sandbox) 双保险 +
// nosniff 防 MIME 嗅探。注意：<img src> 加载 SVG 是被动资源加载，不受这些头影响，图片仍正常显示。
function applySvgGuardIfNeeded(res, mime) {
  if (!/^image\/svg(\+xml)?/i.test(mime || '')) return;
  res.setHeader('Content-Disposition', 'attachment');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

// 审计 §3.1 P0-3：HIT 热路径用内存 Map（key→filename）跳过 readdirSync 全目录扫描
const keyToFile = new Map();

// 简易 LRU：按 atime 排序删旧的，超过 MAX_DIR_SIZE 时
// 审计 §3.1 P0-3：经 setImmediate 调度，不在请求响应路径同步阻塞事件循环
function evictIfNeeded() {
  try {
    if (!existsSync(CACHE_DIR)) return;
    const files = readdirSync(CACHE_DIR).map(f => {
      const fp = join(CACHE_DIR, f);
      const s = statSync(fp);
      return { fp, name: f, size: s.size, atime: s.atimeMs };
    }).sort((a, b) => a.atime - b.atime);
    let total = files.reduce((s, f) => s + f.size, 0);
    while (total > MAX_DIR_SIZE && files.length > 0) {
      const oldest = files.shift();
      try { unlinkSync(oldest.fp); } catch {}
      keyToFile.delete(oldest.name.split('.')[0]); // key 为纯 hex，无内嵌点
      total -= oldest.size;
    }
  } catch {}
}

export function registerImgCacheRoutes(app) {
  app.get('/api/img-cache', async (req, res) => {
    const url = String(req.query.url || '').trim();
    if (!url) return res.status(400).json({ error: 'url required' });
    if (url.length > 2048) return res.status(400).json({ error: 'url too long' });
    // 协议 / 端口 / 私网 IP 校验在 assertPublicUrl 内统一做

    ensureDir();
    const key = urlToKey(url);
    // 热路径：先查内存 Map（O(1)），仅在未命中或文件已被 evict 时才 readdirSync 回填
    let cachedName = keyToFile.get(key);
    if (cachedName && !existsSync(join(CACHE_DIR, cachedName))) {
      keyToFile.delete(key);
      cachedName = null;
    }
    if (!cachedName) {
      const candidates = readdirSync(CACHE_DIR).filter(f => f.startsWith(key + '.'));
      if (candidates.length > 0) {
        cachedName = candidates[0];
        keyToFile.set(key, cachedName);
      }
    }

    if (cachedName) {
      // 命中 cache，返本地
      const fp = join(CACHE_DIR, cachedName);
      const buf = readFileSync(fp);
      const ext = cachedName.split('.').pop();
      const mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' })[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('X-Img-Cache', 'HIT');
      applySvgGuardIfNeeded(res, mime); // SVG 回放防存储型 XSS
      return res.end(buf);
    }

    // miss，下载（手动跟 redirect，每跳一次重做 SSRF 校验）
    let activeDispatcher = null;
    try {
      let curUrl = url;
      let resp;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      try {
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          let resolution;
          try { resolution = await assertPublicUrl(curUrl); }
          catch (e) { clearTimeout(timer); closeDispatcher(activeDispatcher); return res.status(400).json({ error: `url blocked: ${e.message}` }); }
          const dispatcher = createSafeDispatcher(resolution);
          activeDispatcher = dispatcher;
          resp = await fetch(curUrl, { signal: ac.signal, redirect: 'manual', ...(dispatcher ? { dispatcher } : {}) });
          if (resp.status >= 300 && resp.status < 400) {
            const loc = resp.headers.get('location');
            closeDispatcher(activeDispatcher);
            activeDispatcher = null;
            if (!loc) return res.status(502).json({ error: 'redirect without Location' });
            try { curUrl = new URL(loc, curUrl).toString(); }
            catch { return res.status(502).json({ error: 'invalid redirect target' }); }
            continue;
          }
          break;
        }
      } finally { clearTimeout(timer); }
      if (!resp) { closeDispatcher(activeDispatcher); return res.status(502).json({ error: 'no response' }); }
      if (resp.status >= 300 && resp.status < 400) { closeDispatcher(activeDispatcher); return res.status(502).json({ error: 'too many redirects' }); }
      if (!resp.ok) { closeDispatcher(activeDispatcher); return res.status(502).json({ error: `upstream ${resp.status}` }); }
      // B-005 安全：只允许 image mime（防被 LLM 误传 css/html/exe 做 proxy）
      const mime = resp.headers.get('content-type') || '';
      if (!/^image\//i.test(mime)) { closeDispatcher(activeDispatcher); return res.status(415).json({ error: `not an image (${mime})` }); }
      const len = parseInt(resp.headers.get('content-length') || '0', 10);
      if (len > MAX_FILE_SIZE) { closeDispatcher(activeDispatcher); return res.status(413).json({ error: `image too large (${len} > ${MAX_FILE_SIZE})` }); }
      // B1.4：流式读取 + 真实字节上限（不信任 Content-Length，防缺失/伪造时无界缓冲 OOM）
      let buf;
      try {
        buf = await readBodyWithLimit(resp, MAX_FILE_SIZE);
      } catch (e) {
        closeDispatcher(activeDispatcher);
        activeDispatcher = null;
        if (e && e.code === TOO_LARGE) return res.status(413).json({ error: `image too large (> ${MAX_FILE_SIZE})` });
        throw e;
      }
      closeDispatcher(activeDispatcher);
      activeDispatcher = null;

      // B1.4 codex post-review 返工：svg 内容强制存 .svg 扩展——否则上游 Content-Type 是 svg 但 URL 是 .png 时
      // 会存成 .png，HIT 路径按扩展名推 mime=image/png 不触发 applySvgGuardIfNeeded，SVG 存储型 XSS 在 HIT 漏防。
      let ext = guessExt(url, mime);
      if (/^image\/svg(\+xml)?/i.test(mime || '')) ext = 'svg';
      const fname = `${key}.${ext}`;
      const fp = join(CACHE_DIR, fname);
      writeFileSync(fp, buf, { mode: 0o600 });
      try { chmodSync(fp, 0o600); } catch {}
      keyToFile.set(key, fname);
      setImmediate(evictIfNeeded); // 非阻塞：不让 LRU 扫描卡住当前响应

      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('X-Img-Cache', 'MISS-DL');
      applySvgGuardIfNeeded(res, mime); // SVG 回放防存储型 XSS
      res.end(buf);
    } catch (e) {
      closeDispatcher(activeDispatcher);
      res.status(502).json({ error: 'fetch failed: ' + e.message });
    }
  });

  // 状态查询
  app.get('/api/img-cache/stats', (_, res) => {
    try {
      ensureDir();
      const files = readdirSync(CACHE_DIR);
      const totalSize = files.reduce((s, f) => {
        try { return s + statSync(join(CACHE_DIR, f)).size; } catch { return s; }
      }, 0);
      res.json({ ok: true, count: files.length, totalBytes: totalSize, totalMB: (totalSize / 1024 / 1024).toFixed(2), maxMB: MAX_DIR_SIZE / 1024 / 1024 });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return { CACHE_DIR };
}
