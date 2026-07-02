import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { redactNoeFreedomPayload } from '../capabilities/NoeFreedomManifest.js';
import { redactSensitiveText } from './NoeContextScrubber.js';

export const NOE_FREEDOM_RUN_LEDGER_SCHEMA_VERSION = 1;
export const DEFAULT_NOE_FREEDOM_RUN_LEDGER_DIR = 'output/noe-freedom-runs';

function clean(value, max = 4000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function safeObject(value) {
  if (!value || typeof value !== 'object') return {};
  try {
    return JSON.parse(redactSensitiveText(JSON.stringify(redactNoeFreedomPayload(value))));
  } catch {
    return {};
  }
}

function isDeveloperModeLedger(ledger = {}) {
  return ledger.realExecute === true && ledger.authorization?.mode === 'developer_unrestricted';
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(value = '') {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function pathInside(base, target) {
  const root = resolve(base);
  const next = resolve(target);
  return next === root || next.startsWith(root + sep);
}

function assertRelativeOutputDir(outDir = '') {
  const cleanOutDir = clean(outDir || DEFAULT_NOE_FREEDOM_RUN_LEDGER_DIR, 2000);
  if (!cleanOutDir) throw new Error('freedom_run_ledger_out_dir_required');
  if (isAbsolute(cleanOutDir)) throw new Error('freedom_run_ledger_out_dir_must_be_relative');
  const parts = cleanOutDir.split(/[\\/]+/).filter(Boolean);
  if (parts.includes('..')) throw new Error('freedom_run_ledger_out_dir_path_traversal');
  if (parts[0] !== 'output' || parts[1] !== 'noe-freedom-runs') {
    throw new Error('freedom_run_ledger_out_dir_must_be_output_noe_freedom_runs');
  }
  return parts.join(sep);
}

function assertRelativeLedgerRef(ref = '') {
  const cleanRef = clean(ref, 2000);
  if (!cleanRef) throw new Error('freedom_run_ledger_ref_required');
  if (isAbsolute(cleanRef)) throw new Error('freedom_run_ledger_ref_must_be_relative');
  const parts = cleanRef.split(/[\\/]+/).filter(Boolean);
  if (parts.includes('..')) throw new Error('freedom_run_ledger_ref_path_traversal');
  if (parts[0] !== 'output' || parts[1] !== 'noe-freedom-runs') {
    throw new Error('freedom_run_ledger_ref_must_be_output_noe_freedom_runs');
  }
  if (parts.at(-1) !== 'ledger.json') throw new Error('freedom_run_ledger_ref_must_end_with_ledger_json');
  return parts.join(sep);
}

function assertNoExistingSymlink(root, target) {
  const rootResolved = resolve(root);
  const targetResolved = resolve(target);
  if (!pathInside(rootResolved, targetResolved)) throw new Error('freedom_run_ledger_out_dir_outside_root');
  const rel = relative(rootResolved, targetResolved);
  let cursor = rootResolved;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error('freedom_run_ledger_symlink_path_denied');
    } catch (error) {
      if (error?.message === 'freedom_run_ledger_symlink_path_denied') throw error;
      if (error?.code === 'ENOENT') return;
      throw error;
    }
  }
}

function assertExistingFileInsideRoot(root, target) {
  const rootResolved = realpathSync(resolve(root));
  const targetResolved = realpathSync(resolve(target));
  if (!pathInside(rootResolved, targetResolved)) throw new Error('freedom_run_ledger_ref_outside_root');
  if (!lstatSync(targetResolved).isFile()) throw new Error('freedom_run_ledger_ref_not_file');
  return targetResolved;
}

function assertExistingDirectoryInsideRoot(root, target) {
  const rootResolved = realpathSync(resolve(root));
  const targetResolved = realpathSync(resolve(target));
  if (!pathInside(rootResolved, targetResolved)) throw new Error('freedom_run_ledger_dir_outside_root');
  if (!lstatSync(targetResolved).isDirectory()) throw new Error('freedom_run_ledger_dir_not_directory');
  return targetResolved;
}

function safeRunId(value = '') {
  const id = clean(value || `freedom-run-${randomUUID().slice(0, 12)}`, 180)
    .replace(/[^a-z0-9_.-]+/gi, '-')
    .replace(/^-+|-+$/g, '');
  return id || `freedom-run-${randomUUID().slice(0, 12)}`;
}

export function buildNoeFreedomRunLedger({
  result = {},
  runId = '',
  createdAt = new Date().toISOString(),
} = {}) {
  const action = {
    id: clean(result.id, 180),
    toolId: clean(result.tool?.id, 180),
    operation: clean(result.tool?.operation, 180),
    capability: clean(result.tool?.capability, 120),
    riskLevel: clean(result.tool?.riskLevel || 'critical', 40),
  };
  const ledger = {
    schemaVersion: NOE_FREEDOM_RUN_LEDGER_SCHEMA_VERSION,
    runId: safeRunId(runId || result.id),
    createdAt: clean(createdAt, 80),
    ok: result.ok === true,
    dryRunOnly: result.dryRunOnly !== false,
    realExecute: result.realExecute === true,
    action,
    authorization: safeObject(result.authorization),
    trust: safeObject(result.trust),
    allowlist: safeObject(result.allowlist),
    argsPreview: safeObject(result.argsPreview),
    blockers: Array.isArray(result.blockers) ? result.blockers.map((item) => clean(item, 1000)) : [],
    warnings: Array.isArray(result.warnings) ? result.warnings.map((item) => clean(item, 1000)) : [],
    runtime: safeObject(result.runtime),
    rollback: safeObject(result.rollback),
    evidence: result.evidence ? {
      sha256: clean(result.evidence.sha256, 80),
      dryRunOnly: result.evidence.dryRunOnly !== false,
      refs: safeObject(result.evidence.refs),
    } : null,
    secretValuesReturned: result.runtime?.secretValuesReturned === true,
  };
  return {
    ...ledger,
    sha256: sha256(stableJson(ledger)),
  };
}

export function validateNoeFreedomRunLedger(ledger = {}) {
  const errors = [];
  if (ledger.schemaVersion !== NOE_FREEDOM_RUN_LEDGER_SCHEMA_VERSION) errors.push('unsupported_freedom_run_ledger_schema_version');
  if (!clean(ledger.runId, 180)) errors.push('freedom_run_id_required');
  if (!clean(ledger.action?.operation, 180)) errors.push('freedom_run_operation_required');
  if (ledger.realExecute === true && ledger.dryRunOnly === true) errors.push('freedom_run_real_execute_dry_run_conflict');
  if (ledger.secretValuesReturned === true) errors.push('freedom_run_secret_values_returned');
  if (ledger.realExecute === true) {
    const developerMode = isDeveloperModeLedger(ledger);
    if (!developerMode && !ledger.trust?.id) errors.push('freedom_run_trust_manifest_required');
    if (!developerMode && !ledger.allowlist?.id) errors.push('freedom_run_allowlist_required');
    if (!developerMode && !ledger.rollback?.plan && ledger.action?.riskLevel === 'critical') errors.push('freedom_run_rollback_plan_required');
  }
  const expected = ledger.sha256;
  if (expected) {
    const copy = { ...ledger };
    delete copy.sha256;
    if (sha256(stableJson(copy)) !== expected) errors.push('freedom_run_ledger_hash_mismatch');
  }
  return { ok: errors.length === 0, errors };
}

export function resolveNoeFreedomRunLedgerRef(root = process.cwd(), ref = '') {
  const safeRef = assertRelativeLedgerRef(ref);
  const file = resolve(root, safeRef);
  if (!pathInside(root, file)) throw new Error('freedom_run_ledger_ref_outside_root');
  return assertExistingFileInsideRoot(root, file);
}

export function readNoeFreedomRunLedgerFile(ref = '', { root = process.cwd() } = {}) {
  const file = resolveNoeFreedomRunLedgerRef(root, ref);
  const ledger = JSON.parse(readFileSync(file, 'utf8'));
  const validation = validateNoeFreedomRunLedger(ledger);
  return {
    ok: validation.ok,
    errors: validation.errors,
    ref: assertRelativeLedgerRef(ref),
    path: file,
    ledger,
  };
}

function ledgerNextActionPreview(ledger = {}) {
  const source = Array.isArray(ledger.runtime?.nextFreedomActions) ? ledger.runtime.nextFreedomActions : [];
  return source.slice(0, 12).map((item, index) => ({
    stepId: clean(item?.stepId || `step-${index + 1}`, 120),
    title: clean(item?.title || item?.label || '', 160),
    actionId: clean(item?.actionId || item?.toolId || item?.operation || '', 180),
    mode: clean(item?.mode || 'developer_unrestricted', 80),
  })).filter((item) => item.actionId);
}

function summarizeNoeFreedomRunLedgerRead(read = {}, stat = null) {
  const ledger = safeObject(read.ledger);
  const nextFreedomActions = ledgerNextActionPreview(ledger);
  const operation = clean(ledger.action?.operation, 180);
  const resumableOperation = ![
    'noe.freedom.run.history',
    'noe.freedom.run.resume_next_actions',
  ].includes(operation);
  return {
    ok: read.ok === true && ledger.ok === true,
    valid: read.ok === true,
    errors: Array.isArray(read.errors) ? read.errors.map((item) => clean(item, 1000)) : [],
    ref: clean(read.ref, 2000),
    runId: clean(ledger.runId, 180),
    createdAt: clean(ledger.createdAt, 80),
    action: {
      operation,
      capability: clean(ledger.action?.capability, 120),
      riskLevel: clean(ledger.action?.riskLevel, 40),
    },
    dryRunOnly: ledger.dryRunOnly !== false,
    realExecute: ledger.realExecute === true,
    authorizationMode: clean(ledger.authorization?.mode, 80),
    blockerCount: Array.isArray(ledger.blockers) ? ledger.blockers.length : 0,
    warningCount: Array.isArray(ledger.warnings) ? ledger.warnings.length : 0,
    hasNextFreedomActions: nextFreedomActions.length > 0,
    nextActionCount: nextFreedomActions.length,
    nextFreedomActions,
    resumeCandidate: read.ok === true && ledger.ok === true && resumableOperation && nextFreedomActions.length > 0,
    sha256: clean(ledger.sha256, 80),
    mtimeMs: Number(stat?.mtimeMs) || 0,
    secretValuesReturned: ledger.secretValuesReturned === true,
  };
}

// 取文件 mtimeMs，stat 失败（文件在 walk 收集后被并发删除/不可访问）容忍为 0（fail-open）。
// 供 findNoeFreedomRunLedgerFiles 的稳健排序用：消失文件排到末尾而非抛 ENOENT 冲垮整个列举。
function safeLedgerMtimeMs(file) {
  try { return statSync(file).mtimeMs; } catch { return 0; }
}

export function findNoeFreedomRunLedgerFiles({
  root = process.cwd(),
  dir = DEFAULT_NOE_FREEDOM_RUN_LEDGER_DIR,
  maxDepth = 6,
} = {}) {
  const safeDir = assertRelativeOutputDir(dir);
  const base = resolve(root, safeDir);
  if (!pathInside(root, base)) throw new Error('freedom_run_ledger_dir_outside_root');
  if (!existsSync(base)) return [];
  assertNoExistingSymlink(root, base);
  assertExistingDirectoryInsideRoot(root, base);
  const out = [];
  const walk = (path, depth = 0) => {
    if (depth > maxDepth) return;
    const current = lstatSync(path);
    if (current.isSymbolicLink()) throw new Error('freedom_run_ledger_symlink_path_denied');
    if (current.isDirectory()) {
      for (const entry of readdirSync(path)) walk(resolve(path, entry), depth + 1);
      return;
    }
    if (current.isFile() && path.endsWith(`${sep}ledger.json`)) out.push(path);
  };
  walk(base, 0);
  // 强健+性能（批4）：原比较器内对每个文件重复 statSync（O(n log n) 次系统调用），且
  //   若某 ledger 在 walk() 收集后、排序前被并发清理删除，statSync 抛 ENOENT 会冲垮整个列举
  //   （调用方 runNoeFreedomAdapter.execute 不裹 try/catch → noe.freedom.run.history 整体失败）。
  //   改 decorate-sort-undecorate：每文件只 stat 一次；stat 失败（文件已消失等）容忍为 mtime 0
  //   排到末尾，交给下游 listNoeFreedomRunLedgers 逐项 try/catch 优雅处理（与其容错语义一致）。
  //   全存在时排序结果与旧实现逐字等价（同为按 mtime 降序）。
  return out
    .map((file) => ({ file, mtimeMs: safeLedgerMtimeMs(file) }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((entry) => entry.file);
}

export function listNoeFreedomRunLedgers({
  root = process.cwd(),
  dir = DEFAULT_NOE_FREEDOM_RUN_LEDGER_DIR,
  limit = 20,
  onlyWithNextActions = false,
  requireOk = false,
} = {}) {
  const maxItems = Math.max(1, Math.min(200, Number(limit) || 20));
  const files = findNoeFreedomRunLedgerFiles({ root, dir });
  const items = [];
  for (const file of files) {
    const ref = relative(root, file);
    let item;
    try {
      const read = readNoeFreedomRunLedgerFile(ref, { root });
      item = summarizeNoeFreedomRunLedgerRead(read, statSync(file));
    } catch (error) {
      item = {
        ok: false,
        valid: false,
        errors: [`freedom_run_ledger_read_failed:${clean(error?.message || error, 500)}`],
        ref: clean(ref, 2000),
        resumeCandidate: false,
        hasNextFreedomActions: false,
        nextActionCount: 0,
        nextFreedomActions: [],
        mtimeMs: 0,
        secretValuesReturned: false,
      };
    }
    if (onlyWithNextActions && !item.hasNextFreedomActions) continue;
    if (requireOk && !item.ok) continue;
    items.push(item);
    if (items.length >= maxItems) break;
  }
  return {
    ok: true,
    dir: safeObject({ ref: assertRelativeOutputDir(dir) }).ref,
    checked: files.length,
    returned: items.length,
    items,
    secretValuesReturned: false,
  };
}

export function writeNoeFreedomRunLedgerFile({
  result = {},
  root = process.cwd(),
  outDir = DEFAULT_NOE_FREEDOM_RUN_LEDGER_DIR,
  runId = '',
} = {}) {
  const ledger = buildNoeFreedomRunLedger({ result, runId });
  const safeOutDir = assertRelativeOutputDir(outDir);
  const base = resolve(root, safeOutDir);
  if (!pathInside(root, base)) throw new Error('freedom_run_ledger_out_dir_outside_root');
  const dir = resolve(base, ledger.runId);
  if (!pathInside(base, dir)) throw new Error('freedom_run_ledger_path_escape');
  assertNoExistingSymlink(root, dir);
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, 'ledger.json');
  writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`);
  return {
    ok: true,
    ledger,
    path: file,
    ref: relative(root, file),
    sha256: ledger.sha256,
  };
}
