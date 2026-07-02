import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildNoeWeakRuntimeRemainingLaneAudit,
  renderMarkdown,
} from '../../scripts/noe-weak-runtime-remaining-lane-audit.mjs';

describe('noe-weak-runtime-remaining-lane-audit', () => {
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
    dir = mkdtempSync(join(tmpdir(), 'noe-weak-remaining-lanes-'));
    mkdirSync(join(dir, 'src/server/routes'), { recursive: true });
    writeFileSync(join(dir, 'src/server/routes/live.js'), `
      app.get('/api/live', requireOwnerToken, (_req, res) => res.json({secret:'TOPSECRET_SOURCE_BODY'}));
    `);
    writeFileSync(join(dir, 'src/server/routes/mutating.js'), `
      app.post('/api/mutate', requireOwnerToken, (_req, res) => res.json({secret:'TOPSECRET_SOURCE_BODY'}));
      app.put('/api/mutate/:id', requireOwnerToken, (_req, res) => res.json({ok:true}));
    `);
    return {
      weakRuntimeSupportReview: writeJson('weak-review.json', {
        ok: true,
        generatedAt: '2026-06-15T00:00:00.000Z',
        root: dir,
        summary: {
          weakFiles: 8,
          runtimeProbeNeeded: 6,
        },
        files: [
          {
            file: 'src/route/LiveRouteDep.js',
            module: 'route',
            lines: 10,
            reviewClass: 'route_imported_runtime_candidate',
            supportDecision: 'runtime_probe_needed',
            routeImporters: ['src/server/routes/live.js'],
            sourceImporters: ['src/server/routes/live.js'],
          },
          {
            file: 'src/route/MutatingRouteDep.js',
            module: 'route',
            lines: 20,
            reviewClass: 'route_imported_runtime_candidate',
            supportDecision: 'runtime_probe_needed',
            routeImporters: ['src/server/routes/mutating.js'],
            sourceImporters: ['src/server/routes/mutating.js'],
          },
          {
            file: 'src/servered/BootThing.js',
            module: 'servered',
            lines: 30,
            reviewClass: 'server_imported_runtime_candidate',
            supportDecision: 'natural_or_managed_runtime_probe_needed',
            sourceImporters: ['server.js'],
            serverImported: true,
          },
          {
            file: 'src/service/ServiceThing.js',
            module: 'service',
            lines: 40,
            reviewClass: 'server_imported_runtime_candidate',
            supportDecision: 'natural_or_managed_runtime_probe_needed',
            sourceImporters: ['src/server/services/runner.js'],
            serviceImporters: ['src/server/services/runner.js'],
          },
          {
            file: 'src/secrets/NoeSecretBroker.js',
            module: 'secrets',
            lines: 50,
            reviewClass: 'runtime_chain_imported_candidate',
            supportDecision: 'targeted_runtime_probe_needed',
            sourceImporters: ['src/runtime/NoeFreedomAdapters.js'],
          },
          {
            file: 'src/bootstrap/load-env.js',
            module: 'bootstrap',
            lines: 60,
            reviewClass: 'isolated_library_with_tests',
            supportDecision: 'support_role_likely_manual_review',
            sourceImporters: [],
          },
          {
            file: 'src/support/AlreadyConfirmed.js',
            module: 'support',
            lines: 70,
            reviewClass: 'library_support_with_unit_coverage',
            supportDecision: 'support_role_confirmed_by_imports_and_tests',
            sourceImporters: ['src/support/Parent.js'],
          },
        ],
      }),
      weakRouteSurfaceProbe: writeJson('route-probe.json', {
        ok: true,
        generatedAt: '2026-06-15T00:00:00.000Z',
        mode: 'unauthorized_live_get_probe',
        files: [
          {
            file: 'src/route/LiveRouteDep.js',
            liveProtectedGetProbes: [{ path: '/api/live', status: 401, statusKind: 'route_live_auth_protected' }],
          },
          {
            file: 'src/route/MutatingRouteDep.js',
            liveProtectedGetProbes: [],
          },
        ],
      }),
      weakRouteTargetedLocalDrills: writeJson('route-drills.json', {
        ok: true,
        generatedAt: '2026-06-15T00:00:00.000Z',
        summary: {
          targetFiles: 2,
          drilledOk: 2,
          failed: 0,
          liveAuthSurfaceTargetFiles: 1,
          liveAuthSurfaceDrilledOk: 1,
          noSafeGetTargetFiles: 1,
          noSafeGetDrilledOk: 1,
          protectedBusinessProofStillNeeded: 2,
        },
        files: [
          {
            file: 'src/route/LiveRouteDep.js',
            lane: 'route_live_auth_surface_business_pending',
            drillStatus: 'drilled_ok',
          },
          {
            file: 'src/route/MutatingRouteDep.js',
            lane: 'route_has_protected_surface_but_no_safe_get_probe',
            drillStatus: 'drilled_ok',
          },
        ],
      }),
      weakTargetedLocalDrills: writeJson('targeted-drills.json', {
        ok: true,
        generatedAt: '2026-06-15T00:00:00.000Z',
        files: [
          {
            file: 'src/bootstrap/load-env.js',
            lane: 'isolated_tested_support_manual_review_needed',
            drillStatus: 'drilled_ok',
          },
        ],
      }),
      weakServerTargetedLocalDrills: writeJson('server-drills.json', {
        ok: true,
        generatedAt: '2026-06-15T00:00:00.000Z',
        files: [
          {
            file: 'src/servered/BootThing.js',
            lane: 'server_boot_imported_natural_runtime_needed',
            drillStatus: 'drilled_ok',
          },
          {
            file: 'src/service/ServiceThing.js',
            lane: 'server_service_chain_managed_smoke_needed',
            drillStatus: 'drilled_ok',
          },
        ],
      }),
      naturalRuntimeEvidenceAudit: writeJson('natural-runtime.json', {
        ok: true,
        generatedAt: '2026-06-15T00:00:00.000Z',
        summary: {
          targetFiles: 3,
          directStructuredRuntimeEvidenceFiles: 0,
          indirectStructuredRuntimeSignalFiles: 1,
          missingStructuredRuntimeEvidenceFiles: 2,
          naturalRuntimeProofStillNeeded: 3,
        },
        files: [
          {
            file: 'src/servered/BootThing.js',
            naturalEvidenceStatus: 'indirect_structured_runtime_signal',
          },
          {
            file: 'src/service/ServiceThing.js',
            naturalEvidenceStatus: 'missing_structured_runtime_evidence',
          },
          {
            file: 'src/secrets/NoeSecretBroker.js',
            naturalEvidenceStatus: 'missing_structured_runtime_evidence',
          },
        ],
      }),
    };
  }

  it('splits remaining weak runtime files into concrete proof lanes without source bodies', () => {
    const paths = fixturePaths();
    const report = buildNoeWeakRuntimeRemainingLaneAudit({
      root: dir,
      paths,
      now: new Date('2026-06-15T00:00:00.000Z'),
    });
    const byFile = new Map(report.files.map((file) => [file.file, file]));
    const raw = JSON.stringify(report);
    const md = renderMarkdown(report, join(dir, 'lanes.json'));

    expect(byFile.get('src/route/LiveRouteDep.js')).toMatchObject({
      lane: 'route_live_auth_surface_business_pending',
      proofStrength: 'medium',
      ownerDecisionNeeded: true,
      liveAuthSurface: true,
      routeTargetedLocalDrillStatus: 'drilled_ok',
    });
    expect(byFile.get('src/route/MutatingRouteDep.js')).toMatchObject({
      lane: 'route_has_protected_surface_but_no_safe_get_probe',
      ownerDecisionNeeded: true,
      targetedProbeNeeded: true,
      routeTargetedLocalDrillStatus: 'drilled_ok',
      routeAuth: [
        expect.objectContaining({
          protectedMutatingCount: 2,
          protectedStaticGetCount: 0,
        }),
      ],
    });
    expect(byFile.get('src/servered/BootThing.js').lane).toBe('server_boot_imported_natural_runtime_needed');
    expect(byFile.get('src/servered/BootThing.js').serverTargetedLocalDrillStatus).toBe('drilled_ok');
    expect(byFile.get('src/servered/BootThing.js').naturalRuntimeEvidenceStatus).toBe('indirect_structured_runtime_signal');
    expect(byFile.get('src/service/ServiceThing.js').lane).toBe('server_service_chain_managed_smoke_needed');
    expect(byFile.get('src/service/ServiceThing.js').serverTargetedLocalDrillStatus).toBe('drilled_ok');
    expect(byFile.get('src/service/ServiceThing.js').naturalRuntimeEvidenceStatus).toBe('missing_structured_runtime_evidence');
    expect(byFile.get('src/secrets/NoeSecretBroker.js').lane).toBe('credential_boundary_targeted_probe_no_secret_read');
    expect(byFile.get('src/bootstrap/load-env.js').lane).toBe('isolated_tested_support_manual_review_needed');
    expect(byFile.get('src/bootstrap/load-env.js').targetedLocalDrillStatus).toBe('drilled_ok');
    expect(byFile.has('src/support/AlreadyConfirmed.js')).toBe(false);
    expect(report.summary).toMatchObject({
      actionableFiles: 6,
      routeLiveAuthSurfaceBusinessPending: 1,
      routeNoSafeGetFiles: 1,
      routeTargetedDrilledOk: 2,
      routeLiveAuthSurfaceTargetedDrilledOk: 1,
      routeNoSafeGetTargetedDrilledOk: 1,
      routeProtectedBusinessProofStillNeeded: 2,
      serverCandidates: 2,
      serverBootImported: 1,
      serverServiceChain: 1,
      serverTargetedDrilledOk: 2,
      serverBootTargetedDrilledOk: 1,
      serverServiceChainTargetedDrilledOk: 1,
      serverNaturalRuntimeStillNeeded: 2,
      chainCandidates: 1,
      manualSupportReviewFiles: 1,
      ownerDecisionNeededFiles: 2,
      naturalRuntimeNeededFiles: 2,
      naturalRuntimeDirectEvidenceFiles: 0,
      naturalRuntimeIndirectSignalFiles: 1,
      naturalRuntimeMissingEvidenceFiles: 1,
      naturalRuntimeProofStillNeeded: 3,
      targetedProbeNeededFiles: 5,
      postDrillTargetedProbeNeededFiles: 3,
      manualSupportDrilledOk: 1,
      componentContractDrilledOk: 3,
    });
    expect(raw).not.toContain('TOPSECRET_SOURCE_BODY');
    expect(md).not.toContain('TOPSECRET_SOURCE_BODY');
    expect(md).toContain('route import contract drilled ok: 2/2');
    expect(md).toContain('route protected business proof still needed: 2');
  });
});
