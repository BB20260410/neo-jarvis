#!/usr/bin/env node
// @ts-check
// Split the remaining weak runtime/support queue into concrete proof lanes.
// Read-only: consumes weak-review and weak-route probe summaries plus route
// signatures. It does not read env files, owner tokens, DBs, or response bodies.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.NOE_WEAK_RUNTIME_REMAINING_LANE_OUT_DIR || join(ROOT, 'output', 'noe-audit');
const OUT_BASE = process.env.NOE_WEAK_RUNTIME_REMAINING_LANE_BASENAME || 'weak-runtime-remaining-lane-audit-2026-06-15';

const DEFAULT_PATHS = {
  weakRuntimeSupportReview: join(ROOT, 'output', 'noe-audit', 'weak-runtime-support-review-2026-06-15.json'),
  weakRouteSurfaceProbe: join(ROOT, 'output', 'noe-audit', 'weak-route-surface-probe-2026-06-15.json'),
  weakRouteTargetedLocalDrills: join(ROOT, 'output', 'noe-audit', 'weak-route-targeted-local-drills-2026-06-15.json'),
  weakTargetedLocalDrills: join(ROOT, 'output', 'noe-audit', 'weak-targeted-local-drills-2026-06-15.json'),
  weakServerTargetedLocalDrills: join(ROOT, 'output', 'noe-audit', 'weak-server-targeted-local-drills-2026-06-15.json'),
  naturalRuntimeEvidenceAudit: join(ROOT, 'output', 'noe-audit', 'natural-runtime-evidence-audit-2026-06-15.json'),
};

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '', max = 240) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function uniq(values = []) {
  return [...new Set(values.filter(Boolean).map((value) => String(value)))].sort();
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

function routeAuthSpecs(text = '') {
  const specs = [];
  const re = /\b(?:app|router)\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]\s*,\s*requireOwnerToken\b/g;
  for (const match of String(text || '').matchAll(re)) {
    const method = String(match[1] || '').toUpperCase();
    const path = String(match[2] || '').trim();
    if (!method || !path) continue;
    specs.push({
      method,
      path,
      dynamic: path.includes(':') || path.includes('*'),
      safeNoTokenProbe: method === 'GET' && !path.includes(':') && !path.includes('*'),
      mutating: method !== 'GET',
    });
  }
  return specs.sort((a, b) => a.method.localeCompare(b.method) || a.path.localeCompare(b.path));
}

function routeAuthSurfaceFor({ root = ROOT, routeFiles = [] } = {}) {
  const map = new Map();
  for (const routeFile of uniq(routeFiles)) {
    let text = '';
    try { text = readFileSync(join(root, routeFile), 'utf8'); } catch { text = ''; }
    const specs = routeAuthSpecs(text);
    map.set(routeFile, {
      routeFile,
      protectedRouteCount: specs.length,
      protectedStaticGetCount: specs.filter((spec) => spec.safeNoTokenProbe).length,
      protectedDynamicGetCount: specs.filter((spec) => spec.method === 'GET' && spec.dynamic).length,
      protectedMutatingCount: specs.filter((spec) => spec.mutating).length,
      methods: uniq(specs.map((spec) => spec.method)),
      sampleProtectedPaths: specs.slice(0, 8).map((spec) => `${spec.method} ${spec.path}`),
    });
  }
  return map;
}

function hasLiveAuthSurface(routeProbeFile = {}) {
  return arr(routeProbeFile.liveProtectedGetProbes).some((probe) => probe.statusKind === 'route_live_auth_protected');
}

function laneForRoute({ weakFile: _weakFile = {}, routeProbeFile = {}, routeAuth = [] } = {}) {
  if (hasLiveAuthSurface(routeProbeFile)) {
    return {
      lane: 'route_live_auth_surface_business_pending',
      proofStrength: 'medium',
      remainingNeed: 'owner-authorized business summary, handler-level local drill, or natural invocation evidence; do not infer imported dependency execution from route 401',
      ownerDecisionNeeded: true,
      naturalRuntimeNeeded: false,
      targetedProbeNeeded: true,
    };
  }
  const protectedMutatingCount = routeAuth.reduce((sum, item) => sum + item.protectedMutatingCount, 0);
  const protectedDynamicGetCount = routeAuth.reduce((sum, item) => sum + item.protectedDynamicGetCount, 0);
  const protectedRouteCount = routeAuth.reduce((sum, item) => sum + item.protectedRouteCount, 0);
  if (protectedMutatingCount > 0 || protectedDynamicGetCount > 0) {
    return {
      lane: 'route_has_protected_surface_but_no_safe_get_probe',
      proofStrength: 'weak_actionable',
      remainingNeed: 'do not live-probe mutating routes without explicit authorization; use local handler drill, owner-authorized readonly summary, or natural invocation evidence',
      ownerDecisionNeeded: true,
      naturalRuntimeNeeded: false,
      targetedProbeNeeded: true,
    };
  }
  if (protectedRouteCount > 0) {
    return {
      lane: 'route_protected_surface_unclassified',
      proofStrength: 'weak_actionable',
      remainingNeed: 'inspect route signature and add a safe proof lane',
      ownerDecisionNeeded: false,
      naturalRuntimeNeeded: false,
      targetedProbeNeeded: true,
    };
  }
  return {
    lane: 'route_importer_without_detected_owner_surface',
    proofStrength: 'weak',
    remainingNeed: 'confirm support-only import or add route/handler-level proof',
    ownerDecisionNeeded: false,
    naturalRuntimeNeeded: false,
    targetedProbeNeeded: true,
  };
}

function laneForServer(weakFile = {}) {
  const importers = arr(weakFile.sourceImporters);
  const serviceImporters = arr(weakFile.serviceImporters);
  if (serviceImporters.length || importers.some((file) => file.startsWith('src/server/services/'))) {
    return {
      lane: 'server_service_chain_managed_smoke_needed',
      proofStrength: 'weak_actionable',
      remainingNeed: 'managed local smoke through service runner with fake process/client, or natural job evidence after runtime cadence',
      ownerDecisionNeeded: false,
      naturalRuntimeNeeded: true,
      targetedProbeNeeded: true,
    };
  }
  if (importers.includes('server.js') || weakFile.serverImported) {
    return {
      lane: 'server_boot_imported_natural_runtime_needed',
      proofStrength: 'weak_actionable',
      remainingNeed: 'server import proves boot wiring only; collect natural runtime counter/status, managed smoke, or readonly status summary',
      ownerDecisionNeeded: false,
      naturalRuntimeNeeded: true,
      targetedProbeNeeded: true,
    };
  }
  return {
    lane: 'server_candidate_import_chain_unclear',
    proofStrength: 'weak',
    remainingNeed: 'inspect importer chain and add a managed smoke or support-only decision',
    ownerDecisionNeeded: false,
    naturalRuntimeNeeded: true,
    targetedProbeNeeded: true,
  };
}

function laneForChain(weakFile = {}) {
  const file = String(weakFile.file || '');
  if (file.includes('/secrets/')) {
    return {
      lane: 'credential_boundary_targeted_probe_no_secret_read',
      proofStrength: 'weak_actionable',
      remainingNeed: 'test broker contract with fake keychain/secret provider; do not read real secrets',
      ownerDecisionNeeded: false,
      naturalRuntimeNeeded: false,
      targetedProbeNeeded: true,
    };
  }
  if (file.includes('NoeHostExecEnv')) {
    return {
      lane: 'host_exec_boundary_targeted_probe_needed',
      proofStrength: 'weak_actionable',
      remainingNeed: 'run targeted no-side-effect host-exec environment drill through fake executor context',
      ownerDecisionNeeded: false,
      naturalRuntimeNeeded: false,
      targetedProbeNeeded: true,
    };
  }
  if (file.includes('Voiceprint')) {
    return {
      lane: 'sensor_identity_runtime_probe_needed',
      proofStrength: 'weak_actionable',
      remainingNeed: 'use fixture audio/vector drill or natural voice session evidence; do not require microphone/live capture here',
      ownerDecisionNeeded: false,
      naturalRuntimeNeeded: true,
      targetedProbeNeeded: true,
    };
  }
  if (file.includes('atomicJsonFile')) {
    return {
      lane: 'shared_persistence_utility_tempfile_drill_needed',
      proofStrength: 'weak_actionable',
      remainingNeed: 'temp-directory atomic write/read/failure drill through importer chain',
      ownerDecisionNeeded: false,
      naturalRuntimeNeeded: false,
      targetedProbeNeeded: true,
    };
  }
  return {
    lane: 'runtime_chain_targeted_probe_needed',
    proofStrength: 'weak_actionable',
    remainingNeed: 'targeted runtime probe through importer chain',
    ownerDecisionNeeded: false,
    naturalRuntimeNeeded: true,
    targetedProbeNeeded: true,
  };
}

function laneForManual(_weakFile = {}) {
  return {
    lane: 'isolated_tested_support_manual_review_needed',
    proofStrength: 'support_pending',
    remainingNeed: 'confirm intentionally unimported support/test utility or wire into runtime if it is expected live',
    ownerDecisionNeeded: false,
    naturalRuntimeNeeded: false,
    targetedProbeNeeded: false,
  };
}

function buildFileEntry({ weakFile, routeProbeMap, routeAuthMap, routeDrillMap, targetedDrillMap, serverDrillMap, naturalEvidenceMap }) {
  const routeAuth = arr(weakFile.routeImporters).map((routeFile) => routeAuthMap.get(routeFile) || {
    routeFile,
    protectedRouteCount: 0,
    protectedStaticGetCount: 0,
    protectedDynamicGetCount: 0,
    protectedMutatingCount: 0,
    methods: [],
    sampleProtectedPaths: [],
  });
  let lane = null;
  if (weakFile.reviewClass === 'route_imported_runtime_candidate') {
    lane = laneForRoute({
      weakFile,
      routeProbeFile: routeProbeMap.get(weakFile.file) || {},
      routeAuth,
    });
  } else if (weakFile.reviewClass === 'server_imported_runtime_candidate') {
    lane = laneForServer(weakFile);
  } else if (weakFile.reviewClass === 'runtime_chain_imported_candidate') {
    lane = laneForChain(weakFile);
  } else if (weakFile.supportDecision === 'support_role_likely_manual_review' || weakFile.supportDecision === 'manual_review_or_probe_needed') {
    lane = laneForManual(weakFile);
  } else {
    return null;
  }
  return {
    file: weakFile.file,
    module: clean(weakFile.module || '', 120),
    lines: Number(weakFile.lines) || 0,
    reviewClass: weakFile.reviewClass,
    supportDecision: weakFile.supportDecision,
    lane: lane.lane,
    proofStrength: lane.proofStrength,
    remainingNeed: lane.remainingNeed,
    ownerDecisionNeeded: lane.ownerDecisionNeeded,
    naturalRuntimeNeeded: lane.naturalRuntimeNeeded,
    targetedProbeNeeded: lane.targetedProbeNeeded,
    routeImporters: arr(weakFile.routeImporters),
    sourceImporters: arr(weakFile.sourceImporters).slice(0, 12),
    serviceImporters: arr(weakFile.serviceImporters).slice(0, 12),
    routeAuth,
    liveAuthSurface: hasLiveAuthSurface(routeProbeMap.get(weakFile.file) || {}),
    routeTargetedLocalDrillStatus: clean(routeDrillMap.get(weakFile.file)?.drillStatus || '', 80),
    targetedLocalDrillStatus: clean(targetedDrillMap.get(weakFile.file)?.drillStatus || '', 80),
    serverTargetedLocalDrillStatus: clean(serverDrillMap.get(weakFile.file)?.drillStatus || '', 80),
    naturalRuntimeEvidenceStatus: clean(naturalEvidenceMap.get(weakFile.file)?.naturalEvidenceStatus || '', 100),
    testCount: Number(weakFile.testCount) || 0,
    testImporterCount: Number(weakFile.testImporterCount) || 0,
  };
}

export function buildNoeWeakRuntimeRemainingLaneAudit({
  root = ROOT,
  paths = DEFAULT_PATHS,
  now = new Date(),
} = {}) {
  const resolvedPaths = { ...DEFAULT_PATHS, ...paths };
  const weakReview = readJson(resolvedPaths.weakRuntimeSupportReview);
  const routeProbe = readJson(resolvedPaths.weakRouteSurfaceProbe);
  const routeTargetedDrills = readJson(resolvedPaths.weakRouteTargetedLocalDrills);
  const targetedDrills = readJson(resolvedPaths.weakTargetedLocalDrills);
  const serverTargetedDrills = readJson(resolvedPaths.weakServerTargetedLocalDrills);
  const naturalRuntimeEvidence = readJson(resolvedPaths.naturalRuntimeEvidenceAudit);
  const routeProbeMap = mapByFile(routeProbe.files);
  const routeDrillMap = mapByFile(routeTargetedDrills.files);
  const targetedDrillMap = mapByFile(targetedDrills.files);
  const serverDrillMap = mapByFile(serverTargetedDrills.files);
  const naturalEvidenceMap = mapByFile(naturalRuntimeEvidence.files);
  const routeFiles = uniq(arr(weakReview.files).flatMap((file) => arr(file.routeImporters)));
  const routeAuthMap = routeAuthSurfaceFor({ root, routeFiles });
  const files = arr(weakReview.files)
    .map((weakFile) => buildFileEntry({ weakFile, routeProbeMap, routeAuthMap, routeDrillMap, targetedDrillMap, serverDrillMap, naturalEvidenceMap }))
    .filter(Boolean)
    .sort((a, b) => {
      const order = {
        route_live_auth_surface_business_pending: 0,
        route_has_protected_surface_but_no_safe_get_probe: 1,
        server_boot_imported_natural_runtime_needed: 2,
        server_service_chain_managed_smoke_needed: 3,
        runtime_chain_targeted_probe_needed: 4,
        isolated_tested_support_manual_review_needed: 5,
      };
      return (order[a.lane] ?? 20) - (order[b.lane] ?? 20)
        || b.lines - a.lines
        || a.file.localeCompare(b.file);
    });

  const laneCounts = {};
  const proofStrengthCounts = {};
  const reviewClassCounts = {};
  const drillStatusCounts = {};
  const routeDrillStatusCounts = {};
  const serverDrillStatusCounts = {};
  const naturalEvidenceStatusCounts = {};
  const byModule = {};
  for (const file of files) {
    inc(laneCounts, file.lane);
    inc(proofStrengthCounts, file.proofStrength);
    inc(reviewClassCounts, file.reviewClass);
    if (file.routeTargetedLocalDrillStatus) inc(routeDrillStatusCounts, file.routeTargetedLocalDrillStatus);
    if (file.targetedLocalDrillStatus) inc(drillStatusCounts, file.targetedLocalDrillStatus);
    if (file.serverTargetedLocalDrillStatus) inc(serverDrillStatusCounts, file.serverTargetedLocalDrillStatus);
    if (file.naturalRuntimeEvidenceStatus) inc(naturalEvidenceStatusCounts, file.naturalRuntimeEvidenceStatus);
    if (!byModule[file.module]) byModule[file.module] = { module: file.module, files: 0, lines: 0, laneCounts: {} };
    byModule[file.module].files += 1;
    byModule[file.module].lines += file.lines;
    inc(byModule[file.module].laneCounts, file.lane);
  }

  return {
    ok: true,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    root: weakReview.root || routeProbe.root || root,
    inputs: {
      weakRuntimeSupportReview: rel(resolvedPaths.weakRuntimeSupportReview),
      weakRuntimeSupportReviewGeneratedAt: weakReview.generatedAt || '',
      weakRouteSurfaceProbe: rel(resolvedPaths.weakRouteSurfaceProbe),
      weakRouteSurfaceProbeGeneratedAt: routeProbe.generatedAt || '',
      weakRouteSurfaceProbeMode: routeProbe.mode || '',
      weakRouteTargetedLocalDrills: rel(resolvedPaths.weakRouteTargetedLocalDrills),
      weakRouteTargetedLocalDrillsGeneratedAt: routeTargetedDrills.generatedAt || '',
      weakTargetedLocalDrills: rel(resolvedPaths.weakTargetedLocalDrills),
      weakTargetedLocalDrillsGeneratedAt: targetedDrills.generatedAt || '',
      weakServerTargetedLocalDrills: rel(resolvedPaths.weakServerTargetedLocalDrills),
      weakServerTargetedLocalDrillsGeneratedAt: serverTargetedDrills.generatedAt || '',
      naturalRuntimeEvidenceAudit: rel(resolvedPaths.naturalRuntimeEvidenceAudit),
      naturalRuntimeEvidenceAuditGeneratedAt: naturalRuntimeEvidence.generatedAt || '',
    },
    policy: {
      readOnlyAudit: true,
      noEnvFileReads: true,
      noOwnerTokenReads: true,
      noProtectedApiAuth: true,
      noDbReads: true,
      noModelCalls: true,
      noNetworkCalls: true,
      noLiveMutatingRequests: true,
      noResponseBodiesStored: true,
      noSourceBodiesReturned: true,
      noSecretValuesReturned: true,
    },
    status: {
      audit: 'weak_runtime_remaining_lanes_split',
      completionClaim: 'not_complete',
      explanation: 'Remaining weak runtime files are split into route business proof, protected mutating route, server natural/runtime, service managed-smoke, chain targeted-probe, and manual support-review lanes.',
    },
    summary: {
      weakRuntimeFiles: Number(weakReview.summary?.weakFiles || 0),
      weakRuntimeProbeNeeded: Number(weakReview.summary?.runtimeProbeNeeded || 0),
      actionableFiles: files.length,
      routeCandidates: files.filter((file) => file.reviewClass === 'route_imported_runtime_candidate').length,
      routeLiveAuthSurfaceBusinessPending: files.filter((file) => file.lane === 'route_live_auth_surface_business_pending').length,
      routeNoSafeGetFiles: files.filter((file) => file.lane === 'route_has_protected_surface_but_no_safe_get_probe').length,
      routeTargetedDrilledOk: files.filter((file) => file.reviewClass === 'route_imported_runtime_candidate' && file.routeTargetedLocalDrillStatus === 'drilled_ok').length,
      routeLiveAuthSurfaceTargetedDrilledOk: files.filter((file) => file.liveAuthSurface && file.routeTargetedLocalDrillStatus === 'drilled_ok').length,
      routeNoSafeGetTargetedDrilledOk: files.filter((file) => file.lane === 'route_has_protected_surface_but_no_safe_get_probe' && file.routeTargetedLocalDrillStatus === 'drilled_ok').length,
      routeProtectedBusinessProofStillNeeded: routeTargetedDrills.summary?.protectedBusinessProofStillNeeded ?? files.filter((file) => file.reviewClass === 'route_imported_runtime_candidate').length,
      serverCandidates: files.filter((file) => file.reviewClass === 'server_imported_runtime_candidate').length,
      serverBootImported: files.filter((file) => file.lane === 'server_boot_imported_natural_runtime_needed').length,
      serverServiceChain: files.filter((file) => file.lane === 'server_service_chain_managed_smoke_needed').length,
      serverTargetedDrilledOk: files.filter((file) => file.reviewClass === 'server_imported_runtime_candidate' && file.serverTargetedLocalDrillStatus === 'drilled_ok').length,
      serverBootTargetedDrilledOk: files.filter((file) => file.lane === 'server_boot_imported_natural_runtime_needed' && file.serverTargetedLocalDrillStatus === 'drilled_ok').length,
      serverServiceChainTargetedDrilledOk: files.filter((file) => file.lane === 'server_service_chain_managed_smoke_needed' && file.serverTargetedLocalDrillStatus === 'drilled_ok').length,
      serverNaturalRuntimeStillNeeded: files.filter((file) => file.reviewClass === 'server_imported_runtime_candidate' && file.naturalRuntimeNeeded).length,
      chainCandidates: files.filter((file) => file.reviewClass === 'runtime_chain_imported_candidate').length,
      chainTargetedDrilledOk: files.filter((file) => file.reviewClass === 'runtime_chain_imported_candidate' && file.targetedLocalDrillStatus === 'drilled_ok').length,
      manualSupportReviewFiles: files.filter((file) => file.lane === 'isolated_tested_support_manual_review_needed').length,
      manualSupportDrilledOk: files.filter((file) => file.lane === 'isolated_tested_support_manual_review_needed' && file.targetedLocalDrillStatus === 'drilled_ok').length,
      manualSupportSkippedByPolicy: files.filter((file) => file.lane === 'isolated_tested_support_manual_review_needed' && file.targetedLocalDrillStatus === 'skipped_by_policy').length,
      ownerDecisionNeededFiles: files.filter((file) => file.ownerDecisionNeeded).length,
      naturalRuntimeNeededFiles: files.filter((file) => file.naturalRuntimeNeeded).length,
      naturalRuntimeDirectEvidenceFiles: files.filter((file) => file.naturalRuntimeNeeded && file.naturalRuntimeEvidenceStatus === 'direct_structured_runtime_evidence').length,
      naturalRuntimeIndirectSignalFiles: files.filter((file) => file.naturalRuntimeNeeded && file.naturalRuntimeEvidenceStatus === 'indirect_structured_runtime_signal').length,
      naturalRuntimeMissingEvidenceFiles: files.filter((file) => file.naturalRuntimeNeeded && file.naturalRuntimeEvidenceStatus === 'missing_structured_runtime_evidence').length,
      naturalRuntimeProofStillNeeded: naturalRuntimeEvidence.summary?.naturalRuntimeProofStillNeeded ?? files.filter((file) => file.naturalRuntimeNeeded).length,
      targetedProbeNeededFiles: files.filter((file) => file.targetedProbeNeeded).length,
      postDrillTargetedProbeNeededFiles: files.filter((file) => file.targetedProbeNeeded && file.targetedLocalDrillStatus !== 'drilled_ok' && file.serverTargetedLocalDrillStatus !== 'drilled_ok').length,
      componentContractDrilledOk: files.filter((file) => file.targetedLocalDrillStatus === 'drilled_ok' || file.serverTargetedLocalDrillStatus === 'drilled_ok').length,
      laneCounts,
      proofStrengthCounts,
      reviewClassCounts,
      drillStatusCounts,
      routeDrillStatusCounts,
      serverDrillStatusCounts,
      naturalEvidenceStatusCounts,
    },
    byModule: Object.values(byModule).sort((a, b) => b.lines - a.lines || b.files - a.files || a.module.localeCompare(b.module)),
    files,
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
    topCounts(item.laneCounts, 4),
  ]);
  const fileRows = report.files.slice(0, 140).map((file) => [
    `\`${file.file}\``,
    file.reviewClass,
    file.lane,
    file.liveAuthSurface ? 'yes' : '',
    file.ownerDecisionNeeded ? 'yes' : '',
    file.naturalRuntimeNeeded ? 'yes' : '',
    file.targetedProbeNeeded ? 'yes' : '',
    file.naturalRuntimeEvidenceStatus || '-',
    file.routeTargetedLocalDrillStatus || '-',
    file.targetedLocalDrillStatus || '-',
    file.serverTargetedLocalDrillStatus || '-',
    clean(file.remainingNeed, 180),
  ]);
  return [
    '# Noe Weak Runtime Remaining Lane Audit',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Verdict',
    '',
    `- audit: \`${report.status.audit}\``,
    `- completion claim: \`${report.status.completionClaim}\``,
    `- explanation: ${report.status.explanation}`,
    '',
    '## Summary',
    '',
    `- actionable files: ${report.summary.actionableFiles}`,
    `- route live auth business pending: ${report.summary.routeLiveAuthSurfaceBusinessPending}; route no-safe-GET files: ${report.summary.routeNoSafeGetFiles}`,
    `- route import contract drilled ok: ${report.summary.routeTargetedDrilledOk}/${report.summary.routeCandidates}; route protected business proof still needed: ${report.summary.routeProtectedBusinessProofStillNeeded}`,
    `- server candidates: ${report.summary.serverCandidates}; server boot imported: ${report.summary.serverBootImported}; service chain: ${report.summary.serverServiceChain}`,
    `- server targeted drilled ok: ${report.summary.serverTargetedDrilledOk}; server natural runtime still needed: ${report.summary.serverNaturalRuntimeStillNeeded}`,
    `- chain candidates: ${report.summary.chainCandidates}; chain targeted drilled ok: ${report.summary.chainTargetedDrilledOk}`,
    `- manual support review files: ${report.summary.manualSupportReviewFiles}; manual drilled ok: ${report.summary.manualSupportDrilledOk}; manual skipped by policy: ${report.summary.manualSupportSkippedByPolicy}`,
    `- owner decision needed: ${report.summary.ownerDecisionNeededFiles}; natural runtime needed: ${report.summary.naturalRuntimeNeededFiles}; targeted probe needed: ${report.summary.targetedProbeNeededFiles}; post-drill targeted probe needed: ${report.summary.postDrillTargetedProbeNeededFiles}`,
    `- natural runtime evidence: direct ${report.summary.naturalRuntimeDirectEvidenceFiles}; indirect ${report.summary.naturalRuntimeIndirectSignalFiles}; missing ${report.summary.naturalRuntimeMissingEvidenceFiles}; proof still needed ${report.summary.naturalRuntimeProofStillNeeded}`,
    `- component contract drilled ok: ${report.summary.componentContractDrilledOk}`,
    `- lanes: ${topCounts(report.summary.laneCounts, 10)}`,
    '',
    '## By Module',
    '',
    mdTable([
      ['module', 'files', 'lines', 'lanes'],
      ['---', '---:', '---:', '---'],
      ...moduleRows,
    ]),
    '',
    '## Files',
    '',
    mdTable([
      ['file', 'review class', 'lane', 'live auth surface', 'owner decision', 'natural runtime', 'targeted probe', 'natural evidence', 'route drill', 'chain/manual drill', 'server drill', 'remaining need'],
      ['---', '---', '---', '---', '---', '---', '---', '---', '---', '---', '---', '---'],
      ...fileRows,
    ]),
    '',
    '## Interpretation',
    '',
    '- `route_live_auth_surface_business_pending` means a no-token GET proved route/auth registration. It does not prove the imported dependency ran.',
    '- `route_has_protected_surface_but_no_safe_get_probe` means the route has protected mutating or contextual surfaces; this audit deliberately did not send live POST/PUT/DELETE requests.',
    '- `routeTargetedLocalDrillStatus=drilled_ok` proves the route dependency import/export contract only; protected business proof remains separate.',
    '- Server and chain lanes remain incomplete until a managed smoke, natural runtime event, or targeted no-side-effect drill produces evidence.',
    '- `targetedLocalDrillStatus=drilled_ok` proves a local component contract, not natural live-panel invocation.',
    '- `serverTargetedLocalDrillStatus=drilled_ok` proves a server/service component contract under isolated temp HOME; natural runtime evidence remains separate.',
    '- `naturalRuntimeEvidenceStatus` is direct only when a structured runtime counter/status/recent timestamp is module-specific; indirect signals do not reduce the proof gap.',
    '',
    '## JSON',
    '',
    jsonPath ? `Full report: \`${jsonPath.replace(`${ROOT}/`, '')}\`.` : 'No JSON path supplied.',
  ].join('\n');
}

export function writeNoeWeakRuntimeRemainingLaneAudit(report) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${OUT_BASE}.json`);
  const mdPath = join(OUT_DIR, `${OUT_BASE}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mdPath, `${renderMarkdown(report, jsonPath)}\n`, { mode: 0o600 });
  return { jsonPath, mdPath };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = buildNoeWeakRuntimeRemainingLaneAudit();
  const paths = writeNoeWeakRuntimeRemainingLaneAudit(report);
  console.log(JSON.stringify({
    ok: report.ok,
    audit: report.status.audit,
    actionableFiles: report.summary.actionableFiles,
    routeLiveAuthSurfaceBusinessPending: report.summary.routeLiveAuthSurfaceBusinessPending,
    routeNoSafeGetFiles: report.summary.routeNoSafeGetFiles,
    routeTargetedDrilledOk: report.summary.routeTargetedDrilledOk,
    routeProtectedBusinessProofStillNeeded: report.summary.routeProtectedBusinessProofStillNeeded,
    serverCandidates: report.summary.serverCandidates,
    serverTargetedDrilledOk: report.summary.serverTargetedDrilledOk,
    serverNaturalRuntimeStillNeeded: report.summary.serverNaturalRuntimeStillNeeded,
    naturalRuntimeDirectEvidenceFiles: report.summary.naturalRuntimeDirectEvidenceFiles,
    naturalRuntimeIndirectSignalFiles: report.summary.naturalRuntimeIndirectSignalFiles,
    naturalRuntimeMissingEvidenceFiles: report.summary.naturalRuntimeMissingEvidenceFiles,
    naturalRuntimeProofStillNeeded: report.summary.naturalRuntimeProofStillNeeded,
    chainCandidates: report.summary.chainCandidates,
    chainTargetedDrilledOk: report.summary.chainTargetedDrilledOk,
    manualSupportReviewFiles: report.summary.manualSupportReviewFiles,
    postDrillTargetedProbeNeededFiles: report.summary.postDrillTargetedProbeNeededFiles,
    paths,
  }, null, 2));
}
