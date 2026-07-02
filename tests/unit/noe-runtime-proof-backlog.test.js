import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildNoeRuntimeProofBacklog } from '../../scripts/noe-runtime-proof-backlog.mjs';

describe('noe-runtime-proof-backlog', () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('prioritizes useful non-live files and classifies proof strategies without source bodies', () => {
    dir = mkdtempSync(join(tmpdir(), 'noe-runtime-proof-backlog-'));
    const atlasPath = join(dir, 'atlas.json');
    writeFileSync(atlasPath, JSON.stringify({
      ok: true,
      generatedAt: '2026-06-15T00:00:00.000Z',
      root: dir,
      summary: {
        files: 6,
        symbolBlocks: 30,
        filesNotProvenLive: 4,
        filesStaticRuntimeSurfaceUnproven: 1,
        runtimeBlockers: ['expectation_no_failed_samples'],
      },
      files: [
        {
          file: 'src/agents/AgentRunStore.js',
          module: 'agents',
          lines: 1000,
          usefulness: 'AGI-critical',
          featureTags: ['action_execution', 'safety_governance'],
          runtime: { proof: 'not_proven_live', gaps: ['no_direct_runtime_module_mapping'] },
          symbolBlockCount: 20,
          tests: { direct: 1, importers: 1 },
          staticSignals: { routeHints: [], runtimeHints: [] },
          nextAction: 'map_to_runtime_probe_or_confirm_support_only',
        },
        {
          file: 'src/capabilities/NoeCapabilityExecutor.js',
          module: 'capabilities',
          lines: 200,
          usefulness: 'AGI-critical',
          featureTags: ['action_execution'],
          runtime: { proof: 'not_proven_live', gaps: ['no_direct_runtime_module_mapping'] },
          symbolBlockCount: 5,
          tests: { direct: 1, importers: 0 },
          staticSignals: { routeHints: [], runtimeHints: [] },
          nextAction: 'map_to_runtime_probe_or_confirm_support_only',
        },
        {
          file: 'src/server/routes/noe.js',
          module: 'server',
          lines: 250,
          usefulness: 'runtime_support',
          featureTags: ['operator_interface'],
          runtime: { proof: 'static_runtime_surface_unproven', gaps: [] },
          symbolBlockCount: 5,
          tests: { direct: 1, importers: 0 },
          staticSignals: { routeHints: ['/api/noe/readiness'], runtimeHints: ['http_route'] },
          nextAction: 'add_behavioral_runtime_probe',
        },
        {
          file: 'src/autopilot/AutopilotStore.js',
          module: 'autopilot',
          lines: 120,
          usefulness: 'AGI-critical',
          featureTags: ['action_execution'],
          runtime: { proof: 'not_proven_live', gaps: [] },
          symbolBlockCount: 5,
          tests: { direct: 1, importers: 0 },
          staticSignals: { routeHints: [], runtimeHints: [] },
          nextAction: 'map_to_runtime_probe_or_confirm_support_only',
        },
        {
          file: 'tests/unit/noe-runtime-proof-backlog.test.js',
          module: 'tests',
          lines: 100,
          usefulness: 'verification',
          featureTags: ['verification_ops'],
          runtime: { proof: 'not_proven_live', gaps: [] },
          symbolBlockCount: 2,
          tests: { direct: 0, importers: 0 },
          staticSignals: { routeHints: [], runtimeHints: [] },
          nextAction: 'keep_as_verification_coverage',
        },
        {
          file: 'scripts/noe-runtime-proof-backlog.mjs',
          module: 'scripts',
          lines: 200,
          usefulness: 'operations_or_verification',
          featureTags: ['verification_ops'],
          runtime: { proof: 'file_hint_plus_module_live', gaps: [] },
          symbolBlockCount: 5,
          tests: { direct: 1, importers: 0 },
          staticSignals: { routeHints: [], runtimeHints: ['npm_script_or_manual_verifier'] },
          nextAction: 'keep_or_wire_to_repeatable_verifier',
        },
      ],
    }));

    const report = buildNoeRuntimeProofBacklog({ atlasPath });
    const byFile = new Map(report.files.map((file) => [file.file, file]));

    expect(report.summary.backlogFiles).toBe(4);
    expect(byFile.has('tests/unit/noe-runtime-proof-backlog.test.js')).toBe(false);
    expect(byFile.has('scripts/noe-runtime-proof-backlog.mjs')).toBe(false);
    expect(byFile.get('src/agents/AgentRunStore.js').recommendedProofStrategy).toBe('agent_runtime_usage_probe');
    expect(byFile.get('src/capabilities/NoeCapabilityExecutor.js').recommendedProofStrategy).toBe('capability_invocation_probe');
    expect(byFile.get('src/autopilot/AutopilotStore.js').recommendedProofStrategy).toBe('scheduler_or_delegation_probe');
    expect(byFile.get('src/server/routes/noe.js').recommendedProofStrategy).toBe('route_or_ui_behavior_probe');
    expect(JSON.stringify(report)).not.toContain('source body');
  });
});
