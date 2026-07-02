#!/usr/bin/env node
// @ts-check
// Probe P0 route/auth surfaces on the live local panel without owner credentials.
// Read-only: GET requests only, local host only, no owner token, no response bodies, no model calls, no POSTs.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_URL = process.env.NOE_P0_PROBE_BASE_URL || 'http://127.0.0.1:51835';
const OUT_DIR = process.env.NOE_P0_LIVE_AUTH_SURFACE_OUT_DIR || join(ROOT, 'output', 'noe-audit');
const OUT_BASE = process.env.NOE_P0_LIVE_AUTH_SURFACE_BASENAME || 'p0-live-auth-surface-probe-2026-06-15';
const DEFAULT_TIMEOUT_MS = Number(process.env.NOE_P0_PROBE_TIMEOUT_MS || 1500);

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const PROBES = [
  {
    id: 'health',
    method: 'GET',
    path: '/health',
    p0Files: [],
    purpose: 'confirm_live_panel_process',
    publicOk: true,
  },
  {
    id: 'agent_runs_auth_surface',
    method: 'GET',
    path: '/api/agent-runs?limit=1',
    p0Files: ['src/agents/AgentRunStore.js', 'src/agents/AgentRunVerificationExecutor.js'],
    purpose: 'agent_run_store_and_verification_route_registered_without_executing_mutations',
  },
  {
    id: 'activity_auth_surface',
    method: 'GET',
    path: '/api/activity?limit=1',
    p0Files: ['src/audit/ActivityLog.js'],
    purpose: 'activity_log_route_registered_without_append',
  },
  {
    id: 'agent_registry_auth_surface',
    method: 'GET',
    path: '/api/agent-registry',
    p0Files: ['src/agents/AgentSkillRegistry.js'],
    purpose: 'agent_registry_route_registered_without_classification_post',
  },
  {
    id: 'noe_commands_auth_surface',
    method: 'GET',
    path: '/api/noe/commands/discover?limit=1',
    p0Files: ['src/capabilities/NoeCommandSurface.js'],
    purpose: 'command_surface_discovery_route_registered_without_action_execution',
  },
  {
    id: 'research_status_auth_surface',
    method: 'GET',
    path: '/api/noe/research/status',
    p0Files: ['src/research/WebSearch.js'],
    purpose: 'web_search_status_route_registered_without_search_or_fetch',
  },
  {
    id: 'policy_file_guard_no_route_probe',
    method: 'NONE',
    path: '',
    skipFetch: true,
    p0Files: ['src/security/NoePolicyFileGuard.js'],
    purpose: 'no_public_read_route_static_runtime_spine_only',
  },
];

function localBaseUrl(rawUrl = BASE_URL) {
  const url = new URL(rawUrl);
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`refusing non-local probe host: ${url.hostname}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`refusing unsupported probe protocol: ${url.protocol}`);
  }
  return url;
}

function statusKind(status, { publicOk = false } = {}) {
  if (status === 0) return 'request_failed';
  if (publicOk && status >= 200 && status < 300) return 'public_route_live';
  if (status === 401 || status === 403) return 'route_live_auth_protected';
  if (status === 404) return 'route_not_registered_or_wrong_path';
  if (status === 405) return 'route_live_method_not_allowed';
  if (status >= 200 && status < 300) return 'route_live_without_owner_token';
  if (status >= 500) return 'route_reached_server_error';
  return 'route_reached_unexpected_status';
}

function joinPath(base, path) {
  const url = new URL(base.href);
  url.pathname = path.split('?')[0];
  url.search = path.includes('?') ? `?${path.split('?').slice(1).join('?')}` : '';
  return url;
}

async function fetchStatus(url, { fetchFn = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof fetchFn !== 'function') throw new Error('fetch unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(250, timeoutMs));
  try {
    const response = await fetchFn(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    return { status: Number(response?.status) || 0, error: '' };
  } catch (e) {
    return { status: 0, error: String(e?.name || e?.message || e || 'request_failed').slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
}

async function runProbe({ baseUrl = BASE_URL, fetchFn = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const base = localBaseUrl(baseUrl);
  const probes = [];
  for (const probe of PROBES) {
    if (probe.skipFetch) {
      probes.push({
        id: probe.id,
        method: probe.method,
        path: probe.path,
        p0Files: probe.p0Files,
        purpose: probe.purpose,
        status: null,
        statusKind: 'not_probeable_by_unauthorized_get',
        error: '',
      });
      continue;
    }
    const url = joinPath(base, probe.path);
    const result = await fetchStatus(url, { fetchFn, timeoutMs });
    probes.push({
      id: probe.id,
      method: probe.method,
      path: probe.path,
      p0Files: probe.p0Files,
      purpose: probe.purpose,
      status: result.status,
      statusKind: statusKind(result.status, { publicOk: probe.publicOk }),
      error: result.error,
    });
  }
  const reachableKinds = new Set(['public_route_live', 'route_live_auth_protected', 'route_live_method_not_allowed', 'route_live_without_owner_token', 'route_reached_server_error', 'route_reached_unexpected_status']);
  const filesByProbe = new Map();
  for (const probe of probes) {
    if (!reachableKinds.has(probe.statusKind)) continue;
    for (const file of probe.p0Files) filesByProbe.set(file, probe.id);
  }
  const p0Files = [...new Set(PROBES.flatMap((probe) => probe.p0Files))].sort();
  const routeSurfaceFiles = [...filesByProbe.keys()].sort();
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    root: ROOT,
    baseUrl: `${base.protocol}//${base.host}`,
    policy: {
      readOnlyGetOnly: true,
      localHostOnly: true,
      noOwnerTokenSent: true,
      noPostRequests: true,
      noResponseBodiesStored: true,
      noDbWrites: true,
      noModelCalls: true,
      noExternalNetworkCalls: true,
      noSecretValuesReturned: true,
    },
    summary: {
      probes: probes.length,
      fetchedProbes: probes.filter((probe) => probe.status !== null).length,
      p0Files: p0Files.length,
      p0FilesWithRouteSurfaceObserved: routeSurfaceFiles.length,
      p0FilesNotProbeableByUnauthorizedGet: p0Files.filter((file) => !routeSurfaceFiles.includes(file)),
      statusKinds: probes.reduce((counts, probe) => {
        counts[probe.statusKind] = (counts[probe.statusKind] || 0) + 1;
        return counts;
      }, {}),
    },
    probes,
  };
}

function mdTable(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function renderMarkdown(report, jsonPath) {
  const rows = report.probes.map((probe) => [
    probe.id,
    probe.method,
    probe.path ? `\`${probe.path}\`` : '-',
    probe.status === null ? '-' : String(probe.status),
    probe.statusKind,
    probe.p0Files.map((file) => `\`${file}\``).join('<br>') || '-',
  ]);
  return [
    '# Neo P0 Live Auth Surface Probe',
    '',
    `Generated: ${report.generatedAt}`,
    `Base URL: \`${report.baseUrl}\``,
    '',
    '## Summary',
    '',
    `- probes: ${report.summary.probes}; fetched: ${report.summary.fetchedProbes}`,
    `- P0 files with route/auth surface observed: ${report.summary.p0FilesWithRouteSurfaceObserved}/${report.summary.p0Files}`,
    `- P0 files not probeable by unauthorized GET: ${report.summary.p0FilesNotProbeableByUnauthorizedGet.map((file) => `\`${file}\``).join(', ') || 'none'}`,
    '',
    '## Probes',
    '',
    mdTable([
      ['id', 'method', 'path', 'status', 'status kind', 'P0 files'],
      ['---', '---', '---', '---:', '---', '---'],
      ...rows,
    ]),
    '',
    '## Interpretation',
    '',
    '- `route_live_auth_protected` proves the running local server has a matching route/auth surface. It does not prove the protected business method returned data or executed with owner credentials.',
    '- This probe intentionally sends no owner token and stores no response body. It cannot prove `NoePolicyFileGuard`, because that file is on the runtime safety spine rather than a public read route.',
    '',
    '## JSON',
    '',
    `Full probe output is in \`${jsonPath.replace(`${ROOT}/`, '')}\`. It stores status codes, classifications, and paths only.`,
  ].join('\n');
}

function writeProbe(report) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${OUT_BASE}.json`);
  const mdPath = join(OUT_DIR, `${OUT_BASE}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mdPath, `${renderMarkdown(report, jsonPath)}\n`, { mode: 0o600 });
  return { jsonPath, mdPath };
}

export { localBaseUrl, runProbe, statusKind };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runProbe();
  const paths = writeProbe(report);
  console.log(JSON.stringify({
    ok: true,
    generatedAt: report.generatedAt,
    p0FilesWithRouteSurfaceObserved: report.summary.p0FilesWithRouteSurfaceObserved,
    statusKinds: report.summary.statusKinds,
    paths,
  }, null, 2));
}
