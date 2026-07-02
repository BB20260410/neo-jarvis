#!/usr/bin/env node
// @ts-check
// Noe100Readiness — read-only proof gate for the Noe100 acceptance matrix.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.NOE_100_READINESS_OUT_DIR || join(ROOT, 'output', 'noe-100-readiness');
const DB_PATH = process.env.PANEL_DB_PATH || join(homedir(), '.noe-panel', 'panel.db');
const BASE_URL = (process.env.NOE_PANEL_URL || 'http://127.0.0.1:51835').replace(/\/+$/, '');
const FETCH_TIMEOUT_MS = Math.max(1, Number(process.env.NOE_100_READINESS_FETCH_TIMEOUT_MS || 5000));
const TOOL_MARKETPLACE_DIR = process.env.NOE_TOOL_MARKETPLACE_DIR || '';
const NOW = Date.now();
const ONE_HOUR = 3_600_000;
const ONE_DAY = 86_400_000;
const args = new Set(process.argv.slice(2));
const CONTROLLED_EXPECTATION_SOURCE_RE = /(?:controlled|synthetic|fixture|test|drill|calibration[_-]?sample|calibration[_-]?drill|settlement[_-]?drill)/i;

const { default: Database } = await import('better-sqlite3');

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function latestFile(dir, pred = () => true) {
  const files = walk(dir).filter(pred).map((file) => ({ file, mtimeMs: statSync(file).mtimeMs }));
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0]?.file || '';
}

function latestJsonFile(dir, filePred = () => true, jsonPred = () => true) {
  const files = walk(dir).filter(filePred).map((file) => ({ file, mtimeMs: statSync(file).mtimeMs }));
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const item of files) {
    const json = readJson(item.file);
    if (json && jsonPred(json)) return { file: item.file, json };
  }
  return { file: '', json: null };
}

async function fetchJson(path) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`${BASE_URL}${path}`, { signal: ctrl.signal });
    clearTimeout(timer);
    const text = await res.text();
    return { ok: res.ok, status: res.status, json: text ? JSON.parse(text) : null };
  } catch (e) {
    return { ok: false, status: 0, error: e?.message || String(e), json: null };
  }
}

function openDb() {
  if (!existsSync(DB_PATH)) return null;
  return new Database(DB_PATH, { readonly: true });
}

function scalar(db, sql, params = []) {
  if (!db) return null;
  try { return db.prepare(sql).get(...params); } catch { return null; }
}

function rows(db, sql, params = []) {
  if (!db) return [];
  try { return db.prepare(sql).all(...params); } catch { return []; }
}

function isControlledExpectationSource(source) {
  return CONTROLLED_EXPECTATION_SOURCE_RE.test(String(source || ''));
}

function brier(rows) {
  const scored = rows.filter((r) => r.resolved_at != null && (r.outcome === 0 || r.outcome === 1));
  if (!scored.length) return null;
  return scored.reduce((sum, r) => sum + (Number(r.p) - Number(r.outcome)) ** 2, 0) / scored.length;
}

function summarizeExpectations(expectationRows = []) {
  const scored = expectationRows.filter((r) => r.resolved_at != null && (r.outcome === 0 || r.outcome === 1));
  const naturalRows = expectationRows.filter((r) => !isControlledExpectationSource(r.source));
  const controlledRows = expectationRows.filter((r) => isControlledExpectationSource(r.source));
  const naturalScored = naturalRows.filter((r) => r.resolved_at != null && (r.outcome === 0 || r.outcome === 1));
  const controlledScored = controlledRows.filter((r) => r.resolved_at != null && (r.outcome === 0 || r.outcome === 1));
  const openDueTimes = expectationRows
    .filter((r) => r.due_at != null && r.resolved_at == null)
    .map((r) => Number(r.due_at))
    .filter(Number.isFinite);
  return {
    total: expectationRows.length,
    resolved: scored.length,
    naturalResolved: naturalScored.length,
    controlledResolved: controlledScored.length,
    controlledRows: controlledRows.length,
    oldestDue: openDueTimes.length ? Math.min(...openDueTimes) : null,
    brier: brier(expectationRows),
    brierNatural: brier(naturalRows),
  };
}

function evidence(file, note) {
  return file ? { file: file.startsWith(ROOT) ? file.slice(ROOT.length + 1) : file, note } : null;
}

function rel(file) {
  return file.startsWith(`${ROOT}/`) ? file.slice(ROOT.length + 1) : file;
}

function check(id, ok, details = {}, evidenceRefs = []) {
  return { id, ok: Boolean(ok), details, evidenceRefs: evidenceRefs.filter(Boolean) };
}

function dimension(id, title, checks) {
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;
  const blockers = checks.filter((c) => !c.ok).map((c) => c.id);
  return {
    id,
    title,
    score: checks.length ? Math.round((passed / checks.length) * 100) : 0,
    passed,
    failed,
    blockers,
    checks,
  };
}

async function summarizeToolSurface() {
  const modules = {
    toolRegistry: existsSync(join(ROOT, 'src/capabilities/ToolRegistry.js')),
    builtinReadonlyTools: existsSync(join(ROOT, 'src/capabilities/builtinReadonlyTools.js')),
    freedomManifest: existsSync(join(ROOT, 'src/capabilities/NoeFreedomManifest.js')),
    toolRouter: existsSync(join(ROOT, 'src/capabilities/NoeToolRouter.js')),
    marketplaceRegistry: existsSync(join(ROOT, 'src/runtime/NoeToolMarketplaceRegistry.js')),
  };
  const out = {
    ok: false,
    modules,
    readonlyToolCount: 0,
    readonlyLowRiskCount: 0,
    freedomToolCount: 0,
    commandManifestCount: 0,
    marketplace: {
      ok: false,
      toolCount: 0,
      enabledCount: 0,
      executionEnabledCount: 0,
      error: '',
    },
    policy: {
      readOnly: true,
      noToolExecution: true,
      secretValuesReturned: false,
    },
  };
  try {
    const readonly = await import('../src/capabilities/builtinReadonlyTools.js');
    const tools = Array.isArray(readonly.BUILTIN_READONLY_TOOLS) ? readonly.BUILTIN_READONLY_TOOLS : [];
    out.readonlyToolCount = tools.length;
    out.readonlyLowRiskCount = tools.filter((tool) => tool?.risk_level === 'low' && !tool?.command).length;
  } catch (error) {
    out.readonlyImportError = String(error?.message || error).slice(0, 120);
  }
  try {
    const freedom = await import('../src/capabilities/NoeFreedomManifest.js');
    const freedomTools = typeof freedom.listNoeFreedomTools === 'function' ? freedom.listNoeFreedomTools() : [];
    const commandManifests = typeof freedom.freedomToolsAsCommandManifests === 'function' ? freedom.freedomToolsAsCommandManifests() : [];
    out.freedomToolCount = Array.isArray(freedomTools) ? freedomTools.length : 0;
    out.commandManifestCount = Array.isArray(commandManifests) ? commandManifests.length : 0;
  } catch (error) {
    out.freedomImportError = String(error?.message || error).slice(0, 120);
  }
  try {
    const market = await import('../src/runtime/NoeToolMarketplaceRegistry.js');
    const listed = typeof market.listNoeMarketplaceTools === 'function'
      ? market.listNoeMarketplaceTools(TOOL_MARKETPLACE_DIR ? { dir: TOOL_MARKETPLACE_DIR } : {})
      : { ok: false, tools: [] };
    const tools = Array.isArray(listed.tools) ? listed.tools : [];
    out.marketplace = {
      ok: listed.ok === true,
      toolCount: tools.length,
      enabledCount: tools.filter((tool) => tool?.state === 'enabled').length,
      executionEnabledCount: tools.filter((tool) => tool?.executionEnabled === true).length,
      error: listed.error ? String(listed.error).slice(0, 120) : '',
    };
  } catch (error) {
    out.marketplace.error = String(error?.message || error).slice(0, 120);
  }
  const allModules = Object.values(out.modules).every(Boolean);
  out.ok = allModules
    && out.readonlyToolCount > 0
    && out.readonlyLowRiskCount === out.readonlyToolCount
    && out.freedomToolCount > 0
    && out.commandManifestCount >= out.freedomToolCount
    && out.marketplace.ok
    && out.marketplace.executionEnabledCount === 0;
  return out;
}

const db = openDb();
const health = await fetchJson('/health');
const readiness = await fetchJson('/api/noe/readiness');
const toolSurface = await summarizeToolSurface();
const readinessStatus = readiness.json?.readiness?.status || readiness.json?.health?.status || null;
const readinessCounts = readiness.json?.counts || null;
const readinessChecks = readiness.json?.checks || readiness.json?.readiness?.checks || null;

const recentDoneTick = scalar(db, 'SELECT id, kind, finished_at FROM noe_ticks WHERE status = ? ORDER BY finished_at DESC LIMIT 1', ['done']);
const failedTicks1h = scalar(db, 'SELECT COUNT(*) AS n FROM noe_ticks WHERE status = ? AND COALESCE(finished_at, started_at, due_at, 0) >= ?', ['failed', NOW - ONE_HOUR])?.n || 0;
const failedTickWindowRows = rows(db, `
  SELECT
    kind,
    COUNT(*) AS n,
    MIN(COALESCE(finished_at, started_at, due_at, 0)) AS oldestAt,
    MAX(COALESCE(finished_at, started_at, due_at, 0)) AS latestAt
  FROM noe_ticks
  WHERE status = ? AND COALESCE(finished_at, started_at, due_at, 0) >= ?
  GROUP BY kind
  ORDER BY kind
`, ['failed', NOW - ONE_HOUR]);
const latestFailedTickAt = failedTickWindowRows.reduce((max, row) => Math.max(max, Number(row.latestAt) || 0), 0) || null;
const failedTickNextClearAt = latestFailedTickAt ? latestFailedTickAt + ONE_HOUR : null;
const activeDays = scalar(db, "SELECT COUNT(DISTINCT substr(datetime(ts / 1000, 'unixepoch'), 1, 10)) AS n FROM events WHERE kind = 'noe_episode'")?.n || 0;
const inner24 = scalar(db, "SELECT COUNT(*) AS n, MAX(ts) AS lastTs FROM events WHERE kind = 'noe_episode' AND (tag = 'inner_monologue' OR json_extract(payload,'$.episodeType') = 'inner_monologue') AND ts >= ?", [NOW - ONE_DAY]) || { n: 0, lastTs: null };
const grounded = scalar(db, "SELECT COUNT(*) AS n FROM events WHERE kind = 'noe_episode' AND (tag = 'inner_monologue' OR json_extract(payload,'$.episodeType') = 'inner_monologue') AND json_extract(payload,'$.meta.grounding') IS NOT NULL")?.n || 0;
const focusCount = scalar(db, 'SELECT COUNT(*) AS n FROM noe_focus_stack')?.n || 0;
const expectationRows = rows(db, 'SELECT source, p, due_at, resolved_at, outcome FROM noe_expectations');
const exp = summarizeExpectations(expectationRows);
const acts = scalar(db, 'SELECT COUNT(*) AS total, SUM(CASE WHEN updated_at >= ? THEN 1 ELSE 0 END) AS recent, SUM(CASE WHEN evidence_event_id IS NOT NULL OR log_ref != ? THEN 1 ELSE 0 END) AS withEvidence, SUM(CASE WHEN status IN (?, ?) THEN 1 ELSE 0 END) AS inFlight FROM noe_acts', [NOW - ONE_DAY, '', 'running', 'executing']) || {};
const latestSelfLearning = scalar(db, "SELECT id, title, status, updated_at FROM noe_goals WHERE source = 'self_learning' ORDER BY updated_at DESC LIMIT 1") || null;
const selfLearningDone = scalar(db, "SELECT id, title, status, updated_at FROM noe_goals WHERE source = 'self_learning' AND status = 'done' ORDER BY updated_at DESC LIMIT 1") || null;
const checkpoint = scalar(db, 'SELECT COUNT(*) AS total, SUM(CASE WHEN evidence_ref IS NOT NULL AND evidence_ref != ? THEN 1 ELSE 0 END) AS withEvidence FROM noe_goal_checkpoints', ['']) || {};
const checkpointWorkflow = scalar(db, `
  SELECT
    COUNT(*) AS actionCheckpoints,
    SUM(CASE WHEN json_extract(payload, '$.workflow.schemaVersion') IS NOT NULL THEN 1 ELSE 0 END) AS withWorkflow,
    SUM(CASE WHEN json_extract(payload, '$.workflow.idempotencyKey') IS NOT NULL AND json_extract(payload, '$.workflow.idempotencyKey') != '' THEN 1 ELSE 0 END) AS withIdempotency,
    SUM(CASE WHEN json_extract(payload, '$.workflow.resumeCursor.checkpointId') IS NOT NULL AND json_extract(payload, '$.workflow.resumeCursor.checkpointId') != '' THEN 1 ELSE 0 END) AS withResumeCursor
  FROM noe_goal_checkpoints
  WHERE kind = 'act'
`) || {};
const checkpointEvidenceWorkflow = scalar(db, `
  SELECT
    COUNT(*) AS actionEvidenceCheckpoints,
    SUM(CASE WHEN json_extract(payload, '$.workflow.sideEffectFingerprint') IS NOT NULL AND json_extract(payload, '$.workflow.sideEffectFingerprint') != '' THEN 1 ELSE 0 END) AS withSideEffectFingerprint,
    SUM(CASE WHEN json_extract(payload, '$.workflow.rollbackEvidence.required') = 1 AND json_extract(payload, '$.workflow.rollbackEvidence.status') = 'available' THEN 1 ELSE 0 END) AS rollbackAvailable,
    SUM(CASE WHEN json_extract(payload, '$.workflow.rollbackEvidence.required') = 1 AND json_extract(payload, '$.workflow.rollbackEvidence.status') != 'available' THEN 1 ELSE 0 END) AS rollbackRequiredMissing,
    SUM(CASE WHEN json_extract(payload, '$.workflow.rollbackEvidence.status') IS NOT NULL THEN 1 ELSE 0 END) AS withRollbackPolicy
  FROM noe_goal_checkpoints
  WHERE kind = 'act' AND phase = 'evidence'
`) || {};
const insight = scalar(db, "SELECT COUNT(*) AS total, SUM(CASE WHEN updated_at > created_at THEN 1 ELSE 0 END) AS revised FROM noe_memory WHERE scope = 'insight' AND hidden = 0") || {};

const latestP0 = latestFile(join(ROOT, 'output', 'ce12-p0'), (f) => /p0-verify-all.*\.json$/.test(f));
const latestCognitive = latestFile(join(ROOT, 'output'), (f) => /output\/noe-(cognitive-runtime|cognitive-verify|full-current|external-readiness)\/.+\.json$/.test(f));
const latestSideEffectDrill = latestFile(join(ROOT, 'output', 'noe-controlled-side-effect-drill'), (f) => /\/report\.json$/.test(f));
const sideEffectDrillReport = latestSideEffectDrill ? readJson(latestSideEffectDrill) : null;
const sideEffectDrillOk = Boolean(
  sideEffectDrillReport?.ok === true
  && sideEffectDrillReport?.applied === true
  && sideEffectDrillReport?.actionEvidence?.dryRunOnly === false
  && sideEffectDrillReport?.sideEffect?.externalSideEffectPerformed === true
  && sideEffectDrillReport?.sideEffect?.writeVerified === true
  && sideEffectDrillReport?.rollback?.performed === true
  && sideEffectDrillReport?.rollback?.verified === true
  && sideEffectDrillReport?.validation?.ok === true
);
const latestExpectationDrill = latestFile(join(ROOT, 'output', 'noe-expectation-settlement-drill'), (f) => /\/report\.json$/.test(f));
const expectationDrillReport = latestExpectationDrill ? readJson(latestExpectationDrill) : null;
const expectationDrillOk = Boolean(
  expectationDrillReport?.ok === true
  && expectationDrillReport?.liveDbMutated === false
  && Number(expectationDrillReport?.sampleCount || 0) >= 20
  && Number(expectationDrillReport?.resolvedCount || 0) >= 20
  && Number(expectationDrillReport?.unresolvedCount || 0) === 0
  && Number(expectationDrillReport?.brier?.n || 0) >= 20
  && Number.isFinite(Number(expectationDrillReport?.brier?.brier))
);
const latestModelUnloadDrillHit = latestJsonFile(
  join(ROOT, 'output', 'noe-model-unload-recovery-drill'),
  (f) => /\/report\.json$/.test(f),
  (report) => report?.loadedSnapshots?.before?.source === 'lmstudio:/api/v0/models'
    && report?.loadedSnapshots?.after?.source === 'lmstudio:/api/v0/models',
);
const latestModelUnloadDrill = latestModelUnloadDrillHit.file;
const modelUnloadDrillReport = latestModelUnloadDrillHit.json;
const modelUnloadRecoveryDrillOk = Boolean(
  modelUnloadDrillReport?.ok === true
  && modelUnloadDrillReport?.scenario === 'controlled_model_unloaded_error_recovery'
  && modelUnloadDrillReport?.modelUnloadedDetected === true
  && modelUnloadDrillReport?.modelUnloadedIssue === 'model_unloaded'
  && modelUnloadDrillReport?.backupParticipantUsed === true
  && modelUnloadDrillReport?.quorum?.ok === true
  && Number(modelUnloadDrillReport?.quorum?.availableCount || 0) >= 2
  && modelUnloadDrillReport?.lmStudioStateReadOnly === true
  && modelUnloadDrillReport?.lmStudioLoadUnloadCommandsIssued === false
  && modelUnloadDrillReport?.lmStudioLoadUnloadChanged === false
  && modelUnloadDrillReport?.lmStudioStateEqual === true
  && modelUnloadDrillReport?.ledgerSafe?.ok === true
);
const latestRuntimeRestartDrillHit = latestJsonFile(
  join(ROOT, 'output', 'noe-runtime-restart-recovery-drill'),
  (f) => /\/report\.json$/.test(f),
  (report) => report?.mode === 'real' && report?.applied === true && report?.realRestartAttempted === true,
);
const latestRuntimeRestartDrill = latestRuntimeRestartDrillHit.file;
const runtimeRestartDrillReport = latestRuntimeRestartDrillHit.json;
const runtimeRestartDrillOk = Boolean(
  runtimeRestartDrillReport?.ok === true
  && runtimeRestartDrillReport?.checks?.pidChanged === true
  && runtimeRestartDrillReport?.checks?.oldPidAbsent === true
  && runtimeRestartDrillReport?.checks?.newPidCwdIsRoot === true
  && runtimeRestartDrillReport?.checks?.port51735Untouched === true
  && runtimeRestartDrillReport?.checks?.lmStudioLoadedModelsUnchanged === true
  && runtimeRestartDrillReport?.checks?.healthOk === true
  && runtimeRestartDrillReport?.checks?.readinessPassed === true
  && runtimeRestartDrillReport?.checks?.freedomLiveOk === true
);
const latestActRecoveryDrillHit = latestJsonFile(
  join(ROOT, 'output', 'noe-act-recovery-drill'),
  (f) => /\/report\.json$/.test(f),
  (report) => report?.scenario === 'act_failure_and_approval_wait_recovery'
    && report?.liveDbMutated === false,
);
const latestActRecoveryDrill = latestActRecoveryDrillHit.file;
const actRecoveryDrillReport = latestActRecoveryDrillHit.json;
const actRecoveryDrillOk = Boolean(
  actRecoveryDrillReport?.ok === true
  && actRecoveryDrillReport?.liveDbMutated === false
  && actRecoveryDrillReport?.failedAct?.firstStatus === 'failed'
  && actRecoveryDrillReport?.failedAct?.recoveredStatus === 'completed'
  && Number(actRecoveryDrillReport?.failedAct?.executorAttempts || 0) === 2
  && Number(actRecoveryDrillReport?.failedAct?.executedEventCount || 0) === 1
  && actRecoveryDrillReport?.failedAct?.actionEvidenceValid === true
  && actRecoveryDrillReport?.failedAct?.checkpointWorkflowReady === true
  && actRecoveryDrillReport?.approvalWait?.firstStatus === 'awaiting_approval'
  && actRecoveryDrillReport?.approvalWait?.resumedStatusBeforeApproval === 'awaiting_approval'
  && actRecoveryDrillReport?.approvalWait?.sameApprovalAfterRestart === true
  && Number(actRecoveryDrillReport?.approvalWait?.approvalCountAfterRestart || 0) === 1
  && Number(actRecoveryDrillReport?.approvalWait?.executorCallsBeforeApproval ?? -1) === 0
  && actRecoveryDrillReport?.approvalWait?.approvedStatus === 'approved'
  && actRecoveryDrillReport?.approvalWait?.finalStatus === 'completed'
  && Number(actRecoveryDrillReport?.approvalWait?.finalExecutorCalls || 0) === 1
  && Number(actRecoveryDrillReport?.approvalWait?.executedEventCount || 0) === 1
  && actRecoveryDrillReport?.approvalWait?.actionEvidenceValid === true
  && actRecoveryDrillReport?.approvalWait?.checkpointWorkflowReady === true
);
const matrixFile = join(ROOT, 'docs', 'NOE_100_ACCEPTANCE_MATRIX.md');
const scriptFile = join(ROOT, 'scripts', 'noe-100-readiness.mjs');
const actionCheckpointCount = Number(checkpointWorkflow.actionCheckpoints || 0);
const actionEvidenceCheckpointCount = Number(checkpointEvidenceWorkflow.actionEvidenceCheckpoints || 0);
const goalResumeReady = actionCheckpointCount > 0
  && Number(checkpointWorkflow.withWorkflow || 0) === actionCheckpointCount
  && Number(checkpointWorkflow.withIdempotency || 0) === actionCheckpointCount
  && Number(checkpointWorkflow.withResumeCursor || 0) === actionCheckpointCount
  && actionEvidenceCheckpointCount > 0
  && Number(checkpointEvidenceWorkflow.withSideEffectFingerprint || 0) === actionEvidenceCheckpointCount;
const rollbackPolicyReady = actionEvidenceCheckpointCount > 0
  && Number(checkpointEvidenceWorkflow.withRollbackPolicy || 0) === actionEvidenceCheckpointCount
  && Number(checkpointEvidenceWorkflow.rollbackRequiredMissing || 0) === 0;
const rollbackSampleReady = (rollbackPolicyReady && Number(checkpointEvidenceWorkflow.rollbackAvailable || 0) > 0) || sideEffectDrillOk;
const liveResolvedExpectations = Number(exp.resolved || 0);
const naturalLiveResolvedExpectations = Number(exp.naturalResolved || 0);
const controlledResolvedExpectations = expectationDrillOk ? Number(expectationDrillReport?.resolvedCount || 0) : 0;
const controlledLiveResolvedExpectations = Number(exp.controlledResolved || 0);
const expectationSettlementReady = naturalLiveResolvedExpectations >= 20;

const dimensions = [
  dimension('survival', '生存', [
    check('live_health_ok', health.ok && health.json?.ok === true, { status: health.status }, [evidence('GET /health', 'public live health')]),
    check('live_readiness_ok', readiness.ok && readinessStatus === 'passed', { status: readiness.status, readinessStatus }, [evidence('GET /api/noe/readiness', 'public live readiness')]),
    check('recent_done_tick_10m', recentDoneTick && NOW - Number(recentDoneTick.finished_at || 0) <= 10 * 60_000, { recentDoneTick }, [evidence(DB_PATH, 'noe_ticks')]),
    check('active_days_at_least_1', activeDays >= 1, { activeDays }, [evidence(DB_PATH, 'events kind=noe_episode')]),
    check('not_enough_soak_evidence', activeDays >= 7, { activeDays, requiredDays: 7 }, [evidence(DB_PATH, 'events active day coverage')]),
  ]),
  dimension('thinking', '思考', [
    check('inner_monologue_recent_24h', Number(inner24.n || 0) > 0, inner24, [evidence(DB_PATH, 'events inner_monologue')]),
    check('inner_monologue_grounding_sampled', grounded > 0, { grounded }, [evidence(DB_PATH, 'events meta.grounding')]),
    check('workspace_focus_recorded', focusCount > 0, { focusCount }, [evidence(DB_PATH, 'noe_focus_stack')]),
    check('expectation_ledger_has_fuel', Number(exp.total || 0) > 0, exp, [evidence(DB_PATH, 'noe_expectations')]),
    check('groundedness_trend_available', grounded >= 10, { grounded, requiredSamples: 10 }, [evidence(DB_PATH, 'events meta.grounding')]),
  ]),
  dimension('acting', '行动', [
    check('act_ledger_exists', Number(acts.total || 0) > 0, acts, [evidence(DB_PATH, 'noe_acts')]),
    check('recent_act_24h', Number(acts.recent || 0) > 0, acts, [evidence(DB_PATH, 'noe_acts updated_at')]),
    check('act_evidence_refs_exist', Number(acts.withEvidence || 0) > 0, acts, [evidence(DB_PATH, 'noe_acts evidence_event_id/log_ref')]),
    check('tool_surface_health_visible', toolSurface.ok, toolSurface, [
      evidence(join(ROOT, 'src/capabilities/ToolRegistry.js'), 'tool registry module'),
      evidence(join(ROOT, 'src/capabilities/NoeFreedomManifest.js'), 'freedom manifest command surface'),
      evidence(join(ROOT, 'src/runtime/NoeToolMarketplaceRegistry.js'), 'marketplace registry read-only listing'),
    ]),
    check('self_learning_done', selfLearningDone?.status === 'done', { latest: latestSelfLearning, latestDone: selfLearningDone }, [evidence(DB_PATH, 'latest done self_learning goal')]),
    check('no_real_external_side_effect_replay', sideEffectDrillOk, {
      latestDrill: latestSideEffectDrill ? latestSideEffectDrill.slice(ROOT.length + 1) : null,
      sideEffectKind: sideEffectDrillReport?.sideEffect?.kind || null,
      writeVerified: sideEffectDrillReport?.sideEffect?.writeVerified === true,
      rollbackVerified: sideEffectDrillReport?.rollback?.verified === true,
      publicNetworkSideEffect: sideEffectDrillReport?.sideEffect?.publicNetworkSideEffect === true,
      reason: sideEffectDrillOk ? 'controlled local side effect plus rollback verified' : 'requires controlled real side effect plus rollback evidence',
    }, [evidence(latestSideEffectDrill, 'controlled side-effect drill report')]),
  ]),
  dimension('reflection', '记录反思', [
    check('insight_memory_exists', Number(insight.total || 0) > 0, insight, [evidence(DB_PATH, 'noe_memory scope=insight')]),
    check('insight_revised_by_evidence', Number(insight.revised || 0) > 0, insight, [evidence(DB_PATH, 'noe_memory updated_at > created_at')]),
    check('expectations_recorded', Number(exp.total || 0) > 0, exp, [evidence(DB_PATH, 'noe_expectations')]),
    check('expectation_settlements_below_20', expectationSettlementReady, {
      liveResolved: liveResolvedExpectations,
      naturalLiveResolved: naturalLiveResolvedExpectations,
      controlledLiveResolved: controlledLiveResolvedExpectations,
      controlledResolved: controlledResolvedExpectations,
      controlledMechanismReady: expectationDrillOk,
      required: 20,
      source: expectationSettlementReady ? 'natural_live_noe_expectations' : 'natural_live_noe_expectations_below_threshold',
      latestDrill: latestExpectationDrill ? latestExpectationDrill.slice(ROOT.length + 1) : null,
      liveDbMutated: expectationDrillReport?.liveDbMutated ?? null,
      brier: {
        liveBrier: exp.brier ?? null,
        naturalLiveBrier: exp.brierNatural ?? null,
        controlledDrillBrier: expectationDrillOk ? expectationDrillReport?.brier : null,
      },
      reason: expectationSettlementReady
        ? 'natural live expectation settlements reached the long-term threshold'
        : expectationDrillOk
          ? 'controlled drill proves mechanism only; long-term Noe100 readiness still requires natural live resolved rows'
          : 'requires natural live expectation settlements',
    }, [evidence(DB_PATH, 'noe_expectations resolved'), evidence(latestExpectationDrill, 'controlled expectation settlement drill report')]),
    check('brier_available', Number.isFinite(Number(exp.brier)), { brier: exp.brier ?? null }, [evidence(DB_PATH, 'noe_expectations brier')]),
  ]),
  dimension('stability', '稳定', [
    check('cluster_readiness_passed', readinessStatus === 'passed', { readinessStatus }, [evidence('GET /api/noe/readiness', 'readiness status')]),
    check('no_failed_ticks_last_hour', failedTicks1h === 0, {
      failedTicks1h,
      byKind: failedTickWindowRows.map((row) => ({
        kind: row.kind,
        count: Number(row.n) || 0,
        oldestAt: Number(row.oldestAt) || null,
        latestAt: Number(row.latestAt) || null,
      })),
      latestFailedTickAt,
      latestFailedTickAtIso: latestFailedTickAt ? new Date(latestFailedTickAt).toISOString() : null,
      nextClearAt: failedTickNextClearAt,
      nextClearAtIso: failedTickNextClearAt ? new Date(failedTickNextClearAt).toISOString() : null,
      secondsUntilClear: failedTickNextClearAt ? Math.max(0, Math.ceil((failedTickNextClearAt - NOW) / 1000)) : 0,
      note: failedTicks1h
        ? 'diagnostic is redacted: kind/count/timestamps only; no tick intent/outcome/error text'
        : 'no failed ticks in the last hour',
    }, [evidence(DB_PATH, 'noe_ticks failures')]),
    check('no_inflight_act_backlog', Number(acts.inFlight || 0) === 0, { inFlight: acts.inFlight || 0 }, [evidence(DB_PATH, 'noe_acts status')]),
    check('p0_report_available', Boolean(latestP0), { latestP0: latestP0 ? latestP0.slice(ROOT.length + 1) : null }, [evidence(latestP0, 'latest p0 report')]),
    check('runtime_restart_recovery_drill', runtimeRestartDrillOk, {
      latestDrill: latestRuntimeRestartDrill ? latestRuntimeRestartDrill.slice(ROOT.length + 1) : null,
      oldPid: runtimeRestartDrillReport?.before?.port51835?.listeners?.[0]?.pid || null,
      newPid: runtimeRestartDrillReport?.after?.port51835?.listeners?.[0]?.pid || null,
      newPidCwd: runtimeRestartDrillReport?.after?.port51835?.listeners?.[0]?.cwd || null,
      port51735: runtimeRestartDrillReport?.after?.port51735?.listeners?.[0] || null,
      loadedModelsBefore: runtimeRestartDrillReport?.before?.lmStudio?.loadedModels || null,
      loadedModelsAfter: runtimeRestartDrillReport?.after?.lmStudio?.loadedModels || null,
      checks: runtimeRestartDrillReport?.checks || null,
      reason: runtimeRestartDrillOk
        ? 'real 51835 restart recovery verified; 51735 and LM Studio loaded models unchanged'
        : 'requires real --apply runtime restart drill with health/readiness/freedom-live evidence',
    }, [evidence(latestRuntimeRestartDrill, 'controlled runtime restart recovery drill report')]),
    check('no_model_unload_recovery_drill', modelUnloadRecoveryDrillOk, {
      latestDrill: latestModelUnloadDrill ? latestModelUnloadDrill.slice(ROOT.length + 1) : null,
      scenario: modelUnloadDrillReport?.scenario || null,
      modelUnloadedDetected: modelUnloadDrillReport?.modelUnloadedDetected === true,
      backupParticipantUsed: modelUnloadDrillReport?.backupParticipantUsed === true,
      quorum: modelUnloadDrillReport?.quorum || null,
      lmStudioStateReadOnly: modelUnloadDrillReport?.lmStudioStateReadOnly === true,
      lmStudioLoadUnloadCommandsIssued: modelUnloadDrillReport?.lmStudioLoadUnloadCommandsIssued === true,
      lmStudioLoadUnloadChanged: modelUnloadDrillReport?.lmStudioLoadUnloadChanged ?? null,
      loadedModelsBefore: modelUnloadDrillReport?.loadedModelsBefore || null,
      loadedModelsAfter: modelUnloadDrillReport?.loadedModelsAfter || null,
      reason: modelUnloadRecoveryDrillOk
        ? 'controlled model_unloaded error recovery verified without changing LM Studio loaded models'
        : 'requires model_unloaded recovery evidence and unchanged LM Studio loaded-model snapshot',
    }, [evidence(latestModelUnloadDrill, 'controlled model_unloaded recovery drill report')]),
  ]),
  dimension('observability', '观测', [
    check('acceptance_matrix_exists', existsSync(matrixFile), { file: 'docs/NOE_100_ACCEPTANCE_MATRIX.md' }, [evidence(matrixFile, 'matrix')]),
    check('readiness_script_exists', existsSync(scriptFile), { file: 'scripts/noe-100-readiness.mjs' }, [evidence(scriptFile, 'script')]),
    check('live_readiness_counts_visible', Boolean(readinessCounts || readinessChecks), { hasCounts: Boolean(readinessCounts), hasChecks: Boolean(readinessChecks) }, [evidence('GET /api/noe/readiness', 'counts/checks')]),
    check('recent_cognitive_or_full_report_available', Boolean(latestCognitive), { latestReport: latestCognitive ? latestCognitive.slice(ROOT.length + 1) : null }, [evidence(latestCognitive, 'latest cognitive/full report')]),
    check('evidence_refs_non_empty', Number(acts.withEvidence || 0) + Number(checkpoint.withEvidence || 0) > 0, { actEvidence: acts.withEvidence || 0, checkpointEvidence: checkpoint.withEvidence || 0 }, [evidence(DB_PATH, 'evidence refs')]),
  ]),
  dimension('recoverability', '恢复', [
    check('goal_checkpoints_exist', Number(checkpoint.total || 0) > 0, checkpoint, [evidence(DB_PATH, 'noe_goal_checkpoints')]),
    check('goal_checkpoint_evidence_refs_exist', Number(checkpoint.withEvidence || 0) > 0, checkpoint, [evidence(DB_PATH, 'noe_goal_checkpoints evidence_ref')]),
    check('runtime_recovery_clean', readinessStatus === 'passed', { readinessStatus }, [evidence('GET /api/noe/readiness', 'runtime recovery proxy')]),
    check('goal_resume_idempotency_complete', goalResumeReady, { checkpointWorkflow, checkpointEvidenceWorkflow }, [evidence(DB_PATH, 'noe_goal_checkpoints payload.workflow')]),
    check('rollback_evidence_not_complete', rollbackSampleReady, {
      checkpointEvidenceWorkflow,
      controlledSideEffectDrill: latestSideEffectDrill ? {
        report: latestSideEffectDrill.slice(ROOT.length + 1),
        ok: sideEffectDrillOk,
        rollbackVerified: sideEffectDrillReport?.rollback?.verified === true,
      } : null,
      reason: rollbackSampleReady
        ? 'rollback sample available'
        : rollbackPolicyReady ? 'requires at least one controlled rollback evidence sample' : 'rollback policy coverage incomplete',
    }, [evidence(DB_PATH, 'noe_goal_checkpoints payload.workflow.rollbackEvidence'), evidence(latestSideEffectDrill, 'controlled rollback drill report')]),
    check('act_failure_approval_wait_recovery_drill', actRecoveryDrillOk, {
      latestDrill: latestActRecoveryDrill ? latestActRecoveryDrill.slice(ROOT.length + 1) : null,
      failedAct: actRecoveryDrillReport?.failedAct ? {
        firstStatus: actRecoveryDrillReport.failedAct.firstStatus || null,
        recoveredStatus: actRecoveryDrillReport.failedAct.recoveredStatus || null,
        executorAttempts: actRecoveryDrillReport.failedAct.executorAttempts || null,
        executedEventCount: actRecoveryDrillReport.failedAct.executedEventCount || null,
        actionEvidenceValid: actRecoveryDrillReport.failedAct.actionEvidenceValid === true,
      } : null,
      approvalWait: actRecoveryDrillReport?.approvalWait ? {
        firstStatus: actRecoveryDrillReport.approvalWait.firstStatus || null,
        resumedStatusBeforeApproval: actRecoveryDrillReport.approvalWait.resumedStatusBeforeApproval || null,
        sameApprovalAfterRestart: actRecoveryDrillReport.approvalWait.sameApprovalAfterRestart === true,
        approvalCountAfterRestart: actRecoveryDrillReport.approvalWait.approvalCountAfterRestart || null,
        executorCallsBeforeApproval: actRecoveryDrillReport.approvalWait.executorCallsBeforeApproval ?? null,
        finalStatus: actRecoveryDrillReport.approvalWait.finalStatus || null,
        finalExecutorCalls: actRecoveryDrillReport.approvalWait.finalExecutorCalls || null,
        actionEvidenceValid: actRecoveryDrillReport.approvalWait.actionEvidenceValid === true,
      } : null,
      reason: actRecoveryDrillOk
        ? 'isolated failed-act retry and approval-wait resume semantics verified'
        : 'requires isolated act failure / approval wait recovery drill report',
    }, [evidence(latestActRecoveryDrill, 'controlled act failure and approval wait recovery drill report')]),
  ]),
];

const flatChecks = dimensions.flatMap((d) => d.checks.map((c) => ({ ...c, dimension: d.id })));
const failedChecks = flatChecks.filter((c) => !c.ok);
const evidenceRefs = flatChecks.flatMap((c) => c.evidenceRefs || []);
// 治理整改(GPT5.5 印证:100-readiness=100 易被误读成"全系统健康")：score/passed 仅覆盖 Noe100 验收矩阵证据门,
//   不含 runtime-evidence 的活体 blocker(curiosity_harvest/affect_health 等)。联动读 runtime-evidence latest.json,
//   把 runtime blocker 进 summary + 加 scope/caveat,避免满分误导决策。read-only,不改算分,只补诚实范围标注。
const runtimeEvidence = readJson(join(ROOT, 'output', 'noe-runtime-evidence', 'latest.json'));
const runtimeBlockers = Array.isArray(runtimeEvidence?.summary?.blockers)
  ? runtimeEvidence.summary.blockers
  : (Array.isArray(runtimeEvidence?.blockers) ? runtimeEvidence.blockers : []);
const summary = {
  ok: true,
  scope: 'noe100_acceptance_matrix_proof_gate',
  passed: failedChecks.length === 0,
  readyFor100: failedChecks.length === 0,
  caveat: (failedChecks.length === 0 && runtimeBlockers.length)
    ? `验收矩阵证据门通过,但存在 ${runtimeBlockers.length} 个 runtime 活体 blocker(${runtimeBlockers.join(', ')})——score/passed 仅代表验收矩阵证据门,不代表全系统健康,见 verify:noe:runtime-evidence`
    : 'score/passed 仅覆盖 Noe100 验收矩阵证据门,非全系统健康判定',
  runtimeBlockers,
  score: Math.round(dimensions.reduce((sum, d) => sum + d.score, 0) / dimensions.length),
  passedChecks: flatChecks.length - failedChecks.length,
  failedChecks: failedChecks.length,
  blockers: failedChecks.map((c) => c.id),
  evidenceRefs,
  dimensions: Object.fromEntries(dimensions.map((d) => [d.id, d])),
  source: {
    dbPath: DB_PATH,
    baseUrl: BASE_URL,
    generatedAt: new Date(NOW).toISOString(),
    policy: 'read-only; no .env; no owner token; no model calls',
  },
};

mkdirSync(OUT_DIR, { recursive: true });
const reportPath = join(OUT_DIR, `noe-100-readiness-${NOW}.json`);
const latestPath = join(OUT_DIR, 'latest.json');
const body = `${JSON.stringify(summary, null, 2)}\n`;
writeFileSync(reportPath, body, { mode: 0o600 });
writeFileSync(latestPath, body, { mode: 0o600 });
console.log(JSON.stringify({ ...summary, reportPath: rel(reportPath), latestPath: rel(latestPath) }, null, 2));

if (args.has('--require-pass') && !summary.passed) process.exitCode = 1;
