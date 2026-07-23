// 单元测试：src/webhook/WebhookDispatcher.js
// 覆盖：buildPayload 三种格式 + 事件映射 + fireWebhooks 过滤与调度 + testWebhook

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── mock WebhookStore（避免读写真实文件系统） ──────────────────────────────
vi.mock('../../src/webhook/WebhookStore.js', () => {
  const items = [];
  const webhookStore = {
    _items: items,
    list({ mask: _mask = true } = {}) { return items; },
    bumpStats: vi.fn(),
  };
  return { webhookStore };
});

// 测试不做真实网络/DNS：mock SsrfGuard.safeFetchPublicUrl 转发到被 stub 的全局 fetch（保 fetch spy）。
// 真实 SSRF/DNS-rebinding/逐跳校验逻辑由 ssrf-guard.test.js 覆盖。
vi.mock('../../src/security/SsrfGuard.js', () => ({
  safeFetchPublicUrl: async (url, opts = {}) => {
    const resp = await globalThis.fetch(url, { method: opts.method, headers: opts.headers, body: opts.body });
    return { resp, finalUrl: url, cleanup: () => {} };
  },
}));

import { buildPayload, fireWebhooks, testWebhook } from '../../src/webhook/WebhookDispatcher.js';
import { webhookStore } from '../../src/webhook/WebhookStore.js';

// ── 辅助：构造标准 ctx ────────────────────────────────────────────────────
const baseCtx = (overrides = {}) => ({
  roomName: 'TestRoom',
  mode: 'debate',
  eventCategory: 'room_done',
  eventType: 'debate_done',
  error: undefined,
  reason: undefined,
  summary: '这是摘要',
  panelUrl: 'http://localhost:51835',
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
describe('buildPayload — discord 格式', () => {
  it('room_done：content 含房间名 + embed title 一致', () => {
    const p = buildPayload('discord', baseCtx());
    expect(p.content).toContain('TestRoom');
    expect(p.embeds).toHaveLength(1);
    expect(p.embeds[0].title).toBe(p.content);
  });

  it('外发到第三方前对 summary/error 脱敏(secret 不出 webhook)', () => {
    const p = buildPayload('discord', baseCtx({ summary: '结论 sk-abcdefghijklmnopqrstuvwxyz0123 完成' }));
    expect(p.embeds[0].description).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
    expect(p.embeds[0].description).toContain('[redacted');
    const j = buildPayload('json', baseCtx({ summary: 'x', error: 'ANTHROPIC_API_KEY=sk-zzzzzzzzzzzzzzzzzzzzzzzz' }));
    expect(JSON.stringify(j)).not.toContain('sk-zzzzzzzzzzzzzzzzzzzzzzzz');
  });

  it('room_done：embed.color === 0x2da44e（绿色）', () => {
    const p = buildPayload('discord', baseCtx());
    expect(p.embeds[0].color).toBe(0x2da44e);
  });

  it('room_done：embed.description === summary（截取前 1500 字）', () => {
    const p = buildPayload('discord', baseCtx({ summary: '摘要内容' }));
    expect(p.embeds[0].description).toBe('摘要内容');
  });

  it('room_done：summary 超长时截取到 1500 字', () => {
    const longSummary = 'x'.repeat(2000);
    const p = buildPayload('discord', baseCtx({ summary: longSummary }));
    expect(p.embeds[0].description.length).toBe(1500);
  });

  it('room_done：summary 为空时 description === "（无摘要）"', () => {
    const p = buildPayload('discord', baseCtx({ summary: '' }));
    expect(p.embeds[0].description).toBe('（无摘要）');
  });

  it('room_error：color === 0xdc3545（红色）+ title 含 ❌', () => {
    const p = buildPayload('discord', baseCtx({
      eventCategory: 'room_error',
      eventType: 'debate_error',
      error: '超时',
    }));
    expect(p.embeds[0].color).toBe(0xdc3545);
    expect(p.embeds[0].title).toContain('❌');
    expect(p.embeds[0].description).toContain('超时');
  });

  it('room_error：error 超长时截取到 500 字', () => {
    const longError = 'e'.repeat(600);
    const p = buildPayload('discord', baseCtx({
      eventCategory: 'room_error',
      error: longError,
    }));
    expect(p.embeds[0].description.length).toBe(500);
  });

  it('room_auto_paused：color === 0xc15f3c + title 含 🛑', () => {
    const p = buildPayload('discord', baseCtx({
      eventCategory: 'room_auto_paused',
      eventType: 'room_auto_paused',
      reason: '连续失败',
    }));
    expect(p.embeds[0].color).toBe(0xc15f3c);
    expect(p.embeds[0].title).toContain('🛑');
    expect(p.embeds[0].description).toBe('连续失败');
  });

  it('embed.footer.text === "Noe"', () => {
    const p = buildPayload('discord', baseCtx());
    expect(p.embeds[0].footer.text).toBe('Noe');
  });

  it('embed.timestamp 是合法 ISO 字符串', () => {
    const p = buildPayload('discord', baseCtx());
    expect(() => new Date(p.embeds[0].timestamp)).not.toThrow();
    expect(new Date(p.embeds[0].timestamp).getTime()).toBeGreaterThan(0);
  });

  it('panelUrl 透传到 embed.url', () => {
    const p = buildPayload('discord', baseCtx({ panelUrl: 'http://localhost:12345' }));
    expect(p.embeds[0].url).toBe('http://localhost:12345');
  });

  it('mode=squad 时 emoji 和模式标签正确', () => {
    const p = buildPayload('discord', baseCtx({ mode: 'squad' }));
    expect(p.content).toContain('👥');
    expect(p.content).toContain('小组');
  });

  it('未知 mode 时 emoji 为 🤖', () => {
    const p = buildPayload('discord', baseCtx({ mode: 'unknown' }));
    expect(p.content).toContain('🤖');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('buildPayload — slack 格式', () => {
  it('room_done：text 含房间名 + attachments[0].color === "good"', () => {
    const p = buildPayload('slack', baseCtx());
    expect(p.text).toContain('TestRoom');
    expect(p.attachments).toHaveLength(1);
    expect(p.attachments[0].color).toBe('good');
  });

  it('room_error：attachment.color === "danger"', () => {
    const p = buildPayload('slack', baseCtx({
      eventCategory: 'room_error',
      error: '崩了',
    }));
    expect(p.attachments[0].color).toBe('danger');
  });

  it('room_auto_paused：attachment.color === "warning"', () => {
    const p = buildPayload('slack', baseCtx({
      eventCategory: 'room_auto_paused',
      reason: '暂停原因',
    }));
    expect(p.attachments[0].color).toBe('warning');
  });

  it('ts 是整数（秒级时间戳）', () => {
    const p = buildPayload('slack', baseCtx());
    expect(Number.isInteger(p.attachments[0].ts)).toBe(true);
    expect(p.attachments[0].ts).toBeGreaterThan(0);
  });

  it('attachments[0].text 包含 summary', () => {
    const p = buildPayload('slack', baseCtx({ summary: '小组摘要' }));
    expect(p.attachments[0].text).toBe('小组摘要');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('buildPayload — json 格式', () => {
  it('包含所有必要字段：event / eventType / roomName / mode / body / at', () => {
    const p = buildPayload('json', baseCtx());
    expect(p.event).toBe('room_done');
    expect(p.eventType).toBe('debate_done');
    expect(p.roomName).toBe('TestRoom');
    expect(p.mode).toBe('debate');
    expect(typeof p.at).toBe('string');
    expect(() => new Date(p.at)).not.toThrow();
  });

  it('room_error：error 字段透传', () => {
    const p = buildPayload('json', baseCtx({
      eventCategory: 'room_error',
      error: '错误详情',
    }));
    expect(p.error).toBe('错误详情');
  });

  it('room_auto_paused：reason 字段透传', () => {
    const p = buildPayload('json', baseCtx({
      eventCategory: 'room_auto_paused',
      reason: '原因说明',
    }));
    expect(p.reason).toBe('原因说明');
  });

  it('room_done：body === summary（截取前 1500 字）', () => {
    const p = buildPayload('json', baseCtx({ summary: '短摘要' }));
    expect(p.body).toBe('短摘要');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('buildPayload — 未知 eventCategory（fallback 分支）', () => {
  it('title 含 eventType，body 为空字符串', () => {
    const p = buildPayload('json', baseCtx({
      eventCategory: 'unknown_event',
      eventType: 'custom_type',
    }));
    expect(p.eventType).toBe('custom_type');
    // json 格式 body 由 buildPayload 计算，fallback 分支 body = ''
    expect(p.body).toBe('');
  });

  it('discord fallback：color === 0x6c757d（灰色）', () => {
    const p = buildPayload('discord', baseCtx({
      eventCategory: 'unknown_event',
      eventType: 'custom_type',
    }));
    expect(p.embeds[0].color).toBe(0x6c757d);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('EVENT_MAP 事件映射（通过 fireWebhooks 验证）', () => {
  beforeEach(() => {
    webhookStore._items.length = 0;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const mappingCases = [
    ['debate_done',     'room_done'],
    ['squad_done',      'room_done'],
    ['arena_done',      'room_done'],
    ['debate_error',    'room_error'],
    ['squad_error',     'room_error'],
    ['arena_error',     'room_error'],
    ['chat_error',      'room_error'],
    ['room_auto_paused','room_auto_paused'],
  ];

  it.each(mappingCases)('%s → eventCategory %s：fetch 被调用', async (msgType, expectedCategory) => {
    const wh = {
      id: 'wh-test',
      enabled: true,
      events: [expectedCategory],
      roomFilter: '*',
      url: 'https://example.com/webhook',
      format: 'json',
      headers: {},
    };
    webhookStore._items.push(wh);

    await fireWebhooks('room-1', { type: msgType }, { name: 'R', mode: 'debate' });

    // fire-and-forget: 等微任务刷完
    await new Promise((r) => setTimeout(r, 0));
    expect(fetch).toHaveBeenCalledOnce();

    const [url, opts] = fetch.mock.calls[0];
    expect(url).toBe('https://example.com/webhook');
    const body = JSON.parse(opts.body);
    expect(body.event).toBe(expectedCategory);
  });

  it('未映射事件（如 chat_message）→ fetch 不调用', async () => {
    webhookStore._items.push({
      id: 'wh-x', enabled: true, events: ['room_done'],
      roomFilter: '*', url: 'https://example.com/w', format: 'json', headers: {},
    });
    await fireWebhooks('room-1', { type: 'chat_message' }, { name: 'R', mode: 'chat' });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('fireWebhooks — webhook 过滤逻辑', () => {
  beforeEach(() => {
    webhookStore._items.length = 0;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('enabled=false 的 webhook 不触发', async () => {
    webhookStore._items.push({
      id: 'wh-disabled', enabled: false, events: ['room_done'],
      roomFilter: '*', url: 'https://example.com/w', format: 'json', headers: {},
    });
    await fireWebhooks('room-1', { type: 'debate_done' }, { name: 'R', mode: 'debate' });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('events 不包含当前 eventCategory → 不触发', async () => {
    webhookStore._items.push({
      id: 'wh-noevent', enabled: true, events: ['room_error'],
      roomFilter: '*', url: 'https://example.com/w', format: 'json', headers: {},
    });
    await fireWebhooks('room-1', { type: 'debate_done' }, { name: 'R', mode: 'debate' });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('roomFilter 为数组且不含当前 roomId → 不触发', async () => {
    webhookStore._items.push({
      id: 'wh-filter', enabled: true, events: ['room_done'],
      roomFilter: ['aaaaaaaa-0000-0000-0000-000000000001'],
      url: 'https://example.com/w', format: 'json', headers: {},
    });
    await fireWebhooks('room-OTHER', { type: 'debate_done' }, { name: 'R', mode: 'debate' });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('roomFilter 为 * → 所有 room 都触发', async () => {
    webhookStore._items.push({
      id: 'wh-star', enabled: true, events: ['room_done'],
      roomFilter: '*', url: 'https://example.com/w', format: 'json', headers: {},
    });
    await fireWebhooks('any-room-id', { type: 'debate_done' }, { name: 'R', mode: 'debate' });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('多个 webhook 符合条件时并行触发所有（fire-and-forget）', async () => {
    for (let i = 0; i < 3; i++) {
      webhookStore._items.push({
        id: `wh-${i}`, enabled: true, events: ['room_done'],
        roomFilter: '*', url: `https://example.com/w${i}`, format: 'json', headers: {},
      });
    }
    await fireWebhooks('room-1', { type: 'debate_done' }, { name: 'R', mode: 'debate' });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('fetch 失败时 bumpStats(id, false, errMsg) 被调用，不抛出', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('网络超时')));
    webhookStore._items.push({
      id: 'wh-fail', enabled: true, events: ['room_done'],
      roomFilter: '*', url: 'https://example.com/w', format: 'json', headers: {},
    });
    await expect(
      fireWebhooks('room-1', { type: 'debate_done' }, { name: 'R', mode: 'debate' })
    ).resolves.toBeUndefined();
    // 等异步 catch 完成
    await new Promise((r) => setTimeout(r, 10));
    expect(webhookStore.bumpStats).toHaveBeenCalledWith('wh-fail', false, expect.stringContaining('网络超时'));
  });

  it('fetch 成功时 bumpStats(id, true) 被调用', async () => {
    webhookStore._items.push({
      id: 'wh-ok', enabled: true, events: ['room_done'],
      roomFilter: '*', url: 'https://example.com/w', format: 'json', headers: {},
    });
    await fireWebhooks('room-1', { type: 'debate_done' }, { name: 'R', mode: 'debate' });
    await new Promise((r) => setTimeout(r, 10));
    expect(webhookStore.bumpStats).toHaveBeenCalledWith('wh-ok', true);
  });

  it('没有候选 webhook 时直接返回（不调 fetch）', async () => {
    // _items 为空
    await fireWebhooks('room-1', { type: 'debate_done' }, { name: 'R', mode: 'debate' });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('testWebhook', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('成功时返回 { ok: true }', async () => {
    const result = await testWebhook({
      url: 'https://example.com/hook',
      format: 'json',
      headers: {},
    });
    expect(result).toEqual({ ok: true });
  });

  it('调用 fetch 时 Content-Type 为 application/json', async () => {
    await testWebhook({ url: 'https://example.com/hook', format: 'discord', headers: {} });
    expect(fetch).toHaveBeenCalledOnce();
    const [, opts] = fetch.mock.calls[0];
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  it('测试 payload 的 roomName 为 "(测试)"（discord 格式验证）', async () => {
    await testWebhook({ url: 'https://example.com/hook', format: 'discord', headers: {} });
    const [, opts] = fetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    // discord embed title 应包含 "(测试)"
    expect(body.embeds[0].title).toContain('(测试)');
  });

  it('测试 payload 的 roomName 为 "(测试)"（json 格式验证）', async () => {
    await testWebhook({ url: 'https://example.com/hook', format: 'json', headers: {} });
    const [, opts] = fetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.roomName).toBe('(测试)');
  });

  it('fetch 返回非 ok 时抛出错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    }));
    await expect(
      testWebhook({ url: 'https://example.com/hook', format: 'json', headers: {} })
    ).rejects.toThrow('HTTP 403');
  });

  it('自定义 headers 被合并到请求头', async () => {
    await testWebhook({
      url: 'https://example.com/hook',
      format: 'json',
      headers: { 'X-Custom-Token': 'abc123' },
    });
    const [, opts] = fetch.mock.calls[0];
    expect(opts.headers['X-Custom-Token']).toBe('abc123');
  });
});
