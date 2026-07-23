#!/usr/bin/env node
// @ts-check
// Fuse code inventory with runtime evidence into a per-module and per-file audit map.
// Read-only: no DB writes, no env-file reads, no model calls, no network calls.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY_PATH = process.env.NOE_CODEBASE_INVENTORY_PATH || join(ROOT, 'output', 'noe-codebase-inventory', 'latest.json');
const RUNTIME_PATH = process.env.NOE_RUNTIME_EVIDENCE_PATH || join(ROOT, 'output', 'noe-runtime-evidence', 'latest.json');
const OUT_DIR = process.env.NOE_MODULE_RUNTIME_MAP_OUT_DIR || join(ROOT, 'output', 'noe-audit');
const OUT_BASE = process.env.NOE_MODULE_RUNTIME_MAP_BASENAME || 'module-runtime-map-2026-06-15';

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function uniq(values = []) {
  return [...new Set(values.filter(Boolean).map((v) => String(v)))].sort();
}

function pct(n, d) {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
}

function moduleRuntimeIds(moduleName = '') {
  const m = String(moduleName || '');
  const map = {
    'server.js': ['panel_service', 'heartbeat_loop'],
    server: ['panel_service'],
    public: ['panel_service'],
    loop: ['heartbeat_loop', 'act_pipeline', 'self_evolution_gate'],
    cognition: ['expectation_calibration', 'curiosity_surprise_loop', 'owner_prediction'],
    memory: ['long_term_memory'],
    runtime: ['act_pipeline'],
    actions: ['act_pipeline'],
    room: ['local_models', 'self_evolution_gate'],
    model: ['local_models'],
    embeddings: ['long_term_memory', 'local_models'],
    voice: ['panel_service'],
    storage: ['long_term_memory', 'panel_service'],
    context: ['heartbeat_loop', 'long_term_memory'],
    permissions: ['act_pipeline'],
    governance: ['act_pipeline'],
    safety: ['act_pipeline'],
    scripts: ['self_evolution_gate'],
  };
  return map[m] || [];
}

function usefulnessForModule(moduleName = '', role = '') {
  const m = String(moduleName || '');
  const r = String(role || '');
  if (['server.js', 'server', 'loop', 'cognition', 'memory', 'runtime', 'room', 'model', 'storage'].includes(m)) return 'core_or_autonomy_spine';
  if (['public', 'voice', 'context', 'permissions', 'governance', 'safety', 'actions'].includes(m)) return 'operator_interface_or_action_safety';
  if (['scripts', 'tests'].includes(m) || r.includes('test')) return 'verification_or_operations';
  if (['agents', 'autopilot', 'workspace', 'integrations', 'mcp', 'plugin', 'watcher', 'telemetry'].includes(m)) return 'supporting_runtime_capability';
  return 'support_or_library';
}

function riskForFile(file) {
  const tests = arr(file.tests).length + arr(file.testImporters).length;
  const runtime = arr(file.runtimeHints).length + arr(file.routeHints).length;
  const imports = arr(file.sourceImporters).length;
  const envs = arr(file.envVars).length;
  const symbols = arr(file.symbols).length;
  if (String(file.file || '').startsWith('tests/')) return 'test_artifact';
  if (runtime > 0 && tests === 0) return 'runtime_surface_needs_behavioral_check';
  if (envs > 0 && tests === 0) return 'config_sensitive_needs_targeted_test';
  if (imports === 0 && !String(file.file || '').startsWith('server.js') && !String(file.file || '').startsWith('public/')) return 'entry_or_static_link_unknown';
  if (symbols === 0 && tests === 0 && runtime === 0) return 'low_signal_static_artifact';
  return tests > 0 ? 'covered_by_tests_or_importer_tests' : 'static_useful_needs_live_evidence';
}

function runtimeStatusForModule(moduleName, runtimeModulesById) {
  const ids = moduleRuntimeIds(moduleName);
  const modules = ids.map((id) => runtimeModulesById.get(id)).filter(Boolean);
  if (!ids.length) return { strength: 'static_only', ids: [], verdicts: [], gaps: ['no_direct_runtime_module_mapping'] };
  if (!modules.length) return { strength: 'missing_runtime_report', ids, verdicts: [], gaps: ['runtime_report_missing_module'] };
  const gaps = uniq(modules.map((m) => m.gap).filter(Boolean));
  const verdicts = uniq(modules.map((m) => `${m.id}:${m.running}`));
  const strength = gaps.length ? 'live_with_gap' : 'live_evidence';
  return { strength, ids, verdicts, gaps };
}

function buildAudit({ inventory, runtime }) {
  const files = arr(inventory?.files);
  const runtimeModulesById = new Map(arr(runtime?.modules).map((m) => [m.id, m]));
  const moduleMap = new Map();
  for (const file of files) {
    const moduleName = String(file.module || 'unknown');
    if (!moduleMap.has(moduleName)) {
      const runtimeStatus = runtimeStatusForModule(moduleName, runtimeModulesById);
      moduleMap.set(moduleName, {
        module: moduleName,
        usefulness: usefulnessForModule(moduleName),
        files: 0,
        lines: 0,
        sourceFiles: 0,
        testFiles: 0,
        routeFiles: 0,
        runtimeHintedFiles: 0,
        filesWithDirectTests: 0,
        filesWithAnyTestSignal: 0,
        filesWithEnvVars: 0,
        filesWithImporters: 0,
        riskCounts: {},
        runtime: runtimeStatus,
      });
    }
    const m = moduleMap.get(moduleName);
    m.files += 1;
    m.lines += Number(file.lines) || 0;
    if (String(file.file || '').startsWith('src/') || String(file.file || '') === 'server.js') m.sourceFiles += 1;
    if (String(file.file || '').startsWith('tests/')) m.testFiles += 1;
    if (arr(file.routeHints).length) m.routeFiles += 1;
    if (arr(file.runtimeHints).length) m.runtimeHintedFiles += 1;
    if (arr(file.tests).length) m.filesWithDirectTests += 1;
    if (arr(file.tests).length || arr(file.testImporters).length) m.filesWithAnyTestSignal += 1;
    if (arr(file.envVars).length) m.filesWithEnvVars += 1;
    if (arr(file.sourceImporters).length) m.filesWithImporters += 1;
    const risk = riskForFile(file);
    m.riskCounts[risk] = (m.riskCounts[risk] || 0) + 1;
  }
  const modules = [...moduleMap.values()]
    .map((m) => ({
      ...m,
      testSignalPct: pct(m.filesWithAnyTestSignal, m.files),
      runtimeHintPct: pct(m.runtimeHintedFiles + m.routeFiles, m.files),
    }))
    .sort((a, b) => b.lines - a.lines || b.files - a.files || a.module.localeCompare(b.module));

  const fileAudit = files.map((file) => {
    const runtimeStatus = runtimeStatusForModule(file.module, runtimeModulesById);
    const risk = riskForFile(file);
    return {
      file: file.file,
      module: file.module,
      role: file.role,
      lines: file.lines,
      usefulness: usefulnessForModule(file.module, file.role),
      risk,
      runtimeEvidence: {
        strength: runtimeStatus.strength,
        mappedRuntimeIds: runtimeStatus.ids,
        mappedRuntimeVerdicts: runtimeStatus.verdicts,
        gaps: runtimeStatus.gaps,
        routeHints: arr(file.routeHints).length,
        runtimeHints: arr(file.runtimeHints).length,
      },
      testEvidence: {
        directTests: arr(file.tests).length,
        testImporters: arr(file.testImporters).length,
      },
      staticEvidence: {
        symbols: arr(file.symbols).slice(0, 12),
        envVars: arr(file.envVars).slice(0, 12),
        localImports: arr(file.localImports).length,
        sourceImporters: arr(file.sourceImporters).length,
      },
    };
  }).sort((a, b) => String(a.file).localeCompare(String(b.file)));

  const blockers = arr(runtime?.blockers);
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    root: inventory?.root || ROOT,
    inputs: {
      inventoryPath: INVENTORY_PATH,
      inventoryGeneratedAt: inventory?.generatedAt || '',
      runtimePath: RUNTIME_PATH,
      runtimeGeneratedAt: runtime?.generatedAt || '',
    },
    policy: {
      readOnlyFiles: true,
      noDbWrites: true,
      noEnvFileReads: true,
      noModelCalls: true,
      noNetworkCalls: true,
      noSecretValuesReturned: true,
      fileBodiesNotExported: true,
    },
    totals: {
      ...(inventory?.totals || {}),
      modules: modules.length,
      runtimeBlockers: blockers,
    },
    runtimeModules: arr(runtime?.modules).map((m) => ({
      id: m.id,
      running: m.running,
      useful: m.useful,
      evidence: m.evidence,
      gap: m.gap,
    })),
    modules,
    files: fileAudit,
  };
}

function mdTable(rows) {
  return rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
}

function writeAudit(audit) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${OUT_BASE}.json`);
  const mdPath = join(OUT_DIR, `${OUT_BASE}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(audit, null, 2)}\n`, { mode: 0o600 });
  const rows = audit.modules.slice(0, 60).map((m) => [
    `\`${m.module}\``,
    String(m.files),
    String(m.lines),
    m.usefulness,
    `${m.runtime.strength}${m.runtime.gaps.length ? ` (${m.runtime.gaps.join(',')})` : ''}`,
    `${m.filesWithAnyTestSignal}/${m.files} (${m.testSignalPct}%)`,
    `${m.routeFiles}+${m.runtimeHintedFiles}`,
    Object.entries(m.riskCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v}`).join('<br>'),
  ]);
  const weakRows = audit.modules
    .filter((m) => m.runtime.strength !== 'live_evidence' || m.filesWithAnyTestSignal < m.files)
    .slice(0, 30)
    .map((m) => [
      `\`${m.module}\``,
      m.runtime.strength,
      m.runtime.gaps.join(',') || '-',
      `${m.filesWithAnyTestSignal}/${m.files}`,
      Object.entries(m.riskCounts).sort((a, b) => b[1] - a[1])[0]?.join(':') || '-',
    ]);
  const md = [
    '# Neo Module Runtime Map',
    '',
    `Generated: ${audit.generatedAt}`,
    `Inventory: ${audit.inputs.inventoryGeneratedAt || '-'}`,
    `Runtime evidence: ${audit.inputs.runtimeGeneratedAt || '-'}`,
    '',
    '## Summary',
    '',
    `- files: ${audit.totals.files}; sourceFiles: ${audit.totals.sourceFiles}; tests: ${audit.totals.testFiles}; modules: ${audit.totals.modules}`,
    `- lines: ${audit.totals.lines}; sourceLines: ${audit.totals.sourceLines}`,
    `- untestedSourceFiles: ${audit.totals.untestedSourceFiles}; unreferencedSourceFiles: ${audit.totals.unreferencedSourceFiles}`,
    `- runtime blockers: ${audit.totals.runtimeBlockers.length ? audit.totals.runtimeBlockers.map((b) => `\`${b}\``).join(', ') : 'none'}`,
    '',
    '## Runtime Modules',
    '',
    mdTable([
      ['runtime id', 'running', 'useful', 'gap'],
      ['---', '---', '---', '---'],
      ...audit.runtimeModules.map((m) => [`\`${m.id}\``, m.running || '-', m.useful || '-', m.gap || '']),
    ]),
    '',
    '## Module Matrix',
    '',
    mdTable([
      ['module', 'files', 'lines', 'usefulness', 'runtime evidence', 'test signal', 'routes+runtimeHints', 'top risks'],
      ['---', '---:', '---:', '---', '---', '---:', '---:', '---'],
      ...rows,
    ]),
    '',
    '## Weak Or Pending Evidence',
    '',
    mdTable([
      ['module', 'runtime strength', 'runtime gaps', 'test signal', 'top risk'],
      ['---', '---', '---', '---:', '---'],
      ...weakRows,
    ]),
    '',
    '## File-Level Audit',
    '',
    `Full per-file audit is in \`${jsonPath.replace(`${ROOT}/`, '')}\` under \`files[]\`. It includes all ${audit.files.length} inventoried files with usefulness, risk, runtime evidence, test evidence, symbols/env names only, and no file bodies.`,
    '',
    '## Policy',
    '',
    '- read-only file inputs only',
    '- no DB writes, no model calls, no network calls',
    '- no `.env` reads, no owner-token reads, no file bodies in output',
  ].join('\n');
  writeFileSync(mdPath, `${md}\n`, { mode: 0o600 });
  return { jsonPath, mdPath };
}

export function buildNoeModuleRuntimeMap({
  inventoryPath = INVENTORY_PATH,
  runtimePath = RUNTIME_PATH,
} = {}) {
  if (!existsSync(inventoryPath)) throw new Error(`inventory not found: ${inventoryPath}`);
  if (!existsSync(runtimePath)) throw new Error(`runtime evidence not found: ${runtimePath}`);
  const inventory = readJson(inventoryPath);
  const runtime = readJson(runtimePath);
  return buildAudit({ inventory, runtime });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const audit = buildNoeModuleRuntimeMap();
  const paths = writeAudit(audit);
  console.log(JSON.stringify({
    ok: true,
    generatedAt: audit.generatedAt,
    modules: audit.modules.length,
    files: audit.files.length,
    blockers: audit.totals.runtimeBlockers,
    paths,
  }, null, 2));
}
