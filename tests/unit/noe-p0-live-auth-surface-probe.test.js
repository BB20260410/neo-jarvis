import { describe, expect, it } from 'vitest';
import { localBaseUrl, runProbe, statusKind } from '../../scripts/noe-p0-live-auth-surface-probe.mjs';

describe('noe-p0-live-auth-surface-probe', () => {
  it('classifies local unauthorized GET route surfaces without response bodies', async () => {
    const requested = [];
    const report = await runProbe({
      baseUrl: 'http://127.0.0.1:51835',
      timeoutMs: 500,
      fetchFn: async (url, options) => {
        requested.push({ url: String(url), options });
        if (String(url).endsWith('/health')) return { status: 200 };
        return { status: 401, text: async () => 'secret body that should never be read' };
      },
    });

    expect(report.summary.fetchedProbes).toBe(6);
    expect(report.summary.p0Files).toBe(7);
    expect(report.summary.p0FilesWithRouteSurfaceObserved).toBe(6);
    expect(report.summary.p0FilesNotProbeableByUnauthorizedGet).toEqual(['src/security/NoePolicyFileGuard.js']);
    expect(report.summary.statusKinds.public_route_live).toBe(1);
    expect(report.summary.statusKinds.route_live_auth_protected).toBe(5);
    expect(requested.every((request) => request.options.method === 'GET')).toBe(true);
    expect(requested.every((request) => !request.options.headers.Authorization)).toBe(true);
    expect(JSON.stringify(report)).not.toContain('secret body');
  });

  it('refuses non-local probe hosts', () => {
    expect(() => localBaseUrl('https://example.com')).toThrow(/refusing non-local/);
    expect(() => localBaseUrl('http://localhost:51835')).not.toThrow();
  });

  it('keeps status classification conservative', () => {
    expect(statusKind(200, { publicOk: true })).toBe('public_route_live');
    expect(statusKind(401)).toBe('route_live_auth_protected');
    expect(statusKind(403)).toBe('route_live_auth_protected');
    expect(statusKind(404)).toBe('route_not_registered_or_wrong_path');
    expect(statusKind(0)).toBe('request_failed');
  });
});
