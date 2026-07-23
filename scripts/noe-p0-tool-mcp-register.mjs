#!/usr/bin/env node
// @ts-check
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpStore } from '../src/mcp/McpStore.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'output/noe-p0-tool-install-2026-06-14');
const SEMGREP_BIN = resolve(OUT_DIR, '.venv-semgrep/bin/semgrep');
const ENV_BIN = '/usr/bin/env';

function assertExists(path, label) {
  if (!existsSync(path)) throw new Error(`${label}_missing:${path}`);
  return path;
}

function upsert(store, cfg) {
  const existing = store.get(cfg.name);
  if (existing) return { action: 'updated', server: store.update(cfg.name, cfg) };
  return { action: 'created', server: store.create(cfg) };
}

mkdirSync(OUT_DIR, { recursive: true });

const store = new McpStore();
const configs = [
  {
    name: 'chrome-devtools-local-safe',
    type: 'stdio',
    command: ENV_BIN,
    args: [
      process.execPath,
      assertExists(resolve(ROOT, 'scripts/noe-chrome-devtools-mcp-safe-server.mjs'), 'chrome_devtools_safe_proxy'),
    ],
    env: { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' },
    enabled: true,
  },
  {
    name: 'context7-docs',
    type: 'stdio',
    command: ENV_BIN,
    args: [
      process.execPath,
      assertExists(resolve(ROOT, 'node_modules/@upstash/context7-mcp/dist/index.js'), 'context7_mcp_bin'),
    ],
    env: {},
    enabled: true,
  },
  {
    name: 'semgrep-local-security',
    type: 'stdio',
    command: ENV_BIN,
    args: [assertExists(SEMGREP_BIN, 'semgrep_bin'), 'mcp', '--transport', 'stdio'],
    env: {
      SEMGREP_SEND_METRICS: 'off',
      SEMGREP_ENABLE_VERSION_CHECK: '0',
    },
    enabled: true,
  },
];

const registered = configs.map((cfg) => {
  const result = upsert(store, cfg);
  return {
    name: result.server.name,
    action: result.action,
    type: result.server.type,
    enabled: result.server.enabled,
    command: result.server.command,
    args: result.server.args,
    envKeys: Object.keys(result.server.env || {}),
  };
});

console.log(JSON.stringify({ ok: true, registered }, null, 2));
