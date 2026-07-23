// @ts-check

import { buildNoeMemoryStatus } from './NoeMemoryStatus.js';
import { loadConsolidationCandidates } from './NoeDreamConsolidation.js';
import { planConsolidation } from './NoeMemoryConsolidator.js';

function ids(items = [], key = 'id', limit = 50) {
  return (Array.isArray(items) ? items : [])
    .map((item) => String((typeof item === 'string' ? item : item?.[key]) || '').slice(0, 180))
    .filter(Boolean)
    .slice(0, limit);
}

export async function runNoeMemoryMaintenanceDryRun({
  memory,
  db = null,
  projectId = 'noe',
  candidateLimit = 80,
  gcMaxScan = 10000,
  now = Date.now,
} = {}) {
  if (!memory?.runGc) throw new Error('memory required');
  const before = db?.prepare ? buildNoeMemoryStatus({ db, now }) : null;
  const candidates = loadConsolidationCandidates(memory, { projectId, limit: candidateLimit });
  const plan = await planConsolidation(candidates, {
    nowMs: now(),
    protectedScopes: ['identity', 'person'],
  });
  const gc = memory.runGc({ apply: false, projectId, maxScan: gcMaxScan });
  return {
    ok: true,
    projectId,
    mode: 'dry_run',
    policy: {
      dryRunOnly: true,
      noMemoryBodyOutput: true,
      noSecretOutput: true,
      protectedIdentitySalience: 5,
    },
    before: before ? {
      counts: before.counts,
      sourceLinked: before.sourceLinked,
      semanticProvider: before.semanticProvider,
      maintenance: before.maintenance,
    } : null,
    dream: {
      scanned: plan.scanned,
      merges: ids(plan.merges, 'keepId'),
      mergeCount: Array.isArray(plan.merges) ? plan.merges.length : 0,
      downgradeIds: ids(plan.downgrades),
      downgradeCount: Array.isArray(plan.downgrades) ? plan.downgrades.length : 0,
      promotionIds: ids(plan.promotions),
      promotionCount: Array.isArray(plan.promotions) ? plan.promotions.length : 0,
      skippedProtected: plan.skippedProtected || 0,
    },
    gc: {
      applied: false,
      candidateIds: ids(gc.plan?.gcCandidates || []),
      candidateCount: Array.isArray(gc.plan?.gcCandidates) ? gc.plan.gcCandidates.length : 0,
      expiredCount: Array.isArray(gc.plan?.buckets?.expired) ? gc.plan.buckets.expired.length : 0,
      staleCount: Array.isArray(gc.plan?.buckets?.stale) ? gc.plan.buckets.stale.length : 0,
      lowConfidenceCount: Array.isArray(gc.plan?.buckets?.low_confidence) ? gc.plan.buckets.low_confidence.length : 0,
      truncated: gc.truncated === true,
    },
  };
}
