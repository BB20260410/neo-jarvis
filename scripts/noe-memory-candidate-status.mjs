#!/usr/bin/env node
// @ts-check

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildNoeMemoryCandidateStatus } from '../src/memory/NoeMemoryCandidateStatus.js';

const root = process.cwd();
const outDir = join(root, 'output', 'noe-memory-candidates', 'status');
mkdirSync(outDir, { recursive: true });

const status = buildNoeMemoryCandidateStatus({ root, limit: 10 });
const report = {
  ok: status.ok === true,
  generatedAt: new Date().toISOString(),
  status,
};
const file = join(outDir, `memory-candidate-status-${Date.now()}.json`);
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });

console.log(JSON.stringify({
  ok: report.ok,
  reportPath: file,
  queueRecords: status.queue.records,
  pendingRecords: status.pending.records,
  pendingOwnerReview: status.pending.pendingOwnerReview,
  latestReviewStatus: status.readiness.latestReviewStatus,
  latestApplyStatus: status.readiness.latestApplyStatus,
  latestRollbackStatus: status.readiness.latestRollbackStatus,
  readOnly: status.policy.readOnly,
}, null, 2));
