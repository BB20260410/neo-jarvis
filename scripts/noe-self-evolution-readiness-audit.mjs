#!/usr/bin/env node
// @ts-check
// Read-only + isolated self-evolution readiness audit.
// It reads the live DGM archive for counts, then writes a temporary archive drill only.
// No live archive mutation, no model calls, no git worktree, no patch application.

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildDgmArchiveEvidence } from './noe-runtime-evidence-audit.mjs';
import { buildNoeEvolutionArchiveEntry } from '../src/room/NoeEvolutionArchive.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = homedir();
const OUT_DIR = process.env.NOE_SELF_EVOLUTION_READINESS_OUT_DIR || join(ROOT, 'output', 'noe-audit');
const OUT_BASE = process.env.NOE_SELF_EVOLUTION_READINESS_BASENAME || 'self-evolution-readiness-audit-2026-06-15';
const LIVE_ARCHIVE = process.env.NOE_SELF_IMPROVE_ARCHIVE || join(HOME, '.noe-panel', 'self-improve', 'archive.jsonl');

function clean(value = '', max = 240) {
  return String(value ?? '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [key]')
    .replace(/token[=:]\S+/gi, 'token=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function rel(file) {
  const abs = resolve(file);
  return abs.startsWith(ROOT) ? abs.replace(`${ROOT}/`, '') : abs.replace(`${HOME}/`, '~/');
}

function countBenchmarkEntries(archivePath = '') {
  if (!archivePath || !existsSync(archivePath)) return 0;
  let count = 0;
  const text = readFileSync(archivePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item?.benchmark || item?.benchmarkRef) count += 1;
    } catch {
      // ignored: parse errors are already counted by buildDgmArchiveEvidence
    }
  }
  return count;
}

function appendJsonLine(path, value) {
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

function runIsolatedDgmArchiveDrill({
  generations = 10,
  tempRoot = tmpdir(),
  nowMs = Date.now(),
  cleanup = true,
} = {}) {
  const dir = mkdtempSync(join(tempRoot, 'noe-self-evolution-readiness-'));
  const archivePath = join(dir, 'archive.jsonl');
  let retained = cleanup !== true;
  try {
    let lastVariantId = '';
    for (let i = 1; i <= generations; i += 1) {
      const entry = buildNoeEvolutionArchiveEntry({
        archivePath,
        ts: nowMs + i,
        proposal: `fixture generation ${i}`,
        verdict: 'tests_passed',
        plan: {
          file: 'src/cognition/NoeWorkspace.js',
          why: 'isolated readiness drill',
          startLine: i,
          endLine: i,
        },
        patchFile: `output/noe-self-evolution-readiness/patch-${i}.diff`,
        parentId: lastVariantId,
        holdoutRef: `output/noe-self-evolution-readiness/holdout-${i}.json`,
        benchmarkRef: `output/noe-self-evolution-readiness/benchmark-${i}.json`,
      });
      lastVariantId = entry.variantId || lastVariantId;
      appendJsonLine(archivePath, entry);
    }
    appendJsonLine(archivePath, buildNoeEvolutionArchiveEntry({
      archivePath,
      ts: nowMs + generations + 1,
      proposal: 'fixture apply final generation',
      verdict: 'applied',
      variantId: lastVariantId,
      patchFile: `output/noe-self-evolution-readiness/patch-${generations}.diff`,
      holdoutRef: `output/noe-self-evolution-readiness/holdout-${generations}.json`,
      benchmarkRef: `output/noe-self-evolution-readiness/benchmark-${generations}.json`,
    }));
    const evidence = buildDgmArchiveEvidence({ archivePath });
    return {
      ok: evidence.variantGenerations >= generations
        && evidence.hasParentChildLineage === true
        && evidence.hasHoldoutEvidence === true
        && evidence.appliedEntries >= 1
        && evidence.parseErrors === 0,
      archiveRetained: retained,
      archivePath: cleanup === true ? '[temporary-deleted]' : rel(archivePath),
      targetGenerations: generations,
      evidence: {
        entries: evidence.entries,
        variantGenerations: evidence.variantGenerations,
        passedVariants: evidence.passedVariants,
        failedVariants: evidence.failedVariants,
        appliedEntries: evidence.appliedEntries,
        parseErrors: evidence.parseErrors,
        lineageEntries: evidence.lineageEntries,
        holdoutEntries: evidence.holdoutEntries,
        benchmarkEntries: countBenchmarkEntries(archivePath),
        hasParentChildLineage: evidence.hasParentChildLineage,
        hasHoldoutEvidence: evidence.hasHoldoutEvidence,
        verdictCounts: evidence.verdictCounts,
      },
    };
  } finally {
    if (cleanup === true) {
      retained = false;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore cleanup failure */ }
    }
  }
}

export function buildNoeSelfEvolutionReadinessAudit({
  liveArchivePath = LIVE_ARCHIVE,
  generations = 10,
  tempRoot = tmpdir(),
  cleanup = true,
  now = new Date(),
} = {}) {
  const liveArchive = buildDgmArchiveEvidence({ archivePath: liveArchivePath });
  const isolatedDrill = runIsolatedDgmArchiveDrill({
    generations,
    tempRoot,
    cleanup,
    nowMs: now instanceof Date ? now.getTime() : new Date(now).getTime(),
  });
  const liveGaps = [];
  if ((liveArchive.variantGenerations || 0) < generations) liveGaps.push('live_dgm_archive_generations_below_target');
  if (!liveArchive.hasParentChildLineage) liveGaps.push('live_dgm_parent_child_lineage_missing');
  if (!liveArchive.hasHoldoutEvidence) liveGaps.push('live_dgm_holdout_or_benchmark_missing');
  if ((liveArchive.appliedEntries || 0) < 1) liveGaps.push('live_dgm_applied_entry_missing');
  return {
    ok: isolatedDrill.ok === true,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    policy: {
      liveArchiveReadOnly: true,
      isolatedArchiveOnly: true,
      noLiveArchiveWrites: true,
      noModelCalls: true,
      noGitWorktree: true,
      noPatchApplication: true,
      noProposalTextOutput: true,
      noSecretOutput: true,
    },
    liveArchive: {
      exists: liveArchive.exists === true,
      archivePath: clean(liveArchive.archivePath || rel(liveArchivePath), 220),
      entries: liveArchive.entries || 0,
      variantGenerations: liveArchive.variantGenerations || 0,
      passedVariants: liveArchive.passedVariants || 0,
      failedVariants: liveArchive.failedVariants || 0,
      appliedEntries: liveArchive.appliedEntries || 0,
      parseErrors: liveArchive.parseErrors || 0,
      lineageEntries: liveArchive.lineageEntries || 0,
      holdoutEntries: liveArchive.holdoutEntries || 0,
      hasParentChildLineage: liveArchive.hasParentChildLineage === true,
      hasHoldoutEvidence: liveArchive.hasHoldoutEvidence === true,
      verdictCounts: liveArchive.verdictCounts || {},
      latestAt: liveArchive.latestAt || null,
      gaps: liveGaps,
    },
    isolatedDrill,
    readiness: {
      status: isolatedDrill.ok ? 'archive_writer_lineage_holdout_ready' : 'archive_writer_drill_failed',
      liveStatus: liveGaps.length ? 'live_archive_still_below_target' : 'live_archive_meets_structure_target',
      liveGaps,
      nextAction: liveGaps.length
        ? 'run controlled future self-improve cycles with holdout/benchmark refs; do not backfill historical archive or hand-edit live records'
        : 'continue monitoring live self-evolution evidence and verify applied self-modification with rollback evidence',
    },
  };
}

function mdTable(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

export function renderMarkdown(report, jsonPath = '') {
  return [
    '# Noe Self-Evolution Readiness Audit',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Verdict',
    '',
    `- ok: ${report.ok}`,
    `- readiness status: \`${report.readiness.status}\``,
    `- live status: \`${report.readiness.liveStatus}\``,
    `- live gaps: ${report.readiness.liveGaps.length ? report.readiness.liveGaps.map((gap) => `\`${gap}\``).join(', ') : '-'}`,
    `- next action: ${clean(report.readiness.nextAction, 280)}`,
    '',
    '## Live Archive',
    '',
    mdTable([
      ['metric', 'value'],
      ['---', '---:'],
      ['entries', String(report.liveArchive.entries)],
      ['variantGenerations', String(report.liveArchive.variantGenerations)],
      ['appliedEntries', String(report.liveArchive.appliedEntries)],
      ['lineageEntries', String(report.liveArchive.lineageEntries)],
      ['holdoutEntries', String(report.liveArchive.holdoutEntries)],
      ['parseErrors', String(report.liveArchive.parseErrors)],
    ]),
    '',
    '## Isolated Drill',
    '',
    mdTable([
      ['metric', 'value'],
      ['---', '---:'],
      ['targetGenerations', String(report.isolatedDrill.targetGenerations)],
      ['variantGenerations', String(report.isolatedDrill.evidence.variantGenerations)],
      ['appliedEntries', String(report.isolatedDrill.evidence.appliedEntries)],
      ['lineageEntries', String(report.isolatedDrill.evidence.lineageEntries)],
      ['holdoutEntries', String(report.isolatedDrill.evidence.holdoutEntries)],
      ['benchmarkEntries', String(report.isolatedDrill.evidence.benchmarkEntries)],
      ['parseErrors', String(report.isolatedDrill.evidence.parseErrors)],
    ]),
    '',
    '## JSON',
    '',
    jsonPath ? `Full report: \`${jsonPath.replace(`${ROOT}/`, '')}\`.` : 'No JSON path supplied.',
  ].join('\n');
}

export function writeNoeSelfEvolutionReadinessAudit(report) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${OUT_BASE}.json`);
  const mdPath = join(OUT_DIR, `${OUT_BASE}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mdPath, `${renderMarkdown(report, jsonPath)}\n`, { mode: 0o600 });
  return { jsonPath, mdPath };
}

export { runIsolatedDgmArchiveDrill };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = buildNoeSelfEvolutionReadinessAudit();
  const paths = writeNoeSelfEvolutionReadinessAudit(report);
  console.log(JSON.stringify({
    ok: report.ok,
    readinessStatus: report.readiness.status,
    liveStatus: report.readiness.liveStatus,
    liveGaps: report.readiness.liveGaps,
    liveVariantGenerations: report.liveArchive.variantGenerations,
    isolatedVariantGenerations: report.isolatedDrill.evidence.variantGenerations,
    isolatedLineageEntries: report.isolatedDrill.evidence.lineageEntries,
    isolatedHoldoutEntries: report.isolatedDrill.evidence.holdoutEntries,
    paths,
  }, null, 2));
}
