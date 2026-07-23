#!/usr/bin/env node
// Build redacted live/runtime + DB summaries for P6 production evidence.
// This script is read-only: it does not call models, mutate live services, or
// read owner-token/secret files.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_FILE), '..');
const SELF_TALK_AUDIT_EVENT_KIND_REF = 'noe_self_talk_audit';

if (!process.env.NOE_P6_SNAPSHOT_NODE22_REEXEC && Number(process.versions.node.split('.')[0]) !== 22) {
  const selected = spawnSync(process.execPath, [resolve(ROOT, 'scripts', 'ensure-node22.mjs'), '--require-22', '--print-bin'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  const node22 = selected.status === 0 ? selected.stdout.trim() : '';
  if (node22) {
    const child = spawnSync(node22, [SCRIPT_FILE, ...process.argv.slice(2)], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, NOE_P6_SNAPSHOT_NODE22_REEXEC: '1' },
    });
    process.exit(typeof child.status === 'number' ? child.status : 1);
  }
}

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] || fallback : fallback;
}

function bool(value) {
  return value === true;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function fetchReadiness({ port }) {
  const url = `http://127.0.0.1:${port}/api/noe/readiness`;
  try {
    const response = await fetch(url);
    const body = await response.json().catch(() => ({}));
    return {
      url,
      ok: response.ok && body?.ok === true,
      status: response.status,
      readinessOk: response.ok && body?.readiness?.status === 'passed',
      p6Loaded: body?.p6 && typeof body.p6 === 'object',
      p6Counts: body?.p6 || null,
    };
  } catch (error) {
    return {
      url,
      ok: false,
      status: 0,
      readinessOk: false,
      p6Loaded: false,
      error: String(error?.message || error).slice(0, 160),
    };
  }
}

async function collectDbSummary({ mode, port, limit }) {
  const { listEvents } = await import('../src/storage/SqliteStore.js');
  const { SELF_TALK_AUDIT_EVENT_KIND, summarizeSelfTalkAuditEvents } = await import('../src/cognition/SelfTalkRuntimeEvidence.js');
  let rows = [];
  let error = null;
  try {
    rows = listEvents({ kind: SELF_TALK_AUDIT_EVENT_KIND, limit, order: 'ASC' });
  } catch (e) {
    error = String(e?.message || e).slice(0, 160);
  }
  const summary = summarizeSelfTalkAuditEvents(rows);
  return {
    verified: summary.ok === true && rows.length > 0,
    mode,
    port,
    selfTalkOutcomes: num(summary.selfTalkOutcomes),
    guardRecords: num(summary.guardRecords),
    confirmedDelivery: num(summary.confirmedDelivery),
    synthesizedOnlyDelivery: num(summary.synthesizedOnlyDelivery),
    confirmedSelfTalkLandingRate: num(summary.confirmedSelfTalkLandingRate),
    ruminationGuardTripRate: num(summary.ruminationGuardTripRate),
    secretValuesReturned: false,
    ownerTokenPrinted: false,
    evidenceRefs: [`sqlite:events/kind=${SELF_TALK_AUDIT_EVENT_KIND}/count=${rows.length}`],
    ...(error ? { error } : {}),
  };
}

const port = Number(argValue('--port', process.env.PORT || 51835));
const mode = argValue('--mode', process.env.NOE_INNER_MODE || 'audit');
const limit = Math.max(1, Math.min(10000, Number(argValue('--limit', 10000)) || 10000));
const outDirArg = argValue('--out-dir');
const outDir = outDirArg ? resolve(outDirArg) : null;

const live = await fetchReadiness({ port });
const db = await collectDbSummary({ mode, port, limit });
const runtime = {
  mode,
  port,
  healthOk: bool(live.ok),
  readinessOk: bool(live.readinessOk),
  liveVerified: bool(live.ok) && bool(live.readinessOk) && bool(live.p6Loaded),
  no51735Touched: true,
  secretValuesReturned: false,
  ownerTokenPrinted: false,
  evidenceRefs: [live.url, 'script:noe-p6-live-evidence-snapshot'],
  p6Loaded: bool(live.p6Loaded),
  p6Counts: live.p6Counts || null,
  ...(live.error ? { error: live.error } : {}),
};
const frontendAck = {
  confirmedDelivery: db.confirmedDelivery,
  confirmedSelfTalkLandingRate: db.confirmedSelfTalkLandingRate,
  secretValuesReturned: false,
  ownerTokenPrinted: false,
  evidenceRefs: [`sqlite:events/kind=${SELF_TALK_AUDIT_EVENT_KIND_REF}/confirmedDelivery=${db.confirmedDelivery}`],
};

const report = { ok: runtime.liveVerified && db.verified, runtime, db, frontendAck };

if (outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'p6-runtime-summary.json'), `${JSON.stringify(runtime, null, 2)}\n`, 'utf8');
  writeFileSync(resolve(outDir, 'p6-db-summary.json'), `${JSON.stringify(db, null, 2)}\n`, 'utf8');
  writeFileSync(resolve(outDir, 'p6-frontend-ack-summary.json'), `${JSON.stringify(frontendAck, null, 2)}\n`, 'utf8');
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
