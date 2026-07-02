import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildNonRouteProofPlan, laneFor } from '../../scripts/noe-runtime-proof-nonroute-plan.mjs';

describe('noe-runtime-proof-nonroute-plan', () => {
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

  it('classifies uncovered files into proof lanes and excludes protected GET covered files', () => {
    dir = mkdtempSync(join(tmpdir(), 'noe-nonroute-plan-'));
    const matrixPath = writeJson('matrix.json', {
      ok: true,
      root: dir,
      files: [
        {
          file: 'src/agents/AgentRunStore.js',
          priority: 'P0',
          module: 'agents',
          surface: 'protected_get_surface_candidate',
          recommendedProofStrategy: 'agent_runtime_usage_probe',
        },
        {
          file: 'src/research/WebSearch.js',
          priority: 'P0',
          module: 'research',
          surface: 'no_route_importer',
          recommendedProofStrategy: 'runtime_probe_or_support_only_review',
        },
        {
          file: 'src/research/ResearchIntent.js',
          priority: 'P1',
          module: 'research',
          surface: 'route_importer_without_safe_get_candidate',
          recommendedProofStrategy: 'runtime_probe_or_support_only_review',
        },
        {
          file: 'src/watcher/OllamaAdapter.js',
          priority: 'P2',
          module: 'watcher',
          surface: 'no_route_importer',
          recommendedProofStrategy: 'support_only_classification_review',
        },
      ],
    });
    const inventoryPath = writeJson('inventory.json', {
      ok: true,
      root: dir,
      files: [
        { file: 'src/agents/AgentRunStore.js', sourceImporters: ['src/server/routes/agentRuns.js'], tests: [], testImporters: [] },
        { file: 'src/research/WebSearch.js', sourceImporters: ['server.js'], tests: ['tests/unit/research-websearch.test.js'], testImporters: [] },
        { file: 'src/research/ResearchIntent.js', sourceImporters: ['src/server/routes/noeDo.js'], tests: [], testImporters: [] },
        { file: 'src/watcher/OllamaAdapter.js', sourceImporters: ['src/watcher/WatcherAdapter.js'], tests: [], testImporters: [] },
      ],
    });
    const backlogPath = writeJson('backlog.json', {
      ok: true,
      root: dir,
      files: [
        { file: 'src/agents/AgentRunStore.js', module: 'agents', recommendedProofStrategy: 'agent_runtime_usage_probe' },
        { file: 'src/research/WebSearch.js', module: 'research', recommendedProofStrategy: 'runtime_probe_or_support_only_review' },
        { file: 'src/research/ResearchIntent.js', module: 'research', recommendedProofStrategy: 'runtime_probe_or_support_only_review' },
        { file: 'src/watcher/OllamaAdapter.js', module: 'watcher', recommendedProofStrategy: 'support_only_classification_review' },
      ],
    });

    const report = buildNonRouteProofPlan({ matrixPath, inventoryPath, backlogPath });
    const byFile = new Map(report.files.map((file) => [file.file, file]));

    expect(report.summary.uncoveredFiles).toBe(3);
    expect(byFile.has('src/agents/AgentRunStore.js')).toBe(false);
    expect(byFile.get('src/research/WebSearch.js')).toMatchObject({
      lane: 'server_constructed_provider_status_probe',
      ownerTokenNeeded: true,
      paidQuotaRisk: true,
    });
    expect(byFile.get('src/research/ResearchIntent.js')).toMatchObject({
      lane: 'authorized_post_or_dynamic_route_probe',
      ownerTokenNeeded: true,
    });
    expect(byFile.get('src/watcher/OllamaAdapter.js')).toMatchObject({
      lane: 'support_only_classification_review',
      ownerTokenNeeded: false,
    });
  });

  it('routes common non-route modules to concrete next proof lanes', () => {
    expect(laneFor({ matrixFile: { module: 'autopilot' } }).lane).toBe('scheduler_or_delegation_runtime_evidence');
    expect(laneFor({ matrixFile: { module: 'capabilities' } }).lane).toBe('local_capability_drill');
    expect(laneFor({ matrixFile: { module: 'mcp' } }).lane).toBe('mcp_smoke_or_audit_probe');
    expect(laneFor({ matrixFile: { module: 'workspace' } }).lane).toBe('workspace_temp_dir_drill');
    expect(laneFor({ matrixFile: { module: 'identity' } }).lane).toBe('local_model_or_sensor_status_preflight');
  });

  it('does not include source bodies or secret values in the plan', () => {
    dir = mkdtempSync(join(tmpdir(), 'noe-nonroute-secret-'));
    const matrixPath = writeJson('matrix.json', {
      files: [{ file: 'src/secrets/NoeProviderHealth.js', priority: 'P1', module: 'secrets', surface: 'no_route_importer', recommendedProofStrategy: 'runtime_probe_or_support_only_review' }],
    });
    const inventoryPath = writeJson('inventory.json', {
      files: [{ file: 'src/secrets/NoeProviderHealth.js', sourceImporters: [], tests: [], testImporters: [], body: 'unit fake secret body should not leak' }],
    });
    const backlogPath = writeJson('backlog.json', {
      files: [{ file: 'src/secrets/NoeProviderHealth.js', module: 'secrets', recommendedProofStrategy: 'runtime_probe_or_support_only_review' }],
    });

    const report = buildNonRouteProofPlan({ matrixPath, inventoryPath, backlogPath });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('unit fake secret body');
    expect(report.files[0]).toMatchObject({ lane: 'provider_health_status_or_mock_probe', paidQuotaRisk: true });
  });
});
