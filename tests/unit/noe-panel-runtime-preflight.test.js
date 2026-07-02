import { describe, expect, it } from 'vitest';
import {
  collectNoePanelRuntimePreflight,
  compactPanelRuntimePreflight,
  evaluateNoePanelRestartPreflight,
  parseLsofCwdOutput,
  parseLsofListenOutput,
  parsePsOutput,
} from '../../src/runtime/NoePanelRuntimePreflight.js';

function runnerFor({ root = '/repo/noe', panel = 'owned', observeOnly = false } = {}) {
  return (cmd, args) => {
    if (cmd === 'lsof' && args.includes('-iTCP:51835')) {
      if (panel === 'probe_error') {
        throw Object.assign(new Error('lsof unavailable'), { status: 127, stdout: '', stderr: 'lsof: command not found' });
      }
      if (panel === 'none') throw Object.assign(new Error('no listener'), { status: 1, stdout: '', stderr: '' });
      const pid = panel === 'foreign' ? 222 : 111;
      return `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode ${pid} owner 18u IPv4 0x1 0t0 TCP 127.0.0.1:51835 (LISTEN)\n`;
    }
    if (cmd === 'lsof' && args.includes('-iTCP:51735')) {
      if (!observeOnly) throw Object.assign(new Error('no listener'), { status: 1, stdout: '', stderr: '' });
      return 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 333 owner 18u IPv4 0x2 0t0 TCP 127.0.0.1:51735 (LISTEN)\n';
    }
    if (cmd === 'ps') {
      const pid = args[1];
      return ` ${pid} 1 01:23 /usr/local/bin/node server.js\n`;
    }
    if (cmd === 'lsof' && args.includes('-d') && args.includes('cwd')) {
      const pid = args[2];
      const cwd = pid === '222' ? '/tmp/other-panel' : root;
      return `p${pid}\nfcwd\nn${cwd}\n`;
    }
    throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
  };
}

describe('NoePanelRuntimePreflight parsers', () => {
  it('parses lsof, ps, and cwd outputs without exposing extra process text', () => {
    expect(parseLsofListenOutput('COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 12 owner 1u IPv4 X 0t0 TCP 127.0.0.1:51835 (LISTEN)\n')).toMatchObject([
      { command: 'node', pid: 12, user: 'owner' },
    ]);
    expect(parsePsOutput(' 12 1 00:01 node server.js\n')).toMatchObject({ pid: 12, ppid: 1, etime: '00:01', command: 'node server.js' });
    expect(parseLsofCwdOutput('p12\nfcwd\nn/repo/noe\n')).toBe('/repo/noe');
  });
});

describe('collectNoePanelRuntimePreflight', () => {
  it('marks 51835 safe to restart only when the listener cwd is the real repo', () => {
    const report = collectNoePanelRuntimePreflight({
      root: '/repo/noe',
      commandRunner: runnerFor({ root: '/repo/noe', panel: 'owned' }),
      now: new Date('2026-06-13T00:00:00Z'),
    });
    const compact = compactPanelRuntimePreflight(report);
    const decision = evaluateNoePanelRestartPreflight(report);
    expect(report).toMatchObject({
      ok: true,
      status: 'owned',
      panel: { owned: true, safeToRestart: true, actionsPerformed: false },
      policy: { secretValuesReturned: false, readsOwnerToken: false, restartsProcess: false },
    });
    expect(compact).toMatchObject({ pid: 111, cwd: '/repo/noe', safeToRestart: true, observeOnlyListenerCount: 0 });
    expect(decision).toMatchObject({
      ok: true,
      decision: 'restart_owned_panel',
      safeToRestart: true,
      policy: { actionsPerformed: false, secretValuesReturned: false },
    });
  });

  it('blocks restart when 51835 is owned by a different cwd', () => {
    const report = collectNoePanelRuntimePreflight({
      root: '/repo/noe',
      commandRunner: runnerFor({ root: '/repo/noe', panel: 'foreign' }),
    });
    const decision = evaluateNoePanelRestartPreflight(report);
    expect(report.ok).toBe(false);
    expect(report.blockers).toContain('panel_listener_cwd_mismatch');
    expect(compactPanelRuntimePreflight(report)).toMatchObject({ safeToRestart: false, cwd: '/tmp/other-panel' });
    expect(decision).toMatchObject({
      ok: false,
      decision: 'blocked',
      safeToRestart: false,
      safeToStart: false,
      policy: { actionsPerformed: false, touchesObserveOnlyPort: false },
    });
    expect(decision.blockers).toContain('panel_preflight_not_safe_to_restart_or_start');
  });

  it('allows start evidence when 51835 has no listener', () => {
    const report = collectNoePanelRuntimePreflight({
      root: '/repo/noe',
      commandRunner: runnerFor({ root: '/repo/noe', panel: 'none' }),
    });
    const decision = evaluateNoePanelRestartPreflight(report);
    expect(report.ok).toBe(true);
    expect(report.status).toBe('not_running');
    expect(compactPanelRuntimePreflight(report)).toMatchObject({ safeToStart: true, safeToRestart: false, pid: null });
    expect(decision).toMatchObject({ ok: true, decision: 'start_missing_panel', safeToStart: true });
  });

  it('blocks restart/start when the 51835 listener probe itself fails', () => {
    const report = collectNoePanelRuntimePreflight({
      root: '/repo/noe',
      commandRunner: runnerFor({ root: '/repo/noe', panel: 'probe_error' }),
    });
    const decision = evaluateNoePanelRestartPreflight(report);
    expect(report.ok).toBe(false);
    expect(report.status).toBe('blocked');
    expect(report.blockers).toContain('panel_listener_probe_failed');
    expect(decision).toMatchObject({
      ok: false,
      decision: 'blocked',
      safeToRestart: false,
      safeToStart: false,
    });
  });

  it('observes 51735 without turning it into a restart target', () => {
    const report = collectNoePanelRuntimePreflight({
      root: '/repo/noe',
      commandRunner: runnerFor({ root: '/repo/noe', panel: 'owned', observeOnly: true }),
    });
    expect(report.observeOnly).toMatchObject({ port: 51735, touchPolicy: 'observe_only', listenerCount: 1 });
    expect(report.policy.touchesObserveOnlyPort).toBe(false);
    expect(report.warnings).toContain('observe_only_port_51735_has_listener');
  });
});
