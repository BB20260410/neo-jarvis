import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildNoeMemoryCandidateStatus } from '../../src/memory/NoeMemoryCandidateStatus.js';

function writeJson(file, data) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function appendLine(file, data) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data)}\n`, { flag: 'a' });
}

describe('buildNoeMemoryCandidateStatus', () => {
  it('summarizes queue, pending candidates, and reports without exposing memory bodies or secret-like text', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-memory-candidate-status-'));
    try {
      appendLine(join(root, 'output/noe-proposal-executions/queues/memory-candidates.jsonl'), {
        executionKey: 'exec-a',
        effect: 'pending_queue_only',
        proposal: {
          proposalId: 'proposal-a',
          proposalType: 'memory_candidate',
          raw: { item: { body: '用户 OPENAI_API_KEY=unitsecret000000000000000000 should not leak' } },
        },
      });
      appendLine(join(root, 'output/noe-memory-candidates/pending.jsonl'), {
        candidateId: 'candidate-a',
        status: 'pending_owner_review',
        body: '主人喜欢黑咖啡，token=secret-value should not leak',
        scope: 'project',
        confidence: 0.91,
        salience: 4,
        evidenceRefs: ['output/noe-proposal-executions/queues/memory-candidates.jsonl'],
        requiresOwnerApproval: true,
        writesMemoryCore: false,
      });
      writeJson(join(root, 'output/noe-memory-candidates/reports/review.json'), {
        ok: true,
        status: 'ready_for_owner_review',
        generatedAt: '2026-06-13T01:00:00.000Z',
        dryRun: false,
        reportRef: 'output/noe-memory-candidates/reports/review.json',
        counts: { records: 1, written: 1 },
        candidates: [{ body: 'secret candidate body' }],
        writesMemoryCore: false,
      });
      writeJson(join(root, 'output/noe-memory-candidates/apply-reports/fixture/apply.json'), {
        ok: true,
        status: 'dry_run_ready',
        generatedAt: '2026-06-13T01:01:00.000Z',
        dryRun: true,
        reportRef: 'output/noe-memory-candidates/apply-reports/fixture/apply.json',
        counts: { records: 1, ready: 1 },
        plans: [{ memoryWrite: { body: 'secret apply body' } }],
      });
      writeJson(join(root, 'output/noe-memory-candidates/rollback-reports/rollback.json'), {
        ok: true,
        status: 'skipped',
        generatedAt: '2026-06-13T01:02:00.000Z',
        dryRun: true,
        reportRef: 'output/noe-memory-candidates/rollback-reports/rollback.json',
        counts: { rollbackItems: 0 },
      });

      const status = buildNoeMemoryCandidateStatus({ root, now: new Date('2026-06-13T02:00:00.000Z') });

      expect(status).toMatchObject({
        ok: true,
        policy: { readOnly: true, noMemoryBodyOutput: true, productionMemoryWriteExposedInUi: false },
        queue: { exists: true, records: 1 },
        pending: { exists: true, records: 1, pendingOwnerReview: 1 },
        readiness: {
          hasPendingOwnerReview: true,
          latestReviewStatus: 'ready_for_owner_review',
          latestApplyStatus: 'dry_run_ready',
          latestRollbackStatus: 'skipped',
          rollbackInputReady: true,
        },
      });
      expect(status.pending.latest[0]).toMatchObject({
        candidateId: 'candidate-a',
        evidenceRefCount: 1,
        writesMemoryCore: false,
      });
      const serialized = JSON.stringify(status);
      expect(serialized).not.toContain('黑咖啡');
      expect(serialized).not.toContain('secret apply body');
      expect(serialized).not.toContain('secret candidate body');
      expect(serialized).not.toContain('unitsecret');
      expect(serialized).not.toContain('secret-value');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
