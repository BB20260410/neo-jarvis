#!/usr/bin/env node
// @ts-check
// Read-only semanticTrace coverage snapshot for Noe action evidence.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.NOE_ACTION_SEMANTIC_TRACE_OUT_DIR || join(ROOT, 'output', 'noe-action-semantic-trace');
const DB_PATH = process.env.PANEL_DB_PATH || join(homedir(), '.noe-panel', 'panel.db');
const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

const { default: Database } = await import('better-sqlite3');

function parseJson(text, fallback = {}) {
  try { return JSON.parse(String(text || '')); } catch { return fallback; }
}

function clean(value = '', max = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanPath(file = '') {
  return file.startsWith(ROOT) ? file.slice(ROOT.length + 1) : file;
}

function tableExists(db, table) {
  try {
    return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  } catch {
    return false;
  }
}

function safeAll(db, sql, params = []) {
  try { return db.prepare(sql).all(...params); } catch { return []; }
}

function semanticTraceInfo(trace = null) {
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) return null;
  const keys = Object.entries(trace)
    .filter(([key, value]) => key !== 'fingerprint' && Array.isArray(value) && value.length)
    .map(([key, value]) => ({ key: clean(key, 80), count: value.length }));
  if (!keys.length) return null;
  return {
    keyCount: keys.length,
    keys,
    hasFingerprint: /^[a-f0-9]{24}$/.test(String(trace.fingerprint || '')),
  };
}

function summarizeActionRows(rows = [], sinceMs = 0) {
  const out = {
    scanned: rows.length,
    recentScanned: 0,
    withActionEvidence: 0,
    withSemanticTrace: 0,
    recentWithSemanticTrace: 0,
    withGoal: 0,
    withExpectation: 0,
    withCheckpoint: 0,
    latestSemanticTrace: null,
  };
  for (const row of rows) {
    const updatedAt = Number(row.updated_at || row.updatedAt || 0);
    const recent = sinceMs > 0 && updatedAt >= sinceMs;
    if (recent) out.recentScanned += 1;
    const payload = parseJson(row.payload, {});
    const evidence = payload?.actionEvidence;
    if (evidence && typeof evidence === 'object') out.withActionEvidence += 1;
    const trace = evidence?.semanticTrace;
    const info = semanticTraceInfo(trace);
    if (!info) continue;
    out.withSemanticTrace += 1;
    if (recent) out.recentWithSemanticTrace += 1;
    if (Array.isArray(trace.goal) && trace.goal.length) out.withGoal += 1;
    if (Array.isArray(trace.expectation) && trace.expectation.length) out.withExpectation += 1;
    if (Array.isArray(trace.checkpoint) && trace.checkpoint.length) out.withCheckpoint += 1;
    out.latestSemanticTrace ||= {
      id: clean(row.id, 120),
      action: clean(row.action, 180),
      status: clean(row.status, 80),
      updatedAt,
      trace: info,
    };
  }
  return out;
}

function summarizeCheckpointRows(rows = [], sinceMs = 0) {
  const out = {
    scanned: rows.length,
    recentScanned: 0,
    withActionEvidenceSummary: 0,
    withSemanticTrace: 0,
    recentWithSemanticTrace: 0,
    latestSemanticTrace: null,
  };
  for (const row of rows) {
    const ts = Number(row.ts || 0);
    const recent = sinceMs > 0 && ts >= sinceMs;
    if (recent) out.recentScanned += 1;
    const payload = parseJson(row.payload, {});
    const summary = payload?.actionEvidenceSummary;
    if (summary && typeof summary === 'object') out.withActionEvidenceSummary += 1;
    const info = semanticTraceInfo(summary?.semanticTrace);
    if (!info) continue;
    out.withSemanticTrace += 1;
    if (recent) out.recentWithSemanticTrace += 1;
    out.latestSemanticTrace ||= {
      id: clean(row.id, 120),
      action: clean(row.action, 180),
      phase: clean(row.phase, 80),
      status: clean(row.status, 80),
      ts,
      trace: info,
    };
  }
  return out;
}

function summarizeExpectationTicks(rows = []) {
  const out = {
    scanned: rows.length,
    ticksWithPreviousResult: 0,
    checked: 0,
    resolved: 0,
    judged: 0,
    judgedWithAlignment: 0,
    judgedWithTraceAlignment: 0,
    semanticLinkedActionEvents: 0,
    semanticActionMaxCoverage: 0,
    semanticTraceActionEvents: 0,
    semanticTraceLinkedActionEvents: 0,
    semanticTraceMaxCoverage: 0,
    latestWithPreviousResult: null,
  };
  for (const row of rows) {
    const outcome = parseJson(row.outcome, {});
    const previousResult = outcome.previousResult && typeof outcome.previousResult === 'object'
      ? outcome.previousResult
      : null;
    if (!previousResult) continue;
    const judged = Array.isArray(previousResult.judged) ? previousResult.judged : [];
    out.ticksWithPreviousResult += 1;
    out.checked += Number(previousResult.checked || 0);
    out.resolved += Number(previousResult.resolved || 0);
    out.judged += judged.length;
    for (const item of judged) {
      const alignment = item?.evidenceClaimAlignment;
      if (!alignment || typeof alignment !== 'object') continue;
      out.judgedWithAlignment += 1;
      out.semanticLinkedActionEvents += Number(alignment.semanticLinkedActionEvents || 0);
      out.semanticActionMaxCoverage = Math.max(out.semanticActionMaxCoverage, Number(alignment.semanticActionMaxCoverage || 0));
      if (Number(alignment.semanticTraceActionEvents || 0) > 0 || Number(alignment.semanticTraceMaxCoverage || 0) > 0) {
        out.judgedWithTraceAlignment += 1;
      }
      out.semanticTraceActionEvents += Number(alignment.semanticTraceActionEvents || 0);
      out.semanticTraceLinkedActionEvents += Number(alignment.semanticTraceLinkedActionEvents || 0);
      out.semanticTraceMaxCoverage = Math.max(out.semanticTraceMaxCoverage, Number(alignment.semanticTraceMaxCoverage || 0));
    }
    out.latestWithPreviousResult ||= {
      id: Number(row.id) || null,
      status: clean(row.status, 80),
      finishedAt: Number(row.finished_at || 0),
      checked: Number(previousResult.checked || 0),
      resolved: Number(previousResult.resolved || 0),
      judged: judged.length,
    };
  }
  return out;
}

export function buildActionSemanticTraceSnapshot(db, {
  now = NOW,
  sinceMs = now - DAY_MS,
  limit = 1000,
  dbPath = DB_PATH,
} = {}) {
  const lim = Math.max(1, Math.min(5000, Number(limit) || 1000));
  const acts = tableExists(db, 'noe_acts')
    ? safeAll(db, 'SELECT id, action, status, updated_at, payload FROM noe_acts ORDER BY updated_at DESC LIMIT ?', [lim])
    : [];
  const checkpoints = tableExists(db, 'noe_goal_checkpoints')
    ? safeAll(db, "SELECT id, ts, phase, status, kind, action, payload FROM noe_goal_checkpoints WHERE kind = 'act' ORDER BY ts DESC LIMIT ?", [lim])
    : [];
  const ticks = tableExists(db, 'noe_ticks')
    ? safeAll(db, "SELECT id, kind, status, finished_at, outcome FROM noe_ticks WHERE kind = 'expectation' ORDER BY id DESC LIMIT 100", [])
    : [];
  const actionCoverage = summarizeActionRows(acts, sinceMs);
  const checkpointCoverage = summarizeCheckpointRows(checkpoints, sinceMs);
  const expectationTicks = summarizeExpectationTicks(ticks);
  const blockers = [];
  if (actionCoverage.withSemanticTrace <= 0) blockers.push('action_semantic_trace_absent');
  if (checkpointCoverage.withActionEvidenceSummary > 0 && checkpointCoverage.withSemanticTrace <= 0) blockers.push('checkpoint_semantic_trace_absent');
  if (actionCoverage.recentScanned > 0 && actionCoverage.recentWithSemanticTrace <= 0) blockers.push('recent_action_semantic_trace_absent');
  return {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    since: {
      ms: sinceMs,
      iso: sinceMs ? new Date(sinceMs).toISOString() : null,
    },
    status: {
      actionSemanticTraceReady: actionCoverage.withSemanticTrace > 0,
      checkpointSemanticTraceReady: checkpointCoverage.withSemanticTrace > 0,
      recentActionSemanticTraceReady: actionCoverage.recentScanned > 0 && actionCoverage.recentWithSemanticTrace > 0,
      expectationAlignmentObserved: expectationTicks.judgedWithAlignment > 0,
      expectationTraceAlignmentObserved: expectationTicks.judgedWithTraceAlignment > 0,
      blockers,
    },
    actionCoverage,
    checkpointCoverage,
    expectationTicks,
    source: {
      dbPath,
      policy: 'read-only; no owner token; no model calls; no raw semantic values exported',
    },
  };
}

export function writeActionSemanticTraceSnapshot(report, { outDir = OUT_DIR, now = NOW } = {}) {
  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, `action-semantic-trace-${now}.json`);
  const latestPath = join(outDir, 'latest.json');
  const body = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(reportPath, body, { mode: 0o600 });
  writeFileSync(latestPath, body, { mode: 0o600 });
  return { reportPath: cleanPath(reportPath), latestPath: cleanPath(latestPath) };
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    requireTrace: false,
    sinceMs: Number(process.env.NOE_ACTION_SEMANTIC_TRACE_SINCE_MS || 0) || NOW - DAY_MS,
    limit: Number(process.env.NOE_ACTION_SEMANTIC_TRACE_LIMIT || 0) || 1000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--require-trace') out.requireTrace = true;
    else if (arg === '--since-iso') out.sinceMs = Date.parse(String(argv[++i] || '')) || out.sinceMs;
    else if (arg === '--since-ms') out.sinceMs = Number(argv[++i]) || out.sinceMs;
    else if (arg === '--limit') out.limit = Number(argv[++i]) || out.limit;
  }
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!existsSync(DB_PATH)) {
    console.log(JSON.stringify({ ok: false, error: `missing db: ${DB_PATH}` }, null, 2));
    process.exitCode = 1;
    return;
  }
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const report = buildActionSemanticTraceSnapshot(db, {
      now: NOW,
      sinceMs: args.sinceMs,
      limit: args.limit,
      dbPath: DB_PATH,
    });
    const paths = writeActionSemanticTraceSnapshot(report);
    const out = { ...report, ...paths };
    console.log(JSON.stringify(out, null, 2));
    if (args.requireTrace && !report.status.actionSemanticTraceReady) process.exitCode = 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
