#!/usr/bin/env node
// @ts-check
// No-body line-semantics audit for Neo/Noe.
// Read-only: classifies every inventoried source line by line kind, symbol context, feature tag, and runtime proof.
// It does not export file bodies, does not read env files, and does not call DB/network/model providers.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ATLAS_PATH = process.env.NOE_FULL_CODE_ATLAS_PATH || join(ROOT, 'output', 'noe-audit', 'full-code-function-atlas-2026-06-15.json');
const OUT_DIR = process.env.NOE_LINE_SEMANTICS_OUT_DIR || join(ROOT, 'output', 'noe-audit');
const OUT_BASE = process.env.NOE_LINE_SEMANTICS_BASENAME || 'line-semantics-audit-2026-06-15';
const MAX_UNCOVERED_RANGES_PER_FILE = 16;
const MAX_MD_FILE_ROWS = 180;
const MAX_MD_MODULE_ROWS = 80;

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '', max = 240) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function pct(n, d) {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
}

function countLines(text = '') {
  if (!text) return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

function splitLines(text = '') {
  if (!text) return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

function inc(counts, key, amount = 1) {
  counts[key] = (counts[key] || 0) + amount;
}

function lineKind(trimmed = '', inBlockComment = false) {
  if (!trimmed) return 'blank';
  if (inBlockComment) return 'comment';
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('*/')) {
    return 'comment';
  }
  if (/^import\b/.test(trimmed) || /^export\s+(?:\{|\*)/.test(trimmed)) return 'import_export';
  if (/^(?:export\s+)?(?:async\s+)?function\b/.test(trimmed)
    || /^(?:export\s+)?class\b/.test(trimmed)
    || /^(?:export\s+)?(?:const|let|var)\s+[$A-Z_a-z][$\w]*\s*=\s*(?:async\s*)?(?:\([^)]*\)|[$A-Z_a-z][$\w]*)\s*=>/.test(trimmed)
    || /^(?:export\s+)?(?:const|let|var)\s+[$A-Z_a-z][$\w]*\s*=\s*(?:function|class)\b/.test(trimmed)) {
    return 'declaration';
  }
  if (/^(?:if|else|for|while|switch|case|default|try|catch|finally|return|throw|await|break|continue)\b/.test(trimmed)) {
    return 'control_flow';
  }
  if (/^(?:const|let|var)\b/.test(trimmed)) return 'state_or_binding';
  if (/^[}\]);,]+$/.test(trimmed)) return 'syntax';
  return 'expression_or_literal';
}

function updateBlockCommentState(trimmed = '', inBlockComment = false) {
  let next = inBlockComment;
  if (!next && trimmed.includes('/*') && !trimmed.includes('*/')) next = true;
  if (next && trimmed.includes('*/')) next = false;
  return next;
}

function mergedRanges(lineNumbers = [], maxRanges = MAX_UNCOVERED_RANGES_PER_FILE) {
  const sorted = [...new Set(lineNumbers)].sort((a, b) => a - b);
  const ranges = [];
  for (const line of sorted) {
    const last = ranges[ranges.length - 1];
    if (!last || line > last.endLine + 1) {
      ranges.push({ startLine: line, endLine: line, lines: 1 });
    } else {
      last.endLine = line;
      last.lines += 1;
    }
  }
  return {
    totalRanges: ranges.length,
    ranges: ranges.slice(0, maxRanges),
    truncated: ranges.length > maxRanges,
  };
}

function buildSymbolLineIndex(symbolBlocks = []) {
  const index = new Map();
  for (const block of arr(symbolBlocks)) {
    const start = Number(block.startLine) || 0;
    const end = Number(block.endLine) || start;
    if (start <= 0) continue;
    for (let line = start; line <= Math.max(start, end); line += 1) {
      if (!index.has(line)) index.set(line, []);
      index.get(line).push({
        kind: clean(block.kind || '', 80),
        name: clean(block.name || '', 160),
      });
    }
  }
  return index;
}

function classifyFileLines({ fileAudit = {}, root = ROOT } = {}) {
  const relFile = clean(fileAudit.file || '', 500);
  const abs = resolve(root, relFile);
  let text = '';
  let readOk = false;
  try {
    text = readFileSync(abs, 'utf8');
    readOk = true;
  } catch {
    text = '';
  }
  const expectedLines = Number(fileAudit.lines) || countLines(text);
  const lines = readOk ? splitLines(text) : [];
  const actualLines = readOk ? lines.length : 0;
  const symbolIndex = buildSymbolLineIndex(fileAudit.symbolBlocks);
  const counts = {
    blank: 0,
    comment: 0,
    import_export: 0,
    declaration: 0,
    control_flow: 0,
    state_or_binding: 0,
    syntax: 0,
    expression_or_literal: 0,
  };
  let inBlockComment = false;
  let codeLikeLines = 0;
  let symbolCoveredLines = 0;
  let symbolCoveredCodeLines = 0;
  const topLevelCodeLineNumbers = [];
  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const trimmed = String(lines[i] || '').trim();
    const kind = lineKind(trimmed, inBlockComment);
    inc(counts, kind);
    const codeLike = kind !== 'blank' && kind !== 'comment';
    const symbolCovered = symbolIndex.has(lineNo);
    if (codeLike) codeLikeLines += 1;
    if (symbolCovered) symbolCoveredLines += 1;
    if (symbolCovered && codeLike) symbolCoveredCodeLines += 1;
    if (codeLike && !symbolCovered) topLevelCodeLineNumbers.push(lineNo);
    inBlockComment = updateBlockCommentState(trimmed, inBlockComment);
  }
  const topLevel = mergedRanges(topLevelCodeLineNumbers);
  return {
    file: relFile,
    module: clean(fileAudit.module || 'unknown', 120),
    role: clean(fileAudit.role || '', 160),
    usefulness: clean(fileAudit.usefulness || '', 120),
    runtimeProof: clean(fileAudit.runtime?.proof || '', 120),
    featureTags: arr(fileAudit.featureTags).map((tag) => clean(tag, 80)),
    nextAction: clean(fileAudit.nextAction || '', 180),
    readOk,
    lines: expectedLines,
    actualLines,
    classifiedLines: readOk ? actualLines : 0,
    lineKindCounts: counts,
    codeLikeLines,
    symbolBlocks: arr(fileAudit.symbolBlocks).length,
    symbolCoveredLines,
    symbolCoveredCodeLines,
    symbolCoveredCodePct: pct(symbolCoveredCodeLines, codeLikeLines),
    topLevelCodeLines: topLevelCodeLineNumbers.length,
    topLevelCodeRanges: topLevel.ranges,
    topLevelCodeRangeCount: topLevel.totalRanges,
    topLevelCodeRangesTruncated: topLevel.truncated,
    parse: {
      ok: fileAudit.parse?.ok === true,
      errors: arr(fileAudit.parse?.errors).map((error) => clean(error, 160)),
    },
  };
}

function sumCount(files, key) {
  return files.reduce((sum, file) => sum + (Number(file[key]) || 0), 0);
}

function aggregateKindCounts(files = []) {
  const counts = {};
  for (const file of files) {
    for (const [key, value] of Object.entries(file.lineKindCounts || {})) inc(counts, key, Number(value) || 0);
  }
  return counts;
}

function topEntries(counts = {}, max = 5) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max);
}

function aggregateByModule(files = []) {
  const modules = new Map();
  for (const file of files) {
    if (!modules.has(file.module)) {
      modules.set(file.module, {
        module: file.module,
        files: 0,
        lines: 0,
        codeLikeLines: 0,
        symbolCoveredCodeLines: 0,
        topLevelCodeLines: 0,
        readFailures: 0,
        runtimeProofCounts: {},
        usefulnessCounts: {},
        featureTagCounts: {},
      });
    }
    const item = modules.get(file.module);
    item.files += 1;
    item.lines += Number(file.lines) || 0;
    item.codeLikeLines += Number(file.codeLikeLines) || 0;
    item.symbolCoveredCodeLines += Number(file.symbolCoveredCodeLines) || 0;
    item.topLevelCodeLines += Number(file.topLevelCodeLines) || 0;
    if (!file.readOk) item.readFailures += 1;
    inc(item.runtimeProofCounts, file.runtimeProof || 'unknown');
    inc(item.usefulnessCounts, file.usefulness || 'unknown');
    for (const tag of arr(file.featureTags)) inc(item.featureTagCounts, tag);
  }
  return [...modules.values()]
    .map((item) => ({
      ...item,
      symbolCoveredCodePct: pct(item.symbolCoveredCodeLines, item.codeLikeLines),
      topRuntimeProofs: topEntries(item.runtimeProofCounts, 4),
      topUsefulness: topEntries(item.usefulnessCounts, 3),
      topFeatureTags: topEntries(item.featureTagCounts, 5),
    }))
    .sort((a, b) => b.lines - a.lines || b.files - a.files || a.module.localeCompare(b.module));
}

function aggregateByFeature(files = []) {
  const features = new Map();
  for (const file of files) {
    for (const tag of arr(file.featureTags)) {
      if (!features.has(tag)) {
        features.set(tag, {
          tag,
          files: 0,
          lines: 0,
          codeLikeLines: 0,
          symbolCoveredCodeLines: 0,
          topLevelCodeLines: 0,
          modules: {},
          runtimeProofCounts: {},
        });
      }
      const item = features.get(tag);
      item.files += 1;
      item.lines += Number(file.lines) || 0;
      item.codeLikeLines += Number(file.codeLikeLines) || 0;
      item.symbolCoveredCodeLines += Number(file.symbolCoveredCodeLines) || 0;
      item.topLevelCodeLines += Number(file.topLevelCodeLines) || 0;
      inc(item.modules, file.module);
      inc(item.runtimeProofCounts, file.runtimeProof || 'unknown');
    }
  }
  return [...features.values()]
    .map((item) => ({
      ...item,
      symbolCoveredCodePct: pct(item.symbolCoveredCodeLines, item.codeLikeLines),
      topModules: topEntries(item.modules, 5),
      topRuntimeProofs: topEntries(item.runtimeProofCounts, 4),
    }))
    .sort((a, b) => b.lines - a.lines || b.files - a.files || a.tag.localeCompare(b.tag));
}

export function buildNoeLineSemanticsAudit({
  atlasPath = ATLAS_PATH,
  root = ROOT,
  now = new Date(),
} = {}) {
  if (!existsSync(atlasPath)) throw new Error(`full-code atlas not found: ${atlasPath}`);
  const atlas = readJson(atlasPath);
  const atlasFiles = arr(atlas.files);
  const files = atlasFiles.map((fileAudit) => classifyFileLines({
    fileAudit,
    root: root || atlas.root || ROOT,
  }));
  const lines = sumCount(files, 'lines');
  const classifiedLines = sumCount(files, 'classifiedLines');
  const codeLikeLines = sumCount(files, 'codeLikeLines');
  const symbolCoveredCodeLines = sumCount(files, 'symbolCoveredCodeLines');
  const topLevelCodeLines = sumCount(files, 'topLevelCodeLines');
  const readFailures = files.filter((file) => !file.readOk).length;
  const parseFailures = files.filter((file) => !file.parse.ok).length;
  const lineClassificationOk = readFailures === 0 && classifiedLines === lines;
  const summary = {
    files: files.length,
    lines,
    classifiedLines,
    classifiedLineCoveragePct: pct(classifiedLines, lines),
    readFailures,
    parseFailures,
    codeLikeLines,
    symbolCoveredCodeLines,
    symbolCoveredCodePct: pct(symbolCoveredCodeLines, codeLikeLines),
    topLevelCodeLines,
    topLevelCodePct: pct(topLevelCodeLines, codeLikeLines),
    filesWithTopLevelCode: files.filter((file) => file.topLevelCodeLines > 0).length,
    lineKindCounts: aggregateKindCounts(files),
  };
  return {
    ok: true,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    root: atlas.root || root,
    inputs: {
      atlasPath,
      atlasGeneratedAt: atlas.generatedAt || '',
    },
    policy: {
      readOnlyFiles: true,
      noDbWrites: true,
      noEnvFileReads: true,
      noOwnerTokenReads: true,
      noModelCalls: true,
      noNetworkCalls: true,
      noSecretValuesReturned: true,
      fileBodiesNotExported: true,
      lineBodiesNotExported: true,
    },
    status: {
      lineClassification: lineClassificationOk ? 'all_lines_classified_no_body' : 'line_classification_incomplete',
      semanticSignoff: 'not_claimed',
      explanation: lineClassificationOk
        ? 'Every atlas line is classified by no-body line kind and mapped to file/module/feature/runtime context; this is not a human/model line-by-line semantic signoff.'
        : 'Some atlas lines could not be read/classified; fix read failures before using this as full-code traceability evidence.',
    },
    summary,
    byModule: aggregateByModule(files),
    byFeature: aggregateByFeature(files),
    files: files.sort((a, b) => b.topLevelCodeLines - a.topLevelCodeLines || b.lines - a.lines || a.file.localeCompare(b.file)),
  };
}

function mdTable(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function renderCountPairs(entries = []) {
  return entries.map(([key, value]) => `${key}:${value}`).join('<br>') || '-';
}

export function renderMarkdown(report, jsonPath = '') {
  const moduleRows = report.byModule.slice(0, MAX_MD_MODULE_ROWS).map((item) => [
    `\`${item.module}\``,
    String(item.files),
    String(item.lines),
    String(item.codeLikeLines),
    `${item.symbolCoveredCodePct}%`,
    String(item.topLevelCodeLines),
    renderCountPairs(item.topRuntimeProofs),
    renderCountPairs(item.topFeatureTags),
  ]);
  const fileRows = report.files
    .filter((file) => file.topLevelCodeLines > 0 || !file.readOk || !file.parse.ok)
    .slice(0, MAX_MD_FILE_ROWS)
    .map((file) => [
      `\`${file.file}\``,
      String(file.lines),
      file.usefulness || '-',
      file.runtimeProof || '-',
      String(file.codeLikeLines),
      `${file.symbolCoveredCodePct}%`,
      String(file.topLevelCodeLines),
      file.topLevelCodeRanges.map((range) => `${range.startLine}-${range.endLine}`).join('<br>') || '-',
      file.nextAction || '-',
    ]);
  return [
    '# Neo Line Semantics Audit',
    '',
    `Generated: ${report.generatedAt}`,
    `Atlas: ${report.inputs.atlasGeneratedAt || '-'}`,
    '',
    '## Verdict',
    '',
    `- line classification: \`${report.status.lineClassification}\``,
    `- semantic signoff: \`${report.status.semanticSignoff}\``,
    `- explanation: ${report.status.explanation}`,
    '',
    '## Summary',
    '',
    `- files: ${report.summary.files}; lines: ${report.summary.lines}; classified lines: ${report.summary.classifiedLines} (${report.summary.classifiedLineCoveragePct}%)`,
    `- code-like lines: ${report.summary.codeLikeLines}; symbol-covered code lines: ${report.summary.symbolCoveredCodeLines} (${report.summary.symbolCoveredCodePct}%)`,
    `- top-level/unscoped code lines: ${report.summary.topLevelCodeLines} (${report.summary.topLevelCodePct}%); files with top-level code: ${report.summary.filesWithTopLevelCode}`,
    `- read failures: ${report.summary.readFailures}; parse failures inherited from atlas: ${report.summary.parseFailures}`,
    `- line kind counts: ${renderCountPairs(topEntries(report.summary.lineKindCounts, 10))}`,
    '',
    '## By Module',
    '',
    mdTable([
      ['module', 'files', 'lines', 'code-like', 'symbol-covered code', 'top-level code', 'runtime proofs', 'feature tags'],
      ['---', '---:', '---:', '---:', '---:', '---:', '---', '---'],
      ...moduleRows,
    ]),
    '',
    '## Top-Level / Unscoped Code Ranges',
    '',
    mdTable([
      ['file', 'lines', 'usefulness', 'runtime proof', 'code-like', 'symbol-covered', 'top-level lines', 'sample ranges', 'next action'],
      ['---', '---:', '---', '---', '---:', '---:', '---:', '---', '---'],
      ...fileRows,
    ]),
    '',
    '## JSON',
    '',
    jsonPath ? `Full no-body line audit: \`${jsonPath.replace(`${ROOT}/`, '')}\`.` : 'No JSON path supplied.',
    '',
    '## Policy',
    '',
    '- no source line bodies exported',
    '- no `.env`, owner-token, DB, model, or network access',
    '- line classification is traceability evidence, not a claim of subjective or exhaustive human understanding',
  ].join('\n');
}

export function writeNoeLineSemanticsAudit(report) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${OUT_BASE}.json`);
  const mdPath = join(OUT_DIR, `${OUT_BASE}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mdPath, `${renderMarkdown(report, jsonPath)}\n`, { mode: 0o600 });
  return { jsonPath, mdPath };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = buildNoeLineSemanticsAudit();
  const paths = writeNoeLineSemanticsAudit(report);
  console.log(JSON.stringify({
    ok: report.ok,
    lineClassification: report.status.lineClassification,
    semanticSignoff: report.status.semanticSignoff,
    files: report.summary.files,
    lines: report.summary.lines,
    classifiedLineCoveragePct: report.summary.classifiedLineCoveragePct,
    codeLikeLines: report.summary.codeLikeLines,
    symbolCoveredCodePct: report.summary.symbolCoveredCodePct,
    topLevelCodeLines: report.summary.topLevelCodeLines,
    readFailures: report.summary.readFailures,
    paths,
  }, null, 2));
}
