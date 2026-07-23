import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';
import { NOE_MEMORY_CANDIDATE_PENDING } from './NoeMemoryCandidateReview.js';

export const NOE_MEMORY_CANDIDATE_APPLY_SCHEMA_VERSION = 1;
export const NOE_MEMORY_CANDIDATE_APPLY_REPORT_DIR = 'output/noe-memory-candidates/apply-reports';

function clean(value, max = 1000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function rel(root, file) {
  const ref = relative(root, file).replaceAll('\\', '/');
  if (ref && !ref.startsWith('..') && ref !== '..' && !ref.startsWith('/')) return ref;
  return file;
}

function hash(value) {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function reportFileName() {
  return `memory-candidate-apply-${Date.now()}-${randomUUID().slice(0, 8)}.json`;
}

function readJsonl(file) {
  if (!existsSync(file)) return { records: [], errors: [] };
  const records = [];
  const errors = [];
  readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      records.push(JSON.parse(line));
    } catch {
      errors.push({ line: index + 1, error: 'json_parse_failed' });
    }
  });
  return { records, errors };
}

export function buildNoeMemoryCandidateApplyPlan(candidate = {}, {
  pendingRef = NOE_MEMORY_CANDIDATE_PENDING,
} = {}) {
  const blockers = [];
  if (!candidate?.candidateId) blockers.push('candidate_id_required');
  if (candidate?.status !== 'pending_owner_review') blockers.push('candidate_not_pending_owner_review');
  if (!candidate?.body) blockers.push('memory_body_required');
  if (candidate?.writesMemoryCore === true) blockers.push('candidate_already_claims_memory_write');
  if (candidate?.requiresOwnerApproval !== true) blockers.push('owner_approval_flag_required');
  const applyId = `memory-apply-${hash({
    candidateId: candidate.candidateId,
    body: candidate.body,
    evidenceRefs: candidate.evidenceRefs,
  })}`;
  return {
    ok: blockers.length === 0,
    blockers,
    plan: {
      schemaVersion: NOE_MEMORY_CANDIDATE_APPLY_SCHEMA_VERSION,
      applyId,
      candidateId: clean(candidate.candidateId, 200),
      status: blockers.length ? 'blocked' : 'ready_for_apply',
      pendingRef: clean(pendingRef, 500),
      memoryWrite: {
        body: clean(candidate.body, 2000),
        scope: clean(candidate.scope || 'project', 120) || 'project',
        projectId: clean(candidate.projectId ?? 'noe', 120) || 'noe',
        sourceType: 'proposal_memory_candidate',
        sourceId: clean(candidate.candidateId, 200),
        confidence: Math.max(0, Math.min(1, Number(candidate.confidence) || 0.5)),
        salience: Math.max(1, Math.min(5, Math.trunc(Number(candidate.salience) || 3))),
        tags: ['proposal-candidate', 'owner-review-required'],
      },
      evidenceRefs: Array.isArray(candidate.evidenceRefs)
        ? candidate.evidenceRefs.map((item) => clean(item, 500)).filter(Boolean).slice(0, 20)
        : [],
      rollbackPlan: [
        'If applied, hide or supersede the created MemoryCore id using the apply report memoryId.',
        'Keep pending candidate and source proposal artifacts for audit.',
      ],
      writesMemoryCore: true,
      requiresOwnerApproval: true,
    },
  };
}

export function runNoeMemoryCandidateApply({
  root = process.cwd(),
  pendingRef = NOE_MEMORY_CANDIDATE_PENDING,
  reportDir = NOE_MEMORY_CANDIDATE_APPLY_REPORT_DIR,
  memoryCore = null,
  dryRun = true,
  confirmOwner = false,
  now = new Date(),
} = {}) {
  const rootAbs = resolve(root);
  const pendingPath = resolve(rootAbs, pendingRef);
  const generatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const reportPath = resolve(rootAbs, reportDir, reportFileName());
  const { records, errors } = readJsonl(pendingPath);
  const planned = records.map((candidate) => buildNoeMemoryCandidateApplyPlan(candidate, { pendingRef }));
  const ready = planned.filter((item) => item.ok);
  const blocked = planned.filter((item) => !item.ok);
  const applied = [];
  const applyErrors = [];
  if (!dryRun && confirmOwner !== true) {
    applyErrors.push({ error: 'owner_confirmation_required' });
  } else if (!dryRun && !memoryCore?.write) {
    applyErrors.push({ error: 'memory_core_required' });
  } else if (!dryRun) {
    for (const item of ready) {
      try {
        const memory = memoryCore.write(item.plan.memoryWrite);
        applied.push({
          applyId: item.plan.applyId,
          candidateId: item.plan.candidateId,
          memoryId: clean(memory?.id, 200),
          rollback: {
            action: 'hide_memory',
            memoryId: clean(memory?.id, 200),
            reason: `rollback:${item.plan.applyId}`,
          },
        });
      } catch (e) {
        applyErrors.push({ applyId: item.plan.applyId, candidateId: item.plan.candidateId, error: clean(e?.message || e, 500) });
      }
    }
  }
  const status = !records.length
    ? 'skipped'
    : (errors.length || blocked.length || applyErrors.length ? 'blocked' : (dryRun ? 'dry_run_ready' : 'applied'));
  const report = {
    ok: errors.length === 0 && blocked.length === 0 && applyErrors.length === 0,
    schemaVersion: NOE_MEMORY_CANDIDATE_APPLY_SCHEMA_VERSION,
    generatedAt,
    status,
    reason: !records.length ? 'no_pending_memory_candidates' : '',
    dryRun,
    pendingRef,
    reportRef: rel(rootAbs, reportPath),
    counts: {
      records: records.length,
      ready: ready.length,
      blocked: blocked.length,
      applied: applied.length,
      errors: errors.length + applyErrors.length,
    },
    errors: [...errors, ...applyErrors],
    blocked: blocked.map((item) => ({ candidateId: item.plan.candidateId, blockers: item.blockers })),
    plans: ready.map((item) => item.plan),
    applied,
    directWrites: dryRun ? [] : [rel(rootAbs, reportPath), ...(applied.length ? ['MemoryCore'] : [])],
    rollbackEvidenceRequired: !dryRun,
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
