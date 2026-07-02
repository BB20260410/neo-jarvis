#!/usr/bin/env node
// @ts-check

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runNoeMemoryRoadmapVerification } from '../src/memory/NoeMemoryRoadmapVerifier.js';

function flag(name) {
  return process.argv.includes(name);
}

const report = await runNoeMemoryRoadmapVerification({ includeRealDb: !flag('--isolated-only') });
const outDir = join(process.cwd(), 'output', 'noe-memory-roadmap');
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `noe-memory-roadmap-${Date.now()}.json`);
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  ok: report.ok,
  reportPath: file,
  requiredChecks: report.requiredChecks.map((c) => ({ id: c.id, passed: c.passed })),
  advisoryChecks: report.advisoryChecks.map((c) => ({ id: c.id, passed: c.passed })),
}, null, 2));
if (flag('--require-pass') && !report.ok) process.exit(1);
