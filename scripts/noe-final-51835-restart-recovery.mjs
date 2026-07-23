#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveNoeConsensusRef } from '../src/room/NoeConsensusLedger.js';
import {
  buildStageEEvidencePack,
  buildStageEFinalRestartReport,
  scanStageERedaction,
} from '../src/runtime/NoeFinal51835RestartEvidence.js';

const DEFAULT_OUT = 'output/noe-final-real-machine-stages/20260619/stage-E-final-51835-restart-recovery.json';
const DEFAULT_EVIDENCE_PACK = 'output/noe-final-real-machine-stages/20260619/stage-E-evidence-pack.md';
const DEFAULT_DRILL_OUT_DIR = 'output/noe-final-real-machine-stages/20260619/stage-E-runtime-drill';
const DEFAULT_PREFLIGHT_REF = 'output/noe-final-real-machine-stages/20260619/stage-E-preflight.json';

function parseArgs(argv) {
  const out = {
    out: DEFAULT_OUT,
    evidencePack: DEFAULT_EVIDENCE_PACK,
    drillOutDir: DEFAULT_DRILL_OUT_DIR,
    preflightOut: DEFAULT_PREFLIGHT_REF,
    apply: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') out.out = argv[++i];
    else if (arg.startsWith('--out=')) out.out = arg.slice('--out='.length);
    else if (arg === '--evidence-pack') out.evidencePack = argv[++i];
    else if (arg.startsWith('--evidence-pack=')) out.evidencePack = arg.slice('--evidence-pack='.length);
    else if (arg === '--drill-out-dir') out.drillOutDir = argv[++i];
    else if (arg.startsWith('--drill-out-dir=')) out.drillOutDir = arg.slice('--drill-out-dir='.length);
    else if (arg === '--preflight-out') out.preflightOut = argv[++i];
    else if (arg.startsWith('--preflight-out=')) out.preflightOut = arg.slice('--preflight-out='.length);
    else if (arg === '--no-apply') out.apply = false;
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

function parseJsonFromStdout(stdout) {
  const text = String(stdout || '');
  const start = text.indexOf('{');
  if (start < 0) throw new Error('json_stdout_not_found');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('json_stdout_unclosed');
}

function runNodeScript(args, env = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'noe-stage-e-child-'));
  const stdoutPath = join(tmp, 'stdout.txt');
  const stderrPath = join(tmp, 'stderr.txt');
  const stdoutFd = openSync(stdoutPath, 'w');
  const stderrFd = openSync(stderrPath, 'w');
  const out = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', stdoutFd, stderrFd],
  });
  closeSync(stdoutFd);
  closeSync(stderrFd);
  const stdout = readFileSync(stdoutPath, 'utf8');
  const stderr = readFileSync(stderrPath, 'utf8');
  rmSync(tmp, { recursive: true, force: true });
  return {
    status: out.status,
    signal: out.signal || null,
    stdout,
    stderr,
    error: out.error?.message || '',
  };
}

function assertPreflightSafe(preflight) {
  const decision = preflight?.preflight?.decision;
  if (preflight?.ok !== true || decision?.safeToRestart !== true || (decision?.blockers || []).length) {
    throw new Error('stage_e_preflight_not_safe_to_restart');
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const commandRefs = [
    'node scripts/restart-panel.mjs --check-only',
    `NOE_RUNTIME_RESTART_DRILL_OUT_DIR=${args.drillOutDir} node scripts/noe-runtime-restart-recovery-drill.mjs${args.apply ? ' --apply' : ''}`,
    'node scripts/noe-final-stage-matrix-verify.mjs --require-complete',
  ];

  const preflightRun = runNodeScript(['scripts/restart-panel.mjs', '--check-only']);
  const preflight = parseJsonFromStdout(preflightRun.stdout);
  writeJsonRef(args.preflightOut, preflight);
  assertPreflightSafe(preflight);

  const drillRun = runNodeScript(
    ['scripts/noe-runtime-restart-recovery-drill.mjs', ...(args.apply ? ['--apply'] : [])],
    { NOE_RUNTIME_RESTART_DRILL_OUT_DIR: args.drillOutDir },
  );
  const drill = parseJsonFromStdout(drillRun.stdout);
  const observedAt = new Date().toISOString();
  const report = buildStageEFinalRestartReport({
    observedAt,
    drill,
    drillReportRef: drill.reportPath,
    preflight,
    preflightRef: args.preflightOut,
    evidencePackRef: args.evidencePack,
  });
  const redactionFindings = scanStageERedaction(report);
  writeJsonRef(args.out, report);
  writeTextRef(args.evidencePack, buildStageEEvidencePack({
    report,
    evidenceRef: args.out,
    commandRefs,
    redactionFindings,
  }));

  const result = {
    ok: report.ok === true && redactionFindings.length === 0,
    out: args.out,
    evidencePack: args.evidencePack,
    preflightOut: args.preflightOut,
    drillReportRef: drill.reportPath,
    drillStatus: drillRun.status,
    redactionFindings,
    checks: {
      preflightSafeToRestart: report.preflight.safeToRestart,
      applied: report.restart.applied,
      realRestartAttempted: report.restart.realRestartAttempted,
      pidChanged: report.restart.pidChanged,
      oldPidAbsent: report.restart.oldPidAbsent,
      newPidCwdIsRoot: report.restart.newPidCwdIsRoot,
      port51735Untouched: report.ports.port51735Untouched,
      healthOk: report.health.ok,
      readinessPassed: report.readiness.passed,
      freedomLiveOk: report.freedomLive.ok,
    },
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

main();
