#!/usr/bin/env node
// @ts-check
// Read-only post-hint judgement audit.
// It inspects sanitized expectation-calibration metadata only; it never reads the live DB, .env, owner token, raw claims, evidence bodies, or model replies.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.NOE_POST_HINT_JUDGEMENT_AUDIT_OUT_DIR || join(ROOT, 'output', 'noe-audit');
const OUT_BASE = process.env.NOE_POST_HINT_JUDGEMENT_AUDIT_BASENAME || 'post-hint-judgement-audit-2026-06-15';
const COVERAGE_TARGET = 0.25;

const DEFAULT_PATHS = {
  calibrationLatest: join(ROOT, 'output', 'noe-expectation-calibration', 'latest.json'),
  expectationJudgeBlockerAudit: join(ROOT, 'output', 'noe-audit', 'expectation-judge-blocker-audit-2026-06-15.json'),
};

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function nullableNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
}

function readJson(path) {
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function rel(path, root = ROOT) {
  return String(path || '').replace(`${root}/`, '');
}

function clean(value = '', max = 500) {
  return String(value ?? '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [key]')
    .replace(/token[=:]\S+/gi, 'token=[redacted]')
    .replace(/(?:api[_-]?key|secret|password)[=:]\S+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function safeTag(value = '', max = 120) {
  return clean(value, max)
    .replace(/[^\p{Letter}\p{Number}_.:-]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max);
}

function pathSummary(paths = {}) {
  return Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, rel(path)]));
}

function compactCountMap(map, keyName, limit = 12) {
  return [...map.entries()]
    .map(([key, count]) => ({ [keyName]: safeTag(key, 120), count: num(count) }))
    .filter((item) => item[keyName] && item.count > 0)
    .sort((a, b) => b.count - a.count || String(a[keyName]).localeCompare(String(b[keyName])))
    .slice(0, limit);
}

function increment(map, key, by = 1) {
  const safe = safeTag(key || 'unknown');
  if (!safe) return;
  map.set(safe, (map.get(safe) || 0) + by);
}

function firstCountValue(rows = [], keyName) {
  return arr(rows)
    .map((item) => safeTag(item?.[keyName] || '', 120))
    .filter(Boolean);
}

function hasGap(entry, gap) {
  return arr(entry?.evidenceGaps).some((item) => safeTag(item?.gap || '') === gap);
}

function latestAlignment(entry = {}) {
  return entry.latestEvidenceClaimAlignment && typeof entry.latestEvidenceClaimAlignment === 'object'
    ? entry.latestEvidenceClaimAlignment
    : {};
}

function latestDecision(entry = {}) {
  return entry.latestEvidenceDecision && typeof entry.latestEvidenceDecision === 'object'
    ? entry.latestEvidenceDecision
    : {};
}

function latestHint(entry = {}) {
  return entry.latestEvidenceDecisionHint && typeof entry.latestEvidenceDecisionHint === 'object'
    ? entry.latestEvidenceDecisionHint
    : {};
}

function classifyEntry(entry = {}) {
  const decision = latestDecision(entry);
  const hint = latestHint(entry);
  const alignment = latestAlignment(entry);
  const decisionLabel = safeTag(decision.label || '');
  const hintLabel = safeTag(hint.label || '');
  const suggestedVerdict = safeTag(hint.suggestedVerdict || '');
  const reasonCodes = firstCountValue(entry.verdictReasonCodes, 'reasonCode');
  const actionSuccess = decisionLabel === 'action_success_signal'
    || hintLabel === 'action_success_signal'
    || suggestedVerdict === 'APPLIED';
  const actionFailure = decisionLabel === 'action_failure_signal'
    || hintLabel === 'action_failure_signal'
    || suggestedVerdict === 'FAILED';
  const semanticTraceCoverage = nullableNum(alignment.semanticTraceMaxCoverage) ?? 0;
  const semanticCoverage = nullableNum(alignment.semanticActionMaxCoverage) ?? 0;
  const actionCoverage = nullableNum(alignment.actionMaxCoverage) ?? 0;
  const semanticTraceResultActionEvents = num(alignment.semanticTraceResultActionEvents);
  const resultActionEvents = num(alignment.resultActionEvents);
  if (hasGap(entry, 'no_evidence') || hasGap(entry, 'missing_evidence_summary')) {
    return 'missing_evidence';
  }
  if (hasGap(entry, 'observation_only_unknown')) {
    return 'observation_only_correct_unknown';
  }
  if (hasGap(entry, 'judge_reports_claim_mismatch_with_trace_success')) {
    return 'judge_claim_mismatch_after_trace_success';
  }
  if (hasGap(entry, 'claim_action_semantic_trace_mixed_linkage')) {
    return 'mixed_semantic_trace_linkage';
  }
  if (semanticTraceResultActionEvents > 0 && semanticTraceCoverage < COVERAGE_TARGET) {
    return 'semantic_trace_coverage_low';
  }
  if ((actionSuccess || actionFailure) && resultActionEvents > 0 && semanticTraceResultActionEvents <= 0) {
    return 'historical_action_evidence_lacks_semantic_trace';
  }
  if ((actionSuccess || actionFailure) && Math.max(semanticCoverage, actionCoverage) < COVERAGE_TARGET) {
    return 'claim_action_semantic_alignment_weak';
  }
  if ((actionSuccess || actionFailure) && Math.max(semanticTraceCoverage, semanticCoverage, actionCoverage) >= COVERAGE_TARGET) {
    return reasonCodes.some((code) => code.startsWith('claim_mismatch'))
      ? 'judge_claim_mismatch_after_direct_evidence'
      : 'judge_contract_too_conservative';
  }
  if (hasGap(entry, 'thin_matched_evidence')) return 'thin_matched_evidence';
  return 'other_unknown';
}

function compactEntry(entry = {}) {
  const decision = latestDecision(entry);
  const hint = latestHint(entry);
  const alignment = latestAlignment(entry);
  const summary = entry.latestEvidenceSummary && typeof entry.latestEvidenceSummary === 'object'
    ? entry.latestEvidenceSummary
    : {};
  return {
    id: num(entry.id),
    total: num(entry.total),
    unresolved: num(entry.unresolved),
    resolved: num(entry.resolved),
    category: classifyEntry(entry),
    reasonCodes: firstCountValue(entry.verdictReasonCodes, 'reasonCode').slice(0, 4),
    hintAgreements: firstCountValue(entry.hintAgreements, 'hintAgreement').slice(0, 4),
    gaps: firstCountValue(entry.evidenceGaps, 'gap').slice(0, 6),
    decisionLabel: safeTag(decision.label || ''),
    hintLabel: safeTag(hint.label || ''),
    suggestedVerdict: safeTag(hint.suggestedVerdict || ''),
    profileSource: safeTag(hint.profileSource || ''),
    matched: num(summary.matched),
    actionKinds: num(decision.profile?.actionKinds),
    observationKinds: num(decision.profile?.observationKinds),
    actionResultSignals: num(decision.profile?.actionResultSignals),
    observationSignals: num(decision.profile?.observationSignals),
    successSignals: num(decision.profile?.successSignals),
    claimGrams: num(alignment.claimGrams),
    resultActionEvents: num(alignment.resultActionEvents),
    semanticResultActionEvents: num(alignment.semanticResultActionEvents),
    semanticTraceResultActionEvents: num(alignment.semanticTraceResultActionEvents),
    actionMaxCoverage: nullableNum(alignment.actionMaxCoverage),
    semanticActionMaxCoverage: nullableNum(alignment.semanticActionMaxCoverage),
    semanticTraceMaxCoverage: nullableNum(alignment.semanticTraceMaxCoverage),
    replyChars: num(entry.latestReplyStats?.chars),
    replyLines: num(entry.latestReplyStats?.lines),
  };
}

function summarizeEntries(entries = []) {
  const categoryCounts = new Map();
  const gapCounts = new Map();
  const reasonCodeCounts = new Map();
  const hintAgreementCounts = new Map();
  const decisionLabelCounts = new Map();
  const hintLabelCounts = new Map();
  let actionSuccessUnknown = 0;
  let observationOnlyUnknown = 0;
  let directEvidenceUnknown = 0;
  let staleActionHintOnObservationOnly = 0;
  let repeatedUnresolved = 0;
  let semanticTraceCoverageMax = 0;
  let semanticCoverageMax = 0;
  const compact = [];
  for (const entry of arr(entries)) {
    if (!entry || typeof entry !== 'object') continue;
    const item = compactEntry(entry);
    if (!item.id) continue;
    compact.push(item);
    increment(categoryCounts, item.category);
    if (item.decisionLabel) increment(decisionLabelCounts, item.decisionLabel);
    if (item.hintLabel) increment(hintLabelCounts, item.hintLabel);
    for (const gap of item.gaps) increment(gapCounts, gap);
    for (const reasonCode of item.reasonCodes) increment(reasonCodeCounts, reasonCode);
    for (const agreement of item.hintAgreements) increment(hintAgreementCounts, agreement);
    if (item.unresolved >= 2) repeatedUnresolved += 1;
    const hasActionSuccessHint = item.decisionLabel === 'action_success_signal'
      || item.hintLabel === 'action_success_signal'
      || item.suggestedVerdict === 'APPLIED';
    if (item.category === 'observation_only_correct_unknown'
      && (item.hintLabel === 'action_success_signal' || item.suggestedVerdict === 'APPLIED')) {
      staleActionHintOnObservationOnly += item.unresolved > 0 ? 1 : 0;
    }
    if (hasActionSuccessHint && item.category !== 'observation_only_correct_unknown') {
      actionSuccessUnknown += item.unresolved > 0 ? 1 : 0;
    }
    if (item.category === 'observation_only_correct_unknown') observationOnlyUnknown += item.unresolved > 0 ? 1 : 0;
    if (['judge_contract_too_conservative', 'judge_claim_mismatch_after_direct_evidence', 'judge_claim_mismatch_after_trace_success'].includes(item.category)) {
      directEvidenceUnknown += item.unresolved > 0 ? 1 : 0;
    }
    semanticTraceCoverageMax = Math.max(semanticTraceCoverageMax, num(item.semanticTraceMaxCoverage));
    semanticCoverageMax = Math.max(semanticCoverageMax, num(item.semanticActionMaxCoverage));
  }
  return {
    uniqueJudgements: compact.length,
    unresolvedUniqueJudgements: compact.filter((item) => item.unresolved > 0).length,
    repeatedUnresolved,
    actionSuccessUnknown,
    observationOnlyUnknown,
    directEvidenceUnknown,
    staleActionHintOnObservationOnly,
    semanticTraceCoverageMax: nullableNum(semanticTraceCoverageMax),
    semanticCoverageMax: nullableNum(semanticCoverageMax),
    categoryCounts: compactCountMap(categoryCounts, 'category'),
    gapCounts: compactCountMap(gapCounts, 'gap'),
    reasonCodeCounts: compactCountMap(reasonCodeCounts, 'reasonCode'),
    hintAgreementCounts: compactCountMap(hintAgreementCounts, 'hintAgreement'),
    decisionLabelCounts: compactCountMap(decisionLabelCounts, 'label'),
    hintLabelCounts: compactCountMap(hintLabelCounts, 'label'),
    samples: compact
      .sort((a, b) => b.unresolved - a.unresolved || a.category.localeCompare(b.category) || a.id - b.id)
      .slice(0, 12),
  };
}

function buildStatus({ summary, codeMitigations }) {
  const actionPayloadTraceReady = codeMitigations?.actionEvidenceActPayloadSemanticTrace?.status === 'code_ready_live_pending_restart_or_new_actions';
  const categoryIds = new Set(arr(summary.categoryCounts).map((item) => item.category));
  if (!summary.uniqueJudgements) return 'no_post_hint_metadata';
  if (categoryIds.has('historical_action_evidence_lacks_semantic_trace') && actionPayloadTraceReady) {
    return 'code_mitigated_live_pending_new_evidence';
  }
  if (categoryIds.has('judge_contract_too_conservative') || categoryIds.has('judge_claim_mismatch_after_direct_evidence')) {
    return 'direct_evidence_judge_contract_needs_review';
  }
  if (summary.actionSuccessUnknown > 0) return 'action_success_unknown_needs_alignment_repair';
  if (summary.observationOnlyUnknown > 0) return 'observation_only_unknown_expected';
  return 'needs_more_post_hint_samples';
}

function buildNextActions({ status, summary, codeMitigations }) {
  const actionPayloadTraceReady = codeMitigations?.actionEvidenceActPayloadSemanticTrace?.status === 'code_ready_live_pending_restart_or_new_actions';
  const actions = [];
  if (actionPayloadTraceReady && status === 'code_mitigated_live_pending_new_evidence') {
    actions.push({
      priority: 'P0',
      action: 'restart_or_wait_for_new_action_evidence_then_rerun_calibration',
      ownerDecision: true,
      reason: 'post-hint metadata shows historical action success UNKNOWN lacks semanticTrace; code now preserves act.payload semantics but live needs new evidence.',
    });
  }
  if (summary.actionSuccessUnknown > 0) {
    actions.push({
      priority: 'P0',
      action: 'do_not_loosen_judge_until_direct_coverage_reaches_gate',
      ownerDecision: false,
      reason: `actionSuccessUnknown=${summary.actionSuccessUnknown}, semanticTraceCoverageMax=${summary.semanticTraceCoverageMax ?? '-'}`,
    });
  }
  if (summary.observationOnlyUnknown > 0) {
    actions.push({
      priority: 'P1',
      action: 'keep_observation_only_unknown_and_collect_action_or_external_result',
      ownerDecision: false,
      reason: `observationOnlyUnknown=${summary.observationOnlyUnknown}; these should not become APPLIED/FAILED without action or external result evidence.`,
    });
  }
  if (summary.staleActionHintOnObservationOnly > 0) {
    actions.push({
      priority: 'P1',
      action: 'ignore_stale_compact_action_hints_on_observation_only_rows',
      ownerDecision: false,
      reason: `staleActionHintOnObservationOnly=${summary.staleActionHintOnObservationOnly}; refreshed safe metadata has no action event.`,
    });
  }
  if (summary.directEvidenceUnknown > 0) {
    actions.push({
      priority: 'P0',
      action: 'review_judge_prompt_contract_for_direct_evidence_unknowns',
      ownerDecision: false,
      reason: `directEvidenceUnknown=${summary.directEvidenceUnknown}; safe metadata already meets direct-evidence threshold.`,
    });
  }
  if (!actions.length) {
    actions.push({
      priority: 'P1',
      action: 'collect_more_natural_post_hint_samples',
      ownerDecision: false,
      reason: 'current sanitized metadata is insufficient to change judge behavior safely.',
    });
  }
  return actions;
}

export function buildPostHintJudgementAudit({
  root = ROOT,
  paths = DEFAULT_PATHS,
  now = new Date(),
} = {}) {
  const resolvedPaths = { ...DEFAULT_PATHS, ...paths };
  const calibration = readJson(resolvedPaths.calibrationLatest) || {};
  const blockerAudit = readJson(resolvedPaths.expectationJudgeBlockerAudit) || {};
  const recent = calibration.recentAutoJudgements || {};
  const summary = summarizeEntries(recent.judgementIdCounts || []);
  const codeMitigations = blockerAudit.codeMitigations || {};
  const status = buildStatus({ summary, codeMitigations });
  return {
    ok: true,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    root,
    status,
    policy: {
      readOnlyAudit: true,
      readsSanitizedCalibrationOnly: true,
      noDbReads: true,
      noDbWrites: true,
      noEnvFileReads: true,
      noOwnerTokenReads: true,
      noLiveHttpCalls: true,
      noModelCalls: true,
      noClaimTextReturned: true,
      noEvidenceBodyReturned: true,
      noModelReplyReturned: true,
    },
    inputs: pathSummary(resolvedPaths),
    calibration: {
      generatedAt: calibration.generatedAt || '',
      postHintGateStatus: clean(calibration.postHintJudgementGate?.status || '', 120),
      nextStep: clean(calibration.postHintJudgementGate?.nextStep || '', 240),
      actionFocus: {
        basis: clean(recent.actionFocus?.basis || '', 120),
        tickId: num(recent.actionFocus?.tickId),
        gapCounts: arr(recent.actionFocus?.gapCounts).map((item) => ({
          gap: safeTag(item?.gap || ''),
          count: num(item?.count),
        })).filter((item) => item.gap && item.count > 0).slice(0, 8),
      },
      latestTick: {
        id: num(recent.latestTickWithJudgement?.id),
        checked: num(recent.latestTickWithJudgement?.checked),
        resolved: num(recent.latestTickWithJudgement?.resolved),
        evidenceGapCounts: arr(recent.latestTickWithJudgement?.evidenceGapCounts).map((item) => ({
          gap: safeTag(item?.gap || ''),
          count: num(item?.count),
        })).filter((item) => item.gap && item.count > 0).slice(0, 8),
      },
    },
    codeMitigations,
    summary,
    nextActions: buildNextActions({ status, summary, codeMitigations }),
    successCriteria: [
      { id: 'new_action_trace_coverage', target: 'new natural action-result evidence has semanticTraceMaxCoverage >= 0.25' },
      { id: 'post_hint_unknown_rate', target: 'action_success_signal UNKNOWN samples drop after new evidence without increasing observation-only settlements' },
      { id: 'no_false_observation_settlement', target: 'observation_only_result_signal remains UNKNOWN unless action/external-result evidence appears' },
    ],
  };
}

function mdTable(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

export function renderMarkdown(report, jsonPath = '') {
  const categoryRows = report.summary.categoryCounts.map((item) => [`\`${item.category}\``, String(item.count)]);
  const sampleRows = report.summary.samples.map((item) => [
    String(item.id),
    `\`${item.category}\``,
    String(item.unresolved),
    `\`${item.decisionLabel || item.hintLabel || '-'}\``,
    String(item.semanticTraceMaxCoverage ?? '-'),
    item.gaps.map((gap) => `\`${gap}\``).join('<br>') || '-',
  ]);
  const actionRows = report.nextActions.map((item) => [
    item.priority,
    item.ownerDecision ? 'yes' : 'no',
    `\`${item.action}\``,
    clean(item.reason, 220),
  ]);
  return [
    '# Neo Post-Hint Judgement Audit',
    '',
    `Generated: ${report.generatedAt}`,
    `Project root: \`${report.root}\``,
    '',
    '## Verdict',
    '',
    `- status: \`${report.status}\``,
    `- unique judgements: ${report.summary.uniqueJudgements}`,
    `- action success UNKNOWN: ${report.summary.actionSuccessUnknown}`,
    `- observation-only UNKNOWN: ${report.summary.observationOnlyUnknown}`,
    `- direct-evidence UNKNOWN: ${report.summary.directEvidenceUnknown}`,
    `- stale action hint on observation-only: ${report.summary.staleActionHintOnObservationOnly}`,
    `- max semanticTrace coverage: ${report.summary.semanticTraceCoverageMax ?? '-'}`,
    '',
    '## Categories',
    '',
    mdTable([
      ['category', 'count'],
      ['---', '---:'],
      ...categoryRows,
    ]),
    '',
    '## Samples',
    '',
    mdTable([
      ['id', 'category', 'unresolved', 'decision', 'trace coverage', 'gaps'],
      ['---:', '---', '---:', '---', '---:', '---'],
      ...sampleRows,
    ]),
    '',
    '## Next Actions',
    '',
    mdTable([
      ['priority', 'owner decision', 'action', 'reason'],
      ['---', '---', '---', '---'],
      ...actionRows,
    ]),
    '',
    '## JSON',
    '',
    jsonPath ? `Full report: \`${jsonPath.replace(`${ROOT}/`, '')}\`.` : 'No JSON path supplied.',
  ].join('\n');
}

export function writePostHintJudgementAudit(report) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${OUT_BASE}.json`);
  const mdPath = join(OUT_DIR, `${OUT_BASE}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mdPath, `${renderMarkdown(report, jsonPath)}\n`, { mode: 0o600 });
  return { jsonPath, mdPath };
}

export { classifyEntry, summarizeEntries };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = buildPostHintJudgementAudit();
  const paths = writePostHintJudgementAudit(report);
  console.log(JSON.stringify({
    ok: report.ok,
    status: report.status,
    uniqueJudgements: report.summary.uniqueJudgements,
    actionSuccessUnknown: report.summary.actionSuccessUnknown,
    observationOnlyUnknown: report.summary.observationOnlyUnknown,
    directEvidenceUnknown: report.summary.directEvidenceUnknown,
    staleActionHintOnObservationOnly: report.summary.staleActionHintOnObservationOnly,
    semanticTraceCoverageMax: report.summary.semanticTraceCoverageMax,
    paths,
  }, null, 2));
}
