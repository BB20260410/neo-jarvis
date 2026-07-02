#!/usr/bin/env node
// @ts-check
// Per-file drilldown for AGI/self-awareness critical Neo modules.
// Read-only: uses inventory + module runtime map only; no DB/env/model/network access.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY_PATH = process.env.NOE_CODEBASE_INVENTORY_PATH || join(ROOT, 'output', 'noe-codebase-inventory', 'latest.json');
const MODULE_MAP_PATH = process.env.NOE_MODULE_RUNTIME_MAP_PATH || join(ROOT, 'output', 'noe-audit', 'module-runtime-map-2026-06-15.json');
const OUT_DIR = process.env.NOE_CRITICAL_MODULE_DRILLDOWN_OUT_DIR || join(ROOT, 'output', 'noe-audit');
const OUT_BASE = process.env.NOE_CRITICAL_MODULE_DRILLDOWN_BASENAME || 'critical-modules-drilldown-2026-06-15';
const DEFAULT_MODULES = ['cognition', 'memory', 'loop', 'context', 'room', 'runtime', 'model', 'server.js'];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '', max = 240) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function moduleList() {
  const raw = process.env.NOE_CRITICAL_MODULES || DEFAULT_MODULES.join(',');
  return raw.split(',').map((s) => clean(s, 80)).filter(Boolean);
}

function basename(file = '') {
  return String(file || '').split('/').pop() || '';
}

function featureTags(file = {}) {
  const hay = [
    file.file,
    file.module,
    file.role,
    ...arr(file.symbols),
    ...arr(file.envVars),
  ].join(' ');
  const tags = [];
  const add = (tag, re) => { if (re.test(hay)) tags.push(tag); };
  add('prediction_calibration', /Expectation|Brier|Prediction|OwnerBehavior|Curiosity|GoalSystem|GoalCheckpoint/i);
  add('active_learning', /Curiosity|Learning|Surprise|ReflectiveTuner|Reward|ReasoningSearch/i);
  add('global_workspace_self_state', /Workspace|Deliberation|Integration|MindVitals|ThoughtLoop|Rumination|SelfTalk|Narrative/i);
  add('affect_welfare', /Affect|Mood|Vitals|Welfare/i);
  add('long_term_memory', /Memory|Episodic|FocusStack|KnowledgeGraph|PersonCard|Sublimation|Dream|FactExtractor/i);
  add('semantic_retrieval', /Semantic|Embedding|Fusion|Fisher|Retriever|Recall|Relevance|Rerank/i);
  add('memory_governance', /Governance|Candidate|Audit|Conflict|WriteGate|Provenance|Rollback|CopyValidation|Dedup/i);
  add('action_execution', /Act|Freedom|Mission|Executor|Runtime|Tool|Pipeline|Checkpoint|Taskflow/i);
  add('model_routing_review', /Model|Brain|Adapter|Reflect|Consensus|Arena|LmStudio|Ollama|Claude|Codex|Gemini|MiniMax|Xiaomi/i);
  add('self_evolution', /SelfEvolution|Evolution|Archive|DGM|self-improve|Holdout/i);
  add('context_identity', /Context|Identity|Turn|Host|Situation|Continuity|Narrative|Boundary/i);
  add('safety_governance', /Guard|Policy|Approval|Permission|Safety|Governance|Escalator|Protected|Risk/i);
  if (!tags.length) tags.push('supporting_logic');
  return [...new Set(tags)];
}

function usefulnessVerdict(fileAudit = {}) {
  const tags = featureTags(fileAudit);
  const runtimeStrength = fileAudit.runtimeEvidence?.strength || 'static_only';
  if (tags.some((t) => ['prediction_calibration', 'long_term_memory', 'action_execution', 'global_workspace_self_state'].includes(t))) {
    return 'AGI-critical';
  }
  if (tags.some((t) => ['safety_governance', 'model_routing_review', 'memory_governance', 'affect_welfare', 'self_evolution'].includes(t))) {
    return 'safety-or-evaluation-critical';
  }
  if (runtimeStrength === 'live_evidence') return 'runtime-support';
  return 'supporting';
}

function runState(fileAudit = {}) {
  const runtime = fileAudit.runtimeEvidence || {};
  if (runtime.strength === 'live_evidence') return 'live_evidence';
  if (runtime.strength === 'live_with_gap') return `live_with_gap:${arr(runtime.gaps).join(',') || 'unknown_gap'}`;
  if ((runtime.routeHints || 0) > 0 || (runtime.runtimeHints || 0) > 0) return 'runtime_surface_static_only';
  return 'static_or_test_only';
}

function nextAction(fileAudit = {}, runtimeBlockers = []) {
  const gaps = arr(fileAudit.runtimeEvidence?.gaps);
  const tags = featureTags(fileAudit);
  const name = basename(fileAudit.file);
  if (tags.includes('affect_welfare') && runtimeBlockers.includes('affect_health_below_target')) {
    return 'restart_and_observe_affect_desaturation_or_fix_appraisal';
  }
  if (gaps.includes('semantic_runtime_unconfigured')) return 'restart_or_env_verify_semantic_memory_runtime';
  if (/OwnerBehaviorPredictor/i.test(name)) return 'restart_then_observe_owner_negative_followup_sample';
  if (gaps.includes('no_failed_samples') || gaps.includes('source_surprise_absent')) return 'produce_or_observe_real_failed_prediction_samples';
  if (gaps.includes('live_pending_restart_or_natural_sample')) return 'restart_then_observe_owner_negative_followup_sample';
  if (tags.includes('self_evolution')) return 'prove_lineage_holdout_and_applied_self_modification';
  if ((fileAudit.runtimeEvidence?.strength || '') === 'static_only') return 'add_runtime_probe_or_map_to_existing_live_evidence';
  return 'keep_covered_and_recheck_after_runtime_changes';
}

function buildDrilldown({ inventory, moduleMap, modules = DEFAULT_MODULES }) {
  const inventoryByFile = new Map(arr(inventory.files).map((f) => [f.file, f]));
  const runtimeBlockers = arr(moduleMap.totals?.runtimeBlockers);
  const fileAudits = arr(moduleMap.files)
    .filter((f) => modules.includes(f.module))
    .map((audit) => {
      const inv = inventoryByFile.get(audit.file) || {};
      return {
        file: audit.file,
        module: audit.module,
        basename: basename(audit.file),
        lines: audit.lines,
        featureTags: featureTags({ ...audit, ...inv }),
        usefulness: usefulnessVerdict(audit),
        runState: runState(audit),
        currentGaps: arr(audit.runtimeEvidence?.gaps),
        risk: audit.risk,
        nextAction: nextAction(audit, runtimeBlockers),
        tests: {
          direct: audit.testEvidence?.directTests || 0,
          importers: audit.testEvidence?.testImporters || 0,
        },
        staticSignals: {
          symbols: arr(inv.symbols).slice(0, 10),
          envVars: arr(inv.envVars).slice(0, 10),
          sourceImporters: arr(inv.sourceImporters).length,
          localImports: arr(inv.localImports).length,
          routeHints: arr(inv.routeHints).slice(0, 8),
          runtimeHints: arr(inv.runtimeHints).slice(0, 8),
        },
      };
    })
    .sort((a, b) => a.module.localeCompare(b.module) || b.lines - a.lines || a.file.localeCompare(b.file));

  const byModule = modules.map((module) => {
    const files = fileAudits.filter((f) => f.module === module);
    const tagCounts = {};
    const runCounts = {};
    const gapCounts = {};
    for (const file of files) {
      for (const tag of file.featureTags) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      runCounts[file.runState] = (runCounts[file.runState] || 0) + 1;
      for (const gap of file.currentGaps) gapCounts[gap] = (gapCounts[gap] || 0) + 1;
    }
    return {
      module,
      files: files.length,
      lines: files.reduce((sum, f) => sum + (Number(f.lines) || 0), 0),
      runCounts,
      gapCounts,
      topTags: Object.entries(tagCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8),
      topNextActions: Object.entries(files.reduce((acc, f) => {
        acc[f.nextAction] = (acc[f.nextAction] || 0) + 1;
        return acc;
      }, {})).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6),
    };
  });

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    inputs: {
      inventoryPath: INVENTORY_PATH,
      inventoryGeneratedAt: inventory.generatedAt || '',
      moduleMapPath: MODULE_MAP_PATH,
      moduleMapGeneratedAt: moduleMap.generatedAt || '',
    },
    policy: {
      readOnlyFiles: true,
      noDbWrites: true,
      noEnvFileReads: true,
      noModelCalls: true,
      noNetworkCalls: true,
      noFileBodies: true,
    },
    modules,
    summary: {
      files: fileAudits.length,
      lines: fileAudits.reduce((sum, f) => sum + (Number(f.lines) || 0), 0),
      runtimeBlockers,
    },
    byModule,
    files: fileAudits,
  };
}

function mdTable(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function renderMarkdown(report, jsonPath) {
  const moduleRows = report.byModule.map((m) => [
    `\`${m.module}\``,
    String(m.files),
    String(m.lines),
    Object.entries(m.runCounts).map(([k, v]) => `${k}:${v}`).join('<br>') || '-',
    Object.entries(m.gapCounts).map(([k, v]) => `${k}:${v}`).join('<br>') || '-',
    m.topTags.map(([k, v]) => `${k}:${v}`).join('<br>') || '-',
    m.topNextActions.map(([k, v]) => `${k}:${v}`).join('<br>') || '-',
  ]);
  const fileRows = report.files.map((f) => [
    `\`${f.file}\``,
    String(f.lines),
    f.usefulness,
    f.featureTags.join(', '),
    f.runState,
    f.currentGaps.join(',') || '-',
    `${f.tests.direct}+${f.tests.importers}`,
    f.nextAction,
  ]);
  return [
    '# Neo Critical Module Drilldown',
    '',
    `Generated: ${report.generatedAt}`,
    `Inventory: ${report.inputs.inventoryGeneratedAt || '-'}`,
    `Module map: ${report.inputs.moduleMapGeneratedAt || '-'}`,
    '',
    '## Summary',
    '',
    `- modules: ${report.modules.map((m) => `\`${m}\``).join(', ')}`,
    `- files: ${report.summary.files}; lines: ${report.summary.lines}`,
    `- runtime blockers: ${report.summary.runtimeBlockers.map((b) => `\`${b}\``).join(', ') || 'none'}`,
    '',
    '## Module Drilldown',
    '',
    mdTable([
      ['module', 'files', 'lines', 'run states', 'gaps', 'top feature tags', 'top next actions'],
      ['---', '---:', '---:', '---', '---', '---', '---'],
      ...moduleRows,
    ]),
    '',
    '## File Drilldown',
    '',
    mdTable([
      ['file', 'lines', 'usefulness', 'feature tags', 'run state', 'gaps', 'tests', 'next action'],
      ['---', '---:', '---', '---', '---', '---', '---:', '---'],
      ...fileRows,
    ]),
    '',
    '## JSON',
    '',
    `Full symbols/env/import counts are in \`${jsonPath.replace(`${ROOT}/`, '')}\`. The report contains names and counts only, not file bodies.`,
  ].join('\n');
}

function writeDrilldown(report) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${OUT_BASE}.json`);
  const mdPath = join(OUT_DIR, `${OUT_BASE}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mdPath, `${renderMarkdown(report, jsonPath)}\n`, { mode: 0o600 });
  return { jsonPath, mdPath };
}

export function buildCriticalModuleDrilldown({
  inventoryPath = INVENTORY_PATH,
  moduleMapPath = MODULE_MAP_PATH,
  modules = moduleList(),
} = {}) {
  if (!existsSync(inventoryPath)) throw new Error(`inventory not found: ${inventoryPath}`);
  if (!existsSync(moduleMapPath)) throw new Error(`module runtime map not found: ${moduleMapPath}`);
  return buildDrilldown({
    inventory: readJson(inventoryPath),
    moduleMap: readJson(moduleMapPath),
    modules,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = buildCriticalModuleDrilldown();
  const paths = writeDrilldown(report);
  console.log(JSON.stringify({
    ok: true,
    generatedAt: report.generatedAt,
    modules: report.modules,
    files: report.summary.files,
    blockers: report.summary.runtimeBlockers,
    paths,
  }, null, 2));
}
