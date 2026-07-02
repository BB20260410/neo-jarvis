#!/usr/bin/env node
// Verify a P6 live/DB production evidence JSON file without touching live services.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateP6ProductionEvidence } from '../src/cognition/P6ProductionEvidence.js';
import { parseSelfTalkAuditJsonl, summarizeSelfTalkAudit } from '../src/cognition/SelfTalkAuditStore.js';

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] || fallback : fallback;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { __readError: error?.message || 'malformed_json' };
  }
}

function readAuditSummary(file) {
  if (!file) return null;
  const resolved = resolve(file);
  if (!existsSync(resolved)) {
    return { ok: false, missing: true, file: resolved };
  }
  const parsed = parseSelfTalkAuditJsonl(readFileSync(resolved, 'utf8'));
  return summarizeSelfTalkAudit(parsed.records, { malformed: parsed.malformed });
}

const evidenceArg = argValue('--evidence-file');
if (!evidenceArg) {
  console.log(JSON.stringify({
    ok: false,
    reason: 'evidence_file_required',
  }, null, 2));
  process.exit(1);
}

const evidenceFile = resolve(evidenceArg);
if (!existsSync(evidenceFile)) {
  console.log(JSON.stringify({
    ok: false,
    reason: 'evidence_file_missing',
    evidenceFile,
  }, null, 2));
  process.exit(1);
}

const evidence = readJson(evidenceFile);
if (evidence.__readError) {
  console.log(JSON.stringify({
    ok: false,
    reason: 'evidence_file_malformed',
    evidenceFile,
  }, null, 2));
  process.exit(1);
}

const auditSummary = readAuditSummary(argValue('--audit-file'));
const report = validateP6ProductionEvidence(evidence, { auditSummary });
console.log(JSON.stringify({
  ok: report.ok,
  evidenceFile,
  blockers: report.blockers,
  warnings: report.warnings,
  summary: report.summary,
}, null, 2));
process.exit(report.ok ? 0 : 1);
