import { describe, expect, it } from 'vitest';
import { createStickyEventBuffer, DEFAULT_STICKY_TYPES } from '../../src/runtime/NoeStickyEvents.js';

// T27 接线测试：关键事件粘性缓存，断线重连补发。

describe('createStickyEventBuffer', () => {
  it('关键类型入缓存，非关键(高频)不入', () => {
    const buf = createStickyEventBuffer();
    expect(buf.consider({ type: 'noe_hang_alert', alert: { taskId: 'a' } })).toBe(true);
    expect(buf.consider({ type: 'metrics_update', cpu: 1 })).toBe(false);
    expect(buf.consider({ type: 'noe_loop_tick' })).toBe(false);
    expect(buf.size()).toBe(1);
  });

  it('replay 返回副本并标 replay:true（前端可区分补发）', () => {
    const buf = createStickyEventBuffer();
    buf.consider({ type: 'chat_finalizer', message: { content: '交接' } });
    const replayed = buf.replay();
    expect(replayed).toHaveLength(1);
    expect(replayed[0].replay).toBe(true);
    expect(replayed[0].type).toBe('chat_finalizer');
    expect(replayed[0].ts).toBeGreaterThan(0);
  });

  it('FIFO 超容量挤掉最旧', () => {
    const buf = createStickyEventBuffer({ capacity: 3, types: ['x'] });
    for (let i = 1; i <= 5; i += 1) buf.consider({ type: 'x', n: i });
    expect(buf.size()).toBe(3);
    expect(buf.replay().map((m) => m.n)).toEqual([3, 4, 5]);
  });

  it('默认类型覆盖关键告警/交接/暂停', () => {
    for (const t of ['noe_hang_alert', 'noe_turn_finalized', 'chat_finalizer', 'room_auto_paused']) {
      expect(DEFAULT_STICKY_TYPES).toContain(t);
    }
  });

  it('无 type 的消息不入缓存', () => {
    const buf = createStickyEventBuffer();
    expect(buf.consider({})).toBe(false);
    expect(buf.consider(null)).toBe(false);
  });
});
