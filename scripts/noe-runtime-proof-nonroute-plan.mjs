#!/usr/bin/env node
// @ts-check
// Plan proof lanes for runtime-proof backlog files that are not covered by protected GET route surfaces.
// Read-only: consumes audit JSON reports only; no source bodies, DB writes, env reads, owner token, model calls, or network calls.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MATRIX_PATH = process.env.NOE_AUTH_SURFACE_MATRIX_PATH || join(ROOT, 'output', 'noe-audit', 'runtime-proof-auth-surface-matrix-live-2026-06-15.json');
const INVENTORY_PATH = process.env.NOE_CODEBASE_INVENTORY_PATH || join(ROOT, 'output', 'noe-codebase-inventory', 'latest.json');
const BACKLOG_PATH = process.env.NOE_RUNTIME_PROOF_BACKLOG_PATH || join(ROOT, 'output', 'noe-audit', 'runtime-proof-backlog-2026-06-15.json');
const OUT_DIR = process.env.NOE_NONROUTE_PLAN_OUT_DIR || join(ROOT, 'output', 'noe-audit');
const OUT_BASE = process.env.NOE_NONROUTE_PLAN_BASENAME || 'runtime-proof-nonroute-plan-2026-06-15';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function uniq(values = []) {
  return [...new Set(values.filter(Boolean).map((value) => String(value)))].sort();
}

function indexByFile(items = []) {
  return new Map(arr(items).map((item) => [String(item.file || ''), item]));
}

function routeImporters(importers = []) {
  return arr(importers).filter((file) => String(file).startsWith('src/server/routes/'));
}

function serverImported(importers = []) {
  return arr(importers).includes('server.js');
}

function laneFor({ matrixFile = {}, inventoryItem = {}, backlogFile = {} } = {}) {
  const file = String(matrixFile.file || backlogFile.file || '');
  const module = String(matrixFile.module || backlogFile.module || inventoryItem.module || '');
  const strategy = String(matrixFile.recommendedProofStrategy || backlogFile.recommendedProofStrategy || '');
  const importers = arr(inventoryItem.sourceImporters);
  if (matrixFile.surface === 'route_importer_without_safe_get_candidate') {
    return {
      lane: 'authorized_post_or_dynamic_route_probe',
      proofKind: 'owner-authorized route smoke with mock/temp input',
      ownerTokenNeeded: true,
      livePanelNeeded: true,
      externalNetworkRisk: false,
      paidQuotaRisk: false,
      nextProof: 'inspect route method/body contract, then run an owner-authorized mock/temp probe without external side effects',
    };
  }
  if (strategy === 'support_only_classification_review') {
    return {
      lane: 'support_only_classification_review',
      proofKind: 'support-only review plus existing tests',
      ownerTokenNeeded: false,
      livePanelNeeded: false,
      externalNetworkRisk: false,
      paidQuotaRisk: false,
      nextProof: 'confirm the file is an adapter/library helper and record support-only classification with direct tests',
    };
  }
  if (module === 'autopilot') {
    return {
      lane: 'scheduler_or_delegation_runtime_evidence',
      proofKind: 'natural scheduler/delegation evidence',
      ownerTokenNeeded: false,
      livePanelNeeded: true,
      externalNetworkRisk: false,
      paidQuotaRisk: false,
      nextProof: 'collect natural scheduler/delegation run evidence or a managed temp delegation smoke without taking over live ports',
    };
  }
  if (module === 'capabilities') {
    return {
      lane: 'local_capability_drill',
      proofKind: 'local temp capability/allowlist/tool drill',
      ownerTokenNeeded: false,
      livePanelNeeded: false,
      externalNetworkRisk: false,
      paidQuotaRisk: false,
      nextProof: 'run a local temp drill for allowlist/manifest/executor/router behavior without invoking real tools',
    };
  }
  if (module === 'agents') {
    return {
      lane: /ParserAdapter|parsers\//.test(file) ? 'parser_fixture_drill' : 'codebase_index_local_drill',
      proofKind: 'local fixture index/parser drill',
      ownerTokenNeeded: false,
      livePanelNeeded: false,
      externalNetworkRisk: false,
      paidQuotaRisk: false,
      nextProof: 'run local fixture indexing/parser smoke and record counts only',
    };
  }
  if (['security', 'approval', 'audit'].includes(module)) {
    return {
      lane: 'local_safety_policy_drill',
      proofKind: 'local safety/policy audit drill',
      ownerTokenNeeded: false,
      livePanelNeeded: false,
      externalNetworkRisk: false,
      paidQuotaRisk: false,
      nextProof: 'run temp-path or fake-store safety drill; do not mutate real policy/config files',
    };
  }
  if (['secrets', 'cloud'].includes(module)) {
    return {
      lane: 'provider_health_status_or_mock_probe',
      proofKind: 'provider health/status or mocked provider probe',
      ownerTokenNeeded: false,
      livePanelNeeded: false,
      externalNetworkRisk: true,
      paidQuotaRisk: true,
      nextProof: 'prefer mocked provider health; if live status is needed, report provider availability without printing secret values or making paid calls',
    };
  }
  if (['identity', 'vision'].includes(module)) {
    return {
      lane: 'local_model_or_sensor_status_preflight',
      proofKind: 'local model/sensor status preflight',
      ownerTokenNeeded: false,
      livePanelNeeded: false,
      externalNetworkRisk: false,
      paidQuotaRisk: false,
      nextProof: 'run local model/sensor status probe or fixture inference without camera/microphone capture unless explicitly requested',
    };
  }
  if (module === 'mcp') {
    return {
      lane: 'mcp_smoke_or_audit_probe',
      proofKind: 'MCP aggregation smoke',
      ownerTokenNeeded: false,
      livePanelNeeded: false,
      externalNetworkRisk: false,
      paidQuotaRisk: false,
      nextProof: 'run MCP aggregation audit with fake/local registry or no-op servers; no external connector calls',
    };
  }
  if (module === 'workspace') {
    return {
      lane: 'workspace_temp_dir_drill',
      proofKind: 'workspace temp-directory drill',
      ownerTokenNeeded: false,
      livePanelNeeded: false,
      externalNetworkRisk: false,
      paidQuotaRisk: false,
      nextProof: 'run temp workspace/safe-delete drill; never delete user files',
    };
  }
  if (module === 'skills') {
    return {
      lane: 'skill_fixture_drill',
      proofKind: 'skill fixture extraction/curation drill',
      ownerTokenNeeded: false,
      livePanelNeeded: false,
      externalNetworkRisk: false,
      paidQuotaRisk: false,
      nextProof: 'run fixture skill extraction/curation/rollback drill with temporary files only',
    };
  }
  if (['watcher', 'plugin'].includes(module)) {
    return {
      lane: strategy === 'support_only_classification_review' ? 'support_only_classification_review' : 'adapter_fake_spawn_http_drill',
      proofKind: 'adapter fake spawn/http drill',
      ownerTokenNeeded: false,
      livePanelNeeded: false,
      externalNetworkRisk: false,
      paidQuotaRisk: false,
      nextProof: 'use fake spawn/fetch adapters and classify live use separately from support library behavior',
    };
  }
  if (['knowledge', 'archive'].includes(module)) {
    return {
      lane: module === 'archive' ? 'archive_lineage_holdout_drill' : 'knowledge_store_temp_db_drill',
      proofKind: 'temp DB/store drill',
      ownerTokenNeeded: false,
      livePanelNeeded: false,
      externalNetworkRisk: false,
      paidQuotaRisk: false,
      nextProof: 'run temp DB/store drill and record counts/digests only, no memory bodies',
    };
  }
  if (module === 'report') {
    return {
      lane: 'report_fixture_drill',
      proofKind: 'report fixture render drill',
      ownerTokenNeeded: false,
      livePanelNeeded: false,
      externalNetworkRisk: false,
      paidQuotaRisk: false,
      nextProof: 'render report fixture and assert fields without exposing room transcript/body text',
    };
  }
  if (module === 'research') {
    return {
      lane: serverImported(importers) ? 'server_constructed_provider_status_probe' : 'research_mock_probe',
      proofKind: 'no-paid-call research/status or mocked research probe',
      ownerTokenNeeded: serverImported(importers),
      livePanelNeeded: serverImported(importers),
      externalNetworkRisk: true,
      paidQuotaRisk: true,
      nextProof: serverImported(importers)
        ? 'use owner-authorized status-only route or mocked provider; do not perform real search/fetch'
        : 'run mocked research intent/deep-research fixture; do not call web providers',
    };
  }
  return {
    lane: 'support_or_runtime_classification_review',
    proofKind: 'manual support/runtime classification',
    ownerTokenNeeded: routeImporters(importers).length > 0,
    livePanelNeeded: routeImporters(importers).length > 0,
    externalNetworkRisk: false,
    paidQuotaRisk: false,
    nextProof: 'review import chain and either add a local drill, live evidence probe, or support-only classification',
  };
}

function urgencyFor(file = {}) {
  if (file.priority === 'P0') return 'highest';
  if (file.priority === 'P1') return 'high';
  if (file.priority === 'P2') return 'medium';
  return 'low';
}

function buildPlan({ matrix, inventory, backlog }) {
  const inventoryByFile = indexByFile(inventory.files);
  const backlogByFile = indexByFile(backlog.files);
  const uncovered = arr(matrix.files)
    .filter((file) => file.surface !== 'protected_get_surface_candidate')
    .map((matrixFile) => {
      const inventoryItem = inventoryByFile.get(matrixFile.file) || {};
      const backlogFile = backlogByFile.get(matrixFile.file) || {};
      const lane = laneFor({ matrixFile, inventoryItem, backlogFile });
      const importers = arr(inventoryItem.sourceImporters);
      return {
        file: matrixFile.file,
        priority: matrixFile.priority,
        module: matrixFile.module,
        surface: matrixFile.surface,
        recommendedProofStrategy: matrixFile.recommendedProofStrategy,
        lane: lane.lane,
        proofKind: lane.proofKind,
        urgency: urgencyFor(matrixFile),
        ownerTokenNeeded: lane.ownerTokenNeeded,
        livePanelNeeded: lane.livePanelNeeded,
        externalNetworkRisk: lane.externalNetworkRisk,
        paidQuotaRisk: lane.paidQuotaRisk,
        nextProof: lane.nextProof,
        sourceImporters: importers.slice(0, 20),
        routeImporters: routeImporters(importers),
        directTests: arr(inventoryItem.tests).length,
        testImporters: arr(inventoryItem.testImporters).length,
      };
    })
    .sort((a, b) => {
      const prio = ['P0', 'P1', 'P2', 'P3'];
      return prio.indexOf(a.priority) - prio.indexOf(b.priority)
        || a.lane.localeCompare(b.lane)
        || a.file.localeCompare(b.file);
    });

  const byLane = [];
  for (const lane of uniq(uncovered.map((file) => file.lane))) {
    const files = uncovered.filter((file) => file.lane === lane);
    byLane.push({
      lane,
      files: files.length,
      priorities: countBy(files, 'priority'),
      ownerTokenNeeded: files.filter((file) => file.ownerTokenNeeded).length,
      livePanelNeeded: files.filter((file) => file.livePanelNeeded).length,
      externalNetworkRisk: files.filter((file) => file.externalNetworkRisk).length,
      paidQuotaRisk: files.filter((file) => file.paidQuotaRisk).length,
      topFiles: files.slice(0, 8).map((file) => ({ file: file.file, priority: file.priority, nextProof: file.nextProof })),
    });
  }
  byLane.sort((a, b) => b.files - a.files || a.lane.localeCompare(b.lane));

  const byPriority = [];
  for (const priority of ['P0', 'P1', 'P2', 'P3']) {
    const files = uncovered.filter((file) => file.priority === priority);
    byPriority.push({
      priority,
      files: files.length,
      lanes: countBy(files, 'lane'),
      ownerTokenNeeded: files.filter((file) => file.ownerTokenNeeded).length,
      livePanelNeeded: files.filter((file) => file.livePanelNeeded).length,
      paidQuotaRisk: files.filter((file) => file.paidQuotaRisk).length,
    });
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    root: matrix.root || inventory.root || backlog.root || ROOT,
    inputs: {
      matrixPath: MATRIX_PATH,
      matrixGeneratedAt: matrix.generatedAt || '',
      inventoryPath: INVENTORY_PATH,
      inventoryGeneratedAt: inventory.generatedAt || '',
      backlogPath: BACKLOG_PATH,
      backlogGeneratedAt: backlog.generatedAt || '',
    },
    policy: {
      inputReportsOnly: true,
      noSourceBodiesRead: true,
      noDbWrites: true,
      noEnvFileReads: true,
      noOwnerTokenReads: true,
      noModelCalls: true,
      noNetworkCalls: true,
      noSecretValuesReturned: true,
    },
    summary: {
      backlogFiles: arr(matrix.files).length,
      protectedGetSurfaceFiles: arr(matrix.files).filter((file) => file.surface === 'protected_get_surface_candidate').length,
      uncoveredFiles: uncovered.length,
      noRouteImporterFiles: uncovered.filter((file) => file.surface === 'no_route_importer').length,
      routeImporterWithoutSafeGetFiles: uncovered.filter((file) => file.surface === 'route_importer_without_safe_get_candidate').length,
      lanes: byLane.length,
      ownerTokenNeeded: uncovered.filter((file) => file.ownerTokenNeeded).length,
      livePanelNeeded: uncovered.filter((file) => file.livePanelNeeded).length,
      externalNetworkRisk: uncovered.filter((file) => file.externalNetworkRisk).length,
      paidQuotaRisk: uncovered.filter((file) => file.paidQuotaRisk).length,
    },
    byPriority,
    byLane,
    files: uncovered,
  };
}

function countBy(items = [], key) {
  const counts = {};
  for (const item of items) {
    const value = typeof key === 'function' ? key(item) : item[key];
    const text = String(value || 'unknown');
    counts[text] = (counts[text] || 0) + 1;
  }
  return counts;
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
  const priorityRows = report.byPriority.map((entry) => [
    entry.priority,
    String(entry.files),
    renderCounts(entry.lanes),
    String(entry.ownerTokenNeeded),
    String(entry.livePanelNeeded),
    String(entry.paidQuotaRisk),
  ]);
  const laneRows = report.byLane.map((entry) => [
    entry.lane,
    String(entry.files),
    renderCounts(entry.priorities),
    String(entry.ownerTokenNeeded),
    String(entry.livePanelNeeded),
    String(entry.paidQuotaRisk),
    entry.topFiles.slice(0, 4).map((file) => `\`${file.file}\` (${file.priority})`).join('<br>') || '-',
  ]);
  const fileRows = report.files.map((file) => [
    file.priority,
    `\`${file.file}\``,
    file.surface,
    file.lane,
    file.ownerTokenNeeded ? 'yes' : 'no',
    file.paidQuotaRisk ? 'yes' : 'no',
    file.nextProof,
  ]);
  return [
    '# Neo Runtime Proof Non-Route Plan',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- backlog files: ${report.summary.backlogFiles}`,
    `- protected GET surface files: ${report.summary.protectedGetSurfaceFiles}`,
    `- uncovered files: ${report.summary.uncoveredFiles}`,
    `- no-route-importer files: ${report.summary.noRouteImporterFiles}`,
    `- route-importer-without-safe-GET files: ${report.summary.routeImporterWithoutSafeGetFiles}`,
    `- lanes: ${report.summary.lanes}`,
    `- owner-token needed for next proof: ${report.summary.ownerTokenNeeded}`,
    `- live panel needed for next proof: ${report.summary.livePanelNeeded}`,
    `- paid quota risk if run live: ${report.summary.paidQuotaRisk}`,
    '',
    '## By Priority',
    '',
    mdTable([
      ['priority', 'files', 'lanes', 'owner token needed', 'live panel needed', 'paid quota risk'],
      ['---', '---:', '---', '---:', '---:', '---:'],
      ...priorityRows,
    ]),
    '',
    '## By Proof Lane',
    '',
    mdTable([
      ['lane', 'files', 'priorities', 'owner token needed', 'live panel needed', 'paid quota risk', 'top files'],
      ['---', '---:', '---', '---:', '---:', '---:', '---'],
      ...laneRows,
    ]),
    '',
    '## Files',
    '',
    mdTable([
      ['priority', 'file', 'surface', 'lane', 'owner token', 'paid risk', 'next proof'],
      ['---', '---', '---', '---', '---', '---', '---'],
      ...fileRows,
    ]),
    '',
    '## Interpretation',
    '',
    '- This plan starts where the protected GET auth-surface matrix stops. It does not prove live execution by itself.',
    '- Provider/model lanes are marked with quota/network risk so they are not run as hidden paid calls. Prefer mocked probes unless the owner explicitly authorizes live provider checks.',
    '- Local drill lanes should use temp files, fake stores, fake spawn/fetch, and count/digest summaries only.',
    '',
    '## JSON',
    '',
    `Full plan is in \`${jsonPath.replace(`${ROOT}/`, '')}\`. It stores file paths, lanes, counts, and next-proof labels only.`,
  ].join('\n');
}

function writeReport(report) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${OUT_BASE}.json`);
  const mdPath = join(OUT_DIR, `${OUT_BASE}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mdPath, `${renderMarkdown(report, jsonPath)}\n`, { mode: 0o600 });
  return { jsonPath, mdPath };
}

export function buildNonRouteProofPlan({
  matrixPath = MATRIX_PATH,
  inventoryPath = INVENTORY_PATH,
  backlogPath = BACKLOG_PATH,
} = {}) {
  if (!existsSync(matrixPath)) throw new Error(`auth surface matrix not found: ${matrixPath}`);
  if (!existsSync(inventoryPath)) throw new Error(`inventory not found: ${inventoryPath}`);
  if (!existsSync(backlogPath)) throw new Error(`runtime-proof backlog not found: ${backlogPath}`);
  return buildPlan({
    matrix: readJson(matrixPath),
    inventory: readJson(inventoryPath),
    backlog: readJson(backlogPath),
  });
}

export {
  laneFor,
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = buildNonRouteProofPlan();
  const paths = writeReport(report);
  console.log(JSON.stringify({
    ok: true,
    generatedAt: report.generatedAt,
    uncoveredFiles: report.summary.uncoveredFiles,
    lanes: report.summary.lanes,
    ownerTokenNeeded: report.summary.ownerTokenNeeded,
    livePanelNeeded: report.summary.livePanelNeeded,
    paidQuotaRisk: report.summary.paidQuotaRisk,
    paths,
  }, null, 2));
}
