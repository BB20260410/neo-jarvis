import { describe, expect, it } from 'vitest';
import {
  buildClusterResourceGuardReport,
  buildClusterResourceSnapshot,
} from '../../src/server/services/cluster-resource-guard.js';

describe('cluster resource guard', () => {
  it('passes under normal resource pressure', () => {
    const report = buildClusterResourceGuardReport({
      snapshot: {
        rssMb: 128,
        heapUsedRatio: 0.4,
        activeHandles: 12,
        activeRequests: 1,
        eventLoopLagMs: 20,
      },
      config: {
        warnRssMb: 512,
        maxRssMb: 1024,
        warnHeapUsedRatio: 0.8,
        maxHeapUsedRatio: 0.95,
        warnActiveHandles: 100,
        maxActiveHandles: 200,
        warnActiveRequests: 20,
        maxActiveRequests: 40,
        warnEventLoopLagMs: 100,
        maxEventLoopLagMs: 500,
      },
      now: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(report).toMatchObject({
      guardVersion: 'cluster-resource-guard-v1',
      generatedAt: '2026-06-01T00:00:00.000Z',
      status: 'passed',
      ok: true,
      blockers: [],
      warnings: [],
    });
  });

  it('warns before blocking so operators can reduce load', () => {
    const report = buildClusterResourceGuardReport({
      snapshot: {
        rssMb: 700,
        heapUsedRatio: 0.81,
        activeHandles: 120,
        activeRequests: 22,
        eventLoopLagMs: 120,
      },
      config: {
        warnRssMb: 512,
        maxRssMb: 1024,
        warnHeapUsedRatio: 0.8,
        maxHeapUsedRatio: 0.95,
        warnActiveHandles: 100,
        maxActiveHandles: 200,
        warnActiveRequests: 20,
        maxActiveRequests: 40,
        warnEventLoopLagMs: 100,
        maxEventLoopLagMs: 500,
      },
    });

    expect(report.status).toBe('warn');
    expect(report.ok).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.warnings).toEqual(expect.arrayContaining([
      'rss_mb_gte_512mb',
      'heap_used_ratio_gte_0.8',
      'active_handles_gte_100',
      'active_requests_gte_20',
      'event_loop_lag_ms_gte_100ms',
    ]));
  });

  it('blocks when resource pressure crosses hard limits', () => {
    const report = buildClusterResourceGuardReport({
      snapshot: {
        rssMb: 1100,
        heapUsedRatio: 0.97,
        activeHandles: 230,
        activeRequests: 45,
        eventLoopLagMs: 800,
      },
      config: {
        warnRssMb: 512,
        maxRssMb: 1024,
        warnHeapUsedRatio: 0.8,
        maxHeapUsedRatio: 0.95,
        warnActiveHandles: 100,
        maxActiveHandles: 200,
        warnActiveRequests: 20,
        maxActiveRequests: 40,
        warnEventLoopLagMs: 100,
        maxEventLoopLagMs: 500,
      },
    });

    expect(report.status).toBe('blocked');
    expect(report.ok).toBe(false);
    expect(report.blockers).toEqual(expect.arrayContaining([
      'rss_mb_gte_1024mb',
      'heap_used_ratio_gte_0.95',
      'active_handles_gte_200',
      'active_requests_gte_40',
      'event_loop_lag_ms_gte_500ms',
    ]));
  });

  it('does not block on high heap ratio when absolute heap usage is small', () => {
    const report = buildClusterResourceGuardReport({
      snapshot: {
        rssMb: 170,
        heapUsedMb: 65,
        heapUsedRatio: 0.96,
        activeHandles: 7,
        activeRequests: 1,
        eventLoopLagMs: 20,
      },
      config: {
        warnRssMb: 512,
        maxRssMb: 1024,
        warnHeapUsedRatio: 0.8,
        maxHeapUsedRatio: 0.95,
        warnHeapUsedMbForRatio: 256,
        maxHeapUsedMbForRatio: 512,
        warnActiveHandles: 100,
        maxActiveHandles: 200,
        warnActiveRequests: 20,
        maxActiveRequests: 40,
        warnEventLoopLagMs: 100,
        maxEventLoopLagMs: 500,
      },
    });

    expect(report.status).toBe('passed');
    expect(report.ok).toBe(true);
    expect(report.blockers).not.toContain('heap_used_ratio_gte_0.95');
    expect(report.warnings).not.toContain('heap_used_ratio_gte_0.8');
  });

  it('builds a live snapshot without throwing on unsupported process internals', () => {
    const snapshot = buildClusterResourceSnapshot({
      memory: {
        rss: 100 * 1024 * 1024,
        heapUsed: 20 * 1024 * 1024,
        heapTotal: 80 * 1024 * 1024,
        external: 1,
        arrayBuffers: 1,
      },
      activeHandles: 3,
      activeRequests: 0,
    });

    expect(snapshot).toMatchObject({
      rssMb: 100,
      heapUsedMb: 20,
      heapTotalMb: 80,
      heapUsedRatio: 0.25,
      activeHandles: 3,
      activeRequests: 0,
    });
  });
});
