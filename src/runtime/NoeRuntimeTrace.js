// @ts-check
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactSensitiveText } from './NoeContextScrubber.js';

export const NOE_RUNTIME_TRACE_SCHEMA_VERSION = 1;
export const DEFAULT_NOE_RUNTIME_TRACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_NOE_RUNTIME_TRACE_BASE_DIR = 'output/noe-runtime-trace';
export const DEFAULT_NOE_RUNTIME_TRACE_MAX_FILE_BYTES = 5 * 1024 * 1024;

export const NOE_RUNTIME_TRACE_STAGES = Object.freeze([
  'observe',
  'can_execute',
  'act',
  'verify',
  'learn',
]);

export const NOE_RUNTIME_TRACE_STATUSES = Object.freeze([
  'started',
  'passed',
  'blocked',
  'completed',
  'failed',
  'skipped',
]);

const POLICY_DEFAULTS = Object.freeze({
  runtimeTouched: false,
  runtimeSemanticChange: false,
  memoryV2Writes: false,
  liveRestart: false,
  privateHoldoutRead: false,
  secretValuesReturned: false,
});

const REDACTION_DEFAULTS = Object.freeze({
  prompts: 'excluded',
  rawStreams: 'excluded',
  memoryBodies: 'excluded',
  lessonBodies: 'excluded',
  ownerTokens: 'excluded',
  secrets: 'excluded',
});

const FORBIDDEN_KEY_RE = /(?:raw[_-]?prompt|prompt|stdout|stderr|dom|html|body|memory[_-]?body|lesson|card|owner[_-]?token|secret|token|password|passwd|authorization|cookie|api[_-]?key|private[_-]?key|credential)/i;
const FORBIDDEN_SUMMARY_RE = /(?:raw\s*prompt|memory\s*body|lesson\s*body|card\s*body|owner\s*token|full\s*stdout|full\s*stderr|dom\s*body|secret\s*value)/i;
const FORBIDDEN_VALUE_RE = /(?:raw\s*prompt|full\s*stdout|full\s*stderr|stdout\s*:|stderr\s*:|<html\b|<body\b|<\/body>|dom\s*body|memory\s*body|lesson\s*body|card\s*body|owner\s*token|secret\s*value)/i;
const PRIVATE_HOLDOUT_REF_RE = /(^|\/)evals\/neo\/private_holdout(?:\/|$)/i;
const SECRET_VALUE_RE = /(sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|Authorization:\s*Bearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]{8,}|X-Panel-Owner-Token["':\s]+(?!\[redacted\])[0-9a-f]{24,})/i;
const SAFE_METRIC_LABEL_RE = /^[A-Za-z0-9._:/@-]{1,160}$/;

function nowIso(nowMs = Date.now()) {
  return new Date(Number(nowMs) || Date.now()).toISOString();
}

function sha256(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function clean(value, max = 1000) {
  return redactSensitiveText(String(value ?? '').replace(/\s+/g, ' ').trim()).slice(0, max);
}

function cleanSummary(value) {
  const text = clean(value, 1000);
  return FORBIDDEN_SUMMARY_RE.test(text) ? '[redacted-runtime-trace-summary]' : text;
}

function cleanMetricString(value) {
  const text = clean(value, 240);
  if (!text) return text;
  if (FORBIDDEN_VALUE_RE.test(text)) return '[redacted-runtime-trace-value]';
  if (!SAFE_METRIC_LABEL_RE.test(text)) return '[redacted-runtime-trace-value]';
  return text;
}

function cleanId(value, fallback = '') {
  return clean(value || fallback, 180).replace(/[^a-zA-Z0-9._:/@-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 180);
}

function dayStamp(nowMs = Date.now()) {
  return nowIso(nowMs).slice(0, 10);
}

function bool(value) {
  return value === true;
}

function normalizeStage(stage) {
  const cleanStage = clean(stage, 80);
  return NOE_RUNTIME_TRACE_STAGES.includes(cleanStage) ? cleanStage : 'observe';
}

function normalizeStatus(status) {
  const cleanStatus = clean(status, 80);
  return NOE_RUNTIME_TRACE_STATUSES.includes(cleanStatus) ? cleanStatus : 'completed';
}

function makeTracePathError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function nearestExistingPath(file) {
  let current = file;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function insidePath(root, file) {
  const ref = relPath(root, file);
  return ref === '' || (ref !== '..' && !ref.startsWith('../') && !ref.startsWith('/'));
}

function relPath(root, full) {
  return relative(root, full).replace(/\\/g, '/');
}

export function resolveNoeRuntimeTraceDir({
  root = DEFAULT_NOE_RUNTIME_TRACE_ROOT,
  baseDir = DEFAULT_NOE_RUNTIME_TRACE_BASE_DIR,
  label = 'trace_dir',
} = {}) {
  const fullRoot = resolve(root);
  const realRoot = existsSync(fullRoot) ? realpathSync(fullRoot) : fullRoot;
  const fullDir = resolve(fullRoot, String(baseDir || DEFAULT_NOE_RUNTIME_TRACE_BASE_DIR));
  const rel = relPath(fullRoot, fullDir);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return {
      ok: false,
      fullDir,
      rel,
      error: makeTracePathError('NOE_RUNTIME_TRACE_PATH_ESCAPES_ROOT', `${label} escapes root`),
    };
  }
  if (PRIVATE_HOLDOUT_REF_RE.test(rel)) {
    return {
      ok: false,
      fullDir,
      rel,
      error: makeTracePathError('NOE_RUNTIME_TRACE_PRIVATE_HOLDOUT_FORBIDDEN', `${label} must not target private_holdout`),
    };
  }
  try {
    const existing = nearestExistingPath(fullDir);
    if (existsSync(existing)) {
      if (lstatSync(existing).isSymbolicLink()) {
        return {
          ok: false,
          fullDir,
          rel,
          error: makeTracePathError('NOE_RUNTIME_TRACE_SYMLINK_FORBIDDEN', `${label} uses forbidden symlink path`),
        };
      }
      if (!insidePath(realRoot, realpathSync(existing))) {
        return {
          ok: false,
          fullDir,
          rel,
          error: makeTracePathError('NOE_RUNTIME_TRACE_REALPATH_ESCAPES_ROOT', `${label} resolves outside root`),
        };
      }
    }
    if (existsSync(fullDir)) {
      if (lstatSync(fullDir).isSymbolicLink()) {
        return {
          ok: false,
          fullDir,
          rel,
          error: makeTracePathError('NOE_RUNTIME_TRACE_SYMLINK_FORBIDDEN', `${label} uses forbidden symlink path`),
        };
      }
      if (!insidePath(realRoot, realpathSync(fullDir))) {
        return {
          ok: false,
          fullDir,
          rel,
          error: makeTracePathError('NOE_RUNTIME_TRACE_REALPATH_ESCAPES_ROOT', `${label} resolves outside root`),
        };
      }
    }
  } catch (error) {
    return {
      ok: false,
      fullDir,
      rel,
      error: makeTracePathError('NOE_RUNTIME_TRACE_REALPATH_CHECK_FAILED', `${label} realpath check failed: ${clean(error?.message || error, 200)}`),
    };
  }
  return { ok: true, fullDir, rel: rel || '.', error: null };
}

function resolveNoeRuntimeTraceFile({
  root = DEFAULT_NOE_RUNTIME_TRACE_ROOT,
  fullDir,
  name,
  label = 'trace_file',
} = {}) {
  const fullRoot = resolve(root);
  const realRoot = existsSync(fullRoot) ? realpathSync(fullRoot) : fullRoot;
  const file = join(fullDir, String(name || ''));
  try {
    if (!/^runtime-trace-.*\.jsonl$/.test(String(name || ''))) {
      return {
        ok: false,
        file,
        error: makeTracePathError('NOE_RUNTIME_TRACE_FILE_NAME_INVALID', `${label} has invalid file name`),
      };
    }
    if (!existsSync(file)) {
      return {
        ok: false,
        file,
        error: makeTracePathError('NOE_RUNTIME_TRACE_FILE_MISSING', `${label} no longer exists`),
      };
    }
    if (lstatSync(file).isSymbolicLink()) {
      return {
        ok: false,
        file,
        error: makeTracePathError('NOE_RUNTIME_TRACE_SYMLINK_FORBIDDEN', `${label} uses forbidden symlink file`),
      };
    }
    const realDir = existsSync(fullDir) ? realpathSync(fullDir) : fullDir;
    const realFile = realpathSync(file);
    if (!insidePath(realRoot, realFile) || !insidePath(realDir, realFile)) {
      return {
        ok: false,
        file,
        error: makeTracePathError('NOE_RUNTIME_TRACE_REALPATH_ESCAPES_ROOT', `${label} resolves outside trace directory`),
      };
    }
  } catch (error) {
    return {
      ok: false,
      file,
      error: makeTracePathError('NOE_RUNTIME_TRACE_REALPATH_CHECK_FAILED', `${label} realpath check failed: ${clean(error?.message || error, 200)}`),
    };
  }
  return { ok: true, file, error: null };
}

function sanitizeValue(value, depth = 0) {
  if (depth > 5) return '[truncated]';
  if (typeof value === 'string') return cleanMetricString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 40)
      .map((item) => sanitizeValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value !== 'object') return clean(value, 500);
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 80)) {
    const safeKey = clean(key, 120);
    if (!safeKey || FORBIDDEN_KEY_RE.test(safeKey)) continue;
    const safeValue = sanitizeValue(item, depth + 1);
    if (safeValue !== undefined) out[safeKey] = safeValue;
  }
  return out;
}

function hasForbiddenTraceStringValue(value, depth = 0) {
  if (depth > 6 || value == null) return false;
  if (typeof value === 'string') return FORBIDDEN_VALUE_RE.test(value);
  if (Array.isArray(value)) return value.some((item) => hasForbiddenTraceStringValue(item, depth + 1));
  if (typeof value === 'object') {
    return Object.values(value).some((item) => hasForbiddenTraceStringValue(item, depth + 1));
  }
  return false;
}

function normalizeRefs(refs = []) {
  const input = Array.isArray(refs)
    ? refs
    : refs && typeof refs === 'object'
      ? Object.values(refs).flat()
      : [refs];
  const out = [];
  for (const value of input) {
    const ref = clean(value, 800).replace(/\\/g, '/');
    if (!ref || PRIVATE_HOLDOUT_REF_RE.test(ref) || out.includes(ref)) continue;
    out.push(ref);
    if (out.length >= 24) break;
  }
  return out;
}

function normalizePolicy(policy = {}) {
  return {
    runtimeTouched: bool(policy.runtimeTouched),
    runtimeSemanticChange: bool(policy.runtimeSemanticChange),
    memoryV2Writes: bool(policy.memoryV2Writes),
    liveRestart: bool(policy.liveRestart),
    privateHoldoutRead: bool(policy.privateHoldoutRead),
    secretValuesReturned: bool(policy.secretValuesReturned),
  };
}

function normalizeEntity(entity = {}) {
  const type = clean(entity.type || 'manual', 80);
  return {
    type: type || 'manual',
    id: clean(entity.id || '', 180),
  };
}

function hashRecord(record) {
  const copy = { ...record };
  delete copy.sha256;
  return sha256(JSON.stringify(copy));
}

export function buildNoeRuntimeTraceRecord(input = {}, deps = {}) {
  const ts = Number(input.ts || deps.nowMs || Date.now());
  const stage = normalizeStage(input.stage);
  const source = cleanId(input.source, 'manual_audit') || 'manual_audit';
  const entity = normalizeEntity(input.entity);
  const rootRef = clean(input.rootRef || (entity.id ? `${entity.type}:${entity.id}` : 'manual'), 300) || 'manual';
  const baseRecord = {
    schemaVersion: NOE_RUNTIME_TRACE_SCHEMA_VERSION,
    traceId: cleanId(input.traceId, `rt-${sha256(`${stage}:${source}:${rootRef}:${ts}`).slice(0, 24)}`),
    rootRef,
    stage,
    stageDetail: clean(input.stageDetail || '', 160),
    ts,
    at: nowIso(ts),
    source,
    entity,
    status: normalizeStatus(input.status),
    summary: cleanSummary(input.summary || ''),
    refs: normalizeRefs(input.refs),
    policy: { ...POLICY_DEFAULTS, ...normalizePolicy(input.policy) },
    redaction: { ...REDACTION_DEFAULTS },
    metrics: sanitizeValue(input.metrics || {}),
  };
  return {
    ...baseRecord,
    sha256: hashRecord(baseRecord),
  };
}

export function validateNoeRuntimeTraceRecord(record = {}) {
  const errors = [];
  if (record.schemaVersion !== NOE_RUNTIME_TRACE_SCHEMA_VERSION) errors.push('unsupported_runtime_trace_schema_version');
  if (!clean(record.traceId, 180)) errors.push('trace_id_required');
  if (!NOE_RUNTIME_TRACE_STAGES.includes(record.stage)) errors.push('stage_invalid');
  if (!NOE_RUNTIME_TRACE_STATUSES.includes(record.status)) errors.push('status_invalid');
  if (!clean(record.source, 180)) errors.push('source_required');
  if (!record.entity || typeof record.entity !== 'object') errors.push('entity_required');
  if (!record.policy || typeof record.policy !== 'object') errors.push('policy_required');
  for (const [key, expected] of Object.entries(POLICY_DEFAULTS)) {
    if (typeof record.policy?.[key] !== 'boolean') errors.push(`policy_${key}_boolean_required`);
    if (expected === false && record.policy?.[key] === true) errors.push(`policy_${key}_violation`);
  }
  for (const [key, expected] of Object.entries(REDACTION_DEFAULTS)) {
    if (record.redaction?.[key] !== expected) errors.push(`redaction_${key}_must_be_${expected}`);
  }
  const text = JSON.stringify(record);
  if (PRIVATE_HOLDOUT_REF_RE.test(text.replace(/\\/g, '/'))) errors.push('private_holdout_ref_forbidden');
  if (SECRET_VALUE_RE.test(text)) errors.push('secret_value_detected');
  if (FORBIDDEN_SUMMARY_RE.test(String(record.summary || ''))) errors.push('forbidden_summary_marker_detected');
  if (hasForbiddenTraceStringValue(record)) errors.push('forbidden_raw_payload_marker_detected');
  if (record.sha256 !== hashRecord(record)) errors.push('sha256_mismatch');
  return { ok: errors.length === 0, errors };
}

function serializeAppendError(error) {
  return {
    message: clean(error?.message || error || 'unknown', 400),
    code: clean(error?.code || '', 80),
  };
}

export class NoeRuntimeTraceWriter {
  constructor({
    root = DEFAULT_NOE_RUNTIME_TRACE_ROOT,
    baseDir = DEFAULT_NOE_RUNTIME_TRACE_BASE_DIR,
    maxFileBytes = DEFAULT_NOE_RUNTIME_TRACE_MAX_FILE_BYTES,
    appendFileFn = appendFile,
    mkdirFn = mkdir,
    statFn = stat,
    now = Date.now,
  } = {}) {
    this.root = resolve(root);
    this.dir = resolveNoeRuntimeTraceDir({ root: this.root, baseDir, label: 'runtime_trace_writer_base_dir' });
    this.baseDir = this.dir.fullDir;
    this.maxFileBytes = Math.max(128 * 1024, Number(maxFileBytes) || DEFAULT_NOE_RUNTIME_TRACE_MAX_FILE_BYTES);
    this.appendFileFn = appendFileFn;
    this.mkdirFn = mkdirFn;
    this.statFn = statFn;
    this.now = now;
    this.queue = Promise.resolve();
  }

  async traceFile(nowMs = this.now()) {
    if (!this.dir.ok) throw this.dir.error;
    await this.mkdirFn(this.baseDir, { recursive: true, mode: 0o700 });
    const dayFile = join(this.baseDir, `runtime-trace-${dayStamp(nowMs)}.jsonl`);
    try {
      const info = await this.statFn(dayFile);
      if (Number(info.size || 0) >= this.maxFileBytes) {
        return join(this.baseDir, `runtime-trace-${dayStamp(nowMs)}-${Number(nowMs) || Date.now()}.jsonl`);
      }
    } catch {}
    return dayFile;
  }

  append(input = {}) {
    const nowMs = Number(input.ts || this.now());
    const record = buildNoeRuntimeTraceRecord(input, { nowMs });
    const job = this.queue
      .then(async () => {
        const file = await this.traceFile(nowMs);
        const body = `${JSON.stringify(record)}\n`;
        await this.appendFileFn(file, body, { mode: 0o600 });
        return {
          ok: true,
          record,
          path: relative(this.root, file).replace(/\\/g, '/'),
        };
      })
      .catch((error) => ({
        ok: false,
        record,
        error: serializeAppendError(error),
      }));
    this.queue = job.then(() => undefined, () => undefined);
    return job;
  }
}

export function appendNoeRuntimeTrace(input = {}, opts = {}) {
  const writer = opts.writer || new NoeRuntimeTraceWriter(opts);
  return writer.append(input);
}

export async function readNoeRuntimeTraceRecords({
  root = DEFAULT_NOE_RUNTIME_TRACE_ROOT,
  baseDir = DEFAULT_NOE_RUNTIME_TRACE_BASE_DIR,
  limit = 5000,
} = {}) {
  const dir = resolveNoeRuntimeTraceDir({ root, baseDir, label: 'runtime_trace_input_dir' });
  if (!dir.ok) {
    return {
      records: [],
      files: [],
      invalidLines: 0,
      sourceDir: dir.rel || '',
      error: serializeAppendError(dir.error),
    };
  }
  const fullDir = dir.fullDir;
  const max = Math.max(1, Math.min(50_000, Number(limit) || 5000));
  let files = [];
  try {
    files = (await readdir(fullDir))
      .filter((name) => /^runtime-trace-.*\.jsonl$/.test(name))
      .sort();
  } catch {
    return { records: [], files: [], invalidLines: 0, sourceDir: dir.rel };
  }
  const records = [];
  let invalidLines = 0;
  for (const name of files) {
    if (records.length >= max) break;
    const file = resolveNoeRuntimeTraceFile({ root, fullDir, name, label: 'runtime_trace_input_file' });
    if (!file.ok) {
      return {
        records: [],
        files: [],
        invalidLines,
        sourceDir: dir.rel,
        error: serializeAppendError(file.error),
      };
    }
    const text = await readFile(file.file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        invalidLines += 1;
      }
      if (records.length >= max) break;
    }
  }
  return {
    records,
    files: files.map((name) => join(dir.rel, name).replace(/\\/g, '/')),
    invalidLines,
    sourceDir: dir.rel,
  };
}

export function buildNoeRuntimeTraceSnapshot({ records = [], files = [], invalidLines = 0, sourceDir = DEFAULT_NOE_RUNTIME_TRACE_BASE_DIR, nowMs = Date.now(), error = null } = {}) {
  const byStage = Object.fromEntries(NOE_RUNTIME_TRACE_STAGES.map((stage) => [stage, 0]));
  const byStatus = {};
  const violations = [];
  let invalidRecords = 0;
  for (const record of records) {
    const validation = validateNoeRuntimeTraceRecord(record);
    if (!validation.ok) {
      invalidRecords += 1;
      for (const error of validation.errors) {
        if (/violation|secret|private_holdout/.test(error) && !violations.includes(error)) violations.push(error);
      }
    }
    if (record.stage in byStage) byStage[record.stage] += 1;
    const status = clean(record.status || 'unknown', 80) || 'unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  const blockers = [];
  if (records.length <= 0) blockers.push('runtime_trace_absent');
  if (invalidLines > 0) blockers.push('runtime_trace_invalid_jsonl');
  if (invalidRecords > 0) blockers.push('runtime_trace_schema_invalid');
  if (violations.length > 0) blockers.push('runtime_trace_policy_or_secret_violation');
  if (error?.code) blockers.push('runtime_trace_source_rejected');
  return {
    ok: blockers.length === 0,
    schemaVersion: NOE_RUNTIME_TRACE_SCHEMA_VERSION,
    generatedAt: nowIso(nowMs),
    status: {
      runtimeTraceReady: records.length > 0,
      blockers,
      violations,
      error: error || null,
    },
    coverage: {
      filesScanned: files.length,
      recordsScanned: records.length,
      invalidLines,
      invalidRecords,
      byStage,
      byStatus,
    },
    source: {
      dir: clean(sourceDir, 1000),
      policy: 'JSONL-only aggregation; writes snapshot artifacts only; no live 51835; no memory-v2 writes; no private_holdout reads; no model calls',
    },
  };
}
