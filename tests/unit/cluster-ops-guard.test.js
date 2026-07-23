import { describe, expect, it } from 'vitest';
import {
  buildClusterOpsGuardReport,
  classifyClusterOpsEntry,
} from '../../src/server/services/cluster-ops-guard.js';

describe('cluster ops guard', () => {
  it('passes when recent history and rooms are healthy', () => {
    const report = buildClusterOpsGuardReport({
      historyEntries: [
        { ok: true, restartMethod: 'check' },
        { ok: true, restartMethod: 'launchd' },
      ],
      currentReport: { ok: true, health: { status: 'passed' } },
      rooms: [
        { mode: 'cross_verify', status: 'done' },
        { mode: 'cross_verify', status: 'idle' },
      ],
      now: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(report).toMatchObject({
      guardVersion: 'cluster-ops-guard-v1',
      generatedAt: '2026-06-01T00:00:00.000Z',
      status: 'passed',
      ok: true,
      blockers: [],
      warnings: [],
    });
  });

  it('blocks on consecutive operational failures', () => {
    const report = buildClusterOpsGuardReport({
      historyEntries: [{ ok: false, restartMethod: 'check' }],
      currentReport: { ok: false, diagnostics: { status: 'blocked' } },
      rooms: [],
      now: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(report.status).toBe('blocked');
    expect(report.ok).toBe(false);
    expect(report.blockers).toEqual(['consecutive_ops_failures=2']);
  });

  it('warns on repair loops before blocking', () => {
    const report = buildClusterOpsGuardReport({
      historyEntries: [
        { ok: true, repair: { status: 'repaired', appliedActions: ['cleaned_active_abort_controllers'] } },
      ],
      currentReport: { ok: true, repair: { status: 'repaired', appliedActions: ['paused_stalled_active_rooms'] } },
      rooms: [],
      now: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(report.status).toBe('warn');
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual(['repair_actions_gte_2']);
  });

  it('blocks on room backlog and error accumulation', () => {
    const rooms = [
      ...Array.from({ length: 6 }, (_, index) => ({ mode: 'cross_verify', status: index % 2 ? 'running' : 'queued' })),
      ...Array.from({ length: 3 }, () => ({ mode: 'cross_verify', status: 'error' })),
    ];
    const report = buildClusterOpsGuardReport({
      currentReport: { ok: true },
      rooms,
      now: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(report.status).toBe('blocked');
    expect(report.blockers).toEqual(expect.arrayContaining([
      'inflight_rooms_gte_6',
      'error_rooms_gte_3',
    ]));
  });

  it('classifies risky restart only when restart carries failure or warnings', () => {
    expect(classifyClusterOpsEntry({ ok: true, restartMethod: 'launchd' })).toMatchObject({
      restartAction: true,
      riskyRestart: false,
    });
    expect(classifyClusterOpsEntry({ ok: true, restartMethod: 'launchd', warnings: ['cluster_repair_warn', 'cluster_assurance_warn'] })).toMatchObject({
      restartAction: true,
      riskyRestart: false,
    });
    expect(classifyClusterOpsEntry({ ok: true, restartMethod: 'launchd', warnings: ['cluster_resource_guard_warn'] })).toMatchObject({
      restartAction: true,
      riskyRestart: true,
    });
    expect(classifyClusterOpsEntry({ ok: true, restartMethod: 'launchd', resourceGuard: { status: 'warn' } })).toMatchObject({
      restartAction: true,
      riskyRestart: true,
    });
  });
});
