#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadinessReport } from './obsidian-mcp-readiness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'output', 'obsidian-mcp-plan');
const REPORT = join(OUT_DIR, `obsidian-mcp-plan-${Date.now()}.json`);

function parseArgs(argv) {
  const out = { endpoint: '', name: 'obsidian-local-rest', enabled: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--endpoint') out.endpoint = argv[++i] || '';
    else if (arg.startsWith('--endpoint=')) out.endpoint = arg.slice('--endpoint='.length);
    else if (arg === '--name') out.name = argv[++i] || out.name;
    else if (arg.startsWith('--name=')) out.name = arg.slice('--name='.length);
    else if (arg === '--enabled') out.enabled = true;
  }
  return out;
}

function chooseEndpoint(readiness, requested) {
  if (requested) return requested;
  if (readiness.obsidian?.listeners?.http27123?.open) return 'http://127.0.0.1:27123/mcp/';
  if (readiness.obsidian?.listeners?.https27124?.open) return 'https://127.0.0.1:27124/mcp/';
  return 'http://127.0.0.1:27123/mcp/';
}

function buildPlan({ readiness, endpoint, name, enabled }) {
  const config = {
    name,
    type: 'http',
    url: endpoint,
    headers: {
      Authorization: 'Bearer <api-key>',
    },
    enabled,
  };
  return {
    ok: true,
    mode: 'dry_run',
    writesConfig: false,
    recommended: 'Use the Obsidian Local REST API plugin built-in MCP first. It avoids another long-running server.',
    readiness: {
      ok: readiness.ok,
      externalBlocked: readiness.ok !== true,
      nextActions: readiness.nextActions || [],
    },
    primaryConfig: config,
    noShellCommandNeeded: true,
    fallbackOnly: {
      reason: 'Use only if the built-in MCP is unavailable or folder-scoped read/write policy is required.',
      config: {
        name: 'obsidian-mcp-server',
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@cyanheads/obsidian-mcp-server'],
        env: {
          OBSIDIAN_API_KEY: '<api-key>',
          OBSIDIAN_BASE_URL: endpoint.startsWith('https:')
            ? 'https://127.0.0.1:27124'
            : 'http://127.0.0.1:27123',
          OBSIDIAN_READ_ONLY: 'true',
          OBSIDIAN_ENABLE_COMMANDS: 'false',
        },
        enabled: false,
      },
    },
    applyNotes: [
      'Do not paste the real API key into docs or git.',
      'Prefer enabled:false first; enable only after Noe can connect and list tools.',
      'Start with read/search/append/patch only; keep delete and command execution disabled.',
      'Run npm run obsidian:mcp:check after Obsidian is open and the Local REST API key is available.',
    ],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const readiness = await createReadinessReport();
  const endpoint = chooseEndpoint(readiness, args.endpoint);
  const plan = buildPlan({ readiness, endpoint, name: args.name, enabled: args.enabled });
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(REPORT, JSON.stringify(plan, null, 2));
  console.log(JSON.stringify(plan, null, 2));
  console.log(`report=${REPORT}`);
}

main().catch((e) => {
  mkdirSync(OUT_DIR, { recursive: true });
  const out = { ok: false, mode: 'dry_run', writesConfig: false, error: e?.message || String(e) };
  writeFileSync(REPORT, JSON.stringify(out, null, 2));
  console.error(JSON.stringify(out, null, 2));
  console.error(`report=${REPORT}`);
  process.exit(1);
});
