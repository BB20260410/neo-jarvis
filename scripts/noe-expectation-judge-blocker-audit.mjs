#!/usr/bin/env node
// @ts-check
// Read-only expectation judge blocker audit.
// It consumes existing sanitized reports plus selected source-shape checks; it never reads the live DB, .env, owner token, or raw claim/evidence text.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.NOE_EXPECTATION_JUDGE_BLOCKER_OUT_DIR || join(ROOT, 'output', 'noe-audit');
const OUT_BASE = process.env.NOE_EXPECTATION_JUDGE_BLOCKER_BASENAME || 'expectation-judge-blocker-audit-2026-06-15';

const DEFAULT_PATHS = {
  calibrationLatest: join(ROOT, 'output', 'noe-expectation-calibration', 'latest.json'),
  runtimeEvidenceLatest: join(ROOT, 'output', 'noe-runtime-evidence', 'latest.json'),
  surpriseLearningAudit: join(ROOT, 'output', 'noe-audit', 'surprise-learning-audit-2026-06-15.json'),
  postHintJudgementAudit: join(ROOT, 'output', 'noe-audit', 'post-hint-judgement-audit-2026-06-15.json'),
  newActionEvidenceReadiness: join(ROOT, 'output', 'noe-audit', 'new-action-evidence-readiness-2026-06-15.json'),
  directEvidenceReaskReadiness: join(ROOT, 'output', 'noe-audit', 'direct-evidence-reask-readiness-2026-06-15.json'),
  actionEvidenceSource: join(ROOT, 'src', 'runtime', 'NoeActionEvidence.js'),
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
  return Number.isFinite(n) ? n : null;
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

function pathSummary(paths = {}) {
  return Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, rel(path)]));
}

function sourceText(path) {
  if (!path || !existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

function detectCodeMitigations(paths = {}) {
  const actionEvidenceSource = sourceText(paths.actionEvidenceSource);
  const actionPayloadTrace = {
    source: rel(paths.actionEvidenceSource || ''),
    status: 'missing',
    checks: {
      safeActPayloadObject: /\bsafeActPayload\b/.test(actionEvidenceSource),
      goalFromActPayload: /safeActPayload\.goalTitle/.test(actionEvidenceSource) && /safeActPayload\.goal\b/.test(actionEvidenceSource),
      expectationFromActPayload: /safeActPayload\.expectedClaim/.test(actionEvidenceSource) && /safeActPayload\.expectation/.test(actionEvidenceSource),
      checkpointFromActPayload: /safeActPayload\.checkpoint/.test(actionEvidenceSource) && /safeActPayload\.stepText/.test(actionEvidenceSource),
    },
    effect: 'completed action evidence can preserve goal/expectation/checkpoint semanticTrace fields from saved act.payload when retry input is thin',
    liveStatus: 'pending_restart_or_new_action_evidence',
  };
  const ready = Object.values(actionPayloadTrace.checks).every(Boolean);
  actionPayloadTrace.status = ready ? 'code_ready_live_pending_restart_or_new_actions' : 'not_detected';
  return {
    actionEvidenceActPayloadSemanticTrace: actionPayloadTrace,
  };
}

function countFromRows(rows = [], keyName, keyValue) {
  const row = arr(rows).find((item) => String(item?.[keyName] || '') === keyValue);
  return num(row?.count);
}

function compactRows(rows = [], keyName, limit = 8) {
  return arr(rows)
    .map((row) => ({
      [keyName]: clean(row?.[keyName] || '', 96),
      count: num(row?.count),
    }))
    .filter((row) => row[keyName] && row.count > 0)
    .sort((a, b) => b.count - a.count || String(a[keyName]).localeCompare(String(b[keyName])))
    .slice(0, limit);
}

function runtimeJudgeCounts(runtime = {}) {
  const expectations = runtime?.expectations || {};
  const judge = runtime?.expectationJudgeContract || expectations?.judgeContract || {};
  return {
    generatedAt: runtime?.generatedAt || '',
    expectationStatus: clean(expectations.status || '', 120),
    total: num(expectations.total),
    settled: num(expectations.settled),
    applied: num(expectations.applied),
    failed: num(expectations.failed),
    open: num(expectations.open),
    dueOpen: num(expectations.dueOpen),
    brier: nullableNum(expectations.brier),
    judgeStatus: clean(judge.status || '', 120),
    ticksScanned: num(judge.ticksScanned),
    judged: num(judge.judged),
    resolved: num(judge.resolved),
    unknown: num(judge.unknown),
    noEvidence: num(judge.noEvidence),
    decisiveHints: num(judge.decisiveHints),
    decisiveHintUnknown: num(judge.decisiveHintUnknown),
    decisiveHintOverride: num(judge.decisiveHintOverride),
    decisiveUnknownRate: nullableNum(judge.decisiveUnknownRate),
    avgSemanticCoverage: nullableNum(judge.avgSemanticCoverage),
    reasonCounts: compactRows(judge.reasonCounts, 'reason'),
    verdictReasonCounts: compactRows(judge.verdictReasonCounts, 'reasonCode'),
    hintLabelCounts: compactRows(judge.hintLabelCounts, 'label'),
    suggestedVerdictCounts: compactRows(judge.suggestedVerdictCounts, 'verdict'),
  };
}

function calibrationCounts(calibration = {}) {
  const live = calibration?.live || {};
  const recent = calibration?.recentAutoJudgements || {};
  const alignment = recent?.evidenceClaimAlignment || {};
  const evidenceSummary = recent?.evidenceSummary || {};
  const evidenceDecision = recent?.evidenceDecision || {};
  const evidenceDecisionHint = recent?.evidenceDecisionHint || {};
  const outcomeCounts = recent?.outcomeCounts || {};
  const postHint = calibration?.postHintJudgementGate || {};
  const blockers = arr(calibration?.status?.blockers).map((item) => clean(item, 120));
  return {
    generatedAt: calibration?.generatedAt || '',
    statusBlockers: blockers,
    live: {
      total: num(live.total),
      resolvedScored: num(live.resolvedScored),
      naturalResolvedScored: num(live.naturalResolvedScored),
      liveResolvedRequired: num(live.liveResolvedRequired),
      liveResolvedRemaining: num(live.liveResolvedRemaining),
      open: num(live.open),
      dueNowOpen: num(live.dueNowOpen),
      overdueOpen: num(live.overdueOpen),
      resolverActionableNow: live.resolverActionableNow === true,
      brierN: num(live.brier?.n),
      brier: nullableNum(live.brier?.brier),
    },
    recent: {
      ticksScanned: num(recent.ticksScanned),
      ticksWithJudgements: num(recent.ticksWithJudgements),
      judged: num(recent.judged),
      resolvedFromResults: num(recent.resolvedFromResults),
      outcomeCounts: {
        applied: num(outcomeCounts.applied),
        failed: num(outcomeCounts.failed),
        unknown: num(outcomeCounts.unknown),
      },
      reasonCounts: compactRows(recent.reasonCounts, 'reason'),
      verdictReasonCodeCounts: compactRows(recent.verdictReasonCodeCounts, 'reasonCode'),
      evidenceGapCounts: compactRows(recent.evidenceGapCounts, 'gap', 12),
      repeatedUnresolvedIds: arr(recent.repeatedUnresolvedIds).slice(0, 12).map((item) => ({
        id: num(item?.id),
        count: num(item?.count),
      })),
      evidenceSummary: {
        withSummary: num(evidenceSummary.withSummary),
        hasActionEvent: num(evidenceSummary.hasActionEvent),
        hasObservationEvent: num(evidenceSummary.hasObservationEvent),
        hasResultSignal: num(evidenceSummary.hasResultSignal),
        matchedAvg: nullableNum(evidenceSummary.matched?.avg),
        matchedMin: nullableNum(evidenceSummary.matched?.min),
        matchedMax: nullableNum(evidenceSummary.matched?.max),
        kindCounts: compactRows(evidenceSummary.kindCounts, 'kind', 12),
        signalCounts: compactRows(evidenceSummary.signalCounts, 'signal', 12),
      },
      evidenceDecision: {
        withDecision: num(evidenceDecision.withDecision),
        actionSuccess: countFromRows(evidenceDecision.labelCounts, 'label', 'action_success_signal'),
        observationOnly: countFromRows(evidenceDecision.labelCounts, 'label', 'observation_only_result_signal'),
        labelCounts: compactRows(evidenceDecision.labelCounts, 'label'),
        confidenceCounts: compactRows(evidenceDecision.confidenceCounts, 'confidence'),
      },
      evidenceDecisionHint: {
        withHint: num(evidenceDecisionHint.withHint),
        actionSuccess: countFromRows(evidenceDecisionHint.labelCounts, 'label', 'action_success_signal'),
        observationOnly: countFromRows(evidenceDecisionHint.labelCounts, 'label', 'observation_only_result_signal'),
        suggestedApplied: countFromRows(evidenceDecisionHint.suggestedVerdictCounts, 'suggestedVerdict', 'APPLIED'),
        suggestedFailed: countFromRows(evidenceDecisionHint.suggestedVerdictCounts, 'suggestedVerdict', 'FAILED'),
        suggestedUnknown: countFromRows(evidenceDecisionHint.suggestedVerdictCounts, 'suggestedVerdict', 'UNKNOWN'),
        labelCounts: compactRows(evidenceDecisionHint.labelCounts, 'label'),
        suggestedVerdictCounts: compactRows(evidenceDecisionHint.suggestedVerdictCounts, 'suggestedVerdict'),
      },
      evidenceClaimAlignment: {
        withAlignment: num(alignment.withAlignment),
        actionEvents: num(alignment.actionEvents),
        resultActionEvents: num(alignment.resultActionEvents),
        linkedActionEvents: num(alignment.linkedActionEvents),
        unlinkedActionEvents: num(alignment.unlinkedActionEvents),
        actionMaxCoverage: nullableNum(alignment.actionMaxCoverage),
        semanticActionEvents: num(alignment.semanticActionEvents),
        semanticResultActionEvents: num(alignment.semanticResultActionEvents),
        semanticLinkedActionEvents: num(alignment.semanticLinkedActionEvents),
        semanticActionMaxCoverage: nullableNum(alignment.semanticActionMaxCoverage),
        semanticTraceActionEvents: num(alignment.semanticTraceActionEvents),
        semanticTraceResultActionEvents: num(alignment.semanticTraceResultActionEvents),
        semanticTraceLinkedActionEvents: num(alignment.semanticTraceLinkedActionEvents),
        semanticTraceUnlinkedActionEvents: num(alignment.semanticTraceUnlinkedActionEvents),
        semanticTraceMaxCoverage: nullableNum(alignment.semanticTraceMaxCoverage),
      },
    },
    postHint: {
      status: clean(postHint.status || '', 120),
      decisiveEvidenceDecisionCount: num(postHint.decisiveEvidenceDecisionCount),
      decisiveEvidenceHintCount: num(postHint.decisiveEvidenceHintCount),
      dueNowOpen: num(postHint.dueNowOpen),
      nextOpenDueAtIso: clean(postHint.nextOpenDueAtIso || '', 80),
      secondsUntilNextOpenDue: num(postHint.secondsUntilNextOpenDue),
      nextStep: clean(postHint.nextStep || '', 240),
    },
  };
}

function compactPostHintAudit(value = {}) {
  const summary = value?.summary || {};
  return {
    status: clean(value?.status || '', 120),
    uniqueJudgements: num(summary.uniqueJudgements),
    actionSuccessUnknown: num(summary.actionSuccessUnknown),
    observationOnlyUnknown: num(summary.observationOnlyUnknown),
    directEvidenceUnknown: num(summary.directEvidenceUnknown),
    staleActionHintOnObservationOnly: num(summary.staleActionHintOnObservationOnly),
    semanticTraceCoverageMax: nullableNum(summary.semanticTraceCoverageMax),
    categoryCounts: compactRows(summary.categoryCounts, 'category', 8),
  };
}

function compactNewActionReadiness(value = {}) {
  const summary = value?.summary || {};
  return {
    status: clean(value?.status || '', 120),
    ready: summary.ready === true,
    newActionSemanticTraceCoverage: nullableNum(summary.newActionSemanticTraceCoverage),
    legacyActionSemanticTraceCoverage: nullableNum(summary.legacyActionSemanticTraceCoverage),
    observationOnlySemanticTraceCoverage: nullableNum(summary.observationOnlySemanticTraceCoverage),
  };
}

function compactDirectEvidenceReaskReadiness(value = {}) {
  const summary = value?.summary || {};
  return {
    status: clean(value?.status || '', 120),
    ready: summary.ready === true,
    directSuccessResolved: num(summary.directSuccessResolved),
    directSuccessOutcome: summary.directSuccessOutcome === 1 ? 1 : summary.directSuccessOutcome === 0 ? 0 : null,
    directSuccessSemanticTraceCoverage: nullableNum(summary.directSuccessSemanticTraceCoverage),
    claimMismatchResolved: num(summary.claimMismatchResolved),
    claimMismatchSecondReasonCode: clean(summary.claimMismatchSecondReasonCode || '', 80),
  };
}

function buildBlockers({ runtime, calibration, surpriseAudit, postHintAudit, codeMitigations, newActionReadiness, directEvidenceReadiness }) {
  const blockers = [];
  const actionPayloadTraceReady = codeMitigations?.actionEvidenceActPayloadSemanticTrace?.status === 'code_ready_live_pending_restart_or_new_actions';
  const newActionReady = newActionReadiness?.ready === true
    && Number(newActionReadiness?.newActionSemanticTraceCoverage || 0) >= 0.25;
  const decisiveReaskReady = directEvidenceReadiness?.ready === true
    && directEvidenceReadiness?.directSuccessOutcome === 1
    && Number(directEvidenceReadiness?.directSuccessSemanticTraceCoverage || 0) >= 0.25
    && directEvidenceReadiness?.claimMismatchSecondReasonCode === 'claim_mismatch';
  if (runtime.failed === 0) {
    blockers.push({
      id: 'no_failed_expectation_samples',
      severity: 'P0',
      evidence: `runtime failed=${runtime.failed}, surpriseGoals=${num(surpriseAudit?.current?.surpriseGoals)}`,
      impact: '没有 outcome=0，就没有可审计的 surprise learning 输入。',
      nextAction: '先修 judge/evidence 断点，让自然 expectation 能出现真实失败样本；不要手写 DB。',
    });
  }
  if (Number(runtime.decisiveUnknownRate) >= 0.8) {
    blockers.push({
      id: 'decisive_hints_mostly_unknown',
      severity: 'P0',
      evidence: `decisiveHints=${runtime.decisiveHints}, decisiveHintUnknown=${runtime.decisiveHintUnknown}, rate=${runtime.decisiveUnknownRate}`,
      impact: '安全元数据已经给出直接结果信号，但本地裁判仍大量 UNKNOWN。',
      nextAction: '把 post-hint 样本按 claim/evidence linkage 分层，再决定调 evidence 还是调 judge prompt。',
    });
  }
  const traceCoverage = calibration.recent.evidenceClaimAlignment.semanticTraceMaxCoverage;
  if (calibration.recent.evidenceClaimAlignment.semanticTraceResultActionEvents > 0 && Number(traceCoverage) < 0.25) {
    blockers.push({
      id: 'semantic_trace_claim_coverage_low',
      severity: actionPayloadTraceReady && newActionReady ? 'P1' : 'P0',
      evidence: `semanticTraceResultActionEvents=${calibration.recent.evidenceClaimAlignment.semanticTraceResultActionEvents}, semanticTraceMaxCoverage=${traceCoverage}, newActionReady=${newActionReady}`,
      impact: actionPayloadTraceReady && newActionReady
        ? '历史 action 结果 trace 覆盖低；新 action evidence drill 已证明可达阈值，剩余是 live 新样本复验。'
        : 'action 结果存在且 linked，但 semanticTrace 覆盖不到 claim 阈值，judge 继续认为直接证据不足。',
      nextAction: actionPayloadTraceReady && newActionReady
        ? 'readiness drill 已证明新证据能过 semanticTrace gate；等待重启或自然新 action evidence 后复验，不要回填/手写 live DB。'
        : (actionPayloadTraceReady
          ? '代码侧已让 completed action semanticTrace 从 saved act.payload 保留 goal/expectation/checkpoint；重启或产生新 action evidence 后复验 coverage。'
          : '在 completed action semanticTrace 中加入脱敏 expectation/goal 关键词，让 trace 覆盖达到结算阈值。'),
    });
  }
  if (calibration.recent.evidenceDecision.actionSuccess > 0 && calibration.recent.outcomeCounts.unknown > calibration.recent.outcomeCounts.applied) {
    blockers.push({
      id: 'action_success_signal_still_unknown',
      severity: 'P0',
      evidence: `actionSuccessSignals=${calibration.recent.evidenceDecision.actionSuccess}, recentUnknown=${calibration.recent.outcomeCounts.unknown}, recentApplied=${calibration.recent.outcomeCounts.applied}, postHintStatus=${postHintAudit.status || 'missing'}, directReaskReady=${decisiveReaskReady}`,
      impact: '存在 high-confidence action success 信号，但近期仍以 UNKNOWN 为主。',
      nextAction: postHintAudit.status === 'code_mitigated_live_pending_new_evidence' && decisiveReaskReady
        ? 'direct-evidence reask readiness 已证明二次复核可落 APPLIED 且不覆盖 claim_mismatch；等待重启或自然新 action evidence 后复验 live decisiveUnknownRate。'
        : postHintAudit.status === 'code_mitigated_live_pending_new_evidence'
        ? 'post-hint 安全 metadata 审计已完成：先等重启或新 action evidence 复验 trace 覆盖，不要直接放宽 judge。'
        : '抽样只看安全 metadata 的 post-hint judgement，定位是 claim mismatch、coverage low 还是 judge prompt 太保守。',
    });
  }
  if (calibration.recent.evidenceDecision.observationOnly > 0) {
    blockers.push({
      id: 'observation_only_result_noise',
      severity: 'P1',
      evidence: `observationOnlySignals=${calibration.recent.evidenceDecision.observationOnly}, actionEvents=${calibration.recent.evidenceClaimAlignment.actionEvents}`,
      impact: '内心独白/观察事件带 result-like 信号，会稀释 action 证据路径。',
      nextAction: '把 observation-only result signal 从 action settlement 候选里降权，或者要求外部/action 证据补齐。',
    });
  }
  if (calibration.live.resolvedScored < calibration.live.liveResolvedRequired) {
    blockers.push({
      id: 'live_resolved_below_gate',
      severity: 'P1',
      evidence: `resolvedScored=${calibration.live.resolvedScored}/${calibration.live.liveResolvedRequired}, remaining=${calibration.live.liveResolvedRemaining}`,
      impact: '长期校准样本数还低，不能把当前 Brier 当稳定能力指标。',
      nextAction: '继续等自然 tick 或修 resolver 让 dueOpen 能被安全结算。',
    });
  }
  if (calibration.live.overdueOpen > 0) {
    blockers.push({
      id: 'overdue_open_expectations',
      severity: 'P1',
      evidence: `overdueOpen=${calibration.live.overdueOpen}, resolverActionableNow=${calibration.live.resolverActionableNow}`,
      impact: '到期任务积压会让校准和 surprise learning 都滞后。',
      nextAction: '优先处理 dueNowOpen 的 evidence matching，不要扩大新 expectation 产量。',
    });
  }
  return blockers;
}

function buildSuccessCriteria() {
  return [
    { id: 'failed_samples_exist', target: 'expectations.failed > 0 and curiosity.failedSurpriseEligible > 0 from natural runtime evidence' },
    { id: 'surprise_goals_exist', target: 'noe_goals source=surprise > 0, with corresponding outcome=0 evidence' },
    { id: 'judge_unknown_rate_reduced', target: 'decisiveUnknownRate < 0.5 for recent expectation ticks' },
    { id: 'semantic_trace_coverage', target: 'semanticTraceMaxCoverage >= 0.25 on action-result samples or a stricter justified threshold with tests' },
    { id: 'live_calibration_gate', target: 'natural resolved scored expectations >= required gate and not all positive samples' },
  ];
}

export function buildExpectationJudgeBlockerAudit({
  root = ROOT,
  paths = DEFAULT_PATHS,
  now = new Date(),
} = {}) {
  const resolvedPaths = { ...DEFAULT_PATHS, ...paths };
  const calibration = calibrationCounts(readJson(resolvedPaths.calibrationLatest) || {});
  const runtime = runtimeJudgeCounts(readJson(resolvedPaths.runtimeEvidenceLatest) || {});
  const surpriseAudit = readJson(resolvedPaths.surpriseLearningAudit) || {};
  const postHintAudit = compactPostHintAudit(readJson(resolvedPaths.postHintJudgementAudit) || {});
  const newActionReadiness = compactNewActionReadiness(readJson(resolvedPaths.newActionEvidenceReadiness) || {});
  const directEvidenceReadiness = compactDirectEvidenceReaskReadiness(readJson(resolvedPaths.directEvidenceReaskReadiness) || {});
  const codeMitigations = detectCodeMitigations(resolvedPaths);
  const blockers = buildBlockers({
    runtime,
    calibration,
    surpriseAudit,
    postHintAudit,
    codeMitigations,
    newActionReadiness,
    directEvidenceReadiness,
  });
  return {
    ok: true,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    root,
    status: blockers.some((item) => item.severity === 'P0') ? 'blocked_at_judge_and_evidence_linkage' : 'needs_monitoring',
    policy: {
      readOnlyAudit: true,
      readsSanitizedReportsOnly: false,
      readsSourceShapeOnly: true,
      noDbReads: true,
      noDbWrites: true,
      noEnvFileReads: true,
      noOwnerTokenReads: true,
      noLiveHttpCalls: true,
      noModelCalls: true,
      noClaimTextReturned: true,
      noEvidenceBodyReturned: true,
    },
    inputs: pathSummary(resolvedPaths),
    codeMitigations,
    runtime,
    calibration,
    surpriseLearning: {
      status: clean(surpriseAudit.status || '', 120),
      surpriseLearningLive: surpriseAudit.surpriseLearningLive === true,
      expectationsFailed: num(surpriseAudit.current?.expectationsFailed),
      failedSurpriseEligible: num(surpriseAudit.current?.failedSurpriseEligible),
      surpriseGoals: num(surpriseAudit.current?.surpriseGoals),
    },
    postHintJudgement: postHintAudit,
    readiness: {
      newActionEvidence: newActionReadiness,
      directEvidenceReask: directEvidenceReadiness,
    },
    blockers,
    successCriteria: buildSuccessCriteria(),
  };
}

function mdTable(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

export function renderMarkdown(report, jsonPath = '') {
  const blockerRows = report.blockers.map((item) => [
    item.severity,
    `\`${item.id}\``,
    clean(item.evidence, 160),
    clean(item.nextAction, 220),
  ]);
  const criteriaRows = report.successCriteria.map((item) => [`\`${item.id}\``, clean(item.target, 220)]);
  return [
    '# Neo Expectation Judge Blocker Audit',
    '',
    `Generated: ${report.generatedAt}`,
    `Project root: \`${report.root}\``,
    '',
    '## Verdict',
    '',
    `- status: \`${report.status}\``,
    `- runtime decisiveUnknownRate: ${report.runtime.decisiveUnknownRate ?? '-'}`,
    `- runtime failed expectations: ${report.runtime.failed}`,
    `- surprise goals: ${report.surpriseLearning.surpriseGoals}`,
    `- semanticTraceMaxCoverage: ${report.calibration.recent.evidenceClaimAlignment.semanticTraceMaxCoverage ?? '-'}`,
    `- action evidence payload semanticTrace mitigation: \`${report.codeMitigations?.actionEvidenceActPayloadSemanticTrace?.status || 'missing'}\``,
    `- post-hint judgement audit: \`${report.postHintJudgement?.status || 'missing'}\``,
    `- new-action evidence readiness: \`${report.readiness?.newActionEvidence?.status || 'missing'}\``,
    `- direct-evidence reask readiness: \`${report.readiness?.directEvidenceReask?.status || 'missing'}\``,
    '',
    '## Code Mitigations',
    '',
    mdTable([
      ['mitigation', 'status', 'live status', 'source'],
      ['---', '---', '---', '---'],
      [
        '`actionEvidenceActPayloadSemanticTrace`',
        `\`${report.codeMitigations?.actionEvidenceActPayloadSemanticTrace?.status || 'missing'}\``,
        `\`${report.codeMitigations?.actionEvidenceActPayloadSemanticTrace?.liveStatus || 'unknown'}\``,
        `\`${clean(report.codeMitigations?.actionEvidenceActPayloadSemanticTrace?.source || '', 160)}\``,
      ],
    ]),
    '',
    '## Runtime Judge',
    '',
    mdTable([
      ['metric', 'value'],
      ['---', '---:'],
      ['total', String(report.runtime.total)],
      ['settled', String(report.runtime.settled)],
      ['failed', String(report.runtime.failed)],
      ['dueOpen', String(report.runtime.dueOpen)],
      ['judged', String(report.runtime.judged)],
      ['unknown', String(report.runtime.unknown)],
      ['decisiveHints', String(report.runtime.decisiveHints)],
      ['decisiveHintUnknown', String(report.runtime.decisiveHintUnknown)],
      ['decisiveUnknownRate', String(report.runtime.decisiveUnknownRate ?? '-')],
    ]),
    '',
    '## Post-Hint Judgement',
    '',
    mdTable([
      ['metric', 'value'],
      ['---', '---:'],
      ['status', `\`${report.postHintJudgement?.status || 'missing'}\``],
      ['uniqueJudgements', String(report.postHintJudgement?.uniqueJudgements ?? 0)],
      ['actionSuccessUnknown', String(report.postHintJudgement?.actionSuccessUnknown ?? 0)],
      ['observationOnlyUnknown', String(report.postHintJudgement?.observationOnlyUnknown ?? 0)],
      ['directEvidenceUnknown', String(report.postHintJudgement?.directEvidenceUnknown ?? 0)],
      ['staleActionHintOnObservationOnly', String(report.postHintJudgement?.staleActionHintOnObservationOnly ?? 0)],
      ['semanticTraceCoverageMax', String(report.postHintJudgement?.semanticTraceCoverageMax ?? '-')],
    ]),
    '',
    '## Readiness Drills',
    '',
    mdTable([
      ['drill', 'status', 'ready', 'key evidence'],
      ['---', '---', '---', '---'],
      [
        'new-action evidence',
        `\`${report.readiness?.newActionEvidence?.status || 'missing'}\``,
        String(report.readiness?.newActionEvidence?.ready === true),
        `newActionSemanticTraceCoverage=${report.readiness?.newActionEvidence?.newActionSemanticTraceCoverage ?? '-'}`,
      ],
      [
        'direct-evidence reask',
        `\`${report.readiness?.directEvidenceReask?.status || 'missing'}\``,
        String(report.readiness?.directEvidenceReask?.ready === true),
        `directSuccessResolved=${report.readiness?.directEvidenceReask?.directSuccessResolved ?? '-'}, claimMismatchSecondReasonCode=${report.readiness?.directEvidenceReask?.claimMismatchSecondReasonCode || '-'}`,
      ],
    ]),
    '',
    '## Calibration Metadata',
    '',
    mdTable([
      ['metric', 'value'],
      ['---', '---:'],
      ['recentUnknown', String(report.calibration.recent.outcomeCounts.unknown)],
      ['recentApplied', String(report.calibration.recent.outcomeCounts.applied)],
      ['recentFailed', String(report.calibration.recent.outcomeCounts.failed)],
      ['actionSuccessSignals', String(report.calibration.recent.evidenceDecision.actionSuccess)],
      ['observationOnlySignals', String(report.calibration.recent.evidenceDecision.observationOnly)],
      ['suggestedAppliedHints', String(report.calibration.recent.evidenceDecisionHint.suggestedApplied)],
      ['semanticTraceResultActionEvents', String(report.calibration.recent.evidenceClaimAlignment.semanticTraceResultActionEvents)],
      ['semanticTraceMaxCoverage', String(report.calibration.recent.evidenceClaimAlignment.semanticTraceMaxCoverage ?? '-')],
      ['liveResolvedScored', `${report.calibration.live.resolvedScored}/${report.calibration.live.liveResolvedRequired}`],
      ['overdueOpen', String(report.calibration.live.overdueOpen)],
    ]),
    '',
    '## Blockers',
    '',
    mdTable([
      ['severity', 'blocker', 'evidence', 'next action'],
      ['---', '---', '---', '---'],
      ...blockerRows,
    ]),
    '',
    '## Success Criteria',
    '',
    mdTable([
      ['criterion', 'target'],
      ['---', '---'],
      ...criteriaRows,
    ]),
    '',
    '## JSON',
    '',
    jsonPath ? `Full report: \`${jsonPath.replace(`${ROOT}/`, '')}\`.` : 'No JSON path supplied.',
  ].join('\n');
}

export function writeExpectationJudgeBlockerAudit(report) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${OUT_BASE}.json`);
  const mdPath = join(OUT_DIR, `${OUT_BASE}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mdPath, `${renderMarkdown(report, jsonPath)}\n`, { mode: 0o600 });
  return { jsonPath, mdPath };
}

export {
  calibrationCounts,
  runtimeJudgeCounts,
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = buildExpectationJudgeBlockerAudit();
  const paths = writeExpectationJudgeBlockerAudit(report);
  console.log(JSON.stringify({
    ok: report.ok,
    status: report.status,
    p0Blockers: report.blockers.filter((item) => item.severity === 'P0').map((item) => item.id),
    p1Blockers: report.blockers.filter((item) => item.severity === 'P1').map((item) => item.id),
    decisiveUnknownRate: report.runtime.decisiveUnknownRate,
    failed: report.runtime.failed,
    surpriseGoals: report.surpriseLearning.surpriseGoals,
    semanticTraceMaxCoverage: report.calibration.recent.evidenceClaimAlignment.semanticTraceMaxCoverage,
    paths,
  }, null, 2));
}
