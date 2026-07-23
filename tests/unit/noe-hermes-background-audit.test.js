import { describe, expect, it } from 'vitest';
import { buildHermesBackgroundAudit } from '../../scripts/noe-hermes-background-audit.mjs';

const DAY = 24 * 60 * 60 * 1000;

function record(category, offsetMs, ok = true) {
  const now = Date.parse('2026-06-13T00:00:00.000Z');
  return {
    category,
    ref: `output/${category}/${offsetMs}.json`,
    at: now - offsetMs,
    ok,
    summary: {},
  };
}

function allCategories(offsetMs) {
  return [
    record('mission_finalization', offsetMs),
    record('background_review', offsetMs),
    record('skill_curator', offsetMs),
    record('memory_provider', offsetMs),
    record('candidate_holdout', offsetMs),
    record('patch_apply_chain', offsetMs),
  ];
}

describe('noe-hermes-background-audit', () => {
  it('blocks when the observation span is shorter than the requested 24h window', () => {
    const now = Date.parse('2026-06-13T00:00:00.000Z');
    const report = buildHermesBackgroundAudit({
      now,
      windowHours: 24,
      records: [
        ...allCategories(60_000),
        ...allCategories(10 * 60_000),
      ],
    });

    expect(report.ok).toBe(true);
    expect(report.status).toBe('blocked');
    expect(report.blockers[0]).toMatch(/insufficient_observation_window/);
    expect(report.note).toContain('does not prove a full 24h');
    expect(report.categories.memory_provider.count).toBe(2);
    expect(report.categories.patch_apply_chain.count).toBe(2);
  });

  it('blocks missing evidence categories even when the duration is long enough', () => {
    const now = Date.parse('2026-06-13T00:00:00.000Z');
    const report = buildHermesBackgroundAudit({
      now,
      windowHours: 24,
      records: [
        record('mission_finalization', DAY),
        record('background_review', DAY / 2),
        record('candidate_holdout', 60_000),
      ],
    });

    expect(report.status).toBe('blocked');
    expect(report.blockers).toContain('missing_category:skill_curator');
    expect(report.blockers).toContain('missing_category:memory_provider');
    expect(report.blockers).toContain('missing_category:patch_apply_chain');
  });

  it('passes when all categories span the requested window', () => {
    const now = Date.parse('2026-06-13T00:00:00.000Z');
    const report = buildHermesBackgroundAudit({
      now,
      windowHours: 24,
      records: [
        ...allCategories(DAY),
        ...allCategories(DAY / 2),
        ...allCategories(60_000),
      ],
    });

    expect(report.status).toBe('passed');
    expect(report.blockers).toEqual([]);
    expect(report.observed.recordCount).toBe(18);
    expect(report.categories.mission_finalization.count).toBe(3);
    expect(report.categories.patch_apply_chain.count).toBe(3);
  });
});
