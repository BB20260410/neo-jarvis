// @ts-check
// SsrfGuard 单测 — 覆盖实测发现的真实绕过面(IPv4-mapped IPv6)+ DNS rebinding + 正常放行(防误杀)。
import { describe, it, expect } from 'vitest';
import { isPrivateIp, isPrivateHostSync, assertPublicUrl, safeFetchPublicUrl, createPinnedLookup } from '../../src/security/SsrfGuard.js';

describe('SsrfGuard.isPrivateIp', () => {
  it('IPv4 私网/保留段 → true', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });
  it('IPv4 公网 → false（含 172.15/172.32 边界外）', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '11.0.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
  it('IPv6 私网 → true（含 v4-mapped dotted/hex/compat 三形式，这是弱版漏判的真实绕过）', () => {
    // ::7f00:1 / ::a00:1 = URL.hostname 把 ::127.0.0.1 / ::10.0.0.1 压成的 IPv4-compat hex（codex 复核抓出的真实绕过）
    for (const ip of ['::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::127.0.0.1', '::ffff:10.0.0.1', '::7f00:1', '::a00:1']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });
  it('IPv6 公网 → false', () => {
    for (const ip of ['2001:4860:4860::8888', '2606:4700:4700::1111']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
  it('非法 IP 字面量 fail-closed → true（十进制/十六进制整数等非 net.isIP 格式）', () => {
    for (const v of ['', 'not-an-ip', '2130706433', '0x7f000001', 'example.com']) {
      expect(isPrivateIp(v), v).toBe(true);
    }
  });
  it('特殊保留段(TEST-NET/2001:db8)判私网；但 198.18 fake-ip 段不判（防误杀 Clash 域名抓取）', () => {
    for (const ip of ['192.0.2.1', '198.51.100.5', '203.0.113.9', '192.88.99.1', '2001:db8::1']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    expect(isPrivateIp('198.18.0.1')).toBe(false); // fake-ip 段故意放行（域名解析到此段是正常 Clash 行为）
    expect(isPrivateIp('198.19.255.255')).toBe(false);
    expect(isPrivateIp('2001:db80::1')).toBe(false); // 邻段公网，精确正则不被前缀误伤（codex 复核）
    expect(isPrivateIp('2001:db8f::1')).toBe(false);
  });
});

describe('SsrfGuard.isPrivateHostSync（同步决策点用，IP 字面量强判+域名不变）', () => {
  it('localhost/.local/.internal/IP 字面量私网 → true', () => {
    for (const h of ['localhost', 'foo.local', 'svc.internal', '127.0.0.1', '[::1]', '::ffff:127.0.0.1', '192.168.0.1']) {
      expect(isPrivateHostSync(h), h).toBe(true);
    }
  });
  it('公网 IP → false；域名 → false（同步判不了，留给异步 assertPublicUrl，与旧弱版对域名行为一致=零回归）', () => {
    for (const h of ['8.8.8.8', 'example.com', 'attacker.com', 'upload.googleapis.com']) {
      expect(isPrivateHostSync(h), h).toBe(false);
    }
  });
});

describe('SsrfGuard.assertPublicUrl', () => {
  const pubDns = async () => [{ address: '93.184.216.34', family: 4 }];
  it('拒非 http(s) 协议', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/protocol/);
    await expect(assertPublicUrl('ftp://x/')).rejects.toThrow(/protocol/);
  });
  it('拒非白名单端口（挡 22/3306/6379 等内网服务扫描）', async () => {
    await expect(assertPublicUrl('http://example.com:6379/', { dnsResolve: pubDns })).rejects.toThrow(/port/);
    await expect(assertPublicUrl('http://example.com:22/', { dnsResolve: pubDns })).rejects.toThrow(/port/);
  });
  it('拒私网 IP 字面量（含 IPv4-mapped IPv6 这一实测真实绕过）', async () => {
    await expect(assertPublicUrl('http://127.0.0.1/')).rejects.toThrow(/private ip/);
    await expect(assertPublicUrl('http://[::ffff:127.0.0.1]/')).rejects.toThrow(/private ip/);
    await expect(assertPublicUrl('http://2130706433/')).rejects.toThrow(/private ip/); // URL 规范化成 127.0.0.1
  });
  it('拒 DNS rebinding：域名解析到内网 IP（弱版完全无防御的真洞）', async () => {
    const evilDns = async () => [{ address: '10.0.0.5', family: 4 }];
    await expect(assertPublicUrl('http://attacker.com/', { dnsResolve: evilDns })).rejects.toThrow(/private ip/);
  });
  it('拒 DNS 多解析里夹一个内网（任一私网即拒）', async () => {
    const mixedDns = async () => [{ address: '93.184.216.34', family: 4 }, { address: '192.168.1.1', family: 4 }];
    await expect(assertPublicUrl('http://mixed.com/', { dnsResolve: mixedDns })).rejects.toThrow(/private ip/);
  });
  it('放行正常公网域名，返回解析结果（防误杀）', async () => {
    const r = await assertPublicUrl('http://example.com/', { dnsResolve: pubDns });
    expect(r.host).toBe('example.com');
    expect(r.literal).toBe(false);
    expect(r.addresses[0].address).toBe('93.184.216.34');
  });
  it('放行公网 IP 字面量', async () => {
    const r = await assertPublicUrl('http://8.8.8.8/');
    expect(r.literal).toBe(true);
    expect(r.host).toBe('8.8.8.8');
  });
});

describe('SsrfGuard.safeFetchPublicUrl（闭合 DNS rebinding TOCTOU + redirect 逐跳校验）', () => {
  const pubDns = async () => [{ address: '93.184.216.34', family: 4 }];
  const okResp = { status: 200, ok: true, headers: { get: () => 'text/html' }, text: async () => 'ok' };

  it('拒内网 IP 字面量，且连接前就拦（不调 fetch）', async () => {
    let called = 0;
    const fetchImpl = async () => { called += 1; return okResp; };
    await expect(safeFetchPublicUrl('http://127.0.0.1/', { fetchImpl, dnsResolve: pubDns })).rejects.toThrow(/private ip/);
    expect(called).toBe(0);
  });

  it('拒 DNS rebinding（域名解析到内网 IP）', async () => {
    const evilDns = async () => [{ address: '10.0.0.5', family: 4 }];
    const fetchImpl = async () => okResp;
    await expect(safeFetchPublicUrl('http://attacker.com/', { fetchImpl, dnsResolve: evilDns })).rejects.toThrow(/private ip/);
  });

  it('拒"重定向到内网"（每跳重新 assertPublicUrl，这是裸 redirect:follow 防不住的 TOCTOU）', async () => {
    let hop = 0;
    const fetchImpl = async () => {
      hop += 1;
      if (hop === 1) return { status: 302, headers: { get: (k) => (k === 'location' ? 'http://169.254.169.254/' : null) } };
      return okResp;
    };
    await expect(safeFetchPublicUrl('http://example.com/', { fetchImpl, dnsResolve: pubDns })).rejects.toThrow(/private ip/);
  });

  it('放行公网并返回 resp + cleanup', async () => {
    const fetchImpl = async () => okResp;
    const r = await safeFetchPublicUrl('http://example.com/', { fetchImpl, dnsResolve: pubDns });
    expect(r.resp.ok).toBe(true);
    expect(typeof r.cleanup).toBe('function');
    r.cleanup();
  });

  it('限制重定向跳数（防重定向循环）', async () => {
    const fetchImpl = async () => ({ status: 302, headers: { get: (k) => (k === 'location' ? 'http://example.com/next' : null) } });
    await expect(safeFetchPublicUrl('http://example.com/', { fetchImpl, dnsResolve: pubDns, maxRedirects: 2 })).rejects.toThrow(/too many redirects/);
  });

  it('maxRedirects:0 遇 3xx 直接拒（webhook 不跟跳，防跨域转发 secret header）', async () => {
    const fetchImpl = async () => ({ status: 302, headers: { get: (k) => (k === 'location' ? 'http://other.example/' : null) } });
    await expect(safeFetchPublicUrl('http://example.com/', { fetchImpl, dnsResolve: pubDns, maxRedirects: 0 })).rejects.toThrow(/too many redirects/);
  });

  it('超时窗口覆盖到 body 阶段：返回时 signal 未 abort（防先发 header 再无限拖 body 的 DoS）', async () => {
    let sig;
    const fetchImpl = async (u, opts) => { sig = opts.signal; return okResp; };
    const r = await safeFetchPublicUrl('http://example.com/', { fetchImpl, dnsResolve: pubDns, timeoutMs: 10000 });
    expect(sig.aborted).toBe(false); // 返回时 timer 未清，body 读取仍在超时保护下
    r.cleanup(); // 读完 body 后由 caller 调 cleanup 清 timer
    expect(typeof r.cleanup).toBe('function');
  });

  it('fake-ip 段(198.18/15)默认拒绝（防攻击者伪造首次 DNS 返回 fake-ip 关 pin 再 rebind 内网）', async () => {
    const fakeIpDns = async () => [{ address: '198.18.0.9', family: 4 }];
    const fetchImpl = async () => okResp;
    await expect(safeFetchPublicUrl('http://attacker.com/', { fetchImpl, dnsResolve: fakeIpDns })).rejects.toThrow(/fake-ip/);
  });

  it('fake-ip + allowFakeIp opt-in → 放行不 pin（owner 本地可信 Clash 环境）', async () => {
    const fakeIpDns = async () => [{ address: '198.18.0.9', family: 4 }];
    let opts;
    const fetchImpl = async (u, o) => { opts = o; return okResp; };
    const r = await safeFetchPublicUrl('http://example.com/', { fetchImpl, dnsResolve: fakeIpDns, allowFakeIp: true });
    expect(r.resp.ok).toBe(true);
    expect(opts.dispatcher).toBeUndefined(); // 不 pin，兼容代理
  });

  it('真实公网解析 + 无代理(direct) → pin 闭合 TOCTOU', async () => {
    let opts;
    const fetchImpl = async (u, o) => { opts = o; return okResp; };
    await safeFetchPublicUrl('http://example.com/', { fetchImpl, dnsResolve: pubDns, hasProxy: false });
    expect(opts.dispatcher).toBeDefined(); // direct → pin
  });

  it('有全局代理 → 不 pin（走代理抓 GFW 网站；pin 用无代理 Agent 会覆盖代理直连，51835 实测 wikipedia 失败）', async () => {
    let opts;
    const fetchImpl = async (u, o) => { opts = o; return okResp; };
    await safeFetchPublicUrl('http://example.com/', { fetchImpl, dnsResolve: pubDns, hasProxy: true });
    expect(opts.dispatcher).toBeUndefined(); // 有代理 → 不 pin，走全局代理
  });
});

describe('SsrfGuard.createPinnedLookup（fail-closed，不回退裸 DNS）', () => {
  it('host mismatch → 报错不放行（防 pin 绕过）', () => {
    const lookup = createPinnedLookup('example.com', [{ address: '93.184.216.34', family: 4 }]);
    let err;
    lookup('evil.com', {}, (e) => { err = e; });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/mismatch|blocked/);
  });
  it('无已校验公网地址 → 报错不放行', () => {
    const lookup = createPinnedLookup('example.com', []);
    let err;
    lookup('example.com', {}, (e) => { err = e; });
    expect(err).toBeInstanceOf(Error);
  });
  it('host 匹配 + 有公网地址 → 正常返回已校验 IP', () => {
    const lookup = createPinnedLookup('example.com', [{ address: '93.184.216.34', family: 4 }]);
    let addr;
    lookup('example.com', {}, (e, a) => { addr = a; });
    expect(addr).toBe('93.184.216.34');
  });
});
