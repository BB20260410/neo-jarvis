#!/usr/bin/env node
// @ts-check
// Build a protected GET route/auth-surface matrix for the runtime-proof backlog.
//
// Default mode is static-only. With --probe-live, it performs unauthenticated GETs
// to local protected GET routes and stores only status codes/classifications.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKLOG_PATH = process.env.NOE_RUNTIME_PROOF_BACKLOG_PATH || join(ROOT, 'output', 'noe-audit', 'runtime-proof-backlog-2026-06-15.json');
const INVENTORY_PATH = process.env.NOE_CODEBASE_INVENTORY_PATH || join(ROOT, 'output', 'noe-codebase-inventory', 'latest.json');
const OUT_DIR = process.env.NOE_AUTH_SURFACE_MATRIX_OUT_DIR || join(ROOT, 'output', 'noe-audit');
const OUT_BASE = process.env.NOE_AUTH_SURFACE_MATRIX_BASENAME || 'runtime-proof-auth-surface-matrix-2026-06-15';
const DEFAULT_BASE_URL = process.env.NOE_PANEL_URL || 'http://127.0.0.1:51835';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function uniq(values = []) {
  return [...new Set(values.filter(Boolean).map((value) => String(value)))].sort();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function rel(path, root = ROOT) {
  return relative(root, path).replaceAll('\\', '/');
}

function walkJsFiles(target, root = ROOT, out = []) {
  if (!existsSync(target)) return out;
  const st = statSync(target);
  if (st.isFile()) {
    if (target.endsWith('.js')) out.push(rel(target, root));
    return out;
  }
  if (!st.isDirectory()) return out;
  for (const name of readdirSync(target)) {
    if (name === 'node_modules' || name === '.git' || name === 'output') continue;
    walkJsFiles(join(target, name), root, out);
  }
  return out;
}

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const out = {
    probeLive: false,
    baseUrl: env.NOE_PANEL_URL || DEFAULT_BASE_URL,
    timeoutMs: Number(env.NOE_AUTH_SURFACE_TIMEOUT_MS || 1500),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--probe-live') out.probeLive = true;
    else if (arg === '--base-url') out.baseUrl = argv[++i] || out.baseUrl;
    else if (arg.startsWith('--base-url=')) out.baseUrl = arg.slice('--base-url='.length);
    else if (arg === '--timeout-ms') out.timeoutMs = Number(argv[++i]) || out.timeoutMs;
    else if (arg.startsWith('--timeout-ms=')) out.timeoutMs = Number(arg.slice('--timeout-ms='.length)) || out.timeoutMs;
  }
  out.baseUrl = String(out.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  out.timeoutMs = Number.isFinite(out.timeoutMs) && out.timeoutMs > 0 ? out.timeoutMs : 1500;
  return out;
}

function localBaseUrl(rawUrl = DEFAULT_BASE_URL) {
  const url = new URL(rawUrl);
  if (!LOCAL_HOSTS.has(url.hostname)) throw new Error(`refusing non-local probe host: ${url.hostname}`);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`refusing unsupported probe protocol: ${url.protocol}`);
  return url;
}

function joinUrl(base, path) {
  const url = new URL(base.href);
  url.pathname = path;
  url.search = '';
  return url;
}

function statusKind(status) {
  if (status === null || status === undefined) return 'not_probed';
  if (status === 0) return 'request_failed';
  if (status === 401 || status === 403) return 'route_live_auth_protected';
  if (status === 404) return 'route_not_registered_or_wrong_path';
  if (status === 405) return 'route_live_method_not_allowed';
  if (status >= 200 && status < 300) return 'route_live_without_owner_token';
  if (status >= 500) return 'route_reached_server_error';
  return 'route_reached_unexpected_status';
}

function extractProtectedGetRoutes(text = '') {
  const routes = [];
  const re = /\b(?:app|router)\.get\(\s*['"`]([^'"`]+)['"`]\s*,\s*requireOwnerToken\b/g;
  for (const match of String(text || '').matchAll(re)) {
    const path = String(match[1] || '').trim();
    if (!path || path.includes(':') || path.includes('*')) continue;
    routes.push(path);
  }
  return uniq(routes);
}

function buildRouteMap({ root = ROOT, routeFiles = null } = {}) {
  const files = routeFiles || walkJsFiles(join(root, 'src', 'server', 'routes'), root).sort();
  const map = new Map();
  for (const file of files) {
    let text = '';
    try { text = readFileSync(join(root, file), 'utf8'); } catch { text = ''; }
    const protectedGetRoutes = extractProtectedGetRoutes(text);
    if (!protectedGetRoutes.length) continue;
    map.set(file, protectedGetRoutes);
  }
  return map;
}

function indexByFile(items = []) {
  return new Map(arr(items).map((item) => [String(item.file || ''), item]));
}

function routeImportersFor(item = {}) {
  return arr(item.sourceImporters).filter((file) => String(file).startsWith('src/server/routes/'));
}

function classifySurface({ routeImporters = [], candidatePaths = [] } = {}) {
  if (candidatePaths.length) return 'protected_get_surface_candidate';
  if (routeImporters.length) return 'route_importer_without_safe_get_candidate';
  return 'no_route_importer';
}

async function probePath(base, path, { fetchFn = globalThis.fetch, timeoutMs = 1500 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(250, timeoutMs));
  try {
    const response = await fetchFn(joinUrl(base, path), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    return { path, status: Number(response?.status) || 0, statusKind: statusKind(Number(response?.status) || 0), error: '' };
  } catch (e) {
    return { path, status: 0, statusKind: 'request_failed', error: String(e?.name || e?.message || e || 'request_failed').slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
}

async function probePaths(paths = [], { baseUrl = DEFAULT_BASE_URL, fetchFn = globalThis.fetch, timeoutMs = 1500 } = {}) {
  const base = localBaseUrl(baseUrl);
  const out = [];
  for (const path of paths) {
    out.push(await probePath(base, path, { fetchFn, timeoutMs }));
  }
  return out;
}

function countBy(items = [], pick) {
  const counts = {};
  for (const item of items) {
    const key = typeof pick === 'function' ? pick(item) : item[pick];
    const value = String(key || 'unknown');
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

async function buildAuthSurfaceMatrix({
  root = ROOT,
  backlogPath = BACKLOG_PATH,
  inventoryPath = INVENTORY_PATH,
  probeLive = false,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = 1500,
  fetchFn = globalThis.fetch,
  routeFiles = null,
} = {}) {
  const backlog = readJson(backlogPath);
  const inventory = readJson(inventoryPath);
  const inventoryByFile = indexByFile(inventory.files);
  const routeMap = buildRouteMap({ root, routeFiles });
  const backlogFiles = arr(backlog.files);
  const files = backlogFiles.map((backlogFile) => {
    const inventoryItem = inventoryByFile.get(backlogFile.file) || {};
    const routeImporters = routeImportersFor(inventoryItem);
    const candidatePaths = uniq(routeImporters.flatMap((file) => routeMap.get(file) || []));
    return {
      file: backlogFile.file,
      priority: backlogFile.priority,
      module: backlogFile.module,
      usefulness: backlogFile.usefulness,
      recommendedProofStrategy: backlogFile.recommendedProofStrategy,
      routeImporters,
      protectedGetCandidatePaths: candidatePaths,
      surface: classifySurface({ routeImporters, candidatePaths }),
      directTests: arr(inventoryItem.tests).length,
      testImporters: arr(inventoryItem.testImporters).length,
    };
  }).sort((a, b) => {
    const prio = ['P0', 'P1', 'P2', 'P3'];
    return prio.indexOf(a.priority) - prio.indexOf(b.priority) || a.file.localeCompare(b.file);
  });

  const uniquePaths = uniq(files.flatMap((file) => file.protectedGetCandidatePaths));
  const liveProbes = probeLive
    ? await probePaths(uniquePaths, { baseUrl, fetchFn, timeoutMs })
    : [];
  const probeByPath = new Map(liveProbes.map((probe) => [probe.path, probe]));
  for (const file of files) {
    file.liveProtectedGetProbes = file.protectedGetCandidatePaths.map((path) => probeByPath.get(path) || {
      path,
      status: null,
      statusKind: 'not_probed',
      error: '',
    });
  }
  const filesWith401 = files.filter((file) => file.liveProtectedGetProbes.some((probe) => probe.statusKind === 'route_live_auth_protected'));
  const byPriority = [];
  for (const priority of ['P0', 'P1', 'P2', 'P3']) {
    const list = files.filter((file) => file.priority === priority);
    byPriority.push({
      priority,
      files: list.length,
      routeImporterFiles: list.filter((file) => file.routeImporters.length).length,
      protectedGetCandidateFiles: list.filter((file) => file.protectedGetCandidatePaths.length).length,
      liveAuthSurfaceFiles: list.filter((file) => file.liveProtectedGetProbes.some((probe) => probe.statusKind === 'route_live_auth_protected')).length,
      surfaceCounts: countBy(list, 'surface'),
    });
  }
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    root: backlog.root || inventory.root || root,
    mode: probeLive ? 'unauthorized_live_get_probe' : 'static_matrix_only',
    baseUrl: probeLive ? `${localBaseUrl(baseUrl).protocol}//${localBaseUrl(baseUrl).host}` : '',
    inputs: {
      backlogPath,
      backlogGeneratedAt: backlog.generatedAt || '',
      inventoryPath,
      inventoryGeneratedAt: inventory.generatedAt || '',
    },
    policy: {
      defaultStaticOnly: true,
      probeLiveRequiresFlag: true,
      localHostOnlyWhenProbing: true,
      protectedGetOnly: true,
      noOwnerTokenSent: true,
      noPostRequests: true,
      noResponseBodiesStored: true,
      noDbWrites: true,
      noModelCalls: true,
      noExternalNetworkCalls: true,
      noSecretValuesReturned: true,
    },
    summary: {
      backlogFiles: files.length,
      routeImporterFiles: files.filter((file) => file.routeImporters.length).length,
      protectedGetCandidateFiles: files.filter((file) => file.protectedGetCandidatePaths.length).length,
      uniqueProtectedGetPaths: uniquePaths.length,
      liveProbeExecuted: probeLive,
      liveProbedPaths: liveProbes.length,
      liveAuthSurfaceFiles: filesWith401.length,
      liveAuthSurfacePaths: liveProbes.filter((probe) => probe.statusKind === 'route_live_auth_protected').length,
      surfaceCounts: countBy(files, 'surface'),
      liveStatusKinds: countBy(liveProbes, 'statusKind'),
    },
    byPriority,
    liveProbes,
    files,
  };
}

function mdTable(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function renderMarkdown(report, jsonPath) {
  const priorityRows = report.byPriority.map((entry) => [
    entry.priority,
    String(entry.files),
    String(entry.routeImporterFiles),
    String(entry.protectedGetCandidateFiles),
    String(entry.liveAuthSurfaceFiles),
    Object.entries(entry.surfaceCounts).map(([key, count]) => `${key}:${count}`).join('<br>') || '-',
  ]);
  const fileRows = report.files
    .filter((file) => file.routeImporters.length || file.protectedGetCandidatePaths.length)
    .slice(0, 140)
    .map((file) => [
      file.priority,
      `\`${file.file}\``,
      file.surface,
      file.routeImporters.map((entry) => `\`${entry}\``).join('<br>') || '-',
      file.protectedGetCandidatePaths.map((path) => `\`${path}\``).join('<br>') || '-',
      file.liveProtectedGetProbes.map((probe) => `${probe.path}:${probe.status ?? '-'}:${probe.statusKind}`).join('<br>') || '-',
    ]);
  return [
    '# Neo Runtime Proof Auth Surface Matrix',
    '',
    `Generated: ${report.generatedAt}`,
    `Mode: ${report.mode}`,
    report.baseUrl ? `Base URL: \`${report.baseUrl}\`` : '',
    '',
    '## Summary',
    '',
    `- backlog files: ${report.summary.backlogFiles}`,
    `- route importer files: ${report.summary.routeImporterFiles}`,
    `- protected GET candidate files: ${report.summary.protectedGetCandidateFiles}`,
    `- unique protected GET paths: ${report.summary.uniqueProtectedGetPaths}`,
    `- live probe executed: ${report.summary.liveProbeExecuted}`,
    `- live auth surface files: ${report.summary.liveAuthSurfaceFiles}`,
    `- live auth surface paths: ${report.summary.liveAuthSurfacePaths}`,
    '',
    '## By Priority',
    '',
    mdTable([
      ['priority', 'files', 'route importer files', 'protected GET files', 'live auth surface files', 'surface counts'],
      ['---', '---:', '---:', '---:', '---:', '---'],
      ...priorityRows,
    ]),
    '',
    '## Files With Route Surfaces',
    '',
    mdTable([
      ['priority', 'file', 'surface', 'route importers', 'protected GET candidates', 'live probes'],
      ['---', '---', '---', '---', '---', '---'],
      ...fileRows,
    ]),
    '',
    '## Interpretation',
    '',
    '- A protected GET candidate means the backlog file is imported by a route file that has at least one static `GET` route protected by `requireOwnerToken` and no dynamic path parameters. This is a route-file surface candidate, not proof that the specific imported dependency ran.',
    '- In `--probe-live` mode, `401/403` proves the running local server has the protected route/auth surface registered. It still does not prove owner-authorized business behavior.',
    '',
    '## JSON',
    '',
    `Full matrix is in \`${jsonPath.replace(`${ROOT}/`, '')}\`. It stores file paths, route paths, status codes, and classifications only.`,
  ].filter(Boolean).join('\n');
}

function writeReport(report) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${OUT_BASE}.json`);
  const mdPath = join(OUT_DIR, `${OUT_BASE}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mdPath, `${renderMarkdown(report, jsonPath)}\n`, { mode: 0o600 });
  return { jsonPath, mdPath };
}

export {
  buildAuthSurfaceMatrix,
  buildRouteMap,
  extractProtectedGetRoutes,
  parseArgs,
  statusKind,
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs();
  const report = await buildAuthSurfaceMatrix(args);
  const paths = writeReport(report);
  console.log(JSON.stringify({
    ok: true,
    generatedAt: report.generatedAt,
    mode: report.mode,
    routeImporterFiles: report.summary.routeImporterFiles,
    protectedGetCandidateFiles: report.summary.protectedGetCandidateFiles,
    uniqueProtectedGetPaths: report.summary.uniqueProtectedGetPaths,
    liveAuthSurfaceFiles: report.summary.liveAuthSurfaceFiles,
    paths,
  }, null, 2));
}
