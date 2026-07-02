#!/usr/bin/env node
// @ts-check
// Read-only surprise-learning audit.
// It separates static wiring from live evidence so code readiness is not mistaken for active learning.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.NOE_SURPRISE_LEARNING_AUDIT_OUT_DIR || join(ROOT, 'output', 'noe-audit');
const OUT_BASE = process.env.NOE_SURPRISE_LEARNING_AUDIT_BASENAME || 'surprise-learning-audit-2026-06-15';

const DEFAULT_PATHS = {
  runtimeEvidenceLatest: join(ROOT, 'output', 'noe-runtime-evidence', 'latest.json'),
  runtimeEvidenceDir: join(ROOT, 'output', 'noe-runtime-evidence'),
  expectationResolver: join(ROOT, 'src', 'cognition', 'NoeExpectationResolver.js'),
  ownerBehaviorPredictor: join(ROOT, 'src', 'cognition', 'NoeOwnerBehaviorPredictor.js'),
  goalSystem: join(ROOT, 'src', 'cognition', 'NoeGoalSystem.js'),
  server: join(ROOT, 'server.js'),
  curiosityYieldReport: join(ROOT, 'scripts', 'noe-curiosity-yield-report.mjs'),
  packageJson: join(ROOT, 'package.json'),
};

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function rate(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function bool(value) {
  return value === true;
}

function readJson(path) {
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readText(path) {
  if (!path || !existsSync(path)) return '';
  return readFileSync(path, 'utf8');
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

function extractRuntimeCounts(evidence = {}) {
  const curiosityExpectations = evidence?.curiosity?.expectations || {};
  const curiosityResearch = evidence?.curiosity?.research || {};
  const expectations = evidence?.expectations || {};
  const goals = evidence?.goals || {};
  const judge = evidence?.expectationJudgeContract || expectations?.judgeContract || {};
  const ownerPredictionRepair = evidence?.ownerPredictionRepair || {};
  return {
    generatedAt: evidence?.generatedAt || evidence?.curiosity?.generatedAt || '',
    blockers: arr(evidence?.blockers).map((item) => clean(item, 120)),
    expectationStatus: clean(expectations?.status || '', 120),
    goalStatus: clean(goals?.status || '', 120),
    expectationsCreated: num(curiosityExpectations.created ?? expectations.total),
    expectationsOpen: num(curiosityExpectations.open ?? expectations.open),
    expectationsSettled: num(curiosityExpectations.settled ?? expectations.settled),
    expectationsApplied: num(curiosityExpectations.applied ?? expectations.applied),
    expectationsFailed: num(curiosityExpectations.failed ?? expectations.failed),
    failedSurpriseEligible: num(curiosityExpectations.failedSurpriseEligible),
    surpriseGoals: num(curiosityResearch.surpriseGoals ?? goals.surpriseGoals),
    surpriseGoalsActive: num(curiosityResearch.surpriseGoalsActive ?? goals.surpriseGoalsActive),
    surpriseGoalsDone: num(curiosityResearch.surpriseGoalsDone ?? goals.surpriseGoalsDone),
    decisiveHints: num(judge.decisiveHints),
    decisiveHintUnknown: num(judge.decisiveHintUnknown),
    decisiveHintOverride: num(judge.decisiveHintOverride),
    decisiveUnknownRate: rate(judge.decisiveUnknownRate),
    avgSemanticCoverage: rate(judge.avgSemanticCoverage),
    ownerPredictionStatus: clean(ownerPredictionRepair.status || '', 120),
    ownerPredictionLiveLoaded: bool(ownerPredictionRepair.liveLoaded),
  };
}

function snapshotTimestamp(name = '') {
  const m = String(name).match(/runtime-evidence-(\d+)\.json$/);
  return m ? Number(m[1]) : 0;
}

function collectRuntimeSnapshots(dir, { latestPath = '', limit = 8 } = {}) {
  const files = [];
  if (dir && existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (/^runtime-evidence-\d+\.json$/.test(name)) files.push(join(dir, name));
    }
  }
  files.sort((a, b) => snapshotTimestamp(a) - snapshotTimestamp(b));
  const selected = files.slice(Math.max(0, files.length - limit));
  if (!selected.length && latestPath && existsSync(latestPath)) selected.push(latestPath);
  return selected
    .map((path) => ({ path, evidence: readJson(path) }))
    .filter((item) => item.evidence)
    .map((item) => ({ path: rel(item.path), ...extractRuntimeCounts(item.evidence) }));
}

function average(values = []) {
  const nums = values.filter((value) => Number.isFinite(Number(value))).map(Number);
  if (!nums.length) return null;
  return Math.round((nums.reduce((sum, value) => sum + value, 0) / nums.length) * 1000) / 1000;
}

function buildTrend(snapshots = []) {
  const failedValues = snapshots.map((item) => item.expectationsFailed);
  const surpriseValues = snapshots.map((item) => item.surpriseGoals);
  const failedEligibleValues = snapshots.map((item) => item.failedSurpriseEligible);
  const unknownRates = snapshots.map((item) => item.decisiveUnknownRate).filter((item) => item != null);
  return {
    snapshots: snapshots.length,
    allFailedZero: snapshots.length > 0 && failedValues.every((item) => item === 0),
    allFailedSurpriseEligibleZero: snapshots.length > 0 && failedEligibleValues.every((item) => item === 0),
    allSurpriseGoalsZero: snapshots.length > 0 && surpriseValues.every((item) => item === 0),
    maxFailed: failedValues.length ? Math.max(...failedValues) : 0,
    maxFailedSurpriseEligible: failedEligibleValues.length ? Math.max(...failedEligibleValues) : 0,
    maxSurpriseGoals: surpriseValues.length ? Math.max(...surpriseValues) : 0,
    avgDecisiveUnknownRate: average(unknownRates),
    highUnknownSnapshots: unknownRates.filter((item) => Number(item) >= 0.8).length,
  };
}

function buildStaticWiringEvidence({ texts = {}, packageJson = {} } = {}) {
  const resolver = texts.expectationResolver || '';
  const predictor = texts.ownerBehaviorPredictor || '';
  const goalSystem = texts.goalSystem || '';
  const server = texts.server || '';
  const curiosityYieldReport = texts.curiosityYieldReport || '';
  const curiosityScript = String(packageJson?.scripts?.['noe:curiosity:yield-report'] || '');
  const resolverHarvestSurprise =
    /goalSystem\s*=\s*null/.test(resolver)
    && /v\.outcome\s*===\s*0[\s\S]{0,220}goalSystem\.harvestSurprise/.test(resolver);
  const resolverStrictReask =
    /DECISIVE_REASK_SYSTEM/.test(resolver)
    && /NOE_EXPECT_DECISIVE_REASK/.test(resolver)
    && /NOE_EXPECT_LOOSEN_FAIL/.test(resolver);
  const ownerPredictionNegative =
    /\bFOLLOWUP_FAIL_RE\b/.test(predictor)
    && /outcome\s*=\s*followupFail\s*\?\s*0\s*:\s*1/.test(predictor)
    && /outcome\s*===\s*0[\s\S]{0,220}goalSystem\.harvestSurprise/.test(predictor);
  const goalSystemHarvestSurprise =
    /function\s+harvestSurprise/.test(goalSystem)
    && /source:\s*['"]surprise['"]/.test(goalSystem)
    && /curiositySurpriseThreshold/.test(goalSystem);
  const serverExpectationGoalSystemWired =
    /createExpectationResolver\(\{[\s\S]{0,1800}goalSystem:\s*noeGoalSystem/.test(server);
  const serverOwnerPredictionGoalSystemWired =
    /createOwnerBehaviorPredictor\(\{\s*ledger:\s*noeExpectationLedger,\s*goalSystem:\s*noeGoalSystem\s*\}\)/.test(server);
  const curiosityYieldReportReady =
    /export function buildCuriosityYieldReport/.test(curiosityYieldReport)
    && /readonly/.test(curiosityYieldReport)
    && /SELECT COUNT/.test(curiosityYieldReport);
  const packageScriptUsesNode22 =
    /ensure-node22\.mjs/.test(curiosityScript)
    && /noe-curiosity-yield-report\.mjs/.test(curiosityScript);
  const required = {
    resolverHarvestSurprise,
    ownerPredictionNegative,
    goalSystemHarvestSurprise,
    serverExpectationGoalSystemWired,
    serverOwnerPredictionGoalSystemWired,
  };
  return {
    ...required,
    resolverStrictReask,
    curiosityYieldReportReady,
    packageScriptUsesNode22,
    allRequiredCodeWired: Object.values(required).every(Boolean),
  };
}

function buildDiagnostics({ current, trend, staticWiring }) {
  const diagnostics = [];
  if (!staticWiring.allRequiredCodeWired) diagnostics.push('static_surprise_wiring_incomplete');
  if (current.expectationsFailed === 0) diagnostics.push('expectation_failure_not_observed');
  if (current.failedSurpriseEligible === 0) diagnostics.push('failed_surprise_eligible_absent');
  if (current.surpriseGoals === 0) diagnostics.push('source_surprise_absent');
  if (Number(current.decisiveUnknownRate) >= 0.8) diagnostics.push('expectation_judge_decisive_unknown_rate_high');
  if (/pending_restart/i.test(current.ownerPredictionStatus)) diagnostics.push('owner_prediction_repair_live_pending_restart');
  if (trend.snapshots > 1 && trend.allFailedZero && trend.allSurpriseGoalsZero) diagnostics.push('recent_snapshots_repeat_no_failed_or_surprise_flow');
  return diagnostics;
}

function buildStatus({ current, staticWiring }) {
  if (!staticWiring.allRequiredCodeWired) return 'static_wiring_incomplete';
  if (current.failedSurpriseEligible > 0 && current.surpriseGoals > 0) return 'live_working_with_surprise_goals';
  if (current.failedSurpriseEligible > 0 && current.surpriseGoals === 0) return 'harvest_missing_for_failed_surprise';
  if (current.expectationsFailed === 0 && current.surpriseGoals === 0) return 'code_ready_live_blocked_no_failed_samples';
  return 'code_ready_live_blocked_no_surprise_goals';
}

function buildNextActions({ status, current }) {
  const actions = [
    {
      priority: 'P0',
      action: '先把 expectation judge 的 decisive UNKNOWN 降下来，再观察自然 outcome=0',
      ownerDecision: false,
      reason: `当前 failed=${current.expectationsFailed}、decisiveUnknownRate=${current.decisiveUnknownRate ?? 'n/a'}；没有失败样本就不会有 surprise 学习。`,
    },
    {
      priority: 'P0',
      action: '重启 51835 后复验 owner explicit-negative followup 到 source=surprise 的链路',
      ownerDecision: true,
      reason: current.ownerPredictionStatus || status,
    },
    {
      priority: 'P0',
      action: '用 npm run noe:curiosity:yield-report 或 ensure-node22 运行 DB 漏斗，不要用系统 node 直接跑',
      ownerDecision: false,
      reason: 'curiosity-yield 依赖 better-sqlite3；仓库脚本已经通过 ensure-node22 固定运行时。',
    },
  ];
  if (status === 'live_working_with_surprise_goals') {
    actions.unshift({
      priority: 'P0',
      action: '抽样核验每个 source=surprise 目标是否有对应 outcome=0 与证据引用',
      ownerDecision: false,
      reason: '非零计数只证明链路有流量，还需要抽样证明它不是脏数据或手动写入。',
    });
  }
  return actions;
}

export function buildSurpriseLearningAudit({
  root = ROOT,
  paths = DEFAULT_PATHS,
  now = new Date(),
  recentLimit = 8,
} = {}) {
  const resolvedPaths = { ...DEFAULT_PATHS, ...paths };
  const latestEvidence = readJson(resolvedPaths.runtimeEvidenceLatest) || {};
  const snapshots = collectRuntimeSnapshots(resolvedPaths.runtimeEvidenceDir, {
    latestPath: resolvedPaths.runtimeEvidenceLatest,
    limit: recentLimit,
  });
  const packageJson = readJson(resolvedPaths.packageJson) || {};
  const staticWiring = buildStaticWiringEvidence({
    texts: {
      expectationResolver: readText(resolvedPaths.expectationResolver),
      ownerBehaviorPredictor: readText(resolvedPaths.ownerBehaviorPredictor),
      goalSystem: readText(resolvedPaths.goalSystem),
      server: readText(resolvedPaths.server),
      curiosityYieldReport: readText(resolvedPaths.curiosityYieldReport),
    },
    packageJson,
  });
  const current = extractRuntimeCounts(latestEvidence);
  const trend = buildTrend(snapshots);
  const status = buildStatus({ current, staticWiring });
  const diagnostics = buildDiagnostics({ current, trend, staticWiring });
  return {
    ok: true,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    root,
    status,
    surpriseLearningLive: status === 'live_working_with_surprise_goals',
    judgment: status === 'live_working_with_surprise_goals'
      ? 'surprise-learning has live flow, but it still needs sample-level evidence audit'
      : 'surprise-learning is code-ready but not live as an active learning engine',
    policy: {
      readOnlyAudit: true,
      readsRuntimeEvidenceJson: true,
      readsStaticSourceText: true,
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
    current,
    trend,
    staticWiring,
    diagnostics,
    snapshots,
    nextActions: buildNextActions({ status, current }),
  };
}

function mdTable(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

export function renderMarkdown(report, jsonPath = '') {
  const wiringRows = Object.entries(report.staticWiring).map(([key, value]) => [`\`${key}\``, String(value)]);
  const actionRows = report.nextActions.map((item) => [
    item.priority,
    item.ownerDecision ? 'yes' : 'no',
    clean(item.action, 220),
    clean(item.reason, 180),
  ]);
  return [
    '# Neo Surprise Learning Audit',
    '',
    `Generated: ${report.generatedAt}`,
    `Project root: \`${report.root}\``,
    '',
    '## Verdict',
    '',
    `- status: \`${report.status}\``,
    `- surpriseLearningLive: ${report.surpriseLearningLive}`,
    `- judgment: ${report.judgment}`,
    `- diagnostics: ${report.diagnostics.map((item) => `\`${item}\``).join(', ') || '-'}`,
    '',
    '## Current Runtime Counts',
    '',
    mdTable([
      ['metric', 'value'],
      ['---', '---:'],
      ['expectationsCreated', String(report.current.expectationsCreated)],
      ['expectationsSettled', String(report.current.expectationsSettled)],
      ['expectationsFailed', String(report.current.expectationsFailed)],
      ['failedSurpriseEligible', String(report.current.failedSurpriseEligible)],
      ['surpriseGoals', String(report.current.surpriseGoals)],
      ['surpriseGoalsDone', String(report.current.surpriseGoalsDone)],
      ['decisiveUnknownRate', String(report.current.decisiveUnknownRate ?? '-')],
      ['ownerPredictionStatus', report.current.ownerPredictionStatus || '-'],
    ]),
    '',
    '## Recent Trend',
    '',
    mdTable([
      ['metric', 'value'],
      ['---', '---:'],
      ['snapshots', String(report.trend.snapshots)],
      ['allFailedZero', String(report.trend.allFailedZero)],
      ['allFailedSurpriseEligibleZero', String(report.trend.allFailedSurpriseEligibleZero)],
      ['allSurpriseGoalsZero', String(report.trend.allSurpriseGoalsZero)],
      ['maxFailed', String(report.trend.maxFailed)],
      ['maxFailedSurpriseEligible', String(report.trend.maxFailedSurpriseEligible)],
      ['maxSurpriseGoals', String(report.trend.maxSurpriseGoals)],
      ['avgDecisiveUnknownRate', String(report.trend.avgDecisiveUnknownRate ?? '-')],
      ['highUnknownSnapshots', String(report.trend.highUnknownSnapshots)],
    ]),
    '',
    '## Static Wiring',
    '',
    mdTable([
      ['check', 'ok'],
      ['---', '---:'],
      ...wiringRows,
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

export function writeSurpriseLearningAudit(report) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${OUT_BASE}.json`);
  const mdPath = join(OUT_DIR, `${OUT_BASE}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mdPath, `${renderMarkdown(report, jsonPath)}\n`, { mode: 0o600 });
  return { jsonPath, mdPath };
}

export {
  buildStaticWiringEvidence,
  buildTrend,
  collectRuntimeSnapshots,
  extractRuntimeCounts,
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = buildSurpriseLearningAudit();
  const paths = writeSurpriseLearningAudit(report);
  console.log(JSON.stringify({
    ok: report.ok,
    status: report.status,
    surpriseLearningLive: report.surpriseLearningLive,
    expectationsFailed: report.current.expectationsFailed,
    failedSurpriseEligible: report.current.failedSurpriseEligible,
    surpriseGoals: report.current.surpriseGoals,
    diagnostics: report.diagnostics,
    paths,
  }, null, 2));
}
