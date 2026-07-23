#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getOrCreateOwnerToken } from '../src/server/auth/owner-token.js';
import { resolveNoeConsensusRef } from '../src/room/NoeConsensusLedger.js';
import {
  buildStageDEvidencePack,
  buildStageDLiveScratchReport,
  buildStageDRollbackReport,
  buildStageDScratchMemoryInput,
  scanStageDRedaction,
} from '../src/runtime/NoeLive51835ScratchEvidence.js';
import { resolveOwnerTokenAuthorization } from './lib/noe-standing-autonomy-grant.mjs';

const DEFAULT_OUT = 'output/noe-final-real-machine-stages/20260619/stage-D-live-51835-scratch-write.json';
const DEFAULT_ROLLBACK_OUT = 'output/noe-final-real-machine-stages/20260619/stage-D-rollback.json';
const DEFAULT_EVIDENCE_PACK = 'output/noe-final-real-machine-stages/20260619/stage-D-evidence-pack.md';

function parseArgs(argv) {
  const out = {
    baseUrl: 'http://127.0.0.1:51835',
    out: DEFAULT_OUT,
    rollbackOut: DEFAULT_ROLLBACK_OUT,
    evidencePack: DEFAULT_EVIDENCE_PACK,
    ackReadOwnerCredential: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base-url') out.baseUrl = argv[++i];
    else if (arg.startsWith('--base-url=')) out.baseUrl = arg.slice('--base-url='.length);
    else if (arg === '--out') out.out = argv[++i];
    else if (arg.startsWith('--out=')) out.out = arg.slice('--out='.length);
    else if (arg === '--rollback-out') out.rollbackOut = argv[++i];
    else if (arg.startsWith('--rollback-out=')) out.rollbackOut = arg.slice('--rollback-out='.length);
    else if (arg === '--evidence-pack') out.evidencePack = argv[++i];
    else if (arg.startsWith('--evidence-pack=')) out.evidencePack = arg.slice('--evidence-pack='.length);
    else if (arg === '--ack-read-owner-token') out.ackReadOwnerCredential = true;
    else throw new Error(`unknown arg: ${arg}`);
  }
  return out;
}

function writeJsonRef(ref, value) {
  const file = resolveNoeConsensusRef(process.cwd(), ref);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return file;
}

function writeTextRef(ref, value) {
  const file = resolveNoeConsensusRef(process.cwd(), ref);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, String(value), { mode: 0o600 });
  return file;
}

function urlWithPath(baseUrl, path) {
  return new URL(path, baseUrl).toString();
}

async function requestJson({ baseUrl, path, method = 'GET', credential, body }) {
  const headers = { accept: 'application/json' };
  if (credential) headers['X-Panel-Owner-Token'] = credential;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(urlWithPath(baseUrl, path), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return {
    ok: res.ok,
    httpStatus: res.status,
    json,
    textLength: text.length,
  };
}

function memoryQueryPath({ marker, projectId }) {
  const params = new URLSearchParams({
    projectId,
    q: marker,
    limit: '10',
  });
  return `/api/noe/memory?${params.toString()}`;
}

function scratchVisibility(result, scratchId) {
  const items = Array.isArray(result?.json?.items) ? result.json.items : [];
  return {
    count: Number.isFinite(Number(result?.json?.count)) ? Number(result.json.count) : items.length,
    visible: items.some((item) => item?.id === scratchId),
  };
}

function authSummary(callAuth, readAuth) {
  return {
    authorized: callAuth.authorized === true && readAuth.authorized === true,
    mode: callAuth.mode === readAuth.mode ? callAuth.mode : `${callAuth.mode}+${readAuth.mode}`,
    scope: 'live-protected-api:call+owner-token:read',
    grantRefStatus: callAuth.source === 'standing_autonomy_grant' || readAuth.source === 'standing_autonomy_grant'
      ? 'standing_grant_present'
      : 'explicit_ack_or_env',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const observedAt = new Date().toISOString();
  const projectId = 'stage-d-scratch';
  const marker = `stage-d-${observedAt}-${randomUUID()}`;
  const scratchId = `stage-d-live-scratch-${randomUUID()}`;
  const commandRefs = [
    `node scripts/noe-live-51835-scratch-write.mjs --out ${args.out}`,
    'node scripts/noe-final-stage-matrix-verify.mjs',
  ];

  const callAuth = resolveOwnerTokenAuthorization({
    explicitAck: args.ackReadOwnerCredential,
    scope: 'live-protected-api:call',
  });
  const readAuth = resolveOwnerTokenAuthorization({
    explicitAck: args.ackReadOwnerCredential,
    scope: 'owner-token:read',
  });
  if (!callAuth.authorized || !readAuth.authorized) {
    const rollbackReport = buildStageDRollbackReport({
      observedAt,
      scratchId,
      marker,
      cleanupOk: false,
      visibleAfterCleanup: null,
    });
    const report = buildStageDLiveScratchReport({
      observedAt,
      baseUrlRef: args.baseUrl,
      rollbackRef: args.rollbackOut,
      auth: authSummary(callAuth, readAuth),
      scratch: { id: scratchId, marker, projectId },
      steps: [{ name: 'authorization_check', ok: false, httpStatus: null, expected: 'standing grant or explicit acknowledgement' }],
      counts: {},
      cleanup: { attempted: false, ok: false, visibleAfterCleanup: null },
      reviewerCapsuleRef: args.evidencePack,
    });
    const findings = scanStageDRedaction(report, { disallowedStrings: [marker, scratchId] });
    writeJsonRef(args.rollbackOut, rollbackReport);
    writeJsonRef(args.out, report);
    writeTextRef(args.evidencePack, buildStageDEvidencePack({
      report,
      rollbackReport,
      evidenceRef: args.out,
      rollbackRef: args.rollbackOut,
      commandRefs,
      redactionFindings: findings,
    }));
    console.log(JSON.stringify({ ok: false, out: args.out, rollbackOut: args.rollbackOut, evidencePack: args.evidencePack, redactionFindings: findings }, null, 2));
    process.exit(1);
  }

  const credential = getOrCreateOwnerToken();
  if (!credential) throw new Error('owner credential unavailable');

  const memoryInput = buildStageDScratchMemoryInput({
    scratchId,
    marker,
    sourceRef: args.out,
    projectId,
    now: new Date(observedAt),
  });
  const queryPath = memoryQueryPath({ marker, projectId });

  const steps = [];
  const before = await requestJson({ baseUrl: args.baseUrl, path: queryPath, credential });
  const beforeVisible = scratchVisibility(before, scratchId);
  steps.push({
    name: 'before_query',
    ok: before.ok && !beforeVisible.visible,
    httpStatus: before.httpStatus,
    expected: 'protected memory query reachable and scratch id absent',
  });

  const write = await requestJson({
    baseUrl: args.baseUrl,
    path: '/api/noe/memory',
    method: 'POST',
    credential,
    body: memoryInput,
  });
  steps.push({
    name: 'scratch_write',
    ok: write.ok && write.httpStatus === 201 && write.json?.ok === true && write.json?.item?.id === scratchId,
    httpStatus: write.httpStatus,
    expected: 'POST creates the scratch memory id',
  });

  const afterWrite = await requestJson({ baseUrl: args.baseUrl, path: queryPath, credential });
  const afterWriteVisible = scratchVisibility(afterWrite, scratchId);
  steps.push({
    name: 'after_write_query',
    ok: afterWrite.ok && afterWriteVisible.visible,
    httpStatus: afterWrite.httpStatus,
    expected: 'scratch id visible after write',
  });

  const cleanup = await requestJson({
    baseUrl: args.baseUrl,
    path: `/api/noe/memory/${encodeURIComponent(scratchId)}?projectId=${encodeURIComponent(projectId)}&reason=stage_d_cleanup`,
    method: 'DELETE',
    credential,
  });
  steps.push({
    name: 'cleanup_delete',
    ok: cleanup.ok && cleanup.json?.ok === true,
    httpStatus: cleanup.httpStatus,
    expected: 'DELETE hides the scratch memory id',
  });

  const afterCleanup = await requestJson({ baseUrl: args.baseUrl, path: queryPath, credential });
  const afterCleanupVisible = scratchVisibility(afterCleanup, scratchId);
  steps.push({
    name: 'after_cleanup_query',
    ok: afterCleanup.ok && !afterCleanupVisible.visible,
    httpStatus: afterCleanup.httpStatus,
    expected: 'scratch id absent after cleanup',
  });

  const rollbackReport = buildStageDRollbackReport({
    observedAt,
    scratchId,
    marker,
    httpStatus: cleanup.httpStatus,
    cleanupOk: cleanup.ok && cleanup.json?.ok === true,
    visibleAfterCleanup: afterCleanupVisible.visible,
  });
  const report = buildStageDLiveScratchReport({
    observedAt,
    baseUrlRef: args.baseUrl,
    rollbackRef: args.rollbackOut,
    auth: authSummary(callAuth, readAuth),
    scratch: {
      id: scratchId,
      marker,
      projectId,
      ttlMs: memoryInput.ttlMs,
      salience: memoryInput.salience,
    },
    steps,
    counts: {
      beforeVisible: beforeVisible.visible ? 1 : 0,
      afterWriteVisible: afterWriteVisible.visible ? 1 : 0,
      afterCleanupVisible: afterCleanupVisible.visible ? 1 : 0,
    },
    cleanup: {
      attempted: true,
      ok: cleanup.ok && cleanup.json?.ok === true,
      httpStatus: cleanup.httpStatus,
      visibleAfterCleanup: afterCleanupVisible.visible,
    },
    reviewerCapsuleRef: args.evidencePack,
  });
  const redactionFindings = [
    ...scanStageDRedaction(report, { disallowedStrings: [marker, scratchId, memoryInput.body, credential] }),
    ...scanStageDRedaction(rollbackReport, { disallowedStrings: [marker, scratchId, memoryInput.body, credential] }),
  ];

  writeJsonRef(args.rollbackOut, rollbackReport);
  writeJsonRef(args.out, report);
  writeTextRef(args.evidencePack, buildStageDEvidencePack({
    report,
    rollbackReport,
    evidenceRef: args.out,
    rollbackRef: args.rollbackOut,
    commandRefs,
    redactionFindings,
  }));

  console.log(JSON.stringify({
    ok: report.ok === true && rollbackReport.ok === true && redactionFindings.length === 0,
    out: args.out,
    rollbackOut: args.rollbackOut,
    evidencePack: args.evidencePack,
    steps: report.steps,
    counts: report.counts,
    redactionFindings,
  }, null, 2));
  if (report.ok !== true || rollbackReport.ok !== true || redactionFindings.length) process.exit(1);
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e?.message || String(e) }, null, 2));
  process.exit(1);
});
