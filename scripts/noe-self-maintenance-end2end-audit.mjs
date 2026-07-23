#!/usr/bin/env node
// @ts-check
// P7-A0: read-only self-maintenance baseline; writes only aggregate reports.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = homedir();
const DEFAULT_DB_PATH = process.env.PANEL_DB_PATH || join(HOME, '.noe-panel', 'panel.db');
const DEFAULT_SKILLS_DIR = process.env.NOE_SKILLS_DIR || join(HOME, '.noe-panel', 'skills');
const DEFAULT_SFT_DIR = process.env.NOE_SFT_DIR || join(HOME, '.noe-panel', 'sft');
const DEFAULT_OUT_DIR = process.env.NOE_SELF_MAINTENANCE_END2END_OUT_DIR || join(ROOT, 'output', 'noe-self-maintenance-end2end');
const REPORT_SCHEMA_VERSION = 1;
const SFT_TARGET = Math.max(1, Number(process.env.NOE_SELF_MAINTENANCE_SFT_TARGET || 500));
const SFT_MIN_PROGRESS = Math.max(0, Number(process.env.NOE_SELF_MAINTENANCE_SFT_MIN_PROGRESS || 0.2));
const SELF_LEARNING_SOURCE = 'self_learning';
const SECRET_LIKE = /\b(?:sk|sk-cp|sk-ant|AIza|ghp|github_pat|xox[baprs]|tp-c[0-9a-z]+)[A-Za-z0-9._~+/=-]{12,}\b/gi;
const LONG_TOKEN = /\b[A-Za-z0-9_=-]{32,}\b/g;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const TOPIC_KEYWORDS = Object.freeze({
  web_research: ['上网', '搜索', '网页', '研究', 'research', 'web', 'browser', 'github'],
  computer_action: ['电脑', '浏览器', '行动', '执行', '操控', 'computer', 'browser', 'action', 'shell'],
  memory_conflict: ['记忆', '冲突', '长期', '修正', 'memory', 'conflict', 'knowledge'],
  checkpoint_recovery: ['恢复', '失败', 'checkpoint', 'resume', 'recovered', 'blocked', 'evidence'],
  grounded_reflection: ['意识', '内心', '思考', '反刍', 'echo', 'monologue', 'reflection', 'grounded'],
  capability_discovery: ['能力', '工具', '技能', 'capability', 'tool', 'skill', 'mcp'],
});
function round(n, digits = 3) {
  const value = Number(n || 0);
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
function ratio(n, d) {
  return d > 0 ? round(n / d) : 0;
}
function safeJson(value, fallback = null) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '')); } catch { return fallback; }
}
function redactText(value, max = 140) {
  return String(value || '')
    .replace(SECRET_LIKE, '[redacted-secret]')
    .replace(EMAIL, '[redacted-email]')
    .replace(LONG_TOKEN, '[redacted-id]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
function rel(file) {
  const abs = resolve(file);
  return abs.startsWith(ROOT) ? relative(ROOT, abs).replace(/\\/g, '/') : abs;
}
function normalizeStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  if (s === 'completed' || s === 'complete' || s === 'success') return 'done';
  if (s === 'error') return 'failed';
  return s || 'unknown';
}
function normalizeActionKind(action, fallback = 'unknown') {
  const s = String(action || '').trim();
  if (!s) return fallback;
  return s.split(':')[0].slice(0, 80);
}
function inc(map, key, amount = 1) {
  const k = String(key || 'unknown');
  map[k] = (map[k] || 0) + amount;
}
function nestedInc(map, key, subKey, amount = 1) {
  const k = String(key || 'unknown');
  const s = String(subKey || 'unknown');
  if (!map[k]) map[k] = {};
  map[k][s] = (map[k][s] || 0) + amount;
}
function safeAll(db, sql, params = []) {
  if (!db) return [];
  try { return db.prepare(sql).all(...params); } catch { return []; }
}
function safeGet(db, sql, params = []) {
  if (!db) return null;
  try { return db.prepare(sql).get(...params); } catch { return null; }
}
function tableExists(db, name) {
  return Boolean(safeGet(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]));
}
function extractPlan(row) {
  const plan = safeJson(row?.plan, []);
  return Array.isArray(plan) ? plan : [];
}
function isSelfLearningGoal(row) {
  return String(row?.source || '').trim() === SELF_LEARNING_SOURCE;
}
function isStepExecuted(step) {
  const status = normalizeStatus(step?.status || 'open');
  return !['open', 'unknown'].includes(status);
}
function isPlanAllDone(plan) {
  return plan.length > 0 && plan.every((step) => normalizeStatus(step?.status) === 'done');
}
function stepKind(step) {
  return String(step?.kind || (step?.action ? 'act' : 'think') || 'unknown').trim() || 'unknown';
}
function topicsInText(text) {
  const lower = String(text || '').toLowerCase();
  return Object.entries(TOPIC_KEYWORDS)
    .filter(([, words]) => words.some((word) => lower.includes(String(word).toLowerCase())))
    .map(([topic]) => topic);
}
function listFilesRecursive(dir, predicate = () => true, limit = 5000) {
  const out = [];
  if (!existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length && out.length < limit) {
    const current = stack.pop();
    if (!current) continue;
    let entries = [];
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile() && predicate(abs, entry.name)) out.push(abs);
      if (out.length >= limit) break;
    }
  }
  return out.sort();
}
export function openReadonlyDb({ dbPath = DEFAULT_DB_PATH, DatabaseCtor = Database } = {}) {
  const resolved = resolve(dbPath);
  if (!existsSync(resolved)) {
    return { db: null, dbPath: resolved, exists: false, opened: false, readonly: true };
  }
  const db = new DatabaseCtor(resolved, { readonly: true, fileMustExist: true });
  return { db, dbPath: resolved, exists: true, opened: true, readonly: true };
}
export function collectGoalRows(db) {
  if (!tableExists(db, 'noe_goals')) return [];
  return safeAll(db, 'SELECT id, created_at, source, title, why, priority, status, plan, updated_at FROM noe_goals ORDER BY created_at ASC');
}
function collectActRows(db) {
  if (!tableExists(db, 'noe_acts')) return [];
  return safeAll(db, 'SELECT id, title, action, status, failure_reason, payload, created_at, updated_at FROM noe_acts ORDER BY created_at ASC');
}
export function collectDiscovery(db, { goalRows = collectGoalRows(db) } = {}) {
  const bySource = {};
  const byStatus = {};
  for (const goal of goalRows) {
    inc(bySource, goal.source || 'unknown');
    inc(byStatus, goal.status || 'unknown');
  }
  const selfLearning = goalRows.filter(isSelfLearningGoal);
  const activeStatuses = new Set(['active', 'doing', 'open']);
  return {
    goalsTotal: goalRows.length,
    goalsBySource: bySource,
    goalsByStatus: byStatus,
    selfLearningGoalsTotal: selfLearning.length,
    selfLearningGoalsActive: selfLearning.filter((goal) => activeStatuses.has(normalizeStatus(goal.status))).length,
    surpriseTriggeredGoals: goalRows.filter((goal) => String(goal.source || '') === 'surprise').length,
    driveImpliedGoals: goalRows.filter((goal) => String(goal.source || '') === 'drive').length,
    ownerDelegationTriggered: goalRows.filter((goal) => String(goal.source || '') === 'owner').length,
  };
}
export function collectExecution(db, { goalRows = collectGoalRows(db), actRows = collectActRows(db) } = {}) {
  const stepKindDistribution = {};
  const stepStatusDistribution = {};
  const actStepOutcomeByKind = {};
  let totalSteps = 0;
  let doneSteps = 0;
  let actSteps = 0;
  let actDoneSteps = 0;
  let totalPlanGoals = 0;
  let totalPlanSteps = 0;
  for (const goal of goalRows) {
    const plan = extractPlan(goal);
    if (plan.length) {
      totalPlanGoals += 1;
      totalPlanSteps += plan.length;
    }
    for (const step of plan) {
      totalSteps += 1;
      const kind = stepKind(step);
      const status = normalizeStatus(step?.status || 'open');
      inc(stepKindDistribution, kind);
      inc(stepStatusDistribution, status);
      if (status === 'done') doneSteps += 1;
      if (kind === 'act') {
        actSteps += 1;
        if (status === 'done') actDoneSteps += 1;
        nestedInc(actStepOutcomeByKind, normalizeActionKind(step?.action), status);
      }
    }
  }
  for (const act of actRows) {
    nestedInc(actStepOutcomeByKind, normalizeActionKind(act.action), normalizeStatus(act.status));
  }
  return {
    totalSteps,
    stepKindDistribution,
    stepStatusDistribution,
    stepSuccessRate: ratio(doneSteps, totalSteps),
    meanStepsPerGoal: ratio(totalPlanSteps, totalPlanGoals),
    actStepCount: actSteps,
    actStepSuccessRate: ratio(actDoneSteps, actSteps),
    actRowsObserved: actRows.length,
    actStepOutcomeByKind,
  };
}
function clusterReason(clusters, reason, example) {
  const label = redactText(reason || 'unknown_failure', 80).toLowerCase() || 'unknown_failure';
  if (!clusters[label]) clusters[label] = { cluster: label, count: 0, examples: [] };
  clusters[label].count += 1;
  if (clusters[label].examples.length < 3) clusters[label].examples.push(redactText(example || reason || label, 100));
}
export function collectFailureLearning(db, { goalRows = collectGoalRows(db), actRows = collectActRows(db) } = {}) {
  const clusters = {};
  const blockedByKind = {};
  let recovered = 0;
  let blocked = 0;
  let failed = 0;
  for (const goal of goalRows) {
    for (const step of extractPlan(goal)) {
      const status = normalizeStatus(step?.status);
      const kind = stepKind(step);
      if (status === 'recovered') recovered += 1;
      if (status === 'blocked') {
        blocked += 1;
        inc(blockedByKind, kind);
        clusterReason(clusters, `${kind}:blocked`, step?.action || step?.step);
      }
      if (status === 'failed') {
        failed += 1;
        clusterReason(clusters, `${kind}:failed`, step?.action || step?.step);
      }
    }
  }
  for (const act of actRows) {
    const status = normalizeStatus(act.status);
    if (status !== 'failed' && status !== 'blocked') continue;
    clusterReason(clusters, act.failure_reason || `${act.action || 'act'}:${status}`, act.action || act.title);
  }
  return {
    stepRecoveredCount: recovered,
    stepBlockedCount: blocked,
    stepFailedCount: failed,
    blockedByKind,
    failureModeClusters: Object.values(clusters).sort((a, b) => b.count - a.count).slice(0, 10),
  };
}
export function collectMemoryConsolidation(db) {
  const episodeRows = tableExists(db, 'events')
    ? safeAll(db, "SELECT payload FROM events WHERE kind = 'noe_episode' ORDER BY ts DESC LIMIT 5000")
    : [];
  const episodesByType = {};
  for (const row of episodeRows) {
    const payload = safeJson(row.payload, {});
    inc(episodesByType, payload?.episodeType || payload?.type || 'unknown');
  }
  const realExperience = (episodesByType.interaction || 0) + (episodesByType.observation || 0) + (episodesByType.milestone || 0);
  const expectation = tableExists(db, 'noe_expectations')
    ? safeGet(db, `
      SELECT
        COUNT(*) AS created,
        SUM(CASE WHEN resolved_at IS NOT NULL THEN 1 ELSE 0 END) AS resolved,
        AVG(CASE WHEN surprise IS NOT NULL THEN surprise ELSE NULL END) AS surpriseAvg
      FROM noe_expectations
    `)
    : null;
  const memoryRows = tableExists(db, 'noe_memory')
    ? safeAll(db, 'SELECT source_type, scope, title, body, tags FROM noe_memory WHERE hidden = 0 ORDER BY updated_at DESC LIMIT 5000')
    : [];
  const memoryBySourceType = {};
  const memoryByScope = {};
  let nightReflectionInsights = 0;
  for (const row of memoryRows) {
    inc(memoryBySourceType, row.source_type || 'unknown');
    inc(memoryByScope, row.scope || 'unknown');
    if (String(row.source_type || '').includes('night') || String(row.tags || '').includes('night_reflection')) {
      nightReflectionInsights += 1;
    }
  }
  return {
    episodesTotal: episodeRows.length,
    episodesByType,
    selfTalkVsExperienceRatio: ratio(episodesByType.inner_monologue || 0, Math.max(1, realExperience)),
    expectationsCreated: Number(expectation?.created || 0),
    expectationsResolved: Number(expectation?.resolved || 0),
    expectationsSurpriseAvg: round(expectation?.surpriseAvg || 0),
    memoryRowsVisible: memoryRows.length,
    memoryBySourceType,
    memoryByScope,
    nightReflectionInsights,
  };
}
export function collectCrossTopicKnowledgeReuse(db) {
  const rows = tableExists(db, 'noe_memory')
    ? safeAll(db, 'SELECT title, body, tags, source_type FROM noe_memory WHERE hidden = 0 ORDER BY updated_at DESC LIMIT 5000')
    : [];
  const topicPairs = {};
  let reusableMemoryCount = 0;
  let multiTopicMemoryCount = 0;
  for (const row of rows) {
    const topics = topicsInText(`${row.title || ''} ${row.body || ''} ${row.tags || ''}`);
    if (topics.length) reusableMemoryCount += 1;
    if (topics.length >= 2) {
      multiTopicMemoryCount += 1;
      const sorted = [...new Set(topics)].sort();
      for (let i = 0; i < sorted.length; i += 1) {
        for (let j = i + 1; j < sorted.length; j += 1) inc(topicPairs, `${sorted[i]}+${sorted[j]}`);
      }
    }
  }
  return {
    score: ratio(multiTopicMemoryCount, Math.max(1, reusableMemoryCount)),
    reusableMemoryCount,
    multiTopicMemoryCount,
    topicPairs: Object.fromEntries(Object.entries(topicPairs).sort((a, b) => b[1] - a[1]).slice(0, 12)),
  };
}
export function scanSftDir({ sftDir = DEFAULT_SFT_DIR, sftTarget = SFT_TARGET } = {}) {
  const files = listFilesRecursive(sftDir, (_abs, name) => name.endsWith('.jsonl'), 2000);
  let totalLines = 0;
  let validPairs = 0;
  let invalidPairs = 0;
  for (const file of files) {
    let lines = [];
    try { lines = readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { continue; }
    for (const line of lines) {
      totalLines += 1;
      const parsed = safeJson(line, null);
      const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
      const assistant = messages.findLast?.((m) => m?.role === 'assistant') || messages[messages.length - 1] || null;
      if (messages.length >= 2 && typeof assistant?.content === 'string' && assistant.content.trim().length >= 10) validPairs += 1;
      else invalidPairs += 1;
    }
  }
  return {
    exists: existsSync(sftDir),
    dir: sftDir,
    fileCount: files.length,
    totalLines,
    validPairs,
    invalidPairs,
    targetPairs: sftTarget,
    progress: ratio(validPairs, sftTarget),
  };
}
export function collectSkillDistillation({ db = null, skillsDir = DEFAULT_SKILLS_DIR, sftDir = DEFAULT_SFT_DIR, sftTarget = SFT_TARGET } = {}) {
  const skillFiles = listFilesRecursive(skillsDir, (_abs, name) => name === 'SKILL.md', 2000);
  const sft = scanSftDir({ sftDir, sftTarget });
  const recentSkillRows = tableExists(db, 'events')
    ? safeAll(db, `
      SELECT payload, tag FROM events
      WHERE ts >= ? AND (kind LIKE '%skill%' OR tag LIKE '%skill%' OR payload LIKE '%skill%')
      ORDER BY ts DESC LIMIT 1000
    `, [Date.now() - 7 * 86_400_000])
    : [];
  const recentlyReferenced = new Set();
  for (const row of recentSkillRows) {
    const text = `${row.tag || ''} ${row.payload || ''}`;
    const match = text.match(/[A-Za-z0-9_.:-]+(?:\/SKILL\.md)?/g) || [];
    for (const item of match) {
      if (item.toLowerCase().includes('skill')) recentlyReferenced.add(item.slice(0, 120));
    }
  }
  return {
    skillsDir,
    skillsRegistered: skillFiles.length,
    skillsRecentUse: recentlyReferenced.size,
    skillFilesSample: skillFiles.slice(0, 12).map(rel),
    sftPairsAvailable: sft.validPairs,
    sftPairsTarget: sft.targetPairs,
    sftPairsProgress: sft.progress,
    sft,
  };
}
export function deriveSelfLearningMetrics(goalRows) {
  const selfLearning = goalRows.filter(isSelfLearningGoal);
  const executed = selfLearning.filter((goal) => normalizeStatus(goal.status) !== 'open' || extractPlan(goal).some(isStepExecuted));
  const successful = executed.filter((goal) => isPlanAllDone(extractPlan(goal)));
  return {
    selfLearningGoalExecCount: executed.length,
    selfLearningSuccessRate: ratio(successful.length, executed.length),
    selfLearningSuccessNumerator: successful.length,
    selfLearningSuccessDenominator: executed.length,
  };
}
function evaluateReadiness({ dbInfo, selfLearning, skillDistillation, failureLearning, crossTopicKnowledgeReuse }) {
  const blockers = [];
  const warnings = [];
  if (!dbInfo.exists) blockers.push('db_missing');
  if (selfLearning.selfLearningGoalExecCount === 0) blockers.push('no_self_learning_executed');
  if (skillDistillation.sftPairsProgress < SFT_MIN_PROGRESS) blockers.push('sft_dataset_insufficient');
  if (selfLearning.selfLearningSuccessDenominator > 0 && selfLearning.selfLearningSuccessRate === 0) warnings.push('self_learning_success_rate_zero');
  if (failureLearning.failureModeClusters.length > 0) warnings.push('failure_modes_present');
  if (crossTopicKnowledgeReuse.score < 0.1) warnings.push('low_cross_topic_knowledge_reuse');
  if (skillDistillation.skillsRegistered === 0) warnings.push('no_skill_registry_detected');
  return { ok: blockers.length === 0, blockers, warnings };
}
export function buildEnd2EndReport({
  db = null,
  dbPath = DEFAULT_DB_PATH,
  dbExists = true,
  now = Date.now(),
  reportId = randomUUID(),
  skillsDir = DEFAULT_SKILLS_DIR,
  sftDir = DEFAULT_SFT_DIR,
  sftTarget = SFT_TARGET,
} = {}) {
  const goalRows = collectGoalRows(db);
  const actRows = collectActRows(db);
  const selfLearning = deriveSelfLearningMetrics(goalRows);
  const discovery = collectDiscovery(db, { goalRows });
  const execution = collectExecution(db, { goalRows, actRows });
  const failureLearning = collectFailureLearning(db, { goalRows, actRows });
  const memoryConsolidation = collectMemoryConsolidation(db);
  const crossTopicKnowledgeReuse = collectCrossTopicKnowledgeReuse(db);
  const skillDistillation = collectSkillDistillation({ db, skillsDir, sftDir, sftTarget });
  const topLevelMetrics = {
    selfLearningGoalExecCount: selfLearning.selfLearningGoalExecCount,
    selfLearningSuccessRate: selfLearning.selfLearningSuccessRate,
    failureModeClusters: failureLearning.failureModeClusters,
    crossTopicKnowledgeReuse,
    actStepOutcomeByKind: execution.actStepOutcomeByKind,
  };
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    reportId,
    generatedAt: now,
    generatedAtIso: new Date(now).toISOString(),
    policy: {
      readOnly: true,
      noDbWrites: true,
      noGoalWrites: true,
      noMemoryWrites: true,
      noLivePortsTouched: true,
      redaction: 'aggregate_only',
    },
    db: { path: resolve(dbPath), exists: dbExists, openedReadonly: Boolean(db) },
    ...topLevelMetrics,
    metrics: {
      ...topLevelMetrics,
      selfLearningSuccessNumerator: selfLearning.selfLearningSuccessNumerator,
      selfLearningSuccessDenominator: selfLearning.selfLearningSuccessDenominator,
    },
    discovery,
    execution,
    failureLearning,
    memoryConsolidation,
    skillDistillation,
    readiness: evaluateReadiness({
      dbInfo: { exists: dbExists },
      selfLearning,
      skillDistillation,
      failureLearning,
      crossTopicKnowledgeReuse,
    }),
  };
  return report;
}
export function writeEnd2EndReport(report, { outDir = DEFAULT_OUT_DIR } = {}) {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const stamp = new Date(report.generatedAt).toISOString().replace(/[:.]/g, '-');
  const file = join(outDir, `${stamp}-${report.reportId}.json`);
  const latest = join(outDir, 'latest.json');
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(file, payload, { mode: 0o600 });
  writeFileSync(latest, payload, { mode: 0o600 });
  return { file, latest };
}
function parseArgs(argv) {
  const out = {};
  const map = { '--db': 'dbPath', '--out-dir': 'outDir', '--skills-dir': 'skillsDir', '--sft-dir': 'sftDir' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (map[arg]) out[map[arg]] = argv[++i];
    else for (const [flag, key] of Object.entries(map)) {
      if (arg.startsWith(`${flag}=`)) out[key] = arg.slice(flag.length + 1);
    }
  }
  return out;
}
export function runEnd2EndAudit({ dbPath = DEFAULT_DB_PATH, outDir = DEFAULT_OUT_DIR, skillsDir = DEFAULT_SKILLS_DIR, sftDir = DEFAULT_SFT_DIR, now = Date.now() } = {}) {
  const opened = openReadonlyDb({ dbPath });
  try {
    const report = buildEnd2EndReport({ db: opened.db, dbPath: opened.dbPath, dbExists: opened.exists, now, skillsDir, sftDir });
    const written = writeEnd2EndReport(report, { outDir });
    return { report, written };
  } finally {
    try { opened.db?.close?.(); } catch {}
  }
}
export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { report, written } = runEnd2EndAudit(args);
  const summary = { ok: report.readiness.ok, output: rel(written.latest), report: rel(written.file), selfLearningGoalExecCount: report.selfLearningGoalExecCount, selfLearningSuccessRate: report.selfLearningSuccessRate, blockers: report.readiness.blockers, warnings: report.readiness.warnings };
  console.log(JSON.stringify(summary, null, 2));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
