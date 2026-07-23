import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildNoeModuleRuntimeMap } from '../../scripts/noe-module-runtime-map.mjs';

describe('noe-module-runtime-map', () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('fuses inventory files with runtime module evidence without file bodies', () => {
    dir = mkdtempSync(join(tmpdir(), 'noe-module-runtime-map-'));
    const inventoryPath = join(dir, 'inventory.json');
    const runtimePath = join(dir, 'runtime.json');
    writeFileSync(inventoryPath, JSON.stringify({
      ok: true,
      generatedAt: '2026-06-15T00:00:00.000Z',
      root: '/repo',
      totals: {
        files: 4,
        sourceFiles: 2,
        testFiles: 1,
        lines: 100,
        sourceLines: 40,
        untestedSourceFiles: 0,
        unreferencedSourceFiles: 0,
      },
      files: [
        {
          file: 'server.js',
          module: 'server.js',
          role: 'server_entry',
          lines: 20,
          symbols: ['function:start'],
          envVars: ['NOE_HEARTBEAT'],
          routeHints: ['/health'],
          runtimeHints: ['listen'],
          localImports: [],
          sourceImporters: [],
          tests: ['tests/unit/server.test.js'],
          testImporters: [],
        },
        {
          file: 'src/cognition/NoeOwnerBehaviorPredictor.js',
          module: 'cognition',
          role: 'source',
          lines: 50,
          symbols: ['export:function:createOwnerBehaviorPredictor'],
          envVars: [],
          routeHints: [],
          runtimeHints: [],
          localImports: [],
          sourceImporters: ['server.js'],
          tests: ['tests/unit/noe-owner-behavior-predictor.test.js'],
          testImporters: [],
        },
        {
          file: 'public/app.js',
          module: 'public',
          role: 'browser_ui_asset',
          lines: 20,
          symbols: [],
          envVars: [],
          routeHints: ['/api/noe/readiness'],
          runtimeHints: ['fetch'],
          localImports: [],
          sourceImporters: [],
          tests: [],
          testImporters: ['tests/unit/appjs.test.js'],
        },
        {
          file: 'tests/unit/noe-owner-behavior-predictor.test.js',
          module: 'tests',
          role: 'test',
          lines: 10,
          symbols: [],
          envVars: [],
          routeHints: [],
          runtimeHints: [],
          localImports: [],
          sourceImporters: [],
          tests: [],
          testImporters: [],
        },
      ],
    }));
    writeFileSync(runtimePath, JSON.stringify({
      ok: true,
      generatedAt: '2026-06-15T00:01:00.000Z',
      blockers: ['expectation_no_failed_samples', 'curiosity_source_surprise_absent'],
      modules: [
        { id: 'panel_service', running: 'running', useful: 'core_runtime', evidence: 'health=true', gap: '' },
        { id: 'heartbeat_loop', running: 'running', useful: 'life_sign', evidence: 'done10m=1', gap: '' },
        { id: 'expectation_calibration', running: 'positive_only_no_failed_samples', useful: 'reality_correction', evidence: 'failed=0', gap: 'no_failed_samples' },
        { id: 'curiosity_surprise_loop', running: 'wired_but_no_surprise_goals', useful: 'active_learning', evidence: 'surpriseGoals=0', gap: 'source_surprise_absent' },
        { id: 'owner_prediction', running: 'code_ready_live_pending_restart', useful: 'other_model_calibration', evidence: 'explicitNegative=true', gap: 'live_pending_restart_or_natural_sample' },
      ],
    }));

    const audit = buildNoeModuleRuntimeMap({ inventoryPath, runtimePath });

    expect(audit.files).toHaveLength(4);
    expect(audit.totals.runtimeBlockers).toEqual([
      'expectation_no_failed_samples',
      'curiosity_source_surprise_absent',
    ]);
    const cognition = audit.modules.find((m) => m.module === 'cognition');
    expect(cognition).toMatchObject({
      files: 1,
      usefulness: 'core_or_autonomy_spine',
      runtime: {
        strength: 'live_with_gap',
        ids: ['expectation_calibration', 'curiosity_surprise_loop', 'owner_prediction'],
      },
    });
    expect(cognition.runtime.gaps).toEqual([
      'live_pending_restart_or_natural_sample',
      'no_failed_samples',
      'source_surprise_absent',
    ]);
    const ownerFile = audit.files.find((f) => f.file.includes('NoeOwnerBehaviorPredictor'));
    expect(ownerFile).toMatchObject({
      usefulness: 'core_or_autonomy_spine',
      risk: 'covered_by_tests_or_importer_tests',
      testEvidence: { directTests: 1, testImporters: 0 },
    });
    expect(JSON.stringify(audit)).not.toContain('secret body should never exist');
  });
});
