import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildNoeWeakTargetedLocalDrills,
  renderMarkdown,
} from '../../scripts/noe-weak-targeted-local-drills.mjs';

describe('noe-weak-targeted-local-drills', () => {
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
    dir = mkdtempSync(join(tmpdir(), 'noe-weak-targeted-drills-test-'));
    return {
      weakRuntimeRemainingLaneAudit: writeJson('lanes.json', {
        ok: true,
        generatedAt: '2026-06-15T00:00:00.000Z',
        root: dir,
        files: [
          { file: 'src/state/atomicJsonFile.js', reviewClass: 'runtime_chain_imported_candidate', lane: 'shared_persistence_utility_tempfile_drill_needed' },
          { file: 'src/security/NoeHostExecEnv.js', reviewClass: 'runtime_chain_imported_candidate', lane: 'host_exec_boundary_targeted_probe_needed' },
          { file: 'src/secrets/NoeSecretBroker.js', reviewClass: 'runtime_chain_imported_candidate', lane: 'credential_boundary_targeted_probe_no_secret_read' },
          { file: 'src/identity/Voiceprint.js', reviewClass: 'runtime_chain_imported_candidate', lane: 'sensor_identity_runtime_probe_needed' },
          { file: 'src/knowledge/learned/citation-renderer.js', reviewClass: 'isolated_library_with_tests', lane: 'isolated_tested_support_manual_review_needed' },
          { file: 'src/bootstrap/load-env.js', reviewClass: 'isolated_library_with_tests', lane: 'isolated_tested_support_manual_review_needed' },
        ],
      }),
    };
  }

  it('runs targeted local drills with temp/fake inputs and temp-copy load-env isolation', async () => {
    const report = await buildNoeWeakTargetedLocalDrills({
      paths: fixturePaths(),
      now: new Date('2026-06-15T00:00:00.000Z'),
    });
    const byFile = new Map(report.files.map((file) => [file.file, file]));
    const raw = JSON.stringify(report);
    const md = renderMarkdown(report, join(dir, 'drills.json'));

    expect(report.summary).toMatchObject({
      targetFiles: 6,
      drilledOk: 6,
      skippedByPolicy: 0,
      failed: 0,
      chainTargetFiles: 4,
      chainDrilledOk: 4,
      manualSupportFiles: 2,
      manualSupportDrilledOk: 2,
      manualSupportSkippedByPolicy: 0,
    });
    expect(byFile.get('src/state/atomicJsonFile.js')).toMatchObject({
      drillStatus: 'drilled_ok',
      evidence: expect.objectContaining({ loadedGeneration: 2, backupExists: true, ok: true }),
    });
    expect(byFile.get('src/security/NoeHostExecEnv.js').evidence).toMatchObject({
      dangerousDropped: true,
      secretsDropped: true,
      defaultsApplied: true,
      safeExtraAllowed: true,
    });
    expect(byFile.get('src/secrets/NoeSecretBroker.js').evidence).toMatchObject({
      keychainNoDashW: true,
      keychainValueRedacted: true,
      envSecretRedacted: true,
      outsideRootBlocked: true,
    });
    expect(byFile.get('src/identity/Voiceprint.js').evidence.embeddingLength).toBeGreaterThan(10);
    expect(byFile.get('src/knowledge/learned/citation-renderer.js').evidence).toMatchObject({
      citationLinked: true,
      missingCitationPreserved: true,
      htmlEscaped: true,
    });
    expect(byFile.get('src/bootstrap/load-env.js')).toMatchObject({
      drillStatus: 'drilled_ok',
      evidence: expect.objectContaining({
        tempCopyOnly: true,
        importedTempCopy: true,
        topLevelLoadedTempEnv: true,
        didNotOverrideExisting: true,
        missingFileReturnsFalse: true,
        explicitFileLoads: true,
      }),
    });
    expect(report.policy).toMatchObject({
      noRealEnvFileReads: true,
      tempEnvFileOnly: true,
      noProjectEnvImport: true,
      noRealKeychainSecretReads: true,
      noNetworkCalls: true,
    });
    expect(raw).not.toContain('unit-test-secret-value');
    expect(md).not.toContain('unit-test-secret-value');
  });
});
