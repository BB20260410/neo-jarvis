// tests/unit/error-reporter.test.js
// Unit tests for src/telemetry/ErrorReporter.js (Task 1.1 — previously uncovered).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate ErrorReporter's CONFIG_DIR to a per-suite temp HOME so tests
// never touch the real user home directory.
const tmpHome = mkdtempSync(join(tmpdir(), 'noe-errrep-'));

// Mock node:os: homedir() → tmpHome (config isolation), hostname() → deterministic.
// vi.importActual keeps all other node:os exports (tmpdir, etc.) untouched.
vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os');
  return {
    ...actual,
    homedir: () => tmpHome,
    hostname: () => 'panel-test01',
  };
});

// Re-import the module so the module-level `_config` cache and the
// `_recentFingerprints` Map start fresh for every test.
async function freshImport() {
  vi.resetModules();
  return await import('../../src/telemetry/ErrorReporter.js');
}

const cfgPath = () => join(tmpHome, '.noe-panel', 'telemetry.json');

describe('ErrorReporter', () => {
  beforeEach(() => {
    // Default fetch stub keeps any code path that reaches fetch fully offline.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (existsSync(cfgPath())) rmSync(cfgPath());
  });

  describe('loadConfig', () => {
    it('returns a default disabled config when telemetry.json is missing', async () => {
      const { loadConfig } = await freshImport();
      const c = loadConfig();
      expect(c.enabled).toBe(false);
      expect(c.dsn).toBe('');
      expect(c.acceptedAt).toBeNull();
    });

    it('returns the same cached object on subsequent calls', async () => {
      const { loadConfig } = await freshImport();
      const a = loadConfig();
      const b = loadConfig();
      expect(a).toBe(b);
    });
  });

  describe('acceptTelemetry', () => {
    it('persists enabled=true with the provided DSN', async () => {
      const { acceptTelemetry, isEnabled } = await freshImport();
      acceptTelemetry({ dsn: 'https://abc@sentry.io/42' });
      expect(existsSync(cfgPath())).toBe(true);
      const raw = JSON.parse(readFileSync(cfgPath(), 'utf-8'));
      expect(raw.enabled).toBe(true);
      expect(raw.dsn).toBe('https://abc@sentry.io/42');
      expect(typeof raw.acceptedAt).toBe('string');
      expect(isEnabled()).toBe(true);
    });

    it('trims surrounding whitespace from the DSN', async () => {
      const { acceptTelemetry, isEnabled } = await freshImport();
      acceptTelemetry({ dsn: '  https://k@example.com/2  ' });
      expect(isEnabled()).toBe(true);
    });
  });

  describe('declineTelemetry', () => {
    it('persists enabled=false with an empty DSN', async () => {
      const { declineTelemetry, isEnabled } = await freshImport();
      declineTelemetry();
      const raw = JSON.parse(readFileSync(cfgPath(), 'utf-8'));
      expect(raw.enabled).toBe(false);
      expect(raw.dsn).toBe('');
      expect(typeof raw.acceptedAt).toBe('string');
      expect(isEnabled()).toBe(false);
    });
  });

  describe('isEnabled', () => {
    it('returns false when no config has been written', async () => {
      const { isEnabled } = await freshImport();
      expect(isEnabled()).toBe(false);
    });

    it('returns false when enabled=true but dsn is empty', async () => {
      const { acceptTelemetry, isEnabled } = await freshImport();
      acceptTelemetry({ dsn: '' });
      expect(isEnabled()).toBe(false);
    });
  });

  describe('captureException', () => {
    it('returns { skipped: "disabled" } when telemetry is off', async () => {
      const { captureException } = await freshImport();
      const r = await captureException(new Error('x'));
      expect(r).toEqual({ skipped: 'disabled' });
    });

    it('returns { skipped: "bad-dsn" } when the DSN cannot be parsed', async () => {
      const { acceptTelemetry, captureException } = await freshImport();
      acceptTelemetry({ dsn: 'not a url' });
      const r = await captureException(new Error('x'));
      expect(r).toEqual({ skipped: 'bad-dsn' });
    });

    it('rate-limits an identical error within the 5-minute window', async () => {
      const { acceptTelemetry, captureException } = await freshImport();
      acceptTelemetry({ dsn: 'https://k@example.com/1' });
      // Use string errors so the fingerprint is deterministic
      // (no stack-frame variance between the two calls).
      const r1 = await captureException('dup-msg');
      const r2 = await captureException('dup-msg');
      expect(r1.sent).toBe(true);
      expect(r2).toMatchObject({ skipped: 'rate-limited' });
      expect(r2.fingerprint).toBe(r1.fingerprint);
    });

    it('masks absolute home paths in the error message before sending', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetchMock);
      const { acceptTelemetry, captureException } = await freshImport();
      acceptTelemetry({ dsn: 'https://k@example.com/1' });
      await captureException(new Error('fail at /Users/alice/secret'));
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const value = body.exception.values[0].value;
      expect(value).not.toContain('/Users/alice');
      expect(value).toContain('~');
    });

    it('POSTs to the parsed DSN store endpoint with X-Sentry-Auth header', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetchMock);
      const { acceptTelemetry, captureException } = await freshImport();
      acceptTelemetry({ dsn: 'https://abc123@sentry.io/42' });
      const r = await captureException(new Error('boom'), {
        tags: { feature: 'x' },
        extra: { n: 1 },
      });
      expect(r.sent).toBe(true);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://sentry.io/api/42/store/');
      expect(init.method).toBe('POST');
      expect(init.headers['X-Sentry-Auth']).toContain('sentry_key=abc123');
      const body = JSON.parse(init.body);
      expect(body.tags.feature).toBe('x');
      expect(body.extra.n).toBe(1);
      expect(body.logger).toBe('noe');
      expect(body.platform).toBe('node');
    });

    it('returns { sent: false, status } on a non-2xx response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
      const { acceptTelemetry, captureException } = await freshImport();
      acceptTelemetry({ dsn: 'https://k@example.com/1' });
      const r = await captureException(new Error('x'));
      expect(r).toMatchObject({ sent: false, status: 500 });
    });

    it('swallows fetch errors and returns { error } without throwing', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
      const { acceptTelemetry, captureException } = await freshImport();
      acceptTelemetry({ dsn: 'https://k@example.com/1' });
      const r = await captureException(new Error('x'));
      expect(r).toEqual({ error: 'network down' });
    });
  });
});
