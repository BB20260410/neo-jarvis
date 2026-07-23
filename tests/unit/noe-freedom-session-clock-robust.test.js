import { describe, it, expect } from 'vitest';
import { createNoeFreedomSession, createNoeFreedomSessionStore } from '../../src/runtime/NoeFreedomSessionStore.js';

// 强健加固(批3):nowIso(注入式 now)若返回非 Date 且非有限值/Invalid Date/抛错,
// 原 new Date(value).toISOString() 会抛 RangeError 崩 session 创建。加固=降级当前时间。
// 合法 Date / 数值毫秒注入逐字等价。

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('NoeFreedomSession 注入时钟强健性', () => {
  it('坏注入时钟(undefined/字符串/NaN/Invalid Date/抛错)→不崩,createdAt 仍为合法 ISO', () => {
    const brokenClocks = [
      () => undefined,
      () => 'not-a-date',
      () => NaN,
      () => new Date(NaN),
      () => { throw new Error('clock boom'); },
    ];
    for (const now of brokenClocks) {
      let out;
      expect(() => { out = createNoeFreedomSession({ mode: 'developer_unrestricted', ownerPresent: true, now }); }).not.toThrow();
      expect(out.ok).toBe(true);
      expect(out.session.createdAt).toMatch(ISO_RE);
    }
  });

  it('store.start 同样不被坏时钟崩', () => {
    const store = createNoeFreedomSessionStore({ now: () => undefined });
    let out;
    expect(() => { out = store.start({ mode: 'developer_unrestricted', ownerPresent: true }); }).not.toThrow();
    expect(out.ok).toBe(true);
    expect(out.session.createdAt).toMatch(ISO_RE);
  });

  it('合法 Date 注入逐字等价(零回归)', () => {
    const fixed = new Date('2026-06-14T08:30:00.000Z');
    const out = createNoeFreedomSession({ mode: 'developer_unrestricted', ownerPresent: true, now: () => fixed });
    expect(out.ok).toBe(true);
    expect(out.session.createdAt).toBe('2026-06-14T08:30:00.000Z');
  });

  it('合法数值毫秒注入逐字等价(零回归)', () => {
    const ms = Date.parse('2026-06-14T08:30:00.000Z');
    const out = createNoeFreedomSession({ mode: 'developer_unrestricted', ownerPresent: true, now: () => ms });
    expect(out.ok).toBe(true);
    expect(out.session.createdAt).toBe(new Date(ms).toISOString());
  });
});
