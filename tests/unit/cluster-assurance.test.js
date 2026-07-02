import { describe, expect, it } from 'vitest';
import { buildClusterAssuranceReport } from '../../src/server/services/cluster-assurance.js';

const passedDiagnostics = {
  status: 'passed',
  invariants: { safeToStart: true },
  findings: [],
  recoveryPlan: [],
};

describe('cluster assurance', () => {
  it('aggregates live diagnostics and all drill layers into a single passed gate report', async () => {
    const report = await buildClusterAssuranceReport({
      diagnostics: passedDiagnostics,
      now: new Date('2026-06-01T00:30:00.000Z'),
    });

    expect(report).toMatchObject({
      assuranceVersion: 'cluster-assurance-v1',
      generatedAt: '2026-06-01T00:30:00.000Z',
      status: 'passed',
      ok: true,
      summary: {
        gateCount: 4,
        passedGateCount: 4,
        blockedGateCount: 0,
        warningGateCount: 0,
        failedGateIds: [],
      },
      recoveryPlan: [],
      recommendations: [],
    });
    expect(report.gates.map((gate) => gate.id)).toEqual([
      'live_diagnostics',
      'diagnostics_drill',
      'resilience_drill',
      'runtime_drill',
    ]);
  });

  it('adds long-term health trend as a first-class assurance gate when provided', async () => {
    const report = await buildClusterAssuranceReport({
      diagnostics: passedDiagnostics,
      diagnosticsDrill: { ok: true, caseCount: 4, failedCaseCount: 0, results: [] },
      resilienceDrill: { ok: true, caseCount: 6, failedCaseCount: 0, results: [] },
      runtimeDrill: { ok: true, caseCount: 3, failedCaseCount: 0, results: [] },
      healthTrend: {
        status: 'blocked',
        ok: false,
        blockers: ['current_cluster_repair_unavailable'],
        warnings: [],
      },
      now: new Date('2026-06-01T00:32:00.000Z'),
    });

    expect(report).toMatchObject({
      status: 'blocked',
      ok: false,
      summary: {
        gateCount: 5,
        blockedGateCount: 1,
        failedGateIds: ['health_trend'],
        failedCases: ['health_trend:current_cluster_repair_unavailable'],
      },
      recoveryPlan: [
        {
          gateId: 'health_trend',
          severity: 'blocker',
          blocksStart: true,
          command: 'npm run repair:panel && npm run check:panel',
          endpoint: '/api/cluster/health-trend',
        },
      ],
    });
  });

  it('adds resource guard as a first-class assurance gate when provided', async () => {
    const report = await buildClusterAssuranceReport({
      diagnostics: passedDiagnostics,
      diagnosticsDrill: { ok: true, caseCount: 4, failedCaseCount: 0, results: [] },
      resilienceDrill: { ok: true, caseCount: 6, failedCaseCount: 0, results: [] },
      runtimeDrill: { ok: true, caseCount: 3, failedCaseCount: 0, results: [] },
      resourceGuard: {
        status: 'blocked',
        ok: false,
        blockers: ['rss_mb_gte_1024mb'],
        warnings: [],
      },
      now: new Date('2026-06-01T00:33:00.000Z'),
    });

    expect(report).toMatchObject({
      status: 'blocked',
      ok: false,
      summary: {
        gateCount: 5,
        blockedGateCount: 1,
        failedGateIds: ['resource_guard'],
        failedCases: ['resource_guard:rss_mb_gte_1024mb'],
      },
      recoveryPlan: [
        {
          gateId: 'resource_guard',
          severity: 'blocker',
          blocksStart: true,
          command: 'npm run repair:panel && npm run check:panel',
          endpoint: '/api/cluster/resource-guard',
        },
      ],
    });
  });

  it('adds ops guard as a first-class assurance gate when provided', async () => {
    const report = await buildClusterAssuranceReport({
      diagnostics: passedDiagnostics,
      diagnosticsDrill: { ok: true, caseCount: 4, failedCaseCount: 0, results: [] },
      resilienceDrill: { ok: true, caseCount: 6, failedCaseCount: 0, results: [] },
      runtimeDrill: { ok: true, caseCount: 3, failedCaseCount: 0, results: [] },
      opsGuard: {
        status: 'blocked',
        ok: false,
        blockers: ['repair_actions_gte_4'],
        warnings: [],
      },
      now: new Date('2026-06-01T00:34:00.000Z'),
    });

    expect(report).toMatchObject({
      status: 'blocked',
      ok: false,
      summary: {
        gateCount: 5,
        blockedGateCount: 1,
        failedGateIds: ['ops_guard'],
        failedCases: ['ops_guard:repair_actions_gte_4'],
      },
      recoveryPlan: [
        {
          gateId: 'ops_guard',
          severity: 'blocker',
          blocksStart: true,
          command: 'npm run repair:panel && npm run check:panel',
          endpoint: '/api/cluster/ops-guard',
        },
      ],
    });
  });

  it('adds capability guard as a first-class assurance gate when provided', async () => {
    const report = await buildClusterAssuranceReport({
      diagnostics: passedDiagnostics,
      diagnosticsDrill: { ok: true, caseCount: 4, failedCaseCount: 0, results: [] },
      resilienceDrill: { ok: true, caseCount: 6, failedCaseCount: 0, results: [] },
      runtimeDrill: { ok: true, caseCount: 3, failedCaseCount: 0, results: [] },
      capabilityGuard: {
        status: 'blocked',
        ok: false,
        blockers: ['room_shared_capability_bridge:room-1:skillIds'],
        warnings: [],
      },
      now: new Date('2026-06-01T00:35:00.000Z'),
    });

    expect(report).toMatchObject({
      status: 'blocked',
      ok: false,
      summary: {
        gateCount: 5,
        blockedGateCount: 1,
        failedGateIds: ['capability_guard'],
        failedCases: ['capability_guard:room_shared_capability_bridge:room-1:skillIds'],
      },
      recoveryPlan: [
        {
          gateId: 'capability_guard',
          severity: 'blocker',
          blocksStart: true,
          command: 'npm run repair:panel && npm run check:panel',
          endpoint: '/api/cluster/capability-guard',
        },
      ],
    });
  });

  it('blocks when any assurance layer fails even if live diagnostics looks safe', async () => {
    const report = await buildClusterAssuranceReport({
      diagnostics: passedDiagnostics,
      diagnosticsDrill: { ok: true, caseCount: 4, failedCaseCount: 0, results: [] },
      resilienceDrill: {
        ok: false,
        caseCount: 6,
        failedCaseCount: 1,
        results: [{ id: 'single_adapter_capacity_is_blocked', ok: false }],
      },
      runtimeDrill: { ok: true, caseCount: 3, failedCaseCount: 0, results: [] },
      now: new Date('2026-06-01T00:31:00.000Z'),
    });

    expect(report).toMatchObject({
      status: 'blocked',
      ok: false,
      summary: {
        gateCount: 4,
        blockedGateCount: 1,
        failedGateIds: ['resilience_drill'],
        failedCases: ['resilience_drill:single_adapter_capacity_is_blocked'],
      },
      recoveryPlan: [
        {
          gateId: 'resilience_drill',
          severity: 'blocker',
          blocksStart: true,
          action: '修复多房间容量或掉线接管契约失败项',
          command: 'npm run cluster:stress && npm run check:panel',
          endpoint: '/api/cluster/concurrency-budget',
        },
      ],
    });
    expect(report.recommendations).toEqual([
      '修复多房间容量或掉线接管契约失败项: npm run cluster:stress && npm run check:panel',
    ]);
  });
});
