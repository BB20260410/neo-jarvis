#!/usr/bin/env node
// @ts-check
// P7-H0: attribute self-maintenance failure modes to goals, acts, checkpoints, and reports.
// Read-only: no DB writes, no live ports, no model calls, no secret files.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = homedir();
export const DEFAULT_DB_PATH = process.env.PANEL_DB_PATH || join(HOME, '.noe-panel', 'panel.db');
export const DEFAULT_SOURCE_REPORT = join(ROOT, 'output', 'noe-self-maintenance-end2end', 'latest.json');
export const DEFAULT_OUT_DIR = join(ROOT, 'output', 'noe-failure-modes-attribution');
const SECRET_LIKE = /\b(?:sk|sk-cp|sk-ant|AIza|ghp|github_pat|xox[baprs]|tp-c[0-9a-z]+)[A-Za-z0-9._~+/=-]{8,}\b/gi;
const LONG_TOKEN = /\b[A-Za-z0-9_=-]{32,}\b/g;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function rel(file) {
  const abs = resolve(file);
  return abs.startsWith(ROOT) ? relative(ROOT, abs).replace(/\\/g, '/') : abs;
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function redactText(value, max = 180) {
  return String(value || '')
    .replace(SECRET_LIKE, '[redacted-secret]')
    .replace(EMAIL, '[redacted-email]')
    .replace(LONG_TOKEN, '[redacted-id]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function safeId(kind, id) {
  if (!id) return null;
  return `${kind}_${createHash('sha256').update(String(id)).digest('hex').slice(0, 12)}`;
}

function safeJson(value, fallback = null) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '')); } catch { return fallback; }
}

function normalizeStatus(value) {
  const s = String(value || '').trim().toLowerCase();
  if (s === 'completed' || s === 'complete' || s === 'success') return 'done';
  if (s === 'error') return 'failed';
  return s || 'unknown';
}

function tableExists(db, name) {
  try { return Boolean(db?.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)); } catch { return false; }
}

function all(db, sql, params = []) {
  try { return db?.prepare(sql).all(...params) || []; } catch { return []; }
}

function uniq(values, limit = 50) {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

function sqliteRef(table, id, kind = table) {
  if (id === null || id === undefined || id === '') return null;
  const n = Number(id);
  if (Number.isFinite(n) && String(id).trim() !== '') return `sqlite:${table}/${n}`;
  return `sqlite:${table}/${safeId(kind, id)}`;
}

function newestNestedReport(rootDir) {
  const root = resolve(rootDir);
  if (!existsSync(root)) return null;
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const candidate = entry.isDirectory() ? join(root, entry.name, 'report.json') : join(root, entry.name);
    if (existsSync(candidate) && candidate.endsWith('.json')) files.push(candidate);
  }
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] || null;
}

function relatedReports() {
  const candidates = [
    'output/noe-model-health/latest.json',
    'output/noe-action-evidence-spine/latest.json',
    'output/noe-goal-checkpoint-workflow/latest.json',
    'output/noe-thought-grounding-repair/latest.json',
    newestNestedReport(join(ROOT, 'output', 'noe-act-recovery-drill')),
    newestNestedReport(join(ROOT, 'output', 'noe-runtime-restart-recovery-drill')),
    newestNestedReport(join(ROOT, 'output', 'noe-model-unload-recovery-drill')),
  ].filter(Boolean);
  return candidates.filter((file) => existsSync(file)).map((file) => {
    const parsed = readJson(file) || {};
    return { ref: rel(file), ok: parsed.ok ?? parsed.passed ?? null, generatedAt: parsed.generatedAt || parsed.generatedAtIso || null };
  });
}

function openReadonlyDb(dbPath = DEFAULT_DB_PATH, DatabaseCtor = Database) {
  const resolved = resolve(dbPath);
  if (!existsSync(resolved)) return { db: null, path: resolved, exists: false };
  return { db: new DatabaseCtor(resolved, { readonly: true, fileMustExist: true }), path: resolved, exists: true };
}

function goalFacts(db) {
  if (!tableExists(db, 'noe_goals')) return [];
  const rows = all(db, 'SELECT id, source, title, status, plan, created_at, updated_at FROM noe_goals ORDER BY updated_at DESC LIMIT 500');
  const facts = [];
  for (const row of rows) {
    const plan = safeJson(row.plan, []);
    if (!Array.isArray(plan)) continue;
    plan.forEach((step, stepIndex) => {
      const raw = `${row.source || ''} ${row.title || ''} ${row.status || ''} ${step?.kind || ''} ${step?.status || ''} ${step?.action || ''} ${step?.step || ''} ${step?.note || ''}`;
      facts.push({
        sourceKind: 'goal_plan',
        goalId: row.id,
        action: String(step?.action || ''),
        status: normalizeStatus(step?.status || row.status),
        raw,
        evidenceRefs: [`sqlite:noe_goals/${safeId('goal', row.id)}/plan/${stepIndex}`],
      });
    });
  }
  return facts;
}

function actFacts(db) {
  if (!tableExists(db, 'noe_acts')) return [];
  return all(db, 'SELECT id, title, action, status, failure_reason, evidence_event_id, log_ref, payload, created_at, updated_at FROM noe_acts ORDER BY updated_at DESC LIMIT 2000')
    .map((row) => ({
      sourceKind: 'act_ledger',
      actId: row.id,
      action: String(row.action || ''),
      status: normalizeStatus(row.status),
      raw: `${row.title || ''} ${row.action || ''} ${row.status || ''} ${row.failure_reason || ''} ${row.payload || ''}`,
      evidenceRefs: uniq([
        `sqlite:noe_acts/${safeId('act', row.id)}`,
        row.evidence_event_id ? `sqlite:events/${Number(row.evidence_event_id)}` : null,
        row.log_ref && String(row.log_ref).startsWith('sqlite:events/') ? String(row.log_ref) : null,
      ], 5),
    }));
}

function checkpointFacts(db) {
  if (!tableExists(db, 'noe_goal_checkpoints')) return [];
  return all(db, 'SELECT id, goal_id, phase, status, kind, action, step, note, evidence_ref, replay_safe, payload, created_at FROM noe_goal_checkpoints ORDER BY created_at DESC LIMIT 5000')
    .map((row) => ({
      sourceKind: 'goal_checkpoint',
      goalId: row.goal_id,
      action: String(row.action || ''),
      status: normalizeStatus(row.status),
      replaySafe: row.replay_safe,
      raw: `${row.phase || ''} ${row.status || ''} ${row.kind || ''} ${row.action || ''} ${row.step || ''} ${row.note || ''} ${row.payload || ''}`,
      evidenceRefs: uniq([
        sqliteRef('noe_goal_checkpoints', row.id, 'checkpoint'),
        row.evidence_ref ? redactText(row.evidence_ref, 120) : null,
      ], 5),
    }));
}

function eventFacts(db) {
  if (!tableExists(db, 'events')) return [];
  return all(db, "SELECT id, kind, tag, entity_type, entity_id, task_id, ts FROM events WHERE kind LIKE 'noe_act%' OR kind = 'noe_loop_tick' ORDER BY ts DESC LIMIT 800")
    .map((row) => ({
      sourceKind: 'event_metadata',
      actId: String(row.entity_id || '').startsWith('act-') ? row.entity_id : null,
      status: 'metadata',
      raw: `${row.kind || ''} ${row.tag || ''} ${row.entity_type || ''} ${row.entity_id || ''} ${row.task_id || ''}`,
      evidenceRefs: [sqliteRef('events', row.id, 'event')],
    }));
}

function derivedClusterCandidates(facts) {
  const candidates = [
    {
      cluster: 'goal_checkpoint:evidence_blocked',
      source: 'sqlite_goal_checkpoints',
      derived: true,
      facts: facts.filter((fact) => fact.sourceKind === 'goal_checkpoint'
        && normalizeStatus(fact.status) === 'blocked'
        && String(fact.raw || '').toLowerCase().includes('evidence')),
    },
    {
      cluster: 'goal_checkpoint:step_recovered',
      source: 'sqlite_goal_checkpoints',
      derived: true,
      facts: facts.filter((fact) => fact.sourceKind === 'goal_checkpoint'
        && (normalizeStatus(fact.status) === 'recovered' || String(fact.raw || '').toLowerCase().includes('step_recovered'))),
    },
    {
      cluster: 'act_executor_missing',
      source: 'sqlite_noe_acts',
      derived: true,
      facts: facts.filter((fact) => fact.sourceKind === 'act_ledger'
        && String(fact.raw || '').toLowerCase().includes('real executor not registered')),
    },
  ];
  return candidates
    .filter((item) => item.facts.length > 0)
    .map((item) => ({
      cluster: item.cluster,
      count: item.facts.length,
      examples: uniq(item.facts.map((fact) => fact.action || fact.status), 3),
      source: item.source,
      derived: item.derived,
    }));
}

function mergeSourceAndDerivedClusters(sourceClusters, facts) {
  const out = [...sourceClusters];
  const seen = new Set(out.map((cluster) => String(cluster.cluster || '').toLowerCase()));
  for (const cluster of derivedClusterCandidates(facts)) {
    const key = String(cluster.cluster || '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cluster);
  }
  return out;
}

function clusterMatches(clusterName, fact) {
  const name = String(clusterName || '').toLowerCase();
  const raw = String(fact.raw || '').toLowerCase();
  const action = String(fact.action || '').toLowerCase();
  const status = normalizeStatus(fact.status);
  if (name.includes('browser_dom_host_mismatch')) {
    return raw.includes('browser_dom_host_mismatch') || raw.includes('host mismatch')
      || (action === 'browser.observe_page' && ['failed', 'recovered'].includes(status));
  }
  if (name === 'act:blocked' || name.includes(':blocked')) {
    return ['blocked', 'blocked_safety'].includes(status) || raw.includes('act:blocked');
  }
  if (name === 'goal_checkpoint:evidence_blocked') {
    return fact.sourceKind === 'goal_checkpoint' && status === 'blocked' && raw.includes('evidence');
  }
  if (name === 'goal_checkpoint:step_recovered') {
    return fact.sourceKind === 'goal_checkpoint' && (status === 'recovered' || raw.includes('step_recovered'));
  }
  if (name === 'act_executor_missing') {
    return fact.sourceKind === 'act_ledger' && raw.includes('real executor not registered');
  }
  return raw.includes(name);
}

function rootCauseFor(clusterName, matches) {
  const name = String(clusterName || '').toLowerCase();
  if (name.includes('browser_dom_host_mismatch')) {
    return 'Browser DOM observation depends on the active browser host matching Noe action context; repeated browser.observe_page failures/recoveries show the action chain lacks a preflight host reconciliation step.';
  }
  if (name === 'act:blocked' || name.includes(':blocked')) {
    return 'An action reached a safety or permission boundary and was blocked; the failure is expected protection, but the follow-up path needs a structured approval/evidence settlement instead of remaining a generic blocked mode.';
  }
  if (name === 'goal_checkpoint:evidence_blocked') {
    return 'Goal checkpoint evidence collection is blocked even after the action path records activity; the self-maintenance loop needs a clearer evidence contract before marking the goal ready for settlement.';
  }
  if (name === 'goal_checkpoint:step_recovered') {
    return 'Goal steps are recovering instead of completing cleanly; recovery is working, but repeated recovery checkpoints show the runner should turn the recovery cause into a smaller preventive preflight.';
  }
  if (name === 'act_executor_missing') {
    return 'The act ledger reached an action kind without a registered real executor; capability discovery and action routing are out of sync.';
  }
  if (matches.some((m) => normalizeStatus(m.status) === 'failed')) return 'Execution failure was observed, but the current evidence does not yet separate environment, adapter, model, and approval causes.';
  return 'The maintenance report exposed this failure mode, but attribution evidence is sparse and needs a narrower diagnostic seed.';
}

function nextActionFor(clusterName) {
  const name = String(clusterName || '').toLowerCase();
  if (name.includes('browser_dom_host_mismatch')) return 'Add a read-only browser host preflight report that records active app, adapter host, URL/title metadata, and whether observe_page can run before the goal step is marked failed.';
  if (name === 'act:blocked' || name.includes(':blocked')) return 'Add a blocked-action settlement report that maps blocked action kind to required approval, evidence ref, and safe fallback action.';
  if (name === 'goal_checkpoint:evidence_blocked') return 'Add an evidence-contract checker that explains which evidence ref, action result, or checkpoint payload is missing before settlement.';
  if (name === 'goal_checkpoint:step_recovered') return 'Add a recovery-cause summary to each recovered step and promote recurring causes into preflight checks.';
  if (name === 'act_executor_missing') return 'Add capability discovery coverage for unregistered action kinds before the goal planner can choose them.';
  return 'Create a narrow diagnostic fixture for this cluster before converting it into an autonomous gap execution item.';
}

function gapSeedFor(clusterName, cluster, matches) {
  const safeName = redactText(clusterName, 80).replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'failure_mode';
  const sourceLabel = cluster.derived ? 'P7-H0 derived' : 'P7-A0 reported';
  return {
    seedId: `p7h0_${safeName}`,
    source: 'p7_failure_modes_attribution',
    title: `J0-lite seed candidate: ${redactText(clusterName, 80)}`,
    why: `${sourceLabel} ${cluster.count || 0} occurrences; P7-H0 matched ${matches.length} supporting evidence rows.`,
    constraints: ['read_only_first', 'no_live_port_required', 'no_secret_values', 'owner_review_before_execution'],
    readyForJ0Lite: matches.length > 0,
  };
}

function severityFor(count, secretLeakRisk) {
  if (secretLeakRisk) return 'critical';
  if (count >= 5) return 'high';
  if (count >= 2) return 'medium';
  return 'low';
}

function replaySafetyFor(clusterName) {
  const name = String(clusterName || '').toLowerCase();
  if (name.includes('browser_dom_host_mismatch')) return { level: 'read_only_replay_ok', canReplayAutomatically: false, sideEffects: 'none_expected', requiresOwnerConfirmation: false };
  if (name.includes('blocked')) return { level: 'approval_required', canReplayAutomatically: false, sideEffects: 'possible_protected_action', requiresOwnerConfirmation: true };
  if (name.includes('recovered')) return { level: 'diagnostic_only', canReplayAutomatically: false, sideEffects: 'none_expected', requiresOwnerConfirmation: false };
  if (name.includes('executor_missing')) return { level: 'diagnostic_only', canReplayAutomatically: false, sideEffects: 'unknown', requiresOwnerConfirmation: true };
  return { level: 'diagnostic_only', canReplayAutomatically: false, sideEffects: 'unknown', requiresOwnerConfirmation: true };
}

function attributeCluster(cluster, facts, sourceReportRef, reportRefs) {
  const matches = facts.filter((fact) => clusterMatches(cluster.cluster, fact));
  const rawForRisk = `${JSON.stringify(cluster)} ${matches.map((m) => m.raw).join(' ')}`;
  const secretLeakRisk = SECRET_LIKE.test(rawForRisk);
  SECRET_LIKE.lastIndex = 0;
  const sourceKinds = uniq(['maintenance_report', ...matches.map((m) => m.sourceKind), ...(reportRefs.length ? ['external_report'] : [])], 20);
  const affectedGoalIds = uniq(matches.map((m) => safeId('goal', m.goalId)), 20);
  const affectedActIds = uniq(matches.map((m) => safeId('act', m.actId)), 20);
  const evidenceRefs = uniq([
    cluster.derived ? null : sourceReportRef,
    ...matches.flatMap((m) => m.evidenceRefs || []),
    ...reportRefs.map((r) => r.ref),
  ], 40);
  const warnings = [];
  if (!matches.length) warnings.push('no_sqlite_match_for_cluster');
  if (secretLeakRisk) warnings.push('secret_like_source_detected_redacted');
  const seed = gapSeedFor(cluster.cluster, cluster, matches);
  return {
    cluster: redactText(cluster.cluster, 100),
    count: Number(cluster.count || 0),
    derived: cluster.derived === true,
    origin: cluster.derived ? redactText(cluster.source || 'derived_sqlite', 80) : 'maintenance_report',
    matchedEvidenceCount: matches.length,
    sourceKinds,
    affectedGoalIds,
    affectedActIds,
    evidenceRefs,
    likelyRootCause: rootCauseFor(cluster.cluster, matches),
    suggestedGapSeed: seed,
    recommendedNextAction: nextActionFor(cluster.cluster),
    severity: severityFor(Number(cluster.count || 0), secretLeakRisk),
    replaySafety: replaySafetyFor(cluster.cluster),
    secretLeakRisk,
    warnings,
  };
}

export function buildFailureModesAttributionReport({
  sourceReport = null,
  sourceReportRef = DEFAULT_SOURCE_REPORT,
  db = null,
  dbPath = DEFAULT_DB_PATH,
  dbExists = true,
  now = Date.now(),
  reportId = randomUUID(),
  reportRefs = relatedReports(),
} = {}) {
  const blockers = [];
  const warnings = [];
  if (!sourceReport) blockers.push('source_report_missing');
  if (!dbExists) blockers.push('db_missing');
  const facts = db ? [...goalFacts(db), ...actFacts(db), ...checkpointFacts(db), ...eventFacts(db)] : [];
  const sourceClusters = Array.isArray(sourceReport?.failureModeClusters) ? sourceReport.failureModeClusters : [];
  if (!sourceClusters.length) warnings.push('no_failure_mode_clusters_in_source');
  const clusters = mergeSourceAndDerivedClusters(sourceClusters, facts);
  const attributed = clusters.map((cluster) => attributeCluster(cluster, facts, rel(sourceReportRef), reportRefs));
  if (attributed.some((c) => c.warnings.includes('no_sqlite_match_for_cluster'))) warnings.push('some_clusters_have_no_sqlite_match');
  if (attributed.some((c) => c.secretLeakRisk)) warnings.push('secret_like_source_detected_redacted');
  if (attributed.length < 3) blockers.push('failure_mode_clusters_below_3');
  return {
    schemaVersion: 1,
    reportId,
    generatedAt: now,
    generatedAtIso: new Date(now).toISOString(),
    policy: {
      readOnly: true,
      noDbWrites: true,
      noLivePortsTouched: true,
      noModelCalls: true,
      redaction: 'ids_hashed_text_redacted',
      noLLMContext: true,
    },
    source: {
      maintenanceReportRef: rel(sourceReportRef),
      maintenanceReportFound: Boolean(sourceReport),
      maintenanceGeneratedAtIso: sourceReport?.generatedAtIso || null,
      dbPath: resolve(dbPath),
      dbExists,
      sqliteFactRows: facts.length,
      sourceClusterCount: sourceClusters.length,
      derivedClusterCount: attributed.filter((c) => c.derived).length,
      relatedReports: reportRefs,
    },
    failureModeClusters: attributed,
    suggestedGapSeeds: attributed.map((c) => c.suggestedGapSeed),
    summary: {
      clusterCount: attributed.length,
      sourceClusterCount: attributed.filter((c) => !c.derived).length,
      derivedClusterCount: attributed.filter((c) => c.derived).length,
      topFailureModes: attributed.slice().sort((a, b) => b.count - a.count).slice(0, 5).map((c) => ({ cluster: c.cluster, count: c.count, severity: c.severity })),
      j0LiteGapSeedCount: attributed.filter((c) => c.suggestedGapSeed.readyForJ0Lite).length,
      secretLeakRisk: attributed.some((c) => c.secretLeakRisk),
    },
    blockers,
    warnings,
    ok: blockers.length === 0,
  };
}

export function writeFailureModesAttributionReport(report, { outDir = DEFAULT_OUT_DIR } = {}) {
  const stamp = new Date(report.generatedAt).toISOString().replace(/[:.]/g, '-');
  const dir = join(outDir, stamp);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'report.json');
  const latest = join(outDir, 'latest.json');
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(file, payload, { mode: 0o600 });
  writeFileSync(latest, payload, { mode: 0o600 });
  return { file, latest };
}

function parseArgs(argv = []) {
  const out = {};
  const map = { '--source': 'sourceReportRef', '--db': 'dbPath', '--out-dir': 'outDir' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (map[arg]) out[map[arg]] = argv[++i];
    else for (const [flag, key] of Object.entries(map)) if (arg.startsWith(`${flag}=`)) out[key] = arg.slice(flag.length + 1);
  }
  return out;
}

export function runFailureModesAttribution({ sourceReportRef = DEFAULT_SOURCE_REPORT, dbPath = DEFAULT_DB_PATH, outDir = DEFAULT_OUT_DIR, now = Date.now(), DatabaseCtor = Database } = {}) {
  const sourceReport = existsSync(sourceReportRef) ? readJson(sourceReportRef) : null;
  const opened = openReadonlyDb(dbPath, DatabaseCtor);
  try {
    const report = buildFailureModesAttributionReport({ sourceReport, sourceReportRef, db: opened.db, dbPath: opened.path, dbExists: opened.exists, now });
    const written = writeFailureModesAttributionReport(report, { outDir });
    return { report, written };
  } finally {
    try { opened.db?.close?.(); } catch {}
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { report, written } = runFailureModesAttribution(args);
  console.log(JSON.stringify({
    ok: report.ok,
    output: rel(written.latest),
    report: rel(written.file),
    clusterCount: report.summary.clusterCount,
    topFailureModes: report.summary.topFailureModes,
    j0LiteGapSeedCount: report.summary.j0LiteGapSeedCount,
    blockers: report.blockers,
    warnings: report.warnings,
  }, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
