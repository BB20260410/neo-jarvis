import { describe, expect, it } from 'vitest';
import {
  parseArgs,
  runAuthorizedReadonlyProbe,
  runPolicyGuardDrill,
  summarizePayload,
} from '../../scripts/noe-p0-authorized-readonly-probe.mjs';

describe('noe-p0-authorized-readonly-probe', () => {
  it('defaults to plan-only and does not call protected APIs', async () => {
    const calls = [];
    const report = await runAuthorizedReadonlyProbe({
      argv: [],
      env: { NOE_STANDING_AUTONOMY_GRANT: '0' },
      fetchFn: async (...args) => {
        calls.push(args);
        return { status: 200, json: async () => ({ ok: true }) };
      },
    });

    expect(calls).toHaveLength(0);
    expect(report.mode).toBe('plan_only_with_policy_guard_drill');
    expect(report.summary.executedProtectedReadProbes).toBe(0);
    expect(report.summary.policyGuardDrillOk).toBe(true);
    expect(report.summary.p0FilesWithAuthorizedReadonlySummaryOrPolicyDrill).toBe(1);
    expect(report.tokenPolicy.loaded).toBe(false);
    expect(JSON.stringify(report)).not.toContain('unit-secret-token');
  });

  it('runs authorized GET probes when explicitly enabled with injected token and stores summaries only', async () => {
    const requested = [];
    const payloads = {
      '/api/agent-runs?limit=1': { ok: true, runs: [{ status: 'completed', sensitiveBody: 'do not store' }] },
      '/api/activity?limit=1': { ok: true, count: 3, events: [{ body: 'do not store' }] },
      '/api/agent-registry': { ok: true, counts: { profiles: 4, rules: 5, installedSkills: 6, missingBoundSkills: 1 }, policyOverrides: [{ detail: 'do not store' }] },
      '/api/noe/commands/discover?limit=1': { ok: true, schemaVersion: 1, count: 8, visibleCommands: [{ id: 'a' }], hiddenCommands: [], search: { results: [{ id: 'b' }] } },
      '/api/noe/research/status': { ok: true, mode: 'brave', configured: true, apiKey: 'do not store' },
    };
    const report = await runAuthorizedReadonlyProbe({
      argv: ['--live-authorized', '--ack-read-owner-token'],
      env: { NOE_OWNER_TOKEN: 'unit-secret-token' },
      fetchFn: async (url, options) => {
        requested.push({ url: String(url), options });
        return {
          status: 200,
          json: async () => payloads[new URL(String(url)).pathname + new URL(String(url)).search],
        };
      },
    });

    expect(requested).toHaveLength(5);
    expect(requested.every((item) => item.options.method === 'GET')).toBe(true);
    expect(requested.every((item) => item.options.headers['X-Panel-Owner-Token'] === 'unit-secret-token')).toBe(true);
    expect(report.summary.executedProtectedReadProbes).toBe(5);
    expect(report.summary.authorizedReadonlyOk).toBe(5);
    expect(report.summary.p0FilesWithAuthorizedReadonlySummaryOrPolicyDrill).toBe(7);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('unit-secret-token');
    expect(serialized).not.toContain('do not store');
    expect(serialized).not.toContain('apiKey');
  });

  it('summarizes payloads without carrying bodies or secret-bearing keys', () => {
    expect(summarizePayload('agentRuns', { ok: true, runs: [{ status: 'queued' }, { status: 'queued' }, { status: 'done' }] })).toEqual({
      ok: true,
      runCount: 3,
      statusCounts: { queued: 2, done: 1 },
    });
    expect(summarizePayload('researchStatus', { ok: true, configured: true, apiKey: 'secret', token: 'secret', provider: 'brave' })).toEqual({
      ok: true,
      mode: 'brave',
      configured: true,
      providerKeys: ['configured', 'ok', 'provider'],
    });
  });

  it('classifies policy guard drill without filesystem mutation', () => {
    expect(runPolicyGuardDrill()).toMatchObject({
      ok: true,
      checks: {
        protectedWriteBlocked: true,
        normalWriteAllowed: true,
        protectedShellBlocked: true,
        readShellAllowed: true,
      },
      secretValuesReturned: false,
    });
  });

  it('parses live-authorized mode explicitly', () => {
    expect(parseArgs(['--live-authorized', '--timeout-ms=2500'], {}).liveAuthorized).toBe(true);
    expect(parseArgs(['--timeout-ms=2500'], {}).liveAuthorized).toBe(false);
  });
});
