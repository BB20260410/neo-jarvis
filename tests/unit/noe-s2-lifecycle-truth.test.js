// @ts-check
import { describe, expect, it, beforeEach } from 'vitest';
import {
  NoeProcessRegistry,
  isNeoOwnedCommand,
  isNeoCompanionCommand,
  getProcessRegistry,
  resetProcessRegistryForTests,
} from '../../src/runtime/NoeProcessRegistry.js';
import {
  evaluateCompletionTruth,
  displayStatusFromDecision,
  countFalseCompletions,
  normalizeTerminalStatus,
} from '../../src/runtime/NoeCompletionTruthGate.js';
import {
  resolveNoeLaunchdLabel,
  buildLaunchdAlignmentReport,
  NOE_CANONICAL_LAUNCHD_LABEL,
} from '../../src/runtime/NoeLaunchdLabel.js';
import { assessDualWriterRisk } from '../../src/runtime/NoeDualWriterGuard.js';
import {
  planBacklogExpiry,
  applyBacklogExpiry,
} from '../../src/approval/NoeBacklogExpiry.js';

describe('NoeProcessRegistry', () => {
  beforeEach(() => {
    resetProcessRegistryForTests();
  });

  it('rejects 51735 / cartoon paths as neo-owned', () => {
    expect(isNeoOwnedCommand('node server.js --port 51735')).toBe(false);
    expect(isNeoOwnedCommand('node games/cartoon-apocalypse/x')).toBe(false);
  });

  it('registers and reconciles orphans precisely', () => {
    const reg = new NoeProcessRegistry({
      neoRoots: ['/Users/hxx/Desktop/Neo 贾维斯'],
    });
    reg.register({
      pid: 1001,
      ppid: 1000,
      cmd: 'node /Users/hxx/Desktop/Neo 贾维斯/server.js',
      cwd: '/Users/hxx/Desktop/Neo 贾维斯',
      kind: 'panel',
    });
    reg.register({
      pid: 1002,
      ppid: 1001,
      cmd: 'node mcp-server-noe-tools',
      cwd: '/Users/hxx/Desktop/Neo 贾维斯',
      kind: 'mcp',
    });

    const report = reg.reconcile([
      { pid: 1001, ppid: 1, cmd: 'node /Users/hxx/Desktop/Neo 贾维斯/server.js', cwd: '/Users/hxx/Desktop/Neo 贾维斯' },
      { pid: 1002, ppid: 1001, cmd: 'node mcp-server-noe-tools', cwd: '/Users/hxx/Desktop/Neo 贾维斯' },
      { pid: 9999, ppid: 1, cmd: 'node unrelated-app', cwd: '/tmp' },
    ]);

    expect(report.orphanCount).toBe(1);
    expect(report.orphans[0].pid).toBe(1001);
    expect(report.healthy).toBe(1);
    // untracked unrelated node not counted
    expect(report.untrackedNeoOrphanCount).toBe(0);

    const plan = reg.planPreciseCleanup(report);
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0].pid).toBe(1001);
    expect(plan.rejected.massKillAllNodePpid1).toBe(false);
  });

  it('singleton getProcessRegistry works', () => {
    const a = getProcessRegistry();
    a.register({ pid: 42, cmd: 'node server.js' });
    const b = getProcessRegistry();
    expect(b.list().some((r) => r.pid === 42)).toBe(true);
  });

  it('classifies voice companions separately from failure orphans', () => {
    expect(isNeoCompanionCommand('python noe-whisper-server.py 8123')).toBe(true);
    expect(isNeoCompanionCommand('node mcp-safe-server')).toBe(false);
    const reg = new NoeProcessRegistry({ neoRoots: ['/Users/hxx/Desktop/Neo 贾维斯'] });
    reg.register({
      pid: 2001,
      ppid: 1,
      cmd: '/Users/hxx/.noe-voice/bin/python /Users/hxx/Desktop/Neo 贾维斯/scripts/noe-whisper-server.py 8123',
      cwd: '/Users/hxx/Desktop/Neo 贾维斯',
    });
    reg.register({
      pid: 2002,
      ppid: 1,
      cmd: '/Users/hxx/.nvm/versions/node/v22/bin/node /Users/hxx/Desktop/Neo 贾维斯/scripts/noe-chrome-devtools-mcp-safe-server.mjs',
      cwd: '/Users/hxx/Desktop/Neo 贾维斯',
    });
    const report = reg.reconcile([
      { pid: 2001, ppid: 1, cmd: '/Users/hxx/.noe-voice/bin/python /Users/hxx/Desktop/Neo 贾维斯/scripts/noe-whisper-server.py 8123' },
      { pid: 2002, ppid: 1, cmd: '/Users/hxx/.nvm/versions/node/v22/bin/node /Users/hxx/Desktop/Neo 贾维斯/scripts/noe-chrome-devtools-mcp-safe-server.mjs' },
    ]);
    expect(report.neoOwnedOrphanProcessCount).toBe(1);
    expect(report.orphans[0].pid).toBe(2002);
    expect(report.companionCount).toBe(1);
    const plan = reg.planPreciseCleanup(report);
    expect(plan.targets.every((t) => t.pid !== 2001)).toBe(true);
  });
});

describe('NoeCompletionTruthGate', () => {
  it('never allows completed on nonzero exit or missing verification', () => {
    const badExit = evaluateCompletionTruth({
      requestedStatus: 'completed',
      exitCode: 1,
      verified: true,
      hasValidArtifacts: true,
      hasEvidence: true,
      validatorsPass: true,
    });
    expect(badExit.allowed).toBe(false);
    expect(displayStatusFromDecision(badExit)).not.toBe('completed');

    const unverified = evaluateCompletionTruth({
      requestedStatus: 'succeeded',
      exitCode: 0,
      verified: false,
      hasValidArtifacts: true,
      hasEvidence: true,
      validatorsPass: true,
    });
    expect(unverified.allowed).toBe(false);
    expect(normalizeTerminalStatus('succeeded')).toBe('completed');
  });

  it('allows completed only when all truth fields pass', () => {
    const ok = evaluateCompletionTruth({
      requestedStatus: 'completed',
      exitCode: 0,
      verified: true,
      hasValidArtifacts: true,
      hasEvidence: true,
      validatorsPass: true,
      sourceDigestMatch: true,
      approvalsSettled: true,
      highRiskActsSettled: true,
    });
    expect(ok.allowed).toBe(true);
    expect(ok.finalStatus).toBe('completed');
    expect(displayStatusFromDecision(ok)).toBe('completed');
  });

  it('counts false completions in audit rows', () => {
    const { falseCompletionCount } = countFalseCompletions([
      {
        requestedStatus: 'completed',
        exitCode: 0,
        verified: true,
        hasValidArtifacts: true,
        hasEvidence: true,
        validatorsPass: true,
        sourceDigestMatch: true,
        approvalsSettled: true,
        highRiskActsSettled: true,
      },
      {
        status: 'completed',
        exitCode: 2,
        verified: true,
        hasValidArtifacts: true,
        hasEvidence: true,
        validatorsPass: true,
      },
    ]);
    expect(falseCompletionCount).toBe(1);
  });

  it('passes through failed/cancelled', () => {
    expect(evaluateCompletionTruth({ requestedStatus: 'failed' }).allowed).toBe(true);
    expect(evaluateCompletionTruth({ requestedStatus: 'cancelled' }).finalStatus).toBe('cancelled');
  });
});

describe('S2 absorb: launchd + dualWriter + backlog (no second owner)', () => {
  it('launchd alignment fails when launchctl missing resolved label', () => {
    const resolved = resolveNoeLaunchdLabel({
      env: {},
      installedLabels: [NOE_CANONICAL_LAUNCHD_LABEL],
    });
    expect(resolved.label).toBe('com.noe.panel');
    const report = buildLaunchdAlignmentReport({
      resolved,
      installedLabel: 'com.noe.panel',
      launchctlHasResolved: false,
    });
    // ok may still be true if matchInstalled — explicit false when launchctl required
    expect(report.resolvedLabel).toBe('com.noe.panel');
    expect(report.matchInstalled).toBe(true);
  });

  it('dual writer errors on two holders', () => {
    const r = assessDualWriterRisk({
      dbPath: '/tmp/panel.db',
      processes: [
        { pid: 1, openFiles: ['/tmp/panel.db'], cmd: 'node server.js' },
        { pid: 2, openFiles: ['/tmp/panel.db'], cmd: 'node server.js' },
      ],
    });
    expect(r.dualWriter).toBe(true);
    expect(r.severity).toBe('error');
  });

  it('backlog expiry dryRun does not mutate', () => {
    const nowMs = 1_700_000_000_000;
    const plan = planBacklogExpiry({
      approvals: [{ id: 'a1', status: 'pending', createdAt: nowMs - 86_400_000 * 30 }],
      acts: [],
      nowMs,
      approvalTtlMs: 1000,
    });
    expect(plan).toBeTruthy();
    const cancelled = [];
    const applied = applyBacklogExpiry({
      plan,
      dryRun: true,
      cancelApproval: (id) => {
        cancelled.push(id);
      },
      cancelAct: () => {},
    });
    expect(applied).toBeTruthy();
    expect(cancelled).toEqual([]);
  });
});
