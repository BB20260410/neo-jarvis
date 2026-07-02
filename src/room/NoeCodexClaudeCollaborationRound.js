// @ts-check

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

const VALID_ACTORS = new Set(['codex', 'claude']);
const READY_STATUS = 'ready_to_execute';
const DEFAULT_STATUS = 'draft';
const REQUIRED_CLAUDE_MODE_LABEL = 'Claude 4.8 Max';

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value, max = 30_000) {
  return redactSensitiveText(String(value ?? '').replace(/\r\n/g, '\n')).trim().slice(0, max);
}

function sha12(text) {
  return createHash('sha256').update(String(text || '')).digest('hex').slice(0, 12);
}

function safeSegment(value) {
  return cleanText(value, 120).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'codex-claude-round';
}

function hasText(value, min = 12) {
  return cleanText(value, min + 20).length >= min;
}

function normalizeDecision(value) {
  const text = String(value || '').trim().toLowerCase();
  if (['agree', 'approve', 'yes'].includes(text)) return 'agree';
  if (['revise', 'changes', 'needs_changes'].includes(text)) return 'revise';
  if (['reject', 'no', 'block'].includes(text)) return 'reject';
  return text || 'revise';
}

function normalizeWorkList(value) {
  if (Array.isArray(value)) return value.map((item) => cleanText(item, 800)).filter(Boolean);
  const text = cleanText(value, 4000);
  return text ? text.split('\n').map((line) => cleanText(line.replace(/^[-*\d.]+\s*/, ''), 800)).filter(Boolean) : [];
}

function normalizeActorList(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[, ]+/);
  const actors = raw.map((item) => String(item || '').trim().toLowerCase()).filter((item) => VALID_ACTORS.has(item));
  return actors.length ? [...new Set(actors)] : ['codex', 'claude'];
}

function normalizeSharedEvidence(value) {
  const items = Array.isArray(value)
    ? value
    : cleanText(value, 10_000).split('\n').map((line) => line.trim()).filter(Boolean);
  return items.map((item) => {
    const object = item && typeof item === 'object' ? item : { ref: item };
    const readBy = object.readBy || {};
    const readByList = Array.isArray(readBy) ? normalizeActorList(readBy) : [];
    return {
      ref: cleanText(object.ref || object.path || object.id || '', 600),
      kind: cleanText(object.kind || 'file', 80),
      hash: cleanText(object.hash || '', 120),
      requiredFor: normalizeActorList(object.requiredFor),
      readBy: {
        codex: Boolean(object.codexRead ?? readBy.codex ?? readByList.includes('codex')),
        claude: Boolean(object.claudeRead ?? readBy.claude ?? readByList.includes('claude')),
      },
      notes: cleanText(object.notes || object.note || '', 1200),
    };
  }).filter((item) => item.ref);
}

function normalizeChallengeDecision(value) {
  const text = String(value || '').trim().toLowerCase();
  if (['confirmed', 'confirm', 'accepted', 'true'].includes(text)) return 'confirmed';
  if (['refuted', 'refute', 'rejected', 'false'].includes(text)) return 'refuted';
  return 'unresolved';
}

function normalizeChallengeLog(value) {
  const items = Array.isArray(value) ? value : [];
  return items.map((item) => {
    const object = item && typeof item === 'object' ? item : { claim: item };
    return {
      claim: cleanText(object.claim || '', 1200),
      by: VALID_ACTORS.has(String(object.by || '').toLowerCase()) ? String(object.by).toLowerCase() : '',
      reviewedBy: VALID_ACTORS.has(String(object.reviewedBy || '').toLowerCase()) ? String(object.reviewedBy).toLowerCase() : '',
      decision: normalizeChallengeDecision(object.decision),
      evidenceRef: cleanText(object.evidenceRef || object.evidence || '', 600),
      note: cleanText(object.note || object.rationale || '', 1200),
    };
  }).filter((item) => item.claim);
}

function normalizeEvidenceReadList(value) {
  const items = Array.isArray(value) ? value : [];
  return items.map((item) => {
    const object = item && typeof item === 'object' ? item : { ref: item };
    const mode = String(object.mode || object.status || 'summary-only').trim().toLowerCase();
    return {
      ref: cleanText(object.ref || object.path || object.id || '', 600),
      mode: ['direct-read', 'truncated', 'summary-only'].includes(mode) ? mode : 'summary-only',
      note: cleanText(object.note || object.raw || '', 1000),
    };
  }).filter((item) => item.ref);
}

function normalizeAgentReports(value = {}) {
  const object = value && typeof value === 'object' ? value : {};
  const claude = object.claude && typeof object.claude === 'object' ? object.claude : {};
  return {
    claude: {
      reportRef: cleanText(claude.reportRef || claude.path || claude.reportPath || '', 800),
      sessionId: cleanText(claude.sessionId || '', 160),
      generatedAt: cleanText(claude.generatedAt || '', 80),
      requiredMode: cleanText(claude.requiredMode || '', 80),
      requestedModel: cleanText(claude.requestedModel || claude.model || '', 160),
      requestedEffort: cleanText(claude.requestedEffort || claude.effort || '', 80).toLowerCase(),
      evidenceRead: normalizeEvidenceReadList(claude.evidenceRead),
    },
  };
}

function isClaude48Model(value) {
  return /(?:^|[^0-9])4[._-]?8(?:[^0-9]|$)/i.test(String(value || ''));
}

function normalizeReadinessCriteria(value = {}) {
  const object = value && typeof value === 'object' ? value : {};
  return {
    sharedEvidenceReadByBoth: Boolean(object.sharedEvidenceReadByBoth),
    risksAddressed: Boolean(object.risksAddressed),
    verificationPlan: Boolean(object.verificationPlan),
    rollbackPlan: Boolean(object.rollbackPlan),
    rollbackNotApplicable: Boolean(object.rollbackNotApplicable),
    singleWriter: object.singleWriter !== false,
    noSecretLeak: object.noSecretLeak !== false,
    costAcknowledged: Boolean(object.costAcknowledged),
    costNotApplicable: Boolean(object.costNotApplicable),
    notes: cleanText(object.notes || '', 1600),
  };
}

function evidenceReadByRequiredActors(evidence) {
  return evidence.requiredFor.every((actor) => evidence.readBy?.[actor]);
}

function evidenceReadByBoth(sharedEvidence) {
  return sharedEvidence.length > 0 && sharedEvidence.every(evidenceReadByRequiredActors);
}

function verifyEvidenceFileHashes(sharedEvidence, { rootDir = process.cwd() } = {}) {
  const root = resolve(rootDir);
  const warnings = [];
  for (const evidence of sharedEvidence) {
    const declared = String(evidence.hash || '').replace(/^sha256:/i, '').trim().toLowerCase();
    if (evidence.kind !== 'file' || !declared) continue;
    const file = resolve(root, evidence.ref);
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      warnings.push(`evidence_hash_unchecked:${evidence.ref}`);
      continue;
    }
    const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (declared !== actual && declared !== actual.slice(0, declared.length)) warnings.push(`evidence_hash_mismatch:${evidence.ref}`);
  }
  return warnings;
}

export function createCodexClaudeCollaborationRound({
  roundId = '',
  task,
  sharedEvidence = [],
  codexPlan = '',
  claudePlan = '',
  codexReviewOfClaude = '',
  claudeReviewOfCodex = '',
  synthesis = '',
  challengeLog = [],
  agentReports = {},
  readinessCriteria = {},
  activeExecutor = 'codex',
  codexAgreement = 'revise',
  claudeAgreement = 'revise',
  codexAgreementRationale = '',
  claudeAgreementRationale = '',
  codexWork = [],
  claudeWork = [],
  mergeOwner = '',
  status = DEFAULT_STATUS,
  iteration = 1,
} = {}) {
  const executor = VALID_ACTORS.has(String(activeExecutor).toLowerCase()) ? String(activeExecutor).toLowerCase() : 'codex';
  const id = roundId || `${new Date().toISOString().replace(/[:.]/g, '-')}-${sha12(task)}-${randomUUID().slice(0, 8)}`;
  const normalizedSharedEvidence = normalizeSharedEvidence(sharedEvidence);
  return {
    schema: 'noe.codex_claude_collaboration_round.v2',
    id: safeSegment(id),
    generatedAt: nowIso(),
    task: cleanText(task, 12_000),
    status: cleanText(status, 80) || DEFAULT_STATUS,
    iteration: Math.max(1, Number(iteration) || 1),
    boundaries: {
      singleWriterRequired: true,
      activeExecutor: executor,
      mergeOwner: VALID_ACTORS.has(String(mergeOwner || '').toLowerCase()) ? String(mergeOwner).toLowerCase() : executor,
      codexRole: executor === 'codex' ? 'writer_integrator' : 'reviewer',
      claudeRole: executor === 'claude' ? 'writer_integrator' : 'development_partner_reviewer',
      noSecretsInPromptsOrArtifacts: true,
      untouchedPorts: ['51735'],
      live51835RequiresExplicitPermission: true,
      excludedPaths: ['games/cartoon-apocalypse/**'],
    },
    sharedEvidence: normalizedSharedEvidence,
    independentPlans: {
      codex: cleanText(codexPlan),
      claude: cleanText(claudePlan),
    },
    crossReview: {
      codexReviewOfClaude: cleanText(codexReviewOfClaude),
      claudeReviewOfCodex: cleanText(claudeReviewOfCodex),
    },
    challengeLog: normalizeChallengeLog(challengeLog),
    agentReports: normalizeAgentReports(agentReports),
    synthesis: cleanText(synthesis),
    agreements: {
      codex: {
        decision: normalizeDecision(codexAgreement),
        rationale: cleanText(codexAgreementRationale, 4000),
      },
      claude: {
        decision: normalizeDecision(claudeAgreement),
        rationale: cleanText(claudeAgreementRationale, 4000),
      },
    },
    divisionOfLabor: {
      codex: normalizeWorkList(codexWork),
      claude: normalizeWorkList(claudeWork),
    },
    readinessCriteria: {
      ...normalizeReadinessCriteria(readinessCriteria),
      sharedEvidenceReadByBoth: normalizeReadinessCriteria(readinessCriteria).sharedEvidenceReadByBoth || evidenceReadByBoth(normalizedSharedEvidence),
    },
  };
}

export function validateCodexClaudeCollaborationRound(round = {}, { rootDir = process.cwd() } = {}) {
  const blockers = [];
  const warnings = [];
  const task = cleanText(round.task, 12_000);
  const status = cleanText(round.status, 80) || DEFAULT_STATUS;
  const activeExecutor = round.boundaries?.activeExecutor || 'codex';
  const mergeOwner = round.boundaries?.mergeOwner || activeExecutor;
  const codexDecision = normalizeDecision(round.agreements?.codex?.decision);
  const claudeDecision = normalizeDecision(round.agreements?.claude?.decision);
  const codexWork = normalizeWorkList(round.divisionOfLabor?.codex);
  const claudeWork = normalizeWorkList(round.divisionOfLabor?.claude);
  const sharedEvidence = normalizeSharedEvidence(round.sharedEvidence);
  const challengeLog = normalizeChallengeLog(round.challengeLog);
  const agentReports = normalizeAgentReports(round.agentReports);
  const readinessCriteria = normalizeReadinessCriteria(round.readinessCriteria);
  const sharedEvidenceSatisfied = readinessCriteria.sharedEvidenceReadByBoth || evidenceReadByBoth(sharedEvidence);
  const claudeDirectEvidenceRefs = new Set(
    agentReports.claude.evidenceRead
      .filter((item) => item.mode === 'direct-read' || item.mode === 'truncated')
      .map((item) => item.ref)
  );

  if (!task) blockers.push('missing_task');
  if (!hasText(round.independentPlans?.codex)) blockers.push('missing_independent_codex_plan');
  if (!hasText(round.independentPlans?.claude)) blockers.push('missing_independent_claude_plan');
  if (!hasText(round.crossReview?.codexReviewOfClaude)) blockers.push('missing_codex_review_of_claude');
  if (!hasText(round.crossReview?.claudeReviewOfCodex)) blockers.push('missing_claude_review_of_codex');
  if (!hasText(round.synthesis)) blockers.push('missing_synthesis');
  if (!VALID_ACTORS.has(activeExecutor)) blockers.push('invalid_active_executor');
  if (!VALID_ACTORS.has(mergeOwner)) blockers.push('invalid_merge_owner');
  if (activeExecutor !== mergeOwner) warnings.push('merge_owner_differs_from_active_executor');
  warnings.push(...verifyEvidenceFileHashes(sharedEvidence, { rootDir }));

  if (status === READY_STATUS) {
    if (codexDecision !== 'agree') blockers.push('codex_not_agreed');
    if (claudeDecision !== 'agree') blockers.push('claude_not_agreed');
    if (!hasText(round.agreements?.codex?.rationale, 50)) blockers.push('codex_agreement_rationale_too_thin');
    if (!hasText(round.agreements?.claude?.rationale, 50)) blockers.push('claude_agreement_rationale_too_thin');
    if (!codexWork.length && !claudeWork.length) blockers.push('missing_division_of_labor');
    if (!agentReports.claude.reportRef) blockers.push('missing_claude_report_ref');
    if (!hasText(agentReports.claude.sessionId, 8)) blockers.push('missing_claude_session_id');
    if (!hasText(agentReports.claude.generatedAt, 10)) blockers.push('missing_claude_report_generated_at');
    if (agentReports.claude.requiredMode !== REQUIRED_CLAUDE_MODE_LABEL) blockers.push('claude_report_not_4_8_max_mode');
    if (!isClaude48Model(agentReports.claude.requestedModel)) blockers.push('claude_report_not_4_8_model');
    if (agentReports.claude.requestedEffort !== 'max') blockers.push('claude_report_not_max_effort');
    if (!sharedEvidence.length) blockers.push('missing_shared_evidence');
    for (const evidence of sharedEvidence) {
      for (const actor of evidence.requiredFor) {
        if (!evidence.readBy?.[actor]) blockers.push(`shared_evidence_not_read:${actor}:${evidence.ref}`);
      }
      if (evidence.requiredFor.includes('claude') && evidence.readBy?.claude && !claudeDirectEvidenceRefs.has(evidence.ref)) {
        blockers.push(`claude_report_missing_evidence_read:${evidence.ref}`);
      }
    }
    for (const challenge of challengeLog) {
      if (challenge.decision === 'unresolved') blockers.push(`unresolved_challenge:${challenge.claim}`);
      if (challenge.decision !== 'unresolved') {
        if (!challenge.by || !challenge.reviewedBy) blockers.push(`challenge_missing_reviewer:${challenge.claim}`);
        if (challenge.by && challenge.by === challenge.reviewedBy) blockers.push(`challenge_self_review:${challenge.claim}`);
        if (!challenge.evidenceRef) blockers.push(`challenge_missing_evidence_ref:${challenge.claim}`);
      }
    }
    if (!sharedEvidenceSatisfied) blockers.push('readiness_criteria_missing:sharedEvidenceReadByBoth');
    if (!readinessCriteria.risksAddressed) blockers.push('readiness_criteria_missing:risksAddressed');
    if (!readinessCriteria.verificationPlan) blockers.push('readiness_criteria_missing:verificationPlan');
    if (!readinessCriteria.rollbackPlan && !readinessCriteria.rollbackNotApplicable) blockers.push('readiness_criteria_missing:rollbackPlan');
    if (!readinessCriteria.singleWriter) blockers.push('readiness_criteria_missing:singleWriter');
    if (!readinessCriteria.noSecretLeak) blockers.push('readiness_criteria_missing:noSecretLeak');
    if (!readinessCriteria.costAcknowledged && !readinessCriteria.costNotApplicable) warnings.push('cost_acknowledgement_missing');
  } else {
    if (codexDecision !== 'agree' || claudeDecision !== 'agree') warnings.push('round_not_ready_until_both_agree');
  }

  const readyToExecute = blockers.length === 0 && status === READY_STATUS && codexDecision === 'agree' && claudeDecision === 'agree';
  const nextAction = readyToExecute ? 'execute' : (codexDecision === 'reject' || claudeDecision === 'reject' ? 'blocked' : (blockers.length ? 'blocked' : 'revise'));

  return {
    ok: blockers.length === 0,
    readyToExecute,
    nextAction,
    blockers,
    warnings,
    activeExecutor,
    codexDecision,
    claudeDecision,
    sharedEvidenceReadByBoth: sharedEvidenceSatisfied,
    unresolvedChallenges: challengeLog.filter((challenge) => challenge.decision === 'unresolved').length,
    claudeEvidenceReadCount: agentReports.claude.evidenceRead.length,
  };
}

export function buildCodexClaudeProtocolChecklist({ task = '' } = {}) {
  const cleanTask = cleanText(task, 8000);
  return [
    '# Codex + Claude Collaboration Protocol',
    '',
    '## Task',
    '',
    cleanTask || '<task>',
    '',
    '## Required Flow',
    '',
    '1. Codex builds a shared evidence pack: real files, commands, live outputs, and known constraints.',
    '2. Codex and Claude both read the shared evidence directly where possible; Claude must not rely only on a Codex summary.',
    '3. Codex writes an independent plan.',
    '4. Claude writes an independent plan using its persistent collaborator session.',
    '5. Codex reviews Claude plan: strengths, risks, missing verification, what to adopt.',
    '6. Claude reviews Codex plan: strengths, risks, missing verification, what to adopt.',
    '7. Any disputed factual claim enters challengeLog and must be confirmed or refuted with evidence before execution.',
    '8. Codex synthesizes one merged plan and explicitly lists accepted changes from both sides.',
    '9. Claude reviews the synthesis and either agrees or requests another iteration.',
    '10. Codex agrees only after the synthesis is implementable, testable, and rollback-aware.',
    '11. Claude plan/review/agreement must trace to a Claude collaborator report with sessionId, generatedAt, and evidence_read refs.',
    '12. Execution starts only when both decisions are agree, shared evidence was read by both required agents, Claude report evidence_read matches required refs, challengeLog has no unresolved or self-reviewed claims, readinessCriteria pass, and the round validates ready_to_execute.',
    '',
    '## Execution Rule',
    '',
    '分工可以存在，但同一轮只有一个 writer/integrator。默认 Codex 写，Claude 审查和研究；如果 owner 明确选择 Claude 为 activeExecutor，则 Claude 是唯一 writer，Codex 转 reviewer。',
  ].join('\n');
}

export function writeCodexClaudeCollaborationRound({ rootDir = process.cwd(), outDir = 'output/noe-codex-claude-collaboration', round }) {
  const root = resolve(rootDir);
  const dir = resolve(root, outDir, safeSegment(round.id || 'round'));
  mkdirSync(dir, { recursive: true });
  const validation = validateCodexClaudeCollaborationRound(round, { rootDir: root });
  const jsonPath = join(dir, 'round.json');
  const mdPath = join(dir, 'round.md');
  const payload = {
    ...round,
    validation,
  };
  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mdPath, renderCodexClaudeRoundMarkdown(payload), { mode: 0o600 });
  return {
    ok: validation.ok,
    readyToExecute: validation.readyToExecute,
    blockers: validation.blockers,
    warnings: validation.warnings,
    roundRef: relative(root, jsonPath),
    markdownRef: relative(root, mdPath),
  };
}

export function renderCodexClaudeRoundMarkdown(round = {}) {
  const validation = round.validation || validateCodexClaudeCollaborationRound(round);
  return [
    '# Codex + Claude Collaboration Round',
    '',
    `- id: ${round.id || ''}`,
    `- status: ${round.status || DEFAULT_STATUS}`,
    `- activeExecutor: ${round.boundaries?.activeExecutor || 'codex'}`,
    `- readyToExecute: ${validation.readyToExecute}`,
    `- nextAction: ${validation.nextAction}`,
    `- sharedEvidenceReadByBoth: ${validation.sharedEvidenceReadByBoth}`,
    `- unresolvedChallenges: ${validation.unresolvedChallenges}`,
    `- claudeEvidenceReadCount: ${validation.claudeEvidenceReadCount}`,
    `- blockers: ${validation.blockers.join(', ') || 'none'}`,
    `- warnings: ${validation.warnings.join(', ') || 'none'}`,
    '',
    '## Task',
    '',
    cleanText(round.task, 12_000),
    '',
    '## Shared Evidence',
    '',
    ...normalizeSharedEvidence(round.sharedEvidence).map((item) => `- ${item.ref} (${item.kind}${item.hash ? `, ${item.hash}` : ''}) requiredFor=${item.requiredFor.join('+')} readBy=${Object.entries(item.readBy).filter(([, read]) => read).map(([actor]) => actor).join('+') || 'none'}${item.notes ? ` - ${item.notes}` : ''}`),
    '',
    '## Codex Independent Plan',
    '',
    cleanText(round.independentPlans?.codex),
    '',
    '## Claude Independent Plan',
    '',
    cleanText(round.independentPlans?.claude),
    '',
    '## Codex Review Of Claude',
    '',
    cleanText(round.crossReview?.codexReviewOfClaude),
    '',
    '## Claude Review Of Codex',
    '',
    cleanText(round.crossReview?.claudeReviewOfCodex),
    '',
    '## Challenge Log',
    '',
    ...normalizeChallengeLog(round.challengeLog).map((item) => `- ${item.decision}: ${item.claim}${item.evidenceRef ? ` [${item.evidenceRef}]` : ''}${item.note ? ` - ${item.note}` : ''}`),
    '',
    '## Agent Reports',
    '',
    `- Claude report: ${normalizeAgentReports(round.agentReports).claude.reportRef || 'none'}`,
    `- Claude sessionId: ${normalizeAgentReports(round.agentReports).claude.sessionId || 'none'}`,
    `- Claude generatedAt: ${normalizeAgentReports(round.agentReports).claude.generatedAt || 'none'}`,
    `- Claude requiredMode: ${normalizeAgentReports(round.agentReports).claude.requiredMode || 'none'}`,
    `- Claude requestedModel: ${normalizeAgentReports(round.agentReports).claude.requestedModel || 'none'}`,
    `- Claude requestedEffort: ${normalizeAgentReports(round.agentReports).claude.requestedEffort || 'none'}`,
    ...normalizeAgentReports(round.agentReports).claude.evidenceRead.map((item) => `- Claude evidence_read: ${item.ref} (${item.mode})`),
    '',
    '## Synthesis',
    '',
    cleanText(round.synthesis),
    '',
    '## Agreements',
    '',
    `- Codex: ${round.agreements?.codex?.decision || ''} - ${cleanText(round.agreements?.codex?.rationale, 1000)}`,
    `- Claude: ${round.agreements?.claude?.decision || ''} - ${cleanText(round.agreements?.claude?.rationale, 1000)}`,
    '',
    '## Division Of Labor',
    '',
    '- Codex:',
    ...normalizeWorkList(round.divisionOfLabor?.codex).map((item) => `  - ${item}`),
    '- Claude:',
    ...normalizeWorkList(round.divisionOfLabor?.claude).map((item) => `  - ${item}`),
    '',
    '## Readiness Criteria',
    '',
    ...Object.entries(normalizeReadinessCriteria(round.readinessCriteria)).map(([key, value]) => `- ${key}: ${value}`),
    '',
  ].join('\n');
}
