import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { agentRunStore as defaultAgentRunStore } from './AgentRunStore.js';
import { permissionGovernance as defaultPermissionGovernance } from '../permissions/PermissionGovernance.js';

const SAFE_NPM_RUN_SCRIPTS = new Set(['lint', 'test:e2e', 'perf-check', 'lint:baseline']);
const SAFE_NODE_SCRIPT_COMMANDS = new Set([
  'scripts/perf-check.mjs',
  'scripts/eslint-baseline-check.js',
  'tests/e2e/panel-ui-walkthrough.mjs',
]);
const SAFE_WORK_EVIDENCE_COMMANDS = new Set([
  'git status --short',
  'git status --porcelain=v1',
  'git diff --name-only',
  'git diff --stat',
  'git branch --show-current',
  'git rev-parse --show-toplevel',
  'git ls-files --modified --others --exclude-standard',
]);
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 4_000;
const MAX_FILE_CHANGE_BYTES = 64 * 1024;
const SAFE_FILE_CHANGE_ROOTS = [
  'src/',
  'public/',
  'tests/',
  'docs/',
  'scripts/',
  'output/playwright/',
  '任务交接.md',
  '上下文交接.md',
];
const SAFE_FILE_CHANGE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.json',
  '.md',
  '.css',
  '.html',
  '.txt',
  '.yml',
  '.yaml',
  '.toml',
]);

function safeString(value, max = 1000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function safeContent(value, max = MAX_FILE_CHANGE_BYTES) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max);
}

function normalizeArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 20);
}

function clipOutput(text, max = MAX_OUTPUT_CHARS) {
  const value = safeString(text, max * 2);
  if (value.length <= max) return value;
  return `${value.slice(0, max - 120)}\n...output truncated...`;
}

function processChar(args, parser, char) {
  if (parser.escaping) {
    parser.escaping = false;
    parser.current += char;
    return;
  }
  if (char === '\\') {
    parser.escaping = true;
    return;
  }
  if (parser.quote) {
    if (char === parser.quote) {
      parser.quote = '';
    } else {
      parser.current += char;
    }
    return;
  }
  if (char === '"' || char === "'") {
    parser.quote = char;
    return;
  }
  if (/\s/.test(char)) {
    if (parser.current) {
      args.push(parser.current);
      parser.current = '';
    }
    return;
  }
  parser.current += char;
}

function finalizeParser(args, parser) {
  if (parser.escaping) parser.current += '\\';
  if (parser.quote) throw new Error('unterminated quote in verification command');
  if (parser.current) args.push(parser.current);
}

/**
 * Parses a command line string into an array of arguments, respecting quotes and escapes.
 * @param {string} command - The raw command line string to parse.
 * @returns {string[]} An array of parsed argument strings.
 * @throws {Error} If the command contains an unterminated quote.
 */
export function parseCommandLine(command) {
  const text = safeString(command, 4000);
  const args = [];
  const parser = { current: '', quote: '', escaping: false };
  for (const char of text) {
    processChar(args, parser, char);
  }
  finalizeParser(args, parser);
  return args;
}

function commandInsideCwd(cwd, maybePath) {
  const value = safeString(maybePath, 2000);
  if (!value || value.startsWith('-')) return true;
  const target = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  const rel = relative(resolve(cwd), target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function safeCommandFile(cwd, maybePath, allowedExtensions = SAFE_FILE_CHANGE_EXTENSIONS) {
  const value = safeString(maybePath, 2000);
  if (!value || value.startsWith('-')) return false;
  const relPath = normalizedRelativePath(cwd, value);
  if (!relPath || isSensitiveRelativePath(relPath)) return false;
  if (!allowedExtensions.has(extname(relPath))) return false;
  return commandInsideCwd(cwd, value);
}

function normalizedRelativePath(cwd, maybePath) {
  const value = safeString(maybePath, 2000);
  if (!value) return '';
  const target = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  const rel = relative(resolve(cwd), target).replace(/\\/g, '/');
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return '';
  return rel;
}

function isSensitiveRelativePath(relPath) {
  return /(^|\/)(\.git|node_modules|dist|out)(\/|$)/.test(relPath)
    || /(^|\/)(\.ssh|\.aws|\.gnupg|\.docker|\.kube)(\/|$)/.test(relPath)
    || /(^|\/)\.env(\.|$|\/)?/.test(relPath)
    || /(^|\/)[^/]*(private-key|token|secret|credential)[^/]*$/i.test(relPath);
}

function isAllowedFileChangePath(relPath) {
  if (!relPath || isSensitiveRelativePath(relPath)) return false;
  const ext = extname(relPath);
  if (!SAFE_FILE_CHANGE_EXTENSIONS.has(ext)) return false;
  return SAFE_FILE_CHANGE_ROOTS.some((root) => {
    if (root.endsWith('/')) return relPath.startsWith(root);
    return relPath === root;
  });
}

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

function fileSnapshot(filePath) {
  if (!existsSync(filePath)) return { exists: false, size: 0, sha256: null };
  const content = readFileSync(filePath);
  return {
    exists: true,
    size: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

function hasGitMetadata(cwd) {
  let current = resolve(cwd);
  for (;;) {
    if (existsSync(resolve(current, '.git'))) return true;
    const parent = resolve(current, '..');
    if (parent === current) return false;
    current = parent;
  }
}

const FILE_CHANGE_OPERATIONS = new Set(['create', 'update', 'append']);

function firstString(value, keys, maxLength) {
  for (const key of keys) {
    const v = value[key];
    if (v) return safeString(v, maxLength);
  }
  return '';
}

function firstDefined(value, keys, fallback = '') {
  for (const key of keys) {
    const v = value[key];
    if (v !== undefined && v !== null) return v;
  }
  return fallback;
}

function firstTruthy(value, keys) {
  for (const key of keys) {
    if (value[key]) return true;
  }
  return false;
}

function normalizeFileChangeInput(value) {
  if (!value || typeof value !== 'object') return null;
  const rawOperation = firstString(value, ['operation', 'action'], 40).toLowerCase();
  const operation = FILE_CHANGE_OPERATIONS.has(rawOperation) ? rawOperation : 'update';
  return {
    operation,
    path: firstString(value, ['path', 'filePath', 'file'], 2000),
    content: safeContent(firstDefined(value, ['content', 'text'], '')),
    summary: firstString(value, ['summary', 'reason'], 500),
    approvalId: firstString(value, ['approvalId', 'permissionApprovalId', 'resumeApprovalId'], 160),
    requiresApproval: firstTruthy(value, ['requiresApproval', 'approvalRequired', 'requireApproval']),
    overwrite: Boolean(value.overwrite),
  };
}

function normalizeFileChanges(input = {}) {
  const source = Array.isArray(input.fileChanges) ? input.fileChanges
    : Array.isArray(input.workFileChanges) ? input.workFileChanges
      : Array.isArray(input.changes) ? input.changes
        : [];
  return source.map(normalizeFileChangeInput).filter(Boolean).slice(0, 8);
}

/**
 * Validates a file change operation for safety and correctness.
 * Checks path containment, content size, operation validity, and overwrite permissions.
 *
 * @param {Object} change - The file change object to validate.
 * @param {Object} [options] - Validation options.
 * @param {string} [options.cwd] - Current working directory for path resolution. Defaults to `process.cwd()`.
 * @returns {{ ok: boolean, reason: string, operation: string, path: string, relativePath: string, targetPath: string, content?: string, summary?: string, approvalId?: string, requiresApproval?: boolean, overwrite?: boolean, safeToAutoExecute: boolean }} Validation result object.
 */
function fileChangePathReason(cwd, item, relPath) {
  if (!relPath || !commandInsideCwd(cwd, item.path)) return 'file change path must stay inside cwd';
  if (!isAllowedFileChangePath(relPath)) return 'file change path is outside the safe project file allowlist';
  return null;
}

function fileChangeContentReason(item) {
  if (!item.content && item.operation !== 'append') return 'file change content is empty';
  if (Buffer.byteLength(item.content, 'utf8') > MAX_FILE_CHANGE_BYTES) return 'file change content exceeds the safe size limit';
  return null;
}

function fileChangeOverwriteReason(item, exists) {
  if (item.operation === 'create' && exists && !item.overwrite) return 'create would overwrite an existing file';
  return null;
}

/**
 * Validates a file change against the local safe project allowlist.
 * Ensures the target path stays inside cwd, the path is on the project file allowlist, the content is within safe size limits, and `create` operations do not overwrite existing files unless explicitly permitted.
 *
 * @param {Object|string} change - The file change descriptor (or string path) to validate. Normalized via `normalizeFileChangeInput`.
 * @param {Object} [options]
 * @param {string} [options.cwd] - The current working directory for path resolution. Defaults to `process.cwd()`.
 * @returns {{ ok: boolean, reason: string, operation: string, path: string, relativePath: string, targetPath: string, content?: string, summary?: string, approvalId?: string, requiresApproval?: boolean, overwrite?: boolean, safeToAutoExecute: boolean }} Validation result object.
 */
export function validateFileChange(change, { cwd = process.cwd() } = {}) {
  const item = normalizeFileChangeInput(change);
  if (!item) return { ok: false, reason: 'file change is empty', safeToAutoExecute: false };
  const relPath = normalizedRelativePath(cwd, item.path);
  const targetPath = relPath ? resolve(cwd, relPath) : '';
  const deny = (reason) => ({
    ok: false,
    reason,
    operation: item.operation,
    path: item.path,
    relativePath: relPath,
    targetPath,
    safeToAutoExecute: false,
  });
  const reason = fileChangePathReason(cwd, item, relPath)
    || fileChangeContentReason(item)
    || fileChangeOverwriteReason(item, existsSync(targetPath));
  if (reason) return deny(reason);
  return {
    ok: true,
    reason: 'safe project-local file change allowed',
    operation: item.operation,
    path: item.path,
    relativePath: relPath,
    targetPath,
    content: item.content,
    summary: item.summary,
    approvalId: item.approvalId,
    requiresApproval: item.requiresApproval,
    overwrite: item.overwrite,
    safeToAutoExecute: true,
  };
}

function collectEvidenceSources(input = {}) {
  const list = (key) => (Array.isArray(input[key]) ? input[key] : []);
  return [...list('evidenceArtifacts'), ...list('screenshotEvidence')];
}

function statArtifactMeta(targetPath) {
  try {
    if (existsSync(targetPath)) {
      const stat = statSync(targetPath);
      return { exists: true, size: stat.size };
    }
  } catch {}
  return { exists: false, size: 0 };
}

function coerceEvidenceItem(item) {
  if (typeof item === 'string') return { path: item };
  return item;
}

function evidenceSourcePath(item) {
  return item.path || item.filePath || item.file;
}

function evidenceKind(item) {
  return safeString(item.kind || item.type || 'artifact', 80) || 'artifact';
}

function evidenceLabel(item, relPath) {
  return safeString(item.label || item.title || relPath, 200);
}

function isAcceptableEvidenceRelPath(relPath) {
  return Boolean(relPath) && !isSensitiveRelativePath(relPath);
}

function normalizeEvidenceItem(item, cwd) {
  const source = coerceEvidenceItem(item);
  if (!source || typeof source !== 'object') return null;
  const relPath = normalizedRelativePath(cwd, evidenceSourcePath(source));
  if (!isAcceptableEvidenceRelPath(relPath)) return null;
  const targetPath = resolve(cwd, relPath);
  return {
    kind: evidenceKind(source),
    label: evidenceLabel(source, relPath),
    path: relPath,
    ...statArtifactMeta(targetPath),
  };
}

function normalizeEvidenceArtifacts(input = {}, { cwd = process.cwd() } = {}) {
  return collectEvidenceSources(input)
    .map((item) => normalizeEvidenceItem(item, cwd))
    .filter(Boolean)
    .slice(0, 12);
}

function buildApprovalResumeManifest(input = {}, { cwd = process.cwd(), approvalId = '' } = {}) {
  const manifest = {
    approvalId: safeString(approvalId || input.approvalId || input.permissionApprovalId || input.resumeApprovalId, 160),
    fileChanges: normalizeFileChanges(input),
    workEvidenceCommands: workEvidenceCommands({}, input, cwd).map((item) => item.command),
    commands: verificationCommands({}, input, cwd).map((item) => item.command),
    evidenceArtifacts: normalizeEvidenceArtifacts(input, { cwd }),
  };
  if (safeString(input.cwd, 2000)) manifest.cwd = safeString(input.cwd, 2000);
  return manifest;
}

/**
 * Validates a verification command against the local allowlist.
 * Checks if the command (e.g., npm test, node --check, git diff --check) is safe for auto-execution.
 *
 * @param {string} command - The command string to validate.
 * @param {Object} [options]
 * @param {string} [options.cwd] - The current working directory for path checks. Defaults to process.cwd().
 * @returns {{ ok: boolean, reason: string, bin?: string, args?: string[], normalized?: string, safeToAutoExecute: boolean }} Validation result.
 */
function validateNpmVerification(args, cwd) {
  if (args[0] === 'test') {
    const fileArgs = args.slice(1).filter((arg) => arg !== '--');
    if (fileArgs.some((arg) => /(^|\/)\.env(\.|$|\/)?/.test(arg) || !commandInsideCwd(cwd, arg))) {
      return { allowed: false, reason: 'npm test file arguments must stay inside cwd and avoid sensitive files' };
    }
    return { allowed: true };
  }
  if (args[0] === 'run' && SAFE_NPM_RUN_SCRIPTS.has(args[1])) {
    if (args.length !== 2) {
      return { allowed: false, reason: 'npm run verification scripts must be exact allowlisted commands' };
    }
    return { allowed: true };
  }
  return { allowed: false, reason: 'only npm test and selected npm run verification scripts are auto-executable' };
}

function validateNodeVerification(args, cwd) {
  if (args[0] === '--check') {
    const files = args.slice(1);
    if (!files.length) return { allowed: false, reason: 'node --check requires a project-local file' };
    if (files.some((file) => !safeCommandFile(cwd, file))) {
      return { allowed: false, reason: 'node --check files must stay inside cwd and avoid sensitive files' };
    }
    return { allowed: true };
  }
  if (args[0] === '--test') {
    const files = args.slice(1);
    if (!files.length) return { allowed: false, reason: 'node --test requires explicit project-local test files' };
    if (files.some((file) => !safeCommandFile(cwd, file, new Set(['.js', '.mjs', '.cjs'])))) {
      return { allowed: false, reason: 'node --test files must stay inside cwd, use JS extensions, and avoid sensitive files' };
    }
    return { allowed: true };
  }
  if (args.length === 1 && SAFE_NODE_SCRIPT_COMMANDS.has(args[0])) {
    if (!safeCommandFile(cwd, args[0], new Set(['.js', '.mjs', '.cjs']))) {
      return { allowed: false, reason: 'node script must stay inside cwd and avoid sensitive files' };
    }
    return { allowed: true };
  }
  return { allowed: false, reason: 'node auto verification only supports --check, --test, and selected project scripts' };
}

function validateGitVerification(args) {
  if (args.length === 2 && args[0] === 'diff' && args[1] === '--check') return { allowed: true };
  return { allowed: false, reason: 'git auto verification only supports git diff --check' };
}

/**
 * Validates a verification command against the local allowlist.
 * Supports safe npm scripts (test/lint/run) without --workspace or sudo,
 * node --check/--test/script validation against project-local files,
 * and git diff --check.
 *
 * @param {string} command - The command string to validate.
 * @param {Object} [options]
 * @param {string} [options.cwd] - The current working directory used for safe path checks. Defaults to process.cwd().
 * @returns {{ ok: boolean, reason: string, bin?: string, args?: string[], normalized?: string, safeToAutoExecute: boolean }} Validation result.
 */
export function validateVerificationCommand(command, { cwd = process.cwd() } = {}) {
  const parts = parseCommandLine(command);
  if (!parts.length) return { ok: false, reason: 'verification command is empty', safeToAutoExecute: false };
  const [bin, ...args] = parts;
  const normalized = [bin, ...args].join(' ');
  const shared = { bin, args, normalized };
  const deny = (reason) => ({ ok: false, reason, ...shared, safeToAutoExecute: false });

  let outcome;
  if (bin === 'npm') outcome = validateNpmVerification(args, cwd);
  else if (bin === 'node') outcome = validateNodeVerification(args, cwd);
  else if (bin === 'git') outcome = validateGitVerification(args);
  else return deny(`command "${bin}" is not in the local verification allowlist`);

  if (outcome.allowed) {
    return { ok: true, reason: 'safe local verification command allowed', ...shared, safeToAutoExecute: true };
  }
  return deny(outcome.reason);
}

/**
 * Validates a work evidence command against the local allowlist.
 * Typically allows read-only git commands like 'git status' or 'git diff' in a git worktree.
 *
 * @param {string} command - The command string to validate.
 * @param {Object} [options]
 * @param {string} [options.cwd] - The current working directory for git metadata checks. Defaults to process.cwd().
 * @returns {{ ok: boolean, reason: string, bin?: string, args?: string[], normalized?: string, safeToAutoExecute: boolean }} Validation result.
 */
export function validateWorkEvidenceCommand(command, { cwd = process.cwd() } = {}) {
  const parts = parseCommandLine(command);
  if (!parts.length) return { ok: false, reason: 'work evidence command is empty', safeToAutoExecute: false };
  const [bin, ...args] = parts;
  const normalized = [bin, ...args].join(' ');
  const deny = (reason) => ({ ok: false, reason, bin, args, normalized, safeToAutoExecute: false });
  const allow = () => ({ ok: true, reason: 'safe local work evidence command allowed', bin, args, normalized, safeToAutoExecute: true });
  if (bin !== 'git') return deny(`command "${bin}" is not in the local work evidence allowlist`);
  if (!hasGitMetadata(cwd)) return deny('git work evidence requires a git worktree');
  if (!SAFE_WORK_EVIDENCE_COMMANDS.has(normalized)) {
    return deny('only read-only git status/diff evidence commands are auto-executable');
  }
  return allow();
}

function normalizeCommandInput(value) {
  if (typeof value === 'string') return { command: value };
  if (!value || typeof value !== 'object') return null;
  return {
    command: safeString(value.command || value.cmd, 4000),
    timeoutMs: Number(value.timeoutMs || value.timeout || 0) || undefined,
  };
}

function defaultVerificationCommands(timeline = {}, cwd = process.cwd()) {
  const run = timeline.run || {};
  const files = normalizeArray(run.details?.affectedFiles || []);
  const commands = hasGitMetadata(cwd) ? ['git diff --check'] : [];
  if (files.includes('public/app.js')) commands.push('node --check public/app.js');
  if (files.some((file) => file.startsWith('src/agents/') || file.includes('AgentRunStore') || file.includes('agentRuns'))) {
    commands.push('npm test -- tests/unit/agent-run-store.test.js tests/unit/routes/agent-runs-routes.test.js');
  }
  if (!commands.length || (commands.length === 1 && commands[0] === 'git diff --check')) {
    commands.push('npm test -- tests/unit/agent-run-store.test.js tests/unit/routes/agent-runs-routes.test.js');
  }
  return [...new Set(commands)].slice(0, 4);
}

function verificationCommands(timeline, input = {}, cwd = process.cwd()) {
  const provided = (Array.isArray(input.commands) ? input.commands : [])
    .map(normalizeCommandInput)
    .filter((item) => item?.command);
  const commands = provided.length
    ? provided
    : defaultVerificationCommands(timeline, cwd).map((command) => ({ command }));
  return commands.slice(0, 6);
}

function workEvidenceCommands(timeline, input = {}, cwd = process.cwd()) {
  const provided = (Array.isArray(input.workEvidenceCommands) ? input.workEvidenceCommands : [])
    .map(normalizeCommandInput)
    .filter((item) => item?.command);
  if (provided.length) return provided.slice(0, 6);
  if (!hasGitMetadata(cwd)) return [];
  return ['git status --short', 'git diff --name-only'].map((command) => ({ command }));
}

function buildPlanMetadata(run, details, cwd) {
  return {
    id: `idea-work-plan-${Date.now().toString(36)}`,
    stage: 'idea_work_execution',
    title: `Work plan: ${safeString(details.idea || run.taskId || run.id, 160) || 'Idea Run'}`,
    executionMode: 'local_manifest_then_evidence_then_verification',
    safeToAutoExecute: false,
    cwd,
  };
}

function buildPlanSteps({ fileChanges = [], workCommands = [], verifyCommands = [], evidenceArtifacts = [] } = {}) {
  const readyStatus = (hasItems) => (hasItems ? 'ready' : 'skipped');
  return [
    { type: 'scope', title: 'Confirm idea scope and affected files', status: 'recorded' },
    { type: 'file_changes', title: 'Apply governed local file changes from manifest', status: readyStatus(fileChanges.length) },
    { type: 'work_evidence', title: 'Collect local worktree evidence before archive', status: readyStatus(workCommands.length) },
    { type: 'verification', title: 'Run allowlisted local verification commands', status: readyStatus(verifyCommands.length) },
    { type: 'artifacts', title: 'Attach screenshot and verification artifacts', status: readyStatus(evidenceArtifacts.length) },
    { type: 'archive', title: 'Archive work evidence, verification results, and governance lineage', status: 'pending' },
  ];
}

function buildFileChangeEntries(fileChanges = []) {
  return fileChanges.map((item) => ({
    operation: item.operation,
    path: item.path,
    summary: item.summary || '',
    requiresApproval: Boolean(item.requiresApproval),
  }));
}

function buildCommandLists(workCommands = [], verifyCommands = []) {
  return {
    workEvidence: workCommands.map((item) => item.command),
    verification: verifyCommands.map((item) => item.command),
  };
}

function buildIdeaWorkPlan(timeline = {}, options = {}) {
  const run = timeline.run || {};
  const details = run.details || {};
  return {
    ...buildPlanMetadata(run, details, options.cwd),
    affectedFiles: normalizeArray(details.affectedFiles || []),
    dispatchTags: normalizeArray(run.dispatchTags || []),
    skills: normalizeArray(run.skills || []),
    steps: buildPlanSteps(options),
    fileChanges: buildFileChangeEntries(options.fileChanges),
    evidenceArtifacts: options.evidenceArtifacts || [],
    commands: buildCommandLists(options.workCommands, options.verificationCommands),
  };
}

function safeKillChild(child, signal) {
  try { child.kill(signal); } catch {}
}

function buildSpawnFailurePayload(ctx, stderrOverride) {
  return {
    status: 'failed',
    exitCode: null,
    durationMs: Date.now() - ctx.startedAt,
    stdout: ctx.streams.stdout,
    stderr: ctx.streams.stderr || stderrOverride,
  };
}

function buildSpawnExitPayload(ctx, code, signal) {
  return {
    status: code === 0 ? 'passed' : 'failed',
    exitCode: code,
    signal: signal || null,
    durationMs: Date.now() - ctx.startedAt,
    stdout: ctx.streams.stdout,
    stderr: ctx.streams.stderr,
  };
}

function computeSpawnTimeoutMs(timeoutMs) {
  return Math.max(1_000, Math.min(MAX_TIMEOUT_MS, timeoutMs || DEFAULT_TIMEOUT_MS));
}

function createSpawnContext({ bin, args, cwd }, resolveResult) {
  const child = spawn(bin, args, {
    cwd,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  const ctx = {
    child,
    startedAt: Date.now(),
    streams: { stdout: '', stderr: '' },
    settled: false,
    timeoutHandle: null,
    killTimer: null,
  };

  ctx.settle = (payload) => {
    if (ctx.settled) return;
    ctx.settled = true;
    if (ctx.timeoutHandle) clearTimeout(ctx.timeoutHandle);
    if (ctx.killTimer) clearTimeout(ctx.killTimer);
    resolveResult(payload);
  };

  return ctx;
}

function scheduleSpawnTimeout(ctx, timeoutMs) {
  // M8 修复：SIGTERM 后给 3s 宽限，子进程忽略信号则 SIGKILL 并 settle 为超时失败，避免永久挂死+僵尸。
  const onHardKill = () => {
    safeKillChild(ctx.child, 'SIGKILL');
    ctx.settle(buildSpawnFailurePayload(ctx, 'verification command timed out (SIGKILL)'));
  };

  const onInitialTimeout = () => {
    if (ctx.settled) return;
    safeKillChild(ctx.child, 'SIGTERM');
    ctx.killTimer = setTimeout(() => {
      if (!ctx.settled) onHardKill();
    }, 3_000);
    if (ctx.killTimer.unref) ctx.killTimer.unref();
  };

  ctx.timeoutHandle = setTimeout(onInitialTimeout, timeoutMs);
}

function collectSpawnOutput(ctx) {
  ctx.child.stdout.on('data', (chunk) => { ctx.streams.stdout += chunk.toString(); });
  ctx.child.stderr.on('data', (chunk) => { ctx.streams.stderr += chunk.toString(); });
}

function handleSpawnTermination(ctx) {
  ctx.child.on('error', (error) => {
    ctx.settle(buildSpawnFailurePayload(ctx, error.message));
  });

  ctx.child.on('close', (code, signal) => {
    ctx.settle(buildSpawnExitPayload(ctx, code, signal));
  });
}

function spawnCommand({ bin, args, cwd, timeoutMs }) {
  return new Promise((resolveResult) => {
    const ctx = createSpawnContext({ bin, args, cwd }, resolveResult);
    scheduleSpawnTimeout(ctx, computeSpawnTimeoutMs(timeoutMs));
    collectSpawnOutput(ctx);
    handleSpawnTermination(ctx);
  });
}

export class AgentRunVerificationExecutor {
  constructor({
    agentRunStore = defaultAgentRunStore,
    permissionGovernance = defaultPermissionGovernance,
    cwd = process.cwd(),
    logger = console,
  } = {}) {
    this.agentRunStore = agentRunStore;
    this.permissionGovernance = permissionGovernance;
    this.cwd = cwd;
    this.logger = logger;
  }

  async runGovernedCommand(id, timeline, item, { cwd, stage, toolName, validateCommand, actorType = 'system', actorId = 'idea-auto-executor' }) {
    const validation = validateCommand(item.command, { cwd });
    const command = validation.normalized || item.command;
    if (!validation.ok) {
      return this.buildGovernedCommandValidationBlocked(command, validation, stage);
    }
    const permission = this.permissionGovernance?.evaluatePermission?.({
      actorType,
      actorId,
      agentRunId: id,
      roomId: timeline.run.roomId,
      sessionId: timeline.run.sessionId,
      taskId: timeline.run.taskId,
      cwd,
      action: 'shell.exec',
      target: {
        toolName,
        command,
        guardLevel: 'standard',
      },
      risk: 'low',
      details: { stage },
    });
    if (permission && permission.decision !== 'allow') {
      return this.buildGovernedCommandPermissionBlocked(command, permission, stage);
    }
    return this.runGovernedCommandExecution(command, validation, { cwd, timeoutMs: item.timeoutMs, stage });
  }

  buildGovernedCommandValidationBlocked(command, validation, stage) {
    return {
      command,
      status: 'blocked',
      reason: validation.reason,
      toolResult: {
        name: command,
        toolName: command,
        status: 'blocked',
        inputSummary: command,
        outputSummary: validation.reason,
        payload: { validation, safeToAutoExecute: false, stage },
      },
      evidence: { command, status: 'blocked', reason: validation.reason, stage },
    };
  }

  buildGovernedCommandPermissionBlocked(command, permission, stage) {
    const status = permission.decision === 'deny' ? 'blocked' : 'approval_required';
    const approvalId = permission.approval?.id || null;
    return {
      command,
      status,
      reason: permission.reason,
      approvalId,
      toolResult: {
        name: command,
        toolName: command,
        status,
        inputSummary: command,
        outputSummary: permission.reason,
        approvalId,
        payload: { permissionDecisionId: permission.id, safeToAutoExecute: false, stage },
      },
      evidence: {
        command,
        status,
        reason: permission.reason,
        approvalId,
        stage,
      },
    };
  }

  async runGovernedCommandExecution(command, validation, { cwd, timeoutMs, stage }) {
    const result = await spawnCommand({
      bin: validation.bin,
      args: validation.args,
      cwd,
      timeoutMs,
    });
    const output = clipOutput([result.stdout, result.stderr].filter(Boolean).join('\n').trim() || `exit ${result.exitCode ?? 'unknown'}`);
    return {
      command,
      status: result.status,
      output,
      toolResult: {
        name: command,
        toolName: command,
        status: result.status,
        inputSummary: command,
        outputSummary: output,
        payload: {
          cwd,
          exitCode: result.exitCode,
          signal: result.signal || null,
          durationMs: result.durationMs,
          safeToAutoExecute: true,
          stage,
        },
      },
      evidence: {
        command,
        status: result.status,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stage,
      },
    };
  }

  fileChangePermissionTarget(validation) {
    return {
      path: validation.targetPath,
      filePath: validation.targetPath,
      relativePath: validation.relativePath,
      operation: validation.operation,
      contentSha256: sha256Text(validation.content),
      ...(validation.requiresApproval ? { requiresApproval: true } : {}),
    };
  }

  evaluateGovernedFileChange(id, timeline, change, { cwd, actorType = 'system', actorId = 'idea-auto-executor', approvalId = '' } = {}) {
    const validation = validateFileChange(change, { cwd });
    const toolName = this.resolveGovernedFileChangeToolName(change, validation);
    if (!validation.ok) {
      return this.buildGovernedFileChangeBlockedResult(toolName, validation, change);
    }
    const target = this.fileChangePermissionTarget(validation);
    const permission = this.permissionGovernance?.evaluatePermission?.({
      actorType,
      actorId,
      agentRunId: id,
      roomId: timeline.run.roomId,
      sessionId: timeline.run.sessionId,
      taskId: timeline.run.taskId,
      cwd,
      approvalId: validation.approvalId || approvalId,
      action: 'file.write',
      target,
      risk: validation.requiresApproval ? 'high' : 'medium',
      details: {
        stage: 'idea_file_change',
        operation: validation.operation,
        relativePath: validation.relativePath,
        contentSha256: target.contentSha256,
        requiresApproval: validation.requiresApproval,
      },
    });
    if (permission && permission.decision !== 'allow') {
      return this.buildGovernedFileChangePermissionDeniedResult(toolName, validation, permission);
    }
    return {
      status: 'allowed',
      validation,
      permission,
      toolName,
    };
  }

  resolveGovernedFileChangeToolName(change, validation) {
    return validation.relativePath
      ? `file.write ${validation.relativePath}`
      : `file.write ${safeString(change?.path || 'unknown', 160)}`;
  }

  buildGovernedFileChangeBlockedResult(toolName, validation, change) {
    return {
      status: 'blocked',
      toolResult: {
        name: toolName,
        toolName,
        status: 'blocked',
        inputSummary: validation.path || safeString(change?.path || '', 2000),
        outputSummary: validation.reason,
        payload: { validation, safeToAutoExecute: false, stage: 'idea_file_change' },
      },
      evidence: {
        operation: validation.operation || change?.operation || 'update',
        path: validation.relativePath || validation.path || change?.path || '',
        status: 'blocked',
        reason: validation.reason,
        stage: 'idea_file_change',
      },
    };
  }

  buildGovernedFileChangePermissionDeniedResult(toolName, validation, permission) {
    const status = permission.decision === 'deny' ? 'blocked' : 'approval_required';
    const approvalId = permission.approval?.id || null;
    return {
      status,
      approvalId,
      toolResult: {
        name: toolName,
        toolName,
        status,
        inputSummary: validation.relativePath,
        outputSummary: permission.reason,
        approvalId,
        payload: { permissionDecisionId: permission.id, safeToAutoExecute: false, stage: 'idea_file_change' },
      },
      evidence: {
        operation: validation.operation,
        path: validation.relativePath,
        status,
        reason: permission.reason,
        approvalId,
        stage: 'idea_file_change',
      },
    };
  }

  writeGovernedFileChange(plan, { cwd } = {}) {
    const { validation, permission, toolName } = plan;
    const before = fileSnapshot(validation.targetPath);
    const nextContent = validation.operation === 'append' && before.exists
      ? `${readFileSync(validation.targetPath, 'utf8')}${validation.content}`
      : validation.content;
    mkdirSync(dirname(validation.targetPath), { recursive: true });
    writeFileSync(validation.targetPath, nextContent, 'utf8');
    const after = fileSnapshot(validation.targetPath);
    return {
      status: 'passed',
      toolResult: {
        name: toolName,
        toolName,
        status: 'passed',
        inputSummary: `${validation.operation} ${validation.relativePath}`,
        outputSummary: `${validation.operation} ${validation.relativePath} (${before.sha256 || 'new'} -> ${after.sha256})`,
        payload: {
          stage: 'idea_file_change',
          cwd,
          operation: validation.operation,
          path: validation.relativePath,
          before,
          after,
          contentSha256: sha256Text(validation.content),
          permissionDecisionId: permission?.id || null,
          resumeApprovalId: permission?.approval?.id || validation.approvalId || null,
          safeToAutoExecute: true,
        },
      },
      evidence: {
        operation: validation.operation,
        path: validation.relativePath,
        status: 'passed',
        before,
        after,
        contentSha256: sha256Text(validation.content),
        permissionDecisionId: permission?.id || null,
        resumeApprovalId: permission?.approval?.id || validation.approvalId || null,
        stage: 'idea_file_change',
      },
    };
  }

  applyGovernedFileChange(id, timeline, change, options = {}) {
    const plan = this.evaluateGovernedFileChange(id, timeline, change, options);
    if (plan.status !== 'allowed') return plan;
    return this.writeGovernedFileChange(plan, options);
  }

  async executeIdeaRun(id, input = {}) {
    const timeline = this.agentRunStore.getTimeline(id);
    if (!timeline) throw new Error('agent run not found');
    if (timeline.run.sourceType !== 'idea_to_archive') throw new Error('agent run is not an idea_to_archive draft');
    const cwd = resolve(safeString(input.cwd, 2000) || this.cwd || process.cwd());
    if (!existsSync(cwd)) throw new Error('verification cwd does not exist');
    const commands = verificationCommands(timeline, input, cwd);
    const workCommands = workEvidenceCommands(timeline, input, cwd);
    const fileChanges = normalizeFileChanges(input);
    const evidenceArtifacts = normalizeEvidenceArtifacts(input, { cwd });
    const workPlan = buildIdeaWorkPlan(timeline, { cwd, workCommands, verificationCommands: commands, fileChanges, evidenceArtifacts });
    const workPlanMessage = this.agentRunStore.appendMessage(id, {
      kind: 'work_plan',
      role: 'system',
      status: 'ready',
      summary: `Idea work plan prepared: ${fileChanges.length} file changes, ${workCommands.length} work evidence commands, ${commands.length} verification commands.`,
      payload: { workPlan },
    });
    const fileChangeEvidence = [];
    const fileChangePlans = [];
    for (const item of fileChanges) {
      const plan = this.evaluateGovernedFileChange(id, timeline, item, {
        cwd,
        actorType: input.actorType || 'system',
        actorId: input.requestedBy || 'idea-auto-executor',
        approvalId: input.approvalId || input.permissionApprovalId || input.resumeApprovalId,
      });
      if (plan.status === 'allowed') {
        fileChangePlans.push(plan);
        continue;
      }
      const toolResult = this.agentRunStore.appendToolResult(id, {
        ...plan.toolResult,
        payload: {
          ...(plan.toolResult.payload || {}),
          workPlanId: workPlan.id,
        },
      });
      fileChangeEvidence.push({ ...plan.evidence, toolResultId: toolResult.id });
    }
    const pendingApproval = fileChangeEvidence.find((item) => item.status === 'approval_required' && item.approvalId);
    if (pendingApproval) {
      const resumeManifest = buildApprovalResumeManifest(input, { cwd, approvalId: pendingApproval.approvalId });
      const deferred = this.agentRunStore.transition(id, 'deferred', {
        stage: 'idea_file_change_approval_pending',
        deferReason: 'approval_pending',
        approvalId: pendingApproval.approvalId,
        workPlanId: workPlan.id,
        workPlanMessageId: workPlanMessage.id,
        pendingFileChangePath: pendingApproval.path,
        fileChanges: fileChangeEvidence,
        pendingResumeManifest: resumeManifest,
        safeToAutoExecute: false,
      });
      this.agentRunStore.appendMessage(id, {
        kind: 'summary',
        role: 'system',
        status: 'approval_required',
        summary: `Idea file change requires approval before execution: ${pendingApproval.path}`,
        payload: {
          workPlanId: workPlan.id,
          approvalId: pendingApproval.approvalId,
          fileChanges: fileChangeEvidence,
          resumeManifest,
          resumeHint: 'Approve the permission, then retry idea-auto-execute with the same manifest and approvalId.',
        },
      });
      return {
        run: this.agentRunStore.get(id),
        deferred,
        workPlan,
        workPlanMessage,
        fileChanges: fileChangeEvidence,
        workEvidence: [],
        commandEvidence: [],
        evidenceArtifacts,
        approvalId: pendingApproval.approvalId,
        status: 'approval_required',
      };
    }
    const blockedFileChange = fileChangeEvidence.find((item) => item.status === 'blocked');
    if (blockedFileChange) {
      const summary = `Idea file change blocked before execution: ${blockedFileChange.path || blockedFileChange.reason}`;
      return this.agentRunStore.completeIdeaRun(id, {
        actorType: input.actorType || 'system',
        requestedBy: input.requestedBy || 'idea-auto-executor',
        status: 'failed',
        summary,
        archiveSummary: summary,
        affectedFiles: input.affectedFiles || timeline.run.details?.affectedFiles || [],
        verificationResults: [{
          name: blockedFileChange.path ? `file.write ${blockedFileChange.path}` : 'file.write',
          status: 'blocked',
          inputSummary: blockedFileChange.path || '',
          outputSummary: blockedFileChange.reason || 'file change blocked before execution',
          payload: {
            stage: 'idea_file_change',
            workPlanId: workPlan.id,
            safeToAutoExecute: false,
          },
        }],
        evidence: {
          stage: 'idea_file_change_blocked',
          cwd,
          workPlan,
          workPlanMessageId: workPlanMessage.id,
          fileChanges: fileChangeEvidence,
          workEvidence: [],
          commands: [],
          evidenceArtifacts,
          resumeReviewGate: input.resumeReviewGate || null,
          resumeReviewGateAudit: input.resumeReviewGateAudit || null,
        },
      });
    }
    for (const plan of fileChangePlans) {
      const outcome = this.writeGovernedFileChange(plan, { cwd });
      const toolResult = this.agentRunStore.appendToolResult(id, {
        ...outcome.toolResult,
        payload: {
          ...(outcome.toolResult.payload || {}),
          workPlanId: workPlan.id,
        },
      });
      fileChangeEvidence.push({ ...outcome.evidence, toolResultId: toolResult.id });
    }
    const workEvidence = [];
    for (const item of workCommands) {
      const outcome = await this.runGovernedCommand(id, timeline, item, {
        cwd,
        stage: 'idea_work_evidence',
        toolName: 'idea_work_evidence_command',
        validateCommand: validateWorkEvidenceCommand,
        actorType: input.actorType || 'system',
        actorId: input.requestedBy || 'idea-auto-executor',
      });
      const toolResult = this.agentRunStore.appendToolResult(id, {
        ...outcome.toolResult,
        payload: {
          ...(outcome.toolResult.payload || {}),
          workPlanId: workPlan.id,
        },
      });
      workEvidence.push({ ...outcome.evidence, toolResultId: toolResult.id });
    }
    const verificationResults = [];
    const commandEvidence = [];
    for (const item of commands) {
      const outcome = await this.runGovernedCommand(id, timeline, item, {
        cwd,
        stage: 'idea_auto_verification',
        toolName: 'idea_verification_command',
        validateCommand: validateVerificationCommand,
        actorType: input.actorType || 'system',
        actorId: input.requestedBy || 'idea-auto-executor',
      });
      verificationResults.push({
        ...outcome.toolResult,
        payload: {
          ...(outcome.toolResult.payload || {}),
          workPlanId: workPlan.id,
        },
      });
      commandEvidence.push(outcome.evidence);
    }
    const failed = [...fileChangeEvidence, ...workEvidence, ...commandEvidence].some((item) => item.status !== 'passed');
    const finalStatus = failed ? 'failed' : 'succeeded';
    const summary = safeString(input.summary || input.executionSummary, 2000)
      || (failed
        ? `Auto work or verification failed or blocked: ${[
          ...fileChangeEvidence.map((item) => item.path),
          ...workEvidence.map((item) => item.command),
          ...commandEvidence.map((item) => item.command),
        ].filter(Boolean).join(', ')}`
        : `Auto work applied ${fileChangeEvidence.length} file changes; verification passed: ${commandEvidence.map((item) => item.command).join(', ')}; work evidence collected: ${workEvidence.map((item) => item.command).join(', ') || 'none'}`);
    const affectedFiles = [
      ...(input.affectedFiles || timeline.run.details?.affectedFiles || []),
      ...fileChangeEvidence.map((item) => item.path),
    ].filter(Boolean);
    return this.agentRunStore.completeIdeaRun(id, {
      actorType: input.actorType || 'system',
      requestedBy: input.requestedBy || 'idea-auto-executor',
      status: finalStatus,
      summary,
      archiveSummary: summary,
      affectedFiles,
      verificationResults,
      evidence: {
        stage: 'idea_auto_verification',
        cwd,
        workPlan,
        workPlanMessageId: workPlanMessage.id,
        fileChanges: fileChangeEvidence,
        workEvidence,
        commands: commandEvidence,
        evidenceArtifacts,
        resumeReviewGate: input.resumeReviewGate || null,
        resumeReviewGateAudit: input.resumeReviewGateAudit || null,
      },
    });
  }
}
