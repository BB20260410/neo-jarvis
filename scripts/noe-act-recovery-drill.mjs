#!/usr/bin/env node
// @ts-check
// Controlled act failure / approval-wait recovery drill for Noe100.
// Uses an isolated SQLite database under output/ and never mutates the live panel DB.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ActPipeline } from '../src/loop/ActPipeline.js';
import { ActStore } from '../src/loop/ActStore.js';
import { ApprovalStore } from '../src/approval/ApprovalStore.js';
import { appendGoalCheckpoint, listGoalCheckpoints } from '../src/cognition/NoeGoalCheckpoints.js';
import { close, getDb, initSqlite, listEvents } from '../src/storage/SqliteStore.js';
import { validateNoeActionEvidence } from '../src/runtime/NoeActionEvidence.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.NOE_ACT_RECOVERY_DRILL_OUT_DIR
  ? resolve(process.env.NOE_ACT_RECOVERY_DRILL_OUT_DIR)
  : join(ROOT, 'output', 'noe-act-recovery-drill');
const NOW = Date.now();
const RUN_ID = new Date(NOW).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const RUN_DIR = join(OUT_DIR, RUN_ID);
const DB_PATH = join(RUN_DIR, 'panel.db');
const REPORT_PATH = join(RUN_DIR, 'report.json');

function rel(file) {
  const abs = resolve(file);
  return abs.startsWith(ROOT) ? relative(ROOT, abs).replace(/\\/g, '/') : abs;
}

function auditSink() {
  return { recordSafe() {} };
}

function makePipeline({ executors, projectId = 'noe-act-recovery-drill' } = {}) {
  const store = new ActStore({ projectId });
  const approvalStore = new ApprovalStore({ audit: auditSink() });
  const pipeline = new ActPipeline({
    projectId,
    store,
    approvalStore,
    executors,
    budget: { preflight: () => ({ ok: true, warnings: [], blocked: [] }) },
    permission: { evaluatePermission: () => ({ decision: 'allow', reason: 'isolated drill permission allow' }) },
    audit: auditSink(),
    broadcast: () => {},
    logger: null,
  });
  return { pipeline, store, approvalStore };
}

function evidenceEventsFor(actId) {
  return listEvents({ kind: 'noe_act_executed', entityId: actId, limit: 20, order: 'ASC' });
}

function validationFor(act) {
  return validateNoeActionEvidence(act?.payload?.actionEvidence || {}, { requireRuntime: true });
}

function checkpointRows(goalId) {
  return listGoalCheckpoints(getDb(), { goalId, limit: 50 });
}

mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });

let failureAttempts = 0;
let approvalExecutorCalls = 0;
let report = null;

try {
  initSqlite(DB_PATH);

  const failureExecutors = new Map([
    ['noe100.drill.failing_action', async () => {
      failureAttempts += 1;
      if (failureAttempts === 1) throw new Error('controlled_act_failure_before_side_effect');
      return {
        ok: true,
        adapter: 'controlled-act-failure-recovery',
        recoveredAfterFailure: true,
        readonly: true,
        sideEffectPerformed: false,
      };
    }],
  ]);
  let { pipeline } = makePipeline({ executors: failureExecutors });

  const failedFirst = await pipeline.propose({
    title: 'Noe100 controlled failed act recovery',
    action: 'noe100.drill.failing_action',
    riskLevel: 'low',
    execute: true,
    payload: { drill: 'act_failure' },
  });
  const failedCheckpointId = appendGoalCheckpoint(getDb(), {
    goalId: 'noe100-act-recovery-drill-failed-act',
    stepIndex: 0,
    phase: 'failed',
    status: failedFirst.act?.status || 'failed',
    kind: 'act',
    action: 'noe100.drill.failing_action',
    step: 'controlled failing act',
    payload: {
      actId: failedFirst.act?.id,
      ok: false,
      error: failedFirst.error,
      dryRunOnly: false,
      replaySafe: true,
    },
    replaySafe: true,
  });

  close();
  initSqlite(DB_PATH);
  ({ pipeline } = makePipeline({ executors: failureExecutors }));
  const failedRecovered = await pipeline.retry(failedFirst.act.id, {
    reason: 'controlled failure recovered after restart',
    execute: true,
  });
  const failedEvidenceValidation = validationFor(failedRecovered.act);
  const recoveredCheckpointId = appendGoalCheckpoint(getDb(), {
    goalId: 'noe100-act-recovery-drill-failed-act',
    stepIndex: 0,
    phase: 'evidence',
    status: failedRecovered.act?.status === 'completed' ? 'done' : failedRecovered.act?.status,
    kind: 'act',
    action: 'noe100.drill.failing_action',
    step: 'controlled failing act',
    evidenceRef: failedRecovered.act?.logRef || '',
    payload: {
      actId: failedRecovered.act?.id,
      ok: failedRecovered.ok === true,
      dryRunOnly: false,
      actionEvidenceSummary: failedRecovered.act?.payload?.actionEvidence || null,
    },
    replaySafe: true,
  });

  const approvalExecutors = new Map([
    ['noe100.drill.approval_wait_action', async () => {
      approvalExecutorCalls += 1;
      return {
        ok: true,
        adapter: 'controlled-approval-wait-recovery',
        approvedAfterWait: true,
        readonly: true,
        sideEffectPerformed: false,
      };
    }],
  ]);
  ({ pipeline } = makePipeline({ executors: approvalExecutors }));
  const approvalPending = await pipeline.propose({
    title: 'Noe100 controlled approval wait recovery',
    action: 'noe100.drill.approval_wait_action',
    riskLevel: 'high',
    execute: true,
    payload: { drill: 'approval_wait' },
  });
  const approvalId = approvalPending.act?.approvalId || '';
  const pendingApprovalCountBeforeRestart = pipeline.approvalStore.listApprovals({ status: 'pending' }).length;
  const approvalWaitCheckpointId = appendGoalCheckpoint(getDb(), {
    goalId: 'noe100-act-recovery-drill-approval-wait',
    stepIndex: 0,
    phase: 'approval',
    status: approvalPending.act?.status || 'awaiting_approval',
    kind: 'act',
    action: 'noe100.drill.approval_wait_action',
    step: 'controlled approval wait act',
    payload: {
      actId: approvalPending.act?.id,
      approvalId,
      ok: true,
      awaitingApproval: true,
      executorCalls: approvalExecutorCalls,
    },
    replaySafe: false,
  });

  close();
  initSqlite(DB_PATH);
  ({ pipeline } = makePipeline({ executors: approvalExecutors }));
  const stillWaiting = await pipeline.retry(approvalPending.act.id, {
    reason: 'resume after restart before approval',
    execute: true,
    approvalId,
  });
  const approvalsAfterRestart = pipeline.approvalStore.listApprovals({ type: 'manual' });
  const approvalCountAfterRestart = approvalsAfterRestart.length;
  const sameApprovalAfterRestart = stillWaiting.act?.approvalId === approvalId
    && approvalCountAfterRestart === pendingApprovalCountBeforeRestart;

  const approved = pipeline.approvalStore.approve(approvalId, {
    decisionBy: 'noe-act-recovery-drill',
    reason: 'controlled approval wait recovery drill',
  });
  const approvalCompleted = await pipeline.retry(approvalPending.act.id, {
    reason: 'approved after controlled wait',
    execute: true,
    approvalId,
  });
  const approvalEvidenceValidation = validationFor(approvalCompleted.act);
  const approvalDoneCheckpointId = appendGoalCheckpoint(getDb(), {
    goalId: 'noe100-act-recovery-drill-approval-wait',
    stepIndex: 0,
    phase: 'evidence',
    status: approvalCompleted.act?.status === 'completed' ? 'done' : approvalCompleted.act?.status,
    kind: 'act',
    action: 'noe100.drill.approval_wait_action',
    step: 'controlled approval wait act',
    evidenceRef: approvalCompleted.act?.logRef || '',
    payload: {
      actId: approvalCompleted.act?.id,
      approvalId,
      ok: approvalCompleted.ok === true,
      dryRunOnly: false,
      actionEvidenceSummary: approvalCompleted.act?.payload?.actionEvidence || null,
    },
    replaySafe: false,
  });

  const failedEvents = evidenceEventsFor(failedFirst.act.id);
  const approvalEvents = evidenceEventsFor(approvalPending.act.id);
  const allExecutedEvents = listEvents({ kind: 'noe_act_executed', limit: 100, order: 'ASC' });
  const failedCheckpoints = checkpointRows('noe100-act-recovery-drill-failed-act');
  const approvalCheckpoints = checkpointRows('noe100-act-recovery-drill-approval-wait');

  report = {
    schemaVersion: 1,
    ok: Boolean(
      failedFirst.ok === false
      && failedFirst.act?.status === 'failed'
      && failedRecovered.ok === true
      && failedRecovered.act?.status === 'completed'
      && failureAttempts === 2
      && failedEvents.length === 1
      && failedEvidenceValidation.ok === true
      && approvalPending.ok === true
      && approvalPending.approvalRequired === true
      && approvalPending.act?.status === 'awaiting_approval'
      && approvalExecutorCalls === 1
      && stillWaiting.approvalRequired === true
      && stillWaiting.act?.approvalId === approvalId
      && sameApprovalAfterRestart === true
      && approved?.status === 'approved'
      && approvalCompleted.ok === true
      && approvalCompleted.act?.status === 'completed'
      && approvalEvents.length === 1
      && approvalEvidenceValidation.ok === true
    ),
    generatedAt: new Date(NOW).toISOString(),
    scenario: 'act_failure_and_approval_wait_recovery',
    liveDbMutated: false,
    isolatedDbPath: rel(DB_PATH),
    failedAct: {
      actId: failedFirst.act?.id || null,
      firstStatus: failedFirst.act?.status || null,
      firstError: failedFirst.error || null,
      recoveredStatus: failedRecovered.act?.status || null,
      retryCount: failedRecovered.act?.payload?.retryCount || 0,
      executorAttempts: failureAttempts,
      evidenceEventId: failedRecovered.act?.evidenceEventId || null,
      logRef: failedRecovered.act?.logRef || '',
      actionEvidenceValid: failedEvidenceValidation.ok,
      actionEvidenceErrors: failedEvidenceValidation.errors,
      executedEventCount: failedEvents.length,
      checkpointIds: [failedCheckpointId, recoveredCheckpointId],
      checkpointWorkflowReady: failedCheckpoints.every((row) => row.payload?.workflow?.schemaVersion === 1),
    },
    approvalWait: {
      actId: approvalPending.act?.id || null,
      approvalId,
      firstStatus: approvalPending.act?.status || null,
      pendingApprovalCountBeforeRestart,
      resumedStatusBeforeApproval: stillWaiting.act?.status || null,
      sameApprovalAfterRestart,
      approvalCountAfterRestart,
      executorCallsBeforeApproval: approvalExecutorCalls - 1,
      approvedStatus: approved?.status || null,
      finalStatus: approvalCompleted.act?.status || null,
      retryCount: approvalCompleted.act?.payload?.retryCount || 0,
      finalExecutorCalls: approvalExecutorCalls,
      evidenceEventId: approvalCompleted.act?.evidenceEventId || null,
      logRef: approvalCompleted.act?.logRef || '',
      actionEvidenceValid: approvalEvidenceValidation.ok,
      actionEvidenceErrors: approvalEvidenceValidation.errors,
      executedEventCount: approvalEvents.length,
      checkpointIds: [approvalWaitCheckpointId, approvalDoneCheckpointId],
      checkpointWorkflowReady: approvalCheckpoints.every((row) => row.payload?.workflow?.schemaVersion === 1),
    },
    events: {
      executedCount: allExecutedEvents.length,
      failedActExecutedEventIds: failedEvents.map((event) => event.id),
      approvalExecutedEventIds: approvalEvents.map((event) => event.id),
    },
    goalCheckpoints: {
      failedAct: failedCheckpoints.map((row) => ({
        id: row.id,
        phase: row.phase,
        status: row.status,
        workflow: row.payload?.workflow || null,
      })),
      approvalWait: approvalCheckpoints.map((row) => ({
        id: row.id,
        phase: row.phase,
        status: row.status,
        workflow: row.payload?.workflow || null,
      })),
    },
    source: {
      policy: 'isolated sqlite recovery drill; no live DB mutation; no external side effect; no LM Studio load/unload',
      reportPath: rel(REPORT_PATH),
    },
  };
} catch (e) {
  report = {
    schemaVersion: 1,
    ok: false,
    generatedAt: new Date(NOW).toISOString(),
    scenario: 'act_failure_and_approval_wait_recovery',
    liveDbMutated: false,
    isolatedDbPath: rel(DB_PATH),
    error: e?.stack || e?.message || String(e),
  };
} finally {
  try { close(); } catch {}
}

writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), { mode: 0o600 });
const persisted = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
console.log(JSON.stringify({ ...persisted, reportPath: rel(REPORT_PATH) }, null, 2));
if (!persisted.ok) process.exitCode = 1;
