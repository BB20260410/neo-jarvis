// @ts-check
// Read-only affect health scoring for v4 D5 AI-welfare evidence.
// Inputs are numeric VAD snapshots only; no cause/body/prompt text is needed.

import { clamp01 } from './_mathUtils.js';

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function variance(values = []) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

function round3(value) {
  return Math.round(num(value) * 1000) / 1000;
}

export function evaluateAffectHealth(rows = [], {
  now = Date.now(),
  minSamples = 12,
  staleMs = 24 * 3600_000,
  saturationNear = 0.95,
} = {}) {
  const samples = rows
    .map((row) => ({
      ts: num(row.ts, 0),
      v: Math.max(-1, Math.min(1, num(row.v, 0))),
      a: clamp01(num(row.a, 0)),
      d: Math.max(-1, Math.min(1, num(row.d, 0))),
    }))
    .filter((row) => row.ts > 0)
    .sort((a, b) => b.ts - a.ts);
  if (!samples.length) {
    return {
      ok: false,
      status: 'missing_samples',
      score: 0,
      sampleCount: 0,
      latestAgeMs: null,
      saturatedRatio: 0,
      varianceMean: 0,
      alerts: ['no_affect_samples'],
      thresholds: { minSamples, staleMs, saturationNear },
      policy: { numericVadOnly: true, noCauseTextRequired: true, saturationMode: 'dimension_ratio' },
    };
  }
  const latest = samples[0] || null;
  const latestAgeMs = latest ? Math.max(0, now - latest.ts) : null;
  const rowSaturatedCount = samples.filter((row) => (
    Math.abs(row.v) >= saturationNear || row.a >= saturationNear || Math.abs(row.d) >= saturationNear
  )).length;
  const saturatedDimensionCount = samples.reduce((sum, row) => (
    sum
    + (Math.abs(row.v) >= saturationNear ? 1 : 0)
    + (row.a >= saturationNear ? 1 : 0)
    + (Math.abs(row.d) >= saturationNear ? 1 : 0)
  ), 0);
  const rowSaturatedRatio = samples.length ? rowSaturatedCount / samples.length : 0;
  const saturatedRatio = samples.length ? saturatedDimensionCount / (samples.length * 3) : 0;
  const varianceMean = ['v', 'a', 'd']
    .map((key) => variance(samples.map((row) => row[key])))
    .reduce((sum, value) => sum + value, 0) / 3;
  const varianceScore = clamp01(varianceMean / 0.02);
  const sampleScore = clamp01(samples.length / minSamples);
  const freshnessScore = latestAgeMs == null ? 0 : clamp01(1 - latestAgeMs / staleMs);
  const saturationScore = clamp01(1 - saturatedRatio);
  const score = clamp01(0.25 * sampleScore + 0.25 * freshnessScore + 0.25 * saturationScore + 0.25 * varianceScore);
  const alerts = [];
  if (!samples.length) alerts.push('no_affect_samples');
  if (samples.length > 0 && samples.length < minSamples) alerts.push('insufficient_affect_samples');
  if (latestAgeMs != null && latestAgeMs > staleMs) alerts.push('affect_snapshot_stale');
  if (saturatedRatio >= 0.25) alerts.push('affect_saturation_high');
  if (samples.length >= minSamples && varianceScore < 0.25) alerts.push('affect_variance_low');
  const ok = score >= 0.7 && alerts.length === 0;
  return {
    ok,
    status: ok ? 'healthy' : 'needs_attention',
    score: round3(score),
    sampleCount: samples.length,
    latestAgeMs,
    saturatedRatio: round3(saturatedRatio),
    rowSaturatedRatio: round3(rowSaturatedRatio),
    varianceMean: round3(varianceMean),
    alerts,
    thresholds: { minSamples, staleMs, saturationNear },
    policy: { numericVadOnly: true, noCauseTextRequired: true, saturationMode: 'dimension_ratio' },
  };
}
