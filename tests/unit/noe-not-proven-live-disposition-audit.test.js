import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildNoeNotProvenLiveDispositionAudit,
  renderMarkdown,
} from '../../scripts/noe-not-proven-live-disposition-audit.mjs';

describe('noe-not-proven-live-disposition-audit', () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function writeJson(name, value) {
    const path = join(dir, name);
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    return path;
  }

  function fixturePaths() {
    dir = mkdtempSync(join(tmpdir(), 'noe-not-proven-live-disposition-'));
    const atlasFiles = [
      {
        file: 'src/live/LiveThing.js',
        module: 'live',
        lines: 10,
        usefulness: 'AGI-critical',
        runtime: { proof: 'module_live_inferred' },
        tests: { direct: 1, importers: 0 },
      },
      {
        file: 'src/agents/AgentRunStore.js',
        module: 'agents',
        lines: 20,
        usefulness: 'AGI-critical',
        runtime: { proof: 'not_proven_live' },
        tests: { direct: 2, importers: 1 },
      },
      {
        file: 'src/security/NoePolicyFileGuard.js',
        module: 'security',
        lines: 30,
        usefulness: 'AGI-critical',
        runtime: { proof: 'not_proven_live' },
        tests: { direct: 1, importers: 1 },
      },
      {
        file: 'tests/unit/example.test.js',
        module: 'tests',
        lines: 5,
        usefulness: 'verification',
        runtime: { proof: 'not_proven_live' },
        tests: { direct: 0, importers: 0 },
      },
      {
        file: 'src/pending/PendingFeature.js',
        module: 'pending',
        lines: 40,
        usefulness: 'AGI-critical',
        runtime: { proof: 'static_runtime_surface_unproven' },
        tests: { direct: 0, importers: 0 },
      },
    ];
    return {
      atlas: writeJson('atlas.json', {
        root: dir,
        summary: {
          filesNotProvenLive: 3,
          filesStaticRuntimeSurfaceUnproven: 1,
        },
        files: atlasFiles,
      }),
      backlog: writeJson('backlog.json', {
        summary: { backlogFiles: 3 },
        files: [
          { file: 'src/agents/AgentRunStore.js', priority: 'P0', recommendedProofStrategy: 'agent probe' },
          { file: 'src/security/NoePolicyFileGuard.js', priority: 'P0', recommendedProofStrategy: 'policy drill' },
          { file: 'src/pending/PendingFeature.js', priority: 'P1', recommendedProofStrategy: 'runtime probe' },
        ],
      }),
      authMatrix: writeJson('auth.json', {
        summary: { liveAuthSurfaceFiles: 1 },
        files: [
          {
            file: 'src/agents/AgentRunStore.js',
            liveProtectedGetProbes: [{ path: '/api/agent-runs', status: 401, statusKind: 'route_live_auth_protected' }],
          },
        ],
      }),
      nonroutePlan: writeJson('nonroute.json', {
        files: [
          {
            file: 'src/security/NoePolicyFileGuard.js',
            lane: 'local_safety_policy_drill',
            priority: 'P0',
            nextProof: 'run temp safety drill',
          },
          {
            file: 'src/pending/PendingFeature.js',
            lane: 'scheduler_or_delegation_runtime_evidence',
            priority: 'P1',
            livePanelNeeded: true,
            nextProof: 'collect natural cadence',
          },
        ],
      }),
      localDrills: writeJson('local-drills.json', {
        summary: { okDrills: 1 },
        files: [
          {
            file: 'src/security/NoePolicyFileGuard.js',
            lane: 'local_safety_policy_drill',
            drillStatus: 'drilled_ok',
            evidenceSummary: 'SECRET BODY MUST NOT LEAK policy blocked=true',
          },
        ],
      }),
      p0AuthorizedReadonly: writeJson('p0-auth.json', {
        summary: { p0FilesStillMissingBusinessProof: ['src/agents/AgentRunStore.js'] },
      }),
    };
  }

  it('splits broad not-proven-live labels into actionable dispositions without source bodies', () => {
    const report = buildNoeNotProvenLiveDispositionAudit({
      paths: fixturePaths(),
      now: new Date('2026-06-15T00:00:00.000Z'),
    });
    const byFile = new Map(report.files.map((file) => [file.file, file]));
    const raw = JSON.stringify(report);
    const md = renderMarkdown(report, join(dir, 'audit.json'));

    expect(byFile.get('src/live/LiveThing.js').disposition).toBe('live_runtime_evidence');
    expect(byFile.get('src/agents/AgentRunStore.js')).toMatchObject({
      disposition: 'live_auth_surface_proved_business_pending',
      ownerTokenNeeded: true,
    });
    expect(byFile.get('src/security/NoePolicyFileGuard.js')).toMatchObject({
      disposition: 'local_behavior_drill_ok',
      strength: 'medium',
    });
    expect(byFile.get('tests/unit/example.test.js').disposition).toBe('verification_test_not_runtime_feature');
    expect(byFile.get('src/pending/PendingFeature.js')).toMatchObject({
      disposition: 'pending_runtime_or_business_proof',
      livePanelNeeded: true,
    });
    expect(report.summary).toMatchObject({
      files: 5,
      backlogFiles: 3,
      liveAuthSurfaceFiles: 1,
      localDrillOkFiles: 1,
      p0BusinessProofStillMissing: 1,
    });
    expect(raw).not.toContain('SECRET BODY');
    expect(md).not.toContain('SECRET BODY');
  });
});
