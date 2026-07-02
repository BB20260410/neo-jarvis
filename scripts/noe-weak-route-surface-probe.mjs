#!/usr/bin/env node
// @ts-check
// Build/probe route auth surfaces for weak route-imported runtime candidates.
//
// Default mode is static-only. With --probe-live, it performs unauthenticated
// GETs to local protected GET routes and stores only status codes/classifications.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { statusKind } from './noe-runtime-proof-auth-surface-matrix.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.NOE_WEAK_ROUTE_SURFACE_PROBE_OUT_DIR || join(ROOT, 'output', 'noe-audit');
const OUT_BASE = process.env.NOE_WEAK_ROUTE_SURFACE_PROBE_BASENAME || 'weak-route-surface-probe-2026-06-15';
const DEFAULT_BASE_URL = process.env.NOE_PANEL_URL || 'http://127.0.0.1:51835';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const DEFAULT_PATHS = {
  weakRuntimeSupportReview: join(ROOT, 'output', 'noe-audit', 'weak-runtime-support-review-2026-06-15.json'),
};

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function uniq(values = []) {
  return [...new Set(values.filter(Boolean).map((value) => String(value)))].sort();
}

function readJson(path) {
  if (!path || !existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

function rel(path, root = ROOT) {
  return relative(root, path).replaceAll('\\', '/');
}

function clean(value = '', max = 220) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const out = {
    probeLive: false,
    baseUrl: env.NOE_PANEL_URL || DEFAULT_BASE_URL,
    timeoutMs: Number(env.NOE_WEAK_ROUTE_SURFACE_TIMEOUT_MS || 1500),
    includeDynamicGetPlaceholders: env.NOE_WEAK_ROUTE_SURFACE_DYNAMIC_GET === '1',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--probe-live') out.probeLive = true;
    else if (arg === '--include-dynamic-get-placeholders') out.includeDynamicGetPlaceholders = true;
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

async function probePath(base, path, { fetchFn = globalThis.fetch, timeoutMs = 1500 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(250, timeoutMs));
  try {
    const response = await fetchFn(joinUrl(base, path), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const status = Number(response?.status) || 0;
    return { path, status, statusKind: statusKind(status), error: '' };
  } catch (e) {
    return {
      path,
      status: 0,
      statusKind: 'request_failed',
      error: clean(e?.name || e?.message || e || 'request_failed', 160),
    };
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

function classifySurface({ routeImporters = [], candidatePaths = [] } = {}) {
  if (candidatePaths.length) return 'protected_get_surface_candidate';
  if (routeImporters.length) return 'route_importer_without_safe_get_candidate';
  return 'no_route_importer';
}

function placeholderPath(path = '') {
  if (!path || path.includes('*')) return '';
  return path.replace(/:[A-Za-z0-9_]+/g, '__noe_probe__');
}

function extractProtectedGetRouteSpecs(text = '', { includeDynamicGetPlaceholders = false } = {}) {
  const routes = [];
  const re = /\b(?:app|router)\.get\(\s*['"`]([^'"`]+)['"`]\s*,\s*requireOwnerToken\b/g;
  for (const match of String(text || '').matchAll(re)) {
    const originalPath = String(match[1] || '').trim();
    if (!originalPath || originalPath.includes('*')) continue;
    const dynamicPlaceholder = originalPath.includes(':');
    if (dynamicPlaceholder && !includeDynamicGetPlaceholders) continue;
    const probePath = placeholderPath(originalPath);
    if (!probePath) continue;
    routes.push({
      originalPath,
      probePath,
      dynamicPlaceholder,
    });
  }
  return [...new Map(routes.map((route) => [`${route.originalPath}\t${route.probePath}`, route])).values()]
    .sort((a, b) => a.probePath.localeCompare(b.probePath) || a.originalPath.localeCompare(b.originalPath));
}

function buildRouteSpecMap({ root = ROOT, routeFiles = [], includeDynamicGetPlaceholders = false } = {}) {
  const map = new Map();
  for (const routeFile of uniq(routeFiles)) {
    let text = '';
    try { text = readFileSync(join(root, routeFile), 'utf8'); } catch { text = ''; }
    const specs = extractProtectedGetRouteSpecs(text, { includeDynamicGetPlaceholders });
    if (specs.length) map.set(routeFile, specs);
  }
  return map;
}

function routeCandidateFiles(weakReview = {}) {
  return arr(weakReview.files)
    .filter((file) => file.reviewClass === 'route_imported_runtime_candidate')
    .map((file) => ({
      file: file.file,
      module: file.module,
      lines: Number(file.lines) || 0,
      usefulness: file.usefulness,
      disposition: file.disposition,
      supportDecision: file.supportDecision,
      remainingNeed: file.remainingNeed,
      routeImporters: uniq(file.routeImporters),
      testCount: Number(file.testCount) || 0,
      testImporterCount: Number(file.testImporterCount) || 0,
    }));
}

export async function buildNoeWeakRouteSurfaceProbe({
  root = ROOT,
  paths = DEFAULT_PATHS,
  probeLive = false,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = 1500,
  fetchFn = globalThis.fetch,
  routeFiles = null,
  includeDynamicGetPlaceholders = false,
  now = new Date(),
} = {}) {
  const resolvedPaths = { ...DEFAULT_PATHS, ...paths };
  const weakReview = readJson(resolvedPaths.weakRuntimeSupportReview);
  const candidates = routeCandidateFiles(weakReview);
  const candidateRouteFiles = uniq(candidates.flatMap((file) => file.routeImporters));
  const routeSpecMap = buildRouteSpecMap({
    root,
    routeFiles: routeFiles || candidateRouteFiles,
    includeDynamicGetPlaceholders,
  });
  const files = candidates.map((file) => {
    const specs = file.routeImporters.flatMap((routeFile) => arr(routeSpecMap.get(routeFile)).map((spec) => ({
      routeFile,
      ...spec,
    })));
    const candidatePaths = uniq(specs.map((spec) => spec.probePath));
    return {
      ...file,
      protectedGetCandidateSpecs: specs,
      protectedGetCandidatePaths: candidatePaths,
      surface: classifySurface({ routeImporters: file.routeImporters, candidatePaths }),
    };
  }).sort((a, b) => {
    const surfaceOrder = {
      protected_get_surface_candidate: 0,
      route_importer_without_safe_get_candidate: 1,
      no_route_importer: 2,
    };
    return (surfaceOrder[a.surface] ?? 9) - (surfaceOrder[b.surface] ?? 9)
      || b.lines - a.lines
      || a.file.localeCompare(b.file);
  });

  const uniquePaths = uniq(files.flatMap((file) => file.protectedGetCandidatePaths));
  const dynamicPlaceholderPaths = uniq(files.flatMap((file) => file.protectedGetCandidateSpecs)
    .filter((spec) => spec.dynamicPlaceholder)
    .map((spec) => spec.probePath));
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

  const routeImporterIndex = new Map();
  for (const file of files) {
    for (const routeFile of file.routeImporters) {
      if (!routeImporterIndex.has(routeFile)) {
        routeImporterIndex.set(routeFile, {
          routeFile,
          candidateFiles: [],
          protectedGetCandidateSpecs: routeSpecMap.get(routeFile) || [],
        });
      }
      routeImporterIndex.get(routeFile).candidateFiles.push(file.file);
    }
  }
  const routeImporters = [...routeImporterIndex.values()].map((entry) => ({
    routeFile: entry.routeFile,
    candidateFileCount: entry.candidateFiles.length,
    candidateFiles: uniq(entry.candidateFiles),
    protectedGetCandidateSpecs: entry.protectedGetCandidateSpecs,
    protectedGetCandidatePaths: uniq(entry.protectedGetCandidateSpecs.map((spec) => spec.probePath)),
  })).sort((a, b) => b.candidateFileCount - a.candidateFileCount || a.routeFile.localeCompare(b.routeFile));

  const liveAuthSurfaceFiles = files.filter((file) => file.liveProtectedGetProbes.some((probe) => probe.statusKind === 'route_live_auth_protected'));
  return {
    ok: true,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    root: weakReview.root || root,
    mode: probeLive ? 'unauthorized_live_get_probe' : 'static_matrix_only',
    baseUrl: probeLive ? `${localBaseUrl(baseUrl).protocol}//${localBaseUrl(baseUrl).host}` : '',
    inputs: {
      weakRuntimeSupportReview: rel(resolvedPaths.weakRuntimeSupportReview, root),
      weakRuntimeSupportReviewGeneratedAt: weakReview.generatedAt || '',
    },
    policy: {
      defaultStaticOnly: true,
      probeLiveRequiresFlag: true,
      localHostOnlyWhenProbing: true,
      protectedGetOnly: true,
      dynamicProtectedGetRequiresExplicitFlag: true,
      dynamicGetPlaceholdersEnabled: includeDynamicGetPlaceholders,
      noOwnerTokenSent: true,
      noPostRequests: true,
      noResponseBodiesStored: true,
      noDbWrites: true,
      noModelCalls: true,
      noExternalNetworkCalls: true,
      noSecretValuesReturned: true,
    },
    status: {
      probe: probeLive ? 'weak_route_surface_live_probe_complete' : 'weak_route_surface_static_matrix_complete',
      completionClaim: 'not_complete',
      explanation: '401/403 proves the running route/auth surface is registered. It does not prove owner-authorized business execution or that the imported weak candidate ran.',
    },
    summary: {
      routeCandidateFiles: files.length,
      routeImporterFiles: files.filter((file) => file.routeImporters.length).length,
      routeImporterSourceFiles: routeImporters.length,
      protectedGetCandidateFiles: files.filter((file) => file.protectedGetCandidatePaths.length).length,
      uniqueProtectedGetPaths: uniquePaths.length,
      liveProbeExecuted: probeLive,
      liveProbedPaths: liveProbes.length,
      liveAuthSurfaceFiles: liveAuthSurfaceFiles.length,
      liveAuthSurfacePaths: liveProbes.filter((probe) => probe.statusKind === 'route_live_auth_protected').length,
      dynamicPlaceholderPaths: dynamicPlaceholderPaths.length,
      remainingWithoutProtectedGet: files.filter((file) => !file.protectedGetCandidatePaths.length).length,
      remainingWithoutLiveAuthSurface: probeLive
        ? files.length - liveAuthSurfaceFiles.length
        : null,
      surfaceCounts: countBy(files, 'surface'),
      liveStatusKinds: countBy(liveProbes, 'statusKind'),
    },
    routeImporters,
    liveProbes,
    files,
  };
}

function mdTable(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function topCounts(counts = {}) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, value]) => `${key}:${value}`)
    .join('<br>') || '-';
}

export function renderMarkdown(report, jsonPath = '') {
  const importerRows = report.routeImporters.slice(0, 80).map((entry) => [
    `\`${entry.routeFile}\``,
    String(entry.candidateFileCount),
    entry.protectedGetCandidatePaths.map((path) => `\`${path}\``).join('<br>') || '-',
    entry.candidateFiles.slice(0, 8).map((file) => `\`${file}\``).join('<br>') || '-',
  ]);
  const fileRows = report.files.slice(0, 120).map((file) => [
    `\`${file.file}\``,
    file.surface,
    file.routeImporters.map((entry) => `\`${entry}\``).join('<br>') || '-',
    file.protectedGetCandidatePaths.map((path) => `\`${path}\``).join('<br>') || '-',
    file.liveProtectedGetProbes.map((probe) => `${probe.path}:${probe.status ?? '-'}:${probe.statusKind}`).join('<br>') || '-',
    clean(file.remainingNeed || '-', 160),
  ]);
  return [
    '# Noe Weak Route Surface Probe',
    '',
    `Generated: ${report.generatedAt}`,
    `Mode: ${report.mode}`,
    report.baseUrl ? `Base URL: \`${report.baseUrl}\`` : '',
    '',
    '## Verdict',
    '',
    `- probe: \`${report.status.probe}\``,
    `- completion claim: \`${report.status.completionClaim}\``,
    `- explanation: ${report.status.explanation}`,
    '',
    '## Summary',
    '',
    `- route candidate files: ${report.summary.routeCandidateFiles}`,
    `- route importer files: ${report.summary.routeImporterFiles}; route importer source files: ${report.summary.routeImporterSourceFiles}`,
    `- protected GET candidate files: ${report.summary.protectedGetCandidateFiles}; unique protected GET paths: ${report.summary.uniqueProtectedGetPaths}`,
    `- dynamic placeholder GET paths: ${report.summary.dynamicPlaceholderPaths}`,
    `- live probe executed: ${report.summary.liveProbeExecuted}; live auth surface files: ${report.summary.liveAuthSurfaceFiles}; live auth surface paths: ${report.summary.liveAuthSurfacePaths}`,
    `- surface counts: ${topCounts(report.summary.surfaceCounts)}`,
    `- live status kinds: ${topCounts(report.summary.liveStatusKinds)}`,
    '',
    '## Route Importers',
    '',
    mdTable([
      ['route file', 'candidate files', 'protected GET candidates', 'sample candidate files'],
      ['---', '---:', '---', '---'],
      ...importerRows,
    ]),
    '',
    '## Files',
    '',
    mdTable([
      ['file', 'surface', 'route importers', 'protected GET candidates', 'live probes', 'remaining need'],
      ['---', '---', '---', '---', '---', '---'],
      ...fileRows,
    ]),
    '',
    '## Interpretation',
    '',
    '- A protected GET candidate means the weak file is imported by a route file with at least one static `GET` route protected by `requireOwnerToken` and no dynamic path parameters.',
    '- In `--probe-live` mode, `401/403` proves the local server has that protected route/auth surface registered. It still does not prove the imported dependency executed or returned a business summary.',
    '',
    '## JSON',
    '',
    jsonPath ? `Full report: \`${jsonPath.replace(`${ROOT}/`, '')}\`.` : 'No JSON path supplied.',
  ].filter(Boolean).join('\n');
}

export function writeNoeWeakRouteSurfaceProbe(report) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${OUT_BASE}.json`);
  const mdPath = join(OUT_DIR, `${OUT_BASE}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mdPath, `${renderMarkdown(report, jsonPath)}\n`, { mode: 0o600 });
  return { jsonPath, mdPath };
}

export { parseArgs };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs();
  const report = await buildNoeWeakRouteSurfaceProbe(args);
  const paths = writeNoeWeakRouteSurfaceProbe(report);
  console.log(JSON.stringify({
    ok: report.ok,
    mode: report.mode,
    routeCandidateFiles: report.summary.routeCandidateFiles,
    protectedGetCandidateFiles: report.summary.protectedGetCandidateFiles,
    uniqueProtectedGetPaths: report.summary.uniqueProtectedGetPaths,
    liveAuthSurfaceFiles: report.summary.liveAuthSurfaceFiles,
    liveAuthSurfacePaths: report.summary.liveAuthSurfacePaths,
    paths,
  }, null, 2));
}
