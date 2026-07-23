// @ts-check

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

export const NOE_SKILL_DRAFT_ROLLBACK_SCHEMA_VERSION = 1;
export const NOE_SKILL_DRAFT_ROLLBACK_REPORT_DIR = 'output/noe-skill-drafts/rollback-reports';

function clean(value, max = 1000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function rel(root, file) {
  const ref = relative(root, file).replaceAll('\\', '/');
  if (ref && !ref.startsWith('..') && ref !== '..' && !ref.startsWith('/')) return ref;
  return file;
}

function isInside(root, file) {
  const ref = relative(root, file);
  return ref && !ref.startsWith('..') && ref !== '..' && !ref.startsWith('/');
}

function readJson(file) {
  if (!existsSync(file)) return { ok: false, error: 'apply_report_missing' };
  try {
    return { ok: true, data: JSON.parse(readFileSync(file, 'utf8')) };
  } catch {
    return { ok: false, error: 'apply_report_json_parse_failed' };
  }
}

function reportFileName() {
  return `skill-draft-rollback-${Date.now()}-${randomUUID().slice(0, 8)}.json`;
}

function plansByApplyId(report = {}) {
  const plans = Array.isArray(report.plans) ? report.plans : [];
  return new Map(plans.map((plan) => [plan.applyId, plan]));
}

export function buildNoeSkillDraftRollbackPlan(applyReport = {}, {
  applyReportRef = '',
} = {}) {
  const blockers = [];
  if (applyReport?.status !== 'applied') blockers.push('apply_report_not_applied');
  if (applyReport?.rollbackEvidenceRequired !== true) blockers.push('rollback_evidence_not_required');
  const byApplyId = plansByApplyId(applyReport);
  const applied = Array.isArray(applyReport?.applied) ? applyReport.applied : [];
  if (!applied.length) blockers.push('no_applied_skill_drafts');
  const rollbackItems = applied.map((item = {}) => {
    const plan = byApplyId.get(item.applyId);
    const itemBlockers = [];
    if (!item.applyId) itemBlockers.push('apply_id_required');
    if (!item.skillName) itemBlockers.push('skill_name_required');
    if (item.previousExists !== false) itemBlockers.push('cannot_delete_preexisting_skill');
    if (item.origin !== 'proposal_skill_draft') itemBlockers.push('not_proposal_skill_draft');
    if (item.rollback?.action !== 'delete_skill') itemBlockers.push('unsupported_rollback_action');
    if (!plan) itemBlockers.push('matching_apply_plan_required');
    if (plan && plan.skillWrite?.extra?.origin !== 'proposal_skill_draft') itemBlockers.push('apply_plan_origin_invalid');
    if (plan && plan.skillWrite?.name !== item.skillName) itemBlockers.push('skill_name_mismatch');
    return {
      applyId: clean(item.applyId, 200),
      proposalId: clean(item.proposalId, 200),
      skillName: clean(item.skillName, 120),
      action: 'delete_skill',
      reason: clean(item.rollback?.reason || `rollback:${item.applyId || 'unknown'}`, 500),
      blockers: itemBlockers,
    };
  });
  const itemBlockers = rollbackItems.flatMap((item) => item.blockers);
  return {
    ok: blockers.length === 0 && itemBlockers.length === 0,
    blockers: [...blockers, ...itemBlockers],
    plan: {
      schemaVersion: NOE_SKILL_DRAFT_ROLLBACK_SCHEMA_VERSION,
      status: blockers.length || itemBlockers.length ? 'blocked' : 'ready_for_rollback',
      applyReportRef: clean(applyReportRef, 500),
      dryRunOnlyByDefault: true,
      requiresOwnerConfirmation: true,
      rollbackItems,
    },
  };
}

export function runNoeSkillDraftRollback({
  root = process.cwd(),
  applyReportRef = '',
  reportDir = NOE_SKILL_DRAFT_ROLLBACK_REPORT_DIR,
  skillStore = null,
  dryRun = true,
  confirmOwner = false,
  now = new Date(),
} = {}) {
  const rootAbs = resolve(root);
  const generatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const reportPath = resolve(rootAbs, reportDir, reportFileName());
  const applyReportPath = applyReportRef ? resolve(rootAbs, applyReportRef) : '';
  const errors = [];
  let applyReport = null;
  if (!applyReportRef) {
    // No input is a no-op CLI smoke path, not a failed rollback.
  } else if (!isInside(rootAbs, applyReportPath)) {
    errors.push({ error: 'apply_report_outside_root' });
  } else {
    const loaded = readJson(applyReportPath);
    if (!loaded.ok) errors.push({ error: loaded.error });
    else applyReport = loaded.data;
  }
  const built = applyReport
    ? buildNoeSkillDraftRollbackPlan(applyReport, { applyReportRef })
    : { ok: false, blockers: [], plan: { rollbackItems: [] } };
  const rollbackErrors = [...errors];
  if (!dryRun && confirmOwner !== true) {
    rollbackErrors.push({ error: 'owner_confirmation_required' });
  } else if (!dryRun && !skillStore?.delete) {
    rollbackErrors.push({ error: 'skill_store_required' });
  }
  const rolledBack = [];
  if (!dryRun && rollbackErrors.length === 0 && built.ok) {
    for (const item of built.plan.rollbackItems) {
      const before = skillStore.get?.(item.skillName) || null;
      const deleted = before ? skillStore.delete(item.skillName) === true : true;
      const after = skillStore.get?.(item.skillName) || null;
      rolledBack.push({
        applyId: item.applyId,
        proposalId: item.proposalId,
        skillName: item.skillName,
        status: !after ? (before ? 'deleted' : 'already_missing') : 'not_deleted',
        beforeExists: Boolean(before),
        afterExists: Boolean(after),
        deleted,
        reason: item.reason,
      });
    }
  }
  const blocked = !applyReportRef
    ? []
    : (!built.ok
      ? [{ blockers: built.blockers }]
      : rolledBack.filter((item) => item.afterExists === true).map((item) => ({
          skillName: item.skillName,
          blockers: ['skill_delete_failed'],
        })));
  const status = !applyReportRef
    ? 'skipped'
    : (rollbackErrors.length || blocked.length ? 'blocked' : (dryRun ? 'dry_run_ready' : 'rolled_back'));
  const report = {
    ok: !applyReportRef || (rollbackErrors.length === 0 && blocked.length === 0),
    schemaVersion: NOE_SKILL_DRAFT_ROLLBACK_SCHEMA_VERSION,
    generatedAt,
    status,
    reason: !applyReportRef ? 'apply_report_required' : '',
    dryRun,
    applyReportRef: clean(applyReportRef, 500),
    reportRef: rel(rootAbs, reportPath),
    counts: {
      rollbackItems: built.plan.rollbackItems.length,
      rolledBack: rolledBack.length,
      blocked: blocked.length,
      errors: rollbackErrors.length,
    },
    errors: rollbackErrors,
    blocked,
    plan: built.plan,
    rolledBack,
    directWrites: dryRun ? [] : [rel(rootAbs, reportPath), ...(rolledBack.length ? ['SkillStore'] : [])],
    writesSkillStore: !dryRun && rolledBack.length > 0,
    requiresOwnerConfirmation: true,
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
