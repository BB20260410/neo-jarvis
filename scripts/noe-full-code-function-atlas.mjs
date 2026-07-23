#!/usr/bin/env node
// @ts-check
// Full-code atlas for Neo/Noe: file purpose, function/class locations, usefulness, runtime proof, and next action.
// Read-only: uses inventory + module runtime map + listed code files only; no DB/env/model/network access.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY_PATH = process.env.NOE_CODEBASE_INVENTORY_PATH || join(ROOT, 'output', 'noe-codebase-inventory', 'latest.json');
const MODULE_MAP_PATH = process.env.NOE_MODULE_RUNTIME_MAP_PATH || join(ROOT, 'output', 'noe-audit', 'module-runtime-map-2026-06-15.json');
const OUT_DIR = process.env.NOE_FULL_CODE_ATLAS_OUT_DIR || join(ROOT, 'output', 'noe-audit');
const OUT_BASE = process.env.NOE_FULL_CODE_ATLAS_BASENAME || 'full-code-function-atlas-2026-06-15';
const MAX_SYMBOL_BLOCKS_PER_FILE = 120;
const MAX_MD_FILE_ROWS = 220;
const MAX_MD_SYMBOL_ROWS = 260;

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '', max = 240) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function uniq(values = []) {
  return [...new Set(values.map((v) => clean(v, 300)).filter(Boolean))].sort();
}

function relPath(file = '') {
  return String(file || '').replaceAll('\\', '/');
}

function basename(file = '') {
  return relPath(file).split('/').pop() || '';
}

function pct(n, d) {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
}

function countLines(text = '') {
  if (!text) return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

function exportedNames(file = {}) {
  const names = new Set();
  for (const symbol of arr(file.symbols)) {
    const parts = String(symbol || '').split(':');
    if (parts[0] === 'export' && parts[2]) names.add(parts[2]);
    if (parts[0] === 'export' && parts[1] === 'const' && parts[2]) names.add(parts[2]);
  }
  return names;
}

function featureTags(file = {}) {
  const path = String(file.file || '');
  if (path.startsWith('tests/')) return ['verification_ops'];
  const hay = [
    file.file,
    file.module,
    file.role,
    ...arr(file.symbols),
    ...arr(file.envVars),
    ...arr(file.routeHints),
    ...arr(file.runtimeHints),
  ].join(' ');
  const tags = [];
  const add = (tag, re) => { if (re.test(hay)) tags.push(tag); };
  if (path.startsWith('scripts/')) tags.push('verification_ops');
  if (path === 'server.js' || path.startsWith('src/server/') || path.startsWith('public/') || arr(file.routeHints).length) {
    tags.push('operator_interface');
  }
  add('prediction_calibration', /Expectation|Brier|Prediction|OwnerBehavior|Curiosity|GoalSystem|GoalCheckpoint/i);
  add('active_learning', /Curiosity|Learning|Surprise|ReflectiveTuner|Reward|ReasoningSearch/i);
  add('global_workspace_self_state', /Workspace|Deliberation|Integration|MindVitals|ThoughtLoop|Rumination|SelfTalk|Narrative/i);
  add('affect_welfare', /Affect|Mood|Vitals|Welfare/i);
  add('long_term_memory', /Memory|Episodic|FocusStack|KnowledgeGraph|PersonCard|Sublimation|Dream|FactExtractor/i);
  add('semantic_retrieval', /Semantic|Embedding|Fusion|Fisher|Retriever|Recall|Relevance|Rerank/i);
  add('memory_governance', /MemoryAudit|Governance|Candidate|Conflict|WriteGate|Provenance|Rollback|CopyValidation|Dedup/i);
  add('action_execution', /Act|Freedom|Mission|Executor|Runtime|Tool|Pipeline|Checkpoint|Taskflow/i);
  add('model_routing_review', /Model|Brain|Adapter|Reflect|Consensus|Arena|LmStudio|Ollama|Claude|Codex|Gemini|MiniMax|Xiaomi/i);
  add('self_evolution', /SelfEvolution|Evolution|Archive|DGM|self-improve|Holdout/i);
  add('context_identity', /Context|Identity|Turn|Host|Situation|Continuity|Narrative|Boundary/i);
  add('safety_governance', /Guard|Policy|Approval|Permission|Safety|Governance|Escalator|Protected|Risk/i);
  add('verification_ops', /tests|scripts|verify|audit|snapshot|inventory|drilldown|atlas/i);
  if (!tags.length) tags.push('supporting_logic');
  return uniq(tags);
}

function usefulnessVerdict(file = {}, runtimeStrength = 'static_only') {
  const module = String(file.module || '');
  const tags = featureTags(file);
  if (String(file.file || '').startsWith('tests/')) return 'verification';
  if (String(file.file || '').startsWith('scripts/')) return 'operations_or_verification';
  if (['server.js', 'server', 'cognition', 'memory', 'loop', 'runtime', 'room', 'model', 'storage'].includes(module)) return 'core_or_autonomy_spine';
  if (tags.some((t) => ['prediction_calibration', 'long_term_memory', 'action_execution', 'global_workspace_self_state'].includes(t))) return 'AGI-critical';
  if (tags.some((t) => ['safety_governance', 'model_routing_review', 'memory_governance', 'affect_welfare', 'self_evolution'].includes(t))) return 'safety_or_evaluation_critical';
  if (runtimeStrength === 'live_evidence') return 'runtime_support';
  if (tags.includes('operator_interface')) return 'operator_interface';
  return 'supporting';
}

function runtimeProof(fileAudit = {}, invFile = {}) {
  const runtime = fileAudit.runtimeEvidence || {};
  const strength = runtime.strength || 'static_only';
  if (strength === 'live_evidence') {
    return arr(invFile.runtimeHints).length || arr(invFile.routeHints).length
      ? 'file_hint_plus_module_live'
      : 'module_live_inferred';
  }
  if (strength === 'live_with_gap') return 'module_live_with_gap_inferred';
  if (arr(invFile.runtimeHints).length || arr(invFile.routeHints).length) return 'static_runtime_surface_unproven';
  return 'not_proven_live';
}

function nextAction(fileAudit = {}, invFile = {}, runtimeBlockers = []) {
  const gaps = arr(fileAudit.runtimeEvidence?.gaps);
  const tags = featureTags(invFile);
  const name = basename(invFile.file || fileAudit.file);
  const runtimeStrength = fileAudit.runtimeEvidence?.strength || 'static_only';
  if (String(invFile.file || '').startsWith('tests/')) return 'keep_as_verification_coverage';
  if (gaps.includes('semantic_runtime_unconfigured')) return 'restart_or_env_verify_semantic_memory_runtime';
  if (/OwnerBehaviorPredictor/i.test(name)) return 'restart_then_observe_owner_negative_followup_sample';
  if (
    tags.includes('affect_welfare')
    && runtimeBlockers.includes('affect_health_below_target')
    && (runtimeStrength !== 'static_only' || /Affect|MindVitals|server\.js/i.test(name))
  ) {
    return 'restart_and_observe_affect_desaturation_or_fix_appraisal';
  }
  if (gaps.includes('no_failed_samples') || gaps.includes('source_surprise_absent')) {
    return 'produce_or_observe_real_failed_prediction_samples';
  }
  if (/SelfEvolution|Evolution|Archive|DGM|self-improve|Holdout/i.test(`${invFile.file || ''} ${name}`)) {
    return 'prove_lineage_holdout_and_applied_self_modification';
  }
  if (String(invFile.file || '').startsWith('scripts/')) return 'keep_or_wire_to_repeatable_verifier';
  if ((fileAudit.runtimeEvidence?.strength || '') === 'static_only') return 'map_to_runtime_probe_or_confirm_support_only';
  if (fileAudit.risk === 'runtime_surface_needs_behavioral_check') return 'add_behavioral_runtime_probe';
  return 'keep_covered_and_recheck_after_runtime_changes';
}

function parseSource(text = '', file = '') {
  try {
    return parse(text, {
      sourceType: 'unambiguous',
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      plugins: [
        'jsx',
        'topLevelAwait',
        'dynamicImport',
        'importMeta',
        'importAttributes',
        'classProperties',
        'classPrivateProperties',
        'classPrivateMethods',
        'objectRestSpread',
        'optionalChaining',
        'nullishCoalescingOperator',
      ],
    });
  } catch (firstError) {
    try {
      return parse(text, {
        sourceType: 'script',
        errorRecovery: true,
        allowReturnOutsideFunction: true,
        plugins: ['jsx', 'dynamicImport', 'importMeta'],
      });
    } catch {
      return {
        type: 'ParseFailed',
        program: { body: [] },
        errors: [{ message: clean(firstError?.message || `parse failed: ${file}`, 240) }],
      };
    }
  }
}

function nodeName(node) {
  if (!node) return '';
  if (node.id?.name) return node.id.name;
  if (node.key?.name) return node.key.name;
  if (node.key?.value) return String(node.key.value);
  if (node.left?.name) return node.left.name;
  return '';
}

function nodeLines(node) {
  return {
    start: Number(node?.loc?.start?.line) || 0,
    end: Number(node?.loc?.end?.line) || 0,
  };
}

function blockSpan(block) {
  const start = Number(block.startLine) || 0;
  const end = Number(block.endLine) || start;
  return { start, end: Math.max(start, end) };
}

function unionLineCoverage(blocks = []) {
  const ranges = blocks
    .map(blockSpan)
    .filter((r) => r.start > 0 && r.end >= r.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end + 1) merged.push({ ...range });
    else last.end = Math.max(last.end, range.end);
  }
  return merged.reduce((sum, r) => sum + r.end - r.start + 1, 0);
}

function collectSymbolBlocks(text = '', file = '', invFile = {}) {
  const ast = parseSource(text, file);
  const blocks = [];
  const exports = exportedNames(invFile);
  const parseErrors = arr(ast.errors).map((e) => clean(e.message || e.reasonCode || 'parse error', 200)).slice(0, 5);

  function add(node, kind, name = '', exported = false) {
    const loc = nodeLines(node);
    const safeName = clean(name || nodeName(node) || '<anonymous>', 160);
    if (!loc.start || !safeName) return;
    const isExported = exported || exports.has(safeName);
    blocks.push({
      kind,
      name: safeName,
      startLine: loc.start,
      endLine: loc.end || loc.start,
      lines: Math.max(1, (loc.end || loc.start) - loc.start + 1),
      exported: Boolean(isExported),
    });
  }

  function visit(node, parent = null, exported = false) {
    if (!node || typeof node !== 'object') return;
    switch (node.type) {
      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration':
        if (node.declaration) visit(node.declaration, node, true);
        return;
      case 'FunctionDeclaration':
        add(node, 'function', node.id?.name || '', exported);
        break;
      case 'ClassDeclaration':
        add(node, 'class', node.id?.name || '', exported);
        break;
      case 'VariableDeclarator': {
        const initType = node.init?.type || '';
        if (['ArrowFunctionExpression', 'FunctionExpression', 'ClassExpression'].includes(initType)) {
          const kind = initType === 'ClassExpression' ? 'class-variable' : initType === 'ArrowFunctionExpression' ? 'arrow-function' : 'function-variable';
          add(node, kind, node.id?.name || '', exported || parent?.type === 'VariableDeclaration');
        }
        break;
      }
      case 'ClassMethod':
      case 'ClassPrivateMethod':
      case 'ObjectMethod':
        add(node, 'method', nodeName(node), exported);
        break;
      default:
        break;
    }

    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'extra', 'comments', 'tokens', 'leadingComments', 'trailingComments', 'innerComments'].includes(key)) continue;
      if (Array.isArray(value)) {
        for (const child of value) visit(child, node, false);
      } else if (value && typeof value === 'object' && typeof value.type === 'string') {
        visit(value, node, false);
      }
    }
  }

  visit(ast.program || ast);
  const seen = new Set();
  const uniqueBlocks = blocks
    .sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name))
    .filter((block) => {
      const key = `${block.kind}:${block.name}:${block.startLine}:${block.endLine}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_SYMBOL_BLOCKS_PER_FILE);
  return {
    parseOk: parseErrors.length === 0 || ast.type !== 'ParseFailed',
    parseErrors,
    blocks: uniqueBlocks,
    symbolBlockLines: unionLineCoverage(uniqueBlocks),
  };
}

function buildAtlas({ inventory, moduleMap, root = ROOT }) {
  const invFiles = arr(inventory.files);
  const moduleFileMap = new Map(arr(moduleMap.files).map((file) => [file.file, file]));
  const runtimeBlockers = arr(moduleMap.totals?.runtimeBlockers);
  const fileReports = invFiles.map((invFile) => {
    const file = relPath(invFile.file);
    const mapFile = moduleFileMap.get(file) || {};
    const abs = resolve(root, file);
    let text = '';
    let readOk = false;
    try {
      text = readFileSync(abs, 'utf8');
      readOk = true;
    } catch {
      text = '';
    }
    const parsed = readOk ? collectSymbolBlocks(text, file, invFile) : {
      parseOk: false,
      parseErrors: ['file_read_failed'],
      blocks: [],
      symbolBlockLines: 0,
    };
    const lines = Number(invFile.lines) || countLines(text);
    const runtime = mapFile.runtimeEvidence || { strength: 'static_only', gaps: [] };
    const tags = featureTags(invFile);
    const proof = runtimeProof(mapFile, invFile);
    return {
      file,
      module: invFile.module || mapFile.module || 'unknown',
      role: invFile.role || mapFile.role || 'supporting_module',
      lines,
      symbolBlocks: parsed.blocks,
      symbolBlockCount: parsed.blocks.length,
      symbolBlockLines: parsed.symbolBlockLines,
      symbolBlockCoveragePct: pct(parsed.symbolBlockLines, lines),
      parse: {
        ok: parsed.parseOk,
        errors: parsed.parseErrors,
      },
      featureTags: tags,
      usefulness: usefulnessVerdict(invFile, runtime.strength),
      runtime: {
        strength: runtime.strength || 'static_only',
        proof,
        mappedRuntimeIds: arr(runtime.mappedRuntimeIds),
        mappedRuntimeVerdicts: arr(runtime.mappedRuntimeVerdicts),
        gaps: arr(runtime.gaps),
        routeHints: arr(invFile.routeHints).length,
        runtimeHints: arr(invFile.runtimeHints).length,
      },
      tests: {
        direct: arr(invFile.tests).length,
        importers: arr(invFile.testImporters).length,
      },
      staticSignals: {
        symbols: arr(invFile.symbols).length,
        envVars: arr(invFile.envVars),
        routeHints: arr(invFile.routeHints),
        runtimeHints: arr(invFile.runtimeHints),
        sourceImporters: arr(invFile.sourceImporters).length,
        localImports: arr(invFile.localImports).length,
      },
      risk: mapFile.risk || 'unknown',
      nextAction: nextAction(mapFile, invFile, runtimeBlockers),
    };
  });

  const byModule = [];
  for (const module of uniq(fileReports.map((file) => file.module))) {
    const files = fileReports.filter((file) => file.module === module);
    const runCounts = {};
    const usefulnessCounts = {};
    const nextActionCounts = {};
    for (const file of files) {
      runCounts[file.runtime.proof] = (runCounts[file.runtime.proof] || 0) + 1;
      usefulnessCounts[file.usefulness] = (usefulnessCounts[file.usefulness] || 0) + 1;
      nextActionCounts[file.nextAction] = (nextActionCounts[file.nextAction] || 0) + 1;
    }
    byModule.push({
      module,
      files: files.length,
      lines: files.reduce((sum, f) => sum + f.lines, 0),
      symbolBlocks: files.reduce((sum, f) => sum + f.symbolBlockCount, 0),
      symbolBlockCoveragePct: pct(files.reduce((sum, f) => sum + f.symbolBlockLines, 0), files.reduce((sum, f) => sum + f.lines, 0)),
      runCounts,
      usefulnessCounts,
      topNextActions: Object.entries(nextActionCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8),
    });
  }
  byModule.sort((a, b) => b.lines - a.lines || b.files - a.files || a.module.localeCompare(b.module));

  const byFeature = [];
  for (const tag of uniq(fileReports.flatMap((file) => file.featureTags))) {
    const files = fileReports.filter((file) => file.featureTags.includes(tag));
    const runCounts = {};
    const modules = {};
    for (const file of files) {
      runCounts[file.runtime.proof] = (runCounts[file.runtime.proof] || 0) + 1;
      modules[file.module] = (modules[file.module] || 0) + 1;
    }
    byFeature.push({
      tag,
      files: files.length,
      lines: files.reduce((sum, f) => sum + f.lines, 0),
      symbolBlocks: files.reduce((sum, f) => sum + f.symbolBlockCount, 0),
      runCounts,
      topModules: Object.entries(modules).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8),
    });
  }
  byFeature.sort((a, b) => b.files - a.files || b.lines - a.lines || a.tag.localeCompare(b.tag));

  const symbolBlocks = fileReports.flatMap((file) => file.symbolBlocks.map((block) => ({
    file: file.file,
    module: file.module,
    kind: block.kind,
    name: block.name,
    startLine: block.startLine,
    endLine: block.endLine,
    lines: block.lines,
    exported: block.exported,
    usefulness: file.usefulness,
    runtimeProof: file.runtime.proof,
    nextAction: file.nextAction,
  })));

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    root: inventory.root || root,
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
      noSecretValuesReturned: true,
      fileBodiesNotExported: true,
    },
    summary: {
      files: fileReports.length,
      lines: fileReports.reduce((sum, f) => sum + f.lines, 0),
      symbolBlocks: symbolBlocks.length,
      exportedSymbolBlocks: symbolBlocks.filter((block) => block.exported).length,
      modules: byModule.length,
      featureTags: byFeature.length,
      runtimeBlockers,
      parseFailures: fileReports.filter((file) => file.parse.errors.length && !file.parse.ok).length,
      filesNotProvenLive: fileReports.filter((file) => file.runtime.proof === 'not_proven_live').length,
      filesStaticRuntimeSurfaceUnproven: fileReports.filter((file) => file.runtime.proof === 'static_runtime_surface_unproven').length,
    },
    byModule,
    byFeature,
    files: fileReports.sort((a, b) => a.module.localeCompare(b.module) || b.lines - a.lines || a.file.localeCompare(b.file)),
    symbolBlocks: symbolBlocks.sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine || a.name.localeCompare(b.name)),
  };
}

function mdTable(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function topEntries(counts = {}, max = 4) {
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([k, v]) => `${k}:${v}`).join('<br>') || '-';
}

function renderMarkdown(report, jsonPath) {
  const moduleRows = report.byModule.slice(0, 80).map((m) => [
    `\`${m.module}\``,
    String(m.files),
    String(m.lines),
    String(m.symbolBlocks),
    `${m.symbolBlockCoveragePct}%`,
    topEntries(m.runCounts, 4),
    topEntries(m.usefulnessCounts, 3),
    m.topNextActions.map(([k, v]) => `${k}:${v}`).join('<br>') || '-',
  ]);
  const featureRows = report.byFeature.slice(0, 40).map((f) => [
    f.tag,
    String(f.files),
    String(f.lines),
    String(f.symbolBlocks),
    topEntries(f.runCounts, 4),
    f.topModules.map(([k, v]) => `${k}:${v}`).join('<br>') || '-',
  ]);
  const weakRows = report.files
    .filter((file) => file.runtime.proof !== 'file_hint_plus_module_live' && file.runtime.proof !== 'module_live_inferred')
    .slice(0, MAX_MD_FILE_ROWS)
    .map((file) => [
      `\`${file.file}\``,
      String(file.lines),
      file.usefulness,
      file.runtime.proof,
      file.runtime.gaps.join(',') || '-',
      `${file.tests.direct}+${file.tests.importers}`,
      file.nextAction,
    ]);
  const symbolRows = report.symbolBlocks
    .filter((block) => block.exported || ['core_or_autonomy_spine', 'AGI-critical', 'safety_or_evaluation_critical'].includes(block.usefulness))
    .slice(0, MAX_MD_SYMBOL_ROWS)
    .map((block) => [
      `\`${block.file}:${block.startLine}\``,
      block.kind,
      `\`${block.name}\``,
      block.exported ? 'yes' : '',
      block.runtimeProof,
      block.nextAction,
    ]);
  return [
    '# Neo Full Code Function Atlas',
    '',
    `Generated: ${report.generatedAt}`,
    `Inventory: ${report.inputs.inventoryGeneratedAt || '-'}`,
    `Module map: ${report.inputs.moduleMapGeneratedAt || '-'}`,
    '',
    '## Summary',
    '',
    `- files: ${report.summary.files}; lines: ${report.summary.lines}; modules: ${report.summary.modules}`,
    `- symbol/function/class blocks: ${report.summary.symbolBlocks}; exported blocks: ${report.summary.exportedSymbolBlocks}`,
    `- feature tags: ${report.summary.featureTags}`,
    `- not proven live files: ${report.summary.filesNotProvenLive}; static runtime surfaces unproven: ${report.summary.filesStaticRuntimeSurfaceUnproven}`,
    `- runtime blockers: ${report.summary.runtimeBlockers.map((b) => `\`${b}\``).join(', ') || 'none'}`,
    '',
    '## Architecture By Module',
    '',
    mdTable([
      ['module', 'files', 'lines', 'symbol blocks', 'symbol span coverage', 'runtime proof', 'usefulness', 'top next actions'],
      ['---', '---:', '---:', '---:', '---:', '---', '---', '---'],
      ...moduleRows,
    ]),
    '',
    '## Feature Tag Matrix',
    '',
    mdTable([
      ['feature tag', 'files', 'lines', 'symbol blocks', 'runtime proof', 'top modules'],
      ['---', '---:', '---:', '---:', '---', '---'],
      ...featureRows,
    ]),
    '',
    '## Weak Or Pending File Evidence',
    '',
    mdTable([
      ['file', 'lines', 'usefulness', 'runtime proof', 'gaps', 'tests', 'next action'],
      ['---', '---:', '---', '---', '---', '---:', '---'],
      ...weakRows,
    ]),
    '',
    '## Key Symbol Blocks',
    '',
    mdTable([
      ['location', 'kind', 'name', 'exported', 'runtime proof', 'next action'],
      ['---', '---', '---', '---', '---', '---'],
      ...symbolRows,
    ]),
    '',
    '## JSON',
    '',
    `Full file and symbol-block audit is in \`${jsonPath.replace(`${ROOT}/`, '')}\`. It includes file names, line ranges, symbols, env var names, route names, counts, and runtime-evidence labels only; it does not include file bodies or secret values.`,
    '',
    '## Policy',
    '',
    '- read-only file inputs listed by inventory',
    '- no DB writes, no model calls, no network calls',
    '- no `.env` reads, no owner-token reads, no file bodies in output',
  ].join('\n');
}

function writeAtlas(report) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${OUT_BASE}.json`);
  const mdPath = join(OUT_DIR, `${OUT_BASE}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mdPath, `${renderMarkdown(report, jsonPath)}\n`, { mode: 0o600 });
  return { jsonPath, mdPath };
}

export function buildNoeFullCodeFunctionAtlas({
  inventoryPath = INVENTORY_PATH,
  moduleMapPath = MODULE_MAP_PATH,
  root,
} = {}) {
  if (!existsSync(inventoryPath)) throw new Error(`inventory not found: ${inventoryPath}`);
  if (!existsSync(moduleMapPath)) throw new Error(`module runtime map not found: ${moduleMapPath}`);
  const inventory = readJson(inventoryPath);
  const moduleMap = readJson(moduleMapPath);
  return buildAtlas({
    inventory,
    moduleMap,
    root: root || inventory.root || ROOT,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = buildNoeFullCodeFunctionAtlas();
  const paths = writeAtlas(report);
  console.log(JSON.stringify({
    ok: true,
    generatedAt: report.generatedAt,
    files: report.summary.files,
    lines: report.summary.lines,
    symbolBlocks: report.summary.symbolBlocks,
    modules: report.summary.modules,
    blockers: report.summary.runtimeBlockers,
    paths,
  }, null, 2));
}
