// Codebase Index 扫描上限集中配置（P6 刀1）：把原先散落的硬编码上限集中于此，
// 并支持从 ~/.noe-panel/codebase-limits.json 覆盖（缺省用默认值），便于大库调参而不改代码。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const CODEBASE_LIMIT_DEFAULTS = Object.freeze({
  maxScanFiles: 260,
  maxFocusFiles: 24,
  maxFileBytes: 500_000,
  maxSnippetChars: 220,
  maxScanMs: 1200,
  // FTS / vector / snapshot 索引容量上限（P6 刀2：从各 index 文件集中至此，可经 override 调参）
  maxFtsRows: 2500,
  maxVectorRows: 1200,
  maxSnapshotsPerCwd: 48,
});

/**
 * Loads codebase limit overrides from a JSON file.
 *
 * @param {string} [path] - The path to the JSON configuration file.
 * @returns {Record<string, number>} An object containing the valid override values.
 */
export function loadCodebaseLimitOverrides(path = join(homedir(), '.noe-panel', 'codebase-limits.json')) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    /** @type {Record<string, number>} */
    const out = {};
    for (const key of Object.keys(CODEBASE_LIMIT_DEFAULTS)) {
      const v = raw?.[key];
      if (Number.isFinite(v) && v > 0) out[key] = Math.trunc(v);
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Retrieves the final codebase limits by merging defaults with overrides.
 *
 * @param {Record<string, number>} [overrides] - Optional override values. If not provided, loads from default config file.
 * @returns {Record<string, number>} The merged codebase limits configuration.
 */
export function getCodebaseLimits(overrides) {
  return { ...CODEBASE_LIMIT_DEFAULTS, ...(overrides || loadCodebaseLimitOverrides()) };
}

// 模块加载时解析一次（运行时配置快照）
export const CODEBASE_LIMITS = getCodebaseLimits();

/**
 * Clamps an input to a safe non-negative integer in [min, max], returning
 * `fallback` for any unusable value (undefined / null / NaN / ±Infinity /
 * negative / non-numeric / empty-string).
 *
 * Defensive goals:
 *  - Never throw `TypeError` (e.g. "Cannot convert undefined to number").
 *  - Never propagate `NaN` or `±Infinity` to callers.
 *  - Negative inputs (and -0) fall back to `fallback`; only non-negative
 *    finite numbers make it through clamping.
 *  - Floats are truncated toward zero, matching `loadCodebaseLimitOverrides`.
 *  - Bad `min` / `max` bounds (NaN / negative / inverted) are coerced to
 *    sane defaults ([1, Number.MAX_SAFE_INTEGER]) so clamping can never break.
 *
 * @param {*}      v         Candidate value; coerced via `Number(v)`.
 * @param {number} fallback  Safe default returned when `v` cannot be used.
 * @param {number} [min=1]   Inclusive lower bound (defaults enforce positivity).
 * @param {number} [max=Number.MAX_SAFE_INTEGER] Inclusive upper bound.
 * @returns {number}
 */
/**
 * Coerces a candidate value to a finite, non-negative integer, or `null`
 * when the value is unusable (undefined / null / non-numeric / empty string /
 * NaN / ±Infinity / negative). Floats are truncated toward zero, matching
 * `loadCodebaseLimitOverrides`.
 *
 * @param {*} v
 * @returns {number|null}
 */
function toFiniteNonNegativeInt(v) {
  if (v === undefined || v === null) return null;
  const t = typeof v;
  if (t !== 'number' && t !== 'string') return null;
  if (t === 'string' && v.trim() === '') return null;
  const num = Number(v);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.trunc(num);
}

/**
 * Sanitizes a single numeric bound, requiring it to be finite and ≥ `lo`;
 * returns `fallback` when the bound is unusable (NaN / Infinity / below `lo`).
 *
 * @param {*} b
 * @param {number} lo
 * @param {number} fallback
 * @returns {number}
 */
function sanitizeBound(b, lo, fallback) {
  const n = Number(b);
  return Number.isFinite(n) && n >= lo ? Math.trunc(n) : fallback;
}

/**
 * Clamps an input value to a safe integer within `[min, max]`, falling back to
 * `fallback` whenever the input is unusable (undefined / null / non-numeric /
 * empty string / NaN / ±Infinity / negative). Floats are truncated toward zero,
 * matching `loadCodebaseLimitOverrides`.
 *
 * Defensive guarantees:
 *  - Never throws `TypeError` on unusable input (e.g. `undefined`).
 *  - Returns `Math.trunc(fallback)` (not `fallback` verbatim) so callers can
 *    always rely on an integer result.
 *  - Never propagates `NaN` or `±Infinity` to callers.
 *  - Bad `min` / `max` bounds (NaN / Infinity / below `0` / `min > max`) are
 *    coerced via `sanitizeBound` to sane defaults so clamping can never break
 *    or invert the range.
 *
 * @param {*}      v         Candidate value; coerced via `toFiniteNonNegativeInt`.
 * @param {number} fallback  Safe integer returned when `v` is unusable.
 * @param {number} [min=1]   Inclusive lower bound (defaults enforce positivity).
 * @param {number} [max=Number.MAX_SAFE_INTEGER] Inclusive upper bound.
 * @returns {number}
 */
export function limit(v, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const num = toFiniteNonNegativeInt(v);
  if (num === null) return Math.trunc(fallback);
  const lo = sanitizeBound(min, 0, 1);
  const hi = sanitizeBound(max, lo, Number.MAX_SAFE_INTEGER);
  if (num < lo) return lo;
  if (num > hi) return hi;
  return num;
}
