// owner-token 鉴权：保护 panel 本机写敏感配置（webhook secret 等）端点
//
// 威胁模型：panel 监听 127.0.0.1:51835，但本机其他用户进程也能 curl localhost。
// 任何能写 webhook secret / 支付集成 secret 的端点，必须验证调用者持有 owner token。
// owner token 落在 ~/.noe-panel/owner-token.txt（0600），首次访问自动生成 32 字节随机 hex。
// 浏览器内本面板调用时，前端先读 owner-token 拉到 sessionStorage 再带 X-Panel-Owner-Token。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OWNER_TOKEN_PATH = path.join(os.homedir(), '.noe-panel', 'owner-token.txt');

// 审计 §3.1 P0-1/P1①：token 启动生成后进程内不变（轮换需重启 panel），
// 故首次读后缓存进内存——消除每个 /api/ 请求的同步 existsSync+readFileSync 磁盘 IO
// （高频广播下阻塞事件循环），并缓存比较用 Buffer 避免每次重建。
let _cachedToken = null;
let _cachedBuf = null;

export function getOrCreateOwnerToken() {
  if (_cachedToken) return _cachedToken;
  try {
    let t = null;
    if (fs.existsSync(OWNER_TOKEN_PATH)) {
      const r = fs.readFileSync(OWNER_TOKEN_PATH, 'utf8').trim();
      if (r.length >= 32) t = r;
    }
    if (!t) {
      const dir = path.dirname(OWNER_TOKEN_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      t = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(OWNER_TOKEN_PATH, t + '\n', { mode: 0o600 });
    }
    _cachedToken = t;
    _cachedBuf = Buffer.from(t);
    return t;
  } catch {
    return null;
  }
}

// 测试用：清缓存让下次 getOrCreateOwnerToken 重新读盘（隔离 HOME 切换场景）
export function __resetOwnerTokenCacheForTest() {
  _cachedToken = null;
  _cachedBuf = null;
}

// 给 Express 路由用：HTTP 头 X-Panel-Owner-Token
export function requireOwnerToken(req, res, next) {
  const owner = getOrCreateOwnerToken();
  if (!owner) return res.status(500).json({ error: 'owner token unavailable' });
  const provided = (req.get('X-Panel-Owner-Token') || '').trim();
  if (!provided || provided.length !== owner.length) {
    return res.status(401).json({ error: 'owner token required (see ~/.noe-panel/owner-token.txt)' });
  }
  try {
    if (!crypto.timingSafeEqual(Buffer.from(provided), _cachedBuf)) {
      return res.status(401).json({ error: 'owner token mismatch' });
    }
  } catch {
    return res.status(401).json({ error: 'owner token compare failed' });
  }
  next();
}

// 给 WS upgrade 用：浏览器 WebSocket 不能加自定义 header，必须靠 query string ?token=
// 返回 boolean；timing-safe 比较
export function verifyOwnerTokenString(provided) {
  const owner = getOrCreateOwnerToken();
  if (!owner) return false;
  const p = (provided || '').toString().trim();
  if (!p || p.length !== owner.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(p), _cachedBuf);
  } catch {
    return false;
  }
}
