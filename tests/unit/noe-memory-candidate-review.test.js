import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  reconcileNoeMemoryCandidateRecord,
  runNoeMemoryCandidateReview,
} from '../../src/memory/NoeMemoryCandidateReview.js';

function writeJsonl(file, records = []) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

function queueRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    executionKey: 'exec-memory-1',
    status: 'materialized',
    effect: 'pending_queue_only',
    proposal: {
      proposalId: 'proposal-memory-1',
      proposalType: 'memory_candidate',
      title: 'Owner preference',
      summary: 'Store a stable owner preference.',
      sourceReportRef: 'output/noe-background-review/review.json',
      raw: {
        item: {
          text: 'Owner wants tested Neo runtime improvements with OPENAI_API_KEY=unitsecret000000000000000000 hidden.',
          confidence: 0.82,
        },
      },
    },
    ...overrides,
  };
}

describe('NoeMemoryCandidateReview', () => {
  it('reconciles materialized memory candidates into redacted pending review records', () => {
    const out = reconcileNoeMemoryCandidateRecord(queueRecord());

    expect(out.ok).toBe(true);
    expect(out.candidate).toMatchObject({
      status: 'pending_owner_review',
      origin: 'proposal_materialization',
      writesMemoryCore: false,
      requiresOwnerApproval: true,
      confidence: 0.82,
    });
    expect(out.candidate.body).not.toContain('unitsecret');
    expect(out.candidate.evidenceRefs).toContain('output/noe-background-review/review.json');
  });

  it('blocks low-confidence or wrong-type records before pending review', () => {
    expect(reconcileNoeMemoryCandidateRecord(queueRecord({
      proposal: {
        proposalId: 'proposal-low-confidence',
        proposalType: 'memory_candidate',
        raw: { item: { text: 'weak memory', confidence: 0.2 } },
      },
    })).blockers).toContain('confidence_below_threshold');

    expect(reconcileNoeMemoryCandidateRecord(queueRecord({
      proposal: { proposalId: 'proposal-skill', proposalType: 'skill_draft', raw: { item: { text: 'not memory', confidence: 0.9 } } },
    })).blockers).toContain('not_memory_candidate');
  });

  it('dry-runs without writing pending candidates or reports', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-memory-candidate-review-'));
    try {
      writeJsonl(join(root, 'output/noe-proposal-executions/queues/memory-candidates.jsonl'), [queueRecord()]);

      const report = runNoeMemoryCandidateReview({ root, dryRun: true });

      expect(report).toMatchObject({
        ok: true,
        dryRun: true,
        status: 'ready_for_owner_review',
        counts: { records: 1, accepted: 1, written: 0 },
        writesMemoryCore: false,
      });
      expect(existsSync(join(root, 'output/noe-memory-candidates/pending.jsonl'))).toBe(false);
      expect(existsSync(join(root, report.reportRef))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes an explicit skipped report when no materialized queue exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-memory-candidate-review-'));
    try {
      const report = runNoeMemoryCandidateReview({ root });

      expect(report).toMatchObject({
        ok: true,
        status: 'skipped',
        reason: 'no_materialized_memory_queue',
        counts: { records: 0, accepted: 0, written: 0 },
      });
      expect(readFileSync(join(root, report.reportRef), 'utf8')).toContain('no_materialized_memory_queue');
      expect(existsSync(join(root, 'output/noe-memory-candidates/pending.jsonl'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes pending candidates idempotently and reports duplicates', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-memory-candidate-review-'));
    try {
      writeJsonl(join(root, 'output/noe-proposal-executions/queues/memory-candidates.jsonl'), [queueRecord()]);

      const first = runNoeMemoryCandidateReview({ root, now: new Date('2026-06-13T01:30:00.000Z') });
      const second = runNoeMemoryCandidateReview({ root, now: new Date('2026-06-13T01:31:00.000Z') });

      expect(first).toMatchObject({ ok: true, counts: { records: 1, accepted: 1, written: 1, duplicates: 0 } });
      expect(second).toMatchObject({ ok: true, counts: { records: 1, accepted: 1, written: 0, duplicates: 1 } });
      const pending = readFileSync(join(root, 'output/noe-memory-candidates/pending.jsonl'), 'utf8');
      const report = readFileSync(join(root, first.reportRef), 'utf8');
      expect(pending.split(/\r?\n/).filter(Boolean)).toHaveLength(1);
      expect(pending).toContain('"pending_owner_review"');
      expect(report).toContain('"requiresOwnerApprovalForMemoryWrite": true');
      expect(`${pending}\n${report}`).not.toContain('unitsecret');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
