import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildNoeFullCodeFunctionAtlas } from '../../scripts/noe-full-code-function-atlas.mjs';

describe('noe-full-code-function-atlas', () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('builds a no-body file and symbol atlas with runtime gaps and next actions', () => {
    dir = mkdtempSync(join(tmpdir(), 'noe-full-code-function-atlas-'));
    mkdirSync(join(dir, 'src', 'cognition'), { recursive: true });
    mkdirSync(join(dir, 'src', 'memory'), { recursive: true });
    mkdirSync(join(dir, 'tests', 'unit'), { recursive: true });
    const ownerFile = join(dir, 'src', 'cognition', 'NoeOwnerBehaviorPredictor.js');
    const memoryFile = join(dir, 'src', 'memory', 'NoeMemorySemanticConfig.js');
    const testFile = join(dir, 'tests', 'unit', 'noe-owner-behavior-predictor.test.js');
    writeFileSync(ownerFile, [
      'const secretBody = "secret body should never be exported";',
      'export function createOwnerBehaviorPredictor() {',
      '  return {',
      '    settle() { return secretBody.length; }',
      '  };',
      '}',
    ].join('\n'));
    writeFileSync(memoryFile, [
      'export const resolveNoeMemorySemanticConfig = () => ({',
      '  provider: "ollama",',
      '});',
    ].join('\n'));
    writeFileSync(testFile, 'import "../../src/cognition/NoeOwnerBehaviorPredictor.js";\n');

    const inventoryPath = join(dir, 'inventory.json');
    const moduleMapPath = join(dir, 'module-map.json');
    writeFileSync(inventoryPath, JSON.stringify({
      root: dir,
      generatedAt: '2026-06-15T00:00:00.000Z',
      files: [
        {
          file: 'src/cognition/NoeOwnerBehaviorPredictor.js',
          module: 'cognition',
          role: 'cognition_expectations_goals_workspace',
          lines: 6,
          symbols: ['export:function:createOwnerBehaviorPredictor'],
          envVars: [],
          routeHints: [],
          runtimeHints: [],
          sourceImporters: ['server.js'],
          localImports: [],
          tests: ['tests/unit/noe-owner-behavior-predictor.test.js'],
          testImporters: [],
        },
        {
          file: 'src/memory/NoeMemorySemanticConfig.js',
          module: 'memory',
          role: 'memory_write_retrieval_governance',
          lines: 3,
          symbols: ['export:const:resolveNoeMemorySemanticConfig'],
          envVars: ['NOE_MEMORY_EMBED'],
          routeHints: [],
          runtimeHints: ['memory_runtime_or_maintenance'],
          sourceImporters: ['server.js'],
          localImports: [],
          tests: [],
          testImporters: [],
        },
        {
          file: 'tests/unit/noe-owner-behavior-predictor.test.js',
          module: 'tests',
          role: 'unit_or_route_test',
          lines: 1,
          symbols: [],
          envVars: [],
          routeHints: [],
          runtimeHints: [],
          sourceImporters: [],
          localImports: [],
          tests: [],
          testImporters: [],
        },
      ],
    }));
    writeFileSync(moduleMapPath, JSON.stringify({
      generatedAt: '2026-06-15T00:01:00.000Z',
      totals: {
        runtimeBlockers: [
          'expectation_no_failed_samples',
          'curiosity_source_surprise_absent',
          'memory_semantic_runtime_unconfigured',
        ],
      },
      files: [
        {
          file: 'src/cognition/NoeOwnerBehaviorPredictor.js',
          module: 'cognition',
          role: 'cognition_expectations_goals_workspace',
          lines: 6,
          risk: 'covered_by_tests_or_importer_tests',
          runtimeEvidence: {
            strength: 'live_with_gap',
            mappedRuntimeIds: ['owner_prediction'],
            mappedRuntimeVerdicts: ['owner_prediction:code_ready_live_pending_restart'],
            gaps: ['live_pending_restart_or_natural_sample', 'no_failed_samples', 'source_surprise_absent'],
          },
          testEvidence: { directTests: 1, testImporters: 0 },
        },
        {
          file: 'src/memory/NoeMemorySemanticConfig.js',
          module: 'memory',
          role: 'memory_write_retrieval_governance',
          lines: 3,
          risk: 'runtime_surface_needs_behavioral_check',
          runtimeEvidence: {
            strength: 'live_with_gap',
            mappedRuntimeIds: ['long_term_memory'],
            mappedRuntimeVerdicts: ['long_term_memory:running'],
            gaps: ['semantic_runtime_unconfigured'],
          },
          testEvidence: { directTests: 0, testImporters: 0 },
        },
        {
          file: 'tests/unit/noe-owner-behavior-predictor.test.js',
          module: 'tests',
          role: 'unit_or_route_test',
          lines: 1,
          risk: 'test_artifact',
          runtimeEvidence: { strength: 'static_only', gaps: ['no_direct_runtime_module_mapping'] },
          testEvidence: { directTests: 0, testImporters: 0 },
        },
      ],
    }));

    const atlas = buildNoeFullCodeFunctionAtlas({ inventoryPath, moduleMapPath, root: dir });
    const owner = atlas.files.find((file) => file.file.includes('NoeOwnerBehaviorPredictor'));
    const memory = atlas.files.find((file) => file.file.includes('NoeMemorySemanticConfig'));

    expect(atlas.summary.files).toBe(3);
    expect(atlas.summary.symbolBlocks).toBeGreaterThanOrEqual(3);
    expect(owner.nextAction).toBe('restart_then_observe_owner_negative_followup_sample');
    expect(owner.symbolBlocks.some((block) => block.name === 'createOwnerBehaviorPredictor' && block.exported && block.startLine === 2)).toBe(true);
    expect(owner.symbolBlocks.some((block) => block.name === 'settle' && block.kind === 'method')).toBe(true);
    expect(memory.nextAction).toBe('restart_or_env_verify_semantic_memory_runtime');
    expect(memory.runtime.proof).toBe('module_live_with_gap_inferred');
    expect(JSON.stringify(atlas)).not.toContain('secret body should never be exported');
  });
});
