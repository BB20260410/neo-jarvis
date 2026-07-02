import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildModelHealthReport, writeModelHealthReport } from '../../scripts/noe-model-health-snapshot.mjs';

describe('noe-model-health-snapshot', () => {
  it('writes timestamped and latest model health reports without secret values', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'noe-model-health-'));
    try {
      const report = buildModelHealthReport({
        now: Date.parse('2026-06-12T05:10:00Z'),
        lmstudio: {
          ok: true,
          loadedModels: ['qwen/qwen3.6-35b-a3b'],
          loadedProbeChangedModels: false,
        },
        ollama: { ok: false, error: 'fetch failed' },
        providerHealth: {
          ok: false,
          unavailableProviders: ['openai'],
          providers: { openai: { ok: false, source: 'unconfigured' } },
        },
      });
      const paths = writeModelHealthReport(report, {
        outDir,
        now: Date.parse('2026-06-12T05:10:00Z'),
      });

      expect(paths.reportPath).toMatch(/model-health-1781241000000\.json$/);
      expect(paths.latestPath).toMatch(/latest\.json$/);
      const timestamped = JSON.parse(readFileSync(join(outDir, 'model-health-1781241000000.json'), 'utf8'));
      const latest = JSON.parse(readFileSync(join(outDir, 'latest.json'), 'utf8'));
      expect(latest).toEqual(timestamped);
      expect(latest.policy).toMatchObject({
        readOnly: true,
        noChatCompletionCalls: true,
        lmStudioLoadUnloadChanged: false,
        secretValuesReturned: false,
      });
      expect(JSON.stringify(latest)).not.toMatch(/sk-|token=|cookie=/i);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
