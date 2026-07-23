import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCriticalModuleDrilldown } from '../../scripts/noe-critical-module-drilldown.mjs';

describe('noe-critical-module-drilldown', () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('assigns file-specific next actions for affect, owner prediction, and semantic memory gaps', () => {
    dir = mkdtempSync(join(tmpdir(), 'noe-critical-module-drilldown-'));
    const inventoryPath = join(dir, 'inventory.json');
    const moduleMapPath = join(dir, 'module-map.json');
    const files = [
      {
        file: 'src/cognition/NoeAffectHealth.js',
        module: 'cognition',
        role: 'cognition_expectations_goals_workspace',
        lines: 84,
        symbols: ['export:function:evaluateAffectHealth'],
        envVars: [],
        tests: ['tests/unit/noe-affect-health.test.js'],
        testImporters: ['tests/unit/noe-runtime-evidence-audit.test.js'],
      },
      {
        file: 'src/cognition/NoeOwnerBehaviorPredictor.js',
        module: 'cognition',
        role: 'cognition_expectations_goals_workspace',
        lines: 325,
        symbols: ['export:function:createOwnerBehaviorPredictor'],
        envVars: [],
        tests: ['tests/unit/noe-owner-behavior-predictor.test.js'],
        testImporters: [],
      },
      {
        file: 'src/memory/NoeMemorySemanticConfig.js',
        module: 'memory',
        role: 'memory_write_retrieval_governance',
        lines: 37,
        symbols: ['export:function:resolveNoeMemorySemanticConfig'],
        envVars: [],
        tests: ['tests/unit/noe-memory-semantic-config.test.js'],
        testImporters: [],
      },
    ];
    writeFileSync(inventoryPath, JSON.stringify({ generatedAt: 't0', files }));
    writeFileSync(moduleMapPath, JSON.stringify({
      generatedAt: 't1',
      totals: {
        runtimeBlockers: [
          'expectation_no_failed_samples',
          'curiosity_source_surprise_absent',
          'memory_semantic_runtime_unconfigured',
          'affect_health_below_target',
        ],
      },
      files: [
        {
          file: files[0].file,
          module: 'cognition',
          role: files[0].role,
          lines: 84,
          risk: 'covered_by_tests_or_importer_tests',
          runtimeEvidence: {
            strength: 'live_with_gap',
            gaps: ['no_failed_samples', 'source_surprise_absent', 'live_pending_restart_or_natural_sample'],
          },
          testEvidence: { directTests: 1, testImporters: 1 },
        },
        {
          file: files[1].file,
          module: 'cognition',
          role: files[1].role,
          lines: 325,
          risk: 'covered_by_tests_or_importer_tests',
          runtimeEvidence: {
            strength: 'live_with_gap',
            gaps: ['no_failed_samples', 'source_surprise_absent', 'live_pending_restart_or_natural_sample'],
          },
          testEvidence: { directTests: 1, testImporters: 0 },
        },
        {
          file: files[2].file,
          module: 'memory',
          role: files[2].role,
          lines: 37,
          risk: 'covered_by_tests_or_importer_tests',
          runtimeEvidence: {
            strength: 'live_with_gap',
            gaps: ['semantic_runtime_unconfigured'],
          },
          testEvidence: { directTests: 1, testImporters: 0 },
        },
      ],
    }));

    const report = buildCriticalModuleDrilldown({
      inventoryPath,
      moduleMapPath,
      modules: ['cognition', 'memory'],
    });
    const byFile = new Map(report.files.map((file) => [file.basename, file.nextAction]));

    expect(byFile.get('NoeAffectHealth.js')).toBe('restart_and_observe_affect_desaturation_or_fix_appraisal');
    expect(byFile.get('NoeOwnerBehaviorPredictor.js')).toBe('restart_then_observe_owner_negative_followup_sample');
    expect(byFile.get('NoeMemorySemanticConfig.js')).toBe('restart_or_env_verify_semantic_memory_runtime');
    expect(report.summary.files).toBe(3);
  });
});
