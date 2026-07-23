#!/usr/bin/env node
// @ts-check
/**
 * S10 gate + twelve-dimension report (honest, fail-closed).
 * Metrics derived only from evidence files; gate statuses only from runAcceptanceGates.
 * Never hand-forces PASS. Never hardcodes soakAvailability=0.999.
 *
 *   node scripts/noe-s10-surpass-report.mjs \
 *     --matrix /path/acceptance_matrix.json \
 *     --evidence-root /path/evidence \
 *     --plan-root /path/plan \
 *     --source-digest sha256:... \
 *     --runtime-config-digest sha256:... \
 *     --write-matrix \
 *     --out /path/S10_REPORT.json
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, def = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] || def) : def;
}
function hasFlag(name) {
  return process.argv.includes(name);
}

function sha256File(p) {
  if (!existsSync(p)) return null;
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function readJson(p) {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Load JSON for metric extraction. Stale digests still return data (for observation),
 * but `bound` is false so callers must not treat metrics as RC-final without rebinding evidence.
 */
export function loadEvidenceJson(filePath, currentDigest) {
  const j = readJson(filePath);
  if (!j) return { ok: false, bound: false, reason: 'missing_or_unreadable', data: null, dig: null };
  const dig = j.sourceDigest || j.candidate?.sourceDigest || null;
  const bound = Boolean(currentDigest && dig && dig === currentDigest);
  const reason = !currentDigest
    ? 'current_digest_missing'
    : !dig
      ? 'evidence_digest_missing'
      : dig !== currentDigest
        ? 'stale_digest'
        : null;
  return {
    ok: true,
    bound,
    reason,
    data: j,
    dig,
  };
}

export function summarizeAbsoluteGates(gates = []) {
  const rows = Array.isArray(gates) ? gates : [];
  const count = (status) => rows.filter((g) => g.status === status).length;
  const pass = count('pass');
  const fail = count('fail');
  const blockedExternal = count('blocked_external');
  const pendingOwnerWaived = count('pending_owner_waived');
  const pending = rows.length - pass - fail - blockedExternal - pendingOwnerWaived;
  return {
    pass,
    pending,
    fail,
    blocked_external: blockedExternal,
    pending_owner_waived: pendingOwnerWaived,
    total: rows.length,
    bar: `${pass}/${rows.length}`,
  };
}

/**
 * @param {{
 *   nonSoakGates?: Array<{status?: string}>,
 *   nonSoakDimensions?: Array<{relative?: string}>,
 *   blockedExternal?: string[],
 *   soakComplete?: boolean,
 *   soakOwnerWaived?: boolean,
 * }} [input]
 */
export function reduceCandidateStatus({
  nonSoakGates = [],
  nonSoakDimensions = [],
  blockedExternal = [],
  soakComplete = false,
  soakOwnerWaived = false,
} = {}) {
  if (nonSoakGates.some((g) => g.status === 'blocked_external') || blockedExternal.length > 0) {
    return 'blocked_external';
  }
  if (nonSoakGates.some((g) => g.status !== 'pass')) return 'in_progress';
  const passLabels = new Set(['neo_leads', 'neo_not_below', 'ceiling_tie']);
  if (
    nonSoakDimensions.length === 0 ||
    nonSoakDimensions.some((d) => !passLabels.has(d.relative || ''))
  ) {
    return 'in_progress';
  }
  if (!soakComplete && soakOwnerWaived) return 'partial_owner_waived_soak';
  return soakComplete ? 'non_soak_ready' : 'in_progress';
}

export function synchronizeStageStatuses(stages = [], absoluteGates = []) {
  const rows = (Array.isArray(stages) ? stages : []).map((stage) => ({
    ...stage,
    blockers: [...(stage.blockers || [])],
  }));
  const gateById = new Map((absoluteGates || []).map((gate) => [gate.id, gate]));
  const firstGate = gateById.get('G-FIRST-01');
  const s5 = rows.find((stage) => stage.id === 'S5');
  if (s5 && firstGate && firstGate.status !== 'pass') {
    s5.status = firstGate.status === 'blocked_external' ? 'blocked_external' : 'in_progress';
    s5.blockers = [
      ...new Set([...(s5.blockers || []), `G-FIRST-01_${firstGate.status || 'pending'}`]),
    ];
  }

  const byId = new Map(rows.map((stage) => [stage.id, stage]));
  for (const stage of rows) {
    const blockedDeps = (stage.dependsOn || []).filter(
      (id) => byId.get(id)?.status !== 'completed',
    );
    if (blockedDeps.length === 0) continue;
    if (stage.status !== 'blocked_external') stage.status = 'blocked_dependency';
    stage.blockers = [
      ...new Set([
        ...(stage.blockers || []),
        ...blockedDeps.map((id) => `dependency_${id}_${byId.get(id)?.status || 'missing'}`),
      ]),
    ];
  }
  return rows;
}

export function summarizeStages(stages = []) {
  const rows = Array.isArray(stages) ? stages : [];
  const byStatus = {};
  for (const stage of rows) {
    const status = stage.status || 'unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  return {
    total: rows.length,
    completed: byStatus.completed || 0,
    byStatus,
  };
}

export async function main() {
const matrixPath = resolve(arg('--matrix'));
const evidenceRoot = resolve(arg('--evidence-root'));
const planRoot = resolve(arg('--plan-root', dirname(evidenceRoot)));
const outPath = resolve(arg('--out', join(evidenceRoot, 'S10', 'S10_REPORT.json')));
const sourceDigest = arg('--source-digest', '');
const runtimeConfigDigest = arg('--runtime-config-digest', '');
const writeMatrix = hasFlag('--write-matrix');

const {
  runAcceptanceGates,
  computeVtcr,
  computeTruthMetrics,
  applyGateResultsToMatrix,
  markStaleEvidenceByDigest,
  writeAcceptanceMatrixFile,
} = await import(pathToFileURL(join(root, 'src/runtime/NoeAcceptanceGateRunner.js')).href);
const { BAILONGMA_FIXED_BASELINE } = await import(
  pathToFileURL(join(root, 'src/runtime/NoeBaiLongmaFusionPlanner.js')).href
);
const {
  computeRelativeLabel,
  recomputeDimensionRelative,
  PROXY_FORBIDDEN_DIMS,
  summarizeRelativeDimensions,
} = await import(pathToFileURL(join(root, 'src/runtime/NoeRelativeDimensionScore.js')).href);

const matrix = readJson(matrixPath);
if (!matrix) {
  console.error('matrix_missing');
  return 2;
}

// The caller must supply the current digest. Falling back to a matrix value can
// silently rebind historical evidence to a stale candidate.
const digest = sourceDigest || '';
const runtimeDig = runtimeConfigDigest || '';

const soakProgress =
  readJson(join(evidenceRoot, 'S10/soak-progress.json')) ||
  readJson(join(evidenceRoot, 'soak/SOAK_START.json'));
const c01Path = join(evidenceRoot, 'S3/c01-e2e-10x-summary.json');
const productPath = join(evidenceRoot, 'S6/product-loops-package.json');
const packagingPath = join(evidenceRoot, 'S8/packaging-status.json');
const doctorPath = join(evidenceRoot, 'S2/doctor-final.json');
const pluginPath = join(evidenceRoot, 'S7/plugin-host-t1.json');
const archPath = join(evidenceRoot, 'S3/arch-boundaries-s3.json');
const highRiskPath = join(evidenceRoot, 'S10/high-risk-confirmation.json');
const voicePath = join(evidenceRoot, 'S10/voice-task-loop-suite.json');
const voiceLegacyPath = join(evidenceRoot, 'S10/voice-task-suite.json');
const soakSamplesPath = join(evidenceRoot, 'soak/samples.jsonl');

const c01B = loadEvidenceJson(c01Path, digest);
const productB = loadEvidenceJson(productPath, digest);
const packaging = readJson(packagingPath);
const doctorFinal = readJson(doctorPath);
const pluginT1 = readJson(pluginPath);
const arch = readJson(archPath);
const highRiskB = loadEvidenceJson(highRiskPath, digest);
const voiceB = loadEvidenceJson(voicePath, digest).ok
  ? loadEvidenceJson(voicePath, digest)
  : loadEvidenceJson(voiceLegacyPath, digest);

/** @type {Record<string, number|null>} */
const metrics = {};
/** @type {string[]} */
const metricNotes = [];

// Truth / VTCR from C01 only if file exists (digest binding via evidence records)
if (c01B.ok && c01B.bound && c01B.data?.results) {
  const c01 = c01B.data;
  const tasks = c01.results.map((r) => ({
    status: r.finalStatus === 'completed' ? 'completed' : r.finalStatus,
    verified: r.finalStatus === 'completed' && r.displayCompleted === true,
    hasValidArtifacts: r.reportExists === true,
    hasEvidence: r.reportExists === true,
    exitCode: r.finalStatus === 'completed' ? 0 : 1,
    receiptId: r.taskId,
    cancelledByUser: false,
  }));
  const falseDisplay = c01.results.filter((r) => r.falseDisplayCompleted).length;
  const truth = computeTruthMetrics(tasks);
  const vtcr = computeVtcr(tasks);
  metrics.falseCompletionCount =
    truth.falseCompletionCount + falseDisplay + (c01.falseCompleteCount || 0);
  metrics.completedWithoutEvidence = truth.completedWithoutEvidence;
  metrics.completedWithExitNonZero = truth.completedWithExitNonZero;
  metrics.completedWithMissingArtifact = truth.completedWithMissingArtifact;
  metrics.completedReceiptCoverage = truth.completedReceiptCoverage;
  metrics.VTCR = vtcr.VTCR;
  metrics.restartRecoveryAccuracy = c01.restartRecoveryOk === true ? 1.0 : null;
  if (!c01B.bound) metricNotes.push('c01_metrics_from_stale_file_gates_need_rebind');
} else {
  metricNotes.push(`c01_unavailable:${c01B.reason || 'missing'}`);
}

if (productB.ok && productB.bound && productB.data?.loops) {
  const product = productB.data;
  if (product.loops.memory) {
    metrics.memoryRecall = product.loops.memory.memoryRecall ?? null;
    metrics.memoryPrecision = product.loops.memory.memoryPrecision ?? null;
    metrics.crossProjectSensitiveMemoryMisuse =
      product.loops.memory.crossProjectSensitiveMisuse ?? null;
  }
  if (product.loops.browser) {
    metrics.browserTaskSuccessRate = product.loops.browser.successRate ?? null;
  }
  if (!productB.bound) metricNotes.push('product_loops_metrics_from_unbound_file');
} else {
  metricNotes.push(`product_loops_unavailable:${productB.reason || 'missing'}`);
}

// High-risk suite metrics (gate still requires bound evidence path)
if (
  highRiskB.ok &&
  highRiskB.bound &&
  highRiskB.data &&
  typeof highRiskB.data.highRiskConfirmationAccuracy === 'number'
) {
  metrics.highRiskConfirmationAccuracy = highRiskB.data.highRiskConfirmationAccuracy;
  if (!highRiskB.bound) metricNotes.push('high_risk_metrics_stale_file');
} else {
  metrics.highRiskConfirmationAccuracy = null;
  metricNotes.push('high_risk_suite_missing');
}

// Voice product metric only when suite declares full task loop closed
if (
  voiceB.ok &&
  voiceB.bound &&
  voiceB.data &&
  voiceB.data.taskLoopClosed === true &&
  typeof voiceB.data.voiceTaskSuccessRate === 'number'
) {
  metrics.voiceTaskSuccessRate = voiceB.data.voiceTaskSuccessRate;
} else {
  metrics.voiceTaskSuccessRate = null;
  metricNotes.push('voice_suite_not_task_loop_closed');
}

// Orphans from doctor snapshot (point-in-time; soak still required for G-SOAK)
const orphanFinding = (doctorFinal?.findings || []).find(
  (f) => f.checkId === 'runtime.neo_orphan_processes',
);
if (orphanFinding?.data?.neoOwnedOrphanProcessCount != null) {
  metrics.neoOwnedOrphanProcessCount = orphanFinding.data.neoOwnedOrphanProcessCount;
}

// Soak availability: compute from samples.jsonl ONLY — never hardcode 0.999
const elapsedH = Number(soakProgress?.elapsedHours ?? 0);
const soakComplete = soakProgress?.complete === true || elapsedH >= 72;
let soakAvailability = null;
let recoveryP95 = null;
if (existsSync(soakSamplesPath)) {
  const lines = readFileSync(soakSamplesPath, 'utf8').split('\n').filter(Boolean);
  const samples = [];
  for (const line of lines) {
    try {
      samples.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  if (samples.length > 0) {
    const available = samples.filter((s) => s.healthOk === true && s.dualWriter !== true && s.dualWriterOk !== false).length;
    // missing samples not reconstructed — only rate over present samples; full contract uses expected slots
    soakAvailability = available / samples.length;
  }
  const recoveries = samples
    .map((s) => s.recoverySeconds)
    .filter((n) => typeof n === 'number' && Number.isFinite(n))
    .sort((a, b) => a - b);
  if (recoveries.length > 0) {
    const idx = Math.min(recoveries.length - 1, Math.ceil(recoveries.length * 0.95) - 1);
    recoveryP95 = recoveries[Math.max(0, idx)];
  }
}
// Only publish soak metrics when wall clock complete; else leave null → pending
if (soakComplete && soakAvailability != null) {
  metrics.soakAvailability = soakAvailability;
  metrics.recoveryP95Seconds = recoveryP95;
} else {
  metrics.soakAvailability = null;
  metrics.recoveryP95Seconds = null;
  metricNotes.push('soak_wall_clock_incomplete_or_no_samples');
}

// Install first task: require a digest-bound summary and the actual five-human lab.
const firstCandidates = [
  join(evidenceRoot, 'S8/g-first/G-FIRST-01-summary.json'),
  join(evidenceRoot, 'S10/g-first/G-FIRST-01-summary.json'),
];
const firstPath = firstCandidates.find((p) => existsSync(p));
const gFirstB = firstPath
  ? loadEvidenceJson(firstPath, digest)
  : { ok: false, bound: false, reason: 'missing_or_unreadable', data: null, dig: null };
const firstSum = gFirstB.bound ? gFirstB.data : null;
const gFirstHumanOk =
  firstSum?.ok === true &&
  firstSum?.humanLab?.ok === true &&
  firstSum?.fiveRealHumans === true;
if (
  gFirstHumanOk &&
  (firstSum.cleanMachineInstall === true || firstSum.clean_machine_install_run === true) &&
  firstSum.metric?.installToFirstVerifiedTaskMinutes != null
) {
  metrics.installToFirstVerifiedTaskMinutes = Number(
    firstSum.metric.installToFirstVerifiedTaskMinutes,
  );
  metricNotes.push('g_first_from_bound_five_human_clean_machine_summary');
} else {
  metrics.installToFirstVerifiedTaskMinutes = null;
  metricNotes.push(`g_first_unbound_or_five_human_missing:${gFirstB.reason || 'human_lab_incomplete'}`);
}

/**
 * Build bound evidence record for a relative path under evidence root.
 * Returns null if file missing (caller must not attach).
 */
function boundEvidence(rel, extra = {}) {
  const tryPaths = [
    join(evidenceRoot, rel.replace(/^evidence\//, '')),
    join(evidenceRoot, rel),
    join(planRoot, rel),
  ];
  const abs = tryPaths.find((p) => existsSync(p));
  if (!abs) return null;
  const fileDig = readJson(abs)?.sourceDigest || null;
  // Missing embedded digests are never synthesized from the current run.
  const stale = !digest || !fileDig || fileDig !== digest;
  const staleReason = !digest
    ? 'current_sourceDigest_missing'
    : !fileDig
      ? 'sourceDigest_missing'
      : fileDig !== digest
        ? 'sourceDigest_mismatch'
        : undefined;
  return {
    path: abs,
    sourceDigest: fileDig,
    artifactSha256: sha256File(abs),
    stale,
    staleReason,
    ...extra,
  };
}

// Clone matrix; inject only existing evidence; mark stale by current digest
let m = JSON.parse(JSON.stringify(matrix));
const staleResult = markStaleEvidenceByDigest(m, digest);
m = staleResult.matrix;

const evidenceMap = {
  'G-TRUTH-01': [boundEvidence('S3/c01-e2e-10x-summary.json')].filter(Boolean),
  'G-TRUTH-02': [boundEvidence('S3/c01-e2e-10x-summary.json')].filter(Boolean),
  'G-TRUTH-03': [boundEvidence('S3/c01-e2e-10x-summary.json')].filter(Boolean),
  'G-TRUTH-04': [boundEvidence('S3/c01-e2e-10x-summary.json')].filter(Boolean),
  'G-TRUTH-05': [boundEvidence('S3/c01-e2e-10x-summary.json')].filter(Boolean),
  'G-VTCR-01': [boundEvidence('S3/c01-e2e-10x-summary.json')].filter(Boolean),
  'G-RECOVER-01': [boundEvidence('S3/c01-e2e-10x-summary.json')].filter(Boolean),
  'G-PROC-01': [boundEvidence('S2/doctor-final.json')].filter(Boolean),
  'G-MEM-01': [boundEvidence('S6/product-loops-package.json')].filter(Boolean),
  'G-MEM-02': [boundEvidence('S6/product-loops-package.json')].filter(Boolean),
  'G-MEM-03': [boundEvidence('S6/product-loops-package.json')].filter(Boolean),
  'G-BROWSER-01': [boundEvidence('S6/product-loops-package.json')].filter(Boolean),
  'G-SAFE-01': [boundEvidence('S10/high-risk-confirmation.json')].filter(Boolean),
  // Voice product loop only (taskLoopClosed suite) — not TTS→STT alone
  'G-VOICE-01': [boundEvidence('S10/voice-task-loop-suite.json')].filter(Boolean),
  'G-FIRST-01': [
    boundEvidence('S8/g-first/G-FIRST-01-summary.json'),
    boundEvidence('S10/g-first/G-FIRST-01-summary.json'),
  ].filter(Boolean),
  'G-SOAK-01': [boundEvidence('S10/soak-progress.json')].filter(Boolean),
  'G-SOAK-02': [boundEvidence('S10/soak-progress.json')].filter(Boolean),
};

for (const g of m.absoluteGates || []) {
  if (Object.prototype.hasOwnProperty.call(evidenceMap, g.id)) {
    g.evidence = evidenceMap[g.id];
  }
  // Clear hand-written PASS before evaluation
  if (g.status === 'pass') g.status = 'pending';
}

const gateReport = runAcceptanceGates(m, {
  metrics,
  sourceDigest: digest,
  runtimeConfigDigest: runtimeDig,
  evidenceRoot,
  planRoot,
  allowReadyForCodexValidation: false,
  soakWallClockHours: elapsedH,
  requireWallClockHours: 72,
});

// ONLY demote overrides — never upgrade to pass after runner
for (const g of gateReport.absolute || []) {
  if ((g.id === 'G-SOAK-01' || g.id === 'G-SOAK-02') && !soakComplete) {
    if (g.status === 'pass') g.status = 'pending';
    g.blockers = [...new Set([...(g.blockers || []), 'soak_wall_clock_insufficient'])];
  }
  if (g.id === 'G-FIRST-01') {
    const cleanRun =
      firstSum?.cleanMachineInstall === true ||
      firstSum?.clean_machine_install_run === true;
    if (!cleanRun) {
      if (g.status === 'pass') g.status = 'pending';
      g.blockers = [...new Set([...(g.blockers || []), 'clean_machine_install_not_run'])];
    }
    if (cleanRun && !gFirstHumanOk) {
      g.status = 'blocked_external';
      g.blockers = [...new Set([...(g.blockers || []), 'five_real_humans_not_available'])];
    } else if (cleanRun && g.status === 'pass') {
      g.blockers = (g.blockers || []).filter(
        (b) => b !== 'clean_machine_install_not_run' && b !== 'five_real_humans_not_available',
      );
    }
  }
  if (
    g.id === 'G-VOICE-01' &&
    !(voiceB.ok && voiceB.bound && voiceB.data?.taskLoopClosed === true)
  ) {
    if (g.status === 'pass') g.status = 'pending';
    g.blockers = [...new Set([...(g.blockers || []), 'voice_task_loop_not_closed'])];
  }
  // Belt: never leave pass with zero valid evidence
  if (g.status === 'pass' && g.validEvidenceCount === 0) {
    g.status = 'pending';
    g.blockers = [...new Set([...(g.blockers || []), 'no_valid_bound_evidence'])];
  }
}

// Recompute summary after demotions only
const summary = summarizeAbsoluteGates(gateReport.absolute || []);
gateReport.summary = summary;
gateReport.allAbsolutePass = summary.pass === (gateReport.absolute || []).length && summary.pass > 0;
gateReport.readyForCodexValidation = false;

const appliedMatrix = applyGateResultsToMatrix(m, gateReport, {
  sourceDigest: digest,
  runtimeConfigDigest: runtimeDig,
});
// Candidate status is finalized after dimension recompute below; placeholder until then.
appliedMatrix.candidate.readyForCodexValidationAt = null;
appliedMatrix.candidate.acceptedAt = null;
appliedMatrix.candidate.sourceDigest = digest || null;
appliedMatrix.candidate.runtimeConfigDigest = runtimeDig || null;

// Twelve dimensions — prefer TWELVE_DIM_COMPARE.json; never fabricate bailongma scores
const compareCandidates = [
  join(evidenceRoot, 'S10/compare/TWELVE_DIM_COMPARE.json'),
  join(evidenceRoot, 'S10/TWELVE_DIM_COMPARE.json'),
];
const compareBound = compareCandidates
  .map((p) => loadEvidenceJson(p, digest))
  .find((loaded) => loaded.ok && loaded.bound);
const compareDoc = compareBound?.data || null;
const compareById = new Map(
  (compareDoc?.dimensions || []).map((x) => [x.id, x]),
);

const dimensions = (appliedMatrix.dimensions || matrix.dimensions || []).map((d) => {
  /** @type {string} */
  let status = 'pending';
  /** @type {number|null} */
  let neoScore = null;
  /** @type {number|null} */
  let bailongmaScore = null;
  /** @type {boolean} */
  let isProxy = false;
  /** @type {boolean} */
  let measurementEquivalent = false;
  /** @type {boolean} */
  let neoInputComplete = false;
  /** @type {boolean} */
  let bailongmaInputComplete = false;
  /** @type {string|null} */
  let relativeReasonHint = null;
  const notes = [];
  const fromCompare = compareById.get(d.id);

  if (fromCompare) {
    neoScore = fromCompare.neoScore ?? null;
    bailongmaScore = fromCompare.bailongmaScore ?? null;
    isProxy = fromCompare.isProxy === true;
    measurementEquivalent = fromCompare.measurementEquivalent === true;
    neoInputComplete = fromCompare.neoInputComplete === true;
    bailongmaInputComplete = fromCompare.bailongmaInputComplete === true;
    relativeReasonHint = fromCompare.relativeReason || null;
    if (fromCompare.absoluteMinutes != null) notes.push(`install_minutes=${fromCompare.absoluteMinutes}`);
    notes.push('from_twelve_dim_compare');
  }

  if (d.id === 'D02' || d.id === 'D07') {
    if (neoScore == null) neoScore = metrics.VTCR ?? null;
    notes.push(metrics.VTCR != null ? 'neo_metric_from_c01_if_bound' : 'c01_unbound');
  } else if (d.id === 'D05') {
    if (neoScore == null) neoScore = metrics.memoryRecall ?? null;
    notes.push('memory_loop_if_bound');
  } else if (d.id === 'D03') {
    if (neoScore == null) neoScore = metrics.browserTaskSuccessRate ?? null;
    notes.push('browser_loop_if_bound');
  } else if (d.id === 'D04') {
    if (metrics.voiceTaskSuccessRate != null && neoScore == null) {
      neoScore = metrics.voiceTaskSuccessRate;
    }
    notes.push(metrics.voiceTaskSuccessRate != null ? 'voice_loop_bound' : 'voice_pending');
  } else if (d.id === 'D08') {
    notes.push(soakComplete ? 'soak_complete_review' : 'soak_incomplete_pending_owner_waived');
  } else if (d.id === 'D11') {
    notes.push(packaging?.verdict || packaging?.stage?.status || 'packaging_unknown');
    const pv = packaging?.verdict || packaging?.stage?.status;
    if (pv === 'blocked_external' && (packaging?.stage?.internalOpen || []).length === 0) {
      status = 'blocked_external';
    }
  } else if (d.id === 'D09') {
    notes.push(pluginT1?.ok ? 'plugin_host_fail_closed_probed' : 'plugin_pending');
  } else if (d.id === 'D01') {
    if (metrics.installToFirstVerifiedTaskMinutes != null) {
      const m = Number(metrics.installToFirstVerifiedTaskMinutes);
      if (neoScore == null) neoScore = m <= 10 ? Math.max(0, 1 - m / 10) : 0;
      notes.push('g_first_clean_install_bound');
    } else {
      notes.push('clean_machine_install_not_run');
    }
  } else if (!fromCompare) {
    notes.push('dimension_suite_incomplete');
  }

  // Strip inequivalent proxies on D06/D09/D10/D11 (never invent BL parity from surface proxies)
  if (PROXY_FORBIDDEN_DIMS.includes(d.id) && (isProxy || measurementEquivalent === false)) {
    bailongmaScore = null;
    isProxy = true;
    measurementEquivalent = false;
    relativeReasonHint =
      relativeReasonHint || 'inequivalent_proxy_measurement_removed';
    notes.push('proxy_score_stripped');
  }

  const pendingOwnerWaived = d.id === 'D08' && !soakComplete;
  const recomputed = recomputeDimensionRelative(
    {
      id: d.id,
      neoScore,
      bailongmaScore,
      isProxy,
      measurementEquivalent,
      neoInputComplete,
      bailongmaInputComplete,
      pendingOwnerWaived,
      relativeReason: relativeReasonHint,
    },
    {
      reasonIfNonComparable: relativeReasonHint,
    },
  );

  // Labels must match numbers (sanity check; recomputed is source of truth)
  const check = computeRelativeLabel(neoScore, bailongmaScore, {
    isProxy,
    measurementEquivalent,
    neoInputComplete,
    bailongmaInputComplete,
    pendingOwnerWaived,
    reasonIfNonComparable: relativeReasonHint,
  });
  if (check.relative !== recomputed.relative) {
    notes.push(`label_recompute_mismatch_used_${recomputed.relative}`);
  }

  const relative = recomputed.relative;
  const relativeReason = recomputed.relativeReason;

  if (status === 'pending' && neoScore != null) status = 'neo_absolute_partial';
  if (status === 'pending' && relative && String(relative).startsWith('neo_absolute_pass')) {
    status = 'neo_absolute_partial';
  }
  if (relative === 'pending_owner_waived') status = 'pending_owner_waived';
  if (relative === 'neo_leads' || relative === 'neo_not_below' || relative === 'ceiling_tie') {
    status = relative;
  } else if (relative === 'neo_below') {
    status = 'neo_below';
  } else if (relative === 'non_comparable' && neoScore != null && status === 'pending') {
    status = 'neo_absolute_partial';
  }

  return {
    id: d.id,
    name: d.name,
    status,
    neoScore,
    bailongmaScore,
    relative,
    relativeReason,
    isProxy,
    measurementEquivalent,
    neoInputComplete,
    bailongmaInputComplete,
    lead: recomputed.lead ?? null,
    notes,
  };
});

// Non-soak completion requires actual relative pass labels. A stated
// non_comparable row is visible in the report but never counts as done.
const nonSoakDimensions = dimensions.filter((d) => d.id !== 'D08');
const dimensionSummary = summarizeRelativeDimensions(dimensions);
const nonSoakDimensionSummary = summarizeRelativeDimensions(nonSoakDimensions);
const dimNeoBelow = dimensions.filter((d) => d.relative === 'neo_below');
const d08 = dimensions.find((d) => d.id === 'D08');
const soakOwnerWaived = !soakComplete && d08?.relative === 'pending_owner_waived';
const packagingExternal =
  packaging?.verdict === 'blocked_external' ||
  packaging?.stage?.status === 'blocked_external' ||
  (Array.isArray(packaging?.stage?.externalOnly) && packaging.stage.externalOnly.length > 0);
// Map incomplete soak gates to owner-waived pending, never PASS.
const absoluteGatesForReport = (gateReport.absolute || []).map((g) => {
  if (!soakComplete && (g.id === 'G-SOAK-01' || g.id === 'G-SOAK-02')) {
    return {
      ...g,
      status: 'pending_owner_waived',
      ownerWaived: true,
      note: 'non_soak_goal_terminal_waive_not_pass',
    };
  }
  if (g.id === 'G-FIRST-01' && !gFirstHumanOk) {
    return {
      ...g,
      status: 'blocked_external',
      blockers: [...(g.blockers || []), 'five_real_humans_not_available'],
      note: 'isolated_HOME_supplementary_not_absolute_pass',
    };
  }
  return g;
});
const soakPendingIds = absoluteGatesForReport
  .filter(
    (g) =>
      (g.id === 'G-SOAK-01' || g.id === 'G-SOAK-02') &&
      g.status === 'pending_owner_waived',
  )
  .map((g) => g.id);
const absoluteNonSoak = absoluteGatesForReport.filter(
  (g) => g.id !== 'G-SOAK-01' && g.id !== 'G-SOAK-02',
);
const absoluteSummary = summarizeAbsoluteGates(absoluteGatesForReport);
const absoluteNonSoakSummary = summarizeAbsoluteGates(absoluteNonSoak);
const absoluteNonSoakFail = absoluteNonSoakSummary.fail;
const absoluteNonSoakPending = absoluteNonSoakSummary.pending;

/** @type {string[]} */
const blockedExternal = [];
if (packagingExternal) blockedExternal.push('S8_formal_signing_or_cross_platform');
if (!gFirstHumanOk) blockedExternal.push('G-FIRST_five_real_humans');
const winLinux = readJson(join(evidenceRoot, 'S8/win-linux-build-gates.json'));
if (
  winLinux?.verdict?.includes?.('cross-host') ||
  winLinux?.win?.status === 'BLOCKED_EXTERNAL' ||
  winLinux?.linux?.status === 'BLOCKED_EXTERNAL' ||
  String(winLinux?.win || '').includes?.('not_built')
) {
  blockedExternal.push('win_linux_cross_host_binaries');
}

const candidateStatus = reduceCandidateStatus({
  nonSoakGates: absoluteNonSoak,
  nonSoakDimensions: soakOwnerWaived ? nonSoakDimensions : dimensions,
  blockedExternal,
  soakComplete,
  soakOwnerWaived,
});

const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  planId: matrix.planId,
  sourceDigest: digest || null,
  runtimeConfigDigest: runtimeDig || null,
  bailongmaFixedBaseline: BAILONGMA_FIXED_BASELINE,
  soak: soakProgress,
  metrics,
  metricNotes,
  absoluteGates: absoluteGatesForReport,
  absoluteSummary,
  absoluteNonSoakSummary: {
    ...absoluteNonSoakSummary,
    soakWaived: soakPendingIds,
  },
  allAbsolutePass:
    absoluteSummary.total > 0 && absoluteSummary.pass === absoluteSummary.total,
  dimensions,
  dimensionSummary: {
    ...dimensionSummary,
    d08: d08?.relative || null,
    neoLeads: dimensions.filter((d) => d.relative === 'neo_leads').map((d) => d.id),
    neoNotBelow: dimensions
      .filter((d) => d.relative === 'neo_not_below' || d.relative === 'ceiling_tie')
      .map((d) => d.id),
  },
  packaging: packaging?.verdict || packaging?.stage?.status || null,
  architecture: arch,
  staleEvidenceMarked: staleResult.staleCount,
  candidateStatus,
  readyForCodexValidation: false,
  blockedExternal,
  blockers: [
    !soakComplete
      ? `G-SOAK_pending_owner_waived_wall_clock_${elapsedH.toFixed(2)}h_of_72h`
      : null,
    packagingExternal ? 'packaging_blocked_external_or_incomplete' : null,
    absoluteNonSoakPending > 0 ? `absolute_non_soak_pending_${absoluteNonSoakPending}` : null,
    absoluteNonSoakFail > 0 ? `absolute_gates_fail_${absoluteNonSoakFail}` : null,
    nonSoakDimensionSummary.nonComparable > 0
      ? `relative_non_comparable_${nonSoakDimensionSummary.nonComparable}`
      : null,
    nonSoakDimensionSummary.pending > 0
      ? `relative_pending_${nonSoakDimensionSummary.pending}`
      : null,
    dimNeoBelow.length ? `neo_below_${dimNeoBelow.map((d) => d.id).join(',')}` : null,
    ...blockedExternal.map((b) => `BLOCKED_EXTERNAL:${b}`),
  ].filter(Boolean),
  rule: 'fail_closed_auto_labels_from_scores_no_proxy_D06_D09_D10_D11_no_hardcoded_soak',
  matrixWritten: writeMatrix,
  nonSoakTerminal: candidateStatus === 'non_soak_ready' || candidateStatus === 'partial_owner_waived_soak',
};

// Write matrix after labels/status known (non-soak terminal allowed; never accepted/ready_for_codex)
appliedMatrix.candidate.overallStatus = candidateStatus;
const reportGateById = new Map(absoluteGatesForReport.map((g) => [g.id, g]));
appliedMatrix.absoluteGates = (appliedMatrix.absoluteGates || []).map((g) => {
  const reported = reportGateById.get(g.id);
  if (!reported) return g;
  return {
    ...g,
    status: reported.status,
    blockers: reported.blockers || [],
    ownerWaived: reported.ownerWaived === true,
    note: reported.note || g.note,
  };
});
appliedMatrix.stages = synchronizeStageStatuses(
  appliedMatrix.stages || [],
  appliedMatrix.absoluteGates,
);
report.stageSummary = summarizeStages(appliedMatrix.stages);
if (writeMatrix) {
  // Reflect auto labels + waived soak on matrix dimensions / soak gates
  const dimById = new Map(dimensions.map((x) => [x.id, x]));
  appliedMatrix.dimensions = (appliedMatrix.dimensions || []).map((d) => {
    const r = dimById.get(d.id);
    if (!r) return d;
    return {
      ...d,
      neoScore: r.neoScore,
      bailongmaScore: r.bailongmaScore,
      relative: r.relative,
      relativeReason: r.relativeReason,
      status: r.status,
      isProxy: r.isProxy,
      measurementEquivalent: r.measurementEquivalent,
      neoInputComplete: r.neoInputComplete,
      bailongmaInputComplete: r.bailongmaInputComplete,
      notes: r.notes,
    };
  });
  writeAcceptanceMatrixFile(matrixPath, appliedMatrix);
  report.matrixWritten = true;
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      outPath,
      absoluteSummary: report.absoluteSummary,
      absoluteNonSoakSummary: report.absoluteNonSoakSummary,
      candidateStatus,
      readyForCodexValidation: false,
      blockers: report.blockers,
      blockedExternal,
      matrixWritten: writeMatrix,
      sourceDigest: digest,
    },
    null,
    2,
  ),
);
return report;
}

const isMain =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
