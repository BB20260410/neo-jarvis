import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compactBootSelfCheck, runNoeBootSelfCheck } from '../../src/runtime/NoeBootSelfCheck.js';

const roots = [];

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'noe-boot-self-check-'));
  roots.push(root);
  for (const file of ['package.json', 'server.js', 'public/mind.html', 'public/mind.js', 'public/src/web/noe-world-earth.js']) {
    const full = join(root, file);
    rmSync(full, { force: true });
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file === 'package.json' ? '{"type":"module"}\n' : `${file}\n`);
  }
  return root;
}

function okFetch() {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, service: 'Noe', port: 51835 }),
  });
}

function ownedPanelPreflight({ root }) {
  return {
    ok: true,
    status: 'owned',
    panel: {
      port: 51835,
      safeToRestart: true,
      safeToStart: false,
      listeners: [{
        pid: 111,
        command: 'node',
        process: { cwd: root, ps: { command: 'node server.js' } },
      }],
    },
    observeOnly: { port: 51735, listenerCount: 0 },
    blockers: [],
    warnings: [],
    policy: { secretValuesReturned: false, actionsPerformed: false },
  };
}

function evalOwnedPanelPreflight() {
  return {
    ok: true,
    decision: 'restart_owned_panel',
    safeToRestart: true,
    safeToStart: false,
    pid: 111,
    cwd: '/repo/noe',
    command: 'node server.js',
    blockers: [],
    warnings: [],
    observeOnlyPort: 51735,
    observeOnlyListenerCount: 0,
    policy: { secretValuesReturned: false, actionsPerformed: false },
  };
}

function okCompanionPreflight() {
  return {
    ok: true,
    status: 'ok',
    tools: {
      openclaw: { activePath: '/bin/openclaw', activeVersion: '2026.6.6', warnings: [] },
      hermes: { activePath: '/bin/hermes', activeVersion: '0.16.0', warnings: [] },
      clawPanel: { status: 'ok', warnings: [] },
    },
    warnings: [],
    blockers: [],
    policy: {
      readOnly: true,
      configFilesRead: false,
      secretValuesReturned: false,
      actionsPerformed: false,
    },
  };
}

function warnedCompanionPreflight() {
  return {
    ok: true,
    status: 'warn',
    tools: {
      openclaw: {
        activePath: '/usr/local/bin/openclaw',
        activeVersion: '2026.6.1',
        newestCandidatePath: '~/.npm-global/bin/openclaw',
        newestCandidateVersion: '2026.6.6',
        warnings: ['active_openclaw_older_than_available_candidate'],
      },
      hermes: { activePath: '/bin/hermes', activeVersion: '0.16.0', warnings: [] },
      clawPanel: { status: 'ok', warnings: [] },
    },
    warnings: ['openclaw:active_openclaw_older_than_available_candidate'],
    blockers: [],
    repairPlan: {
      status: 'attention_required',
      summary: { total: 1, safeAutomatic: 0, manual: 1, blocked: 0, requiresOwnerApproval: 1 },
      safeAutomatic: [],
      manual: [{
        id: 'prefer_newer_openclaw_candidate',
        title: '切换到较新的开爪候选版本',
        tool: 'openclaw',
        repairable: false,
        requiresOwnerApproval: true,
      }],
      blocked: [],
      actions: [{
        id: 'prefer_newer_openclaw_candidate',
        title: '切换到较新的开爪候选版本',
        tool: 'openclaw',
        repairable: false,
        requiresOwnerApproval: true,
      }],
      policy: {
        noPathMutation: true,
        noPackageInstall: true,
        noConfigRead: true,
        noSecretRead: true,
        actionsPerformed: false,
      },
    },
    policy: {
      readOnly: true,
      configFilesRead: false,
      secretValuesReturned: false,
      actionsPerformed: false,
    },
  };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('Noe boot self-check', () => {
  it('detects missing evidence output and repairs it with a persisted report', async () => {
    const rootDir = makeRoot();
    const readOnly = await runNoeBootSelfCheck({
      rootDir,
      repair: false,
      writeReport: false,
      fetchImpl: okFetch,
      now: () => 1800000000000,
      collectPanelRuntimePreflight: ownedPanelPreflight,
      evaluatePanelRestartPreflight: evalOwnedPanelPreflight,
      collectCompanionToolPreflight: okCompanionPreflight,
    });
    expect(readOnly.summary.status).toBe('blocked');
    expect(readOnly.summary.blockers).toContain('evidence_output_dir');
    expect(readOnly.reportPath).toBe('');

    const repaired = await runNoeBootSelfCheck({
      rootDir,
      repair: true,
      writeReport: true,
      fetchImpl: okFetch,
      now: () => 1800000001000,
      collectPanelRuntimePreflight: ownedPanelPreflight,
      evaluatePanelRestartPreflight: evalOwnedPanelPreflight,
      collectCompanionToolPreflight: okCompanionPreflight,
    });
    expect(repaired.ok).toBe(true);
    expect(repaired.summary.repaired).toEqual(expect.arrayContaining(['evidence_output_dir', 'latest_boot_report']));
    expect(repaired.selfRepair).toMatchObject({
      requested: true,
      actionsPerformed: true,
      summary: { attempted: 2, repaired: 2, failed: 0 },
      actions: expect.arrayContaining([
        expect.objectContaining({
          id: 'create_output_noe_boot_self_check',
          status: 'repaired',
          operation: 'mkdir',
          path: 'output/noe-boot-self-check',
        }),
        expect.objectContaining({
          id: 'write_boot_self_check_report',
          status: 'repaired',
          operation: 'write_report',
        }),
      ]),
      policy: {
        safeAutomaticOnly: true,
        noSecretRead: true,
        noProcessRestart: true,
      },
    });
    expect(repaired.reportPath).toMatch(/^output\/noe-boot-self-check\/boot-self-check-/);
    const latest = JSON.parse(readFileSync(join(rootDir, 'output/noe-boot-self-check/latest.json'), 'utf8'));
    expect(latest.reportPath).toBe(repaired.reportPath);
    expect(latest.selfRepair.summary).toMatchObject({ attempted: 2, repaired: 2, failed: 0 });

    const compact = compactBootSelfCheck(repaired);
    expect(compact).toMatchObject({
      ok: true,
      status: 'degraded',
      reportPath: repaired.reportPath,
      latestPath: 'output/noe-boot-self-check/latest.json',
      repair: {
        requested: true,
        actionsPerformed: true,
        summary: { attempted: 2, repaired: 2, failed: 0 },
      },
    });
    expect(compact.checks.find((item) => item.id === 'panel_runtime_preflight')).toMatchObject({
      status: 'ok',
      detail: {
        decision: 'restart_owned_panel',
        safeToRestart: true,
        pid: 111,
        command: 'node server.js',
        secretValuesReturned: false,
        actionsPerformed: false,
      },
    });
    expect(compact.checks.find((item) => item.id === 'policy_file_guard')).toMatchObject({
      status: 'ok',
      detail: {
        writeDenied: true,
        shellDenied: true,
        readOnlyAllowed: true,
        secretValuesReturned: false,
        actionsPerformed: false,
      },
    });
    expect(compact.checks.find((item) => item.id === 'companion_tools_preflight')).toMatchObject({
      status: 'ok',
      detail: {
        tools: {
          openclaw: { activeVersion: '2026.6.6' },
          hermes: { activeVersion: '0.16.0' },
        },
        policy: {
          readOnly: true,
          configFilesRead: false,
          secretValuesReturned: false,
          actionsPerformed: false,
        },
      },
    });
  });

  it('repairs a present but unwritable evidence output directory', async () => {
    const rootDir = makeRoot();
    const outDir = join(rootDir, 'output/noe-boot-self-check');
    mkdirSync(join(rootDir, 'output'), { recursive: true });
    mkdirSync(outDir, { mode: 0o700 });
    chmodSync(outDir, 0o500);

    const report = await runNoeBootSelfCheck({
      rootDir,
      repair: true,
      writeReport: true,
      fetchImpl: okFetch,
      now: () => 1800000001500,
      collectPanelRuntimePreflight: ownedPanelPreflight,
      evaluatePanelRestartPreflight: evalOwnedPanelPreflight,
      collectCompanionToolPreflight: okCompanionPreflight,
    });
    const compact = compactBootSelfCheck(report);
    const evidence = compact.checks.find((item) => item.id === 'evidence_output_dir');

    expect(report.ok).toBe(true);
    expect(report.summary.repaired).toContain('evidence_output_dir');
    expect(report.selfRepair).toMatchObject({
      requested: true,
      actionsPerformed: true,
      summary: { attempted: 2, repaired: 2, failed: 0 },
      actions: expect.arrayContaining([
        expect.objectContaining({
          id: 'repair_output_noe_boot_self_check_permission',
          status: 'repaired',
          operation: 'chmod 700',
        }),
      ]),
    });
    expect(evidence.detail.probe.ok).toBe(true);
    expect(evidence.detail.permissionRepair).toMatchObject({ attempted: true, repaired: true });
    expect(readFileSync(join(outDir, 'latest.json'), 'utf8')).toContain('evidence_output_dir');
  });

  it('redacts secret-shaped health errors from persisted reports', async () => {
    const rootDir = makeRoot();
    const report = await runNoeBootSelfCheck({
      rootDir,
      repair: true,
      writeReport: true,
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        json: async () => ({ ok: false, error: 'authorization=secret-token-value service unavailable' }),
      }),
      now: () => 1800000002000,
      collectPanelRuntimePreflight: ownedPanelPreflight,
      evaluatePanelRestartPreflight: evalOwnedPanelPreflight,
      collectCompanionToolPreflight: okCompanionPreflight,
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('secret-token-value');
    expect(serialized).toContain('authorization=[REDACTED]');
    expect(report.summary.blockers).toContain('live_panel_health');
  });

  it('surfaces companion tool repair plans without treating PATH changes as automatic repairs', async () => {
    const rootDir = makeRoot();
    const outDir = join(rootDir, 'output/noe-boot-self-check');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'boot-self-check-1799999999000.json'), '{}\n');
    writeFileSync(join(outDir, 'latest.json'), JSON.stringify({ reportPath: 'output/noe-boot-self-check/previous.json' }));
    const report = await runNoeBootSelfCheck({
      rootDir,
      repair: false,
      writeReport: false,
      fetchImpl: okFetch,
      now: () => 1800000002500,
      collectPanelRuntimePreflight: ownedPanelPreflight,
      evaluatePanelRestartPreflight: evalOwnedPanelPreflight,
      collectCompanionToolPreflight: warnedCompanionPreflight,
    });
    const compact = compactBootSelfCheck(report);
    const companion = compact.checks.find((item) => item.id === 'companion_tools_preflight');

    expect(compact.status).toBe('degraded');
    expect(compact.warnings).toContain('companion_tools_preflight');
    expect(compact.counts.repairable).toBe(0);
    expect(companion).toMatchObject({
      status: 'warn',
      repairable: false,
      detail: {
        repairPlan: {
          status: 'attention_required',
          summary: {
            safeAutomatic: 0,
            manual: 1,
            blocked: 0,
            requiresOwnerApproval: 1,
          },
        },
        policy: {
          readOnly: true,
          configFilesRead: false,
          secretValuesReturned: false,
          actionsPerformed: false,
        },
      },
    });
    expect(companion.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'prefer_newer_openclaw_candidate', repairable: false }),
    ]));
  });

  it('blocks unsafe panel runtime preflight before any restart action is suggested', async () => {
    const rootDir = makeRoot();
    const report = await runNoeBootSelfCheck({
      rootDir,
      repair: true,
      writeReport: true,
      fetchImpl: okFetch,
      now: () => 1800000003000,
      collectCompanionToolPreflight: okCompanionPreflight,
      collectPanelRuntimePreflight: () => ({
        ok: false,
        status: 'blocked',
        panel: { port: 51835, safeToRestart: false, safeToStart: false, listeners: [] },
        observeOnly: { port: 51735, listenerCount: 1 },
        blockers: ['panel_listener_cwd_mismatch'],
        warnings: ['observe_only_port_51735_has_listener'],
      }),
      evaluatePanelRestartPreflight: () => ({
        ok: false,
        decision: 'blocked',
        safeToRestart: false,
        safeToStart: false,
        pid: 222,
        cwd: '/tmp/other-panel',
        command: 'node server.js',
        blockers: ['panel_listener_cwd_mismatch', 'panel_preflight_not_safe_to_restart_or_start'],
        warnings: ['observe_only_port_51735_has_listener'],
        observeOnlyPort: 51735,
        observeOnlyListenerCount: 1,
        policy: { secretValuesReturned: false, actionsPerformed: false },
      }),
    });
    const panel = compactBootSelfCheck(report).checks.find((item) => item.id === 'panel_runtime_preflight');
    expect(report.summary.blockers).toContain('panel_runtime_preflight');
    expect(panel).toMatchObject({
      status: 'blocked',
      detail: {
        decision: 'blocked',
        cwd: '/tmp/other-panel',
        safeToRestart: false,
        observeOnlyListenerCount: 1,
      },
    });
  });
});
