import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

export const NOE_MEMORY_CANDIDATE_ROLLBACK_SCHEMA_VERSION = 1;
export const NOE_MEMORY_CANDIDATE_ROLLBACK_REPORT_DIR = 'output/noe-memory-candidates/rollback-reports';

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
  return `memory-candidate-rollback-${Date.now()}-${randomUUID().slice(0, 8)}.json`;
}

function appliedPlansById(report = {}) {
  const plans = Array.isArray(report.plans) ? report.plans : [];
  return new Map(plans.map((plan) => [plan.applyId, plan]));
}

export function buildNoeMemoryCandidateRollbackPlan(applyReport = {}, {
  applyReportRef = '',
} = {}) {
  const blockers = [];
  if (applyReport?.status !== 'applied') blockers.push('apply_report_not_applied');
  if (applyReport?.rollbackEvidenceRequired !== true) blockers.push('rollback_evidence_not_required');
  const plansById = appliedPlansById(applyReport);
  const applied = Array.isArray(applyReport?.applied) ? applyReport.applied : [];
  if (!applied.length) blockers.push('no_applied_memory_records');
  const rollbackItems = applied.map((item = {}) => {
    const plan = plansById.get(item.applyId);
    const itemBlockers = [];
    if (!item.applyId) itemBlockers.push('apply_id_required');
    if (!item.memoryId) itemBlockers.push('memory_id_required');
    if (item.rollback?.action !== 'hide_memory') itemBlockers.push('unsupported_rollback_action');
    if (!plan) itemBlockers.push('matching_apply_plan_required');
    if (plan && plan.memoryWrite?.sourceType !== 'proposal_memory_candidate') itemBlockers.push('not_proposal_memory_candidate');
    // projectId 必须随 apply plan 自带（apply 默认写生产 'noe'，亦可为显式自定义分区）；
    // 仅校验非空，再用 plan 自带值去 hide，避免硬钉具体值把合法分区误判成孤儿。
    if (plan && !plan.memoryWrite?.projectId) itemBlockers.push('missing_project_id');
    return {
      applyId: clean(item.applyId, 200),
      candidateId: clean(item.candidateId, 200),
      memoryId: clean(item.memoryId, 200),
      projectId: clean(plan?.memoryWrite?.projectId || 'noe', 120) || 'noe',
      reason: clean(item.rollback?.reason || `rollback:${item.applyId || 'unknown'}`, 500),
      action: 'hide_memory',
      blockers: itemBlockers,
    };
  });
  const itemBlockers = rollbackItems.flatMap((item) => item.blockers);
  return {
    ok: blockers.length === 0 && itemBlockers.length === 0,
    blockers: [...blockers, ...itemBlockers],
    plan: {
      schemaVersion: NOE_MEMORY_CANDIDATE_ROLLBACK_SCHEMA_VERSION,
      status: blockers.length || itemBlockers.length ? 'blocked' : 'ready_for_rollback',
      applyReportRef: clean(applyReportRef, 500),
      dryRunOnlyByDefault: true,
      requiresOwnerConfirmation: true,
      rollbackItems,
    },
  };
}

export function runNoeMemoryCandidateRollback({
  root = process.cwd(),
  applyReportRef = '',
  candidateId = '',
  reportDir = NOE_MEMORY_CANDIDATE_ROLLBACK_REPORT_DIR,
  memoryCore = null,
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
  if (candidateId && applyReport) {
    const candidates = Array.isArray(applyReport.applied) ? applyReport.applied : [];
    const exists = candidates.some((item) => item && item.candidateId === candidateId);
    if (!exists) errors.push({ error: 'candidate_not_found', candidateId });
  }
  const built = applyReport
    ? buildNoeMemoryCandidateRollbackPlan(applyReport, { applyReportRef })
    : { ok: false, blockers: [], plan: { rollbackItems: [] } };
  const rollbackErrors = [...errors];
  if (!dryRun && confirmOwner !== true) {
    rollbackErrors.push({ error: 'owner_confirmation_required' });
  } else if (!dryRun && !memoryCore?.hide) {
    rollbackErrors.push({ error: 'memory_core_required' });
  }
  const rolledBack = [];
  if (!dryRun && rollbackErrors.length === 0 && built.ok) {
    for (const item of built.plan.rollbackItems) {
      const before = memoryCore.get?.(item.memoryId, { includeHidden: true }) || null;
      const alreadyHidden = before?.hidden === true;
      const hidden = alreadyHidden ? true : memoryCore.hide(item.memoryId, {
        projectId: item.projectId,
        reason: item.reason,
      });
      const after = memoryCore.get?.(item.memoryId, { includeHidden: true }) || null;
      rolledBack.push({
        applyId: item.applyId,
        candidateId: item.candidateId,
        memoryId: item.memoryId,
        status: after?.hidden === true ? (alreadyHidden ? 'already_hidden' : 'hidden') : 'not_hidden',
        beforeHidden: before?.hidden === true,
        afterHidden: after?.hidden === true,
        hidden: Boolean(hidden),
        reason: item.reason,
      });
    }
  }
  const blocked = !applyReportRef
    ? []
    : (!built.ok
    ? [{ blockers: built.blockers }]
    : rolledBack.filter((item) => item.afterHidden !== true).map((item) => ({
        memoryId: item.memoryId,
        blockers: ['rollback_hide_failed'],
      })));
  const status = !applyReportRef
    ? 'skipped'
    : (rollbackErrors.length || blocked.length ? 'blocked' : (dryRun ? 'dry_run_ready' : 'rolled_back'));
  const report = {
    ok: !applyReportRef || (rollbackErrors.length === 0 && blocked.length === 0),
    schemaVersion: NOE_MEMORY_CANDIDATE_ROLLBACK_SCHEMA_VERSION,
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
    directWrites: dryRun ? [] : [rel(rootAbs, reportPath), ...(rolledBack.length ? ['MemoryCore'] : [])],
    writesProductionMemoryCore: false,
    requiresOwnerConfirmation: true,
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
