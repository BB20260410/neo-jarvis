import { describe, it, expect } from 'vitest';
import { createLoraVersionRegistry } from '../../src/weights/NoeLoraVersionRegistry.js';

function memRegistry() {
  let state = null;
  return createLoraVersionRegistry({
    read: () => state,
    write: (o) => { state = JSON.parse(JSON.stringify(o)); },
    now: (() => { let t = 0; return () => (t += 1000); })(),
  });
}

describe('createLoraVersionRegistry（P5-3 版本化+回滚）', () => {
  it('登记版本 + 重复 version 拒（不可覆盖历史）', () => {
    const r = memRegistry();
    expect(r.register({ version: 'v1', evalScore: 0.8, dataFingerprint: 'fp1', adapterPath: '/a/v1' }).ok).toBe(true);
    expect(r.register({ version: 'v1', evalScore: 0.9 })).toMatchObject({ ok: false, reason: 'version_exists' });
    expect(r.list().length).toBe(1);
  });

  it('list/get/评测分可追溯', () => {
    const r = memRegistry();
    r.register({ version: 'v1', evalScore: 0.8 });
    r.register({ version: 'v2', evalScore: 0.85 });
    expect(r.list().map((x) => x.version)).toEqual(['v2', 'v1']); // 按时间倒序
    expect(r.get('v1').evalScore).toBe(0.8);
    expect(r.get('nope')).toBeNull();
  });

  it('setActive + current', () => {
    const r = memRegistry();
    r.register({ version: 'v1' });
    r.register({ version: 'v2' });
    expect(r.setActive('v2').ok).toBe(true);
    expect(r.current().version).toBe('v2');
    expect(r.setActive('ghost')).toMatchObject({ ok: false, reason: 'unknown_version' });
  });

  it('revertTo 任意历史版本（指针移动，历史不删，真可逆）', () => {
    const r = memRegistry();
    r.register({ version: 'v1', adapterPath: '/a/v1', evalScore: 0.8 });
    r.register({ version: 'v2', adapterPath: '/a/v2', evalScore: 0.6 }); // v2 训坏了
    r.setActive('v2');
    const rb = r.revertTo('v1');
    expect(rb).toMatchObject({ ok: true, revertedFrom: 'v2', revertedTo: 'v1', adapterPath: '/a/v1' });
    expect(r.current().version).toBe('v1');
    expect(r.list().length).toBe(2); // v2 仍在册（可再切回），未删
    expect(r.revertTo('ghost').ok).toBe(false);
  });
});
