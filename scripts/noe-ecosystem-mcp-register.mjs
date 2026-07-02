#!/usr/bin/env node
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpStore } from '../src/mcp/McpStore.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'output/noe-ecosystem-install-2026-06-12');
const SERENA_BIN = resolve(OUT_DIR, '.venv-serena/bin/serena');

function upsert(store, cfg) {
  const existing = store.get(cfg.name);
  if (existing) return { action: 'updated', server: store.update(cfg.name, cfg) };
  return { action: 'created', server: store.create(cfg) };
}

function assertExists(path, label) {
  if (!existsSync(path)) throw new Error(`${label}_missing:${path}`);
  return path;
}

mkdirSync(OUT_DIR, { recursive: true });

const store = new McpStore();
const configs = [
  {
    name: 'serena-noe-repo',
    type: 'stdio',
    command: '/usr/bin/env',
    args: [
      assertExists(SERENA_BIN, 'serena_bin'),
      'start-mcp-server',
      '--project', ROOT,
      '--transport', 'stdio',
      '--context', 'desktop-app',
      '--enable-web-dashboard', 'False',
      '--open-web-dashboard', 'False',
      '--enable-gui-log-window', 'False',
      '--log-level', 'ERROR',
    ],
    env: { SERENA_NO_OPEN_BROWSER: '1' },
    enabled: true,
  },
  {
    name: 'playwright-local-safe',
    type: 'stdio',
    command: process.execPath,
    args: [
      resolve(ROOT, 'scripts/noe-playwright-mcp-safe-server.mjs'),
    ],
    env: {},
    enabled: true,
  },
  {
    name: 'github-readonly',
    type: 'stdio',
    command: process.execPath,
    args: [resolve(ROOT, 'scripts/noe-github-mcp-readonly-server.mjs')],
    env: {},
    enabled: true,
  },
];

const results = configs.map((cfg) => {
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

console.log(JSON.stringify({ ok: true, registered: results }, null, 2));
