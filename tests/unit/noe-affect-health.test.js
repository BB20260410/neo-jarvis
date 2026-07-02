import { describe, expect, it } from 'vitest';
import { evaluateAffectHealth } from '../../src/cognition/NoeAffectHealth.js';

const NOW = Date.parse('2026-06-15T00:00:00Z');

function variedRows(count = 16) {
  return Array.from({ length: count }, (_, i) => ({
    ts: NOW - i * 60_000,
    v: 0.05 + Math.sin(i / 2) * 0.25,
    a: 0.35 + Math.cos(i / 3) * 0.2,
    d: 0.1 + Math.sin(i / 4) * 0.2,
    cause: `raw cause ${i} should not appear`,
  }));
}

describe('NoeAffectHealth', () => {
  it('scores recent varied VAD samples as healthy', () => {
    const report = evaluateAffectHealth(variedRows(), { now: NOW });

    expect(report.ok).toBe(true);
    expect(report.status).toBe('healthy');
    expect(report.score).toBeGreaterThanOrEqual(0.7);
    expect(report.alerts).toEqual([]);
  });

  it('reports missing samples without throwing', () => {
    const report = evaluateAffectHealth([], { now: NOW });

    expect(report.ok).toBe(false);
    expect(report.status).toBe('missing_samples');
    expect(report.score).toBeLessThan(0.7);
    expect(report.alerts).toContain('no_affect_samples');
  });

  it('penalizes saturated VAD rows near boundaries', () => {
    const rows = Array.from({ length: 16 }, (_, i) => ({
      ts: NOW - i * 60_000,
      v: 0.99,
      a: 0.98,
      d: 0.97,
    }));
    const report = evaluateAffectHealth(rows, { now: NOW });

    expect(report.ok).toBe(false);
    expect(report.saturatedRatio).toBe(1);
    expect(report.rowSaturatedRatio).toBe(1);
    expect(report.alerts).toContain('affect_saturation_high');
  });

  it('scores saturation by VAD dimensions instead of treating one saturated dimension as a fully saturated row', () => {
    const rows = Array.from({ length: 16 }, (_, i) => ({
      ts: NOW - i * 60_000,
      v: Math.sin(i / 2) * 0.4,
      a: 0.98,
      d: Math.cos(i / 3) * 0.3,
    }));
    const report = evaluateAffectHealth(rows, { now: NOW });

    expect(report.saturatedRatio).toBeCloseTo(1 / 3, 3);
    expect(report.rowSaturatedRatio).toBe(1);
    expect(report.score).toBeGreaterThanOrEqual(0.7);
    expect(report.alerts).toContain('affect_saturation_high');
  });

  it('penalizes stale latest snapshots', () => {
    const rows = variedRows().map((row) => ({ ...row, ts: NOW - 3 * 24 * 3600_000 - (NOW - row.ts) }));
    const report = evaluateAffectHealth(rows, { now: NOW });

    expect(report.ok).toBe(false);
    expect(report.alerts).toContain('affect_snapshot_stale');
  });

  it('does not copy cause text or other raw episode content into the report', () => {
    const rows = variedRows();
    const report = evaluateAffectHealth(rows, { now: NOW });

    expect(JSON.stringify(report)).not.toContain('raw cause');
    expect(report.policy).toMatchObject({ numericVadOnly: true, noCauseTextRequired: true, saturationMode: 'dimension_ratio' });
  });
});
