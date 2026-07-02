#!/usr/bin/env node
// @ts-check
// Import-only local drills for weak route dependency candidates.
// This does not call route handlers or protected APIs. It imports each candidate
// in an isolated temp-HOME subprocess and records exported contract metadata.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.NOE_WEAK_ROUTE_TARGETED_DRILLS_OUT_DIR || join(ROOT, 'output', 'noe-audit');
const OUT_BASE = process.env.NOE_WEAK_ROUTE_TARGETED_DRILLS_BASENAME || 'weak-route-targeted-local-drills-2026-06-15';

const DEFAULT_PATHS = {
  weakRuntimeRemainingLaneAudit: join(ROOT, 'output', 'noe-audit', 'weak-runtime-remaining-lane-audit-2026-06-15.json'),
};

const RISK_PATTERNS = [
  ['fetch', /\bfetch\s*\(/],
  ['spawn', /\bspawn\s*\(/],
  ['exec', /\bexec(?:File)?\s*\(/],
  ['timer', /\bset(?:Timeout|Interval)\s*\(/],
  ['db', /\bgetDb\s*\(/],
  ['env_load', /\bprocess\.loadEnvFile\s*\(/],
];

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function readJson(path) {
  if (!path || !existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

function rel(path) {
  return String(path || '').replace(`${ROOT}/`, '');
}

function clean(value = '', max = 240) {
  return String(value ?? '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [key]')
    .replace(/token[=:]\S+/gi, 'token=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function inc(counts, key, amount = 1) {
  counts[key] = (counts[key] || 0) + amount;
}

function topLevelRiskSignals(text = '') {
  return RISK_PATTERNS
    .filter(([, re]) => re.test(text))
    .map(([name]) => name);
}

function okFile(file, lane, evidence = {}, remainingNeed = '') {
  return {
    file,
    lane,
    drillStatus: 'drilled_ok',
    evidence,
    remainingNeed,
  };
}

function failedFile(file, lane, reason = '', evidence = {}, remainingNeed = '') {
  return {
    file,
    lane,
    drillStatus: 'failed',
    evidence: {
      ...evidence,
      reason: clean(reason, 400),
    },
    remainingNeed,
  };
}

function childEnv(tempHome, tempRoot) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: tempHome,
    TMPDIR: tempRoot,
    NODE_ENV: 'test',
    NOE_WEAK_ROUTE_DRILL: '1',
  };
}

function targetFilesFromLaneAudit(laneAudit = {}) {
  return arr(laneAudit.files).filter((file) => file.reviewClass === 'route_imported_runtime_candidate');
}

function routeCounts(target = {}) {
  const auth = arr(target.routeAuth);
  return {
    routeImporterCount: arr(target.routeImporters).length,
    protectedRouteCount: auth.reduce((sum, route) => sum + Number(route.protectedRouteCount || 0), 0),
    protectedStaticGetCount: auth.reduce((sum, route) => sum + Number(route.protectedStaticGetCount || 0), 0),
    protectedDynamicGetCount: auth.reduce((sum, route) => sum + Number(route.protectedDynamicGetCount || 0), 0),
    protectedMutatingCount: auth.reduce((sum, route) => sum + Number(route.protectedMutatingCount || 0), 0),
  };
}

function runImportDrill({ root, target, tempRoot }) {
  const file = String(target.file || '');
  const lane = String(target.lane || 'route_imported_runtime_candidate');
  const abs = join(root, file);
  let sourceText = '';
  try {
    sourceText = readFileSync(abs, 'utf8');
  } catch (error) {
    return failedFile(file, lane, error?.message || error, { sourceReadable: false }, 'source file must be readable before route dependency contract can be audited');
  }
  const risks = topLevelRiskSignals(sourceText);
  const runDir = mkdtempSync(join(tempRoot, 'route-run-'));
  const home = mkdtempSync(join(tempRoot, 'route-home-'));
  const moduleUrl = pathToFileURL(abs).href;
  const code = `
    const blockedFetchCalls = [];
    globalThis.fetch = async (...args) => {
      blockedFetchCalls.push(String(args[0] || ''));
      throw new Error('fetch blocked by weak route import drill');
    };
    const mod = await import(${JSON.stringify(moduleUrl)});
    const exportKeys = Object.keys(mod).sort();
    console.log(JSON.stringify({
      imported: true,
      exportCount: exportKeys.length,
      exportKeys: exportKeys.slice(0, 16),
      defaultExport: Object.prototype.hasOwnProperty.call(mod, 'default'),
      blockedFetchCalls: blockedFetchCalls.length,
    }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
    cwd: root,
    env: childEnv(home, runDir),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
  });
  const baseEvidence = {
    isolatedHome: true,
    tempOnly: true,
    sourceReadable: true,
    topLevelRiskSignals: risks,
    testCount: Number(target.testCount || 0),
    testImporterCount: Number(target.testImporterCount || 0),
    liveAuthSurface: target.liveAuthSurface === true,
    ...routeCounts(target),
  };
  if (result.error) {
    return failedFile(file, lane, result.error.message, baseEvidence, 'fix import side effect or add module-specific safe drill');
  }
  if (result.status !== 0) {
    return failedFile(file, lane, result.stderr || result.stdout || `exit ${result.status}`, {
      ...baseEvidence,
      exitStatus: result.status,
    }, 'fix import side effect or add module-specific safe drill');
  }
  try {
    const imported = JSON.parse(String(result.stdout || '').trim() || '{}');
    return okFile(file, lane, {
      ...baseEvidence,
      imported: imported.imported === true,
      exportCount: Number(imported.exportCount || 0),
      exportKeys: arr(imported.exportKeys).slice(0, 16),
      defaultExport: imported.defaultExport === true,
      blockedFetchCalls: Number(imported.blockedFetchCalls || 0),
    }, 'route dependency import contract drilled locally; protected business proof still needs owner-authorized readonly summary or natural route evidence');
  } catch (error) {
    return failedFile(file, lane, `invalid drill json: ${error?.message || error}`, {
      ...baseEvidence,
      stdout: clean(result.stdout, 400),
    }, 'fix drill output before relying on this proof');
  }
}

export function buildNoeWeakRouteTargetedLocalDrills({
  root = ROOT,
  paths = DEFAULT_PATHS,
  now = new Date(),
  keepTemp = false,
} = {}) {
  const resolvedPaths = { ...DEFAULT_PATHS, ...paths };
  const laneAudit = readJson(resolvedPaths.weakRuntimeRemainingLaneAudit);
  const targets = targetFilesFromLaneAudit(laneAudit);
  const tempRoot = mkdtempSync(join(tmpdir(), 'noe-weak-route-drills-'));
  const files = [];
  try {
    for (const target of targets) {
      files.push(runImportDrill({ root, target, tempRoot }));
    }
  } finally {
    if (!keepTemp) rmSync(tempRoot, { recursive: true, force: true });
  }

  const statusCounts = {};
  const laneCounts = {};
  const riskSignalCounts = {};
  for (const file of files) {
    inc(statusCounts, file.drillStatus);
    inc(laneCounts, file.lane);
    for (const signal of arr(file.evidence?.topLevelRiskSignals)) inc(riskSignalCounts, signal);
  }
  const drilledOk = files.filter((file) => file.drillStatus === 'drilled_ok');
  const failed = files.filter((file) => file.drillStatus === 'failed');
  return {
    ok: true,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    root: laneAudit.root || root,
    inputs: {
      weakRuntimeRemainingLaneAudit: rel(resolvedPaths.weakRuntimeRemainingLaneAudit),
      weakRuntimeRemainingLaneAuditGeneratedAt: laneAudit.generatedAt || '',
    },
    policy: {
      importOnly: true,
      isolatedNodeSubprocessPerModule: true,
      tempHomeOnly: true,
      localTempOnly: true,
      readOnlyRealProjectState: true,
      noRealEnvFileReads: true,
      noProjectEnvImport: true,
      noOwnerTokenReads: true,
      noProtectedApiAuth: true,
      noLiveHttpRequests: true,
      noRouteHandlerCalls: true,
      noDbReadsByDrill: true,
      noModelCalls: true,
      noSecretValuesReturned: true,
    },
    status: {
      drill: failed.length ? 'route_import_contract_drills_failed' : 'route_import_contract_drills_complete',
      completionClaim: 'not_complete',
      explanation: 'Route dependency import drills prove local module load/export contracts in isolated temp HOME subprocesses. They do not prove protected business-method execution.',
    },
    summary: {
      targetFiles: targets.length,
      drilledOk: drilledOk.length,
      failed: failed.length,
      liveAuthSurfaceTargetFiles: targets.filter((file) => file.liveAuthSurface === true).length,
      liveAuthSurfaceDrilledOk: drilledOk.filter((file) => file.evidence?.liveAuthSurface === true).length,
      noSafeGetTargetFiles: targets.filter((file) => file.lane === 'route_has_protected_surface_but_no_safe_get_probe').length,
      noSafeGetDrilledOk: drilledOk.filter((file) => file.lane === 'route_has_protected_surface_but_no_safe_get_probe').length,
      protectedBusinessProofStillNeeded: targets.length,
      statusCounts,
      laneCounts,
      riskSignalCounts,
    },
    files,
  };
}

function mdTable(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function evidenceSummary(evidence = {}) {
  return [
    `exports:${evidence.exportCount ?? '-'}`,
    `tests:${evidence.testCount ?? 0}`,
    `liveAuth:${evidence.liveAuthSurface ? 'yes' : 'no'}`,
    `routes:${evidence.protectedRouteCount ?? 0}`,
    `risk:${arr(evidence.topLevelRiskSignals).join(',') || '-'}`,
  ].join('<br>');
}

export function renderMarkdown(report, jsonPath = '') {
  const rows = report.files.map((file) => [
    `\`${file.file}\``,
    file.lane,
    file.drillStatus,
    evidenceSummary(file.evidence || {}),
    clean(file.remainingNeed || '-', 180),
  ]);
  return [
    '# Noe Weak Route Targeted Local Drills',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Verdict',
    '',
    `- drill: \`${report.status.drill}\``,
    `- completion claim: \`${report.status.completionClaim}\``,
    `- explanation: ${report.status.explanation}`,
    '',
    '## Summary',
    '',
    `- target files: ${report.summary.targetFiles}`,
    `- drilled ok: ${report.summary.drilledOk}; failed: ${report.summary.failed}`,
    `- live-auth-surface drilled ok: ${report.summary.liveAuthSurfaceDrilledOk}/${report.summary.liveAuthSurfaceTargetFiles}`,
    `- no-safe-GET drilled ok: ${report.summary.noSafeGetDrilledOk}/${report.summary.noSafeGetTargetFiles}`,
    `- protected business proof still needed: ${report.summary.protectedBusinessProofStillNeeded}`,
    '',
    '## Files',
    '',
    mdTable([
      ['file', 'lane', 'status', 'evidence', 'remaining need'],
      ['---', '---', '---', '---', '---'],
      ...rows,
    ]),
    '',
    '## Interpretation',
    '',
    '- `drilled_ok` proves the module can be imported and its export contract inspected in an isolated temp-HOME subprocess.',
    '- It does not call protected route handlers, read owner tokens, or prove owner-authorized business behavior.',
    '- `protectedBusinessProofStillNeeded` stays equal to the route target count until owner-authorized summaries or natural route execution evidence exist.',
    '',
    '## JSON',
    '',
    jsonPath ? `Full report: \`${jsonPath.replace(`${ROOT}/`, '')}\`.` : 'No JSON path supplied.',
  ].join('\n');
}

export function writeNoeWeakRouteTargetedLocalDrills(report) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${OUT_BASE}.json`);
  const mdPath = join(OUT_DIR, `${OUT_BASE}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mdPath, `${renderMarkdown(report, jsonPath)}\n`, { mode: 0o600 });
  return { jsonPath, mdPath };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = buildNoeWeakRouteTargetedLocalDrills();
  const paths = writeNoeWeakRouteTargetedLocalDrills(report);
  console.log(JSON.stringify({
    ok: report.ok,
    drill: report.status.drill,
    targetFiles: report.summary.targetFiles,
    drilledOk: report.summary.drilledOk,
    failed: report.summary.failed,
    liveAuthSurfaceDrilledOk: report.summary.liveAuthSurfaceDrilledOk,
    noSafeGetDrilledOk: report.summary.noSafeGetDrilledOk,
    protectedBusinessProofStillNeeded: report.summary.protectedBusinessProofStillNeeded,
    paths,
  }, null, 2));
}
