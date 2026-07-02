#!/usr/bin/env node
// @ts-check
// Build a prioritized backlog for Neo files that are useful but not proven live.
// Read-only: consumes the full-code atlas only; no code bodies, DB, env files, model calls, or network calls.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ATLAS_PATH = process.env.NOE_FULL_CODE_ATLAS_PATH || join(ROOT, 'output', 'noe-audit', 'full-code-function-atlas-2026-06-15.json');
const OUT_DIR = process.env.NOE_RUNTIME_PROOF_BACKLOG_OUT_DIR || join(ROOT, 'output', 'noe-audit');
const OUT_BASE = process.env.NOE_RUNTIME_PROOF_BACKLOG_BASENAME || 'runtime-proof-backlog-2026-06-15';
const TARGET_PROOFS = new Set(['not_proven_live', 'static_runtime_surface_unproven']);
const TARGET_USEFULNESS = new Set(['core_or_autonomy_spine', 'AGI-critical', 'safety_or_evaluation_critical', 'runtime_support']);
const SUPPORT_ONLY_PATTERNS = /Parser|Adapter|Schema|Template|Formatter|Normalizer|Limit|Utils?|Config|PolicyStore|Store$/i;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function _clean(value = '', max = 240) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function basename(file = '') {
  return String(file || '').split('/').pop() || '';
}

function scoreFile(file = {}) {
  let score = 0;
  const usefulness = String(file.usefulness || '');
  const tags = new Set(arr(file.featureTags));
  const lines = Number(file.lines) || 0;
  if (usefulness === 'core_or_autonomy_spine') score += 100;
  if (usefulness === 'AGI-critical') score += 90;
  if (usefulness === 'safety_or_evaluation_critical') score += 75;
  if (usefulness === 'runtime_support') score += 55;
  if (tags.has('action_execution')) score += 18;
  if (tags.has('long_term_memory')) score += 18;
  if (tags.has('prediction_calibration')) score += 18;
  if (tags.has('safety_governance')) score += 16;
  if (tags.has('model_routing_review')) score += 14;
  if (tags.has('self_evolution')) score += 14;
  if (tags.has('context_identity')) score += 10;
  if (file.runtime?.proof === 'static_runtime_surface_unproven') score += 22;
  if (arr(file.staticSignals?.routeHints).length) score += 18;
  if (arr(file.staticSignals?.runtimeHints).length) score += 12;
  score += Math.min(20, Math.floor(lines / 250));
  if (SUPPORT_ONLY_PATTERNS.test(basename(file.file))) score -= 8;
  return score;
}

function proofStrategy(file = {}) {
  const name = basename(file.file);
  const module = String(file.module || '');
  const tags = new Set(arr(file.featureTags));
  const routes = arr(file.staticSignals?.routeHints);
  const runtimeHints = arr(file.staticSignals?.runtimeHints);
  if (routes.length) return 'route_or_ui_behavior_probe';
  if (runtimeHints.length) return 'wire_existing_runtime_hint_to_evidence';
  if (/SelfEvolution|Evolution|Archive|Holdout|DGM/i.test(`${file.file} ${name}`)) return 'self_evolution_lineage_holdout_probe';
  if (module === 'agents' || /Agent|Codebase|CodeContext/i.test(name)) return 'agent_runtime_usage_probe';
  if (module === 'capabilities' || /Capability|Tool|FreedomManifest|CommandSurface/i.test(name)) return 'capability_invocation_probe';
  if (module === 'autopilot' || /Autopilot|Delegation|Schedule|Finalizer/i.test(name)) return 'scheduler_or_delegation_probe';
  if (module === 'approval' || module === 'budget' || tags.has('safety_governance')) return 'safety_gate_runtime_probe';
  if (module === 'vision') return 'vision_status_or_situation_probe';
  if (module === 'mcp') return 'mcp_smoke_or_audit_probe';
  if (module === 'audit') return 'audit_log_append_probe';
  if (SUPPORT_ONLY_PATTERNS.test(name)) return 'support_only_classification_review';
  return 'runtime_probe_or_support_only_review';
}

function priorityFor(score) {
  if (score >= 125) return 'P0';
  if (score >= 100) return 'P1';
  if (score >= 80) return 'P2';
  return 'P3';
}

function buildBacklog({ atlas }) {
  const candidates = arr(atlas.files)
    .filter((file) => TARGET_PROOFS.has(file.runtime?.proof))
    .filter((file) => TARGET_USEFULNESS.has(file.usefulness))
    .filter((file) => !String(file.file || '').startsWith('tests/'))
    .filter((file) => !String(file.file || '').startsWith('scripts/'))
    .map((file) => {
      const score = scoreFile(file);
      const strategy = proofStrategy(file);
      return {
        file: file.file,
        module: file.module,
        lines: file.lines,
        usefulness: file.usefulness,
        runtimeProof: file.runtime?.proof || 'unknown',
        gaps: arr(file.runtime?.gaps),
        featureTags: arr(file.featureTags),
        symbolBlockCount: file.symbolBlockCount,
        tests: file.tests,
        routeHints: arr(file.staticSignals?.routeHints).slice(0, 10),
        runtimeHints: arr(file.staticSignals?.runtimeHints).slice(0, 10),
        currentNextAction: file.nextAction,
        recommendedProofStrategy: strategy,
        priority: priorityFor(score),
        score,
      };
    })
    .sort((a, b) => b.score - a.score || b.lines - a.lines || a.file.localeCompare(b.file));

  const byModule = [];
  for (const module of [...new Set(candidates.map((file) => file.module))].sort()) {
    const files = candidates.filter((file) => file.module === module);
    const priorities = {};
    const strategies = {};
    for (const file of files) {
      priorities[file.priority] = (priorities[file.priority] || 0) + 1;
      strategies[file.recommendedProofStrategy] = (strategies[file.recommendedProofStrategy] || 0) + 1;
    }
    byModule.push({
      module,
      files: files.length,
      lines: files.reduce((sum, file) => sum + (Number(file.lines) || 0), 0),
      priorities,
      topStrategies: Object.entries(strategies).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6),
      topFiles: files.slice(0, 8).map((file) => ({
        file: file.file,
        priority: file.priority,
        score: file.score,
        strategy: file.recommendedProofStrategy,
      })),
    });
  }
  byModule.sort((a, b) => {
    const ap0 = a.priorities.P0 || 0;
    const bp0 = b.priorities.P0 || 0;
    const ap1 = a.priorities.P1 || 0;
    const bp1 = b.priorities.P1 || 0;
    return bp0 - ap0 || bp1 - ap1 || b.lines - a.lines || a.module.localeCompare(b.module);
  });

  const byStrategy = [];
  for (const strategy of [...new Set(candidates.map((file) => file.recommendedProofStrategy))].sort()) {
    const files = candidates.filter((file) => file.recommendedProofStrategy === strategy);
    byStrategy.push({
      strategy,
      files: files.length,
      lines: files.reduce((sum, file) => sum + (Number(file.lines) || 0), 0),
      topFiles: files.slice(0, 10).map((file) => ({
        file: file.file,
        priority: file.priority,
        score: file.score,
      })),
    });
  }
  byStrategy.sort((a, b) => b.files - a.files || b.lines - a.lines || a.strategy.localeCompare(b.strategy));

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    root: atlas.root || ROOT,
    inputs: {
      atlasPath: ATLAS_PATH,
      atlasGeneratedAt: atlas.generatedAt || '',
      atlasFiles: atlas.summary?.files || arr(atlas.files).length,
      atlasSymbolBlocks: atlas.summary?.symbolBlocks || 0,
    },
    policy: {
      readOnlyFiles: true,
      atlasOnly: true,
      noDbWrites: true,
      noEnvFileReads: true,
      noModelCalls: true,
      noNetworkCalls: true,
      noSecretValuesReturned: true,
      fileBodiesNotExported: true,
    },
    summary: {
      backlogFiles: candidates.length,
      backlogLines: candidates.reduce((sum, file) => sum + (Number(file.lines) || 0), 0),
      p0: candidates.filter((file) => file.priority === 'P0').length,
      p1: candidates.filter((file) => file.priority === 'P1').length,
      p2: candidates.filter((file) => file.priority === 'P2').length,
      p3: candidates.filter((file) => file.priority === 'P3').length,
      sourceFilesNotProvenLive: atlas.summary?.filesNotProvenLive || 0,
      staticRuntimeSurfaceUnproven: atlas.summary?.filesStaticRuntimeSurfaceUnproven || 0,
      runtimeBlockers: arr(atlas.summary?.runtimeBlockers),
    },
    byModule,
    byStrategy,
    files: candidates,
  };
}

function mdTable(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function renderCounts(counts = {}) {
  return ['P0', 'P1', 'P2', 'P3'].map((key) => `${key}:${counts[key] || 0}`).join('<br>');
}

function renderMarkdown(report, jsonPath) {
  const moduleRows = report.byModule.slice(0, 40).map((m) => [
    `\`${m.module}\``,
    String(m.files),
    String(m.lines),
    renderCounts(m.priorities),
    m.topStrategies.map(([strategy, count]) => `${strategy}:${count}`).join('<br>') || '-',
    m.topFiles.slice(0, 4).map((file) => `\`${file.file}\` (${file.priority}/${file.strategy})`).join('<br>') || '-',
  ]);
  const fileRows = report.files.slice(0, 120).map((file) => [
    file.priority,
    String(file.score),
    `\`${file.file}\``,
    file.usefulness,
    file.runtimeProof,
    file.recommendedProofStrategy,
    file.featureTags.slice(0, 5).join(', '),
  ]);
  const strategyRows = report.byStrategy.map((entry) => [
    entry.strategy,
    String(entry.files),
    String(entry.lines),
    entry.topFiles.slice(0, 5).map((file) => `\`${file.file}\` (${file.priority})`).join('<br>') || '-',
  ]);
  return [
    '# Neo Runtime Proof Backlog',
    '',
    `Generated: ${report.generatedAt}`,
    `Atlas: ${report.inputs.atlasGeneratedAt || '-'}`,
    '',
    '## Summary',
    '',
    `- backlog files: ${report.summary.backlogFiles}; backlog lines: ${report.summary.backlogLines}`,
    `- priorities: P0=${report.summary.p0}; P1=${report.summary.p1}; P2=${report.summary.p2}; P3=${report.summary.p3}`,
    `- atlas not_proven_live files: ${report.summary.sourceFilesNotProvenLive}; static runtime surfaces unproven: ${report.summary.staticRuntimeSurfaceUnproven}`,
    `- runtime blockers: ${report.summary.runtimeBlockers.map((b) => `\`${b}\``).join(', ') || 'none'}`,
    '',
    '## Backlog By Module',
    '',
    mdTable([
      ['module', 'files', 'lines', 'priorities', 'top proof strategies', 'top files'],
      ['---', '---:', '---:', '---', '---', '---'],
      ...moduleRows,
    ]),
    '',
    '## Backlog By Proof Strategy',
    '',
    mdTable([
      ['proof strategy', 'files', 'lines', 'top files'],
      ['---', '---:', '---:', '---'],
      ...strategyRows,
    ]),
    '',
    '## Top Files',
    '',
    mdTable([
      ['priority', 'score', 'file', 'usefulness', 'runtime proof', 'recommended proof strategy', 'feature tags'],
      ['---', '---:', '---', '---', '---', '---', '---'],
      ...fileRows,
    ]),
    '',
    '## JSON',
    '',
    `Full backlog is in \`${jsonPath.replace(`${ROOT}/`, '')}\`. It contains file names, symbols/count-derived tags, route/env names, and proof labels only; no file bodies or secret values.`,
    '',
    '## Policy',
    '',
    '- atlas-only read; no source file bodies read by this script',
    '- no DB writes, no model calls, no network calls',
    '- no `.env` reads, no owner-token reads, no file bodies in output',
  ].join('\n');
}

function writeBacklog(report) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${OUT_BASE}.json`);
  const mdPath = join(OUT_DIR, `${OUT_BASE}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mdPath, `${renderMarkdown(report, jsonPath)}\n`, { mode: 0o600 });
  return { jsonPath, mdPath };
}

export function buildNoeRuntimeProofBacklog({
  atlasPath = ATLAS_PATH,
} = {}) {
  if (!existsSync(atlasPath)) throw new Error(`atlas not found: ${atlasPath}`);
  return buildBacklog({ atlas: readJson(atlasPath) });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = buildNoeRuntimeProofBacklog();
  const paths = writeBacklog(report);
  console.log(JSON.stringify({
    ok: true,
    generatedAt: report.generatedAt,
    backlogFiles: report.summary.backlogFiles,
    priorities: {
      p0: report.summary.p0,
      p1: report.summary.p1,
      p2: report.summary.p2,
      p3: report.summary.p3,
    },
    paths,
  }, null, 2));
}
