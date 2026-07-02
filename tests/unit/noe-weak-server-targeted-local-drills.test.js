import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildNoeWeakServerTargetedLocalDrills,
  renderMarkdown,
} from '../../scripts/noe-weak-server-targeted-local-drills.mjs';

describe('noe-weak-server-targeted-local-drills', () => {
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
    dir = mkdtempSync(join(tmpdir(), 'noe-weak-server-drills-test-'));
    return {
      weakRuntimeRemainingLaneAudit: writeJson('lanes.json', {
        ok: true,
        generatedAt: '2026-06-15T00:00:00.000Z',
        root: dir,
        files: [
          { file: 'src/metrics/MetricsStore.js', lane: 'server_boot_imported_natural_runtime_needed', reviewClass: 'server_imported_runtime_candidate' },
          { file: 'src/mcp/McpStore.js', lane: 'server_boot_imported_natural_runtime_needed', reviewClass: 'server_imported_runtime_candidate' },
          { file: 'src/templates/RoomTemplatesStore.js', lane: 'server_boot_imported_natural_runtime_needed', reviewClass: 'server_imported_runtime_candidate' },
          { file: 'src/webhook/WebhookStore.js', lane: 'server_boot_imported_natural_runtime_needed', reviewClass: 'server_imported_runtime_candidate' },
          { file: 'src/watcher/WatcherDispatcher.js', lane: 'server_boot_imported_natural_runtime_needed', reviewClass: 'server_imported_runtime_candidate' },
          { file: 'src/prefetch/NoePrefetchStore.js', lane: 'server_boot_imported_natural_runtime_needed', reviewClass: 'server_imported_runtime_candidate' },
          { file: 'src/webhook/WebhookDispatcher.js', lane: 'server_boot_imported_natural_runtime_needed', reviewClass: 'server_imported_runtime_candidate' },
          { file: 'src/autopilot/AutopilotController.js', lane: 'server_boot_imported_natural_runtime_needed', reviewClass: 'server_imported_runtime_candidate' },
          { file: 'src/autopilot/AutopilotScheduler.js', lane: 'server_boot_imported_natural_runtime_needed', reviewClass: 'server_imported_runtime_candidate' },
          { file: 'src/watcher/WatcherConfig.js', lane: 'server_boot_imported_natural_runtime_needed', reviewClass: 'server_imported_runtime_candidate' },
          { file: 'src/capabilities/NoeCapabilityTrigger.js', lane: 'server_boot_imported_natural_runtime_needed', reviewClass: 'server_imported_runtime_candidate' },
          { file: 'src/autopilot/NoeHangAlert.js', lane: 'server_boot_imported_natural_runtime_needed', reviewClass: 'server_imported_runtime_candidate' },
          { file: 'src/cost/CostTracker.js', lane: 'server_service_chain_managed_smoke_needed', reviewClass: 'server_imported_runtime_candidate' },
          { file: 'src/state/AgentStateMachine.js', lane: 'server_service_chain_managed_smoke_needed', reviewClass: 'server_imported_runtime_candidate' },
          { file: 'src/planner/FocusChain.js', lane: 'server_service_chain_managed_smoke_needed', reviewClass: 'server_imported_runtime_candidate' },
          { file: 'src/route/RouteThing.js', lane: 'route_live_auth_surface_business_pending', reviewClass: 'route_imported_runtime_candidate' },
        ],
      }),
    };
  }

  it('runs isolated temp-HOME component drills for server/service weak candidates', () => {
    const report = buildNoeWeakServerTargetedLocalDrills({
      paths: fixturePaths(),
      now: new Date('2026-06-15T00:00:00.000Z'),
    });
    const byFile = new Map(report.files.map((file) => [file.file, file]));
    const raw = JSON.stringify(report);
    const md = renderMarkdown(report, join(dir, 'server-drills.json'));
    const fakeSecretValue = ['unit', 'test', 'redacted', 'value'].join('-');

    expect(report.summary).toMatchObject({
      targetFiles: 15,
      drilledOk: 15,
      failed: 0,
      serverBootTargetFiles: 12,
      serverBootDrilledOk: 12,
      serviceChainTargetFiles: 3,
      serviceChainDrilledOk: 3,
      naturalRuntimeStillNeeded: 15,
    });
    expect(report.policy).toMatchObject({
      isolatedNodeSubprocessPerModule: true,
      tempHomeOnly: true,
      noRealNoePanelReads: true,
      noNetworkCalls: true,
      noModelCalls: true,
    });
    expect(byFile.get('src/mcp/McpStore.js').evidence).toMatchObject({
      isolatedHome: true,
      maskedSecret: true,
      deniedDangerousCommand: true,
    });
    expect(byFile.get('src/autopilot/AutopilotController.js').evidence.notifyBroadcast).toBe(true);
    expect(byFile.get('src/watcher/WatcherDispatcher.js').evidence.autoExecute).toBe(true);
    expect(byFile.get('src/cost/CostTracker.js').evidence.nanIgnored).toBe(true);
    expect(byFile.has('src/route/RouteThing.js')).toBe(false);
    expect(raw).not.toContain(fakeSecretValue);
    expect(md).not.toContain(fakeSecretValue);
  });
});
