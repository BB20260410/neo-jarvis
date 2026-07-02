import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildLongTaskFollowupReport,
  runLongTaskFollowup,
} from '../../scripts/noe-long-task-followup.mjs';

const T0 = Date.parse('2026-06-13T03:00:00.000Z');

function observation({
  nextCheckAt = '2026-06-13T04:29:28.708Z',
  generatedAt = '2026-06-13T03:01:20.424Z',
  ready = false,
  naturalResolved = 10,
} = {}) {
  return {
    ok: true,
    generatedAt,
    decision: {
      status: ready ? 'ready_for_next_stage_review' : 'wait_for_expectation_due',
      nextAction: ready ? 'start_next_stage_review' : 'wait_until_next_expectation_due_then_rerun_observation_status',
      nextCheckAt,
      readyForNextStageReview: ready,
      blockers: ready ? [] : ['expectation_calibration_pending', 'token=secret-value'],
    },
    expectationCalibration: { naturalLiveResolved: naturalResolved, required: 20, remaining: Math.max(0, 20 - naturalResolved), dueNowOpen: 0, dueWithin24h: 5 },
    soakSnapshot: { soak: { activeDays: 4, requiredDays: 7, daysRemaining: 3 } },
    hermesBackgroundAudit: { status: 'blocked', observedHours: 8.45, remainingHours: 15.55 },
  };
}

function continuous() {
  return {
    ok: true,
    generatedAt: '2026-06-13T03:05:08.606Z',
    blockers: [],
    observationStatus: { status: 'wait_for_expectation_due' },
  };
}

function writeJson(file, data) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

function seedRoot() {
  const root = mkdtempSync(join(tmpdir(), 'noe-long-task-followup-'));
  writeJson(join(root, 'output/noe-observation-status/latest.json'), observation());
  writeJson(join(root, 'output/noe-continuous-autonomy/latest.json'), continuous());
  return root;
}

describe('noe-long-task-followup', () => {
  it('waits when the next observation check is not due', () => {
    const report = buildLongTaskFollowupReport({
      now: T0,
      observationReport: observation(),
      continuousReport: continuous(),
    });

    expect(report).toMatchObject({
      ok: true,
      status: 'waiting',
      action: 'wait_until_next_expectation_due_then_rerun_observation_status',
      nextCheckAt: '2026-06-13T04:29:28.708Z',
      nextCheckAtLocal: '2026-06-13T12:29:28+08:00',
      nextCheckDue: false,
      minutesUntilNextCheck: 90,
      blockerCount: 2,
    });
    expect(report.generatedAtLocal).toBe('2026-06-13T11:00:00+08:00');
    expect(report.refs.workMap).toBe('output/noe-work-map/latest.json');
    expect(report.refs.runLog).toBe('output/noe-long-task-followup/runs.jsonl');
    expect(report.completionGate).toMatchObject({
      canMarkComplete: false,
      readyForNextStageReview: false,
      criteria: {
        naturalExpectationResolved: 20,
        soakActiveDays: 7,
        hermesObservedHours: 24,
      },
      current: {
        naturalExpectationResolved: 10,
        soakActiveDays: 4,
        hermesObservedHours: 8.45,
      },
      remaining: {
        naturalExpectation: 10,
        soakDays: 3,
        hermesHours: 15.55,
      },
    });
    expect(report.resumeProtocol).toMatchObject({
      safeToResumeFromNextWindow: true,
      canRunNow: false,
      requiresManualInspection: false,
      waitUntilLocal: '2026-06-13T12:29:28+08:00',
      nextCommand: 'npm run verify:noe:long-task-followup',
      operatorGuidance: 'wait_until_next_check_time_then_run_next_command',
      nextWindowInstruction: 'Wait until 2026-06-13T12:29:28+08:00, then run `npm run verify:noe:long-task-followup`.',
      completionAllowed: false,
    });
    expect(report.schedulerExpectation).toMatchObject({
      available: false,
      intervalSeconds: null,
      expectedNextRunAtLocal: '',
      staleIfNoRunAfterLocal: '',
    });
    expect(report.resumeProtocol.mustNotMarkCompleteUntil).toContain('completionGate.canMarkComplete=true');
    expect(report.observation.nextCheckDue).toBe(false);
    expect(report.gateProgress.naturalExpectation).toMatchObject({ resolved: 10, required: 20, remaining: 10 });
    expect(report.observation.blockers.join(' ')).toContain('token=[REDACTED]');
    expect(report.observation.blockers.join(' ')).not.toContain('secret-value');
    expect(report.blockers.join(' ')).not.toContain('secret-value');
  });

  it('marks refresh_due when the observation report is stale for its next check', () => {
    const report = buildLongTaskFollowupReport({
      now: Date.parse('2026-06-13T04:40:00.000Z'),
      observationReport: observation(),
      continuousReport: continuous(),
    });

    expect(report.status).toBe('refresh_due');
    expect(report.action).toBe('run npm run verify:noe:observation-status');
    expect(report.operatorGuidance).toBe('run_next_command_now');
    expect(report.nextCommand).toBe('npm run verify:noe:long-task-followup');
    expect(report.resumeProtocol).toMatchObject({
      canRunNow: true,
      nextCommand: 'npm run verify:noe:long-task-followup',
      operatorGuidance: 'run_next_command_now',
      nextWindowInstruction: 'Run `npm run verify:noe:long-task-followup` now.',
      completionAllowed: false,
    });
  });

  it('does not repeatedly refresh once the current observation snapshot is already at the due window', () => {
    const dueAt = '2026-06-13T04:30:24.046Z';
    const report = buildLongTaskFollowupReport({
      now: Date.parse('2026-06-13T04:33:37.000Z'),
      observationReport: observation({
        generatedAt: dueAt,
        nextCheckAt: dueAt,
      }),
      continuousReport: continuous(),
    });

    expect(report.status).toBe('waiting_for_natural_judgement');
    expect(report.nextCheckDue).toBe(true);
    expect(report.staleForNextCheck).toBe(false);
    expect(report.currentDueWindow).toBe(true);
    expect(report.resumeProtocol).toMatchObject({
      canRunNow: false,
      waitingForNaturalJudgement: true,
      nextCommand: 'npm run verify:noe:long-task-followup',
      operatorGuidance: 'wait_for_natural_judgement; rerun_next_command_after_external_evidence_changes',
      nextWindowInstruction: 'Wait for natural judgement or external evidence changes, then rerun the next command.',
      completionAllowed: false,
    });
  });

  it('tells the next window to wait for launchd when the current due window is already covered', () => {
    const dueAt = '2026-06-13T04:30:24.046Z';
    const report = buildLongTaskFollowupReport({
      now: Date.parse('2026-06-13T04:33:37.000Z'),
      observationReport: observation({
        generatedAt: dueAt,
        nextCheckAt: dueAt,
      }),
      continuousReport: continuous(),
      schedulerStatus: {
        label: 'com.noe.long-task-followup',
        available: true,
        runIntervalSeconds: 900,
        logs: {
          stdout: { exists: true, bytes: 1200, mtimeAt: '2026-06-13T04:31:00.000Z' },
          stderr: { exists: true, bytes: 0, mtimeAt: '2026-06-13T03:00:00.000Z' },
        },
      },
    });

    expect(report.status).toBe('waiting_for_natural_judgement');
    expect(report.operatorGuidance).toBe('wait_for_launchd_or_natural_judgement; do_not_force_refresh_until_scheduler_stale');
    expect(report.nextWindowInstruction).toBe('Wait for launchd or natural judgement. Do not force refresh before schedulerStaleIfNoRunAfterLocal=2026-06-13T13:01:00+08:00.');
    expect(report.resumeProtocol).toMatchObject({
      canRunNow: false,
      waitingForNaturalJudgement: true,
      nextSchedulerExpectedAtLocal: '2026-06-13T12:46:00+08:00',
      schedulerStaleIfNoRunAfterLocal: '2026-06-13T13:01:00+08:00',
      nextWindowInstruction: report.nextWindowInstruction,
    });
  });

  it('writes a durable waiting report for a current due observation window without refreshing', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-long-task-followup-current-due-'));
    const dueAt = '2026-06-13T04:30:24.046Z';
    const calls = [];
    try {
      writeJson(join(root, 'output/noe-observation-status/latest.json'), observation({
        generatedAt: dueAt,
        nextCheckAt: dueAt,
      }));
      writeJson(join(root, 'output/noe-continuous-autonomy/latest.json'), continuous());
      const runner = (cmd, args) => {
        calls.push([cmd, ...args].join(' '));
        return { status: 0, signal: null, stdout: 'unexpected refresh', stderr: '' };
      };

      const { report, paths } = runLongTaskFollowup({
        root,
        outDir: join(root, 'output/noe-long-task-followup'),
        now: Date.parse('2026-06-13T04:33:37.000Z'),
        nowAfterRun: () => Date.parse('2026-06-13T04:33:38.000Z'),
        runner,
        includeSchedulerStatus: false,
      });

      expect(calls).toEqual([]);
      expect(report.status).toBe('waiting_for_natural_judgement');
      expect(report.commandResults).toEqual([]);
      expect(report.gateProgress.naturalExpectation).toMatchObject({
        resolved: 10,
        required: 20,
        remaining: 10,
      });
      expect(report.resumeProtocol.waitingForNaturalJudgement).toBe(true);
      const runLogLine = readFileSync(join(root, paths.runLogPath), 'utf8').trim();
      const runLog = JSON.parse(runLogLine);
      expect(runLog).toMatchObject({
        status: 'waiting_for_natural_judgement',
        operatorGuidance: 'wait_for_natural_judgement; rerun_next_command_after_external_evidence_changes',
        nextWindowInstruction: 'Wait for natural judgement or external evidence changes, then rerun the next command.',
        canRunNow: false,
        resumeOperatorGuidance: 'wait_for_natural_judgement; rerun_next_command_after_external_evidence_changes',
        resumeNextWindowInstruction: 'Wait for natural judgement or external evidence changes, then rerun the next command.',
        waitingForNaturalJudgement: true,
        completionAllowed: false,
      });
      const handoff = readFileSync(join(root, paths.latestHandoffPath), 'utf8');
      expect(handoff).toContain('Status: waiting_for_natural_judgement');
      expect(handoff).toContain('Operator guidance: wait_for_natural_judgement; rerun_next_command_after_external_evidence_changes');
      expect(handoff).toContain('Wait for natural judgement or external evidence changes, then rerun the next command.');
      expect(handoff).toContain('waitingForNaturalJudgement: true');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs safe refresh commands once due and writes a durable latest report', () => {
    const root = seedRoot();
    const calls = [];
    try {
      const runner = (cmd, args) => {
        calls.push([cmd, ...args].join(' '));
        if (args.includes('verify:noe:observation-status')) {
          writeJson(join(root, 'output/noe-observation-status/latest.json'), observation({
            generatedAt: '2026-06-13T04:40:05.000Z',
            nextCheckAt: '2026-06-13T05:40:00.000Z',
          }));
        }
        if (args.includes('verify:noe:continuous-autonomy')) {
          writeJson(join(root, 'output/noe-continuous-autonomy/latest.json'), {
            ...continuous(),
            generatedAt: '2026-06-13T04:40:10.000Z',
            observationStatus: { nextCheckAt: '2026-06-13T05:40:00.000Z' },
          });
        }
        return { status: 0, signal: null, stdout: 'ok', stderr: '' };
      };

      const { report, paths } = runLongTaskFollowup({
        root,
        outDir: join(root, 'output/noe-long-task-followup'),
        now: Date.parse('2026-06-13T04:40:00.000Z'),
        nowAfterRun: () => Date.parse('2026-06-13T04:40:11.000Z'),
        runner,
        includeSchedulerStatus: false,
      });

      expect(calls).toEqual([
        'npm run verify:noe:observation-status',
        'npm run verify:noe:continuous-autonomy',
      ]);
      expect(report.ok).toBe(true);
      expect(report.nextCheckAt).toBe('2026-06-13T05:40:00.000Z');
      expect(report.nextCheckAtLocal).toBe('2026-06-13T13:40:00+08:00');
      expect(report.nextCheckDue).toBe(false);
      expect(report.commandResults).toHaveLength(2);
      expect(paths.latestPath).toBe('output/noe-long-task-followup/latest.json');
      expect(paths.latestHandoffPath).toBe('output/noe-long-task-followup/latest.md');
      expect(paths.runLogPath).toBe('output/noe-long-task-followup/runs.jsonl');
      const latest = JSON.parse(readFileSync(join(root, paths.latestPath), 'utf8'));
      expect(latest.nextCheckAt).toBe('2026-06-13T05:40:00.000Z');
      expect(latest.commandResults).toHaveLength(2);
      const runLogLine = readFileSync(join(root, paths.runLogPath), 'utf8').trim();
      const runLog = JSON.parse(runLogLine);
      expect(runLog).toMatchObject({
        status: 'waiting',
        ok: true,
        nextCheckAt: '2026-06-13T05:40:00.000Z',
        nextCheckAtLocal: '2026-06-13T13:40:00+08:00',
        canRunNow: false,
        completionAllowed: false,
        canMarkComplete: false,
        reportPath: paths.reportPath,
        handoffPath: paths.handoffPath,
      });
      expect(runLog.blockerCount).toBe(2);
      expect(JSON.stringify(runLog)).not.toContain('secret-value');
      const handoff = readFileSync(join(root, paths.latestHandoffPath), 'utf8');
      expect(handoff).toContain('# Noe Long Task Follow-up');
      expect(handoff).toContain('Generated local:');
      expect(handoff).toContain('Next command: `npm run verify:noe:long-task-followup`');
      expect(handoff).toContain('Next check local: 2026-06-13T13:40:00+08:00');
      expect(handoff).toContain('expectation: 10/20');
      expect(handoff).toContain('canMarkComplete: false');
      expect(handoff).toContain('## Resume Protocol');
      expect(handoff).toContain('canRunNow: false');
      expect(handoff).toContain('operatorGuidance: wait_until_next_check_time_then_run_next_command');
      expect(handoff).toContain('nextWindowInstruction: Wait until 2026-06-13T13:40:00+08:00, then run `npm run verify:noe:long-task-followup`.');
      expect(handoff).not.toContain('secret-value');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records compact launchd scheduler status without storing raw environment', () => {
    const root = seedRoot();
    try {
      const stdoutLog = join(root, 'launchd.stdout.log');
      const stderrLog = join(root, 'launchd.err.log');
      writeFileSync(stdoutLog, 'scheduled output\n');
      writeFileSync(stderrLog, '');
      const launchdEvidenceAt = new Date('2026-06-13T02:50:00.000Z');
      utimesSync(stdoutLog, launchdEvidenceAt, launchdEvidenceAt);
      const runner = (cmd, args) => {
        if (cmd === 'launchctl' && args[0] === 'print') {
          return {
            status: 0,
            signal: null,
            stderr: '',
            stdout: `
gui/501/com.noe.long-task-followup = {
  path = ~/Library/LaunchAgents/com.noe.long-task-followup.plist
  state = not running
  stdout path = ${stdoutLog}
  stderr path = ${stderrLog}
  inherited environment = {
    API_KEY => should-not-leak
  }
  runs = 7
  last exit code = 0
  run interval = 900 seconds
  job state = exited
}
`,
          };
        }
        return { status: 0, signal: null, stdout: 'ok', stderr: '' };
      };

      const { report } = runLongTaskFollowup({
        root,
        outDir: join(root, 'output/noe-long-task-followup'),
        now: T0,
        noRun: true,
        runner,
      });

      expect(report.scheduler).toMatchObject({
        label: 'com.noe.long-task-followup',
        available: true,
        state: 'not running',
        jobState: 'exited',
        runs: 7,
        lastExitCode: 0,
        runIntervalSeconds: 900,
      });
      expect(report.scheduler.logs).toMatchObject({
        stdout: { path: stdoutLog, exists: true, mtimeAt: '2026-06-13T02:50:00.000Z' },
        stderr: { path: stderrLog, exists: true },
      });
      expect(report.schedulerExpectation).toMatchObject({
        available: true,
        intervalSeconds: 900,
        basis: 'launchd_log_mtime',
        lastEvidenceAt: '2026-06-13T02:50:00.000Z',
        lastEvidenceAtLocal: '2026-06-13T10:50:00+08:00',
        expectedNextRunAt: '2026-06-13T03:05:00.000Z',
        expectedNextRunAtLocal: '2026-06-13T11:05:00+08:00',
        staleIfNoRunAfter: '2026-06-13T03:20:00.000Z',
        staleIfNoRunAfterLocal: '2026-06-13T11:20:00+08:00',
      });
      expect(report.resumeProtocol).toMatchObject({
        nextSchedulerExpectedAtLocal: '2026-06-13T11:05:00+08:00',
        schedulerStaleIfNoRunAfterLocal: '2026-06-13T11:20:00+08:00',
        operatorGuidance: 'wait_until_next_check_time_then_run_next_command',
      });
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain('should-not-leak');
      expect(serialized).not.toContain('inherited environment');
      expect(serialized).not.toContain('launchd log body');
      const latestHandoff = readFileSync(join(root, 'output/noe-long-task-followup/latest.md'), 'utf8');
      expect(latestHandoff).toContain('state: not running');
      expect(latestHandoff).toContain('runIntervalSeconds: 900');
      expect(latestHandoff).toContain('expectationBasis: launchd_log_mtime');
      expect(latestHandoff).toContain('lastSchedulerEvidenceLocal: 2026-06-13T10:50:00+08:00');
      expect(latestHandoff).toContain('expectedNextRunLocal: 2026-06-13T11:05:00+08:00');
      expect(latestHandoff).toContain('schedulerStaleIfNoRunAfterLocal: 2026-06-13T11:20:00+08:00');
      expect(latestHandoff).toContain('point-in-time snapshot');
      expect(latestHandoff).toContain('Use runs, lastExitCode, and staleIfNoRunAfterLocal');
      expect(latestHandoff).not.toContain('should-not-leak');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the launchd template as an optional one-shot scheduler', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const plist = readFileSync('docs/launchd/com.noe.long-task-followup.plist', 'utf8');

    expect(pkg.scripts['noe:long-task-followup']).toContain('scripts/noe-long-task-followup.mjs');
    expect(pkg.scripts['noe:long-task-followup']).toContain('scripts/noe-observation-status.mjs');
    expect(pkg.scripts['noe:long-task-followup']).toContain('scripts/noe-work-map-snapshot.mjs');
    expect(pkg.scripts['verify:noe:long-task-followup']).toContain('tests/unit/noe-long-task-followup.test.js');
    expect(pkg.scripts['verify:noe:long-task-followup']).toContain('npm run noe:long-task-followup');
    expect(plist).toContain('com.noe.long-task-followup');
    expect(plist).toContain('npm run noe:long-task-followup');
    expect(plist).toContain('<key>StartInterval</key>');
    expect(plist).toContain('<integer>900</integer>');
    expect(plist).not.toContain('verify:noe:long-task-followup');
    expect(plist).not.toContain('<key>KeepAlive</key>');
  });
});
