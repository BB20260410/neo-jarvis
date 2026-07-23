#!/usr/bin/env node
// @ts-check
// Read-only decisive reask readiness drill for expectation settlement.
// Synthetic inputs only: no DB, env-file, owner token, live HTTP, or real model calls.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildEventsEvidence, createExpectationResolver } from '../src/cognition/NoeExpectationResolver.js';
import { buildNoeActionEvidence } from '../src/runtime/NoeActionEvidence.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.NOE_DIRECT_EVIDENCE_REASK_READINESS_OUT_DIR || join(ROOT, 'output', 'noe-audit');
const OUT_BASE = process.env.NOE_DIRECT_EVIDENCE_REASK_READINESS_BASENAME || 'direct-evidence-reask-readiness-2026-06-15';

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

function buildDirectActionPayload(claim) {
  const evidence = buildNoeActionEvidence({
    act: {
      id: 'act-direct-reask-readiness',
      action: 'noe.goal.execute',
      title: 'Direct evidence reask checkpoint',
      riskLevel: 'low',
      payload: {
        goalTitle: 'owner visible delivery evidence',
        expectedClaim: claim,
        checkpoint: 'direct evidence reask writes owner visible delivery evidence',
        stepText: 'write direct evidence reask owner visible delivery evidence',
        token: 'fixture-token',
      },
    },
    input: { realExecute: true },
    permissionResult: { decision: 'allow', reason: 'synthetic decisive reask drill' },
    contextSufficiency: { sufficient: true, blockers: [] },
    dryRunOnly: false,
    executorResult: {
      ok: true,
      completed: true,
      status: 'completed',
      result: 'done',
      stdoutSummary: 'direct evidence reask wrote owner visible delivery evidence',
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

function makeLedger(exp) {
  const resolved = [];
  return {
    resolved,
    due: () => [exp],
    resolve: (id, outcome, t) => {
      const row = { id, outcome, resolved_at: t, surprise: outcome === 0 ? 0.5 : 0 };
      resolved.push(row);
      return row;
    },
  };
}

async function runCase({ id, secondReply }) {
  const createdAt = 1_781_470_000_000;
  const dueAt = createdAt + 60_000;
  const now = dueAt + 60_000;
  const claim = 'owner expects visible delivery evidence from the decisive reask checkpoint';
  const exp = { id: id === 'direct_success_reask_applies' ? 801 : 802, claim, p: 0.7, created_at: createdAt, due_at: dueAt };
  const ledger = makeLedger(exp);
  const events = [{
    ts: createdAt + 10_000,
    kind: 'noe_act_executed',
    payload: buildDirectActionPayload(claim),
  }];
  const evidence = buildEventsEvidence(() => events, { maxLines: 4, scanLimit: 20 });
  const calls = [];
  const adapter = {
    chat: async (messages) => {
      const system = String(messages?.[0]?.content || '');
      calls.push(system.includes('二次复核') ? 'decisive_reask' : 'initial_judge');
      if (system.includes('二次复核')) return { reply: secondReply };
      return {
        reply: '{"verdict":"UNKNOWN","reasonCode":"insufficient_direct_evidence","hintAgreement":"override"}',
      };
    },
  };
  const resolver = createExpectationResolver({
    ledger,
    getAdapter: () => adapter,
    adapterId: 'synthetic',
    evidence,
    maxPerTick: 1,
    unresolvedCooldownMs: 0,
    decisiveReask: true,
    now: () => now,
    projectId: 'noe-direct-evidence-reask-readiness',
  });
  const result = await resolver.tick(now);
  const judged = result.judged?.[0] || {};
  return {
    id,
    checked: Number(result.checked) || 0,
    resolved: Number(result.resolved) || 0,
    outcome: judged.outcome ?? null,
    reason: clean(judged.reason || '', 80),
    evidenceDecisionHint: {
      label: clean(judged.evidenceDecisionHint?.label || '', 80),
      suggestedVerdict: clean(judged.evidenceDecisionHint?.suggestedVerdict || '', 16),
      semanticTraceMaxCoverage: judged.evidenceDecisionHint?.profile?.semanticTraceMaxCoverage ?? null,
      semanticTraceResultActionEvents: judged.evidenceDecisionHint?.profile?.semanticTraceResultActionEvents ?? null,
    },
    decisiveReask: {
      attempted: judged.decisiveReask?.attempted === true,
      outcome: judged.decisiveReask?.outcome ?? null,
      secondReasonCode: clean(judged.decisiveReask?.secondReasonCode || '', 80),
      secondHintAgreement: clean(judged.decisiveReask?.secondHintAgreement || '', 80),
    },
    calls,
    ledgerResolved: ledger.resolved.length,
  };
}

export async function buildDirectEvidenceReaskReadiness({
  now = new Date(),
} = {}) {
  const directSuccess = await runCase({
    id: 'direct_success_reask_applies',
    secondReply: '{"verdict":"APPLIED","reasonCode":"direct_success","hintAgreement":"agree"}',
  });
  const claimMismatch = await runCase({
    id: 'claim_mismatch_reask_stays_unknown',
    secondReply: '{"verdict":"UNKNOWN","reasonCode":"claim_mismatch","hintAgreement":"override"}',
  });
  const ready = directSuccess.resolved === 1
    && directSuccess.outcome === 1
    && directSuccess.decisiveReask.attempted === true
    && claimMismatch.resolved === 0
    && claimMismatch.outcome === null
    && claimMismatch.decisiveReask.secondReasonCode === 'claim_mismatch';
  return {
    ok: true,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    root: ROOT,
    status: ready ? 'ready_for_direct_evidence_decisive_reask' : 'not_ready',
    policy: {
      readOnlyDrill: true,
      syntheticInputsOnly: true,
      noDbReads: true,
      noDbWrites: true,
      noEnvFileReads: true,
      noOwnerTokenReads: true,
      noLiveHttpCalls: true,
      noRealModelCalls: true,
      noClaimTextReturned: true,
      noEvidenceBodyReturned: true,
      noSecretValuesReturned: true,
    },
    summary: {
      ready,
      directSuccessResolved: directSuccess.resolved,
      directSuccessOutcome: directSuccess.outcome,
      directSuccessReaskAttempted: directSuccess.decisiveReask.attempted,
      directSuccessSemanticTraceCoverage: directSuccess.evidenceDecisionHint.semanticTraceMaxCoverage,
      claimMismatchResolved: claimMismatch.resolved,
      claimMismatchOutcome: claimMismatch.outcome,
      claimMismatchReaskAttempted: claimMismatch.decisiveReask.attempted,
      claimMismatchSecondReasonCode: claimMismatch.decisiveReask.secondReasonCode,
    },
    cases: [directSuccess, claimMismatch],
    nextActions: [
      {
        priority: 'P0',
        action: 'rerun_calibration_after_new_live_action_evidence',
        ownerDecision: true,
        reason: 'synthetic resolver path settles direct action-result evidence after decisive reask; live still needs new evidence from the running process.',
      },
      {
        priority: 'P0',
        action: 'do_not_override_claim_mismatch_without_raw_review',
        ownerDecision: false,
        reason: 'claim_mismatch remains UNKNOWN in the readiness drill, preventing unsafe auto-APPLIED settlement.',
      },
    ],
  };
}

function mdTable(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

export function renderMarkdown(report, jsonPath = '') {
  const rows = report.cases.map((item) => [
    `\`${item.id}\``,
    String(item.resolved),
    String(item.outcome),
    item.decisiveReask.attempted ? 'yes' : 'no',
    item.decisiveReask.secondReasonCode || '-',
    String(item.evidenceDecisionHint.semanticTraceMaxCoverage ?? '-'),
  ]);
  return [
    '# Noe Direct Evidence Reask Readiness',
    '',
    `- generatedAt: ${report.generatedAt}`,
    `- status: ${report.status}`,
    `- json: ${jsonPath ? rel(jsonPath) : '-'}`,
    `- ready: ${report.summary.ready}`,
    `- direct success resolved: ${report.summary.directSuccessResolved}`,
    `- claim mismatch resolved: ${report.summary.claimMismatchResolved}`,
    '',
    '## Cases',
    '',
    mdTable([
      ['case', 'resolved', 'outcome', 'reask', 'secondReason', 'semanticTraceCoverage'],
      ['---', '---:', '---:', '---', '---', '---:'],
      ...rows,
    ]),
    '',
    '## Next Actions',
    '',
    ...report.nextActions.map((item) => `- ${item.priority}: ${item.action} (${item.reason})`),
    '',
  ].join('\n');
}

export function writeDirectEvidenceReaskReadiness({
  report,
  outDir = OUT_DIR,
  outBase = OUT_BASE,
} = {}) {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, `${outBase}.json`);
  const mdPath = join(outDir, `${outBase}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(mdPath, renderMarkdown(report, jsonPath));
  return { jsonPath, mdPath };
}

async function main() {
  const report = await buildDirectEvidenceReaskReadiness();
  const paths = writeDirectEvidenceReaskReadiness({ report });
  console.log(JSON.stringify({
    ok: true,
    status: report.status,
    ready: report.summary.ready,
    directSuccessResolved: report.summary.directSuccessResolved,
    directSuccessSemanticTraceCoverage: report.summary.directSuccessSemanticTraceCoverage,
    claimMismatchResolved: report.summary.claimMismatchResolved,
    paths,
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || error);
    process.exit(1);
  });
}
