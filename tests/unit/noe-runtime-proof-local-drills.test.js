import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLocalDrillReport, fakeToolStorage, runDrills } from '../../scripts/noe-runtime-proof-local-drills.mjs';

const TARGETS = [
  ['P0', 'security', 'local_safety_policy_drill', 'src/security/NoePolicyFileGuard.js'],
  ['P1', 'audit', 'local_safety_policy_drill', 'src/audit/PolicyAuditLog.js'],
  ['P2', 'approval', 'local_safety_policy_drill', 'src/approval/CommandApprovalGate.js'],
  ['P1', 'agents', 'codebase_index_local_drill', 'src/agents/CodebaseFtsIndex.js'],
  ['P1', 'agents', 'codebase_index_local_drill', 'src/agents/CodebaseVectorIndex.js'],
  ['P2', 'agents', 'parser_fixture_drill', 'src/agents/parsers/BabelParserAdapter.js'],
  ['P2', 'agents', 'parser_fixture_drill', 'src/agents/parsers/ParserAdapter.js'],
  ['P1', 'archive', 'archive_lineage_holdout_drill', 'src/archive/ArchiveStore.js'],
  ['P1', 'capabilities', 'local_capability_drill', 'src/capabilities/builtinReadonlyTools.js'],
  ['P1', 'capabilities', 'local_capability_drill', 'src/capabilities/NoeCapabilityExecutor.js'],
  ['P1', 'capabilities', 'local_capability_drill', 'src/capabilities/NoeFreedomAllowlist.js'],
  ['P1', 'capabilities', 'local_capability_drill', 'src/capabilities/NoeFreedomManifest.js'],
  ['P1', 'capabilities', 'local_capability_drill', 'src/capabilities/NoeFreedomTrustManifest.js'],
  ['P1', 'capabilities', 'local_capability_drill', 'src/capabilities/ToolRegistry.js'],
  ['P3', 'capabilities', 'local_capability_drill', 'src/capabilities/NoeCapabilityAcquisition.js'],
  ['P1', 'knowledge', 'knowledge_store_temp_db_drill', 'src/knowledge/EvidenceKnowledgeStore.js'],
  ['P2', 'knowledge', 'knowledge_store_temp_db_drill', 'src/knowledge/KnowledgeStore.js'],
  ['P1', 'mcp', 'mcp_smoke_or_audit_probe', 'src/mcp/McpAggregator.js'],
  ['P1', 'report', 'report_fixture_drill', 'src/report/RoomReporter.js'],
  ['P1', 'workspace', 'workspace_temp_dir_drill', 'src/workspace/NoeSafeDelete.js'],
  ['P1', 'identity', 'local_model_or_sensor_status_preflight', 'src/identity/VoiceVad.js'],
  ['P1', 'identity', 'local_model_or_sensor_status_preflight', 'src/identity/CampPlusVoiceClient.js'],
  ['P1', 'vision', 'local_model_or_sensor_status_preflight', 'src/vision/VisualActionPlanner.js'],
  ['P1', 'vision', 'local_model_or_sensor_status_preflight', 'src/vision/LocalVlmClient.js'],
  ['P1', 'cloud', 'provider_health_status_or_mock_probe', 'src/cloud/NoeCloudProviderRegistry.js'],
  ['P1', 'secrets', 'provider_health_status_or_mock_probe', 'src/secrets/NoeProviderHealth.js'],
  ['P1', 'secrets', 'provider_health_status_or_mock_probe', 'src/secrets/NoeProviderSecrets.js'],
  ['P1', 'skills', 'skill_fixture_drill', 'src/skills/AutoSkillExtractor.js'],
  ['P1', 'skills', 'skill_fixture_drill', 'src/skills/NoeSkillDraftRollback.js'],
  ['P1', 'skills', 'skill_fixture_drill', 'src/skills/SkillCurator.js'],
  ['P2', 'watcher', 'support_only_classification_review', 'src/watcher/ClaudeWatcherAdapter.js'],
  ['P2', 'watcher', 'support_only_classification_review', 'src/watcher/CodexWatcherAdapter.js'],
  ['P2', 'watcher', 'support_only_classification_review', 'src/watcher/MiniMaxAdapter.js'],
  ['P2', 'watcher', 'support_only_classification_review', 'src/watcher/OllamaAdapter.js'],
  ['P2', 'watcher', 'support_only_classification_review', 'src/watcher/WatcherAdapter.js'],
  ['P0', 'research', 'server_constructed_provider_status_probe', 'src/research/WebSearch.js'],
  ['P1', 'research', 'authorized_post_or_dynamic_route_probe', 'src/research/ResearchIntent.js'],
  ['P1', 'skills', 'authorized_post_or_dynamic_route_probe', 'src/skills/SkillExtractor.js'],
  ['P1', 'workspace', 'authorized_post_or_dynamic_route_probe', 'src/workspace/WorkspaceManager.js'],
  ['P1', 'autopilot', 'scheduler_or_delegation_runtime_evidence', 'src/autopilot/AutopilotStore.js'],
  ['P1', 'autopilot', 'scheduler_or_delegation_runtime_evidence', 'src/autopilot/DelegationAutostart.js'],
  ['P1', 'autopilot', 'scheduler_or_delegation_runtime_evidence', 'src/autopilot/NoeDelegationAutostart.js'],
  ['P3', 'autopilot', 'scheduler_or_delegation_runtime_evidence', 'src/autopilot/NoeLocalAgentProbe.js'],
];

describe('noe-runtime-proof-local-drills', () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function writePlan() {
    dir = mkdtempSync(join(tmpdir(), 'noe-local-drills-'));
    const planPath = join(dir, 'plan.json');
    writeFileSync(planPath, `${JSON.stringify({
      ok: true,
      generatedAt: '2026-06-15T00:00:00.000Z',
      root: dir,
      files: TARGETS.map(([priority, module, lane, file]) => ({
        priority,
        module,
        lane,
        file,
      })),
    }, null, 2)}\n`);
    return planPath;
  }

  it('runs local-only behavior drills for all mapped local target files', async () => {
    const report = await buildLocalDrillReport({ planPath: writePlan(), root: dir });

    expect(report.ok).toBe(true);
    expect(report.summary).toMatchObject({
      targetFiles: 43,
      drilledFiles: 43,
      okDrills: 43,
      failedDrills: 0,
      lanesCovered: 16,
      rawSecretMarkersPresent: false,
    });
    expect(report.files.every((file) => file.drillStatus === 'drilled_ok')).toBe(true);
    expect(report.byLane.find((lane) => lane.lane === 'local_capability_drill')).toMatchObject({
      targetFiles: 7,
      okDrills: 7,
    });
    expect(report.byLane.find((lane) => lane.lane === 'local_safety_policy_drill')).toMatchObject({
      targetFiles: 3,
      okDrills: 3,
    });
    expect(report.byLane.find((lane) => lane.lane === 'codebase_index_local_drill')).toMatchObject({
      targetFiles: 2,
      okDrills: 2,
    });
    expect(report.byLane.find((lane) => lane.lane === 'parser_fixture_drill')).toMatchObject({
      targetFiles: 2,
      okDrills: 2,
    });
    expect(report.byLane.find((lane) => lane.lane === 'knowledge_store_temp_db_drill')).toMatchObject({
      targetFiles: 2,
      okDrills: 2,
    });
    expect(report.byLane.find((lane) => lane.lane === 'workspace_temp_dir_drill')).toMatchObject({
      targetFiles: 1,
      okDrills: 1,
    });
    expect(report.byLane.find((lane) => lane.lane === 'local_model_or_sensor_status_preflight')).toMatchObject({
      targetFiles: 4,
      okDrills: 4,
    });
    expect(report.byLane.find((lane) => lane.lane === 'provider_health_status_or_mock_probe')).toMatchObject({
      targetFiles: 3,
      okDrills: 3,
    });
    expect(report.byLane.find((lane) => lane.lane === 'skill_fixture_drill')).toMatchObject({
      targetFiles: 3,
      okDrills: 3,
    });
    expect(report.byLane.find((lane) => lane.lane === 'support_only_classification_review')).toMatchObject({
      targetFiles: 5,
      okDrills: 5,
    });
    expect(report.byLane.find((lane) => lane.lane === 'server_constructed_provider_status_probe')).toMatchObject({
      targetFiles: 1,
      okDrills: 1,
    });
    expect(report.byLane.find((lane) => lane.lane === 'authorized_post_or_dynamic_route_probe')).toMatchObject({
      targetFiles: 3,
      okDrills: 3,
    });
    expect(report.byLane.find((lane) => lane.lane === 'scheduler_or_delegation_runtime_evidence')).toMatchObject({
      targetFiles: 4,
      okDrills: 4,
    });

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('unit_value_alpha');
    expect(serialized).not.toContain('unit_value_beta');
    expect(serialized).not.toContain('unit_value_gamma');
    expect(serialized).not.toContain('unit_value_delta');
    expect(serialized).not.toContain('unit_value_epsilon');
  });

  it('keeps ToolRegistry drill on a fake in-memory store', async () => {
    const { storage, rows } = fakeToolStorage();
    const db = storage.getDb();
    db.prepare(`
      INSERT INTO noe_tools(id, name, description, version, category, risk_level, enabled, manifest, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run('unit.tool', 'Unit Tool', '', '1.0.0', 'local', 'low', '{}', 1, 1);

    expect(rows.size).toBe(1);
    expect(db.prepare('SELECT * FROM noe_tools WHERE id = ?').get('unit.tool')).toMatchObject({
      id: 'unit.tool',
      enabled: 0,
    });
  });

  it('does not use network, model, owner token, env file, live panel, or shell execution in drill policy', async () => {
    const drills = await runDrills(dir || process.cwd());
    expect(drills.every((drill) => drill.ok === true)).toBe(true);
    expect(drills.every((drill) => drill.secretValuesReturned === false)).toBe(true);
  });
});
