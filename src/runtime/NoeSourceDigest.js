// @ts-check
/**
 * Unified sourceDigest for Neo evidence binding.
 * Git commit alone is insufficient when the worktree is dirty.
 *
 * sourceDigest = SHA256(JCS({
 *   baseCommit,
 *   currentBytes: sorted path→sha256 of package*.json, electron-main.js, server.js,
 *     src/**, public/**, scripts/**, tests/**, build/**, .github/workflows/**,
 *   toolchain, target, buildFlags, nonSecretRuntimeConfigDigest
 * }))
 */
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);

const EXCLUDE_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'output',
  'out',
  'out-noe',
  'dist',
  'coverage',
  '.cache',
  'logs',
  'tmp',
  '.turbo',
]);

const INCLUDE_ROOT_FILES = [
  'package.json',
  'package-lock.json',
  '.nvmrc',
  'jsconfig.json',
  'vitest.config.js',
  'vitest.config.mjs',
  'eslint.config.js',
  'eslint.config.mjs',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'LICENSE',
  'electron-main.js',
  'server.js',
];

const INCLUDE_DIRS = [
  'src',
  'public',
  'website',
  'scripts',
  'tests',
  'build',
  'docs',
  '.github/workflows',
];

// These trees are shipped by electron-builder (or are public product
// surfaces), so every non-secret regular file is identity-bearing regardless
// of extension. Limiting them to a source-extension allowlist lets media,
// WASM, fonts, model data, or a future extension change the application while
// retaining the same sourceDigest.
const INCLUDE_ALL_FILE_DIRS = new Set([
  'src',
  'public',
  'website',
  'scripts',
  'build',
]);

const SOURCE_EXTS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.json',
  '.md',
  '.css',
  '.html',
  '.yml',
  '.yaml',
  '.sh',
  '.toml',
  '.txt',
  '.svg',
  '.plist',
  '.png',
  '.icns',
  '.py',
]);

const SOURCE_EXTENSIONLESS_BASENAMES = new Set([
  '_headers',
  '_redirects',
  'Dockerfile',
  'Makefile',
]);

const SECRET_BASENAMES = new Set(['.env', '.env.local', 'credentials.json']);

const MIGRATION_SWITCH_DEFAULTS = Object.freeze({
  NOE_UNIFIED_TASK_WRITE: '0',
  NOE_AGENT_RUNTIME_SHADOW: '0',
  NOE_UNIFIED_TASK_READ: '0',
  NOE_LEGACY_TASK_WRITES: '1',
});

// Only names and explicitly non-secret switch values enter the digest. Provider
// credentials, endpoints, HOME and proxy values are deliberately excluded.
const NON_SECRET_RUNTIME_KEY_NAMES = Object.freeze([
  ...Object.keys(MIGRATION_SWITCH_DEFAULTS),
  'NODE_ENV',
  'NOE_AUTONOMY_PROFILE',
  'NOE_BRAIN_CODE',
  'NOE_BRAIN_DEEP',
  'NOE_BRAIN_LOCAL',
  'NOE_BRAIN_MID',
  'NOE_COMPLETION_TRUTH_GATE',
]);

/**
 * RFC 8785-ish: recursively sort object keys; stable arrays; no whitespace.
 * @param {unknown} value
 * @returns {unknown}
 */
export function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(/** @type {Record<string, unknown>} */ (value)).sort()) {
      out[key] = sortKeysDeep(/** @type {Record<string, unknown>} */ (value)[key]);
    }
    return out;
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function jcsStringify(value) {
  return JSON.stringify(sortKeysDeep(value));
}

/**
 * @param {string|Buffer|Uint8Array} input
 * @returns {string}
 */
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => h.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * @param {string} relPath
 * @returns {boolean}
 */
export function shouldExcludePath(relPath) {
  const parts = relPath.split(/[/\\]/).filter(Boolean);
  if (parts.some((p) => EXCLUDE_DIR_NAMES.has(p))) return true;
  const base = parts[parts.length - 1] || '';
  if (SECRET_BASENAMES.has(base)) return true;
  if (base.endsWith('.pem') || base.endsWith('.log') || base.endsWith('.db') || base.endsWith('.sqlite') || base.endsWith('.sqlite3')) {
    return true;
  }
  return false;
}

/**
 * @param {string} relPath
 * @returns {boolean}
 */
export function isSourceLikePath(relPath) {
  const base = relPath.split(/[/\\]/).pop() || '';
  if (SOURCE_EXTENSIONLESS_BASENAMES.has(base)) return true;
  const idx = base.lastIndexOf('.');
  if (idx < 0) return false;
  return SOURCE_EXTS.has(base.slice(idx).toLowerCase());
}

/**
 * @param {string} root
 * @param {string} dirRel
 * @param {Record<string, string>} into
 * @param {{ includeAllFiles?: boolean }} [options]
 */
function walkDir(root, dirRel, into, options = {}) {
  const abs = join(root, dirRel);
  if (!existsSync(abs)) return;
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const rel = dirRel ? `${dirRel}/${ent.name}` : ent.name;
    const norm = rel.replace(/\\/g, '/');
    if (shouldExcludePath(norm)) continue;
    if (ent.isSymbolicLink()) {
      into[norm] = '';
      continue;
    }
    if (ent.isDirectory()) {
      walkDir(root, norm, into, options);
      continue;
    }
    if (!ent.isFile()) continue;
    if (
      options.includeAllFiles !== true &&
      !isSourceLikePath(norm) &&
      !INCLUDE_ROOT_FILES.includes(norm)
    ) continue;
    into[norm] = ''; // filled later async/sync
  }
}

/**
 * Collect sorted path→sha256 map for sourceDigest currentBytes.
 * @param {string} rootDir
 * @param {{ sync?: boolean }} [opts]
 * @returns {Promise<Record<string, string>> | Record<string, string>}
 */
export function collectCurrentBytes(rootDir, opts = {}) {
  const root = String(rootDir || '');
  /** @type {Record<string, string>} */
  const paths = {};
  for (const f of INCLUDE_ROOT_FILES) {
    const abs = join(root, f);
    if (
      existsSync(abs) &&
      (lstatSync(abs).isFile() || lstatSync(abs).isSymbolicLink()) &&
      !shouldExcludePath(f)
    ) paths[f] = '';
  }
  for (const d of INCLUDE_DIRS) {
    walkDir(root, d, paths, { includeAllFiles: INCLUDE_ALL_FILE_DIRS.has(d) });
  }

  const sortedKeys = Object.keys(paths).sort();
  if (opts.sync) {
    /** @type {Record<string, string>} */
    const out = {};
    for (const key of sortedKeys) {
      const path = join(root, key);
      const stat = lstatSync(path);
      out[key] = stat.isSymbolicLink()
        ? sha256Hex(jcsStringify({ kind: 'symlink', mode: stat.mode & 0o7777, target: readlinkSync(path) }))
        : sha256Hex(
            jcsStringify({
              kind: 'file',
              mode: stat.mode & 0o7777,
              sha256: sha256Hex(readFileSync(path)),
            }),
          );
    }
    return out;
  }
  return (async () => {
    /** @type {Record<string, string>} */
    const out = {};
    for (const key of sortedKeys) {
      const path = join(root, key);
      const stat = lstatSync(path);
      out[key] = stat.isSymbolicLink()
        ? sha256Hex(jcsStringify({ kind: 'symlink', mode: stat.mode & 0o7777, target: readlinkSync(path) }))
        : sha256Hex(
            jcsStringify({
              kind: 'file',
              mode: stat.mode & 0o7777,
              sha256: await sha256File(path),
            }),
          );
    }
    return out;
  })();
}

/**
 * Non-secret runtime config digest: only key presence / migration switches, never secret values.
 * @param {{ presentEnvKeys?: string[], migrationSwitches?: Record<string, string>, runtimeValues?: Record<string, string> }} [input]
 */
export function computeRuntimeConfigDigest(input = {}) {
  const payload = {
    migrationSwitches: input.migrationSwitches || MIGRATION_SWITCH_DEFAULTS,
    presentEnvKeys: [...new Set(input.presentEnvKeys || [])].sort(),
    runtimeValues: input.runtimeValues || {},
  };
  return `sha256:${sha256Hex(jcsStringify(payload))}`;
}

/**
 * Read the small, non-secret runtime shape that is allowed into evidence
 * identity. This prevents the digest from silently binding hard-coded defaults
 * when a migration switch is actually enabled.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function readNonSecretRuntimeConfig(env = process.env) {
  /** @type {Record<string, string>} */
  const migrationSwitches = {};
  for (const [key, fallback] of Object.entries(MIGRATION_SWITCH_DEFAULTS)) {
    migrationSwitches[key] = env[key] == null ? fallback : String(env[key]);
  }
  const presentEnvKeys = NON_SECRET_RUNTIME_KEY_NAMES.filter((key) => env[key] != null);
  /** @type {Record<string, string>} */
  const runtimeValues = {};
  for (const key of presentEnvKeys) {
    if (Object.prototype.hasOwnProperty.call(MIGRATION_SWITCH_DEFAULTS, key)) continue;
    runtimeValues[key] = String(env[key]);
  }
  return { migrationSwitches, presentEnvKeys, runtimeValues };
}

/**
 * @param {string} [cwd]
 * @returns {string}
 */
export function readGitBaseCommit(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * @param {string} [cwd]
 */
export function readToolchain(cwd = process.cwd()) {
  let electron = 'unknown';
  try {
    electron = String(require(join(cwd, 'node_modules/electron/package.json')).version || 'unknown');
  } catch {
    electron = 'unknown';
  }
  let npm = 'unknown';
  try {
    const npmCli = resolve(
      dirname(process.execPath),
      '..',
      'lib',
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    );
    npm = existsSync(npmCli)
      ? execFileSync(process.execPath, [npmCli, '-v'], { encoding: 'utf8' }).trim()
      : execFileSync('npm', ['-v'], { encoding: 'utf8' }).trim();
  } catch {
    npm = 'unknown';
  }
  return {
    node: process.version,
    npm,
    electron,
  };
}

/**
 * Build evidence key components.
 * @param {object} parts
 */
export function buildEvidenceKey(parts) {
  const payload = {
    artifactHashes: parts.artifactHashes || {},
    commandDigest: parts.commandDigest || null,
    gateId: parts.gateId,
    gateVersion: parts.gateVersion || '1',
    platform: parts.platform || process.platform,
    arch: parts.arch || process.arch,
    runtimeConfigDigest: parts.runtimeConfigDigest,
    sourceDigest: parts.sourceDigest,
  };
  return `sha256:${sha256Hex(jcsStringify(payload))}`;
}

/**
 * Compute full sourceDigest payload + digests.
 * @param {object} [opts]
 * @param {string} [opts.rootDir]
 * @param {string} [opts.baseCommit]
 * @param {Record<string, string>} [opts.currentBytes]
 * @param {object} [opts.toolchain]
 * @param {object} [opts.target]
 * @param {object} [opts.buildFlags]
 * @param {string} [opts.runtimeConfigDigest]
 * @param {string[]} [opts.presentEnvKeys]
 * @param {Record<string, string>} [opts.migrationSwitches]
 * @param {Record<string, string>} [opts.runtimeValues]
 * @param {boolean} [opts.sync]
 */
export async function computeSourceDigest(opts = {}) {
  if (Object.prototype.hasOwnProperty.call(opts, 'root') && !opts.rootDir) {
    throw new TypeError('computeSourceDigest expects rootDir, not root');
  }
  const rootDir = opts.rootDir || process.cwd();
  const baseCommit = opts.baseCommit || readGitBaseCommit(rootDir);
  const currentBytes =
    opts.currentBytes ||
    /** @type {Record<string, string>} */ (await collectCurrentBytes(rootDir, { sync: !!opts.sync }));
  const toolchain = opts.toolchain || readToolchain(rootDir);
  const target = opts.target || {
    platform: process.platform === 'darwin' ? 'darwin' : process.platform,
    arch: process.arch,
  };
  const buildFlags = opts.buildFlags || {};
  const detectedRuntimeConfig = readNonSecretRuntimeConfig();
  const runtimeConfigDigest =
    opts.runtimeConfigDigest ||
    computeRuntimeConfigDigest({
      migrationSwitches: opts.migrationSwitches || detectedRuntimeConfig.migrationSwitches,
      presentEnvKeys: opts.presentEnvKeys || detectedRuntimeConfig.presentEnvKeys,
      runtimeValues: opts.runtimeValues || detectedRuntimeConfig.runtimeValues,
    });

  const payload = {
    baseCommit,
    buildFlags,
    currentBytes,
    nonSecretRuntimeConfigDigest: runtimeConfigDigest,
    target,
    toolchain,
  };
  const canonical = jcsStringify(payload);
  const sourceDigest = `sha256:${sha256Hex(canonical)}`;
  return {
    sourceDigest,
    runtimeConfigDigest,
    baseCommit,
    fileCount: Object.keys(currentBytes).length,
    toolchain,
    target,
    buildFlags,
    pathListHash: `sha256:${sha256Hex(Object.keys(currentBytes).sort().join('\n'))}`,
    canonicalBytes: Buffer.byteLength(canonical, 'utf8'),
    payload,
  };
}

/**
 * Sync variant for unit tests with injected currentBytes.
 * @param {object} opts
 */
export function computeSourceDigestSync(opts = {}) {
  if (Object.prototype.hasOwnProperty.call(opts, 'root') && !opts.rootDir) {
    throw new TypeError('computeSourceDigestSync expects rootDir, not root');
  }
  const rootDir = opts.rootDir || process.cwd();
  const baseCommit = opts.baseCommit || 'test-base';
  const currentBytes =
    opts.currentBytes ||
    /** @type {Record<string, string>} */ (collectCurrentBytes(rootDir, { sync: true }));
  const toolchain = opts.toolchain || { node: 'v0', npm: '0', electron: '0' };
  const target = opts.target || { platform: 'test', arch: 'test' };
  const buildFlags = opts.buildFlags || {};
  const detectedRuntimeConfig = readNonSecretRuntimeConfig();
  const runtimeConfigDigest =
    opts.runtimeConfigDigest ||
    computeRuntimeConfigDigest({
      migrationSwitches: opts.migrationSwitches || detectedRuntimeConfig.migrationSwitches,
      presentEnvKeys: opts.presentEnvKeys || detectedRuntimeConfig.presentEnvKeys,
      runtimeValues: opts.runtimeValues || detectedRuntimeConfig.runtimeValues,
    });
  const payload = {
    baseCommit,
    buildFlags,
    currentBytes,
    nonSecretRuntimeConfigDigest: runtimeConfigDigest,
    target,
    toolchain,
  };
  const canonical = jcsStringify(payload);
  return {
    sourceDigest: `sha256:${sha256Hex(canonical)}`,
    runtimeConfigDigest,
    baseCommit,
    fileCount: Object.keys(currentBytes).length,
    payload,
    canonical,
  };
}
