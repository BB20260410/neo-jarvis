import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import {
  decideNoeProposalInboxItem,
  executeNoeProposalInboxItem,
  listNoeProposalInbox,
} from '../runtime/NoeProposalInbox.js';
import { close as closeSqlite, initSqlite } from '../storage/SqliteStore.js';
import { MemoryCore } from './MemoryCore.js';
import { runNoeMemoryCandidateReview } from './NoeMemoryCandidateReview.js';
import { runNoeMemoryCandidateApply } from './NoeMemoryCandidateApply.js';
import { runNoeMemoryCandidateRollback } from './NoeMemoryCandidateRollback.js';

export const NOE_MEMORY_CANDIDATE_CHAIN_DRILL_SCHEMA_VERSION = 1;
export const NOE_MEMORY_CANDIDATE_CHAIN_DRILL_DIR = 'output/noe-memory-candidate-chain-drill';

function rel(root, file) {
  const ref = relative(root, file).replaceAll('\\', '/');
  if (ref && !ref.startsWith('..') && ref !== '..' && !ref.startsWith('/')) return ref;
  return file;
}

function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function nowIso(now) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function runIdFrom(now) {
  return `memory-candidate-chain-${nowIso(now).replace(/[-:.]/g, '').replace('T', 'T').replace('Z', 'Z')}`;
}

function stageOk(stage) {
  return Boolean(stage?.ok);
}

export function runNoeMemoryCandidateChainDrill({
  root = process.cwd(),
  outputDir = NOE_MEMORY_CANDIDATE_CHAIN_DRILL_DIR,
  now = new Date(),
  runId = runIdFrom(now),
} = {}) {
  const rootAbs = resolve(root);
  const outputAbs = resolve(rootAbs, outputDir);
  const fixtureRoot = resolve(outputAbs, runId, 'fixture');
  const reportPath = resolve(outputAbs, `${runId}.json`);
  const latestPath = resolve(outputAbs, 'latest.json');
  const generatedAt = nowIso(now);

  writeJson(resolve(fixtureRoot, 'output/noe-background-review/chain-memory-report.json'), {
    finishedAt: generatedAt,
    proposals: [
      {
        id: 'chain-memory-proposal',
        kind: 'memory',
        tool: 'memory_candidate',
        createdAt: generatedAt,
        item: {
          text: 'Owner wants Neo memory candidates to pass proposal materialization, owner review, dry-run apply, and rollback evidence before MemoryCore writes.',
          confidence: 0.86,
        },
      },
    ],
  });

  const inbox = listNoeProposalInbox({ root: fixtureRoot, source: 'background_review', limit: 10 });
  const proposal = inbox.proposals.find((item) => item.type === 'memory_candidate');
  const proposalStage = {
    ok: Boolean(inbox.ok && proposal?.id),
    proposalId: proposal?.id || '',
    proposalCount: inbox.counts?.returned || 0,
  };

  const decision = proposal?.id
    ? decideNoeProposalInboxItem({
        root: fixtureRoot,
        id: proposal.id,
        decision: 'approve_for_gated_apply',
        reason: 'chain_drill_owner_fixture',
        confirmOwner: true,
        now,
      })
    : { ok: false, error: 'proposal_missing' };
  const decisionStage = {
    ok: Boolean(decision.ok && decision.decision?.status === 'approved_for_gated_apply'),
    decisionId: decision.decision?.id || '',
    status: decision.decision?.status || decision.error || '',
  };

  const materialize = proposal?.id
    ? executeNoeProposalInboxItem({
        root: fixtureRoot,
        id: proposal.id,
        dryRun: false,
        confirmOwner: true,
        now,
      })
    : { ok: false, error: 'proposal_missing' };
  const materializeStage = {
    ok: Boolean(materialize.ok
      && materialize.execution?.status === 'materialized'
      && materialize.execution?.effect === 'pending_queue_only'
      && materialize.execution?.writesMemoryCore === false
      && materialize.execution?.changesCode === false),
    status: materialize.execution?.status || materialize.error || '',
    queueRef: materialize.execution?.queueRef || '',
    reportRef: materialize.execution?.reportRef || '',
    writesMemoryCore: materialize.execution?.writesMemoryCore === true,
    changesCode: materialize.execution?.changesCode === true,
  };

  const review = runNoeMemoryCandidateReview({ root: fixtureRoot, dryRun: false, now });
  const reviewStage = {
    ok: Boolean(review.ok
      && review.status === 'ready_for_owner_review'
      && review.counts?.accepted === 1
      && review.writesMemoryCore === false
      && review.requiresOwnerApprovalForMemoryWrite === true),
    status: review.status,
    pendingRef: review.pendingRef,
    reportRef: review.reportRef,
    accepted: review.counts?.accepted || 0,
    written: review.counts?.written || 0,
    writesMemoryCore: review.writesMemoryCore === true,
    requiresOwnerApprovalForMemoryWrite: review.requiresOwnerApprovalForMemoryWrite === true,
    candidateIds: review.candidates.map((item) => item.candidateId),
  };

  const dryApply = runNoeMemoryCandidateApply({ root: fixtureRoot, dryRun: true, now });
  const dryApplyStage = {
    ok: Boolean(dryApply.ok
      && dryApply.status === 'dry_run_ready'
      && dryApply.counts?.ready === 1
      && dryApply.counts?.applied === 0
      && dryApply.directWrites.length === 0),
    status: dryApply.status,
    reportRef: dryApply.reportRef,
    ready: dryApply.counts?.ready || 0,
    applied: dryApply.counts?.applied || 0,
    directWrites: dryApply.directWrites,
  };

  let fakeMemoryWrites = 0;
  const unconfirmedApply = runNoeMemoryCandidateApply({
    root: fixtureRoot,
    dryRun: false,
    confirmOwner: false,
    memoryCore: {
      write() {
        fakeMemoryWrites += 1;
        return { id: 'should-not-be-written' };
      },
    },
    now,
  });
  const unconfirmedApplyStage = {
    ok: Boolean(!unconfirmedApply.ok
      && unconfirmedApply.status === 'blocked'
      && unconfirmedApply.errors.some((item) => item.error === 'owner_confirmation_required')
      && fakeMemoryWrites === 0),
    status: unconfirmedApply.status,
    reportRef: unconfirmedApply.reportRef,
    errors: unconfirmedApply.errors.map((item) => item.error || item.message || 'unknown_error'),
    fakeMemoryWrites,
  };

  const memoryDbPath = resolve(fixtureRoot, 'output/noe-memory-candidates/fixture-memory-core/panel.db');
  let confirmedApply = { ok: false, status: 'not_run', errors: [{ error: 'not_run' }], applied: [] };
  let writtenMemory = null;
  let hiddenMemory = null;
  let rollback = { ok: false, status: 'not_run', rolledBack: [] };
  let recallVisibleAfterRollback = [];
  try {
    initSqlite(memoryDbPath);
    const memoryCore = new MemoryCore({ logger: null });
    confirmedApply = runNoeMemoryCandidateApply({
      root: fixtureRoot,
      reportDir: 'output/noe-memory-candidates/apply-reports/confirmed-fixture',
      dryRun: false,
      confirmOwner: true,
      memoryCore,
      now,
    });
    const memoryId = confirmedApply.applied?.[0]?.memoryId || '';
    if (memoryId) {
      writtenMemory = memoryCore.get(memoryId, { includeHidden: true });
      rollback = runNoeMemoryCandidateRollback({
        root: fixtureRoot,
        applyReportRef: confirmedApply.reportRef,
        reportDir: 'output/noe-memory-candidates/rollback-reports/confirmed-fixture',
        dryRun: false,
        confirmOwner: true,
        memoryCore,
        now,
      });
      hiddenMemory = memoryCore.get(memoryId, { includeHidden: true });
      recallVisibleAfterRollback = memoryCore.recall({
        projectId: 'neo',
        q: 'proposal materialization',
        bumpHits: false,
      }).map((item) => item.id);
    }
  } finally {
    closeSqlite();
  }
  const confirmedFixtureApplyRollbackStage = {
    ok: Boolean(confirmedApply.ok
      && confirmedApply.status === 'applied'
      && confirmedApply.counts?.applied === 1
      && writtenMemory?.hidden === false
      && rollback.ok === true
      && rollback.counts?.rolledBack === 1
      && hiddenMemory?.hidden === true
      && !recallVisibleAfterRollback.includes(confirmedApply.applied?.[0]?.memoryId)),
    status: confirmedApply.status || 'unknown',
    reportRef: confirmedApply.reportRef || '',
    rollbackReportRef: rollback.reportRef || '',
    dbRef: rel(rootAbs, memoryDbPath),
    applied: confirmedApply.counts?.applied || 0,
    memoryId: confirmedApply.applied?.[0]?.memoryId || '',
    rollbackApplied: rollback.ok === true && rollback.counts?.rolledBack === 1,
    hiddenAfterRollback: hiddenMemory?.hidden === true,
    visibleAfterRollback: recallVisibleAfterRollback.includes(confirmedApply.applied?.[0]?.memoryId),
    directWrites: confirmedApply.directWrites || [],
  };

  const stages = {
    proposal: proposalStage,
    ownerDecision: decisionStage,
    materializePendingQueue: materializeStage,
    reviewToPendingCandidate: reviewStage,
    dryRunMemoryApply: dryApplyStage,
    unconfirmedRealApplyBlocked: unconfirmedApplyStage,
    confirmedFixtureApplyRollback: confirmedFixtureApplyRollbackStage,
  };
  const blockers = Object.entries(stages)
    .filter(([, stage]) => !stageOk(stage))
    .map(([name]) => `${name}_failed`);
  const report = {
    ok: blockers.length === 0,
    schemaVersion: NOE_MEMORY_CANDIDATE_CHAIN_DRILL_SCHEMA_VERSION,
    generatedAt,
    runId,
    status: blockers.length ? 'blocked' : 'passed',
    blockers,
    note: 'Isolated drill only: production MemoryCore is untouched; confirmed apply writes to a fixture SQLite DB and then rolls back via hide.',
    fixtureRoot: rel(rootAbs, fixtureRoot),
    reportRef: rel(rootAbs, reportPath),
    latestRef: rel(rootAbs, latestPath),
    stages,
    safety: {
      writesProductionMemoryCore: false,
      writesFixtureMemoryCore: confirmedFixtureApplyRollbackStage.applied > 0,
      writesCode: false,
      requiresOwnerApprovalBeforeMemoryCore: true,
      unconfirmedApplyWrites: fakeMemoryWrites,
      rollbackApplied: confirmedFixtureApplyRollbackStage.rollbackApplied,
    },
  };
  writeJson(reportPath, report);
  writeJson(latestPath, report);
  return report;
}
