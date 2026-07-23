#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOwnerTokenAuthorization } from './lib/noe-standing-autonomy-grant.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'output', 'noe-full-current');
const REPORT = join(OUT_DIR, `full-current-${Date.now()}.json`);

function parseArgs(argv) {
  const out = {
    includeManaged: false,
    includeLive: false,
    includeCognitiveLive: false,
    skipLive: false,
    skipCognitive: false,
    explicitAckReadOwnerToken: process.env.NOE_ACK_READ_OWNER_TOKEN === '1',
  };
  for (const arg of argv) {
    if (arg === '--include-managed') out.includeManaged = true;
    else if (arg === '--include-live') out.includeLive = true;
    else if (arg === '--include-cognitive-live' || arg === '--include-cognitive') out.includeCognitiveLive = true;
    else if (arg === '--skip-live') out.skipLive = true;
    else if (arg === '--skip-cognitive') out.skipCognitive = true;
    else if (arg === '--ack-read-owner-token') out.explicitAckReadOwnerToken = true;
  }
  out.ownerTokenAuthorization = resolveOwnerTokenAuthorization({
    explicitAck: out.explicitAckReadOwnerToken,
    scope: 'live-verifier:run',
  });
  out.ackReadOwnerToken = out.ownerTokenAuthorization.authorized;
  return out;
}

function redact(text) {
  return String(text || '')
    .replace(/\?t=[0-9a-f]{32,}/gi, '?t=[redacted]')
    .replace(/(X-Panel-Owner-Token["':\s]+)[0-9a-f]{32,}/gi, '$1[redacted]')
    .replace(/(Authorization:\s*Bearer\s+)(?!<api-key>)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]');
}

function runCommand(id, command, args, { allowFailure = false, expectedBlock = false } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); stdout = stdout.slice(-20_000); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); stderr = stderr.slice(-20_000); });
    child.on('close', (code) => {
      const ok = code === 0 || allowFailure;
      resolveRun({
        id,
        command: [command, ...args].join(' '),
        ok,
        code,
        status: code === 0 ? 'passed' : expectedBlock ? 'external_blocked' : allowFailure ? 'allowed_failure' : 'failed',
        stdout: redact(stdout).slice(-8000),
        stderr: redact(stderr).slice(-4000),
      });
    });
    child.on('error', (e) => {
      resolveRun({
        id,
        command: [command, ...args].join(' '),
        ok: allowFailure,
        code: null,
        status: expectedBlock ? 'external_blocked' : allowFailure ? 'allowed_failure' : 'failed',
        error: e?.message || String(e),
      });
    });
  });
}

function policyBlockedResult(id, reason) {
  return {
    id,
    command: 'policy-gate',
    ok: true,
    code: null,
    status: 'policy_blocked',
    reason,
    stdout: '',
    stderr: '',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const steps = [
    ['p0_unit', 'npm', ['run', 'test:p0:unit']],
    ['voice_unit', 'npm', ['test', '--', 'tests/unit/noe-voice-session.test.js']],
    ['knowledge_unit', 'npm', ['test', '--', 'tests/unit/obsidian-mcp-readiness.test.js', 'tests/unit/noe-external-readiness.test.js', 'tests/unit/deep-researcher.test.js', 'tests/unit/llm-wiki.test.js', 'tests/unit/routes/knowledge-evidence-routes.test.js', 'tests/unit/routes/noe-do-routes.test.js']],
    ['handoff_consistency', 'npm', ['run', 'verify:handoff']],
    ['wiki_ingest_check', 'npm', ['run', 'wiki:ingest:check']],
    ['wiki_lint', 'npm', ['run', 'wiki:lint']],
    ['obsidian_mcp_readiness', 'npm', ['run', 'obsidian:mcp:check'], { allowFailure: true, expectedBlock: true }],
    ['obsidian_mcp_plan', 'npm', ['run', 'obsidian:mcp:plan']],
    ['external_readiness', 'npm', ['run', 'verify:noe:external-readiness'], { allowFailure: true, expectedBlock: true }],
  ];
  if (args.includeLive && !args.skipLive) {
    if (args.ackReadOwnerToken) steps.push(['phase5_live', 'npm', ['run', 'verify:noe:phase5', '--', '--ack-read-owner-token']]);
    else steps.push(['phase5_live', '__policy__', [args.ownerTokenAuthorization.reason]]);
  }
  if (args.includeCognitiveLive && !args.skipCognitive) {
    if (args.ackReadOwnerToken) steps.push(['cognitive_live', 'npm', ['run', 'verify:cognitive', '--', '--ack-read-owner-token']]);
    else steps.push(['cognitive_live', '__policy__', [args.ownerTokenAuthorization.reason]]);
  }
  if (args.includeManaged) {
    steps.push(['phase5_managed', 'npm', ['run', 'verify:noe:phase5', '--', '--managed']]);
    steps.push(['real_use_replay_managed', 'npm', ['run', 'verify:noe:real-use-replay', '--', '--managed']]);
  }

  const results = [];
  for (const [id, command, commandArgs, opts] of steps) {
    console.log(`RUN ${id}`);
    const result = command === '__policy__'
      ? policyBlockedResult(id, commandArgs[0])
      : await runCommand(id, command, commandArgs, opts || {});
    results.push(result);
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${id} (${result.status})`);
    if (!result.ok) break;
  }

  const failed = results.filter((r) => !r.ok).length;
  const blockers = results.filter((r) => r.status === 'external_blocked');
  const policyBlocked = results.filter((r) => r.status === 'policy_blocked');
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(REPORT, JSON.stringify({
    ok: failed === 0,
    passed: results.filter((r) => r.ok).length,
    failed,
    externalBlocked: blockers.map((r) => r.id),
    policyBlocked: policyBlocked.map((r) => ({ id: r.id, reason: r.reason })),
    args: {
      includeManaged: args.includeManaged,
      includeLive: args.includeLive,
      includeCognitiveLive: args.includeCognitiveLive,
      ackReadOwnerToken: Boolean(args.ackReadOwnerToken),
      ownerTokenAuthorization: args.ownerTokenAuthorization,
    },
    results,
    note: 'Default full-current verification does not read live owner-token or run live cognitive/browser checks. Live checks require explicit ack or a valid standing autonomy grant. Obsidian readiness is allowed to report external_blocked because it requires a real vault, Local REST API listener, API key, and MCP registration.',
  }, null, 2));

  console.log(`report=${REPORT}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(REPORT, JSON.stringify({ ok: false, error: e?.message || String(e) }, null, 2));
  console.error(e?.stack || e?.message || e);
  console.error(`report=${REPORT}`);
  process.exit(1);
});
