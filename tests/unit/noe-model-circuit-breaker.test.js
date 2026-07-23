// @ts-nocheck
import { describe, expect, it } from 'vitest';
import {
  NoeModelCircuitBreaker,
  resolveCircuitBreakerConfig,
  getSharedCircuitBreaker,
  __resetSharedCircuitBreakerForTest,
} from '../../src/room/NoeModelCircuitBreaker.js';
import { OpenAICompatChatAdapter } from '../../src/room/OpenAICompatChatAdapter.js';
import { callCloudReviewer } from '../../src/room/NoePostReviewRunner.js';

describe('NoeModelCircuitBreaker', () => {
  it('resolveCircuitBreakerConfig 默认 OFF（零回归）', () => {
    const c = resolveCircuitBreakerConfig({});
    expect(c.enabled).toBe(false);
    expect(c.threshold).toBe(3);
    expect(c.cooldownMs).toBe(60000);
  });

  it('flag ON 解析 enabled + 自定义阈值/冷却', () => {
    const c = resolveCircuitBreakerConfig({
      NOE_MODEL_CIRCUIT_BREAKER: '1',
      NOE_MODEL_CB_THRESHOLD: '5',
      NOE_MODEL_CB_COOLDOWN_MS: '30000',
    });
    expect(c.enabled).toBe(true);
    expect(c.threshold).toBe(5);
    expect(c.cooldownMs).toBe(30000);
  });

  it('误配兜底：threshold>=1、cooldown>=1000', () => {
    const c = resolveCircuitBreakerConfig({
      NOE_MODEL_CIRCUIT_BREAKER: '1',
      NOE_MODEL_CB_THRESHOLD: '0',
      NOE_MODEL_CB_COOLDOWN_MS: '5',
    });
    expect(c.threshold).toBe(3); // 0 falsy → 回落默认 3
    expect(c.cooldownMs).toBe(1000); // 5 < 1000 → 兜底 1000
  });

  it('连续失败达阈值才熔断（未达不短路）', () => {
    const cb = new NoeModelCircuitBreaker({ threshold: 3, cooldownMs: 5000, now: () => 1000 });
    expect(cb.shouldShortCircuit('x')).toBe(false);
    cb.recordFailure('x');
    cb.recordFailure('x');
    expect(cb.shouldShortCircuit('x')).toBe(false); // 2 < 3
    const tripped = cb.recordFailure('x'); // 3 → 熔断
    expect(tripped).toBe(true);
    expect(cb.shouldShortCircuit('x')).toBe(true);
  });

  it('冷却期满放行半开试探', () => {
    let t = 1000;
    const cb = new NoeModelCircuitBreaker({ threshold: 1, cooldownMs: 5000, now: () => t });
    cb.recordFailure('x'); // 熔断 openUntil=6000
    expect(cb.shouldShortCircuit('x')).toBe(true);
    t = 5999;
    expect(cb.shouldShortCircuit('x')).toBe(true); // 仍在冷却
    t = 6000;
    expect(cb.shouldShortCircuit('x')).toBe(false); // 冷却满 → 半开放行
  });

  it('半开成功 → 关闭熔断、清零', () => {
    let t = 1000;
    const cb = new NoeModelCircuitBreaker({ threshold: 1, cooldownMs: 5000, now: () => t });
    cb.recordFailure('x');
    t = 6000;
    cb.recordSuccess('x');
    expect(cb.status('x').failures).toBe(0);
    expect(cb.status('x').openUntil).toBe(0);
    expect(cb.shouldShortCircuit('x')).toBe(false);
  });

  it('半开失败 → 重新熔断（新冷却窗口）', () => {
    let t = 1000;
    const cb = new NoeModelCircuitBreaker({ threshold: 1, cooldownMs: 5000, now: () => t });
    cb.recordFailure('x');
    t = 6000; // 半开
    cb.recordFailure('x'); // 试探失败 → 重新熔断 openUntil=11000
    expect(cb.shouldShortCircuit('x')).toBe(true);
    expect(cb.status('x').openUntil).toBe(11000);
  });

  it('未达阈值时成功清零失败计数（避免误触发）', () => {
    const cb = new NoeModelCircuitBreaker({ threshold: 3, cooldownMs: 5000, now: () => 1000 });
    cb.recordFailure('x');
    cb.recordFailure('x');
    expect(cb.status('x').failures).toBe(2);
    cb.recordSuccess('x');
    expect(cb.status('x').failures).toBe(0);
  });

  it('多 adapter id 独立熔断（xiaomi 熔断不影响 m3）', () => {
    const cb = new NoeModelCircuitBreaker({ threshold: 1, cooldownMs: 5000, now: () => 1000 });
    cb.recordFailure('xiaomi-mimo');
    expect(cb.shouldShortCircuit('xiaomi-mimo')).toBe(true);
    expect(cb.shouldShortCircuit('minimax-m3')).toBe(false);
  });

  it('getSharedCircuitBreaker 单例 + reset 隔离', () => {
    __resetSharedCircuitBreakerForTest();
    const a = getSharedCircuitBreaker();
    const b = getSharedCircuitBreaker();
    expect(a).toBe(b);
    __resetSharedCircuitBreakerForTest();
    const c = getSharedCircuitBreaker();
    expect(c).not.toBe(a);
  });

  it('半开期只放行单个探针（防 thundering herd）', () => {
    let t = 1000;
    const cb = new NoeModelCircuitBreaker({ threshold: 1, cooldownMs: 5000, now: () => t });
    cb.recordFailure('x'); // 熔断 openUntil=6000
    t = 6000; // 冷却满 → 半开
    expect(cb.shouldShortCircuit('x')).toBe(false); // 第一个探针放行
    expect(cb.shouldShortCircuit('x')).toBe(true);  // 第二个被 probing 拦（单探针）
    expect(cb.shouldShortCircuit('x')).toBe(true);  // 后续仍拦
  });

  it('isOpen 纯只读（不占探针位、不影响半开放行）', () => {
    let t = 1000;
    const cb = new NoeModelCircuitBreaker({ threshold: 1, cooldownMs: 5000, now: () => t });
    cb.recordFailure('x');
    expect(cb.isOpen('x')).toBe(true);  // OPEN 冷却中
    expect(cb.isOpen('x')).toBe(true);  // 多次只读不变
    t = 6000;
    expect(cb.isOpen('x')).toBe(false); // 冷却满 → isOpen false（但未占探针位）
    expect(cb.shouldShortCircuit('x')).toBe(false); // 探针位仍可放行（isOpen 无副作用）
  });

  it('误配 Infinity/NaN → 回落默认（threshold 3 / cooldown 60000），防永不/永久熔断', () => {
    const c = resolveCircuitBreakerConfig({
      NOE_MODEL_CIRCUIT_BREAKER: '1',
      NOE_MODEL_CB_THRESHOLD: 'Infinity',
      NOE_MODEL_CB_COOLDOWN_MS: 'NaN',
    });
    expect(c.threshold).toBe(3);
    expect(c.cooldownMs).toBe(60000);
    const cb = new NoeModelCircuitBreaker({ threshold: Infinity, cooldownMs: Infinity, now: () => 1000 });
    expect(cb.threshold).toBe(3);
    expect(cb.cooldownMs).toBe(60000);
  });

  it('LRU 上限：超 maxEntries 淘汰最久未访问的冷 entry（防 custom:<id> 无界增长）', () => {
    const cb = new NoeModelCircuitBreaker({ threshold: 5, cooldownMs: 5000, now: () => 1000, maxEntries: 3 });
    cb.recordFailure('a'); cb.recordFailure('b'); cb.recordFailure('c');
    expect(cb.size()).toBe(3);
    cb.recordFailure('d'); // 超上限 → 淘汰最老 'a'
    expect(cb.size()).toBe(3); // 稳定在上限，不无界增长
  });

  it('LRU：活跃访问的 entry 被 touch 保住、冷的先淘汰', () => {
    const cb = new NoeModelCircuitBreaker({ threshold: 5, cooldownMs: 5000, now: () => 1000, maxEntries: 3 });
    cb.recordFailure('a'); cb.recordFailure('b'); cb.recordFailure('c');
    cb.recordFailure('a'); // touch 'a' → 移末尾、failures=2
    cb.recordFailure('d'); // 超上限 → 淘汰此刻最老的 'b'
    expect(cb.status('a').failures).toBe(2); // 'a' 被 touch 保住（活跃熔断不丢）
    expect(cb.status('b').failures).toBe(0); // 'b' 被淘汰（重建归零）
  });

  it('maxEntries 误配兜底（0 → 默认 512）', () => {
    const c = resolveCircuitBreakerConfig({ NOE_MODEL_CIRCUIT_BREAKER: '1', NOE_MODEL_CB_MAX_ENTRIES: '0' });
    expect(c.maxEntries).toBe(512);
  });
});

describe('circuit breaker × adapter / post-review 集成', () => {
  it('flag OFF：cb 不介入，retry 满 retries+1=3 次（零回归）', async () => {
    delete process.env.NOE_MODEL_CIRCUIT_BREAKER;
    __resetSharedCircuitBreakerForTest();
    let calls = 0;
    const a = new OpenAICompatChatAdapter({ id: 'cb-int-off', apiKey: 'k', baseUrl: 'http://x' });
    a._doChatOnce = async () => { calls += 1; throw new Error('fetch failed'); };
    await expect(a._doChat([{ role: 'user', content: 'x' }])).rejects.toThrow(/fetch failed/);
    expect(calls).toBe(3); // retries=2 → 3 次，cb 未中止（零回归）
  });

  it('flag ON threshold=1：熔断打开即中止当前 retry（首次只发 1 次而非 3 次）+ 后续短路', async () => {
    process.env.NOE_MODEL_CIRCUIT_BREAKER = '1';
    process.env.NOE_MODEL_CB_THRESHOLD = '1';
    __resetSharedCircuitBreakerForTest();
    let calls = 0;
    const a = new OpenAICompatChatAdapter({ id: 'cb-int-on', apiKey: 'k', baseUrl: 'http://x' });
    a._doChatOnce = async () => { calls += 1; throw new Error('fetch failed'); };
    await expect(a._doChat([{ role: 'user', content: 'x' }])).rejects.toThrow();
    expect(calls).toBe(1); // 首次失败即熔断 → 中止剩余 retry（治 finding #2）
    await expect(a._doChat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'MODEL_CIRCUIT_OPEN' });
    expect(calls).toBe(1); // OPEN 短路，未再发 _doChatOnce
    delete process.env.NOE_MODEL_CIRCUIT_BREAKER;
    delete process.env.NOE_MODEL_CB_THRESHOLD;
    __resetSharedCircuitBreakerForTest();
  });

  it('callCloudReviewer：MODEL_CIRCUIT_OPEN 立即 unavailable、不退避不重试（治 finding #1/#3）', async () => {
    let calls = 0;
    const doChat = async () => { calls += 1; const e = new Error('circuit_breaker_open'); e.code = 'MODEL_CIRCUIT_OPEN'; throw e; };
    const raw = await callCloudReviewer('xiaomi', doChat, { attempts: 5 });
    expect(calls).toBe(1); // 短路：只调一次，不退避空转 5 次
    expect(String(raw).length).toBeGreaterThan(0); // 返回 unavailable raw
  });

  it('callCloudReviewer：普通 transient 失败仍重试到 attempts（短路逻辑不误伤正常退避）', async () => {
    let calls = 0;
    const doChat = async () => { calls += 1; throw new Error('fetch failed'); };
    const raw = await callCloudReviewer('xiaomi', doChat, { attempts: 2 });
    expect(calls).toBe(2); // 重试到 attempts
    expect(String(raw).length).toBeGreaterThan(0);
  });
});
