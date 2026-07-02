// tests/unit/license-manager.test.js
// 测试 LicenseManager 核心行为：签发/验签/过期/篡改/tier 判断
// 自包含测试密钥对，不依赖外部私钥。
// ⚠️ 事故复盘（2026-06-10）：本文件曾自称"不读写真实 LICENSE_PATH"，但 afterEach 在恢复
// fs spy 之后调 clearLicense()，按真实 HOME 路径把 owner 已激活的 ~/.noe-panel/license.txt
// 真删了（生产回落 free 层、MCP 创建 402）。根治：下方把 NOE_LICENSE_PATH 指到 mkdtemp
// 临时目录，本文件全部读写/删除只作用于临时目录；文末有"绝不删真实文件"的回归测试。

import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

// ─── 测试专用 Ed25519 密钥对（每次测试自签自验）─────────────────────────────
const { privateKey: TEST_PRIVATE_KEY, publicKey: TEST_PUBLIC_KEY } =
  crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

import {
  signLicense,
  verifyLicense,
  FREE_FEATURES,
  PRO_FEATURES,
  TEAM_FEATURES,
} from '../../src/license/LicenseManager.js';

// ─── license 路径隔离（根治"单测误删真 license"）────────────────────────────
// LicenseManager 的 licensePath() 调用时解析 NOE_LICENSE_PATH，所以在 import 之后
// 设置也生效。路径里保留 `.noe-panel` 段，兼容下方 fs spy 的 includes('.noe-panel') 匹配。
// 注：fs 在本文件后半段 import（ESM 提升，此处可用）。
const TEST_LICENSE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'noe-license-test-'));
process.env.NOE_LICENSE_PATH = path.join(TEST_LICENSE_DIR, '.noe-panel', 'license.txt');

afterAll(() => {
  delete process.env.NOE_LICENSE_PATH;
  try { fs.rmSync(TEST_LICENSE_DIR, { recursive: true, force: true }); } catch { /* 清理失败不影响测试结论 */ }
});

// ─── 辅助：用测试密钥签发并用测试公钥验签 ────────────────────────────────────
function sign(payload) {
  return signLicense(payload, TEST_PRIVATE_KEY);
}
function verify(licenseStr) {
  return verifyLicense(licenseStr, TEST_PUBLIC_KEY);
}

// ─── 测试 getCurrentTier / isPro / isTeam / hasFeature ──────────────────────
// 这些函数依赖 loadLicense()，而 loadLicense 读文件系统。
// 通过 vi.mock 替换 fs 模块注入虚拟 license 内容，避免读写真实文件。
// ──────────────────────────────────────────────────────────────────────────────

describe('signLicense + verifyLicense（自包含密钥对）', () => {
  it('pro tier：签发后验签成功，payload 字段完整', () => {
    const lic = sign({ tier: 'pro', email: 'test@example.com' });
    const result = verify(lic);
    expect(result.valid).toBe(true);
    expect(result.payload.tier).toBe('pro');
    expect(result.payload.email).toBe('test@example.com');
    expect(result.payload.version).toBe(1);
    expect(typeof result.payload.issuedAt).toBe('number');
    expect(result.payload.expiresAt).toBe(0); // 默认永久
  });

  it('free tier：features 为 FREE_FEATURES', () => {
    const lic = sign({ tier: 'free' });
    const result = verify(lic);
    expect(result.valid).toBe(true);
    expect(result.payload.features).toEqual(FREE_FEATURES);
  });

  it('pro tier：features 为 PRO_FEATURES', () => {
    const lic = sign({ tier: 'pro' });
    const result = verify(lic);
    expect(result.valid).toBe(true);
    expect(result.payload.features).toEqual(PRO_FEATURES);
  });

  it('team tier：features 为 TEAM_FEATURES（包含 workspaces）', () => {
    const lic = sign({ tier: 'team' });
    const result = verify(lic);
    expect(result.valid).toBe(true);
    expect(result.payload.features).toEqual(TEAM_FEATURES);
    expect(result.payload.features).toContain('workspaces');
    expect(result.payload.features).toContain('priority-support');
  });

  it('expiresAt 为未来时间：license 有效', () => {
    vi.useFakeTimers();
    const futureTs = Math.floor(Date.now() / 1000) + 3600; // 1小时后
    const lic = sign({ tier: 'pro', expiresAt: futureTs });
    const result = verify(lic);
    expect(result.valid).toBe(true);
    expect(result.payload.expiresAt).toBe(futureTs);
    vi.useRealTimers();
  });
});

describe('verifyLicense —— 过期检测', () => {
  it('expiresAt 为过去时间：返回 expired 错误', () => {
    vi.useFakeTimers();
    // 签发时 now = 1000，expiresAt = 999（已过期）
    vi.setSystemTime(1000 * 1000); // ms
    const expiredTs = Math.floor(Date.now() / 1000) - 1; // 1秒前
    const lic = sign({ tier: 'pro', expiresAt: expiredTs });

    // 验签时推进 1 秒确保一定过期
    vi.advanceTimersByTime(2000);
    const result = verify(lic);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('expired');
    expect(result.payload).toBeDefined();
    vi.useRealTimers();
  });

  it('expiresAt = 0（永久）：不因过期而失效', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-01-01'));
    const lic = sign({ tier: 'pro', expiresAt: 0 });
    const result = verify(lic);
    expect(result.valid).toBe(true);
    vi.useRealTimers();
  });
});

describe('verifyLicense —— 篡改检测', () => {
  it('修改 payload 后签名不匹配', () => {
    const lic = sign({ tier: 'pro' });
    const [payloadB64, sigB64] = lic.split('.');

    // 篡改 payload：将 pro 改成 team
    const original = Buffer.from(
      payloadB64.replace(/-/g, '+').replace(/_/g, '/').padEnd(
        payloadB64.length + (4 - payloadB64.length % 4) % 4,
        '=',
      ),
      'base64',
    ).toString('utf8');
    const tampered = original.replace('"tier":"pro"', '"tier":"team"');
    const tamperedB64 = Buffer.from(tampered)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const tamperedLic = `${tamperedB64}.${sigB64}`;
    const result = verify(tamperedLic);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('sig-mismatch');
  });

  it('替换签名段后验签失败', () => {
    const lic1 = sign({ tier: 'pro' });
    const lic2 = sign({ tier: 'team' });
    const [payload1] = lic1.split('.');
    const [, sig2] = lic2.split('.');
    const crossed = `${payload1}.${sig2}`;
    const result = verify(crossed);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('sig-mismatch');
  });
});

describe('verifyLicense —— 空/格式错输入', () => {
  it('空字符串：返回 empty-license', () => {
    expect(verifyLicense('')).toMatchObject({ valid: false, error: 'empty-license' });
  });

  it('null：返回 empty-license', () => {
    expect(verifyLicense(null)).toMatchObject({ valid: false, error: 'empty-license' });
  });

  it('undefined：返回 empty-license', () => {
    expect(verifyLicense(undefined)).toMatchObject({ valid: false, error: 'empty-license' });
  });

  it('数字类型：返回 empty-license', () => {
    expect(verifyLicense(12345)).toMatchObject({ valid: false, error: 'empty-license' });
  });

  it('只有一段（无点分隔）：返回 bad-format', () => {
    expect(verifyLicense('onlyone')).toMatchObject({ valid: false, error: 'bad-format' });
  });

  it('三段（多余点）：返回 bad-format', () => {
    expect(verifyLicense('a.b.c')).toMatchObject({ valid: false, error: 'bad-format' });
  });

  it('payload 非 JSON（即使签名格式正确）：捕获异常不崩溃', () => {
    // 构造一个格式正确但 payload 非 JSON 的 license
    // 用测试私钥对非 JSON payload 签名，这样能通过 sig 校验但 JSON.parse 会抛
    const badPayload = Buffer.from('not-json');
    const sig = crypto.sign(null, badPayload, TEST_PRIVATE_KEY);
    const b64url = (buf) =>
      Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const lic = `${b64url(badPayload)}.${b64url(sig)}`;
    const result = verify(lic);
    expect(result.valid).toBe(false);
    // JSON.parse 报错会被 catch，error 为错误信息字符串
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
  });

  it('tier 不合法（unknown）：返回 bad-tier', () => {
    // 用测试密钥签发一个 tier=unknown 的 payload
    const payload = JSON.stringify({ tier: 'unknown', version: 1, issuedAt: 0, expiresAt: 0, features: [] });
    const sig = crypto.sign(null, Buffer.from(payload), TEST_PRIVATE_KEY);
    const b64url = (buf) =>
      Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const lic = `${b64url(payload)}.${b64url(sig)}`;
    const result = verify(lic);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('bad-tier');
  });
});

// ─── tier 判断测试：通过 spy fs + 重置 LicenseManager 缓存 ───────────────────
// loadLicense 有 5s 内存缓存；通过 clearLicense() 把 cached 置 null 后
// 再调用 loadLicense({ force: true }) 强制重新读取（绕过 5s 缓存窗口）。
// verifyLicense 使用内嵌公钥；为让 loadLicense 产生 valid=true 结果，
// 此处用 vi.spyOn(crypto, 'verify') 让签名校验通过，并构造合法格式的 license 字符串。

import fs from 'node:fs';
import {
  loadLicense,
  getCurrentTier,
  isPro,
  isTeam,
  hasFeature,
  clearLicense,
} from '../../src/license/LicenseManager.js';

// base64url 工具（与源码一致）
const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function makeLicenseStr(tier, features, extra = {}) {
  const payload = JSON.stringify({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    expiresAt: 0,
    features,
    tier,
    ...extra,
  });
  // 用测试私钥签；loadLicense 调用 verifyLicense 时我们会 spy crypto.verify 让其通过
  const sig = crypto.sign(null, Buffer.from(payload), TEST_PRIVATE_KEY);
  return `${b64url(payload)}.${b64url(sig)}`;
}

describe('getCurrentTier / isPro / isTeam / hasFeature', () => {
  let existsSyncSpy;
  let readFileSyncSpy;
  let cryptoVerifySpy;

  afterEach(() => {
    existsSyncSpy?.mockRestore();
    readFileSyncSpy?.mockRestore();
    cryptoVerifySpy?.mockRestore();
    // 重置 LicenseManager 模块级缓存（cached=null）。clearLicense 也会删 license 文件，
    // 但 NOE_LICENSE_PATH 已指向 mkdtemp 临时目录——真实 ~/.noe-panel/license.txt 绝不被触碰。
    clearLicense();
  });

  it('无 license 文件时：tier=free，valid=false，isPro=false，isTeam=false', () => {
    existsSyncSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      if (typeof p === 'string' && p.includes('.noe-panel')) return false;
      return fs.existsSync.wrappedValue ? fs.existsSync.wrappedValue(p) : false;
    });
    // 强制清缓存，让 loadLicense 重新走 fs
    // 先把 cached 清掉——调用 spy 后直接 force=true
    const res = loadLicense({ force: true });
    expect(res.tier).toBe('free');
    expect(res.valid).toBe(false);
    expect(res.error).toBe('no-license');
    expect(getCurrentTier()).toBe('free');
    expect(isPro()).toBe(false);
    expect(isTeam()).toBe(false);
    expect(hasFeature('chat')).toBe(true);    // FREE_FEATURES 包含 chat
    expect(hasFeature('squad')).toBe(false);  // squad 是 PRO+
  });

  it('pro license 时：tier=pro，isPro=true，isTeam=false，squad/arena 可用，workspaces 不可用', () => {
    const licStr = makeLicenseStr('pro', PRO_FEATURES, { email: 'pro@test.com' });
    existsSyncSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      if (typeof p === 'string' && p.includes('.noe-panel')) return true;
      return false;
    });
    readFileSyncSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((p, _enc) => {
      if (typeof p === 'string' && p.includes('.noe-panel')) return licStr;
      throw new Error(`unexpected readFileSync: ${p}`);
    });
    // spy crypto.verify：让内嵌公钥的验签通过
    cryptoVerifySpy = vi.spyOn(crypto, 'verify').mockImplementation((alg, data, key, sig) => {
      if (typeof key === 'string' && key.includes('MCowBQYDK2Vw')) return true;
      return crypto.verify(alg, data, key, sig);
    });

    const res = loadLicense({ force: true });
    expect(res.valid).toBe(true);
    expect(res.tier).toBe('pro');
    expect(getCurrentTier()).toBe('pro');
    expect(isPro()).toBe(true);
    expect(isTeam()).toBe(false);
    expect(hasFeature('squad')).toBe(true);
    expect(hasFeature('arena')).toBe(true);
    expect(hasFeature('workspaces')).toBe(false);
  });

  it('team license 时：tier=team，isPro=true，isTeam=true，workspaces/priority-support 可用', () => {
    const licStr = makeLicenseStr('team', TEAM_FEATURES, { email: 'team@test.com' });
    existsSyncSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      if (typeof p === 'string' && p.includes('.noe-panel')) return true;
      return false;
    });
    readFileSyncSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((p, _enc) => {
      if (typeof p === 'string' && p.includes('.noe-panel')) return licStr;
      throw new Error(`unexpected readFileSync: ${p}`);
    });
    cryptoVerifySpy = vi.spyOn(crypto, 'verify').mockImplementation((alg, data, key, sig) => {
      if (typeof key === 'string' && key.includes('MCowBQYDK2Vw')) return true;
      return crypto.verify(alg, data, key, sig);
    });

    const res = loadLicense({ force: true });
    expect(res.valid).toBe(true);
    expect(res.tier).toBe('team');
    expect(getCurrentTier()).toBe('team');
    expect(isPro()).toBe(true);
    expect(isTeam()).toBe(true);
    expect(hasFeature('workspaces')).toBe(true);
    expect(hasFeature('priority-support')).toBe(true);
    expect(hasFeature('chat')).toBe(true);
  });
});

// ─── 回归：单测绝不删真实 license 文件（2026-06-10 误删事故）──────────────────
// 不依赖真 ~/.noe-panel/license.txt 存在：用 fixture 目录模拟"真实 HOME 下的 license"
// 语义，验证 NOE_LICENSE_PATH 覆盖生效后，clearLicense/loadLicense 只作用于覆盖路径。

describe('回归：clearLicense 只作用于 NOE_LICENSE_PATH 覆盖路径', () => {
  it('clearLicense 删的是覆盖路径文件；模拟"真实路径"的 fixture 安然无恙', () => {
    const fakeRealHome = fs.mkdtempSync(path.join(os.tmpdir(), 'noe-fake-real-home-'));
    const fakeRealLicense = path.join(fakeRealHome, '.noe-panel', 'license.txt');
    fs.mkdirSync(path.dirname(fakeRealLicense), { recursive: true });
    fs.writeFileSync(fakeRealLicense, 'fixture-license-content');
    try {
      const overridePath = process.env.NOE_LICENSE_PATH;
      expect(overridePath).toContain(TEST_LICENSE_DIR); // 覆盖确实生效（指向本套件临时目录）
      fs.mkdirSync(path.dirname(overridePath), { recursive: true });
      fs.writeFileSync(overridePath, 'temp-license');
      clearLicense();
      expect(fs.existsSync(overridePath)).toBe(false);   // 删的是覆盖路径
      expect(fs.existsSync(fakeRealLicense)).toBe(true); // "真实文件"fixture 跑完仍在
      expect(fs.readFileSync(fakeRealLicense, 'utf8')).toBe('fixture-license-content');
    } finally {
      fs.rmSync(fakeRealHome, { recursive: true, force: true });
    }
  });

  it('loadLicense 读的也是覆盖路径（写入坏格式文件 → bad-format 而非 no-license）', () => {
    const overridePath = process.env.NOE_LICENSE_PATH;
    fs.mkdirSync(path.dirname(overridePath), { recursive: true });
    fs.writeFileSync(overridePath, 'garbage');
    const res = loadLicense({ force: true });
    expect(res.valid).toBe(false);
    expect(res.error).toBe('bad-format'); // 证明读到了覆盖路径上的文件而非"文件不存在"
    clearLicense();
    expect(loadLicense({ force: true }).error).toBe('no-license');
  });
});
