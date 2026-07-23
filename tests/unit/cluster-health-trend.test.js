import { describe, it, expect } from 'vitest';
import {
  buildClusterHealthTrendReport,
  classifyClusterHealthEntry,
  parseClusterHealthHistoryJsonl,
} from '../../src/server/services/cluster-health-trend.js';

describe('cluster health trend', () => {
  it('parses jsonl history while counting malformed lines', () => {
    const parsed = parseClusterHealthHistoryJsonl('{"ok":true}\nnot-json\n{"ok":false}\n');

    expect(parsed.entries).toHaveLength(2);
    expect(parsed.parseErrorCount).toBe(1);
  });

  it('classifies repair API absence in old history as neutral but explicit repair 404 as blocked', () => {
    expect(classifyClusterHealthEntry({ ok: true, health: { status: 'passed' } })).toMatchObject({
      status: 'passed',
      repairUnavailable: false,
    });
    expect(classifyClusterHealthEntry({
      ok: false,
      repairApi: { statusCode: 404, json: { error: 'not found' } },
    })).toMatchObject({
      status: 'blocked',
      repairUnavailable: true,
    });
  });

  it('blocks on consecutive recent failures', () => {
    const report = buildClusterHealthTrendReport({
      historyEntries: [
        { ok: true, health: { status: 'passed' } },
        { ok: false, health: { status: 'blocked' } },
      ],
      currentReport: { ok: false, diagnostics: { status: 'blocked' } },
      now: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(report).toMatchObject({
      status: 'blocked',
      ok: false,
      summary: {
        blockedCount: 2,
        consecutiveFailureCount: 2,
      },
      blockers: ['consecutive_cluster_health_failures=2'],
    });
  });

  it('warns on repeated non-blocking warnings without blocking healthy current state', () => {
    const report = buildClusterHealthTrendReport({
      historyEntries: [
        { ok: true, warnings: ['cluster_readiness_warn'] },
        { ok: true, diagnostics: { status: 'warn' } },
      ],
      currentReport: { ok: true, warnings: ['cluster_assurance_warn'] },
      now: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(report.status).toBe('warn');
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual(['recent_cluster_health_warnings=3']);
  });

  it('does not warn on a single recovered historical failure', () => {
    const report = buildClusterHealthTrendReport({
      historyEntries: [
        { ok: true, health: { status: 'passed' } },
        { ok: false, health: { status: 'blocked' } },
      ],
      currentReport: { ok: true, health: { status: 'passed' } },
      now: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(report.status).toBe('passed');
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual([]);
    expect(report.blockers).toEqual([]);
  });

  it('blocks on currently unavailable repair API without letting old repair failures poison recovery', () => {
    const recovered = buildClusterHealthTrendReport({
      historyEntries: [
        { ok: false, repairApi: { statusCode: 404, json: { error: 'not found' } } },
      ],
      currentReport: { ok: true, repairApi: { statusCode: 200, json: { repair: { status: 'passed' } } } },
      now: new Date('2026-06-01T00:00:00.000Z'),
    });
    const currentBroken = buildClusterHealthTrendReport({
      historyEntries: [
        { ok: true, repairApi: { statusCode: 200, json: { repair: { status: 'passed' } } } },
      ],
      currentReport: { ok: false, repairApi: { statusCode: 404, json: { error: 'not found' } } },
      now: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(recovered.status).toBe('passed');
    expect(recovered.blockers).toEqual([]);
    expect(currentBroken.status).toBe('blocked');
    expect(currentBroken.blockers).toEqual(['current_cluster_repair_unavailable']);
  });

  it('does not amplify its own historical trend warnings', () => {
    const report = buildClusterHealthTrendReport({
      historyEntries: [
        { ok: true, warnings: ['cluster_health_trend_warn'] },
        { ok: true, warnings: ['cluster_health_trend_warn'] },
        { ok: true, warnings: ['cluster_health_trend_warn'] },
      ],
      currentReport: { ok: true, health: { status: 'passed' } },
      now: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(report.status).toBe('passed');
    expect(report.summary.warningSignalCount).toBe(0);
    expect(report.warnings).toEqual([]);
  });

  it('does not warn after historical warnings have recovered', () => {
    const report = buildClusterHealthTrendReport({
      historyEntries: [
        { ok: true, warnings: ['cluster_resource_guard_warn'] },
        { ok: true, warnings: ['cluster_repair_warn'] },
        { ok: true, warnings: ['cluster_diagnostics_warn'] },
      ],
      currentReport: { ok: true, health: { status: 'passed' } },
      now: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(report.status).toBe('passed');
    expect(report.summary.warningSignalCount).toBe(3);
    expect(report.summary.consecutiveWarningSignalCount).toBe(0);
    expect(report.warnings).toEqual([]);
  });
});
