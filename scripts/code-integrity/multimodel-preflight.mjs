#!/usr/bin/env node
// @ts-check
/**
 * Machine preflight for multi-model code changes.
 * Adapter only — SSOT remains docs/NOE_MULTIMODEL_OPERATING_PROTOCOL.md + AGENTS.md.
 *
 * Usage:
 *   node scripts/code-integrity/multimodel-preflight.mjs [--json] [--repo <path>]
 * Exit 0 when minimum facts are present; exit 2 on missing required inputs when --strict.
 *
 * This script never prints secrets. It only inspects Git status + protocol file presence.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DEFAULT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  /** @type {{ json: boolean, strict: boolean, repo: string, allowedPaths: string[] }} */
  const out = { json: false, strict: false, repo: ROOT_DEFAULT, allowedPaths: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--strict') out.strict = true;
    else if (a === '--repo') out.repo = resolve(argv[++i] || '');
    else if (a === '--allowed-path') out.allowedPaths.push(String(argv[++i] || ''));
  }
  return out;
}

function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  return {
    ok: r.status === 0,
    status: r.status ?? 1,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
  };
}

function fileOk(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repo = opts.repo;
  const protocol = join(repo, 'docs', 'NOE_MULTIMODEL_OPERATING_PROTOCOL.md');
  const adapter = join(repo, 'scripts', 'code-integrity', 'MULTI_MODEL_CHANGE_PROTOCOL_ADAPTER.md');
  const agents = join(repo, 'AGENTS.md');
  const impactMap = join(repo, 'scripts', 'code-integrity', 'impact-map.json');

  const head = git(repo, ['rev-parse', 'HEAD']);
  const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const porcelain = git(repo, ['status', '--porcelain=v1', '-uall']);
  const dirtyLines = porcelain.stdout ? porcelain.stdout.split('\n').filter(Boolean) : [];

  const requiredFiles = [
    { id: 'protocol_ssot', path: protocol, present: fileOk(protocol) },
    { id: 'adapter_non_ssot', path: adapter, present: fileOk(adapter) },
    { id: 'agents', path: agents, present: fileOk(agents) },
    { id: 'impact_map', path: impactMap, present: fileOk(impactMap) },
  ];

  const missing = requiredFiles.filter((f) => !f.present).map((f) => f.id);
  const checklist = {
    schemaVersion: 1,
    kind: 'neo.code-integrity.multimodel-preflight.v1',
    generatedAt: new Date().toISOString(),
    repo,
    git: {
      headOk: head.ok,
      head: head.ok ? head.stdout : null,
      branchOk: branch.ok,
      branch: branch.ok ? branch.stdout : null,
      dirtyCount: dirtyLines.length,
    },
    requiredFiles,
    missingRequiredFiles: missing,
    /** Model must fill these before editing; machine only reports emptiness. */
    humanOrModelMustProvide: [
      'sliceOwnerIntegrator',
      'allowedPaths',
      'forbiddenOrActivePaths',
      'successInvariantTest',
      'failureInvariantTest',
      'riskLevel',
      'exactCommands',
      'rollbackBoundary',
    ],
    allowedPathsProvided: opts.allowedPaths,
    notes: [
      'Adapter is not SSOT; conflict → AGENTS.md / NOE_MULTIMODEL_OPERATING_PROTOCOL.md wins.',
      'Do not start cross-domain refactors without filling humanOrModelMustProvide facts.',
      'code-integrity tools constrain delivery evidence; they do not replace product SSOT modules.',
    ],
  };

  const ok = missing.length === 0 && head.ok && branch.ok;
  const payload = {
    ...checklist,
    ok,
    exitHint: ok
      ? 'preflight_machine_facts_present'
      : 'preflight_missing_required_files_or_git',
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    console.log(`multimodel-preflight: ${ok ? 'OK' : 'INCOMPLETE'}`);
    console.log(`  HEAD=${payload.git.head || 'n/a'} branch=${payload.git.branch || 'n/a'} dirty=${payload.git.dirtyCount}`);
    console.log(`  required files missing: ${missing.length ? missing.join(',') : '(none)'}`);
    console.log('  model must still fill: slice owner, allowedPaths, invariants, risk, commands, rollback');
  }

  if (!ok && opts.strict) process.exit(2);
  process.exit(ok ? 0 : 1);
}

main();
