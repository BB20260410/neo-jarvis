import { describe, it, expect } from 'vitest';
import { buildAllowedOrigins, isOriginAllowed } from '../../../src/server/auth/origin-allow.js';

// 原测试是装饰性占位（expect(true).toBe(true)），无论白名单是否工作都通过。
// 改为对抽出的纯函数 isOriginAllowed 做真断言，HTTP middleware 和 WS upgrade 都用它。
describe('Origin 白名单（CSRF 防御）', () => {
  const allowed = buildAllowedOrigins(51835);

  it('白名单含 localhost / 127.0.0.1 / [::1] 三个同源 Origin', () => {
    expect(allowed.has('http://localhost:51835')).toBe(true);
    expect(allowed.has('http://127.0.0.1:51835')).toBe(true);
    expect(allowed.has('http://[::1]:51835')).toBe(true);
    expect(allowed.size).toBe(3);
  });

  it('buildAllowedOrigins 按传入端口构建', () => {
    const other = buildAllowedOrigins(52000);
    expect(other.has('http://localhost:52000')).toBe(true);
    expect(other.has('http://localhost:51835')).toBe(false);
  });

  it('拒绝恶意跨源 Origin', () => {
    expect(isOriginAllowed('http://evil.example.com', allowed)).toBe(false);
    // 子串/前缀伪装也必须拒绝（精确匹配，非 includes）
    expect(isOriginAllowed('http://localhost:51835.evil.com', allowed)).toBe(false);
    expect(isOriginAllowed('http://127.0.0.1:51835@evil.com', allowed)).toBe(false);
    expect(isOriginAllowed('https://localhost:51835', allowed)).toBe(false); // 协议不符
    expect(isOriginAllowed('http://localhost:9999', allowed)).toBe(false);   // 端口不符
  });

  it('允许同源 Origin', () => {
    expect(isOriginAllowed('http://localhost:51835', allowed)).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:51835', allowed)).toBe(true);
  });

  it('无 Origin 头放行（curl / Electron / 内部请求）', () => {
    expect(isOriginAllowed(undefined, allowed)).toBe(true);
    expect(isOriginAllowed('', allowed)).toBe(true);
    expect(isOriginAllowed(null, allowed)).toBe(true);
  });
});
