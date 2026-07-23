#!/usr/bin/env node
// Compose a P6 production evidence JSON file from redacted runtime/DB/audit summaries.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { composeP6ProductionEvidence } from '../src/cognition/P6ProductionEvidenceComposer.js';
import { validateP6ProductionEvidence } from '../src/cognition/P6ProductionEvidence.js';
import { parseSelfTalkAuditJsonl, summarizeSelfTalkAudit } from '../src/cognition/SelfTalkAuditStore.js';

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] || fallback : fallback;
}

function readJson(file, label) {
  if (!file) return { ok: false, reason: `${label}_file_required` };
  const resolved = resolve(file);
  if (!existsSync(resolved)) return { ok: false, reason: `${label}_file_missing`, file: resolved };
  try {
    return { ok: true, file: resolved, value: JSON.parse(readFileSync(resolved, 'utf8')) };
  } catch {
    return { ok: false, reason: `${label}_file_malformed`, file: resolved };
  }
}

function readAudit(file) {
  if (!file) return { ok: false, reason: 'audit_file_required' };
  const resolved = resolve(file);
  if (!existsSync(resolved)) return { ok: false, reason: 'audit_file_missing', file: resolved };
  const parsed = parseSelfTalkAuditJsonl(readFileSync(resolved, 'utf8'));
  const summary = summarizeSelfTalkAudit(parsed.records, { malformed: parsed.malformed });
  return {
    ok: parsed.malformed === 0,
    reason: parsed.malformed === 0 ? null : 'audit_file_malformed_jsonl',
    file: resolved,
    value: {
      ...summary,
      evidenceRefs: [`jsonl:${resolved}`],
    },
  };
}

const runtime = readJson(argValue('--runtime-file'), 'runtime');
const db = readJson(argValue('--db-file'), 'db');
const audit = readAudit(argValue('--audit-file'));
const frontendAckArg = argValue('--frontend-ack-file');
const frontendAck = frontendAckArg ? readJson(frontendAckArg, 'frontend_ack') : { ok: true, value: {} };
const failedInput = [runtime, db, audit, frontendAck].find((item) => !item.ok);

if (failedInput) {
  console.log(JSON.stringify({
    ok: false,
    reason: failedInput.reason,
    file: failedInput.file || null,
  }, null, 2));
  process.exit(1);
}

const evidence = composeP6ProductionEvidence({
  runtime: runtime.value,
  db: db.value,
  auditSummary: audit.value,
  frontendAck: frontendAck.value,
  sampleKind: argValue('--sample-kind', 'production'),
  mode: argValue('--mode', null),
});
const validation = validateP6ProductionEvidence(evidence, { auditSummary: audit.value });
const out = argValue('--out', null);

if (out) {
  const outFile = resolve(out);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    ok: validation.ok,
    outFile,
    blockers: validation.blockers,
    warnings: validation.warnings,
    summary: validation.summary,
  }, null, 2));
} else {
  console.log(JSON.stringify(evidence, null, 2));
}

process.exit(validation.ok ? 0 : 1);
