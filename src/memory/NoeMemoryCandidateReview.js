import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

export const NOE_MEMORY_CANDIDATE_REVIEW_SCHEMA_VERSION = 1;
export const NOE_MEMORY_CANDIDATE_QUEUE = 'output/noe-proposal-executions/queues/memory-candidates.jsonl';
export const NOE_MEMORY_CANDIDATE_PENDING = 'output/noe-memory-candidates/pending.jsonl';
export const NOE_MEMORY_CANDIDATE_REPORT_DIR = 'output/noe-memory-candidates/reports';

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
  return `memory-candidate-review-${Date.now()}-${randomUUID().slice(0, 8)}.json`;
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

function candidateText(record = {}) {
  const raw = record.proposal?.raw || {};
  const item = raw.item && typeof raw.item === 'object' ? raw.item : {};
  return clean(item.text || item.body || item.summary || record.proposal?.summary || record.proposal?.title || '', 2000);
}

function candidateConfidence(record = {}) {
  const raw = record.proposal?.raw || {};
  const item = raw.item && typeof raw.item === 'object' ? raw.item : {};
  const n = Number(item.confidence ?? record.proposal?.confidence ?? 0.5);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function pendingContains(file, candidateId) {
  if (!existsSync(file)) return false;
  return readFileSync(file, 'utf8').split(/\r?\n/).some((line) => line.includes(`"candidateId":"${candidateId}"`));
}

export function reconcileNoeMemoryCandidateRecord(record = {}, {
  queueRef = NOE_MEMORY_CANDIDATE_QUEUE,
  minConfidence = 0.7,
} = {}) {
  const body = candidateText(record);
  const confidence = candidateConfidence(record);
  const blockers = [];
  if (record.effect !== 'pending_queue_only') blockers.push('unexpected_queue_effect');
  if (record.proposal?.proposalType !== 'memory_candidate') blockers.push('not_memory_candidate');
  if (!body) blockers.push('empty_memory_body');
  if (confidence < minConfidence) blockers.push('confidence_below_threshold');
  const candidateId = `memory-candidate-${hash({
    executionKey: record.executionKey,
    proposalId: record.proposal?.proposalId,
    body,
  })}`;
  return {
    ok: blockers.length === 0,
    blockers,
    candidate: {
      schemaVersion: NOE_MEMORY_CANDIDATE_REVIEW_SCHEMA_VERSION,
      candidateId,
      status: blockers.length ? 'blocked' : 'pending_owner_review',
      origin: 'proposal_materialization',
      executionKey: clean(record.executionKey, 200),
      proposalId: clean(record.proposal?.proposalId, 200),
      sourceReportRef: clean(record.proposal?.sourceReportRef, 500),
      body,
      scope: 'project',
      confidence,
      salience: 3,
      evidenceRefs: [
        clean(queueRef, 500),
        clean(record.proposal?.sourceReportRef, 500),
      ].filter(Boolean),
      writesMemoryCore: false,
      requiresOwnerApproval: true,
      rollbackPlan: [
        'Remove or ignore this pending candidate by candidateId before MemoryCore apply.',
        'Do not mutate source proposal reports.',
      ],
    },
  };
}

export function runNoeMemoryCandidateReview({
  root = process.cwd(),
  queueRef = NOE_MEMORY_CANDIDATE_QUEUE,
  pendingRef = NOE_MEMORY_CANDIDATE_PENDING,
  reportDir = NOE_MEMORY_CANDIDATE_REPORT_DIR,
  dryRun = false,
  now = new Date(),
} = {}) {
  const rootAbs = resolve(root);
  const queuePath = resolve(rootAbs, queueRef);
  const pendingPath = resolve(rootAbs, pendingRef);
  const generatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const reportPath = resolve(rootAbs, reportDir, reportFileName());
  const { records, errors } = readJsonl(queuePath);
  const reconciled = records.map((record) => reconcileNoeMemoryCandidateRecord(record, { queueRef }));
  const accepted = reconciled.filter((item) => item.ok);
  const blocked = reconciled.filter((item) => !item.ok);
  const written = [];
  const duplicates = [];
  if (!dryRun && accepted.length) {
    mkdirSync(dirname(pendingPath), { recursive: true });
    for (const item of accepted) {
      if (pendingContains(pendingPath, item.candidate.candidateId)) {
        duplicates.push(item.candidate.candidateId);
        continue;
      }
      appendFileSync(pendingPath, `${JSON.stringify(item.candidate)}\n`);
      written.push(item.candidate.candidateId);
    }
  }
  const report = {
    ok: errors.length === 0 && blocked.length === 0,
    schemaVersion: NOE_MEMORY_CANDIDATE_REVIEW_SCHEMA_VERSION,
    generatedAt,
    status: !records.length ? 'skipped' : (errors.length || blocked.length ? 'blocked' : 'ready_for_owner_review'),
    reason: !records.length ? 'no_materialized_memory_queue' : '',
    dryRun,
    queueRef,
    pendingRef,
    reportRef: rel(rootAbs, reportPath),
    counts: {
      records: records.length,
      accepted: accepted.length,
      blocked: blocked.length,
      written: written.length,
      duplicates: duplicates.length,
      errors: errors.length,
    },
    errors,
    blocked: blocked.map((item) => ({ candidateId: item.candidate.candidateId, blockers: item.blockers })),
    candidates: accepted.map((item) => item.candidate),
    duplicates,
    directWrites: dryRun ? [] : [pendingRef, rel(rootAbs, reportPath)].filter((_, index) => index === 1 || written.length),
    writesMemoryCore: false,
    requiresOwnerApprovalForMemoryWrite: true,
  };
  if (!dryRun) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}
