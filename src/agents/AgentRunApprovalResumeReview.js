import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import {
  validateFileChange,
  validateVerificationCommand,
  validateWorkEvidenceCommand,
} from './AgentRunVerificationExecutor.js';

const MAX_PREVIEW_LINES = 16;
const MAX_PREVIEW_LINE_CHARS = 220;
const MAX_READ_BYTES = 64 * 1024;

function safeString(value, max = 1000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function safeArray(value, limit = 20) {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

function sha256Text(text) {
  return createHash('sha256').update(String(text || '')).digest('hex');
}

function sha256Json(value) {
  return sha256Text(JSON.stringify(value));
}

function clipLine(line) {
  const value = String(line || '');
  if (value.length <= MAX_PREVIEW_LINE_CHARS) return value;
  return `${value.slice(0, MAX_PREVIEW_LINE_CHARS - 12)} ...truncated`;
}

function readTextSnapshot(filePath) {
  try {
    if (!existsSync(filePath)) return { exists: false, size: 0, sha256: null, content: '' };
    const stat = statSync(filePath);
    if (stat.size > MAX_READ_BYTES) {
      return { exists: true, size: stat.size, sha256: null, content: '', skipped: 'file too large for preview' };
    }
    const content = readFileSync(filePath, 'utf8');
    return {
      exists: true,
      size: Buffer.byteLength(content, 'utf8'),
      sha256: sha256Text(content),
      content,
    };
  } catch (e) {
    return { exists: false, size: 0, sha256: null, content: '', skipped: e.message || String(e) };
  }
}

function splitLogicalLines(text) {
  const lines = String(text || '').split(/\r?\n/);
  if (lines.length === 1 && lines[0] === '') return [];
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function sortedCountMap(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = safeString(keyFn(item), 120) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function extensionKey(path = '') {
  return extname(safeString(path, 2000)).toLowerCase() || 'none';
}

function buildAppendStats(beforeLines, contentLines) {
  return {
    additions: contentLines.length,
    removals: 0,
    netLineChange: contentLines.length,
    beforeLines: beforeLines.length,
    afterLines: beforeLines.length + contentLines.length,
    changed: contentLines.length > 0,
  };
}

function buildNewFileStats(contentLines) {
  return {
    additions: contentLines.length,
    removals: 0,
    netLineChange: contentLines.length,
    beforeLines: 0,
    afterLines: contentLines.length,
    changed: contentLines.length > 0,
  };
}

function buildUnchangedStats(beforeLines, contentLines) {
  return {
    additions: 0,
    removals: 0,
    netLineChange: 0,
    beforeLines: beforeLines.length,
    afterLines: contentLines.length,
    changed: false,
  };
}

function countCommonPrefix(beforeLines, contentLines) {
  let prefix = 0;
  const limit = Math.min(beforeLines.length, contentLines.length);
  while (prefix < limit && beforeLines[prefix] === contentLines[prefix]) {
    prefix += 1;
  }
  return prefix;
}

function countCommonSuffix(beforeLines, contentLines, prefix) {
  let suffix = 0;
  const limit = Math.min(beforeLines.length - prefix, contentLines.length - prefix);
  while (
    suffix < limit
    && beforeLines[beforeLines.length - 1 - suffix] === contentLines[contentLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return suffix;
}

function buildReplaceStats(beforeLines, contentLines, prefix, suffix) {
  const removals = Math.max(0, beforeLines.length - prefix - suffix);
  const additions = Math.max(0, contentLines.length - prefix - suffix);
  return {
    additions,
    removals,
    netLineChange: contentLines.length - beforeLines.length,
    beforeLines: beforeLines.length,
    afterLines: contentLines.length,
    changed: additions > 0 || removals > 0,
  };
}

function buildLineDiffStats(validation = {}, before = {}, content = '') {
  const beforeLines = before.exists ? splitLogicalLines(before.content) : [];
  const contentLines = splitLogicalLines(content);
  if (validation.operation === 'append') return buildAppendStats(beforeLines, contentLines);
  if (!before.exists) return buildNewFileStats(contentLines);
  if (before.content === content) return buildUnchangedStats(beforeLines, contentLines);
  const prefix = countCommonPrefix(beforeLines, contentLines);
  const suffix = countCommonSuffix(beforeLines, contentLines, prefix);
  return buildReplaceStats(beforeLines, contentLines, prefix, suffix);
}

const ATTENTION_FLAG_RULES = [
  { flag: 'blocked_file_change', test: (file) => !file.ok },
  { flag: 'new_file', test: (file) => !file.beforeExists },
  { flag: 'approval_required', test: (file) => file.requiresApproval },
  { flag: 'manual_review', test: (file) => !file.safeToAutoExecute },
];

const SCRIPT_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'];
const CONFIG_EXTENSIONS = ['.json', '.yml', '.yaml', '.toml'];
const UI_SURFACE_EXTENSIONS = ['.html', '.css', '.jsx', '.tsx'];
const PUBLIC_PATH_PREFIX = 'public/';
const LARGE_CHANGE_LINE_THRESHOLD = 120;
const LARGE_CHANGE_BYTE_THRESHOLD = 16 * 1024;
const MAX_ATTENTION_FLAGS = 8;

function isLargeChange(file = {}) {
  const churn = Number(file.diffStats?.additions || 0) + Number(file.diffStats?.removals || 0);
  return churn >= LARGE_CHANGE_LINE_THRESHOLD || Number(file.contentBytes || 0) >= LARGE_CHANGE_BYTE_THRESHOLD;
}

function collectExtensionFlags(ext, path) {
  const flags = [];
  if (SCRIPT_EXTENSIONS.includes(ext)) flags.push('script_change');
  if (CONFIG_EXTENSIONS.includes(ext)) flags.push('config_change');
  if (String(path || '').startsWith(PUBLIC_PATH_PREFIX) || UI_SURFACE_EXTENSIONS.includes(ext)) flags.push('ui_surface_change');
  return flags;
}

function buildAttentionFlags(file = {}) {
  const ext = extensionKey(file.path);
  const flags = [
    ...ATTENTION_FLAG_RULES.filter((rule) => rule.test(file)).map((rule) => rule.flag),
    ...collectExtensionFlags(ext, file.path),
  ];
  if (file.operation === 'create' && file.beforeExists) flags.push('overwrite_candidate');
  if (isLargeChange(file)) flags.push('large_change');
  return [...new Set(flags)].slice(0, MAX_ATTENTION_FLAGS);
}

function normalizedCommandText(command = {}) {
  return safeString(command.command || command, 1000).replace(/\\/g, '/');
}

function commandReferencesPath(command = {}, path = '') {
  const commandText = normalizedCommandText(command);
  const relPath = safeString(path, 2000).replace(/\\/g, '/');
  return Boolean(commandText && relPath && commandText.includes(relPath));
}

function isProjectWideVerificationCommand(command = {}) {
  const commandText = normalizedCommandText(command);
  return Boolean(command?.ok) && (
    commandText === 'npm test'
    || commandText === 'npm run lint'
    || commandText === 'git diff --check'
    || commandText === 'node --test'
  );
}

function isProjectWideWorkEvidenceCommand(command = {}) {
  const commandText = normalizedCommandText(command);
  return Boolean(command?.ok) && [
    'git status --short',
    'git status --porcelain=v1',
    'git diff --name-only',
    'git diff --stat',
    'git branch --show-current',
    'git rev-parse --show-toplevel',
    'git ls-files --modified --others --exclude-standard',
  ].includes(commandText);
}

function commandDigest(commands = []) {
  const payload = safeArray(commands, 20).map(commandGatePayload).filter(command => command.command);
  return payload.length ? sha256Json(payload) : null;
}

function coverageExplanation(kind, status, reason, command = null) {
  const payload = command ? commandGatePayload(command) : null;
  return {
    kind: safeString(kind, 80),
    status: safeString(status, 80),
    command: payload?.command || '',
    ok: payload ? Boolean(payload.ok) : false,
    safeToAutoExecute: payload ? Boolean(payload.safeToAutoExecute) : false,
    reason: safeString(reason, 240),
  };
}

function coverageExplanationSummary(explanations = []) {
  return safeArray(explanations, 6)
    .map((item) => [item.kind, item.status, item.command || item.reason].filter(Boolean).join(':'))
    .join(' | ');
}

function selectFileScopedCommands(commands = [], workEvidenceCommands = [], file = {}) {
  return {
    verificationCommands: safeArray(commands, 20).filter(command => command.ok && commandReferencesPath(command, file.path)),
    workCommands: safeArray(workEvidenceCommands, 20).filter(command => command.ok && commandReferencesPath(command, file.path)),
    projectWideVerificationCommands: safeArray(commands, 20)
      .filter(command => isProjectWideVerificationCommand(command) && !commandReferencesPath(command, file.path)),
    projectWideWorkEvidenceCommands: safeArray(workEvidenceCommands, 20)
      .filter(command => isProjectWideWorkEvidenceCommand(command) && !commandReferencesPath(command, file.path)),
  };
}

function deriveCoverageStatus(file, verificationCommands, projectWideVerificationCommands, workCommands, projectWideWorkEvidenceCommands) {
  if (!file.ok) return 'blocked';
  if (verificationCommands.length) return 'verified';
  if (projectWideVerificationCommands.length) return 'project_wide_verified';
  if (workCommands.length || projectWideWorkEvidenceCommands.length) return 'evidence_only';
  return 'uncovered';
}

function buildCoverageExplanations(file, status, matched) {
  const explanations = [];
  if (!file.ok) {
    explanations.push(coverageExplanation('file', 'blocked', 'file change failed safety validation before command coverage'));
  }
  for (const command of matched.verificationCommands) {
    explanations.push(coverageExplanation('verification', 'matched', 'safe verification command references this file path directly', command));
  }
  for (const command of matched.projectWideVerificationCommands) {
    explanations.push(coverageExplanation('verification', 'project_wide', 'safe project-wide verification command applies to all changed files', command));
  }
  for (const command of matched.workCommands) {
    explanations.push(coverageExplanation('work_evidence', 'matched', 'safe work evidence command references this file path directly', command));
  }
  for (const command of matched.projectWideWorkEvidenceCommands) {
    explanations.push(coverageExplanation('work_evidence', 'project_wide', 'safe project-wide work evidence command records repository state for this change', command));
  }
  if (status === 'project_wide_verified' && !matched.verificationCommands.length) {
    explanations.push(coverageExplanation('gap', 'targeted_verification_missing', 'coverage is project-wide only; add a file-specific verification command for stronger evidence'));
  }
  if (status === 'evidence_only') {
    explanations.push(coverageExplanation('gap', 'verification_missing', 'work evidence exists, but no safe verification command covers this file'));
  }
  if (status === 'uncovered') {
    explanations.push(coverageExplanation('gap', 'uncovered', 'no safe verification or work evidence command references this file'));
  }
  return explanations;
}

function buildCommandCoverage(file = {}, { commands = [], workEvidenceCommands = [] } = {}) {
  const matched = selectFileScopedCommands(commands, workEvidenceCommands, file);
  const status = deriveCoverageStatus(
    file,
    matched.verificationCommands,
    matched.projectWideVerificationCommands,
    matched.workCommands,
    matched.projectWideWorkEvidenceCommands,
  );
  const explanations = buildCoverageExplanations(file, status, matched);
  return {
    status,
    verificationCommandCount: matched.verificationCommands.length,
    workEvidenceCommandCount: matched.workCommands.length,
    projectWideVerificationCommandCount: matched.projectWideVerificationCommands.length,
    projectWideWorkEvidenceCommandCount: matched.projectWideWorkEvidenceCommands.length,
    verificationCommandDigest: commandDigest([...matched.verificationCommands, ...matched.projectWideVerificationCommands]),
    workEvidenceCommandDigest: commandDigest([...matched.workCommands, ...matched.projectWideWorkEvidenceCommands]),
    verificationCommands: matched.verificationCommands.map(commandGatePayload),
    workEvidenceCommands: matched.workCommands.map(commandGatePayload),
    projectWideVerificationCommands: matched.projectWideVerificationCommands.map(commandGatePayload),
    projectWideWorkEvidenceCommands: matched.projectWideWorkEvidenceCommands.map(commandGatePayload),
    coverageExplanations: explanations.slice(0, 12),
    coverageExplanationSummary: coverageExplanationSummary(explanations),
  };
}

function buildCoverageAttentionFlags(flags = [], coverage = {}) {
  const next = safeArray(flags, 10).map(flag => safeString(flag, 80)).filter(Boolean);
  if (coverage.status === 'uncovered') next.push('missing_verification');
  if (coverage.status === 'evidence_only') next.push('verification_missing');
  if (coverage.status === 'project_wide_verified') next.push('project_wide_verification');
  return [...new Set(next)].slice(0, 10);
}

function buildFileRisk(file = {}, coverage = {}) {
  const churn = Number(file.additions || 0) + Number(file.removals || 0);
  const flags = file.attentionFlags;
  const hasFlag = (name) => Array.isArray(flags) && flags.includes(name);
  const rules = [
    [!file.ok, 100, 'blocked file change'],
    [!file.safeToAutoExecute, 35, 'manual review required'],
    [file.requiresApproval, 25, 'explicit approval required'],
    [!file.beforeExists, 10, 'new file'],
    [hasFlag('script_change'), 14, 'script/runtime file'],
    [hasFlag('config_change'), 18, 'configuration file'],
    [hasFlag('ui_surface_change'), 10, 'UI surface change'],
    [hasFlag('large_change'), 30, 'large change'],
    [coverage.status === 'uncovered', 28, 'no matching verification command'],
    [coverage.status === 'evidence_only', 18, 'work evidence without verification'],
    [coverage.status === 'project_wide_verified', 6, 'only project-wide verification'],
  ];
  const reasons = [];
  let score = 0;
  for (const [active, points, reason] of rules) {
    if (!active || !points) continue;
    score += points;
    reasons.push({ points, reason });
  }
  const churnPoints = Math.min(25, Math.ceil(churn / 8));
  if (churnPoints) {
    score += churnPoints;
    reasons.push({ points: churnPoints, reason: `change churn ${churn} lines` });
  }
  let level;
  if (!file.ok) level = 'blocked';
  else if (score >= 70) level = 'high';
  else if (score >= 35) level = 'medium';
  else level = 'low';
  return { score, level, reasons: reasons.slice(0, 8) };
}

function buildFileReviewEntry(file, index, { commands, workEvidenceCommands }) {
  const baseFile = {
    index,
    operation: safeString(file.operation, 40),
    path: safeString(file.path, 2000),
    extension: extensionKey(file.path),
    ok: Boolean(file.ok),
    beforeExists: Boolean(file.beforeExists),
    beforeSize: Number(file.beforeSize || 0),
    contentBytes: Number(file.contentBytes || 0),
    additions: Number(file.diffStats?.additions || 0),
    removals: Number(file.diffStats?.removals || 0),
    netLineChange: Number(file.diffStats?.netLineChange || 0),
    beforeLines: Number(file.diffStats?.beforeLines || 0),
    afterLines: Number(file.diffStats?.afterLines || 0),
    changed: Boolean(file.diffStats?.changed),
    beforeSha256: file.beforeSha256 || null,
    contentSha256: file.contentSha256 || null,
    safeToAutoExecute: Boolean(file.safeToAutoExecute),
    requiresApproval: Boolean(file.requiresApproval),
    attentionFlags: safeArray(file.attentionFlags, 8).map(flag => safeString(flag, 80)).filter(Boolean),
  };
  const commandCoverage = buildCommandCoverage(baseFile, { commands, workEvidenceCommands });
  baseFile.attentionFlags = buildCoverageAttentionFlags(baseFile.attentionFlags, commandCoverage);
  const risk = buildFileRisk(baseFile, commandCoverage);
  return {
    ...baseFile,
    commandCoverage,
    coverageStatus: commandCoverage.status,
    verificationCommandCount: commandCoverage.verificationCommandCount,
    workEvidenceCommandCount: commandCoverage.workEvidenceCommandCount,
    projectWideVerificationCommandCount: commandCoverage.projectWideVerificationCommandCount,
    projectWideWorkEvidenceCommandCount: commandCoverage.projectWideWorkEvidenceCommandCount,
    verificationCommandDigest: commandCoverage.verificationCommandDigest,
    workEvidenceCommandDigest: commandCoverage.workEvidenceCommandDigest,
    coverageExplanations: commandCoverage.coverageExplanations,
    coverageExplanationSummary: commandCoverage.coverageExplanationSummary,
    riskScore: risk.score,
    riskLevel: risk.level,
    riskReasons: risk.reasons,
  };
}

function rankFilesByRisk(files) {
  return [...files].sort((a, b) => (
    b.riskScore - a.riskScore
    || (b.additions + b.removals) - (a.additions + a.removals)
    || a.path.localeCompare(b.path)
  )).map((file, index) => ({
    path: file.path,
    operation: file.operation,
    riskRank: index + 1,
    riskScore: file.riskScore,
    riskLevel: file.riskLevel,
    coverageStatus: file.coverageStatus,
    coverageExplanationSummary: file.coverageExplanationSummary,
    additions: file.additions,
    removals: file.removals,
    attentionFlags: file.attentionFlags,
    riskReasons: file.riskReasons,
  }));
}

function attachRiskRanksToFiles(files, prioritizedFiles) {
  return files.map((file) => {
    const prioritized = prioritizedFiles.find(item => item.path === file.path && item.operation === file.operation);
    return { ...file, riskRank: prioritized?.riskRank || file.index + 1 };
  });
}

function findLargestChange(filesWithRanks) {
  return filesWithRanks.reduce((best, file) => {
    const score = file.additions + file.removals;
    const bestScore = best ? best.additions + best.removals : -1;
    if (!best || score > bestScore || (score === bestScore && file.contentBytes > best.contentBytes)) {
      return {
        path: file.path,
        additions: file.additions,
        removals: file.removals,
        contentBytes: file.contentBytes,
      };
    }
    return best;
  }, null);
}

function buildStagedDiffSummary(filesWithRanks, largestChange, prioritizedFiles) {
  return {
    fileCount: filesWithRanks.length,
    okFileCount: filesWithRanks.filter(file => file.ok).length,
    blockedFileCount: filesWithRanks.filter(file => !file.ok).length,
    newFileCount: filesWithRanks.filter(file => !file.beforeExists).length,
    existingFileCount: filesWithRanks.filter(file => file.beforeExists).length,
    safeToAutoExecuteCount: filesWithRanks.filter(file => file.safeToAutoExecute).length,
    approvalRequiredCount: filesWithRanks.filter(file => file.requiresApproval).length,
    totalAdditions: filesWithRanks.reduce((sum, file) => sum + file.additions, 0),
    totalRemovals: filesWithRanks.reduce((sum, file) => sum + file.removals, 0),
    totalNetLineChange: filesWithRanks.reduce((sum, file) => sum + file.netLineChange, 0),
    totalContentBytes: filesWithRanks.reduce((sum, file) => sum + file.contentBytes, 0),
    attentionFlagCount: filesWithRanks.reduce((sum, file) => sum + file.attentionFlags.length, 0),
    verificationCoveredFileCount: filesWithRanks.filter(file => ['verified', 'project_wide_verified'].includes(file.coverageStatus)).length,
    specificallyVerifiedFileCount: filesWithRanks.filter(file => file.coverageStatus === 'verified').length,
    workEvidenceCoveredFileCount: filesWithRanks.filter(file => file.coverageStatus === 'evidence_only').length,
    uncoveredFileCount: filesWithRanks.filter(file => file.coverageStatus === 'uncovered').length,
    highRiskFileCount: filesWithRanks.filter(file => ['blocked', 'high'].includes(file.riskLevel)).length,
    coverageExplanationCount: filesWithRanks.reduce((sum, file) => sum + safeArray(file.coverageExplanations, 20).length, 0),
    operationCounts: sortedCountMap(filesWithRanks, file => file.operation),
    extensionCounts: sortedCountMap(filesWithRanks, file => file.extension),
    attentionFlagCounts: sortedCountMap(filesWithRanks.flatMap(file => file.attentionFlags), flag => flag),
    coverageStatusCounts: sortedCountMap(filesWithRanks, file => file.coverageStatus),
    riskLevelCounts: sortedCountMap(filesWithRanks, file => file.riskLevel),
    largestChange,
    topRiskFiles: prioritizedFiles.slice(0, 5),
  };
}

function buildComparableStagedFile(file) {
  return {
    operation: file.operation,
    path: file.path,
    extension: file.extension,
    ok: file.ok,
    beforeExists: file.beforeExists,
    additions: file.additions,
    removals: file.removals,
    netLineChange: file.netLineChange,
    beforeSha256: file.beforeSha256,
    contentSha256: file.contentSha256,
    safeToAutoExecute: file.safeToAutoExecute,
    requiresApproval: file.requiresApproval,
    attentionFlags: file.attentionFlags,
    coverageStatus: file.coverageStatus,
    verificationCommandCount: file.verificationCommandCount,
    workEvidenceCommandCount: file.workEvidenceCommandCount,
    projectWideVerificationCommandCount: file.projectWideVerificationCommandCount,
    projectWideWorkEvidenceCommandCount: file.projectWideWorkEvidenceCommandCount,
    verificationCommandDigest: file.verificationCommandDigest,
    workEvidenceCommandDigest: file.workEvidenceCommandDigest,
    coverageExplanations: safeArray(file.coverageExplanations, 12).map(item => ({
      kind: safeString(item?.kind, 80),
      status: safeString(item?.status, 80),
      command: safeString(item?.command, 1000),
      reason: safeString(item?.reason, 240),
    })),
    coverageExplanationSummary: safeString(file.coverageExplanationSummary, 1000),
    riskScore: file.riskScore,
    riskLevel: file.riskLevel,
    riskReasons: safeArray(file.riskReasons, 8).map(item => ({
      points: Number(item?.points || 0),
      reason: safeString(item?.reason, 160),
    })),
    riskRank: file.riskRank,
  };
}

function buildStagedDiffReview(fileChanges = [], { commands = [], workEvidenceCommands = [] } = {}) {
  const files = fileChanges.map((file, index) => buildFileReviewEntry(file, index, { commands, workEvidenceCommands }));
  const prioritizedFiles = rankFilesByRisk(files);
  const filesWithRanks = attachRiskRanksToFiles(files, prioritizedFiles);
  const largestChange = findLargestChange(filesWithRanks);
  const summary = buildStagedDiffSummary(filesWithRanks, largestChange, prioritizedFiles);
  const comparable = {
    summary,
    files: filesWithRanks.map(buildComparableStagedFile),
  };
  const sha256 = sha256Json(comparable);
  return {
    id: `staged-diff-${sha256.slice(0, 12)}`,
    sha256,
    safeToResume: summary.blockedFileCount === 0,
    summary,
    files: filesWithRanks,
    prioritizedFiles,
  };
}

function buildPreviewLines(validation, before = {}) {
  if (!validation?.ok) return [];
  const nextLines = String(validation.content || '').split(/\r?\n/);
  if (validation.operation === 'append' || validation.operation === 'create') {
    return nextLines.slice(0, MAX_PREVIEW_LINES).map(line => `+${clipLine(line)}`);
  }
  if (!before.exists) {
    return nextLines.slice(0, MAX_PREVIEW_LINES).map(line => `+${clipLine(line)}`);
  }
  if (before.content === validation.content) return ['no textual change'];
  const beforeLines = String(before.content || '').split(/\r?\n/);
  const removed = beforeLines.slice(0, Math.min(6, MAX_PREVIEW_LINES / 2)).map(line => `-${clipLine(line)}`);
  const added = nextLines.slice(0, MAX_PREVIEW_LINES - removed.length).map(line => `+${clipLine(line)}`);
  return [...removed, ...added];
}

function reviewCommand(command, validate, cwd) {
  const text = safeString(command, 1000);
  try {
    const result = validate(text, { cwd });
    return {
      command: text,
      ok: Boolean(result.ok),
      reason: result.reason || '',
      safeToAutoExecute: Boolean(result.safeToAutoExecute),
    };
  } catch (e) {
    return {
      command: text,
      ok: false,
      reason: e.message || String(e),
      safeToAutoExecute: false,
    };
  }
}

function commandGatePayload(command = {}) {
  return {
    command: safeString(command.command, 1000),
    ok: Boolean(command.ok),
    reason: safeString(command.reason, 500),
    safeToAutoExecute: Boolean(command.safeToAutoExecute),
  };
}

function buildReviewGateFingerprint({ runId, approvalId, safeToResume, stagedDiffReview, fileChanges, commands, workEvidenceCommands, risks }) {
  return {
    runId: safeString(runId, 160),
    approvalId: safeString(approvalId, 160),
    safeToResume: Boolean(safeToResume),
    stagedDiffReview: stagedDiffReview ? {
      id: safeString(stagedDiffReview.id, 160),
      sha256: safeString(stagedDiffReview.sha256, 128),
      safeToResume: Boolean(stagedDiffReview.safeToResume),
      summary: stagedDiffReview.summary || {},
      files: safeArray(stagedDiffReview.files, 8).map(file => ({
        operation: safeString(file.operation, 40),
        path: safeString(file.path, 2000),
        extension: safeString(file.extension, 40),
        ok: Boolean(file.ok),
        beforeExists: Boolean(file.beforeExists),
        additions: Number(file.additions || 0),
        removals: Number(file.removals || 0),
        netLineChange: Number(file.netLineChange || 0),
        beforeSha256: file.beforeSha256 || null,
        contentSha256: file.contentSha256 || null,
        safeToAutoExecute: Boolean(file.safeToAutoExecute),
        requiresApproval: Boolean(file.requiresApproval),
        attentionFlags: safeArray(file.attentionFlags, 10).map(flag => safeString(flag, 80)),
        coverageStatus: safeString(file.coverageStatus, 80),
        verificationCommandCount: Number(file.verificationCommandCount || 0),
        workEvidenceCommandCount: Number(file.workEvidenceCommandCount || 0),
        projectWideVerificationCommandCount: Number(file.projectWideVerificationCommandCount || 0),
        projectWideWorkEvidenceCommandCount: Number(file.projectWideWorkEvidenceCommandCount || 0),
        verificationCommandDigest: file.verificationCommandDigest || null,
        workEvidenceCommandDigest: file.workEvidenceCommandDigest || null,
        coverageExplanations: safeArray(file.coverageExplanations, 12).map(item => ({
          kind: safeString(item?.kind, 80),
          status: safeString(item?.status, 80),
          command: safeString(item?.command, 1000),
          reason: safeString(item?.reason, 240),
        })),
        coverageExplanationSummary: safeString(file.coverageExplanationSummary, 1000),
        riskScore: Number(file.riskScore || 0),
        riskLevel: safeString(file.riskLevel, 40),
        riskReasons: safeArray(file.riskReasons, 8).map(item => ({
          points: Number(item?.points || 0),
          reason: safeString(item?.reason, 160),
        })),
        riskRank: Number(file.riskRank || 0),
      })),
    } : null,
    fileChanges: fileChanges.map(file => ({
      operation: safeString(file.operation, 40),
      path: safeString(file.path, 2000),
      ok: Boolean(file.ok),
      reason: safeString(file.reason, 500),
      beforeExists: Boolean(file.beforeExists),
      beforeSha256: file.beforeSha256 || null,
      contentBytes: Number(file.contentBytes || 0),
      contentSha256: file.contentSha256 || null,
      safeToAutoExecute: Boolean(file.safeToAutoExecute),
    })),
    commands: commands.map(commandGatePayload),
    workEvidenceCommands: workEvidenceCommands.map(commandGatePayload),
    risks: safeArray(risks, 12).map(risk => safeString(risk, 1000)),
  };
}

function buildReviewGate({ runId = '', approvalId = '', safeToResume = false, fileChanges = [], commands = [], workEvidenceCommands = [], risks = [], stagedDiffReview = null } = {}) {
  const fingerprint = buildReviewGateFingerprint({
    runId,
    approvalId,
    safeToResume,
    stagedDiffReview,
    fileChanges,
    commands,
    workEvidenceCommands,
    risks,
  });
  const sha256 = sha256Json(fingerprint);
  return {
    id: `review-${sha256.slice(0, 12)}`,
    sha256,
    required: true,
    safeToResume: Boolean(safeToResume),
    generatedAt: Date.now(),
  };
}

/**
 * Finds the latest approval resume manifest from the timeline messages or run details.
 * It iterates through messages in reverse order to find the most recent manifest
 * matching the target approvalId (or any manifest if approvalId is empty).
 *
 * @param {Object} timeline - The timeline object containing messages and run details.
 * @param {string} [approvalId=''] - The specific approval ID to match. If empty, returns the first found manifest.
 * @returns {Object|null} The matching resume manifest object, or null if not found.
 */
export function latestApprovalResumeManifest(timeline = {}, approvalId = '') {
  const targetApprovalId = safeString(approvalId, 160);
  const messages = Array.isArray(timeline.messages) ? timeline.messages : [];
  for (const message of [...messages].reverse()) {
    const manifest = message.payload?.resumeManifest || message.payload?.pendingResumeManifest;
    if (!manifest || typeof manifest !== 'object') continue;
    const manifestApprovalId = safeString(manifest.approvalId, 160);
    if (!targetApprovalId || !manifestApprovalId || manifestApprovalId === targetApprovalId) return manifest;
  }
  const detailsManifest = timeline.run?.details?.pendingResumeManifest;
  if (detailsManifest && typeof detailsManifest === 'object') {
    const manifestApprovalId = safeString(detailsManifest.approvalId, 160);
    if (!targetApprovalId || !manifestApprovalId || manifestApprovalId === targetApprovalId) return detailsManifest;
  }
  return null;
}

/**
 * Builds a comprehensive approval resume review object from a manifest.
 *
 * This function processes file changes, verification commands, and work evidence
 * commands to produce a structured review object including risk assessment,
 * coverage analysis, and a review gate for approval decisions.
 *
 * @param {Object} [manifest={}] - The resume manifest object containing file changes, commands, and evidence.
 * @param {Object} [options={}] - Configuration options.
 * @param {string} [options.cwd=process.cwd()] - The current working directory for resolving relative paths.
 * @param {string} [options.runId=''] - The run ID associated with this review.
 * @returns {Object} The structured review object containing:
 *   - approvalId: The unique approval identifier.
 *   - cwd: The effective current working directory.
 *   - safeToResume: Boolean indicating if all changes and commands are safe.
 *   - gate: The review gate object containing ID, SHA256, and status.
 *   - reviewGateId: The ID of the review gate.
 *   - reviewSha256: The SHA256 hash of the review gate.
 *   - fileChangeCount: Number of file changes processed.
 *   - commandCount: Number of verification commands.
 *   - workEvidenceCommandCount: Number of work evidence commands.
 *   - evidenceArtifactCount: Number of evidence artifacts.
 *   - stagedDiffReview: The staged diff review object.
 *   - diffReview: Alias for stagedDiffReview.
 *   - fileChanges: Array of processed file change objects.
 *   - commands: Array of reviewed verification commands.
 *   - workEvidenceCommands: Array of reviewed work evidence commands.
 *   - evidenceArtifacts: Array of evidence artifact objects.
 *   - risks: Array of risk strings.
 */
export function buildApprovalResumeReview(manifest = {}, { cwd = process.cwd(), runId = '' } = {}) {
  const effectiveCwd = resolve(safeString(manifest.cwd, 2000) || cwd || process.cwd());
  const fileChanges = safeArray(manifest.fileChanges, 8).map((change) => {
    const validation = validateFileChange(change, { cwd: effectiveCwd });
    const before = validation.ok ? readTextSnapshot(validation.targetPath) : { exists: false, size: 0, sha256: null, content: '' };
    const content = validation.ok ? validation.content : safeString(change?.content || change?.text || '', MAX_READ_BYTES);
    const file = {
      operation: validation.operation || safeString(change?.operation || change?.action || 'update', 40),
      path: validation.relativePath || safeString(change?.path || change?.filePath || change?.file, 2000),
      summary: validation.summary || safeString(change?.summary || change?.reason || '', 500),
      ok: Boolean(validation.ok),
      reason: validation.reason || '',
      requiresApproval: Boolean(change?.requiresApproval || change?.approvalRequired || change?.requireApproval),
      beforeExists: Boolean(before.exists),
      beforeSize: before.size || 0,
      beforeSha256: before.sha256 || null,
      contentBytes: Buffer.byteLength(content || '', 'utf8'),
      contentSha256: content ? sha256Text(content) : null,
      previewLines: buildPreviewLines(validation, before),
      previewSkipped: before.skipped || '',
      safeToAutoExecute: Boolean(validation.safeToAutoExecute),
    };
    file.extension = extensionKey(file.path);
    file.diffStats = buildLineDiffStats(validation, before, content);
    file.attentionFlags = buildAttentionFlags(file);
    return file;
  });
  const verificationCommands = safeArray(manifest.commands, 20)
    .map(command => reviewCommand(command, validateVerificationCommand, effectiveCwd));
  const workEvidenceCommands = safeArray(manifest.workEvidenceCommands, 20)
    .map(command => reviewCommand(command, validateWorkEvidenceCommand, effectiveCwd));
  const stagedDiffReview = buildStagedDiffReview(fileChanges, {
    commands: verificationCommands,
    workEvidenceCommands,
  });
  for (const file of fileChanges) {
    const reviewed = stagedDiffReview.files.find(item => item.path === file.path && item.operation === file.operation);
    if (!reviewed) continue;
    file.attentionFlags = reviewed.attentionFlags;
    file.commandCoverage = reviewed.commandCoverage;
    file.coverageStatus = reviewed.coverageStatus;
    file.coverageExplanations = reviewed.coverageExplanations;
    file.coverageExplanationSummary = reviewed.coverageExplanationSummary;
    file.riskScore = reviewed.riskScore;
    file.riskLevel = reviewed.riskLevel;
    file.riskReasons = reviewed.riskReasons;
    file.riskRank = reviewed.riskRank;
  }
  const evidenceArtifacts = safeArray(manifest.evidenceArtifacts, 12).map(item => ({
    kind: safeString(item?.kind || item?.type || 'artifact', 80),
    label: safeString(item?.label || item?.title || item?.path || '', 200),
    path: safeString(item?.path || item?.filePath || item?.file || '', 2000),
    exists: Boolean(item?.exists),
    size: Number(item?.size || 0),
  }));
  const unsafeFileChanges = fileChanges.filter(item => !item.ok);
  const unsafeCommands = [...verificationCommands, ...workEvidenceCommands].filter(item => !item.ok);
  const approvalId = safeString(manifest.approvalId, 160);
  const safeToResume = unsafeFileChanges.length === 0 && unsafeCommands.length === 0;
  const risks = [
    ...unsafeFileChanges.map(item => `file:${item.path}:${item.reason}`),
    ...unsafeCommands.map(item => `command:${item.command}:${item.reason}`),
  ].slice(0, 12);
  const gate = buildReviewGate({
    runId,
    approvalId,
    safeToResume,
    fileChanges,
    commands: verificationCommands,
    workEvidenceCommands,
    risks,
    stagedDiffReview,
  });
  return {
    approvalId,
    cwd: effectiveCwd,
    safeToResume,
    gate,
    reviewGateId: gate.id,
    reviewSha256: gate.sha256,
    fileChangeCount: fileChanges.length,
    commandCount: verificationCommands.length,
    workEvidenceCommandCount: workEvidenceCommands.length,
    evidenceArtifactCount: evidenceArtifacts.length,
    stagedDiffReview,
    diffReview: stagedDiffReview,
    fileChanges,
    commands: verificationCommands,
    workEvidenceCommands,
    evidenceArtifacts,
    risks,
  };
}

/**
 * Builds a standardized audit object for an approval/resume gate review.
 * This function normalizes and sanitizes review data into a consistent structure
 * suitable for logging, persistence, or further processing.
 *
 * @param {Object} review - The raw review object containing gate details, counts, and artifacts.
 * @param {Object} [options] - Optional configuration for the audit record.
 * @param {string} [options.status='reviewed'] - The status of the review (e.g., 'reviewed', 'approved').
 * @param {string} [options.recordedBy='system'] - The identifier of the entity that recorded this audit.
 * @returns {Object} A structured audit object containing gate ID, SHA256, status, counts, files, commands, and risks.
 */
export function buildApprovalResumeGateAudit(review = {}, { status = 'reviewed', recordedBy = 'system' } = {}) {
  const gate = review.gate || {};
  return {
    id: safeString(gate.id || review.reviewGateId, 160),
    sha256: safeString(gate.sha256 || review.reviewSha256, 128),
    status: safeString(status, 80) || 'reviewed',
    approvalId: safeString(review.approvalId, 160),
    safeToResume: Boolean(review.safeToResume && gate.safeToResume !== false),
    recordedAt: new Date().toISOString(),
    recordedBy: safeString(recordedBy, 120) || 'system',
    counts: {
      fileChanges: Number(review.fileChangeCount) || 0,
      commands: Number(review.commandCount) || 0,
      workEvidenceCommands: Number(review.workEvidenceCommandCount) || 0,
      evidenceArtifacts: Number(review.evidenceArtifactCount) || 0,
      risks: Array.isArray(review.risks) ? review.risks.length : 0,
    },
    files: safeArray(review.fileChanges, 8).map(item => ({
      operation: safeString(item.operation, 40),
      path: safeString(item.path, 2000),
      beforeSha256: item.beforeSha256 || null,
      contentSha256: item.contentSha256 || null,
      safeToAutoExecute: Boolean(item.safeToAutoExecute),
    })),
    commands: safeArray(review.commands, 8).map(commandGatePayload),
    workEvidenceCommands: safeArray(review.workEvidenceCommands, 8).map(commandGatePayload),
    stagedDiffReview: review.stagedDiffReview || review.diffReview || null,
    risks: safeArray(review.risks, 12).map(risk => safeString(risk, 1000)),
  };
}

/**
 * Verifies that the approval resume review gate is valid and safe to resume.
 *
 * @param {Object|null} review - The review object containing the gate and safeToResume flag.
 * @param {Object} options - Options for verification.
 * @param {string} options.reviewGateId - The expected gate ID.
 * @param {string} options.reviewSha256 - The expected gate SHA256 hash.
 * @returns {{ ok: boolean, status: number, error: string, gate: Object|null }} Verification result.
 */
export function verifyApprovalResumeReviewGate(review = null, { reviewGateId = '', reviewSha256 = '' } = {}) {
  if (!review || typeof review !== 'object') {
    return { ok: false, status: 400, error: 'approval resume review not found', gate: null };
  }
  const gate = review.gate || null;
  if (!gate?.id || !gate?.sha256) {
    return { ok: false, status: 400, error: 'approval resume review gate not found', gate };
  }
  if (!review.safeToResume || !gate.safeToResume) {
    return { ok: false, status: 409, error: 'approval resume review is not safe to resume', gate };
  }
  const expectedId = safeString(reviewGateId, 160);
  const expectedSha = safeString(reviewSha256, 128);
  if (!expectedId || !expectedSha) {
    return { ok: false, status: 428, error: 'approval resume review gate required', gate };
  }
  if (expectedId !== gate.id || expectedSha !== gate.sha256) {
    return { ok: false, status: 409, error: 'approval resume review gate mismatch', gate };
  }
  return { ok: true, status: 200, error: '', gate };
}
