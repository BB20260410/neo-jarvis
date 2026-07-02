#!/usr/bin/env node
// @ts-check
// Read-only readiness drill for future action evidence.
// It uses current code paths with synthetic sanitized inputs only; it never reads DB, .env, owner token, live HTTP, or calls a model.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildNoeActionEvidence } from '../src/runtime/NoeActionEvidence.js';
import {
  buildClaimLinkNeedles,
  buildEvidenceClaimAlignment,
  scoreCandidateClaimLink,
  summarizePayloadSignals,
} from '../src/cognition/NoeExpectationResolver.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.NOE_NEW_ACTION_EVIDENCE_READINESS_OUT_DIR || join(ROOT, 'output', 'noe-audit');
const OUT_BASE = process.env.NOE_NEW_ACTION_EVIDENCE_READINESS_BASENAME || 'new-action-evidence-readiness-2026-06-15';
const COVERAGE_TARGET = 0.25;

function _rel(path, root = ROOT) {
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

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function compactLink(link = {}) {
  return {
    label: clean(link.label || '', 40),
    semanticLabel: clean(link.semanticLabel || '', 40),
    semanticTraceLabel: clean(link.semanticTraceLabel || '', 40),
    hits: num(link.hits),
    coverage: num(link.coverage),
    semanticHits: num(link.semanticHits),
    semanticCoverage: num(link.semanticCoverage),
    semanticTraceHits: num(link.semanticTraceHits),
    semanticTraceCoverage: num(link.semanticTraceCoverage),
  };
}

function compactAlignment(alignment = {}) {
  return {
    claimGrams: num(alignment.claimGrams),
    matchedEvents: num(alignment.matchedEvents),
    actionEvents: num(alignment.actionEvents),
    observationEvents: num(alignment.observationEvents),
    resultEvents: num(alignment.resultEvents),
    resultActionEvents: num(alignment.resultActionEvents),
    linkedActionEvents: num(alignment.linkedActionEvents),
    semanticResultActionEvents: num(alignment.semanticResultActionEvents),
    semanticLinkedActionEvents: num(alignment.semanticLinkedActionEvents),
    semanticTraceResultActionEvents: num(alignment.semanticTraceResultActionEvents),
    semanticTraceLinkedActionEvents: num(alignment.semanticTraceLinkedActionEvents),
    actionMaxCoverage: num(alignment.actionMaxCoverage),
    semanticActionMaxCoverage: num(alignment.semanticActionMaxCoverage),
    semanticTraceMaxCoverage: num(alignment.semanticTraceMaxCoverage),
  };
}

function signals(payload = {}) {
  return summarizePayloadSignals(payload).map((item) => clean(item, 120));
}

function buildActionEvidencePayload({ claim, includePayloadSemantics = true } = {}) {
  const actPayload = includePayloadSemantics ? {
    goalTitle: 'owner visible delivery evidence',
    expectedClaim: claim,
    checkpoint: 'readiness checkpoint writes owner visible delivery evidence',
    stepText: 'write readiness checkpoint with owner visible delivery evidence',
    token: 'fixture-token',
  } : {
    token: 'fixture-token',
  };
  const evidence = buildNoeActionEvidence({
    act: {
      id: includePayloadSemantics ? 'act-readiness-new' : 'act-readiness-legacy',
      action: 'noe.goal.execute',
      title: includePayloadSemantics ? 'Readiness checkpoint evidence' : 'Completed generic action',
      riskLevel: 'low',
      payload: actPayload,
    },
    input: { realExecute: true },
    permissionResult: { decision: 'allow', reason: 'readiness drill synthetic allow' },
    contextSufficiency: { sufficient: true, blockers: [] },
    dryRunOnly: false,
    executorResult: {
      ok: true,
      completed: true,
      status: 'completed',
      result: 'done',
      stdoutSummary: includePayloadSemantics
        ? 'readiness checkpoint wrote owner visible delivery evidence'
        : 'completed generic action',
      authorization: 'unit-test-secret-token-value',
    },
  });
  return {
    ok: true,
    completed: true,
    status: 'completed',
    result: 'done',
    actionEvidence: evidence,
  };
}

function buildObservationPayload({ claim } = {}) {
  return {
    episodeType: 'inner_monologue',
    meta: {
      streamType: 'deliberation',
      guard: { action: 'allow', state: 'normal' },
      grounding: { score: 0.55 },
    },
    summary: `observation discussed ${claim}`,
  };
}

function evaluateCase({ id, kind, claim, payload, minHits }) {
  const grams = [...buildClaimLinkNeedles(claim)];
  const link = scoreCandidateClaimLink(payload, grams, minHits);
  const matched = [{ ev: { kind, ts: 1_781_471_000_000, payload } }];
  const alignment = buildEvidenceClaimAlignment({ matched, grams, minHits });
  const compact = compactAlignment(alignment);
  const directReady = compact.resultActionEvents > 0
    && compact.semanticTraceResultActionEvents > 0
    && compact.semanticTraceMaxCoverage >= COVERAGE_TARGET;
  const actionResultReady = compact.resultActionEvents > 0
    && compact.semanticResultActionEvents > 0
    && compact.semanticActionMaxCoverage >= COVERAGE_TARGET;
  return {
    id,
    kind,
    directReady,
    actionResultReady,
    expectedVerdictHint: directReady ? 'APPLIED' : 'UNKNOWN',
    link: compactLink(link),
    alignment: compact,
    signals: signals(payload),
  };
}

export function buildNewActionEvidenceReadiness({
  now = new Date(),
  claim = 'owner expects visible delivery evidence from the readiness checkpoint',
} = {}) {
  const minHits = 2;
  const newActionPayload = buildActionEvidencePayload({ claim, includePayloadSemantics: true });
  const legacyActionPayload = buildActionEvidencePayload({ claim, includePayloadSemantics: false });
  const observationPayload = buildObservationPayload({ claim });
  const cases = [
    evaluateCase({
      id: 'new_action_evidence_with_act_payload_semantics',
      kind: 'noe_act_executed',
      claim,
      payload: newActionPayload,
      minHits,
    }),
    evaluateCase({
      id: 'legacy_action_evidence_without_act_payload_semantics',
      kind: 'noe_act_executed',
      claim,
      payload: legacyActionPayload,
      minHits,
    }),
    evaluateCase({
      id: 'observation_only_control',
      kind: 'noe_episode',
      claim,
      payload: observationPayload,
      minHits,
    }),
  ];
  const newAction = cases.find((item) => item.id === 'new_action_evidence_with_act_payload_semantics') || {};
  const legacyAction = cases.find((item) => item.id === 'legacy_action_evidence_without_act_payload_semantics') || {};
  const observationOnly = cases.find((item) => item.id === 'observation_only_control') || {};
  const ready = newAction.directReady === true
    && legacyAction.directReady !== true
    && observationOnly.directReady !== true;
  return {
    ok: true,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    root: ROOT,
    status: ready ? 'ready_for_new_action_evidence_after_restart_or_natural_action' : 'not_ready',
    policy: {
      readOnlyDrill: true,
      syntheticInputsOnly: true,
      noDbReads: true,
      noDbWrites: true,
      noEnvFileReads: true,
      noOwnerTokenReads: true,
      noLiveHttpCalls: true,
      noModelCalls: true,
      noClaimTextReturned: true,
      noEvidenceBodyReturned: true,
      noSecretValuesReturned: true,
    },
    gate: {
      coverageTarget: COVERAGE_TARGET,
      minHits,
      required: [
        'new action evidence semanticTraceResultActionEvents > 0',
        'new action evidence semanticTraceMaxCoverage >= 0.25',
        'legacy action evidence without act.payload semantics stays below gate',
        'observation-only evidence stays UNKNOWN',
      ],
    },
    summary: {
      ready,
      newActionDirectReady: newAction.directReady === true,
      legacyActionDirectReady: legacyAction.directReady === true,
      observationOnlyDirectReady: observationOnly.directReady === true,
      newActionSemanticTraceCoverage: newAction.alignment?.semanticTraceMaxCoverage ?? 0,
      legacyActionSemanticTraceCoverage: legacyAction.alignment?.semanticTraceMaxCoverage ?? 0,
      observationOnlySemanticTraceCoverage: observationOnly.alignment?.semanticTraceMaxCoverage ?? 0,
    },
    cases,
    nextActions: [
      {
        priority: 'P0',
        action: 'restart_or_wait_for_natural_new_action_evidence_then_rerun_post_hint_audit',
        ownerDecision: true,
        reason: 'synthetic current-code evidence crosses the semanticTrace gate; live process still needs new evidence to prove this in production.',
      },
      {
        priority: 'P0',
        action: 'keep_observation_only_unknown',
        ownerDecision: false,
        reason: 'observation-only control does not satisfy direct action/result evidence and should not be settled.',
      },
    ],
  };
}

function mdTable(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

export function renderMarkdown(report, jsonPath = '') {
  const caseRows = report.cases.map((item) => [
    `\`${item.id}\``,
    `\`${item.kind}\``,
    item.directReady ? 'yes' : 'no',
    item.expectedVerdictHint,
    String(item.alignment.semanticTraceMaxCoverage),
    String(item.alignment.resultActionEvents),
    String(item.alignment.semanticTraceResultActionEvents),
  ]);
  return [
    '# Neo New Action Evidence Readiness Drill',
    '',
    `Generated: ${report.generatedAt}`,
    `Project root: \`${report.root}\``,
    '',
    '## Verdict',
    '',
    `- status: \`${report.status}\``,
    `- ready: ${report.summary.ready}`,
    `- new action semanticTrace coverage: ${report.summary.newActionSemanticTraceCoverage}`,
    `- legacy action semanticTrace coverage: ${report.summary.legacyActionSemanticTraceCoverage}`,
    `- observation-only semanticTrace coverage: ${report.summary.observationOnlySemanticTraceCoverage}`,
    '',
    '## Cases',
    '',
    mdTable([
      ['case', 'kind', 'direct ready', 'hint', 'trace coverage', 'result action events', 'trace result action events'],
      ['---', '---', '---', '---', '---:', '---:', '---:'],
      ...caseRows,
    ]),
    '',
    '## JSON',
    '',
    jsonPath ? `Full report: \`${jsonPath.replace(`${ROOT}/`, '')}\`.` : 'No JSON path supplied.',
  ].join('\n');
}

export function writeNewActionEvidenceReadiness(report) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${OUT_BASE}.json`);
  const mdPath = join(OUT_DIR, `${OUT_BASE}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mdPath, `${renderMarkdown(report, jsonPath)}\n`, { mode: 0o600 });
  return { jsonPath, mdPath };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = buildNewActionEvidenceReadiness();
  const paths = writeNewActionEvidenceReadiness(report);
  console.log(JSON.stringify({
    ok: report.ok,
    status: report.status,
    ready: report.summary.ready,
    newActionSemanticTraceCoverage: report.summary.newActionSemanticTraceCoverage,
    legacyActionSemanticTraceCoverage: report.summary.legacyActionSemanticTraceCoverage,
    observationOnlySemanticTraceCoverage: report.summary.observationOnlySemanticTraceCoverage,
    paths: {
      jsonPath: paths.jsonPath,
      mdPath: paths.mdPath,
    },
  }, null, 2));
}
