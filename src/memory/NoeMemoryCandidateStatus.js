// @ts-check

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';
import {
  NOE_MEMORY_CANDIDATE_PENDING,
  NOE_MEMORY_CANDIDATE_QUEUE,
  NOE_MEMORY_CANDIDATE_REPORT_DIR,
} from './NoeMemoryCandidateReview.js';
import { NOE_MEMORY_CANDIDATE_APPLY_REPORT_DIR } from './NoeMemoryCandidateApply.js';
import { NOE_MEMORY_CANDIDATE_ROLLBACK_REPORT_DIR } from './NoeMemoryCandidateRollback.js';

const MAX_REPORT_BYTES = 1024 * 1024;

function clean(value, max = 500) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function rel(root, file) {
  const ref = relative(root, file).replaceAll('\\', '/');
  if (ref && !ref.startsWith('..') && ref !== '..' && !ref.startsWith('/')) return ref;
  return file;
}

function readJsonl(file) {
  if (!existsSync(file)) return { exists: false, records: [], errors: [] };
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
  return { exists: true, records, errors };
}

function byStatus(records, fallback = 'unknown') {
  const out = {};
  for (const record of records) {
    const key = clean(record?.status || fallback, 80) || fallback;
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function summarizeQueueRecord(record = {}) {
  return {
    executionKey: clean(record.executionKey, 160),
    proposalId: clean(record.proposal?.proposalId, 160),
    proposalType: clean(record.proposal?.proposalType, 80),
    effect: clean(record.effect, 80),
    createdAt: clean(record.createdAt || record.generatedAt || '', 80),
  };
}

function summarizePendingCandidate(candidate = {}) {
  return {
    candidateId: clean(candidate.candidateId, 160),
    status: clean(candidate.status, 80),
    scope: clean(candidate.scope, 80),
    confidence: Number.isFinite(Number(candidate.confidence)) ? Number(candidate.confidence) : null,
    salience: Number.isFinite(Number(candidate.salience)) ? Number(candidate.salience) : null,
    evidenceRefCount: Array.isArray(candidate.evidenceRefs) ? candidate.evidenceRefs.length : 0,
    requiresOwnerApproval: candidate.requiresOwnerApproval === true,
    writesMemoryCore: candidate.writesMemoryCore === true,
  };
}

function listJsonFiles(dir, depth = 3) {
  if (!existsSync(dir) || depth < 0) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listJsonFiles(file, depth - 1));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const stat = statSync(file);
      out.push({ file, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      // Ignore disappearing files during status reads.
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function readJsonReport(file) {
  try {
    const stat = statSync(file);
    if (stat.size > MAX_REPORT_BYTES) return { ok: false, error: 'report_too_large' };
    return { ok: true, data: JSON.parse(readFileSync(file, 'utf8')) };
  } catch {
    return { ok: false, error: 'report_read_failed' };
  }
}

function summarizeReport(root, item) {
  if (!item?.file) return null;
  const loaded = readJsonReport(item.file);
  const ref = rel(root, item.file);
  if (!loaded.ok) {
    return {
      ref,
      ok: false,
      status: clean(loaded.error, 120),
      generatedAt: '',
      dryRun: null,
      counts: {},
    };
  }
  const report = loaded.data || {};
  return {
    ref,
    reportRef: clean(report.reportRef || ref, 500),
    ok: report.ok === true,
    status: clean(report.status || report.error || '', 120),
    generatedAt: clean(report.generatedAt || '', 80),
    dryRun: typeof report.dryRun === 'boolean' ? report.dryRun : null,
    reason: clean(report.reason || '', 160),
    counts: report.counts && typeof report.counts === 'object' ? report.counts : {},
    writesMemoryCore: report.writesMemoryCore === true || report.writesProductionMemoryCore === true,
    requiresOwnerConfirmation: report.requiresOwnerConfirmation === true || report.requiresOwnerApprovalForMemoryWrite === true,
    directWriteKinds: Array.isArray(report.directWrites)
      ? report.directWrites.map((value) => clean(value, 160)).filter(Boolean).slice(0, 10)
      : [],
  };
}

function reportGroup(rootAbs, reportDir) {
  const dir = resolve(rootAbs, reportDir);
  const files = listJsonFiles(dir);
  return {
    dirRef: reportDir,
    exists: existsSync(dir),
    count: files.length,
    latest: summarizeReport(rootAbs, files[0]),
  };
}

export function buildNoeMemoryCandidateStatus({
  root = process.cwd(),
  queueRef = NOE_MEMORY_CANDIDATE_QUEUE,
  pendingRef = NOE_MEMORY_CANDIDATE_PENDING,
  reviewReportDir = NOE_MEMORY_CANDIDATE_REPORT_DIR,
  applyReportDir = NOE_MEMORY_CANDIDATE_APPLY_REPORT_DIR,
  rollbackReportDir = NOE_MEMORY_CANDIDATE_ROLLBACK_REPORT_DIR,
  limit = 10,
  now = new Date(),
} = {}) {
  const rootAbs = resolve(root);
  const maxItems = Math.max(1, Math.min(50, Math.trunc(Number(limit) || 10)));
  const generatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const queue = readJsonl(resolve(rootAbs, queueRef));
  const pending = readJsonl(resolve(rootAbs, pendingRef));
  const reviewReports = reportGroup(rootAbs, reviewReportDir);
  const applyReports = reportGroup(rootAbs, applyReportDir);
  const rollbackReports = reportGroup(rootAbs, rollbackReportDir);
  const pendingItems = pending.records.map(summarizePendingCandidate);
  const queueItems = queue.records.map(summarizeQueueRecord);
  const pendingOwnerReview = pendingItems.filter((item) => item.status === 'pending_owner_review').length;
  return {
    ok: queue.errors.length === 0 && pending.errors.length === 0,
    generatedAt,
    policy: {
      readOnly: true,
      noMemoryBodyOutput: true,
      noSecretOutput: true,
      productionMemoryWriteExposedInUi: false,
    },
    refs: {
      queueRef,
      pendingRef,
      reviewReportDir,
      applyReportDir,
      rollbackReportDir,
    },
    queue: {
      exists: queue.exists,
      records: queue.records.length,
      errors: queue.errors,
      latest: queueItems.slice(-maxItems).reverse(),
    },
    pending: {
      exists: pending.exists,
      records: pending.records.length,
      errors: pending.errors,
      byStatus: byStatus(pendingItems),
      pendingOwnerReview,
      latest: pendingItems.slice(-maxItems).reverse(),
    },
    reports: {
      review: reviewReports,
      apply: applyReports,
      rollback: rollbackReports,
    },
    readiness: {
      hasPendingOwnerReview: pendingOwnerReview > 0,
      latestReviewStatus: reviewReports.latest?.status || '',
      latestApplyStatus: applyReports.latest?.status || '',
      latestRollbackStatus: rollbackReports.latest?.status || '',
      latestApplyReportRef: applyReports.latest?.reportRef || applyReports.latest?.ref || '',
      rollbackInputReady: Boolean(applyReports.latest?.reportRef || applyReports.latest?.ref),
    },
  };
}
