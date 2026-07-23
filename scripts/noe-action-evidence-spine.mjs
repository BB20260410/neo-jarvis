#!/usr/bin/env node
// @ts-check
// Read-only audit: goal checkpoint -> act ledger -> event log -> actionEvidence.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateNoeActionEvidence } from '../src/runtime/NoeActionEvidence.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.NOE_ACTION_EVIDENCE_SPINE_OUT_DIR
  ? resolve(process.env.NOE_ACTION_EVIDENCE_SPINE_OUT_DIR)
  : join(ROOT, 'output', 'noe-action-evidence-spine');
const DB_PATH = process.env.PANEL_DB_PATH || join(homedir(), '.noe-panel', 'panel.db');
const NOW = Date.now();
const args = process.argv.slice(2);
const requirePass = args.includes('--require-pass');
const goalArgIndex = args.indexOf('--goal-id');
const explicitGoalId = goalArgIndex >= 0 ? String(args[goalArgIndex + 1] || '').trim() : '';

const { default: Database } = await import('better-sqlite3');

function parseJson(text, fallback = null) {
  try { return JSON.parse(String(text || '')); } catch { return fallback; }
}

function workflowOf(cp = {}) {
  return cp.payloadObj?.workflow && typeof cp.payloadObj.workflow === 'object' ? cp.payloadObj.workflow : {};
}

function rollbackOf(cp = {}) {
  const rb = workflowOf(cp).rollbackEvidence;
  return rb && typeof rb === 'object' ? rb : null;
}

function hasText(value = '') {
  return String(value || '').trim().length > 0;
}

function eventIdFromRef(ref = '') {
  const m = String(ref || '').match(/^sqlite:events\/(\d+)$/);
  return m ? Number(m[1]) : null;
}

function cleanPath(file) {
  return file.startsWith(ROOT) ? file.slice(ROOT.length + 1) : file;
}

function row(db, sql, params = []) {
  try { return db.prepare(sql).get(...params); } catch { return null; }
}

function all(db, sql, params = []) {
  try { return db.prepare(sql).all(...params); } catch { return []; }
}

export function writeActionEvidenceSpineReport(summary, { outDir = OUT_DIR, now = NOW } = {}) {
  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, `action-evidence-spine-${now}.json`);
  const latestPath = join(outDir, 'latest.json');
  const body = `${JSON.stringify(summary, null, 2)}\n`;
  writeFileSync(reportPath, body, { mode: 0o600 });
  writeFileSync(latestPath, body, { mode: 0o600 });
  return {
    reportPath: cleanPath(reportPath),
    latestPath: cleanPath(latestPath),
  };
}

export function summarizeActionStepCoverage({ plan = [], checkpoints = [], spine = [] } = {}) {
  const actionSteps = Array.isArray(plan)
    ? plan.map((step, index) => ({ step, index })).filter(({ step }) => step?.kind === 'act')
    : [];
  const validEvidenceByStep = new Set(spine.filter((item) => item.blockers.length === 0).map((item) => item.stepIndex));
  const recoveredByStep = new Set(checkpoints
    .filter((cp) => cp.phase === 'step_recovered' && cp.status === 'recovered')
    .map((cp) => cp.step_index));
  const stepResults = actionSteps.map(({ step, index }) => {
    const status = String(step?.status || '').toLowerCase();
    if (status === 'recovered') {
      const ok = recoveredByStep.has(index);
      return {
        stepIndex: index,
        status,
        mode: 'recovered',
        ok,
        blockers: ok ? [] : [`recovery_checkpoint_missing:${index}`],
      };
    }
    const ok = validEvidenceByStep.has(index);
    return {
      stepIndex: index,
      status,
      mode: 'action_evidence',
      ok,
      blockers: ok ? [] : [`action_evidence_missing_for_step:${index}`],
    };
  });
  return {
    actionStepCount: actionSteps.length,
    actionStepsWithValidEvidence: stepResults.filter((item) => item.mode === 'action_evidence' && item.ok).length,
    actionStepsRecovered: stepResults.filter((item) => item.mode === 'recovered' && item.ok).length,
    actionStepsSatisfied: stepResults.filter((item) => item.ok).length,
    blockers: stepResults.flatMap((item) => item.blockers),
    stepResults,
  };
}

export async function main() {
if (!existsSync(DB_PATH)) {
  console.log(JSON.stringify({ ok: false, passed: false, error: `missing db: ${DB_PATH}` }, null, 2));
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });
try {
  const goal = explicitGoalId
    ? row(db, 'SELECT * FROM noe_goals WHERE id = ?', [explicitGoalId])
    : (
        row(db, "SELECT * FROM noe_goals WHERE source = 'self_learning' AND status = 'done' ORDER BY updated_at DESC LIMIT 1")
        || row(db, "SELECT * FROM noe_goals WHERE source = 'self_learning' ORDER BY updated_at DESC LIMIT 1")
      );
  if (!goal) {
    console.log(JSON.stringify({ ok: false, passed: false, error: 'goal_not_found', goalId: explicitGoalId || null }, null, 2));
    process.exit(1);
  }

  const plan = parseJson(goal.plan, []);
  const checkpoints = all(db, 'SELECT * FROM noe_goal_checkpoints WHERE goal_id = ? ORDER BY ts ASC, created_at ASC', [goal.id])
    .map((cp) => ({ ...cp, payloadObj: parseJson(cp.payload, {}) || {} }));
  const evidenceCheckpoints = checkpoints.filter((cp) => cp.kind === 'act' && cp.phase === 'evidence');
  const spine = [];
  const rawEvidenceBlockers = [];

  for (const cp of evidenceCheckpoints) {
    const actId = cp.payloadObj?.actId || '';
    const eventId = eventIdFromRef(cp.evidence_ref);
    const act = actId
      ? row(db, 'SELECT * FROM noe_acts WHERE id = ?', [actId])
      : (eventId ? row(db, 'SELECT * FROM noe_acts WHERE evidence_event_id = ?', [eventId]) : null);
    const event = eventId ? row(db, 'SELECT id, kind, tag, entity_type, entity_id, ts FROM events WHERE id = ?', [eventId]) : null;
    const actPayload = parseJson(act?.payload, {}) || {};
    const actionEvidence = actPayload.actionEvidence || null;
    const validation = actionEvidence ? validateNoeActionEvidence(actionEvidence, {
      requireRuntime: actionEvidence.dryRunOnly === false,
    }) : { ok: false, errors: ['action_evidence_missing'] };
    const itemBlockers = [];
    if (!eventId) itemBlockers.push('checkpoint_evidence_ref_not_sqlite_event');
    if (!event) itemBlockers.push('event_missing');
    if (!act) itemBlockers.push('act_missing');
    if (!actionEvidence) itemBlockers.push('action_evidence_missing');
    if (!validation.ok) itemBlockers.push(...validation.errors);
    rawEvidenceBlockers.push(...itemBlockers.map((b) => `${b}:${cp.step_index}`));
    spine.push({
      stepIndex: cp.step_index,
      action: cp.action,
      checkpointId: cp.id,
      checkpointStatus: cp.status,
      checkpointEvidenceRef: cp.evidence_ref,
      replaySafe: cp.replay_safe === 1,
      actId: act?.id || actId || null,
      actStatus: act?.status || null,
      actRiskLevel: act?.risk_level || null,
      eventId,
      eventKind: event?.kind || null,
      eventEntityId: event?.entity_id || null,
      actionEvidence: actionEvidence ? {
        schemaVersion: actionEvidence.schemaVersion,
        sha256: actionEvidence.sha256 || null,
        dryRunOnly: actionEvidence.dryRunOnly,
        logRef: actionEvidence.logRef || '',
        validation,
      } : null,
      workflow: workflowOf(cp).schemaVersion ? {
        schemaVersion: workflowOf(cp).schemaVersion,
        idempotencyKey: workflowOf(cp).idempotencyKey || '',
        resumeCursor: workflowOf(cp).resumeCursor || null,
        sideEffectFingerprint: workflowOf(cp).sideEffectFingerprint || '',
        rollbackEvidence: rollbackOf(cp),
      } : null,
      blockers: itemBlockers,
    });
  }

  const stepIndexesWithCheckpoints = new Set(checkpoints.map((cp) => cp.step_index));
  const stepCoverage = summarizeActionStepCoverage({ plan, checkpoints, spine });
  const actionCheckpoints = checkpoints.filter((cp) => cp.kind === 'act');
  const workflowRows = actionCheckpoints.length ? actionCheckpoints : checkpoints;
  const missingWorkflow = workflowRows.filter((cp) => !workflowOf(cp).schemaVersion);
  const missingIdempotency = workflowRows.filter((cp) => !hasText(workflowOf(cp).idempotencyKey));
  const missingResume = workflowRows.filter((cp) => !workflowOf(cp).resumeCursor?.checkpointId);
  const missingFingerprint = evidenceCheckpoints.filter((cp) => !hasText(workflowOf(cp).sideEffectFingerprint));
  const missingRollbackPolicy = evidenceCheckpoints.filter((cp) => !rollbackOf(cp));
  const missingRollbackEvidence = evidenceCheckpoints.filter((cp) => {
    const rb = rollbackOf(cp);
    return rb?.required === true && rb.status !== 'available';
  });
  const durableWorkflowGaps = [];
  if (!workflowRows.length) durableWorkflowGaps.push('no_goal_checkpoints_for_workflow_contract');
  if (missingWorkflow.length) durableWorkflowGaps.push(`workflow_contract_missing:${missingWorkflow.length}`);
  if (missingIdempotency.length) durableWorkflowGaps.push(`idempotency_key_missing:${missingIdempotency.length}`);
  if (missingResume.length) durableWorkflowGaps.push(`resume_cursor_missing:${missingResume.length}`);
  if (missingFingerprint.length) durableWorkflowGaps.push(`side_effect_fingerprint_missing:${missingFingerprint.length}`);
  if (missingRollbackPolicy.length) durableWorkflowGaps.push(`rollback_policy_missing:${missingRollbackPolicy.length}`);
  if (missingRollbackEvidence.length) durableWorkflowGaps.push(`rollback_evidence_missing:${missingRollbackEvidence.length}`);
  const durableWorkflowReady = durableWorkflowGaps.length === 0;
  const spineEvidenceReady = stepCoverage.blockers.length === 0;
  const summary = {
    ok: true,
    passed: spineEvidenceReady && durableWorkflowReady,
    durableWorkflowReady,
    generatedAt: new Date(NOW).toISOString(),
    goal: {
      id: goal.id,
      title: goal.title,
      source: goal.source,
      status: goal.status,
      stepCount: Array.isArray(plan) ? plan.length : 0,
      actionStepCount: stepCoverage.actionStepCount,
    },
    coverage: {
      checkpointCount: checkpoints.length,
      stepIndexesWithCheckpoints: stepIndexesWithCheckpoints.size,
      actionEvidenceCheckpoints: evidenceCheckpoints.length,
      actionStepsWithValidEvidence: stepCoverage.actionStepsWithValidEvidence,
      actionStepsRecovered: stepCoverage.actionStepsRecovered,
      actionStepsSatisfied: stepCoverage.actionStepsSatisfied,
      blockers: [...new Set(stepCoverage.blockers)],
      rawEvidenceBlockers: [...new Set(rawEvidenceBlockers)],
      stepResults: stepCoverage.stepResults,
      durableWorkflowGaps,
      durableWorkflow: {
        actionCheckpoints: actionCheckpoints.length,
        workflowRows: workflowRows.length,
        withWorkflow: workflowRows.length - missingWorkflow.length,
        withIdempotencyKey: workflowRows.length - missingIdempotency.length,
        withResumeCursor: workflowRows.length - missingResume.length,
        evidenceWithSideEffectFingerprint: evidenceCheckpoints.length - missingFingerprint.length,
        evidenceWithRollbackPolicy: evidenceCheckpoints.length - missingRollbackPolicy.length,
        rollbackEvidenceRequiredMissing: missingRollbackEvidence.length,
      },
    },
    spine,
    source: {
      dbPath: DB_PATH,
      policy: 'read-only; no .env; no owner token; no model calls',
    },
  };

  const paths = writeActionEvidenceSpineReport(summary);
  console.log(JSON.stringify({ ...summary, ...paths }, null, 2));
  if (requirePass && !summary.passed) process.exitCode = 1;
} finally {
  db.close();
}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
