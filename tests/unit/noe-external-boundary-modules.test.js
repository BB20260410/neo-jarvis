import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { MiniMaxAdapter } from '../../src/watcher/MiniMaxAdapter.js';
import { OllamaAdapter } from '../../src/watcher/OllamaAdapter.js';

const watcherMockState = vi.hoisted(() => ({
  claudeCalls: [],
  codexCalls: [],
  claudeReply: '',
  codexReply: '',
}));

vi.mock('../../src/room/ClaudeSpawnAdapter.js', () => ({
  ClaudeSpawnAdapter: class {
    constructor(opts = {}) { this.opts = opts; }
    async chat(messages, opts = {}) {
      watcherMockState.claudeCalls.push({ constructorOpts: this.opts, messages, opts });
      return { reply: watcherMockState.claudeReply };
    }
  },
}));

vi.mock('../../src/room/CodexSpawnAdapter.js', () => ({
  CodexSpawnAdapter: class {
    constructor(opts = {}) { this.opts = opts; }
    async chat(messages, opts = {}) {
      watcherMockState.codexCalls.push({ constructorOpts: this.opts, messages, opts });
      return { reply: watcherMockState.codexReply };
    }
  },
}));

const { ClaudeWatcherAdapter } = await import('../../src/watcher/ClaudeWatcherAdapter.js');
const { CodexWatcherAdapter } = await import('../../src/watcher/CodexWatcherAdapter.js');

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  watcherMockState.claudeCalls.length = 0;
  watcherMockState.codexCalls.length = 0;
  watcherMockState.claudeReply = '';
  watcherMockState.codexReply = '';
});

function tempHome(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function moduleUrl(relativePath) {
  return pathToFileURL(join(process.cwd(), relativePath)).href;
}

function runNodeWithHome(home, script) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
}

function verdict(status = 'completed') {
  return JSON.stringify({
    status,
    confidence: 0.92,
    completed_items: ['checked recent messages'],
    remaining_items: [],
    next_action: { type: 'stop', prompt: '', danger_level: 'safe' },
    drift_detected: false,
    reasoning: '已经检查最近对话，结论明确。',
  });
}

describe('ClaudeWatcherAdapter and CodexWatcherAdapter', () => {
  it('passes watcher prompts through mocked CLI adapters and validates JSON verdicts', async () => {
    watcherMockState.claudeReply = `\`\`\`json\n${verdict('completed')}\n\`\`\``;
    watcherMockState.codexReply = verdict('partial');
    const sessionState = {
      id: 's1',
      name: 'Audit session',
      cwd: '/tmp/noe',
      mainGoal: 'finish audit',
      runState: 'running',
      messages: [{ role: 'assistant', content: '我完成了第一步', ts: 'now' }],
    };

    const claude = await new ClaudeWatcherAdapter({ bin: '/bin/claude', model: 'opus', timeout: 123 }).judge(sessionState);
    const codex = await new CodexWatcherAdapter({ bin: '/bin/codex', model: 'gpt', timeout: 456 }).judge(sessionState);

    expect(claude.status).toBe('completed');
    expect(codex.status).toBe('partial');
    expect(watcherMockState.claudeCalls[0].constructorOpts).toMatchObject({ bin: '/bin/claude', timeout: 123 });
    expect(watcherMockState.claudeCalls[0].messages[0].content).toContain('只输出 JSON');
    expect(watcherMockState.claudeCalls[0].opts).toMatchObject({ cwd: '/tmp/noe', model: 'opus' });
    expect(watcherMockState.codexCalls[0].constructorOpts).toMatchObject({ bin: '/bin/codex', timeout: 456 });
    expect(watcherMockState.codexCalls[0].opts).toMatchObject({ cwd: '/tmp/noe', model: 'gpt' });
  });
});

describe('MiniMaxAdapter and OllamaAdapter', () => {
  it('uses fake fetch for MiniMax watcher calls and never needs a real API key', async () => {
    const calls = [];
    globalThis.fetch = async (url, opts = {}) => {
      calls.push({ url, opts });
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: verdict('stuck') } }] }),
      };
    };

    const adapter = new MiniMaxAdapter({ apiKey: 'unit-key', baseUrl: 'https://minimax.example.test/v1', model: 'abab-test' });
    const out = await adapter.judge({ cwd: '/tmp/noe', name: 's', messages: [] });

    expect(out.status).toBe('stuck');
    expect(calls[0].url).toBe('https://minimax.example.test/v1/chat/completions');
    expect(calls[0].opts.headers.Authorization).toBe('Bearer unit-key');
    expect(JSON.parse(calls[0].opts.body)).toMatchObject({
      model: 'abab-test',
      response_format: { type: 'json_object' },
    });
    await expect(new MiniMaxAdapter({ apiKey: '' }).judge({ messages: [] })).rejects.toThrow('MiniMax API key 未配置');
  });

  it('uses fake local fetch for Ollama watcher calls and reports empty content as an error', async () => {
    const calls = [];
    globalThis.fetch = async (url, opts = {}) => {
      calls.push({ url, opts });
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: verdict('need_user') } }] }),
      };
    };
    const adapter = new OllamaAdapter({ baseUrl: 'http://127.0.0.1:11434', model: 'qwen-test' });
    const out = await adapter.judge({ cwd: '/tmp/noe', name: 's', messages: [] });

    expect(out.status).toBe('need_user');
    expect(calls[0].url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(JSON.parse(calls[0].opts.body)).toMatchObject({ model: 'qwen-test' });

    globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '' } }] }) });
    await expect(adapter.judge({ messages: [] })).rejects.toThrow('Ollama 响应空 content');
  });
});

describe('LemonSqueezyClient', () => {
  it('runs only against fake fetch and temp HOME token storage', () => {
    const home = tempHome('noe-lemon-home-');
    try {
      const script = `
        import { mkdirSync, writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        import { homedir } from 'node:os';
        const calls = [];
        globalThis.fetch = async (url, opts = {}) => {
          calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body || '' });
          if (url.endsWith('/users/me')) return { ok: true, json: async () => ({ data: { attributes: { email: 'owner@example.test' } } }) };
          if (url.endsWith('/stores')) return { ok: true, json: async () => ({ data: [{ id: 'store-1' }] }) };
          if (url.includes('/orders?')) return { ok: true, json: async () => ({ data: [] }) };
          if (url.endsWith('/checkouts')) return { ok: true, json: async () => ({ data: { id: 'checkout-1' } }) };
          if (url.includes('/webhooks/')) return { ok: true, text: async () => '', json: async () => ({}) };
          return { ok: false, status: 418, text: async () => 'unit failure' };
        };
        const m = await import(${JSON.stringify(moduleUrl('src/integrations/LemonSqueezyClient.js'))});
        const missing = await m.healthCheck();
        mkdirSync(join(homedir(), '.noe-panel'), { recursive: true, mode: 0o700 });
        writeFileSync(join(homedir(), '.noe-panel', 'lemonsqueezy-key.txt'), 'ls-unit-token\\nsecond-line', { mode: 0o600 });
        const health = await m.healthCheck();
        await m.listOrders({ storeId: 'store-1', limit: 7 });
        await m.createCheckout({ storeId: 'store-1', variantId: 'variant-1', customData: { user: 'u1' } });
        const deleted = await m.deleteWebhook('hook-1');
        console.log(JSON.stringify({ missing, health, deleted, calls }));
      `;
      const out = JSON.parse(runNodeWithHome(home, script));

      expect(out.missing).toMatchObject({ ok: false, tokenStored: false });
      expect(out.health).toMatchObject({ ok: true, user: 'owner@example.test', storesCount: 1, tokenStored: true });
      expect(out.deleted).toEqual({ ok: true, deleted: 'hook-1' });
      expect(out.calls.some((call) => call.url.includes('/orders?filter%5Bstore_id%5D=store-1&page%5Bsize%5D=7'))).toBe(true);
      expect(out.calls.some((call) => call.url.endsWith('/checkouts') && call.method === 'POST')).toBe(true);
      expect(out.calls.every((call) => call.headers.Authorization === 'Bearer ls-unit-token' || !call.headers.Authorization)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('RoomTemplatesStore', () => {
  it('sanitizes user templates and keeps destructive operations inside temp HOME', () => {
    const home = tempHome('noe-room-template-home-');
    try {
      const script = `
        const m = await import(${JSON.stringify(moduleUrl('src/templates/RoomTemplatesStore.js'))});
        const before = m.roomTemplatesStore.list().length;
        const created = m.roomTemplatesStore.create({
          name: 'A'.repeat(120),
          description: 'D'.repeat(500),
          mode: 'debate',
          preset: {
            members: [{ adapterId: 'claude', displayName: 'Claude', model: 'sonnet', enabled: true }],
            debateRounds: 99,
            topicPlaceholder: 'topic'.repeat(400),
          },
          builtin: true,
        });
        const builtinDeleted = m.roomTemplatesStore.delete('builtin:debate-tech-review');
        const userDeleted = m.roomTemplatesStore.delete(created.id);
        console.log(JSON.stringify({
          before,
          created,
          builtinDeleted,
          userDeleted,
          after: m.roomTemplatesStore.list().length,
        }));
      `;
      const out = JSON.parse(runNodeWithHome(home, script));

      expect(out.before).toBeGreaterThanOrEqual(6);
      expect(out.created.name).toHaveLength(80);
      expect(out.created.description).toHaveLength(400);
      expect(out.created.builtin).toBe(false);
      expect(out.created.preset.debateRounds).toBe(10);
      expect(out.created.preset.topicPlaceholder.length).toBeLessThanOrEqual(1000);
      expect(out.builtinDeleted).toBe(false);
      expect(out.userDeleted).toBe(true);
      expect(out.after).toBe(out.before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('Analytics and ErrorReporter telemetry', () => {
  it('keeps telemetry disabled by default and redacts errors before fake Sentry upload', () => {
    const home = tempHome('noe-telemetry-home-');
    try {
      const script = `
        import { mkdirSync, writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        import { homedir } from 'node:os';
        const calls = [];
        globalThis.fetch = async (url, opts = {}) => {
          calls.push({ url, body: opts.body || '', headers: opts.headers || {} });
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        };
        const reporter = await import(${JSON.stringify(moduleUrl('src/telemetry/ErrorReporter.js'))});
        const disabled = await reporter.captureException(new Error('disabled secret sk-unit-disabled-12345678901234567890'));
        reporter.acceptTelemetry({ dsn: 'https://public@sentry.example.test/42' });
        const err = new Error('boom sk-unit-enabled-12345678901234567890 api_key=raw-secret-value');
        err.stack = 'Error: boom\\n    at fn (/Users/hxx/secret/app.js:1:2)';
        const sent = await reporter.captureException(err, { level: 'warning', tags: { area: 'unit' } });
        const repeated = await reporter.captureException(err, { level: 'warning' });
        reporter.declineTelemetry();
        console.log(JSON.stringify({ disabled, sent, repeated, enabledAfterDecline: reporter.isEnabled(), calls }));
      `;
      const out = JSON.parse(runNodeWithHome(home, script));

      expect(out.disabled).toEqual({ skipped: 'disabled' });
      expect(out.sent).toMatchObject({ sent: true, status: 200 });
      expect(out.repeated.skipped).toBe('rate-limited');
      expect(out.enabledAfterDecline).toBe(false);
      expect(out.calls).toHaveLength(1);
      expect(out.calls[0].url).toBe('https://sentry.example.test/api/42/store/');
      expect(out.calls[0].body).not.toContain('sk-unit-enabled');
      expect(out.calls[0].body).not.toContain('/Users/hxx');
      expect(out.calls[0].body).toContain('[REDACTED-OPENAI-KEY]');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('flushes analytics only when host and key are configured', () => {
    const home = tempHome('noe-analytics-home-');
    try {
      const script = `
        import { mkdirSync, writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        import { homedir } from 'node:os';
        const calls = [];
        globalThis.fetch = async (url, opts = {}) => {
          calls.push({ url, body: opts.body || '' });
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        };
        const analytics = await import(${JSON.stringify(moduleUrl('src/telemetry/Analytics.js'))});
        analytics.capture('disabled_event', { count: 1 });
        await analytics.flushOnExit();
        mkdirSync(join(homedir(), '.noe-panel'), { recursive: true });
        writeFileSync(join(homedir(), '.noe-panel', 'telemetry.json'), JSON.stringify({
          analyticsHost: 'https://posthog.example.test',
          analyticsKey: 'phc_unit_key',
          panelVersion: 'test',
        }));
        analytics.capture('room_created', { mode: 'debate' });
        await analytics.flushOnExit();
        console.log(JSON.stringify({ calls }));
      `;
      const out = JSON.parse(runNodeWithHome(home, script));

      expect(out.calls).toHaveLength(1);
      expect(out.calls[0].url).toBe('https://posthog.example.test/batch/');
      const body = JSON.parse(out.calls[0].body);
      expect(body.api_key).toBe('phc_unit_key');
      expect(body.batch[0].event).toBe('room_created');
      expect(body.batch[0].properties).toMatchObject({ mode: 'debate', panel_version: 'test' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
