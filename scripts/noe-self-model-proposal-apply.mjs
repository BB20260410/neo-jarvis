#!/usr/bin/env node
// @ts-check
// P7-D2: explicitly owner-confirmed application of a self-model proposal.
// This command never applies by default; callers must pass --confirm-owner.

import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_IDENTITY } from '../src/context/NoeSelfModel.js';
import { DEFAULT_SELF_MODEL_PROPOSAL_OUT_DIR } from '../src/context/NoeSelfModelProposalAudit.js';
import { applySelfModelDiffProposal } from '../src/context/NoeSelfModelUpdateProtocol.js';
import { createNoeSelfModelVersionStore } from '../src/context/NoeSelfModelVersionStore.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DEFAULT_SELF_MODEL_PROPOSAL_REPORT = resolve(DEFAULT_SELF_MODEL_PROPOSAL_OUT_DIR, 'latest.json');

function rel(file) {
  const abs = resolve(file);
  return abs.startsWith(ROOT) ? relative(ROOT, abs).replace(/\\/g, '/') : abs;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function parseSelfModelProposalApplyArgs(argv = []) {
  const out = {
    source: DEFAULT_SELF_MODEL_PROPOSAL_REPORT,
    selfModelDir: null,
    confirmOwner: false,
    dryRun: false,
  };
  const map = { '--source': 'source', '--self-model-dir': 'selfModelDir' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--confirm-owner') out.confirmOwner = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (map[arg]) out[map[arg]] = argv[++i] || out[map[arg]];
    else {
      for (const [flag, key] of Object.entries(map)) {
        if (arg.startsWith(`${flag}=`)) out[key] = arg.slice(flag.length + 1);
      }
    }
  }
  return out;
}

function effectiveProposalForStore(proposal, store) {
  const current = store?.current?.();
  if (current?.identity) return proposal;
  return {
    ...proposal,
    patch: { ...DEFAULT_IDENTITY, ...(proposal?.patch || {}) },
    requiresOwnerConfirmation: true,
  };
}

function summaryFromResult({ args, report, result, source }) {
  const version = result.version || null;
  return {
    ok: result.ok === true,
    dryRun: args.dryRun === true,
    source: rel(source),
    proposalId: report.proposal?.proposalId || result.proposalId || null,
    proposalStatus: report.proposal?.status || null,
    ownerConfirmed: args.confirmOwner === true,
    applied: result.ok === true,
    reason: result.reason || null,
    versionId: version?.versionId || null,
    previousVersionId: version?.previousVersionId || null,
    file: result.file ? rel(result.file) : null,
    identityFields: version?.identity ? Object.keys(version.identity).sort() : [],
  };
}

export function applySelfModelProposalReport({
  source = DEFAULT_SELF_MODEL_PROPOSAL_REPORT,
  selfModelDir = null,
  confirmOwner = false,
  dryRun = false,
  store = createNoeSelfModelVersionStore({ ...(selfModelDir ? { rootDir: selfModelDir } : {}) }),
} = {}) {
  const args = { confirmOwner, dryRun };
  const file = resolve(source);
  if (!existsSync(file)) {
    return { ok: false, reason: 'proposal_report_missing', source: rel(file) };
  }
  const report = readJson(file);
  if (!report?.proposal) {
    return { ok: false, reason: 'proposal_missing', source: rel(file), decision: report?.decision || null };
  }
  if (confirmOwner !== true) {
    return {
      ok: false,
      reason: 'owner_confirmation_required_for_apply_command',
      source: rel(file),
      proposalId: report.proposal.proposalId || null,
    };
  }
  const proposal = effectiveProposalForStore(report.proposal, store);
  if (dryRun) {
    return summaryFromResult({
      args,
      report: { ...report, proposal },
      source: file,
      result: {
        ok: true,
        proposalId: proposal.proposalId,
        version: {
          versionId: store.nextVersionId?.() || null,
          previousVersionId: store.current?.()?.versionId || null,
          identity: proposal.patch || {},
        },
      },
    });
  }
  const result = applySelfModelDiffProposal({ store, proposal, ownerConfirmed: true });
  return summaryFromResult({ args, report: { ...report, proposal }, result, source: file });
}

export function main(argv = process.argv.slice(2)) {
  const args = parseSelfModelProposalApplyArgs(argv);
  const result = applySelfModelProposalReport(args);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
