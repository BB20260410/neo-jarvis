// @ts-check
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  utimesSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compactFailureModes } from '../../src/server/services/noe-mind-failure-modes.js';

let rootDir;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'noe-mind-fm-'));
});

afterEach(() => {
  if (rootDir && existsSync(rootDir)) {
    rmSync(rootDir, { recursive: true, force: true });
  }
  rootDir = '';
});

function writeReport(file, data, mtimeMs) {
  const dir = join(rootDir, 'output', 'noe-failure-modes-attribution');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, file);
  writeFileSync(p, JSON.stringify(data));
  if (mtimeMs != null) {
    utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  }
  return p;
}

describe('compactFailureModes', () => {
  it('returns disabled shape when no attribution dir exists', () => {
    const result = compactFailureModes(rootDir);
    expect(result).toEqual({ enabled: false, ok: false, clusters: [] });
  });

  it('returns disabled shape when dir has no parseable JSON', () => {
    const dir = join(rootDir, 'output', 'noe-failure-modes-attribution');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report.json'), 'not json{');
    const result = compactFailureModes(rootDir);
    expect(result).toEqual({ enabled: false, ok: false, clusters: [] });
  });

  it('returns compacted summary for a valid report', () => {
    const report = {
      ok: true,
      generatedAtIso: '2025-01-01T00:00:00.000Z',
      summary: { clusterCount: 2, j0LiteGapSeedCount: 1 },
      blockers: ['b1', 'b2'],
      warnings: ['w1', 'w2'],
      failureModeClusters: [
        {
          cluster: 'C1',
          count: 3,
          severity: 'high',
          derived: true,
          origin: 'src/foo.js',
          matchedEvidenceCount: 5,
          suggestedGapSeed: { seedId: 's1', readyForJ0Lite: true },
          recommendedNextAction: 'fix it',
          replaySafety: { level: 'safe' },
        },
      ],
    };
    writeReport('report.json', report, Date.now());
    const result = compactFailureModes(rootDir);
    expect(result.enabled).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.generatedAt).toBe('2025-01-01T00:00:00.000Z');
    expect(result.reportPath).toBe('output/noe-failure-modes-attribution/report.json');
    expect(result.clusterCount).toBe(2);
    expect(result.j0LiteGapSeedCount).toBe(1);
    expect(result.blockers).toEqual(['b1', 'b2']);
    expect(result.warnings).toEqual(['w1', 'w2']);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]).toEqual({
      cluster: 'C1',
      count: 3,
      severity: 'high',
      derived: true,
      origin: 'src/foo.js',
      matchedEvidenceCount: 5,
      seedId: 's1',
      readyForJ0Lite: true,
      nextAction: 'fix it',
      replayLevel: 'safe',
    });
  });

  it('slices clusters to 5', () => {
    const clusters = Array.from({ length: 8 }, (_, i) => ({
      cluster: `C${i}`,
      count: i,
      severity: 'low',
    }));
    writeReport('report.json', { failureModeClusters: clusters }, Date.now());
    const result = compactFailureModes(rootDir);
    expect(result.clusters).toHaveLength(5);
  });

  it('slices blockers and warnings to 8', () => {
    writeReport(
      'report.json',
      {
        failureModeClusters: [],
        blockers: Array.from({ length: 12 }, (_, i) => `b${i}`),
        warnings: Array.from({ length: 12 }, (_, i) => `w${i}`),
      },
      Date.now(),
    );
    const result = compactFailureModes(rootDir);
    expect(result.blockers).toHaveLength(8);
    expect(result.warnings).toHaveLength(8);
  });

  it('truncates nextAction to 180 chars', () => {
    const longAction = 'x'.repeat(300);
    writeReport(
      'report.json',
      {
        failureModeClusters: [
          { cluster: 'C1', count: 1, severity: 'low', recommendedNextAction: longAction },
        ],
      },
      Date.now(),
    );
    const result = compactFailureModes(rootDir);
    expect(result.clusters[0].nextAction).toHaveLength(180);
  });

  it('uses defaults for missing cluster fields', () => {
    writeReport('report.json', { failureModeClusters: [{}] }, Date.now());
    const result = compactFailureModes(rootDir);
    expect(result.clusters[0]).toEqual({
      cluster: '',
      count: 0,
      severity: '',
      derived: false,
      origin: '',
      matchedEvidenceCount: 0,
      seedId: '',
      readyForJ0Lite: false,
      nextAction: '',
      replayLevel: '',
    });
  });

  it('prefers the newest JSON by mtime', () => {
    const now = Date.now();
    const oldReport = { ok: false, failureModeClusters: [{ cluster: 'old' }] };
    const newReport = { ok: true, failureModeClusters: [{ cluster: 'new' }] };
    writeReport('report.json', oldReport, now - 10000);
    writeReport('latest.json', newReport, now);
    const result = compactFailureModes(rootDir);
    expect(result.ok).toBe(true);
    expect(result.clusters[0].cluster).toBe('new');
  });

  it('returns ok=false when report.ok is not true', () => {
    writeReport('report.json', { ok: false, failureModeClusters: [] }, Date.now());
    const result = compactFailureModes(rootDir);
    expect(result.enabled).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('falls back to clusters.length when summary.clusterCount is missing', () => {
    writeReport(
      'report.json',
      { failureModeClusters: [{ cluster: 'a' }, { cluster: 'b' }, { cluster: 'c' }] },
      Date.now(),
    );
    const result = compactFailureModes(rootDir);
    expect(result.clusterCount).toBe(3);
  });
});
