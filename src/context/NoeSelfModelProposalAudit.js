// @ts-check
// P7-D0/D1: shadow/audit channel for self-model update proposals.
// It never applies proposals; it writes aggregate, redacted audit reports only.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSelfModelDiffProposal } from './NoeSelfModelUpdateProtocol.js';
import { DEFAULT_IDENTITY } from './NoeSelfModel.js';
import { createNoeSelfModelVersionStore } from './NoeSelfModelVersionStore.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_SELF_MODEL_PROPOSAL_OUT_DIR = join(ROOT, 'output', 'noe-self-model-proposals');
export const DEFAULT_SELF_MAINTENANCE_REPORT = join(ROOT, 'output', 'noe-self-maintenance-end2end', 'latest.json');

function safeJsonFile(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function rel(file) {
  const abs = resolve(file);
  return abs.startsWith(ROOT) ? relative(ROOT, abs).replace(/\\/g, '/') : abs;
}

function round(n, digits = 3) {
  const value = Number(n || 0);
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function currentIdentity(store) {
  try { return store?.current?.()?.identity || DEFAULT_IDENTITY; } catch { return DEFAULT_IDENTITY; }
}

function maintenanceSignals(report) {
  if (!report || typeof report !== 'object') return null;
  const warnings = Array.isArray(report.readiness?.warnings) ? report.readiness.warnings : [];
  const blockers = Array.isArray(report.readiness?.blockers) ? report.readiness.blockers : [];
  const clusters = Array.isArray(report.failureModeClusters) ? report.failureModeClusters : [];
  const reuse = report.crossTopicKnowledgeReuse || {};
  return {
    ok: report.readiness?.ok === true,
    warnings,
    blockers,
    failureModeClusterCount: clusters.length,
    topFailureModeCount: Number(clusters[0]?.count || 0),
    crossTopicKnowledgeReuseScore: round(reuse.score || 0),
    selfLearningGoalExecCount: Number(report.selfLearningGoalExecCount || 0),
    selfLearningSuccessRate: round(report.selfLearningSuccessRate || 0),
  };
}

function deriveDispositionPatch(identity, signals) {
  if (!signals || signals.blockers.length) return null;
  const reasons = [];
  if (signals.warnings.includes('failure_modes_present')) reasons.push('失败模式复盘');
  if (signals.crossTopicKnowledgeReuseScore < 0.2) reasons.push('跨主题知识复用');
  if (signals.selfLearningGoalExecCount > 0) reasons.push('自学习证据闭环');
  if (!reasons.length) return null;
  const base = String(identity.disposition || DEFAULT_IDENTITY.disposition || '').trim();
  const add = `更重视${reasons.join('、')}，先用证据化提案而不是直接改身份。`;
  if (base.includes(add)) return null;
  return { disposition: `${base}；${add}`.slice(0, 300) };
}

export function buildSelfModelProposalAudit({
  maintenanceReport = null,
  maintenanceReportRef = DEFAULT_SELF_MAINTENANCE_REPORT,
  store = createNoeSelfModelVersionStore(),
  now = Date.now(),
  reportId = randomUUID(),
  proposalId = randomUUID(),
} = {}) {
  const identity = currentIdentity(store);
  const signals = maintenanceSignals(maintenanceReport);
  const evidenceRefs = maintenanceReport ? [rel(maintenanceReportRef)] : [];
  const patch = deriveDispositionPatch(identity, signals);
  const proposal = patch ? createSelfModelDiffProposal({
    currentIdentity: identity,
    patch,
    reason: 'P7-D shadow audit derived from self-maintenance baseline signals.',
    evidenceRefs,
    source: 'self_model_shadow_audit',
    now: () => now,
    proposalId,
  }) : null;
  return {
    schemaVersion: 1,
    reportId,
    generatedAt: now,
    generatedAtIso: new Date(now).toISOString(),
    policy: {
      shadowOnly: true,
      applyAttempted: false,
      llmContextAllowed: false,
      redaction: 'strict_aggregate_only',
      noIdentityCoreWrite: true,
    },
    source: {
      maintenanceReportRef: rel(maintenanceReportRef),
      maintenanceReportFound: Boolean(maintenanceReport),
    },
    signals: signals || { blockers: ['source_report_missing'] },
    decision: proposal ? 'proposal_generated' : 'no_proposal',
    proposal,
    apply: { attempted: false, reason: 'shadow_audit_only' },
  };
}

export function writeSelfModelProposalAudit(report, { outDir = DEFAULT_SELF_MODEL_PROPOSAL_OUT_DIR } = {}) {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const stamp = new Date(report.generatedAt).toISOString().replace(/[:.]/g, '-');
  const file = join(outDir, `${stamp}-${report.reportId}.json`);
  const latest = join(outDir, 'latest.json');
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(file, payload, { mode: 0o600 });
  writeFileSync(latest, payload, { mode: 0o600 });
  return { file, latest };
}

export function runSelfModelProposalAudit({
  maintenanceReportRef = DEFAULT_SELF_MAINTENANCE_REPORT,
  outDir = DEFAULT_SELF_MODEL_PROPOSAL_OUT_DIR,
  store = createNoeSelfModelVersionStore(),
  now = Date.now(),
} = {}) {
  const maintenanceReport = existsSync(maintenanceReportRef) ? safeJsonFile(maintenanceReportRef) : null;
  const report = buildSelfModelProposalAudit({ maintenanceReport, maintenanceReportRef, store, now });
  const written = writeSelfModelProposalAudit(report, { outDir });
  return { report, written };
}
