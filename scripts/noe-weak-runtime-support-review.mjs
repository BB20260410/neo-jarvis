#!/usr/bin/env node
// @ts-check
// Review weak not-proven-live dispositions using import topology and test signals.
// Read-only: consumes inventory/disposition JSON only; no source bodies, DB, env, model, or network access.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.NOE_WEAK_RUNTIME_SUPPORT_REVIEW_OUT_DIR || join(ROOT, 'output', 'noe-audit');
const OUT_BASE = process.env.NOE_WEAK_RUNTIME_SUPPORT_REVIEW_BASENAME || 'weak-runtime-support-review-2026-06-15';

const DEFAULT_PATHS = {
  disposition: join(ROOT, 'output', 'noe-audit', 'not-proven-live-disposition-audit-2026-06-15.json'),
  inventory: join(ROOT, 'output', 'noe-codebase-inventory', 'latest.json'),
};

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '', max = 240) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function readJson(path) {
  if (!path || !existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

function rel(path) {
  return String(path || '').replace(`${ROOT}/`, '');
}

function inc(counts, key, amount = 1) {
  counts[key] = (counts[key] || 0) + amount;
}

function mapByFile(items = []) {
  return new Map(arr(items).map((item) => [item.file, item]));
}

function reviewFor({ dispositionFile = {}, inventoryFile = {} } = {}) {
  const sourceImporters = arr(inventoryFile.sourceImporters);
  const tests = arr(inventoryFile.tests);
  const testImporters = arr(inventoryFile.testImporters);
  const routeImporters = sourceImporters.filter((file) => file.startsWith('src/server/routes/'));
  const serverImported = sourceImporters.includes('server.js');
  const serviceImporters = sourceImporters.filter((file) => file.startsWith('src/server/services/'));
  const scriptImporters = sourceImporters.filter((file) => file.startsWith('scripts/'));
  const runtimeImporters = sourceImporters.filter((file) => (
    file === 'server.js'
    || file.startsWith('src/server/routes/')
    || file.startsWith('src/server/services/')
    || file.startsWith('src/loop/')
    || file.startsWith('src/runtime/')
    || file.startsWith('src/voice/')
  ));
  const tested = tests.length > 0 || testImporters.length > 0;
  const externalBoundaryModule = ['identity', 'vision', 'channels', 'cloud', 'research', 'secrets', 'mcp', 'plugin', 'webhook'].includes(dispositionFile.module);

  if (routeImporters.length > 0) {
    return {
      reviewClass: 'route_imported_runtime_candidate',
      supportDecision: 'runtime_probe_needed',
      remainingNeed: 'route/auth or owner-authorized behavior probe; do not infer business execution from import alone',
    };
  }
  if (serverImported || serviceImporters.length > 0) {
    return {
      reviewClass: 'server_imported_runtime_candidate',
      supportDecision: 'natural_or_managed_runtime_probe_needed',
      remainingNeed: 'natural runtime evidence, managed local smoke, or owner-authorized status summary',
    };
  }
  if (runtimeImporters.length > 0) {
    return {
      reviewClass: 'runtime_chain_imported_candidate',
      supportDecision: 'targeted_runtime_probe_needed',
      remainingNeed: 'targeted runtime probe through importer chain',
    };
  }
  if (externalBoundaryModule && tested) {
    return {
      reviewClass: 'external_boundary_support_with_tests',
      supportDecision: 'support_or_fixture_evidence_ok_live_optional',
      remainingNeed: 'live provider/device proof only if feature is claimed active',
    };
  }
  if (scriptImporters.length > 0 && sourceImporters.length === scriptImporters.length && tested) {
    return {
      reviewClass: 'script_or_manual_tool_support_with_tests',
      supportDecision: 'manual_support_not_live_feature',
      remainingNeed: 'wire into runtime only if this tool should be always-on',
    };
  }
  if (tested && sourceImporters.length > 0) {
    return {
      reviewClass: 'library_support_with_unit_coverage',
      supportDecision: 'support_role_confirmed_by_imports_and_tests',
      remainingNeed: '',
    };
  }
  if (tested) {
    return {
      reviewClass: 'isolated_library_with_tests',
      supportDecision: 'support_role_likely_manual_review',
      remainingNeed: 'confirm this is intentionally unimported support code',
    };
  }
  return {
    reviewClass: 'uncovered_support_or_dead_code_candidate',
    supportDecision: 'manual_review_or_probe_needed',
    remainingNeed: 'add tests, support-only decision, or runtime probe',
  };
}

export function buildNoeWeakRuntimeSupportReview({
  paths = DEFAULT_PATHS,
  now = new Date(),
} = {}) {
  const resolvedPaths = { ...DEFAULT_PATHS, ...paths };
  const disposition = readJson(resolvedPaths.disposition);
  const inventory = readJson(resolvedPaths.inventory);
  const inventoryMap = mapByFile(inventory.files);
  const weakFiles = arr(disposition.files).filter((file) => file.strength === 'weak');
  const files = weakFiles.map((file) => {
    const inventoryFile = inventoryMap.get(file.file) || {};
    const review = reviewFor({ dispositionFile: file, inventoryFile });
    return {
      file: file.file,
      module: file.module,
      lines: file.lines,
      usefulness: file.usefulness,
      disposition: file.disposition,
      reviewClass: review.reviewClass,
      supportDecision: review.supportDecision,
      remainingNeed: review.remainingNeed,
      sourceImporters: arr(inventoryFile.sourceImporters).slice(0, 12),
      routeImporters: arr(inventoryFile.sourceImporters).filter((item) => item.startsWith('src/server/routes/')).slice(0, 12),
      serverImported: arr(inventoryFile.sourceImporters).includes('server.js'),
      serviceImporters: arr(inventoryFile.sourceImporters).filter((item) => item.startsWith('src/server/services/')).slice(0, 12),
      scriptImporters: arr(inventoryFile.sourceImporters).filter((item) => item.startsWith('scripts/')).slice(0, 12),
      testCount: arr(inventoryFile.tests).length,
      testImporterCount: arr(inventoryFile.testImporters).length,
      hasTests: arr(inventoryFile.tests).length > 0 || arr(inventoryFile.testImporters).length > 0,
    };
  });
  const reviewClassCounts = {};
  const supportDecisionCounts = {};
  const byModule = {};
  for (const file of files) {
    inc(reviewClassCounts, file.reviewClass);
    inc(supportDecisionCounts, file.supportDecision);
    if (!byModule[file.module]) byModule[file.module] = { files: 0, lines: 0, reviewClassCounts: {}, supportDecisionCounts: {} };
    byModule[file.module].files += 1;
    byModule[file.module].lines += Number(file.lines) || 0;
    inc(byModule[file.module].reviewClassCounts, file.reviewClass);
    inc(byModule[file.module].supportDecisionCounts, file.supportDecision);
  }
  const runtimeProbeNeeded = files.filter((file) => file.supportDecision.includes('runtime_probe_needed')
    || file.supportDecision.includes('natural_or_managed_runtime_probe_needed')
    || file.supportDecision.includes('targeted_runtime_probe_needed'));
  const supportConfirmed = files.filter((file) => [
    'support_role_confirmed_by_imports_and_tests',
    'manual_support_not_live_feature',
    'support_or_fixture_evidence_ok_live_optional',
  ].includes(file.supportDecision));
  return {
    ok: true,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    root: disposition.root || inventory.root || ROOT,
    inputs: Object.fromEntries(Object.entries(resolvedPaths).map(([key, path]) => [key, rel(path)])),
    policy: {
      readOnlyAudit: true,
      noSourceBodiesRead: true,
      noDbReads: true,
      noEnvFileReads: true,
      noOwnerTokenReads: true,
      noProtectedApiAuth: true,
      noModelCalls: true,
      noNetworkCalls: true,
      noSecretValuesReturned: true,
    },
    status: {
      review: 'weak_runtime_support_review_complete',
      completionClaim: 'not_complete',
      explanation: 'Weak not-proven-live files are split by import topology and test coverage. Runtime candidates still need live/managed proof; support files are not treated as always-on features.',
    },
    summary: {
      weakFiles: files.length,
      weakLines: files.reduce((sum, file) => sum + (Number(file.lines) || 0), 0),
      reviewClassCounts,
      supportDecisionCounts,
      runtimeProbeNeeded: runtimeProbeNeeded.length,
      supportConfirmed: supportConfirmed.length,
      manualReviewOrProbeNeeded: files.filter((file) => file.supportDecision === 'manual_review_or_probe_needed' || file.supportDecision === 'support_role_likely_manual_review').length,
      routeImportedRuntimeCandidates: files.filter((file) => file.reviewClass === 'route_imported_runtime_candidate').length,
      serverImportedRuntimeCandidates: files.filter((file) => file.reviewClass === 'server_imported_runtime_candidate').length,
      librarySupportWithUnitCoverage: files.filter((file) => file.reviewClass === 'library_support_with_unit_coverage').length,
    },
    byModule: Object.entries(byModule)
      .map(([module, value]) => ({ module, ...value }))
      .sort((a, b) => b.lines - a.lines || b.files - a.files || a.module.localeCompare(b.module)),
    files: files.sort((a, b) => {
      const order = {
        route_imported_runtime_candidate: 0,
        server_imported_runtime_candidate: 1,
        runtime_chain_imported_candidate: 2,
        uncovered_support_or_dead_code_candidate: 3,
      };
      return (order[a.reviewClass] ?? 10) - (order[b.reviewClass] ?? 10)
        || b.lines - a.lines
        || a.file.localeCompare(b.file);
    }),
  };
}

function mdTable(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function topCounts(counts = {}, max = 5) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([key, value]) => `${key}:${value}`)
    .join('<br>') || '-';
}

export function renderMarkdown(report, jsonPath = '') {
  const moduleRows = report.byModule.slice(0, 80).map((item) => [
    `\`${item.module}\``,
    String(item.files),
    String(item.lines),
    topCounts(item.reviewClassCounts, 4),
    topCounts(item.supportDecisionCounts, 4),
  ]);
  const fileRows = report.files.slice(0, 120).map((file) => [
    `\`${file.file}\``,
    file.reviewClass,
    file.supportDecision,
    file.serverImported ? 'yes' : '',
    file.routeImporters.length ? file.routeImporters.map((item) => `\`${item}\``).join('<br>') : '-',
    String(file.testCount),
    clean(file.remainingNeed || '-', 180),
  ]);
  return [
    '# Noe Weak Runtime Support Review',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Verdict',
    '',
    `- review: \`${report.status.review}\``,
    `- completion claim: \`${report.status.completionClaim}\``,
    `- explanation: ${report.status.explanation}`,
    '',
    '## Summary',
    '',
    `- weak files: ${report.summary.weakFiles}; weak lines: ${report.summary.weakLines}`,
    `- runtime probe needed: ${report.summary.runtimeProbeNeeded}; support confirmed: ${report.summary.supportConfirmed}; manual review/probe needed: ${report.summary.manualReviewOrProbeNeeded}`,
    `- review classes: ${topCounts(report.summary.reviewClassCounts, 8)}`,
    `- support decisions: ${topCounts(report.summary.supportDecisionCounts, 8)}`,
    '',
    '## By Module',
    '',
    mdTable([
      ['module', 'files', 'lines', 'review classes', 'support decisions'],
      ['---', '---:', '---:', '---', '---'],
      ...moduleRows,
    ]),
    '',
    '## Files',
    '',
    mdTable([
      ['file', 'review class', 'decision', 'server imported', 'route importers', 'tests', 'remaining need'],
      ['---', '---', '---', '---', '---', '---:', '---'],
      ...fileRows,
    ]),
    '',
    '## JSON',
    '',
    jsonPath ? `Full report: \`${jsonPath.replace(`${ROOT}/`, '')}\`.` : 'No JSON path supplied.',
  ].join('\n');
}

export function writeNoeWeakRuntimeSupportReview(report) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${OUT_BASE}.json`);
  const mdPath = join(OUT_DIR, `${OUT_BASE}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mdPath, `${renderMarkdown(report, jsonPath)}\n`, { mode: 0o600 });
  return { jsonPath, mdPath };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = buildNoeWeakRuntimeSupportReview();
  const paths = writeNoeWeakRuntimeSupportReview(report);
  console.log(JSON.stringify({
    ok: report.ok,
    review: report.status.review,
    weakFiles: report.summary.weakFiles,
    runtimeProbeNeeded: report.summary.runtimeProbeNeeded,
    supportConfirmed: report.summary.supportConfirmed,
    manualReviewOrProbeNeeded: report.summary.manualReviewOrProbeNeeded,
    routeImportedRuntimeCandidates: report.summary.routeImportedRuntimeCandidates,
    serverImportedRuntimeCandidates: report.summary.serverImportedRuntimeCandidates,
    librarySupportWithUnitCoverage: report.summary.librarySupportWithUnitCoverage,
    paths,
  }, null, 2));
}
