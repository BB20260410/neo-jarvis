#!/usr/bin/env node
// @ts-check
// Backfill durable workflow metadata into historical goal checkpoints.
// Default is read-only preview; pass --apply to update checkpoint payload JSON.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  serializeGoalCheckpointPayload,
  withGoalCheckpointWorkflow,
} from '../src/cognition/NoeGoalCheckpoints.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.NOE_GOAL_CHECKPOINT_WORKFLOW_OUT_DIR || join(ROOT, 'output', 'noe-goal-checkpoint-workflow');
const DB_PATH = process.env.PANEL_DB_PATH || join(homedir(), '.noe-panel', 'panel.db');
const NOW = Date.now();
const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const refresh = args.has('--refresh');

const { default: Database } = await import('better-sqlite3');

function parseJson(text, fallback = {}) {
  try { return JSON.parse(String(text || '')); } catch { return fallback; }
}

function clean(value = '', max = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function sanitizeObject(value, depth = 0) {
  if (depth > 5 || value === undefined || value === null) return null;
  if (typeof value === 'string') return clean(value, 2000);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => sanitizeObject(item, depth + 1)).filter((item) => item !== null);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 80)) {
      const safeKey = clean(key, 120);
      if (!safeKey || /(?:api[_-]?key|token|secret|password|cookie|authorization|oauth)/i.test(safeKey)) continue;
      const next = sanitizeObject(item, depth + 1);
      if (next !== null) out[safeKey] = next;
    }
    return Object.keys(out).length ? out : null;
  }
  return null;
}

function compactActionEvidence(evidence = null) {
  if (!evidence || typeof evidence !== 'object') return null;
  const out = {
    schemaVersion: evidence.schemaVersion ?? null,
    actionId: clean(evidence.actionId, 160),
    action: clean(evidence.action, 160),
    riskLevel: clean(evidence.riskLevel, 40),
    dryRunOnly: evidence.dryRunOnly !== false,
    evidenceEventId: evidence.evidenceEventId ?? null,
    logRef: clean(evidence.logRef, 1000),
    sha256: clean(evidence.sha256, 80),
    refs: evidence.refs && typeof evidence.refs === 'object' ? evidence.refs : {},
  };
  const semanticTrace = sanitizeObject(evidence.semanticTrace || null);
  if (semanticTrace) out.semanticTrace = semanticTrace;
  return out;
}

function cleanPath(file) {
  return file.startsWith(ROOT) ? file.slice(ROOT.length + 1) : file;
}

if (!existsSync(DB_PATH)) {
  console.log(JSON.stringify({ ok: false, error: `missing db: ${DB_PATH}` }, null, 2));
  process.exit(1);
}

const db = new Database(DB_PATH, apply ? {} : { readonly: true });
try {
  const rows = db.prepare(`
    SELECT id, goal_id, step_index, phase, status, kind, action, step, note, evidence_ref, payload, replay_safe
    FROM noe_goal_checkpoints
    ORDER BY ts ASC, created_at ASC
  `).all();
  const actById = db.prepare('SELECT id, status, risk_level, log_ref, payload FROM noe_acts WHERE id = ?');
  const updates = [];
  for (const row of rows) {
    const payload = parseJson(row.payload, {});
    if (!refresh && payload.workflow?.schemaVersion) continue;
    const nextPayload = { ...payload };
    let actPayload = null;
    if (nextPayload.actId) {
      const act = actById.get(String(nextPayload.actId));
      if (act) {
        actPayload = parseJson(act.payload, {});
        nextPayload.actStatus = nextPayload.actStatus || act.status || null;
        nextPayload.actRiskLevel = nextPayload.actRiskLevel || act.risk_level || null;
        nextPayload.actionEvidenceSummary = nextPayload.actionEvidenceSummary || compactActionEvidence(actPayload.actionEvidence);
        if (nextPayload.readonly !== true && nextPayload.readOnly !== true) {
          const readonly = actPayload.readonly === true || actPayload.actionEvidence?.runtime?.readonly === true;
          if (readonly) nextPayload.readonly = true;
        }
        if (!nextPayload.dryRunOnly && actPayload.dryRunOnly === true) nextPayload.dryRunOnly = true;
      }
    }
    const decorated = withGoalCheckpointWorkflow(nextPayload, {
      checkpointId: row.id,
      goalId: row.goal_id,
      stepIndex: row.step_index,
      phase: row.phase,
      status: row.status,
      kind: row.kind,
      action: row.action,
      step: row.step,
      note: row.note,
      evidenceRef: row.evidence_ref,
      replaySafe: row.replay_safe === 1,
    });
    const serialized = serializeGoalCheckpointPayload(decorated);
    if (serialized && serialized !== row.payload) {
      updates.push({
        id: row.id,
        goalId: row.goal_id,
        stepIndex: row.step_index,
        phase: row.phase,
        kind: row.kind,
        action: row.action,
        hasAct: Boolean(actPayload),
        rollbackStatus: decorated.workflow?.rollbackEvidence?.status || '',
        rollbackRequired: decorated.workflow?.rollbackEvidence?.required === true,
        payload: serialized,
      });
    }
  }

  if (apply && updates.length) {
    const stmt = db.prepare('UPDATE noe_goal_checkpoints SET payload = ? WHERE id = ?');
    const tx = db.transaction((items) => {
      for (const item of items) stmt.run(item.payload, item.id);
    });
    tx(updates);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const reportPath = join(OUT_DIR, `goal-checkpoint-workflow-backfill-${NOW}.json`);
  const latestPath = join(OUT_DIR, 'latest.json');
  const report = {
    ok: true,
    applied: apply,
    refreshedExisting: refresh,
    dbPath: DB_PATH,
    scanned: rows.length,
    updates: updates.length,
    byKind: updates.reduce((acc, item) => {
      const key = item.kind || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    rollbackRequired: updates.filter((item) => item.rollbackRequired).length,
    rollbackMissing: updates.filter((item) => item.rollbackRequired && item.rollbackStatus !== 'available').length,
    sample: updates.slice(0, 12).map(({ payload: _payload, ...item }) => item),
    generatedAt: new Date(NOW).toISOString(),
    reportPath: cleanPath(reportPath),
    latestPath: cleanPath(latestPath),
  };
  const body = JSON.stringify(report, null, 2);
  writeFileSync(reportPath, body, { mode: 0o600 });
  writeFileSync(latestPath, body, { mode: 0o600 });
  console.log(body);
} finally {
  db.close();
}
