import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildNoeWeakRouteSurfaceProbe,
  parseArgs,
  renderMarkdown,
} from '../../scripts/noe-weak-route-surface-probe.mjs';

describe('noe-weak-route-surface-probe', () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function writeJson(path, value) {
    const abs = join(dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`);
    return abs;
  }

  function fixturePaths() {
    dir = mkdtempSync(join(tmpdir(), 'noe-weak-route-surface-probe-'));
    mkdirSync(join(dir, 'src/server/routes'), { recursive: true });
    writeFileSync(join(dir, 'src/server/routes/example.js'), `
      import { requireOwnerToken } from '../auth/owner-token.js';
      app.get('/api/example', requireOwnerToken, (_req, res) => res.json({secret:'no'}));
      app.get('/api/example/:id', requireOwnerToken, (_req, res) => res.json({ok:true}));
      app.post('/api/example', requireOwnerToken, (_req, res) => res.json({ok:true}));
    `);
    writeFileSync(join(dir, 'src/server/routes/noSafeGet.js'), `
      app.get('/api/open', (_req, res) => res.json({ok:true}));
      app.post('/api/protected', requireOwnerToken, (_req, res) => res.json({ok:true}));
    `);
    return {
      weakRuntimeSupportReview: writeJson('weak-review.json', {
        ok: true,
        generatedAt: '2026-06-15T00:00:00.000Z',
        root: dir,
        files: [
          {
            file: 'src/example/RuntimeCandidate.js',
            module: 'example',
            lines: 20,
            usefulness: 'supporting',
            disposition: 'line_classified_support_needs_review',
            reviewClass: 'route_imported_runtime_candidate',
            supportDecision: 'runtime_probe_needed',
            remainingNeed: 'route/auth probe',
            routeImporters: ['src/server/routes/example.js'],
            testCount: 1,
          },
          {
            file: 'src/example/NoSafeGetCandidate.js',
            module: 'example',
            lines: 10,
            usefulness: 'supporting',
            disposition: 'line_classified_support_needs_review',
            reviewClass: 'route_imported_runtime_candidate',
            supportDecision: 'runtime_probe_needed',
            remainingNeed: 'route/auth probe',
            routeImporters: ['src/server/routes/noSafeGet.js'],
            testCount: 0,
          },
          {
            file: 'src/example/SupportOnly.js',
            module: 'example',
            lines: 8,
            usefulness: 'supporting',
            reviewClass: 'library_support_with_unit_coverage',
            supportDecision: 'support_role_confirmed_by_imports_and_tests',
            routeImporters: ['src/server/routes/example.js'],
          },
        ],
      }),
    };
  }

  it('builds a static protected GET matrix for weak route candidates only', async () => {
    const paths = fixturePaths();
    const report = await buildNoeWeakRouteSurfaceProbe({
      root: dir,
      paths,
      now: new Date('2026-06-15T00:00:00.000Z'),
    });
    const byFile = new Map(report.files.map((file) => [file.file, file]));
    const md = renderMarkdown(report, join(dir, 'probe.json'));

    expect(report.summary).toMatchObject({
      routeCandidateFiles: 2,
      routeImporterFiles: 2,
      routeImporterSourceFiles: 2,
      protectedGetCandidateFiles: 1,
      uniqueProtectedGetPaths: 1,
      liveProbeExecuted: false,
      liveAuthSurfaceFiles: 0,
      remainingWithoutProtectedGet: 1,
    });
    expect(byFile.get('src/example/RuntimeCandidate.js').protectedGetCandidatePaths).toEqual(['/api/example']);
    expect(byFile.get('src/example/NoSafeGetCandidate.js').surface).toBe('route_importer_without_safe_get_candidate');
    expect(byFile.has('src/example/SupportOnly.js')).toBe(false);
    expect(md).toContain('weak_route_surface_static_matrix_complete');
    expect(md).not.toContain('secret');
  });

  it('optionally probes local protected GETs without auth headers or response bodies', async () => {
    const paths = fixturePaths();
    const requests = [];
    const report = await buildNoeWeakRouteSurfaceProbe({
      root: dir,
      paths,
      probeLive: true,
      baseUrl: 'http://127.0.0.1:51835',
      fetchFn: async (url, options) => {
        requests.push({ url: String(url), options });
        return { status: 401, text: async () => 'secret response body' };
      },
      now: new Date('2026-06-15T00:00:00.000Z'),
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('http://127.0.0.1:51835/api/example');
    expect(requests[0].options.method).toBe('GET');
    expect(requests[0].options.headers.Authorization).toBeUndefined();
    expect(report.summary).toMatchObject({
      liveProbeExecuted: true,
      liveProbedPaths: 1,
      liveAuthSurfaceFiles: 1,
      liveAuthSurfacePaths: 1,
      remainingWithoutLiveAuthSurface: 1,
    });
    expect(report.liveProbes[0]).toMatchObject({
      path: '/api/example',
      status: 401,
      statusKind: 'route_live_auth_protected',
    });
    expect(JSON.stringify(report)).not.toContain('secret response body');
  });

  it('can include dynamic protected GETs only with an explicit placeholder flag', async () => {
    const paths = fixturePaths();
    const report = await buildNoeWeakRouteSurfaceProbe({
      root: dir,
      paths,
      includeDynamicGetPlaceholders: true,
      now: new Date('2026-06-15T00:00:00.000Z'),
    });
    const file = report.files.find((item) => item.file === 'src/example/RuntimeCandidate.js');

    expect(file.protectedGetCandidatePaths).toEqual(['/api/example', '/api/example/__noe_probe__']);
    expect(file.protectedGetCandidateSpecs.find((item) => item.originalPath === '/api/example/:id')).toMatchObject({
      probePath: '/api/example/__noe_probe__',
      dynamicPlaceholder: true,
    });
    expect(report.summary).toMatchObject({
      uniqueProtectedGetPaths: 2,
      dynamicPlaceholderPaths: 1,
    });
  });

  it('keeps live probing explicit and local-only', async () => {
    expect(parseArgs(['--probe-live', '--include-dynamic-get-placeholders', '--timeout-ms=250'])).toMatchObject({
      probeLive: true,
      includeDynamicGetPlaceholders: true,
      timeoutMs: 250,
    });
    const paths = fixturePaths();
    await expect(buildNoeWeakRouteSurfaceProbe({
      root: dir,
      paths,
      probeLive: true,
      baseUrl: 'https://example.com',
      fetchFn: async () => ({ status: 401 }),
    })).rejects.toThrow(/refusing non-local probe host/);
  });
});
