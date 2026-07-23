import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOE_CONSENSUS_REDACTION_POLICY_SUMMARY } from './NoeConsensusLedger.js';

export const ROUND_SUPPORT_FILES = Object.freeze({
  evidence: 'evidence.md',
  evidencePack: 'evidence-pack.md',
  disagreements: 'disagreements.md',
  stalenessLedger: 'staleness-ledger.md',
  verifierNotes: 'verifier-notes.md',
  finalHandoff: 'final-handoff.md',
});

export function supportFileRefs(roundRelDir) {
  return Object.fromEntries(Object.entries(ROUND_SUPPORT_FILES)
    .map(([key, name]) => [key, join(roundRelDir, name)]));
}

function mdList(items, fallback = '- none') {
  const source = Array.isArray(items) ? items.filter(Boolean) : [];
  return source.length ? source.map((item) => `- ${String(item)}`).join('\n') : fallback;
}

function writeSupportFile(roundDir, name, text) {
  writeFileSync(join(roundDir, name), `${String(text || '').trimEnd()}\n`, { mode: 0o600 });
}

function formatVoteLine(vote) {
  if (!vote) return 'missing vote';
  const blockers = Array.isArray(vote.blockers) && vote.blockers.length
    ? ` blockers=${vote.blockers.length}`
    : '';
  const verify = Array.isArray(vote.verificationRequired) && vote.verificationRequired.length
    ? ` verification=${vote.verificationRequired.length}`
    : '';
  return `${vote.model}: decision=${vote.decision || 'unknown'} vote=${vote.consensusVote || 'blank'} parse=${vote.parseStatus || 'unknown'}${blockers}${verify}`;
}

function classifyDisagreements({ votes = [], parseErrors = [], validation = null }) {
  const issues = [];
  if (parseErrors.length) issues.push(...parseErrors.map((item) => `parse:${item}`));
  for (const vote of votes) {
    if (vote.decision === 'reject') issues.push(`reject:${vote.model}`);
    if (vote.decision === 'abstain') issues.push(`abstain:${vote.model}`);
    if (vote.decision === 'unavailable') issues.push(`unavailable:${vote.model}`);
    if (Array.isArray(vote.blockers) && vote.blockers.length) issues.push(`blockers:${vote.model}:${vote.blockers.length}`);
    if (vote.parseStatus && vote.parseStatus !== 'parsed') issues.push(`unparsed:${vote.model}`);
  }
  for (const error of validation?.errors || []) {
    if (!String(error).startsWith('insufficient_approvals:')) issues.push(`gate:${error}`);
  }
  return issues;
}

function evidenceFreshnessClasses(text) {
  const source = String(text || '').toLowerCase();
  const classes = [];
  if (/(live|runtime|health|readiness|restart|51835|51735)/i.test(source)) classes.push('live_runtime');
  if (/(model health|provider|claude|m3|minimax|codex cli|quota|api)/i.test(source)) classes.push('model_provider');
  if (/(secret|owner-token|owner token|keychain|api key)/i.test(source)) classes.push('secret_boundary');
  if (/(private_holdout|holdout|sealed)/i.test(source)) classes.push('sealed_holdout');
  if (/(patch|write|delete|rollback|restart|kill|apply)/i.test(source)) classes.push('side_effect');
  return [...new Set(classes)];
}

function buildEvidenceMarkdown({ goal, evidenceText, evidenceSha256, createdAt, qualityProfile }) {
  return [
    '# Round Evidence',
    '',
    `- createdAt: ${createdAt}`,
    `- qualityProfile: ${qualityProfile}`,
    `- evidenceSha256: ${evidenceSha256}`,
    `- goal: ${goal}`,
    '',
    '## Evidence Text',
    '',
    evidenceText || 'none',
  ].join('\n');
}

function buildEvidencePackMarkdown({
  goal,
  evidenceRef,
  supportRefs,
  evidenceSha256,
  qualityProfile,
  activeExecutor,
  manifest,
  ledgerRef,
  validation,
  votes = [],
  artifacts = [],
  stageMatrixArtifact,
}) {
  const status = validation ? (validation.ok ? 'consensus_passed' : 'consensus_blocked') : manifest.status;
  const artifactLines = artifacts.map((artifact) => {
    const suffix = artifact?.model ? `:${artifact.model}` : artifact?.type ? `:${artifact.type}` : '';
    return `${artifact?.type || 'artifact'}${suffix}`;
  });
  return [
    '# Round Evidence Pack',
    '',
    `- roundId: ${manifest.roundId}`,
    `- status: ${status}`,
    `- goal: ${goal}`,
    `- qualityProfile: ${qualityProfile}`,
    `- activeExecutor: ${activeExecutor}`,
    `- evidenceRef: ${evidenceRef}`,
    `- evidenceSha256: ${evidenceSha256}`,
    `- ledgerRef: ${ledgerRef || 'not-run'}`,
    `- stageMatrix: ${stageMatrixArtifact ? `ok=${stageMatrixArtifact.ok} complete=${stageMatrixArtifact.requireComplete}` : 'none'}`,
    '',
    '## Support Files',
    mdList(Object.entries(supportRefs).map(([key, ref]) => `${key}: ${ref}`)),
    '',
    '## Redaction Policy',
    mdList(NOE_CONSENSUS_REDACTION_POLICY_SUMMARY),
    '',
    '## Votes',
    mdList(votes.map(formatVoteLine)),
    '',
    '## Artifacts',
    mdList(artifactLines),
    '',
    '## Gate',
    validation
      ? [
        `- ok: ${validation.ok}`,
        `- errors: ${(validation.errors || []).length}`,
        `- warnings: ${(validation.warnings || []).length}`,
        `- approvals: ${validation.consensus?.approvedCount ?? 0}/${validation.consensus?.threshold ?? 'unknown'}`,
      ].join('\n')
      : '- not run',
  ].join('\n');
}

function buildDisagreementsMarkdown({ manifest, votes = [], parseErrors = [], validation = null }) {
  const issues = classifyDisagreements({ votes, parseErrors, validation });
  return [
    '# Round Disagreements',
    '',
    `- roundId: ${manifest.roundId}`,
    `- status: ${issues.length ? 'needs_review' : 'none'}`,
    '',
    '## Issues',
    mdList(issues),
    '',
    '## Vote Summary',
    mdList(votes.map(formatVoteLine)),
    '',
    '## Gate Errors',
    mdList(validation?.errors || []),
  ].join('\n');
}

function buildStalenessLedgerMarkdown({
  manifest,
  evidenceSha256,
  evidenceText,
  stageMatrixArtifact,
  createdAt,
}) {
  const classes = evidenceFreshnessClasses(evidenceText);
  return [
    '# Round Staleness Ledger',
    '',
    `- roundId: ${manifest.roundId}`,
    `- createdAt: ${createdAt}`,
    `- evidenceSha256: ${evidenceSha256}`,
    `- evidenceBinding: reusable only when evidenceSha256 and evidenceRef are unchanged`,
    `- stageMatrixRef: ${stageMatrixArtifact?.matrixRef || 'none'}`,
    '',
    '## Freshness Classes',
    mdList(classes.map((item) => `${item}: re-verify before using as current fact`)),
    '',
    '## Expiry Rules',
    '- live_runtime: 15 minutes or after restart/process change',
    '- model_provider: 30 minutes or after provider/key/model config change',
    '- secret_boundary: current round only; never store raw values',
    '- sealed_holdout: metadata/hash only unless separate raw-read authorization exists',
    '- side_effect: current worktree/runtime state only; rerun after any touched-file or process change',
  ].join('\n');
}

function buildVerifierNotesMarkdown({
  manifest,
  ledgerRef,
  validation,
  parseErrors = [],
  supportRefs,
  stageMatrixArtifact,
}) {
  return [
    '# Round Verifier Notes',
    '',
    `- roundId: ${manifest.roundId}`,
    `- gateValidated: ${validation ? validation.ok : false}`,
    `- ledgerRef: ${ledgerRef || 'not-run'}`,
    `- parseErrors: ${parseErrors.length ? parseErrors.join(', ') : 'none'}`,
    `- stageMatrix: ${stageMatrixArtifact ? `ok=${stageMatrixArtifact.ok} completed=${(stageMatrixArtifact.completed || []).join(',') || 'none'}` : 'none'}`,
    '',
    '## Required Local Verification',
    ledgerRef
      ? `- node scripts/noe-consensus-ledger-verify.mjs --ledger ${ledgerRef} --require-evidence --require-artifacts${validation?.ok ? ' --require-passed' : ''}`
      : '- dry run only; run models before treating this as a gate',
    '',
    '## Direct Evidence Files',
    mdList([
      manifest.evidenceRef,
      supportRefs.evidence,
      supportRefs.evidencePack,
      ledgerRef,
    ].filter(Boolean)),
    '',
    '## Redaction Policy',
    mdList(NOE_CONSENSUS_REDACTION_POLICY_SUMMARY),
    '',
    '## Gate Errors',
    mdList(validation?.errors || []),
  ].join('\n');
}

function buildFinalHandoffMarkdown({
  manifest,
  ledgerRef,
  validation,
  supportRefs,
  evidenceSha256,
  stageMatrixArtifact,
}) {
  return [
    '# Round Final Handoff',
    '',
    `- roundId: ${manifest.roundId}`,
    `- status: ${validation ? (validation.ok ? 'consensus_passed' : 'consensus_blocked') : manifest.status}`,
    `- evidenceSha256: ${evidenceSha256}`,
    `- ledgerRef: ${ledgerRef || 'not-run'}`,
    `- stageMatrixRef: ${stageMatrixArtifact?.matrixRef || 'none'}`,
    '',
    '## Resume Read Order',
    mdList([
      manifest.evidenceRef,
      supportRefs.evidence,
      supportRefs.evidencePack,
      supportRefs.disagreements,
      supportRefs.stalenessLedger,
      supportRefs.verifierNotes,
      ledgerRef,
    ].filter(Boolean)),
    '',
    '## Boundary Reminders',
    '- Treat model/private chat memory as hints only; use these files as the shared fact base.',
    '- Re-run live/runtime/provider probes when staleness-ledger marks a class as expired.',
    '- Do not broaden a passed scoped gate into broader Neo health claims.',
  ].join('\n');
}

export function writeRoundSupportFiles({
  roundDir,
  goal,
  evidenceRef,
  supportRefs,
  evidenceText,
  evidenceSha256,
  createdAt,
  qualityProfile,
  activeExecutor,
  manifest,
  ledgerRef = '',
  validation = null,
  votes = [],
  parseErrors = [],
  artifacts = [],
  stageMatrixArtifact = null,
}) {
  writeSupportFile(roundDir, ROUND_SUPPORT_FILES.evidence, buildEvidenceMarkdown({
    goal,
    evidenceText,
    evidenceSha256,
    createdAt,
    qualityProfile,
  }));
  writeSupportFile(roundDir, ROUND_SUPPORT_FILES.evidencePack, buildEvidencePackMarkdown({
    goal,
    evidenceRef,
    supportRefs,
    evidenceSha256,
    qualityProfile,
    activeExecutor,
    manifest,
    ledgerRef,
    validation,
    votes,
    artifacts,
    stageMatrixArtifact,
  }));
  writeSupportFile(roundDir, ROUND_SUPPORT_FILES.disagreements, buildDisagreementsMarkdown({
    manifest,
    votes,
    parseErrors,
    validation,
  }));
  writeSupportFile(roundDir, ROUND_SUPPORT_FILES.stalenessLedger, buildStalenessLedgerMarkdown({
    manifest,
    evidenceSha256,
    evidenceText,
    stageMatrixArtifact,
    createdAt,
  }));
  writeSupportFile(roundDir, ROUND_SUPPORT_FILES.verifierNotes, buildVerifierNotesMarkdown({
    manifest,
    ledgerRef,
    validation,
    parseErrors,
    supportRefs,
    stageMatrixArtifact,
  }));
  writeSupportFile(roundDir, ROUND_SUPPORT_FILES.finalHandoff, buildFinalHandoffMarkdown({
    manifest,
    ledgerRef,
    validation,
    supportRefs,
    evidenceSha256,
    stageMatrixArtifact,
  }));
}
