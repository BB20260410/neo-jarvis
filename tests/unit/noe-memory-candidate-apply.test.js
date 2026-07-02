import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildNoeMemoryCandidateApplyPlan,
  runNoeMemoryCandidateApply,
} from '../../src/memory/NoeMemoryCandidateApply.js';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { close as closeSqlite, initSqlite } from '../../src/storage/SqliteStore.js';

function writeJsonl(file, records = []) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

function candidate(overrides = {}) {
  return {
    schemaVersion: 1,
    candidateId: 'memory-candidate-1',
    status: 'pending_owner_review',
    origin: 'proposal_materialization',
    executionKey: 'exec-memory-1',
    proposalId: 'proposal-memory-1',
    sourceReportRef: 'output/noe-background-review/review.json',
    body: 'Owner wants tested runtime improvements and OPENAI_API_KEY=unitsecret000000000000000000 hidden.',
    scope: 'project',
    confidence: 0.82,
    salience: 3,
    evidenceRefs: [
      'output/noe-proposal-executions/queues/memory-candidates.jsonl',
      'output/noe-background-review/review.json',
    ],
    writesMemoryCore: false,
    requiresOwnerApproval: true,
    ...overrides,
  };
}

describe('NoeMemoryCandidateApply', () => {
  afterEach(() => {
    try { closeSqlite(); } catch { /* no active sqlite handle */ }
  });

  it('builds a redacted MemoryCore apply plan with rollback instructions', () => {
    const out = buildNoeMemoryCandidateApplyPlan(candidate());

    expect(out.ok).toBe(true);
    expect(out.plan).toMatchObject({
      status: 'ready_for_apply',
      writesMemoryCore: true,
      requiresOwnerApproval: true,
      memoryWrite: {
        scope: 'project',
        projectId: 'noe',
        sourceType: 'proposal_memory_candidate',
        sourceId: 'memory-candidate-1',
        confidence: 0.82,
      },
    });
    expect(out.plan.memoryWrite.body).not.toContain('unitsecret');
    expect(out.plan.rollbackPlan.join('\n')).toContain('memoryId');
  });

  it('dry-runs pending candidates without writing MemoryCore', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-memory-candidate-apply-'));
    try {
      writeJsonl(join(root, 'output/noe-memory-candidates/pending.jsonl'), [candidate()]);
      let writes = 0;
      const memoryCore = { write() { writes += 1; return { id: 'mem-1' }; } };

      const report = runNoeMemoryCandidateApply({ root, memoryCore, dryRun: true });

      expect(report).toMatchObject({
        ok: true,
        status: 'dry_run_ready',
        dryRun: true,
        counts: { records: 1, ready: 1, applied: 0 },
        directWrites: [],
      });
      expect(writes).toBe(0);
      expect(readFileSync(join(root, report.reportRef), 'utf8')).toContain('"dryRun": true');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires owner confirmation and memoryCore before real apply', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-memory-candidate-apply-'));
    try {
      writeJsonl(join(root, 'output/noe-memory-candidates/pending.jsonl'), [candidate()]);

      expect(runNoeMemoryCandidateApply({ root, dryRun: false, memoryCore: { write: () => ({ id: 'mem-1' }) } })).toMatchObject({
        ok: false,
        status: 'blocked',
        errors: [{ error: 'owner_confirmation_required' }],
      });
      expect(runNoeMemoryCandidateApply({ root, dryRun: false, confirmOwner: true })).toMatchObject({
        ok: false,
        status: 'blocked',
        errors: [{ error: 'memory_core_required' }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies confirmed candidates through injected MemoryCore and records rollback evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-memory-candidate-apply-'));
    try {
      writeJsonl(join(root, 'output/noe-memory-candidates/pending.jsonl'), [candidate()]);
      const writes = [];
      const memoryCore = {
        write(input) {
          writes.push(input);
          return { id: 'mem-applied-1', ...input };
        },
      };

      const report = runNoeMemoryCandidateApply({
        root,
        dryRun: false,
        confirmOwner: true,
        memoryCore,
        now: new Date('2026-06-13T01:40:00.000Z'),
      });

      expect(report).toMatchObject({
        ok: true,
        status: 'applied',
        counts: { records: 1, ready: 1, applied: 1 },
        directWrites: [report.reportRef, 'MemoryCore'],
      });
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ sourceType: 'proposal_memory_candidate', sourceId: 'memory-candidate-1' });
      expect(writes[0].body).not.toContain('unitsecret');
      expect(report.applied[0]).toMatchObject({
        memoryId: 'mem-applied-1',
        rollback: { action: 'hide_memory', memoryId: 'mem-applied-1' },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks malformed pending candidates before apply', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-memory-candidate-apply-'));
    try {
      writeJsonl(join(root, 'output/noe-memory-candidates/pending.jsonl'), [candidate({ status: 'blocked', body: '' })]);

      const report = runNoeMemoryCandidateApply({ root, dryRun: true });

      expect(report.ok).toBe(false);
      expect(report.status).toBe('blocked');
      expect(report.blocked[0].blockers).toEqual(expect.arrayContaining([
        'candidate_not_pending_owner_review',
        'memory_body_required',
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies into the production "noe" project so default recall finds it (regression: orphan projectId)', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-memory-candidate-apply-'));
    try {
      writeJsonl(join(root, 'output/noe-memory-candidates/pending.jsonl'), [candidate({ body: 'Owner wants tested runtime improvements documented.' })]);
      const dbPath = join(root, 'output/noe-memory-candidates/fixture-memory-core/panel.db');
      initSqlite(dbPath);
      const memoryCore = new MemoryCore({ logger: null });

      const report = runNoeMemoryCandidateApply({
        root,
        dryRun: false,
        confirmOwner: true,
        memoryCore,
        now: new Date('2026-06-14T00:00:00.000Z'),
      });

      expect(report).toMatchObject({ ok: true, status: 'applied', counts: { applied: 1 } });
      const memoryId = report.applied[0].memoryId;
      expect(memoryId).toBeTruthy();

      // 生产入口（NoeMemoryRetriever / NoeTurnContextEngine / SoloChatDispatcher）默认 projectId='noe'。
      // 旧 bug：apply 硬编码写 'neo' 分区 → 默认 recall 永远召回不到 = 孤儿记忆。
      const recalled = memoryCore.recall({ projectId: 'noe', q: 'tested runtime', bumpHits: false }).map((r) => r.id);
      expect(recalled).toContain(memoryId);
    } finally {
      closeSqlite();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('honors an explicit candidate.projectId when provided', () => {
    const out = buildNoeMemoryCandidateApplyPlan(candidate({ projectId: 'special-room' }));
    expect(out.ok).toBe(true);
    expect(out.plan.memoryWrite.projectId).toBe('special-room');
  });

  it('writes a skipped report when no pending candidate queue exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-memory-candidate-apply-'));
    try {
      const report = runNoeMemoryCandidateApply({ root });

      expect(report).toMatchObject({
        ok: true,
        status: 'skipped',
        reason: 'no_pending_memory_candidates',
      });
      expect(existsSync(join(root, report.reportRef))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
