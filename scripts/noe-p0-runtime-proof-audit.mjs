#!/usr/bin/env node
// @ts-check
// Audit P0 runtime-proof backlog files without touching the live panel.
// Read-only: consumes prior reports only; no source bodies, DB, env files, model calls, network calls, or endpoint probes.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKLOG_PATH = process.env.NOE_RUNTIME_PROOF_BACKLOG_PATH || join(ROOT, 'output', 'noe-audit', 'runtime-proof-backlog-2026-06-15.json');
const INVENTORY_PATH = process.env.NOE_CODEBASE_INVENTORY_PATH || join(ROOT, 'output', 'noe-codebase-inventory', 'latest.json');
const MODULE_MAP_PATH = process.env.NOE_MODULE_RUNTIME_MAP_PATH || join(ROOT, 'output', 'noe-audit', 'module-runtime-map-2026-06-15.json');
const OUT_DIR = process.env.NOE_P0_RUNTIME_PROOF_AUDIT_OUT_DIR || join(ROOT, 'output', 'noe-audit');
const OUT_BASE = process.env.NOE_P0_RUNTIME_PROOF_AUDIT_BASENAME || 'p0-runtime-proof-audit-2026-06-15';

const RUNTIME_SPINE_PREFIXES = [
  'src/loop/',
  'src/runtime/',
  'src/permissions/',
  'src/governance/',
  'src/safety/',
  'src/actions/',
  'src/autopilot/',
  'src/room/',
  'src/model/',
  'src/memory/',
  'src/context/',
  'src/capabilities/',
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function _uniq(values = []) {
  return [...new Set(values.filter(Boolean).map((value) => String(value)))].sort();
}

function _clean(value = '', max = 240) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function indexByFile(items = []) {
  return new Map(arr(items).map((item) => [String(item.file || ''), item]));
}

function indexByModule(items = []) {
  return new Map(arr(items).map((item) => [String(item.module || ''), item]));
}

function routeImporters(importers = []) {
  return arr(importers).filter((file) => String(file).startsWith('src/server/routes/'));
}

function serverServiceImporters(importers = []) {
  return arr(importers).filter((file) => String(file).startsWith('src/server/services/'));
}

function runtimeSpineImporters(importers = []) {
  return arr(importers).filter((file) => RUNTIME_SPINE_PREFIXES.some((prefix) => String(file).startsWith(prefix)));
}

function strongestStaticWiring({ sourceImporters = [] } = {}) {
  const importers = arr(sourceImporters);
  const directServerImport = importers.includes('server.js');
  const routes = routeImporters(importers);
  const services = serverServiceImporters(importers);
  const spine = runtimeSpineImporters(importers);
  if (directServerImport && routes.length) return 'server_and_route_reachable_static';
  if (directServerImport) return 'server_constructed_static';
  if (routes.length) return 'route_reachable_static';
  if (services.length) return 'server_service_reachable_static';
  if (spine.length) return 'runtime_spine_reachable_static';
  if (importers.length) return 'source_imported_static';
  return 'not_static_reachable';
}

function executionObservation({ inventoryItem = {}, moduleItem = {} } = {}) {
  const moduleRuntime = moduleItem.runtime || {};
  const directHints = [...arr(inventoryItem.routeHints), ...arr(inventoryItem.runtimeHints)];
  if (directHints.length && ['live_evidence', 'live_with_gap'].includes(moduleRuntime.strength)) {
    return 'module_mapped_live_but_file_execution_unobserved';
  }
  return 'not_observed_live_execution';
}

function verdictFor({ staticWiring, execution } = {}) {
  if (execution === 'module_mapped_live_but_file_execution_unobserved') {
    return 'useful_static_surface_needs_direct_behavior_probe';
  }
  if (['server_and_route_reachable_static', 'server_constructed_static', 'route_reachable_static', 'server_service_reachable_static'].includes(staticWiring)) {
    return 'wired_to_live_server_static_but_not_proven_executed';
  }
  if (staticWiring === 'runtime_spine_reachable_static') {
    return 'wired_to_runtime_spine_static_but_not_proven_executed';
  }
  if (staticWiring === 'source_imported_static') {
    return 'useful_dependency_static_only_needs_probe';
  }
  return 'usefulness_claim_needs_reachability_probe';
}

function probeFor(file = '', fallback = '') {
  const f = String(file || '');
  if (f.endsWith('AgentRunStore.js')) return 'readonly_agent_runs_route_and_storage_count_probe';
  if (f.endsWith('AgentSkillRegistry.js')) return 'agent_registry_route_and_room_dispatcher_classification_probe';
  if (f.endsWith('WebSearch.js')) return 'provider_status_and_mocked_search_probe_no_paid_provider_call';
  if (f.endsWith('AgentRunVerificationExecutor.js')) return 'agent_run_verification_route_smoke_with_temp_or_mock_run';
  if (f.endsWith('NoePolicyFileGuard.js')) return 'safe_act_or_boot_self_check_policy_drill_temp_path_only';
  if (f.endsWith('NoeCommandSurface.js')) return 'noe_commands_discovery_route_probe_no_action_execution';
  if (f.endsWith('ActivityLog.js')) return 'readonly_activity_route_and_recent_event_count_probe';
  return fallback || 'targeted_runtime_probe';
}

function buildFileAudit({ backlogFile, inventoryItem = {}, moduleItem = {} }) {
  const sourceImporters = arr(inventoryItem.sourceImporters);
  const routes = routeImporters(sourceImporters);
  const services = serverServiceImporters(sourceImporters);
  const spine = runtimeSpineImporters(sourceImporters);
  const staticWiring = strongestStaticWiring({ sourceImporters });
  const execution = executionObservation({ inventoryItem, moduleItem });
  return {
    file: backlogFile.file,
    module: backlogFile.module,
    priority: backlogFile.priority,
    score: backlogFile.score,
    usefulness: backlogFile.usefulness,
    runtimeProofFromAtlas: backlogFile.runtimeProof,
    recommendedProofStrategyFromBacklog: backlogFile.recommendedProofStrategy,
    staticWiring,
    executionObservation: execution,
    verdict: verdictFor({ staticWiring, execution }),
    nextProof: probeFor(backlogFile.file, backlogFile.recommendedProofStrategy),
    evidence: {
      directServerImport: sourceImporters.includes('server.js'),
      routeImporters: routes,
      serverServiceImporters: services,
      runtimeSpineImporters: spine,
      sourceImporterCount: sourceImporters.length,
      directTests: arr(inventoryItem.tests).length,
      testImporters: arr(inventoryItem.testImporters).length,
      envVarNames: arr(inventoryItem.envVars),
      moduleRuntimeStrength: moduleItem.runtime?.strength || 'unknown',
      moduleRuntimeIds: arr(moduleItem.runtime?.ids),
      moduleRuntimeGaps: arr(moduleItem.runtime?.gaps),
    },
  };
}

function countBy(items = [], key) {
  const counts = {};
  for (const item of items) {
    const value = String(item[key] || 'unknown');
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function buildAudit({ backlog, inventory, moduleMap, paths = {} }) {
  const inventoryByFile = indexByFile(inventory?.files);
  const moduleByName = indexByModule(moduleMap?.modules);
  const p0 = arr(backlog?.files).filter((file) => file.priority === 'P0');
  const files = p0.map((backlogFile) => buildFileAudit({
    backlogFile,
    inventoryItem: inventoryByFile.get(backlogFile.file) || {},
    moduleItem: moduleByName.get(backlogFile.module) || {},
  }));
  const observedLiveExecution = files.filter((file) => file.executionObservation !== 'not_observed_live_execution');
  const staticReachable = files.filter((file) => file.staticWiring !== 'not_static_reachable');
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    root: backlog?.root || inventory?.root || ROOT,
    inputs: {
      backlogPath: paths.backlogPath || BACKLOG_PATH,
      backlogGeneratedAt: backlog?.generatedAt || '',
      inventoryPath: paths.inventoryPath || INVENTORY_PATH,
      inventoryGeneratedAt: inventory?.generatedAt || '',
      moduleMapPath: paths.moduleMapPath || MODULE_MAP_PATH,
      moduleMapGeneratedAt: moduleMap?.generatedAt || '',
    },
    policy: {
      readOnlyFiles: true,
      inputReportsOnly: true,
      noSourceBodiesRead: true,
      noDbWrites: true,
      noEnvFileReads: true,
      noModelCalls: true,
      noNetworkCalls: true,
      noLiveEndpointCalls: true,
      noSecretValuesReturned: true,
    },
    summary: {
      p0Files: files.length,
      staticReachableFiles: staticReachable.length,
      observedLiveExecutionFiles: observedLiveExecution.length,
      notObservedLiveExecutionFiles: files.length - observedLiveExecution.length,
      staticWiringCounts: countBy(files, 'staticWiring'),
      verdictCounts: countBy(files, 'verdict'),
      runtimeBlockers: arr(backlog?.summary?.runtimeBlockers),
    },
    files: files.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file)),
  };
}

function mdTable(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function renderCounts(counts = {}) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => `${key}:${count}`)
    .join('<br>') || '-';
}

function renderMarkdown(report, jsonPath) {
  const rows = report.files.map((file) => [
    `\`${file.file}\``,
    file.staticWiring,
    file.executionObservation,
    file.verdict,
    file.nextProof,
    [
      file.evidence.directServerImport ? 'server.js' : '',
      file.evidence.routeImporters.length ? `routes:${file.evidence.routeImporters.length}` : '',
      file.evidence.runtimeSpineImporters.length ? `runtime:${file.evidence.runtimeSpineImporters.length}` : '',
      file.evidence.envVarNames.length ? `env:${file.evidence.envVarNames.join(',')}` : '',
    ].filter(Boolean).join('<br>') || '-',
  ]);
  return [
    '# Neo P0 Runtime Proof Audit',
    '',
    `Generated: ${report.generatedAt}`,
    `Backlog: ${report.inputs.backlogGeneratedAt || '-'}`,
    '',
    '## Summary',
    '',
    `- P0 files: ${report.summary.p0Files}`,
    `- static reachable files: ${report.summary.staticReachableFiles}`,
    `- observed live execution files: ${report.summary.observedLiveExecutionFiles}`,
    `- not observed live execution files: ${report.summary.notObservedLiveExecutionFiles}`,
    `- static wiring: ${renderCounts(report.summary.staticWiringCounts)}`,
    `- verdicts: ${renderCounts(report.summary.verdictCounts)}`,
    `- runtime blockers: ${report.summary.runtimeBlockers.map((item) => `\`${item}\``).join(', ') || 'none'}`,
    '',
    '## P0 Files',
    '',
    mdTable([
      ['file', 'static wiring', 'execution observation', 'verdict', 'next proof', 'static evidence'],
      ['---', '---', '---', '---', '---', '---'],
      ...rows,
    ]),
    '',
    '## Interpretation',
    '',
    '- Static reachability means the module is imported by the server, routes, services, or runtime spine. It is not proof that the code path executed in the live process.',
    '- Live execution remains unobserved for all P0 files in this report. The next proof column is the smallest behavioral probe needed to turn each claim into runtime evidence.',
    '',
    '## JSON',
    '',
    `Full audit is in \`${jsonPath.replace(`${ROOT}/`, '')}\`. It contains paths, import counts, env var names, test counts, and proof labels only; no source bodies or secret values.`,
    '',
    '## Policy',
    '',
    '- input reports only; no source body reads',
    '- no DB writes, no model calls, no network calls, no live endpoint calls',
    '- no `.env` reads, no owner-token reads, no file bodies in output',
  ].join('\n');
}

function writeAudit(report) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${OUT_BASE}.json`);
  const mdPath = join(OUT_DIR, `${OUT_BASE}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mdPath, `${renderMarkdown(report, jsonPath)}\n`, { mode: 0o600 });
  return { jsonPath, mdPath };
}

export function buildNoeP0RuntimeProofAudit({
  backlogPath = BACKLOG_PATH,
  inventoryPath = INVENTORY_PATH,
  moduleMapPath = MODULE_MAP_PATH,
} = {}) {
  if (!existsSync(backlogPath)) throw new Error(`runtime proof backlog not found: ${backlogPath}`);
  if (!existsSync(inventoryPath)) throw new Error(`codebase inventory not found: ${inventoryPath}`);
  if (!existsSync(moduleMapPath)) throw new Error(`module runtime map not found: ${moduleMapPath}`);
  return buildAudit({
    backlog: readJson(backlogPath),
    inventory: readJson(inventoryPath),
    moduleMap: readJson(moduleMapPath),
    paths: { backlogPath, inventoryPath, moduleMapPath },
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = buildNoeP0RuntimeProofAudit();
  const paths = writeAudit(report);
  console.log(JSON.stringify({
    ok: true,
    generatedAt: report.generatedAt,
    p0Files: report.summary.p0Files,
    staticReachableFiles: report.summary.staticReachableFiles,
    observedLiveExecutionFiles: report.summary.observedLiveExecutionFiles,
    paths,
  }, null, 2));
}
