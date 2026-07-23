import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { redactSensitiveText } from './NoeContextScrubber.js';

export const NOE_PROPOSAL_EXECUTOR_SCHEMA_VERSION = 1;
export const NOE_PROPOSAL_EXECUTION_DIR = 'output/noe-proposal-executions';

const MATERIALIZE_TARGETS = {
  boot_self_check_manual_repair: 'queues/boot-self-check-repairs.jsonl',
  memory_candidate: 'queues/memory-candidates.jsonl',
  skill_draft: 'queues/skill-drafts.jsonl',
  review_report: 'queues/review-actions.jsonl',
  skill_review_candidate: 'queues/skill-review-tasks.jsonl',
  skill_archive_candidate: 'queues/skill-archive-tasks.jsonl',
  skill_consolidation_candidate: 'queues/skill-consolidation-tasks.jsonl',
  skill_state_transition_candidate: 'queues/skill-state-transition-tasks.jsonl',
  self_model_diff: 'queues/self-model-diffs.jsonl',
};

function clean(value, max = 1000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function rel(root, file) {
  const ref = relative(root, file).replaceAll('\\', '/');
  if (ref && !ref.startsWith('..') && ref !== '..' && !ref.startsWith('/')) return ref;
  return file;
}

function stableHash(value) {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function safePayload(value, depth = 0) {
  if (depth > 5) return '[max-depth]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => safePayload(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 80).map(([key, item]) => [clean(key, 120), safePayload(item, depth + 1)]));
  }
  return clean(value, 2000);
}

function approvedForGatedApply(proposal = {}) {
  return proposal?.ownerDecision?.status === 'approved_for_gated_apply'
    || proposal?.status === 'approved_for_gated_apply';
}

function targetFor(proposal = {}) {
  return MATERIALIZE_TARGETS[clean(proposal.type, 160)] || '';
}

function executionKeyFor(proposal = {}) {
  return stableHash({
    proposalId: proposal.id,
    proposalHash: proposal.ownerDecision?.proposalHash,
    decisionId: proposal.ownerDecision?.id,
    type: proposal.type,
    target: targetFor(proposal),
  });
}

function queueContainsExecution(file, executionKey) {
  if (!existsSync(file)) return false;
  return readFileSync(file, 'utf8').split(/\r?\n/).some((line) => line.includes(`"executionKey":"${executionKey}"`));
}

export function buildNoeProposalExecutionPlan({
  root = process.cwd(),
  proposal = {},
  now = new Date(),
} = {}) {
  if (!proposal?.id) return { ok: false, error: 'proposal_required' };
  if (!approvedForGatedApply(proposal)) return { ok: false, error: 'proposal_not_approved_for_gated_apply' };
  const target = targetFor(proposal);
  if (!target) return { ok: false, error: 'unsupported_proposal_type', supportedTypes: Object.keys(MATERIALIZE_TARGETS) };
  const rootAbs = resolve(root);
  const executionKey = executionKeyFor(proposal);
  const queuePath = resolve(rootAbs, NOE_PROPOSAL_EXECUTION_DIR, target);
  const reportPath = resolve(rootAbs, NOE_PROPOSAL_EXECUTION_DIR, `execution-${executionKey}.json`);
  const generatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  return {
    ok: true,
    plan: {
      schemaVersion: NOE_PROPOSAL_EXECUTOR_SCHEMA_VERSION,
      executionKey,
      generatedAt,
      action: 'materialize_candidate_queue',
      status: 'planned',
      effect: 'pending_queue_only',
      proposalId: clean(proposal.id, 200),
      proposalType: clean(proposal.type, 160),
      source: clean(proposal.source, 120),
      sourceReportRef: clean(proposal.sourceReportRef, 500),
      ownerDecisionId: clean(proposal.ownerDecision?.id, 200),
      queueRef: rel(rootAbs, queuePath),
      reportRef: rel(rootAbs, reportPath),
      appliesProposalDirectly: false,
      writesMemoryCore: false,
      writesSkillStore: false,
      changesCode: false,
      rollbackPlan: [
        'Remove or ignore the materialized queue item by executionKey.',
        'Keep the source proposal report unchanged.',
      ],
      candidate: {
        proposalId: clean(proposal.id, 200),
        proposalType: clean(proposal.type, 160),
        title: clean(proposal.title, 240),
        summary: clean(proposal.summary || proposal.preview?.summary, 1000),
        sourceReportRef: clean(proposal.sourceReportRef, 500),
        raw: safePayload(proposal.raw || {}),
      },
    },
  };
}

export function executeNoeProposalMaterialization({
  root = process.cwd(),
  proposal = {},
  dryRun = true,
  confirmOwner = false,
  now = new Date(),
} = {}) {
  const built = buildNoeProposalExecutionPlan({ root, proposal, now });
  if (!built.ok) return built;
  const rootAbs = resolve(root);
  const plan = built.plan;
  if (dryRun) return { ok: true, dryRun: true, execution: { ...plan, status: 'dry_run', directWrites: [] } };
  if (confirmOwner !== true) return { ok: false, error: 'owner_confirmation_required' };
  const queuePath = resolve(rootAbs, plan.queueRef);
  const reportPath = resolve(rootAbs, plan.reportRef);
  mkdirSync(dirname(queuePath), { recursive: true });
  mkdirSync(dirname(reportPath), { recursive: true });
  const alreadyMaterialized = queueContainsExecution(queuePath, plan.executionKey);
  const record = {
    schemaVersion: NOE_PROPOSAL_EXECUTOR_SCHEMA_VERSION,
    executionKey: plan.executionKey,
    materializedAt: plan.generatedAt,
    status: alreadyMaterialized ? 'already_materialized' : 'materialized',
    effect: plan.effect,
    proposal: plan.candidate,
    rollbackPlan: plan.rollbackPlan,
  };
  if (!alreadyMaterialized) appendFileSync(queuePath, `${JSON.stringify(record)}\n`);
  const report = {
    ...plan,
    status: record.status,
    directWrites: alreadyMaterialized ? [plan.reportRef] : [plan.queueRef, plan.reportRef],
    materializedRecord: record,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return { ok: true, dryRun: false, execution: report };
}
