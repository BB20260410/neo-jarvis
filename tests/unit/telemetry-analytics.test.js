import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockExistsSync, mockReadFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}));

vi.mock('node:os', () => ({
  homedir: () => '/home/test',
  hostname: () => 'test-host',
  platform: () => 'linux',
  release: () => '5.10.0',
}));

describe('src/telemetry/Analytics.js', () => {
  let capture;
  let isAnalyticsEnabled;
  let flushOnExit;
  let fetchMock;

  function enableAnalytics(overrides = {}) {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      analyticsHost: 'https://h.example.com',
      analyticsKey: 'phc_test_key',
      panelVersion: '9.9.9',
      ...overrides,
    }));
  }

  beforeEach(async () => {
    vi.resetModules();
    mockExistsSync.mockReset();
    mockReadFileSync.mockReset();
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('../../src/telemetry/Analytics.js');
    capture = mod.capture;
    isAnalyticsEnabled = mod.isAnalyticsEnabled;
    flushOnExit = mod.flushOnExit;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('isAnalyticsEnabled()', () => {
    it('returns false when no config file exists', () => {
      mockExistsSync.mockReturnValue(false);
      expect(isAnalyticsEnabled()).toBe(false);
    });

    it('returns true when both analyticsHost and analyticsKey are present', () => {
      enableAnalytics();
      expect(isAnalyticsEnabled()).toBe(true);
    });

    it('returns false when analyticsHost is missing', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ analyticsKey: 'k' }));
      expect(isAnalyticsEnabled()).toBe(false);
    });

    it('returns false when analyticsKey is missing', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ analyticsHost: 'https://h' }));
      expect(isAnalyticsEnabled()).toBe(false);
    });

    it('returns false on malformed JSON (falls back to disabled)', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('{broken');
      expect(isAnalyticsEnabled()).toBe(false);
    });

    it('re-reads config on every call so user can toggle at runtime', () => {
      mockExistsSync.mockReturnValue(false);
      expect(isAnalyticsEnabled()).toBe(false);

      enableAnalytics();
      expect(isAnalyticsEnabled()).toBe(true);

      mockExistsSync.mockReturnValue(false);
      expect(isAnalyticsEnabled()).toBe(false);
    });
  });

  describe('capture()', () => {
    it('does not call fetch when analytics is disabled', async () => {
      mockExistsSync.mockReturnValue(false);
      capture('room_created', { mode: 'debate' });
      await flushOnExit();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('queues events and posts a single batch to /batch/ on flushOnExit', async () => {
      enableAnalytics();
      capture('room_created', { mode: 'debate' });
      await flushOnExit();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://h.example.com/batch/');
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(init.body);
      expect(body.api_key).toBe('phc_test_key');
      expect(body.batch).toHaveLength(1);

      const evt = body.batch[0];
      expect(evt.event).toBe('room_created');
      expect(evt.properties.mode).toBe('debate');
      expect(evt.properties.$os).toBe('linux');
      expect(evt.properties.$os_version).toBe('5.10.0');
      expect(evt.properties.panel_version).toBe('9.9.9');
      expect(typeof evt.properties.$time).toBe('string');
      expect(evt.distinct_id).toMatch(/^[a-f0-9]{16}$/);
      expect(typeof evt.timestamp).toBe('string');
    });

    it('truncates event name to 80 characters', async () => {
      enableAnalytics();
      capture('x'.repeat(120), {});
      await flushOnExit();

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.batch[0].event).toHaveLength(80);
      expect(body.batch[0].event).toBe('x'.repeat(80));
    });

    it('defaults panel_version to "1.0.0" when not set in config', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        analyticsHost: 'https://h',
        analyticsKey: 'k',
      }));
      capture('evt', {});
      await flushOnExit();

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.batch[0].properties.panel_version).toBe('1.0.0');
    });

    it('strips trailing slash from analyticsHost', async () => {
      enableAnalytics({ analyticsHost: 'https://h.example.com/' });
      capture('evt', {});
      await flushOnExit();

      expect(fetchMock.mock.calls[0][0]).toBe('https://h.example.com/batch/');
    });

    it('produces a stable distinct_id across multiple events', async () => {
      enableAnalytics();
      capture('a', {});
      capture('b', {});
      capture('c', {});
      await flushOnExit();

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const ids = body.batch.map(e => e.distinct_id);
      expect(new Set(ids).size).toBe(1);
      expect(ids[0]).toMatch(/^[a-f0-9]{16}$/);
    });

    it('immediately flushes when batch size (50) is reached', async () => {
      enableAnalytics();
      for (let i = 0; i < 50; i++) capture('evt_' + i, { i });

      // Wait for the fire-and-forget flush promise to settle.
      await new Promise((resolve) => setImmediate(resolve));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.batch).toHaveLength(50);
    });

    it('schedules a 30s timer flush when below batch size', async () => {
      vi.useFakeTimers();
      enableAnalytics();
      capture('evt', {});
      expect(fetchMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.batch).toHaveLength(1);
      expect(body.batch[0].event).toBe('evt');
    });

    it('does not schedule a new timer when one is already pending', async () => {
      vi.useFakeTimers();
      enableAnalytics();
      capture('a', {});
      capture('b', {});
      capture('c', {});

      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.batch).toHaveLength(3);
    });
  });

  describe('flush error handling', () => {
    it('does not throw when fetch fails', async () => {
      enableAnalytics();
      fetchMock.mockRejectedValueOnce(new Error('network down'));
      capture('evt', {});
      await expect(flushOnExit()).resolves.toBeUndefined();
    });

    it('drops the batch silently on fetch failure (no retry)', async () => {
      enableAnalytics();
      fetchMock.mockRejectedValueOnce(new Error('boom'));
      capture('evt1', {});
      await flushOnExit();
      // Queue should be empty after the failed flush (batch was spliced out).
      await flushOnExit();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
