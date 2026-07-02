import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildNoeP0RuntimeProofAudit } from '../../scripts/noe-p0-runtime-proof-audit.mjs';

describe('noe-p0-runtime-proof-audit', () => {
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

  it('separates static reachability from observed runtime execution', () => {
    dir = mkdtempSync(join(tmpdir(), 'noe-p0-runtime-proof-audit-'));
    const backlogPath = writeJson('backlog.json', {
      ok: true,
      generatedAt: '2026-06-15T00:00:00.000Z',
      root: dir,
      summary: { runtimeBlockers: ['memory_semantic_runtime_unconfigured'] },
      files: [
        {
          file: 'src/agents/AgentRunStore.js',
          module: 'agents',
          priority: 'P0',
          score: 165,
          usefulness: 'AGI-critical',
          runtimeProof: 'not_proven_live',
          recommendedProofStrategy: 'agent_runtime_usage_probe',
        },
        {
          file: 'src/agents/AgentSkillRegistry.js',
          module: 'agents',
          priority: 'P0',
          score: 137,
          usefulness: 'AGI-critical',
          runtimeProof: 'not_proven_live',
          recommendedProofStrategy: 'agent_runtime_usage_probe',
        },
        {
          file: 'src/security/NoePolicyFileGuard.js',
          module: 'security',
          priority: 'P0',
          score: 125,
          usefulness: 'AGI-critical',
          runtimeProof: 'not_proven_live',
          recommendedProofStrategy: 'safety_gate_runtime_probe',
        },
        {
          file: 'src/low/Unused.js',
          module: 'low',
          priority: 'P1',
          score: 99,
          usefulness: 'runtime_support',
          runtimeProof: 'not_proven_live',
          recommendedProofStrategy: 'targeted_runtime_probe',
        },
      ],
    });
    const inventoryPath = writeJson('inventory.json', {
      ok: true,
      generatedAt: '2026-06-15T00:00:00.000Z',
      root: dir,
      files: [
        {
          file: 'src/agents/AgentRunStore.js',
          module: 'agents',
          sourceImporters: ['server.js', 'src/server/routes/agentRuns.js'],
          tests: ['tests/unit/agent-run-store.test.js'],
          testImporters: ['tests/unit/agent-run-lifecycle.test.js'],
          envVars: [],
          routeHints: [],
          runtimeHints: [],
        },
        {
          file: 'src/agents/AgentSkillRegistry.js',
          module: 'agents',
          sourceImporters: ['src/server/routes/agentRegistry.js', 'src/room/SoloChatDispatcher.js'],
          tests: ['tests/unit/agent-skill-registry.test.js'],
          testImporters: [],
          envVars: [],
          routeHints: [],
          runtimeHints: [],
        },
        {
          file: 'src/security/NoePolicyFileGuard.js',
          module: 'security',
          sourceImporters: ['src/loop/SafeActExecutors.js', 'src/runtime/NoeBootSelfCheck.js'],
          tests: ['tests/unit/noe-policy-file-guard.test.js'],
          testImporters: [],
          envVars: [],
          routeHints: [],
          runtimeHints: [],
        },
      ],
    });
    const moduleMapPath = writeJson('module-map.json', {
      ok: true,
      generatedAt: '2026-06-15T00:00:00.000Z',
      modules: [
        { module: 'agents', runtime: { strength: 'static_only', ids: [], gaps: ['no_direct_runtime_module_mapping'] } },
        { module: 'security', runtime: { strength: 'static_only', ids: [], gaps: ['no_direct_runtime_module_mapping'] } },
      ],
    });

    const report = buildNoeP0RuntimeProofAudit({ backlogPath, inventoryPath, moduleMapPath });
    const byFile = new Map(report.files.map((file) => [file.file, file]));

    expect(report.summary.p0Files).toBe(3);
    expect(report.summary.staticReachableFiles).toBe(3);
    expect(report.summary.observedLiveExecutionFiles).toBe(0);
    expect(byFile.has('src/low/Unused.js')).toBe(false);
    expect(byFile.get('src/agents/AgentRunStore.js').staticWiring).toBe('server_and_route_reachable_static');
    expect(byFile.get('src/agents/AgentSkillRegistry.js').staticWiring).toBe('route_reachable_static');
    expect(byFile.get('src/security/NoePolicyFileGuard.js').staticWiring).toBe('runtime_spine_reachable_static');
    expect(byFile.get('src/agents/AgentRunStore.js').verdict).toBe('wired_to_live_server_static_but_not_proven_executed');
    expect(byFile.get('src/security/NoePolicyFileGuard.js').verdict).toBe('wired_to_runtime_spine_static_but_not_proven_executed');
    expect(JSON.stringify(report)).not.toContain('source body');
  });
});
