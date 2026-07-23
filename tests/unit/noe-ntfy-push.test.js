import { describe, expect, it } from 'vitest';
import { createNtfyPusher, formatNtfyMessage, DEFAULT_PUSH_TYPES } from '../../src/runtime/NoeNtfyPush.js';

// Top100 #63 测试：关键事件推手机（fetch 注入不真发）。

describe('formatNtfyMessage', () => {
  it('hang 告警 → 高优先级 + 分钟数详情', () => {
    const m = formatNtfyMessage({ type: 'noe_hang_alert', alert: { taskId: 'act-9', silentMs: 600000 } });
    expect(m.title).toContain('卡住');
    expect(m.message).toContain('act-9');
    expect(m.message).toContain('10 分钟');
    expect(m.priority).toBe(4);
  });

  it('死前交接 → summary 截 400 字', () => {
    const m = formatNtfyMessage({ type: 'noe_turn_finalized', summary: 'x'.repeat(900) });
    expect(m.message.length).toBe(400);
  });

  it('死前交接含 secret → 推送到公共 ntfy 前已脱敏', () => {
    const m = formatNtfyMessage({ type: 'noe_turn_finalized', summary: 'handoff sk-abcdefghijklmnopqrstuvwxyz0123 done' });
    expect(m.message).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
    expect(m.message).toContain('[redacted');
  });

  it('非关键类型(高频 tick/metrics)不推', () => {
    expect(formatNtfyMessage({ type: 'noe_loop_tick' })).toBe(null);
    expect(formatNtfyMessage({ type: 'metrics_update' })).toBe(null);
    expect(formatNtfyMessage(null)).toBe(null);
  });

  it('默认类型与 StickyEvents 关键集对齐', () => {
    for (const t of ['noe_hang_alert', 'noe_turn_finalized', 'chat_finalizer', 'room_auto_paused']) {
      expect(DEFAULT_PUSH_TYPES).toContain(t);
    }
  });
});

describe('createNtfyPusher', () => {
  it('JSON publish 到 base 根路径，body 含 topic/title/message（UTF-8 安全）', async () => {
    const sent = [];
    const p = createNtfyPusher({ topic: 'noe-hxx', fetchImpl: async (url, init) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); return {}; } });
    expect(p.enabled).toBe(true);
    const pushed = p.push({ type: 'room_auto_paused', reason: '连续 5 次失败' });
    expect(pushed).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://ntfy.sh');
    expect(sent[0].body.topic).toBe('noe-hxx');
    expect(sent[0].body.message).toContain('连续 5 次失败');
  });

  it('无 topic → 禁用态 no-op', () => {
    const p = createNtfyPusher({});
    expect(p.enabled).toBe(false);
    expect(p.push({ type: 'noe_hang_alert', alert: {} })).toBe(false);
  });

  it('推送失败 fail-soft 不抛（fire-and-forget）', async () => {
    const logs = [];
    const p = createNtfyPusher({ topic: 't', fetchImpl: async () => { throw new Error('net down'); }, log: (...a) => logs.push(a.join(' ')) });
    expect(() => p.push({ type: 'noe_hang_alert', alert: { taskId: 'a', silentMs: 1 } })).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
    expect(logs.join(' ')).toContain('net down');
  });
});
