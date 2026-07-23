// @ts-check
import { describe, it, expect } from 'vitest';
import {
  NOE_CANONICAL_LAUNCHD_LABEL,
  resolveNoeLaunchdLabel,
  parseLaunchdPlistLabel,
  buildLaunchdAlignmentReport,
  planLaunchdSupervision,
  isLaunchdLabelDisabledInPrint,
} from '../../src/runtime/NoeLaunchdLabel.js';
import {
  NOE_LIVE_PANEL_PORT,
  isLivePanelPort,
  resolveIsolationDbPath,
  applyIsolationDbPolicyToEnv,
  isSameDbPath,
} from '../../src/runtime/NoeIsolationDbPolicy.js';
import {
  assessDualWriterRisk,
  dualWriterToDoctorFinding,
} from '../../src/runtime/NoeDualWriterGuard.js';
import {
  shouldExpirePendingApproval,
  shouldExpirePendingAct,
  planBacklogExpiry,
  applyBacklogExpiry,
  DEFAULT_APPROVAL_PENDING_TTL_MS,
} from '../../src/approval/NoeBacklogExpiry.js';
import path from 'node:path';
import os from 'node:os';

describe('NoeLaunchdLabel', () => {
  it('defaults to com.noe.panel (not legacy hxx label)', () => {
    const r = resolveNoeLaunchdLabel({ env: {}, installedLabels: [] });
    expect(r.label).toBe(NOE_CANONICAL_LAUNCHD_LABEL);
    expect(r.source).toBe('default');
    expect(r.label).not.toBe('com.hxx.noe.panel51835');
  });

  it('prefers env PANEL_LAUNCHD_LABEL', () => {
    const r = resolveNoeLaunchdLabel({
      env: { PANEL_LAUNCHD_LABEL: 'com.custom.panel' },
      installedLabels: [NOE_CANONICAL_LAUNCHD_LABEL],
    });
    expect(r.label).toBe('com.custom.panel');
    expect(r.source).toBe('env');
  });

  it('discovers installed com.noe.panel over legacy defaults', () => {
    const r = resolveNoeLaunchdLabel({
      env: {},
      installedLabels: ['com.noe.panel', 'com.hxx.noe.panel51835'],
    });
    expect(r.label).toBe('com.noe.panel');
    expect(r.source).toBe('installed');
  });

  it('parses plist Label from XML and plutil -p forms', () => {
    const xml = `<?xml version="1.0"?>
    <plist><dict><key>Label</key><string>com.noe.panel</string></dict></plist>`;
    expect(parseLaunchdPlistLabel(xml)).toBe('com.noe.panel');
    expect(parseLaunchdPlistLabel('"Label" => "com.noe.panel"')).toBe('com.noe.panel');
  });

  it('buildLaunchdAlignmentReport flags mismatch', () => {
    const bad = buildLaunchdAlignmentReport({
      resolved: { label: 'com.hxx.noe.panel51835', source: 'default' },
      installedLabel: 'com.noe.panel',
    });
    expect(bad.matchInstalled).toBe(false);
    expect(bad.ok).toBe(false);

    const unsupervised = buildLaunchdAlignmentReport({
      resolved: { label: 'com.noe.panel', source: 'default' },
      installedLabel: 'com.noe.panel',
      launchctlHasResolved: false,
    });
    expect(unsupervised.matchInstalled).toBe(true);
    expect(unsupervised.ok).toBe(false);

    const disabled = buildLaunchdAlignmentReport({
      resolved: { label: 'com.noe.panel', source: 'default' },
      installedLabel: 'com.noe.panel',
      launchctlHasResolved: true,
      disabled: true,
    });
    expect(disabled.ok).toBe(false);

    const good = buildLaunchdAlignmentReport({
      resolved: { label: 'com.noe.panel', source: 'default' },
      installedLabel: 'com.noe.panel',
      launchctlHasResolved: true,
      disabled: false,
    });
    expect(good.ok).toBe(true);
  });

  it('planLaunchdSupervision stops unmanaged panel before bootstrap', () => {
    const plan = planLaunchdSupervision({
      label: 'com.noe.panel',
      uid: 501,
      plistPath: '/Users/hxx/Library/LaunchAgents/com.noe.panel.plist',
      disabled: true,
      loaded: false,
      launchctlHasLabel: false,
      unmanagedLivePanel: true,
    });
    expect(plan.ok).toBe(true);
    expect(plan.steps.map((s) => s.action)).toEqual([
      'enable',
      'stop_unmanaged_panel',
      'bootstrap',
      'kickstart',
    ]);
    expect(plan.steps.find((s) => s.action === 'bootstrap')?.requiresPrior).toBe('stop_unmanaged_panel');
  });

  it('parses disabled print output', () => {
    const text = '"com.noe.cosyvoice-sft" => enabled\n"com.noe.panel" => disabled\n';
    expect(isLaunchdLabelDisabledInPrint(text, 'com.noe.panel')).toBe(true);
    expect(isLaunchdLabelDisabledInPrint(text, 'com.noe.cosyvoice-sft')).toBe(false);
  });
});

describe('NoeIsolationDbPolicy', () => {
  const liveDb = path.join(os.homedir(), '.noe-panel', 'panel.db');
  const isoDir = path.join(os.homedir(), '.noe-panel', 'isolation');

  it('treats 51835 as live', () => {
    expect(isLivePanelPort(NOE_LIVE_PANEL_PORT)).toBe(true);
    expect(isLivePanelPort(51999)).toBe(false);
  });

  it('auto-assigns isolation DB when PORT is non-live and PANEL_DB_PATH unset', () => {
    const r = resolveIsolationDbPath({
      port: 51999,
      env: {},
      liveDbPath: liveDb,
      isolationDir: isoDir,
    });
    expect(r.isolation).toBe(true);
    expect(r.source).toBe('auto');
    expect(r.rewritten).toBe(true);
    expect(r.path).toContain('panel-isolation-51999.db');
    expect(isSameDbPath(r.path, liveDb)).toBe(false);
  });

  it('rewrites isolation port that points at live panel.db', () => {
    const r = resolveIsolationDbPath({
      port: 51998,
      env: { PANEL_DB_PATH: liveDb },
      liveDbPath: liveDb,
      isolationDir: isoDir,
      failClosed: true,
    });
    expect(r.isolation).toBe(true);
    expect(r.rewritten).toBe(true);
    expect(isSameDbPath(r.path, liveDb)).toBe(false);
  });

  it('applyIsolationDbPolicyToEnv mutates env for isolation port', () => {
    const env = { PORT: '51997' };
    const r = applyIsolationDbPolicyToEnv({
      port: 51997,
      env,
      liveDbPath: liveDb,
      isolationDir: isoDir,
    });
    expect(env.PANEL_DB_PATH).toBe(r.path);
    expect(String(env.PANEL_DB_PATH)).not.toBe(liveDb);
  });

  it('does not rewrite live port env', () => {
    const env = { PORT: '51835' };
    const r = applyIsolationDbPolicyToEnv({
      port: 51835,
      env,
      liveDbPath: liveDb,
    });
    expect(r.isolation).toBe(false);
    expect(env.PANEL_DB_PATH).toBeUndefined();
  });
});

describe('NoeDualWriterGuard', () => {
  it('errors when two PIDs hold same DB', () => {
    const db = '/tmp/fake-panel.db';
    const a = assessDualWriterRisk({
      dbPath: db,
      processes: [
        { pid: 11, cmd: 'node', openFiles: [db] },
        { pid: 22, cmd: 'node', openFiles: [db] },
      ],
    });
    expect(a.dualWriter).toBe(true);
    expect(a.severity).toBe('error');
    expect(a.pids).toEqual(['11', '22']);
    const f = dualWriterToDoctorFinding(a);
    expect(f.checkId).toBe('db.dual_writer');
    expect(f.severity).toBe('error');
  });

  it('ok when single holder', () => {
    const db = '/tmp/fake-panel.db';
    const a = assessDualWriterRisk({
      dbPath: db,
      processes: [{ pid: 11, cmd: 'node', openFiles: [db] }],
    });
    expect(a.dualWriter).toBe(false);
    expect(a.severity).toBe('ok');
  });
});

describe('NoeBacklogExpiry', () => {
  const now = 1_700_000_000_000;

  it('expires approval past expiresAt', () => {
    const d = shouldExpirePendingApproval(
      { status: 'pending', createdAt: now - 1000, expiresAt: now - 1 },
      { nowMs: now },
    );
    expect(d.expire).toBe(true);
    expect(d.reason).toBe('past_expires_at');
  });

  it('expires approval past TTL', () => {
    const d = shouldExpirePendingApproval(
      { status: 'pending', createdAt: now - DEFAULT_APPROVAL_PENDING_TTL_MS - 1 },
      { nowMs: now, ttlMs: DEFAULT_APPROVAL_PENDING_TTL_MS },
    );
    expect(d.expire).toBe(true);
    expect(d.reason).toBe('past_ttl');
  });

  it('does not expire fresh approval', () => {
    const d = shouldExpirePendingApproval(
      { status: 'pending', createdAt: now - 60_000 },
      { nowMs: now, ttlMs: DEFAULT_APPROVAL_PENDING_TTL_MS },
    );
    expect(d.expire).toBe(false);
  });

  it('expires pending acts past TTL', () => {
    const d = shouldExpirePendingAct(
      { status: 'awaiting_approval', createdAt: now - 4 * 24 * 3600_000, updatedAt: now - 4 * 24 * 3600_000 },
      { nowMs: now, ttlMs: 3 * 24 * 3600_000 },
    );
    expect(d.expire).toBe(true);
  });

  it('plan + apply dryRun / real cancel', () => {
    const plan = planBacklogExpiry({
      nowMs: now,
      approvalTtlMs: 1000,
      actTtlMs: 1000,
      approvals: [
        { id: 'a1', status: 'pending', createdAt: now - 5000 },
        { id: 'a2', status: 'pending', createdAt: now - 10 },
      ],
      acts: [
        { id: 'act1', status: 'queued', createdAt: now - 5000, updatedAt: now - 5000 },
      ],
    });
    expect(plan.approvals.map((x) => x.id)).toEqual(['a1']);
    expect(plan.acts.map((x) => x.id)).toEqual(['act1']);

    const dry = applyBacklogExpiry(plan, { dryRun: true });
    expect(dry.approvals[0].action).toBe('would_cancel');

    const cancelled = [];
    const applied = applyBacklogExpiry(plan, {
      dryRun: false,
      approvalStore: {
        cancel(id, opts) {
          cancelled.push({ id, ...opts });
          return { id, status: 'cancelled' };
        },
      },
      actStore: {
        cancel(id, opts) {
          cancelled.push({ id, ...opts });
          return { id, status: 'cancelled' };
        },
      },
    });
    expect(applied.approvals[0].action).toBe('cancelled');
    expect(applied.acts[0].action).toBe('cancelled');
    expect(cancelled).toHaveLength(2);
  });
});
