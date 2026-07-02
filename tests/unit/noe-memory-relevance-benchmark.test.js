import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { NoeMemoryRetriever } from '../../src/memory/NoeMemoryRetriever.js';
import {
  runNoeMemoryRelevanceBenchmark,
  runNoeMemoryRelevanceBenchmarkSelfTest,
} from '../../src/memory/NoeMemoryRelevanceBenchmark.js';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noe-memory-relevance-benchmark-test-'));
  initSqlite(join(dir, 'panel.db'));
});

afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

function noLogRetriever(memory) {
  return new NoeMemoryRetriever({
    memory,
    auditLog: { recordRetrieval() {} },
    logger: { warn() {} },
  });
}

describe('runNoeMemoryRelevanceBenchmark', () => {
  it('compares baseline and semantic retrieval without memory body output', async () => {
    const baselineMemory = new MemoryCore({ logger: { warn() {}, info() {} } });
    const semanticMemory = new MemoryCore({
      logger: { warn() {}, info() {} },
      semanticIndex: {
        async search() {
          return [{ refId: 'bench-user-note', score: 0.9 }];
        },
      },
    });
    for (const memory of [baselineMemory, semanticMemory]) {
      memory.write({
        id: 'bench-user-note',
        projectId: 'noe',
        scope: 'user',
        body: '主人明确要求记住的真实偏好是美式咖啡。',
        sourceType: 'voice_note',
      });
      memory.write({
        id: 'bench-project-note',
        projectId: 'noe',
        scope: 'project',
        body: '项目说明：这不是用户个人偏好。',
        sourceType: 'unit',
      });
    }

    const report = await runNoeMemoryRelevanceBenchmark({
      baselineRetriever: noLogRetriever(baselineMemory),
      semanticRetriever: noLogRetriever(semanticMemory),
      cases: [{
        id: 'semantic_user_note',
        query: 'semantic-only owner coffee note',
        routeType: 'chat',
        expectedIds: ['bench-user-note'],
        disallowedIds: ['bench-project-note'],
        maxExpectedRank: 1,
        maxUnlabeledSelected: 0,
      }],
    });

    expect(report.ok).toBe(true);
    expect(report.summary.semanticPassed).toBe(1);
    expect(report.summary.baselinePassed).toBe(0);
    expect(report.results[0].semantic.selectedIds).toEqual(['bench-user-note']);
    expect(report.results[0].semantic.unlabeledSelectedCount).toBe(0);
    expect(report.results[0].baseline.selectedIds).toEqual([]);
    expect(JSON.stringify(report)).not.toContain('美式咖啡');
    expect(report.policy).toMatchObject({
      noMemoryBodyOutput: true,
      retrievalLogWrites: false,
      selectedIdsOnly: true,
    });
  });

  it('self-test produces a passing isolated report', async () => {
    const report = await runNoeMemoryRelevanceBenchmarkSelfTest();
    expect(report.ok).toBe(true);
    expect(report.summary.semanticQualityOk).toBe(true);
  });
});
