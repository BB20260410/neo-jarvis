import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildNoeWeakRouteTargetedLocalDrills,
  renderMarkdown,
} from '../../scripts/noe-weak-route-targeted-local-drills.mjs';

describe('noe-weak-route-targeted-local-drills', () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function write(path, value) {
    const abs = join(dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, value);
    return abs;
  }

  function writeJson(path, value) {
    return write(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  function fixturePaths() {
    dir = mkdtempSync(join(tmpdir(), 'noe-weak-route-drills-test-'));
    write('package.json', `${JSON.stringify({ type: 'module' }, null, 2)}\n`);
    write('src/live/Foo.js', 'export const foo = 1;\nexport function runFoo() { return foo; }\n');
    write('src/mutate/Bar.js', 'export class Bar {}\nexport const risk = () => fetch("https://example.invalid");\n');
    return {
      weakRuntimeRemainingLaneAudit: writeJson('lanes.json', {
        ok: true,
        generatedAt: '2026-06-15T00:00:00.000Z',
        root: dir,
        files: [
          {
            file: 'src/live/Foo.js',
            lane: 'route_live_auth_surface_business_pending',
            reviewClass: 'route_imported_runtime_candidate',
            liveAuthSurface: true,
            testCount: 2,
            testImporterCount: 1,
            routeImporters: ['src/server/routes/live.js'],
            routeAuth: [{ protectedRouteCount: 1, protectedStaticGetCount: 1, protectedDynamicGetCount: 0, protectedMutatingCount: 0 }],
          },
          {
            file: 'src/mutate/Bar.js',
            lane: 'route_has_protected_surface_but_no_safe_get_probe',
            reviewClass: 'route_imported_runtime_candidate',
            liveAuthSurface: false,
            testCount: 1,
            testImporterCount: 1,
            routeImporters: ['src/server/routes/mutating.js'],
            routeAuth: [{ protectedRouteCount: 2, protectedStaticGetCount: 0, protectedDynamicGetCount: 0, protectedMutatingCount: 2 }],
          },
          {
            file: 'src/servered/BootThing.js',
            lane: 'server_boot_imported_natural_runtime_needed',
            reviewClass: 'server_imported_runtime_candidate',
          },
        ],
      }),
    };
  }

  it('imports only route candidates in temp HOME without claiming protected business proof', () => {
    const paths = fixturePaths();
    const report = buildNoeWeakRouteTargetedLocalDrills({
      root: dir,
      paths,
      now: new Date('2026-06-15T00:00:00.000Z'),
    });
    const byFile = new Map(report.files.map((file) => [file.file, file]));
    const raw = JSON.stringify(report);
    const md = renderMarkdown(report, join(dir, 'route-drills.json'));

    expect(report.summary).toMatchObject({
      targetFiles: 2,
      drilledOk: 2,
      failed: 0,
      liveAuthSurfaceTargetFiles: 1,
      liveAuthSurfaceDrilledOk: 1,
      noSafeGetTargetFiles: 1,
      noSafeGetDrilledOk: 1,
      protectedBusinessProofStillNeeded: 2,
    });
    expect(report.policy).toMatchObject({
      importOnly: true,
      tempHomeOnly: true,
      noOwnerTokenReads: true,
      noProtectedApiAuth: true,
      noRouteHandlerCalls: true,
    });
    expect(byFile.get('src/live/Foo.js')).toMatchObject({
      drillStatus: 'drilled_ok',
      evidence: expect.objectContaining({
        imported: true,
        exportCount: 2,
        liveAuthSurface: true,
        protectedStaticGetCount: 1,
      }),
    });
    expect(byFile.get('src/mutate/Bar.js').evidence).toMatchObject({
      imported: true,
      protectedMutatingCount: 2,
      topLevelRiskSignals: ['fetch'],
      blockedFetchCalls: 0,
    });
    expect(byFile.has('src/servered/BootThing.js')).toBe(false);
    expect(raw).not.toContain('Bearer ');
    expect(md).toContain('protected business proof still needed: 2');
  });
});
