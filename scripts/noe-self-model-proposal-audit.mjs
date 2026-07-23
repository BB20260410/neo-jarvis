#!/usr/bin/env node
// @ts-check
// P7-D shadow audit: produce self-model diff proposals without applying them.

import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SELF_MAINTENANCE_REPORT,
  DEFAULT_SELF_MODEL_PROPOSAL_OUT_DIR,
  runSelfModelProposalAudit,
} from '../src/context/NoeSelfModelProposalAudit.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function rel(file) {
  const abs = resolve(file);
  return abs.startsWith(ROOT) ? relative(ROOT, abs).replace(/\\/g, '/') : abs;
}

function parseArgs(argv) {
  const out = {};
  const map = { '--source': 'maintenanceReportRef', '--out-dir': 'outDir' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (map[arg]) out[map[arg]] = argv[++i];
    else for (const [flag, key] of Object.entries(map)) {
      if (arg.startsWith(`${flag}=`)) out[key] = arg.slice(flag.length + 1);
    }
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { report, written } = runSelfModelProposalAudit({
    maintenanceReportRef: args.maintenanceReportRef || DEFAULT_SELF_MAINTENANCE_REPORT,
    outDir: args.outDir || DEFAULT_SELF_MODEL_PROPOSAL_OUT_DIR,
  });
  console.log(JSON.stringify({
    ok: true,
    output: rel(written.latest),
    report: rel(written.file),
    decision: report.decision,
    proposalStatus: report.proposal?.status || null,
    applyAttempted: report.apply.attempted,
  }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
