#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DEFAULT_GRANT_PATH,
  createMaxAutonomyGrant,
  evaluateStandingAutonomyGrant,
  grantPathFromEnv,
  summarizeGrantForReport,
  writeStandingAutonomyGrant,
} from './lib/noe-standing-autonomy-grant.mjs';

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    action: 'check',
    grantPath: grantPathFromEnv(process.env),
    scope: 'owner-token:read',
    ttlMs: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write-max') out.action = 'write-max';
    else if (arg === '--check') out.action = 'check';
    else if (arg === '--revoke') out.action = 'revoke';
    else if (arg === '--grant-path') out.grantPath = argv[++i] || out.grantPath;
    else if (arg.startsWith('--grant-path=')) out.grantPath = arg.slice('--grant-path='.length);
    else if (arg === '--scope') out.scope = argv[++i] || out.scope;
    else if (arg.startsWith('--scope=')) out.scope = arg.slice('--scope='.length);
    else if (arg === '--ttl-hours') out.ttlMs = Number(argv[++i]) * 60 * 60 * 1000;
    else if (arg.startsWith('--ttl-hours=')) out.ttlMs = Number(arg.slice('--ttl-hours='.length)) * 60 * 60 * 1000;
  }
  return out;
}

function readGrant(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function main() {
  const args = parseArgs();
  if (args.action === 'write-max') {
    const grant = createMaxAutonomyGrant({ ttlMs: args.ttlMs });
    const written = writeStandingAutonomyGrant({ grant, grantPath: args.grantPath || DEFAULT_GRANT_PATH });
    console.log(JSON.stringify({
      ok: true,
      action: 'write-max',
      grantPath: written.grantPath,
      grant: summarizeGrantForReport(written.grant),
      secretValuesReturned: false,
    }, null, 2));
    return;
  }

  if (args.action === 'revoke') {
    const grant = readGrant(args.grantPath) || createMaxAutonomyGrant();
    grant.enabled = false;
    grant.revokedAt = new Date().toISOString();
    mkdirSync(dirname(args.grantPath), { recursive: true });
    writeFileSync(args.grantPath, JSON.stringify(grant, null, 2) + '\n', { mode: 0o600 });
    try { chmodSync(args.grantPath, 0o600); } catch {}
    console.log(JSON.stringify({
      ok: true,
      action: 'revoke',
      grantPath: args.grantPath,
      grant: summarizeGrantForReport(grant),
      secretValuesReturned: false,
    }, null, 2));
    return;
  }

  const evaluation = evaluateStandingAutonomyGrant({
    scope: args.scope,
    grantPath: args.grantPath,
  });
  const grant = readGrant(args.grantPath);
  console.log(JSON.stringify({
    ok: evaluation.authorized,
    action: 'check',
    scope: args.scope,
    grantPath: args.grantPath,
    evaluation,
    grant: grant ? summarizeGrantForReport(grant) : null,
    secretValuesReturned: false,
  }, null, 2));
  process.exitCode = evaluation.authorized ? 0 : 2;
}

main();
