// @ts-check
// SsrfGuard — 统一出站 SSRF 防护，收敛 img-cache / WebhookDispatcher / WebSearch / PermissionGovernance
//   四处为单一可维护点（蒸馏自 OpenClaw src/infra/net/ssrf.ts 的设计，按 Neo 架构重写，非照搬 TS）。
//
// 为什么存在（消除策略分裂）：
//   Neo 原 img-cache.js 有硬版（net.isIP fail-closed + DNS 解析后逐 IP 复查 + IPv4-mapped 识别），
//   WebhookDispatcher 已正确复用它；但 WebSearch.js / PermissionGovernance.js 各留一份弱版 hostname 正则。
//   弱版只看 hostname 字符串、不做 DNS 解析后复查——attacker.com→10.0.0.x 的 DNS rebinding 完全无防御，
//   而 WebSearch.fetchContent 是 owner 每日高频出站链路。两套实现对同一 IP 一个放行一个拦截 = 薛定谔策略。
//   本模块把硬版抽成一处，让四个下游统一引用，删掉弱版副本。
//
// 纪律：纯收紧不放宽；DNS 注入式（便于单测模拟 rebinding）；不碰系统/账号/密钥。
import { promises as dnsPromises } from 'node:dns';
import net from 'node:net';
import { Agent } from 'undici';

// 端口白名单：避开扫内网服务端口（22/3306/6379/5432…）。抓网页/上传只需 http(s) 默认端口。
const ALLOWED_PORTS = ['80', '443', '8080', '8443'];
// 有全局代理(server.js 的 EnvHttpProxyAgent 读 HTTP(S)_PROXY)时，pinned dispatcher(无代理 Agent)会覆盖全局代理→直连，
//   GFW 后的网站(wikipedia 等)抓不了（owner 在中国走 Clash 代理，51835 实测坐实）。auto 据此不 pin，靠 assertPublicUrl
//   预检 + redirect 逐跳防内网；TOCTOU 残余风险经 Clash 需攻击者控 Clash DNS + 打 51835 要 owner-token，可接受。
// 与 server.js 的 EnvHttpProxyAgent 安装条件 + undici 实读 env 严格对齐（仅 HTTP(S)_PROXY，不含 ALL_PROXY）：
//   只设 ALL_PROXY 时 server.js 不装全局代理，若这里却判 hasProxy=true→不 pin，会变成"既不 pin 又没代理"的最坏态。
const HAS_GLOBAL_PROXY = Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy);

// 私网/保留地址判定。IPv4：127/8 10/8 172.16/12 192.168/16 169.254/16 100.64/10 0/8 多播+保留；
//   IPv6：::1 :: fc00::/7 fe80::/10 ff00::/8 多播 + ::ffff:v4-mapped + ::v4-compat。
export function isPrivateIp(ip) {
  if (!ip) return true;
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map((n) => parseInt(n, 10));
    if (p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    if (p[0] === 127) return true;
    if (p[0] === 10) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
    if (p[0] === 0) return true;
    if (p[0] === 192 && p[1] === 0 && p[2] === 2) return true;     // 192.0.2.0/24 TEST-NET-1（文档/测试保留，非公网）
    if (p[0] === 198 && p[1] === 51 && p[2] === 100) return true;  // 198.51.100.0/24 TEST-NET-2
    if (p[0] === 203 && p[1] === 0 && p[2] === 113) return true;   // 203.0.113.0/24 TEST-NET-3
    if (p[0] === 192 && p[1] === 88 && p[2] === 99) return true;   // 192.88.99.0/24 6to4 relay anycast（已废弃）
    if (p[0] >= 224) return true; // 多播 + 保留
    // 注：198.18.0.0/15 benchmark 段不在此判私网——它是 Clash fake-ip 段，域名抓取会解析到此段，判私网会误杀正常抓取。
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7
    if (lower.startsWith('ff')) return true; // 多播
    if (/^2001:0?db8:/i.test(lower)) return true; // 2001:db8::/32 文档段（精确判第二组=db8，不误伤 2001:db80/db8f 等公网）
    // v4-mapped IPv6 dotted：::ffff:a.b.c.d
    const m = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIp(m[1]);
    // v4-mapped IPv6 hex 压缩：::ffff:7f00:1（URL.hostname 会把 ::ffff:127.0.0.1 压成这形式）
    const m2 = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (m2) {
      const h1 = parseInt(m2[1], 16);
      const h2 = parseInt(m2[2], 16);
      const v4 = `${(h1 >> 8) & 0xff}.${h1 & 0xff}.${(h2 >> 8) & 0xff}.${h2 & 0xff}`;
      return isPrivateIp(v4);
    }
    // IPv4-compatible IPv6（已废弃但仍可解析）：dotted ::a.b.c.d
    const compat = lower.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
    if (compat) return isPrivateIp(compat[1]);
    // IPv4-compat 的 hex 压缩形式：URL.hostname 把 ::127.0.0.1 压成 ::7f00:1、::10.0.0.1 压成 ::a00:1。
    // 凡前 96 位为 0 的 ::x 或 ::x:y（IPv4-compat 段，RFC4291 已废弃、无合法公网用途）一律展开低 32 位判私网，fail-closed。
    const compatHex = lower.match(/^::([0-9a-f]{1,4})(?::([0-9a-f]{1,4}))?$/);
    if (compatHex) {
      const h1 = parseInt(compatHex[1], 16);
      const h2 = compatHex[2] ? parseInt(compatHex[2], 16) : 0;
      return isPrivateIp(`${(h1 >> 8) & 0xff}.${h1 & 0xff}.${(h2 >> 8) & 0xff}.${h2 & 0xff}`);
    }
    return false;
  }
  return true; // net.isIP=0：非合法 IP 字面量 → fail-closed
}

export function stripHostBrackets(host = '') {
  return String(host || '').replace(/^\[/, '').replace(/\]$/, '');
}

function lookupFamily(address = '') {
  return net.isIP(address) || 4;
}

// 同步 hostname 判定（给无法 async 的决策点，如 PermissionGovernance.decision）。
//   IP 字面量 → 走强版 isPrivateIp（识破 IPv4-mapped 等弱版正则漏判的写法）；
//   域名 → 无法同步做 DNS，返回 false（与旧弱版对域名行为一致，交由上游 ask 流程或异步 assertPublicUrl）。
// 替换旧弱版正则：对 IP 字面量更强、对域名零行为变化 → 零回归。
export function isPrivateHostSync(host = '') {
  const h = stripHostBrackets(String(host || '').toLowerCase().trim());
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (net.isIP(h)) return isPrivateIp(h);
  return false; // 域名：同步判不了，留给异步 assertPublicUrl / 上游审批
}

// 异步强判：协议 + 端口白名单 + DNS 解析后逐 A/AAAA 复查（防 DNS rebinding 第一关）。
//   dnsResolve 可注入便于单测模拟 rebinding（attacker.com → 10.0.0.x）。
//   返回 { url, host, addresses, literal }，供下游做 pinned 连接（防解析后再次 rebind）。
export async function assertPublicUrl(url, { dnsResolve = dnsPromises.lookup, dnsTimeoutMs = 5000 } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new Error('invalid url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol not allowed');
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (!ALLOWED_PORTS.includes(port)) throw new Error(`port ${port} not allowed`);
  const host = stripHostBrackets(u.hostname);
  // 直接 IP literal：直接判（net.isIP 识别，私网即拒）
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('private ip blocked');
    return { url: u.toString(), host, addresses: [{ address: host, family: lookupFamily(host) }], literal: true };
  }
  // 域名：DNS 反查 → 拒任何指向私网的解析（防 DNS rebinding 第一关），带超时防差 DNS 把整轮抓取卡死。
  let addrs;
  try { addrs = await withTimeout(dnsResolve(host, { all: true, verbatim: true }), dnsTimeoutMs, 'dns lookup timeout'); }
  catch (e) { throw new Error(/timeout/.test(e?.message || '') ? 'dns lookup timeout' : 'dns lookup failed'); }
  if (!addrs.length) throw new Error('dns no addrs');
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error(`dns resolved to private ip ${a.address}`);
  }
  return {
    url: u.toString(),
    host,
    addresses: addrs.map((a) => ({ address: a.address, family: a.family || lookupFamily(a.address) })),
    literal: false,
  };
}

// 把已校验的解析结果 pin 到连接层：连接时只允许之前校验过的公网 IP，防"校验后再 rebind"。
export function createPinnedLookup(host, addresses) {
  const expected = stripHostBrackets(host).toLowerCase();
  const safeAddresses = (addresses || []).filter((a) => a?.address && !isPrivateIp(a.address));
  return (hostname, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    const current = stripHostBrackets(hostname).toLowerCase();
    // fail-closed：只连之前校验过的 host + 公网 IP；host mismatch 或无安全地址绝不回退裸 DNS（否则 pin 形同虚设）。
    if (current !== expected || !safeAddresses.length) {
      return cb(new Error('pinned lookup blocked: host mismatch or no verified public address'));
    }
    const picked = safeAddresses[0];
    if (opts?.all) return cb(null, safeAddresses.map((a) => ({ address: a.address, family: a.family || lookupFamily(a.address) })));
    return cb(null, picked.address, picked.family || lookupFamily(picked.address));
  };
}

// undici Agent，连接走 pinned lookup（用于真正发起被校验过的请求）。
export function createSafeDispatcher(resolution) {
  if (!resolution?.host || !resolution?.addresses?.length) return null;
  return new Agent({ connect: { lookup: createPinnedLookup(resolution.host, resolution.addresses) } });
}

function closeDispatcher(dispatcher) {
  try { dispatcher?.close?.().catch?.(() => {}); } catch {}
}

// Clash 默认 fake-ip-range 198.18.0.0/15：域名抓取时本机 DNS 把公网域名解析成此段，只有 Clash 能解，
//   直连（pinned dispatcher）必失败。检测到解析结果落此段 → 不 pin，让 fetch 走全局代理 dispatcher。
function isFakeIpResolution(resolution) {
  return (resolution?.addresses || []).some((a) => /^198\.1[89]\./.test(String(a?.address || '')));
}

function withTimeout(promise, ms, msg) {
  if (!ms) return promise;
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(msg)), ms); });
  return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(timer)), timeout]);
}

// 安全抓取统一入口：逐跳 assertPublicUrl + pinned dispatcher + redirect:'manual'，闭合 DNS rebinding TOCTOU
//   与"重定向到内网"绕过——预检后连接锁定在已校验的公网 IP，不给 fetch 重新解析 DNS 的机会。
// 返回 { resp, finalUrl, cleanup }；调用方读完 body 后调 cleanup() 释放连接池。
// 注：pinned dispatcher 仅对 undici fetch 生效；注入的 mock fetchImpl 会忽略它（测试无真实连接，逐跳校验逻辑仍执行）。
export async function safeFetchPublicUrl(url, {
  fetchImpl = globalThis.fetch,
  dnsResolve = undefined,
  method = 'GET',
  headers = {},
  body = undefined,
  maxRedirects = 3,
  timeoutMs = 15000,
  dnsTimeoutMs = 5000,
  pinDispatcher = 'auto', // 'auto'=无代理(direct)且公网解析时 pin 闭合 TOCTOU；有全局代理或 fake-ip 时不 pin；true 强 pin；false 不 pin
  allowFakeIp = process.env.NOE_SSRF_ALLOW_FAKEIP === '1', // Clash fake-ip(198.18/15)默认拒绝；owner 本地可信环境显式 opt-in
  hasProxy = HAS_GLOBAL_PROXY, // 有全局代理时不 pin（pin 会覆盖代理→GFW 网站抓不了，51835 实测坐实）
} = {}) {
  const assertOpts = { ...(dnsResolve ? { dnsResolve } : {}), dnsTimeoutMs };
  let curUrl = url;
  let activeDispatcher = null;
  const ac = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const resolution = await assertPublicUrl(curUrl, assertOpts); // 每一跳都重新校验（含 redirect 后的新域名）
      closeDispatcher(activeDispatcher);
      // pinned dispatcher 把连接锁到已校验 IP（强闭合同域 rebind TOCTOU），但会绕过 HTTP 代理/Clash fake-ip 导致连不通。
      // 安全要点(codex 复核)：攻击者控制的域名可伪造首次 DNS 返回 198.18/15 段诱导"判 fake-ip→关 pin"，再 rebind 内网。
      //   故 fail-closed：fake-ip 段必须 owner 显式 NOE_SSRF_ALLOW_FAKEIP=1 opt-in 才放行不 pin；否则直接拒绝，绝不让攻击者 DNS 关 pin。
      const fakeIp = isFakeIpResolution(resolution);
      if (fakeIp && pinDispatcher === 'auto' && !allowFakeIp) {
        throw new Error('fake-ip range blocked (set NOE_SSRF_ALLOW_FAKEIP=1 for trusted local Clash fake-ip)');
      }
      const usePin = pinDispatcher === true || (pinDispatcher === 'auto' && !hasProxy && !fakeIp);
      activeDispatcher = usePin ? createSafeDispatcher(resolution) : null;
      const resp = await fetchImpl(curUrl, {
        method, headers, body, redirect: 'manual', signal: ac.signal,
        ...(activeDispatcher ? { dispatcher: activeDispatcher } : {}),
      });
      const code = Number(resp?.status) || 0;
      if (code >= 300 && code < 400) {
        const loc = resp.headers?.get?.('location');
        if (!loc) throw new Error('redirect without location');
        curUrl = new URL(loc, curUrl).toString();
        continue;
      }
      // timer 不在此清：超时窗口要覆盖到 caller 读 body（防"先发 header 再无限拖 body"的 DoS）。
      // cleanup() 由 caller 读完 body 后调，那时才清 timer + 释放连接。
      const dispatcher = activeDispatcher;
      return { resp, finalUrl: curUrl, cleanup: () => { if (timer) clearTimeout(timer); closeDispatcher(dispatcher); } };
    }
    throw new Error('too many redirects');
  } catch (e) {
    closeDispatcher(activeDispatcher);
    if (timer) clearTimeout(timer);
    throw e;
  }
}
