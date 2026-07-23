#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = homedir();
const OBSIDIAN_DIR = join(HOME, 'Library', 'Application Support', 'obsidian');
const OBSIDIAN_JSON = join(OBSIDIAN_DIR, 'obsidian.json');
const NOE_MCP_JSON = join(HOME, '.noe-panel', 'mcp-servers.json');
const LOCAL_REST_PLUGIN_ID = 'obsidian-local-rest-api';

function readJson(file) {
  try {
    return { ok: true, data: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function tcpOpen(port, host = '127.0.0.1', timeoutMs = 900) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (open, error = '') => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ open, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'timeout'));
    socket.once('error', (e) => finish(false, e?.code || e?.message || 'error'));
    socket.connect(port, host);
  });
}

async function probeHttp(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return { reachable: true, status: res.status };
  } catch (e) {
    return { reachable: false, error: String(e?.message || e).slice(0, 160) };
  }
}

export function discoverVaults({ obsidianJson = OBSIDIAN_JSON, pluginId = LOCAL_REST_PLUGIN_ID } = {}) {
  const obs = existsSync(obsidianJson) ? readJson(obsidianJson) : { ok: false, error: 'obsidian.json not found' };
  const vaultMap = obs.ok && obs.data?.vaults && typeof obs.data.vaults === 'object' ? obs.data.vaults : {};
  return Object.entries(vaultMap).map(([id, v]) => {
    const vaultPath = String(v?.path || '');
    const exists = vaultPath ? existsSync(vaultPath) : false;
    const obsidianConfig = exists ? join(vaultPath, '.obsidian') : '';
    const pluginDir = exists ? join(obsidianConfig, 'plugins', pluginId) : '';
    const pluginManifest = pluginDir ? join(pluginDir, 'manifest.json') : '';
    const pluginData = pluginDir ? join(pluginDir, 'data.json') : '';
    return {
      id,
      path: vaultPath,
      open: v?.open === true,
      exists,
      hasObsidianDir: obsidianConfig ? existsSync(obsidianConfig) : false,
      localRestPlugin: {
        installed: pluginManifest ? existsSync(pluginManifest) : false,
        dataFilePresent: pluginData ? existsSync(pluginData) : false,
      },
    };
  });
}

export function safeMcpServers({ mcpJson = NOE_MCP_JSON } = {}) {
  if (!existsSync(mcpJson)) return { exists: false, servers: [] };
  const parsed = readJson(mcpJson);
  if (!parsed.ok) return { exists: true, error: parsed.error, servers: [] };
  const servers = Array.isArray(parsed.data?.servers) ? parsed.data.servers : [];
  return {
    exists: true,
    servers: servers.map((s) => ({
      name: String(s?.name || ''),
      type: String(s?.type || ''),
      enabled: s?.enabled !== false,
      url: typeof s?.url === 'string' ? redactUrl(s.url) : '',
      command: typeof s?.command === 'string' ? s.command : '',
      argsContainObsidian: Array.isArray(s?.args) && s.args.some((a) => /obsidian/i.test(String(a))),
      envKeys: s?.env && typeof s.env === 'object' ? Object.keys(s.env) : [],
      headerKeys: s?.headers && typeof s.headers === 'object' ? Object.keys(s.headers) : [],
    })),
  };
}

export function redactUrl(value) {
  const raw = String(value || '');
  if (!raw) return '';
  try {
    const url = new URL(raw);
    for (const [k, v] of url.searchParams.entries()) {
      if (/key|token|secret|auth|password/i.test(k) || String(v).length > 16) url.searchParams.set(k, '[redacted]');
    }
    return url.toString();
  } catch {
    return raw.replace(/([?&][^=]*(?:key|token|secret|auth|password)[^=]*=)[^&\s]+/gi, '$1[redacted]');
  }
}

export function isObsidianServer(s) {
  const hay = [s.name, s.type, s.url, s.command, s.argsContainObsidian ? 'obsidian' : '', ...s.envKeys, ...s.headerKeys].join(' ');
  return /obsidian|local[-_ ]?rest/i.test(hay);
}

export function buildNextActions({ vaults, listeners, mcp, envApiKeyPresent }) {
  const actions = [];
  if (vaults.length === 0) {
    actions.push('Open or create a real Obsidian vault first.');
  } else if (!vaults.some((v) => v.exists && v.hasObsidianDir)) {
    actions.push('The remembered Obsidian vault path is missing; open a valid vault.');
  }

  if (!vaults.some((v) => v.localRestPlugin.installed)) {
    actions.push('Install and enable the Obsidian Local REST API community plugin in that vault.');
  }

  if (!listeners.http27123.open && !listeners.https27124.open) {
    actions.push('Start Obsidian and enable Local REST API. For Noe, the lowest-friction endpoint is http://127.0.0.1:27123/mcp/ with the plugin HTTP server enabled.');
  }

  const registered = mcp.servers.some(isObsidianServer);
  if (!registered) {
    actions.push('Register a disabled-by-default or user-approved Noe MCP server named obsidian-local-rest with type=http, url=http://127.0.0.1:27123/mcp/, and Authorization: Bearer <api-key>.');
  }

  if (!envApiKeyPresent && !mcp.servers.some((s) => s.headerKeys.some((k) => /authorization/i.test(k)) || s.envKeys.some((k) => /OBSIDIAN_API_KEY/i.test(k)))) {
    actions.push('Copy the Local REST API key from Obsidian settings into the MCP header/env at registration time. Do not write it into git or docs.');
  }

  return actions;
}

export async function createReadinessReport({
  obsidianJson = OBSIDIAN_JSON,
  mcpJson = NOE_MCP_JSON,
  listeners = null,
  endpointProbe = null,
  env = process.env,
  checkedAt = new Date().toISOString(),
} = {}) {
  const vaults = discoverVaults({ obsidianJson });
  const mcp = safeMcpServers({ mcpJson });
  const liveListeners = listeners || {
    http27123: await tcpOpen(27123),
    https27124: await tcpOpen(27124),
    thirdParty3010: await tcpOpen(3010),
  };
  const liveEndpointProbe = endpointProbe || (liveListeners.http27123.open
    ? await probeHttp('http://127.0.0.1:27123/')
    : { reachable: false, error: 'http listener not open' });
  const envApiKeyPresent = typeof env.OBSIDIAN_API_KEY === 'string' && env.OBSIDIAN_API_KEY.length > 0;
  const mcpCredentialPresent = mcp.servers.some((s) => (
    s.headerKeys.some((k) => /authorization/i.test(k))
    || s.envKeys.some((k) => /OBSIDIAN_API_KEY/i.test(k))
  ));

  const report = {
    ok: vaults.some((v) => v.exists && v.hasObsidianDir)
      && vaults.some((v) => v.localRestPlugin.installed)
      && (liveListeners.http27123.open || liveListeners.https27124.open)
      && mcp.servers.some(isObsidianServer)
      && (envApiKeyPresent || mcpCredentialPresent),
    mode: 'read_only',
    checkedAt,
    obsidian: {
      configPath: obsidianJson,
      configExists: existsSync(obsidianJson),
      vaults,
      listeners: liveListeners,
      endpointProbe: liveEndpointProbe,
      apiKey: {
        envPresent: envApiKeyPresent,
        mcpCredentialPresent,
        printed: false,
      },
    },
    noeMcp: {
      configPath: mcpJson,
      configExists: mcp.exists,
      registeredObsidianServers: mcp.servers.filter(isObsidianServer),
      serverCount: mcp.servers.length,
    },
    recommendedPath: {
      primary: 'Obsidian Local REST API built-in MCP at http://127.0.0.1:27123/mcp/ or https://127.0.0.1:27124/mcp/',
      fallback: '@cyanheads/obsidian-mcp-server only if the built-in MCP is unavailable or you need its folder-scoped read/write policy.',
      reason: 'Noe already supports Streamable HTTP MCP; built-in MCP avoids another long-running server and another npm package.',
    },
    nextActions: [],
  };
  report.nextActions = buildNextActions({ vaults, listeners: liveListeners, mcp, envApiKeyPresent });

  for (const v of report.obsidian.vaults) {
    if (v.exists) {
      try { v.pathMtime = statSync(v.path).mtime.toISOString(); } catch { /* read-only detail */ }
    }
  }

  return report;
}

async function main() {
  const report = await createReadinessReport();
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(JSON.stringify({ ok: false, mode: 'read_only', error: e?.message || String(e) }, null, 2));
    process.exit(1);
  });
}
