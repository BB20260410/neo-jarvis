#!/usr/bin/env node
// Verify P6 rumination/self-talk readiness without touching live services.

import { verifyP6RuminationReadiness } from '../src/cognition/P6RuminationReadiness.js';

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] || fallback : fallback;
}

const report = verifyP6RuminationReadiness({
  root: argValue('--root', process.cwd()),
  auditFile: argValue('--audit-file', null),
  liveEvidenceFile: argValue('--live-evidence-file', null),
  requireAudit: process.argv.includes('--require-audit'),
  requireLive: process.argv.includes('--require-live'),
});

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
