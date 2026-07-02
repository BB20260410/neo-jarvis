import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildNoeNaturalRuntimeEvidenceAudit,
  renderMarkdown,
} from '../../scripts/noe-natural-runtime-evidence-audit.mjs';

describe('noe-natural-runtime-evidence-audit', () => {
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
    dir = mkdtempSync(join(tmpdir(), 'noe-natural-runtime-evidence-'));
    return {
      weakRuntimeRemainingLaneAudit: writeJson('remaining.json', {
        ok: true,
        generatedAt: '2026-06-15T00:00:00.000Z',
        root: dir,
        files: [
          {
            file: 'src/autopilot/AutopilotScheduler.js',
            lane: 'server_boot_imported_natural_runtime_needed',
            module: 'autopilot',
            reviewClass: 'server_imported_runtime_candidate',
            naturalRuntimeNeeded: true,
          },
          {
            file: 'src/prefetch/NoePrefetchStore.js',
            lane: 'server_boot_imported_natural_runtime_needed',
            module: 'prefetch',
            reviewClass: 'server_imported_runtime_candidate',
            naturalRuntimeNeeded: true,
          },
          {
            file: 'src/metrics/MetricsStore.js',
            lane: 'server_boot_imported_natural_runtime_needed',
            module: 'metrics',
            reviewClass: 'server_imported_runtime_candidate',
            naturalRuntimeNeeded: true,
          },
          {
            file: 'src/route/Foo.js',
            lane: 'route_live_auth_surface_business_pending',
            module: 'route',
            reviewClass: 'route_imported_runtime_candidate',
            naturalRuntimeNeeded: false,
          },
        ],
      }),
      runtimeEvidence: writeJson('runtime.json', {
        generatedAt: '2026-06-15T00:00:00.000Z',
        panel: {
          health: { ok: true, uptimeSec: 123 },
          readiness: { ok: true, status: 'passed' },
        },
        heartbeat: {
          recentDone1h: 99,
          byKind1h: { sleeptimeCompute: 3 },
        },
        acts: { recent24h: 7, withEvidence: 8 },
        memory: {
          runtimeProcess: { primaryCwdMatchesExpected: true },
          counts: { byScope: { voice: 4 } },
        },
      }),
      workMap: writeJson('work-map.json', {
        generatedAt: '2026-06-15T00:00:00.000Z',
        counts: {
          rooms: { activeCount: 1 },
          autopilot: { statusCounts: { succeeded: 2 } },
        },
      }),
      longTaskFollowup: writeJson('long-task.json', {
        generatedAt: '2026-06-15T00:00:00.000Z',
        scheduler: { state: 'running', runs: 5 },
      }),
      memoryStatus: writeJson('memory-status.json', {
        generatedAt: '2026-06-15T00:00:00.000Z',
        status: {
          counts: {
            byScope: { voice: 2 },
            bySourceType: { voice_note: 1 },
          },
        },
      }),
    };
  }

  it('keeps indirect runtime signals separate from direct natural proof', () => {
    const paths = fixturePaths();
    const report = buildNoeNaturalRuntimeEvidenceAudit({
      root: dir,
      paths,
      now: new Date('2026-06-15T00:00:00.000Z'),
    });
    const byFile = new Map(report.files.map((file) => [file.file, file]));
    const raw = JSON.stringify(report);
    const md = renderMarkdown(report, join(dir, 'natural.json'));

    expect(report.summary).toMatchObject({
      targetFiles: 3,
      directStructuredRuntimeEvidenceFiles: 0,
      indirectStructuredRuntimeSignalFiles: 2,
      missingStructuredRuntimeEvidenceFiles: 1,
      naturalRuntimeProofStillNeeded: 3,
    });
    expect(byFile.get('src/autopilot/AutopilotScheduler.js')).toMatchObject({
      naturalEvidenceStatus: 'indirect_structured_runtime_signal',
      evidence: expect.objectContaining({
        workMapAutopilotSucceeded: 2,
        livePanelOk: true,
      }),
    });
    expect(byFile.get('src/prefetch/NoePrefetchStore.js')).toMatchObject({
      naturalEvidenceStatus: 'indirect_structured_runtime_signal',
      evidence: expect.objectContaining({
        heartbeatSleeptimeCompute1h: 3,
      }),
    });
    expect(byFile.get('src/metrics/MetricsStore.js')).toMatchObject({
      naturalEvidenceStatus: 'missing_structured_runtime_evidence',
    });
    expect(byFile.has('src/route/Foo.js')).toBe(false);
    expect(report.policy).toMatchObject({
      noOwnerTokenReads: true,
      noLiveHttpRequests: true,
      noModelCalls: true,
    });
    expect(raw).not.toContain('Bearer ');
    expect(md).toContain('natural runtime proof still needed: 3');
  });
});
