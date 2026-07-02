import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildReplayReportFromText,
  writeReplayReport,
} from '../../scripts/noe-self-talk-audit-replay.mjs';

const NOW = Date.parse('2026-06-12T12:00:00.000Z');

function line(record) {
  return JSON.stringify(record);
}

describe('noe-self-talk-audit-replay', () => {
  it('summarizes 24h/48h audit windows without exposing thought text', () => {
    const jsonl = [
      line({
        ts: NOW - 50 * 3_600_000,
        channel: 'rumination_guard',
        proposalId: 'old-guard',
        state: 'repetitive',
        thought: 'old private thought must not leak',
      }),
      line({
        ts: NOW - 30 * 3_600_000,
        channel: 'self_talk_outcome',
        proposalId: 'old-blocked',
        commit: { committed: false, blockedReason: 'repetitive', committedAt: NOW - 30 * 3_600_000 },
        thought: 'blocked private thought must not leak',
      }),
      line({
        ts: NOW - 20 * 3_600_000,
        channel: 'rumination_guard',
        proposalId: 'recent-guard',
        state: 'repetitive',
        thought: 'recent private thought must not leak',
      }),
      line({
        ts: NOW - 60_000,
        channel: 'self_talk_outcome',
        proposalId: 'played',
        commit: { committed: true, committedAt: NOW - 60_000, eventId: 7 },
        landing: {
          type: 'awareness',
          targetId: 'owner-visible',
          at: NOW - 30_000,
          delivery: {
            status: 'played_to_user_confirmed',
            confirmedAt: NOW - 10_000,
            confirmationSource: 'telemetry',
          },
        },
        thought: 'played private thought must not leak',
      }),
    ].join('\n');

    const report = buildReplayReportFromText(jsonl, {
      file: '/tmp/audit.jsonl',
      now: NOW,
      windowsHours: [24, 48],
    });

    expect(report.ok).toBe(true);
    expect(report.totalRecords).toBe(4);
    expect(report.confirmedDelivery).toBe(1);
    expect(report.windows).toHaveLength(2);
    expect(report.windows[0].hours).toBe(24);
    expect(report.windows[0].coversFullWindow).toBe(true);
    expect(report.windows[0].decision).toEqual({
      thresholdTuningReady: true,
      reason: 'window_ready_for_threshold_review',
      recommendedAction: 'review_guard_records_before_threshold_change',
    });
    expect(report.windows[0].summary.totalRecords).toBe(2);
    expect(report.windows[0].summary.confirmedDelivery).toBe(1);
    expect(report.windows[1].hours).toBe(48);
    expect(report.windows[1].coversFullWindow).toBe(true);
    expect(report.windows[1].summary.totalRecords).toBe(3);
    expect(report.auditRange.spanHours).toBe(49.983);
    expect(JSON.stringify(report)).not.toContain('private thought');
    expect(JSON.stringify(report)).not.toContain('owner-visible');
  });

  it('marks a window as incomplete when there is no older boundary evidence', () => {
    const jsonl = [
      line({
        ts: NOW - 2 * 3_600_000,
        channel: 'rumination_guard',
        proposalId: 'recent-only',
        state: 'repetitive',
      }),
    ].join('\n');
    const report = buildReplayReportFromText(jsonl, {
      now: NOW,
      windowsHours: [24],
    });

    expect(report.windows[0].coversFullWindow).toBe(false);
    expect(report.windows[0].decision).toEqual({
      thresholdTuningReady: false,
      reason: 'window_not_fully_covered',
      recommendedAction: 'continue_collecting_window',
    });
    expect(report.windows[0].summary.guardRecords).toBe(1);
    expect(report.windows[0].summary.ruminationGuardTripRate).toBe(1);
  });

  it('requires guard records before threshold tuning even when the window is covered', () => {
    const jsonl = [
      line({
        ts: NOW - 26 * 3_600_000,
        channel: 'self_talk_outcome',
        proposalId: 'boundary',
        commit: { committed: false, blockedReason: 'repetitive', committedAt: NOW - 26 * 3_600_000 },
      }),
      line({
        ts: NOW - 60_000,
        channel: 'self_talk_outcome',
        proposalId: 'recent',
        commit: { committed: false, blockedReason: 'repetitive', committedAt: NOW - 60_000 },
      }),
    ].join('\n');
    const report = buildReplayReportFromText(jsonl, {
      now: NOW,
      windowsHours: [24],
    });

    expect(report.windows[0].coversFullWindow).toBe(true);
    expect(report.windows[0].summary.guardRecords).toBe(0);
    expect(report.windows[0].decision).toEqual({
      thresholdTuningReady: false,
      reason: 'no_guard_records_in_window',
      recommendedAction: 'continue_collecting_guard_records',
    });
  });

  it('writes a replay report artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-p6-audit-replay-'));
    try {
      const report = buildReplayReportFromText('', { now: NOW, windowsHours: [24] });
      const out = writeReplayReport(report, join(root, 'report.json'));
      expect(out).toBe(join(root, 'report.json'));
      const saved = JSON.parse(readFileSync(out, 'utf8'));
      expect(saved.windows[0].hours).toBe(24);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
