// tests/unit/analytics.test.js
// Unit tests for src/telemetry/Analytics.js exported functions:
//   isAnalyticsEnabled, capture, flushOnExit
//
// Strategy: mock node:fs / node:os so the module reads a synthetic telemetry
// config; mock global fetch so the batch POST is observable without network.
// Module-level state (_config / _queue / _distinctId / _flushTimer) is
// reset between tests via vi.resetModules() + dynamic import.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoist the fs mocks so the same fn instances survive vi.resetModules()
// (the test file's top-level imports and the Analytics module both see them).
const { readFileSync, existsSync } = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('node:fs', () => ({ readFileSync, existsSync }));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/home/test'),
  hostname: vi.fn(() => 'test-host'),
  platform: vi.fn(() => 'linux'),
  release: vi.fn(() => '5.0.0'),
}));

const mockFetch = vi.fn(() => Promise.resolve({ ok: true }));
global.fetch = mockFetch;

async function loadAnalytics(configExists = false, config = {}) {
  vi.resetModules();
  existsSync.mockReset();
  readFileSync.mockReset();
  existsSync.mockReturnValue(configExists);
  readFileSync.mockReturnValue(JSON.stringify(config));
  return await import('../../src/telemetry/Analytics.js');
}

describe('Analytics', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true });
  });

  describe('isAnalyticsEnabled', () => {
    it('returns false when config file does not exist', async () => {
      const { isAnalyticsEnabled } = await loadAnalytics(false);
      expect(isAnalyticsEnabled()).toBe(false);
    });

    it('returns false when only analyticsKey is set', async () => {
      const { isAnalyticsEnabled } = await loadAnalytics(true, { analyticsKey: 'k' });
      expect(isAnalyticsEnabled()).toBe(false);
    });

    it('returns false when only analyticsHost is set', async () => {
      const { isAnalyticsEnabled } = await loadAnalytics(true, {
        analyticsHost: 'https://h.example.com',
      });
      expect(isAnalyticsEnabled()).toBe(false);
    });

    it('returns true when both analyticsHost and analyticsKey are set', async () => {
      const { isAnalyticsEnabled } = await loadAnalytics(true, {
        analyticsHost: 'https://h.example.com',
        analyticsKey: 'k',
      });
      expect(isAnalyticsEnabled()).toBe(true);
    });

    it('treats invalid JSON config as disabled', async () => {
      vi.resetModules();
      existsSync.mockReset();
      readFileSync.mockReset();
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('not-json{');
      const mod = await import('../../src/telemetry/Analytics.js');
      expect(mod.isAnalyticsEnabled()).toBe(false);
    });
  });

  describe('capture', () => {
    it('does nothing when analytics is disabled', async () => {
      const { capture } = await loadAnalytics(false);
      capture('room_created', { mode: 'debate' });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('queues and sends an event with merged metadata', async () => {
      const { capture, flushOnExit } = await loadAnalytics(true, {
        analyticsHost: 'https://h.example.com',
        analyticsKey: 'key-abc',
        panelVersion: '2.5.0',
      });

      capture('room_created', { mode: 'debate' });
      await flushOnExit();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://h.example.com/batch/');
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(init.body);
      expect(body.api_key).toBe('key-abc');
      expect(body.batch).toHaveLength(1);

      const evt = body.batch[0];
      expect(evt.event).toBe('room_created');
      expect(evt.properties.mode).toBe('debate');
      expect(evt.properties.$os).toBe('linux');
      expect(evt.properties.$os_version).toBe('5.0.0');
      expect(evt.properties.panel_version).toBe('2.5.0');
      expect(evt.properties.$time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(typeof evt.timestamp).toBe('string');
      expect(evt.distinct_id).toMatch(/^[0-9a-f]{16}$/);
    });

    it('truncates event name to 80 characters', async () => {
      const { capture, flushOnExit } = await loadAnalytics(true, {
        analyticsHost: 'https://h.example.com',
        analyticsKey: 'k',
      });

      capture('x'.repeat(120));
      await flushOnExit();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.batch[0].event).toHaveLength(80);
      expect(body.batch[0].event).toBe('x'.repeat(80));
    });

    it('strips trailing slash from analyticsHost when building url', async () => {
      const { capture, flushOnExit } = await loadAnalytics(true, {
        analyticsHost: 'https://h.example.com/',
        analyticsKey: 'k',
      });

      capture('e');
      await flushOnExit();

      expect(mockFetch.mock.calls[0][0]).toBe('https://h.example.com/batch/');
    });

    it('uses a stable distinct_id across events within the same module', async () => {
      const { capture, flushOnExit } = await loadAnalytics(true, {
        analyticsHost: 'https://h.example.com',
        analyticsKey: 'k',
      });

      capture('a');
      capture('b');
      await flushOnExit();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.batch).toHaveLength(2);
      expect(body.batch[0].distinct_id).toBe(body.batch[1].distinct_id);
    });

    it('auto-flushes when queue reaches BATCH_SIZE', async () => {
      const { capture } = await loadAnalytics(true, {
        analyticsHost: 'https://h.example.com',
        analyticsKey: 'k',
      });

      for (let i = 0; i < 50; i++) capture(`evt_${i}`);
      // flush() is async; yield to the microtask queue so fetch resolves.
      await new Promise((r) => setImmediate(r));

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.batch).toHaveLength(50);
    });

    it('silently swallows fetch errors (does not throw)', async () => {
      mockFetch.mockRejectedValueOnce(new Error('net down'));
      const { capture, flushOnExit } = await loadAnalytics(true, {
        analyticsHost: 'https://h.example.com',
        analyticsKey: 'k',
      });

      capture('boom');
      await expect(flushOnExit()).resolves.toBeUndefined();
    });
  });

  describe('flushOnExit', () => {
    it('does not call fetch when queue is empty', async () => {
      const { flushOnExit } = await loadAnalytics(true, {
        analyticsHost: 'https://h.example.com',
        analyticsKey: 'k',
      });

      await flushOnExit();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('flushes whatever is queued', async () => {
      const { capture, flushOnExit } = await loadAnalytics(true, {
        analyticsHost: 'https://h.example.com',
        analyticsKey: 'k',
      });

      capture('one');
      capture('two');
      await flushOnExit();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.batch.map((e) => e.event)).toEqual(['one', 'two']);
    });
  });
});
