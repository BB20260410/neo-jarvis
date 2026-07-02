import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { redactSensitiveText } from './NoeContextScrubber.js';

export const NOE_PROPOSAL_DECISION_SCHEMA_VERSION = 1;
export const NOE_PROPOSAL_DECISION_LOG = 'output/noe-proposal-decisions/decisions.jsonl';

const ALLOWED_DECISIONS = new Map([
  ['approve_for_gated_apply', 'approved_for_gated_apply'],
  ['defer', 'deferred'],
  ['dismiss', 'dismissed'],
]);

function clean(value, max = 1000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function rel(root, file) {
  const ref = relative(root, file).replaceAll('\\', '/');
  if (ref && !ref.startsWith('..') && ref !== '..' && !ref.startsWith('/')) return ref;
  return file;
}

function logPath(root) {
  return resolve(root, NOE_PROPOSAL_DECISION_LOG);
}

function proposalHash(proposal = {}) {
  return createHash('sha1').update(JSON.stringify({
    id: proposal.id,
    source: proposal.source,
    sourceReportRef: proposal.sourceReportRef,
    type: proposal.type,
    title: proposal.title,
    // 纳入 apply 负载的脱敏内容指纹（如 self-model patch 值），让审批 hash 绑定具体内容、
    // 而非仅元数据；消除 approve→篡改 latest.json→apply 的 TOCTOU。
    patchContentHash: proposal.patchContentHash || '',
  })).digest('hex').slice(0, 16);
}

export function normalizeNoeProposalDecision(decision = '') {
  return clean(decision, 80).toLowerCase();
}

export function statusForNoeProposalDecision(decision = '') {
  return ALLOWED_DECISIONS.get(normalizeNoeProposalDecision(decision)) || '';
}

export function createNoeProposalDecisionRecord({
  proposal = {},
  decision = '',
  reason = '',
  actor = 'owner',
  confirmOwner = false,
  now = new Date(),
} = {}) {
  const normalizedDecision = normalizeNoeProposalDecision(decision);
  const status = statusForNoeProposalDecision(normalizedDecision);
  if (!proposal?.id) return { ok: false, error: 'proposal_required' };
  if (!status) return { ok: false, error: 'unsupported_proposal_decision', allowedDecisions: [...ALLOWED_DECISIONS.keys()] };
  if (confirmOwner !== true) return { ok: false, error: 'owner_confirmation_required' };
  const decidedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  return {
    ok: true,
    record: {
      schemaVersion: NOE_PROPOSAL_DECISION_SCHEMA_VERSION,
      id: `proposal-decision-${randomUUID()}`,
      proposalId: clean(proposal.id, 200),
      proposalHash: proposalHash(proposal),
      // 审批时锁定的 apply 负载内容指纹；apply 时重算并比对，不一致即拒绝（消除 TOCTOU）。
      patchContentHash: clean(proposal.patchContentHash, 32),
      decision: normalizedDecision,
      status,
      actor: clean(actor || 'owner', 80) || 'owner',
      decidedAt,
      reason: clean(reason, 1000),
      source: clean(proposal.source, 120),
      sourceReportRef: clean(proposal.sourceReportRef, 500),
      proposalType: clean(proposal.type, 160),
      effect: 'ledger_only',
      directWrites: [NOE_PROPOSAL_DECISION_LOG],
      appliesProposalDirectly: false,
      requiresExecutorForRealApply: true,
    },
  };
}

export function appendNoeProposalDecision({ root = process.cwd(), record = {} } = {}) {
  const rootAbs = resolve(root);
  const file = logPath(rootAbs);
  mkdirSync(join(file, '..'), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`);
  return { ref: rel(rootAbs, file) };
}

export function recordNoeProposalDecision({
  root = process.cwd(),
  proposal = {},
  decision = '',
  reason = '',
  actor = 'owner',
  confirmOwner = false,
  now = new Date(),
} = {}) {
  const built = createNoeProposalDecisionRecord({ proposal, decision, reason, actor, confirmOwner, now });
  if (!built.ok) return built;
  const ledgerRef = appendNoeProposalDecision({ root, record: built.record }).ref;
  return { ok: true, decision: { ...built.record, ledgerRef } };
}

export function listNoeProposalDecisions({ root = process.cwd() } = {}) {
  const rootAbs = resolve(root);
  const file = logPath(rootAbs);
  if (!existsSync(file)) return { ok: true, decisions: [], errors: [] };
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const decisions = [];
  const errors = [];
  lines.forEach((line, index) => {
    try {
      const record = JSON.parse(line);
      if (record?.schemaVersion === NOE_PROPOSAL_DECISION_SCHEMA_VERSION && record?.proposalId) {
        decisions.push({ ...record, ledgerRef: rel(rootAbs, file) });
      }
    } catch {
      errors.push({ ref: rel(rootAbs, file), line: index + 1, error: 'json_parse_failed' });
    }
  });
  return { ok: true, decisions, errors };
}

export function latestNoeProposalDecisionByProposalId(decisions = []) {
  const latest = new Map();
  for (const decision of decisions) {
    const previous = latest.get(decision.proposalId);
    const at = Date.parse(decision.decidedAt || '') || 0;
    const prevAt = Date.parse(previous?.decidedAt || '') || 0;
    if (!previous || at >= prevAt) latest.set(decision.proposalId, decision);
  }
  return latest;
}

export function decorateNoeProposalWithDecision(proposal = {}, latestDecision = null) {
  if (!latestDecision) return proposal;
  return {
    ...proposal,
    sourceStatus: proposal.status,
    status: latestDecision.status || proposal.status,
    ownerDecision: latestDecision,
  };
}
