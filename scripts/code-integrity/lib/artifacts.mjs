// @ts-check

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertNoSymlinkSegments } from './policy.mjs';

const MAX_SNAPSHOT_FILE_BYTES = 64 * 1024 * 1024;

/** @param {Buffer|string} value */
export function hashBytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** @param {unknown} value */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** @param {string} filePath @param {unknown} value */
export function atomicJsonWrite(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    linkSync(tmp, filePath);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

/**
 * @param {string} pathValue
 */
export function assertSafeRelativePath(pathValue) {
  if (!pathValue || /[\u0000-\u001f\u007f]/.test(pathValue) || isAbsolute(pathValue)) {
    throw new Error(`unsafe relative path: ${JSON.stringify(pathValue)}`);
  }
  const clean = normalize(pathValue).split(sep).join('/');
  if (clean === '..' || clean.startsWith('../') || clean.includes('/../')) {
    throw new Error(`path escapes root: ${pathValue}`);
  }
  if (clean === '.git' || clean.startsWith('.git/') || clean === 'node_modules' || clean.startsWith('node_modules/')) {
    throw new Error(`forbidden repository path: ${pathValue}`);
  }
  if (clean.split('/').some((segment) => segment.startsWith('-'))) {
    throw new Error(`dash-prefixed path segment is not allowed: ${pathValue}`);
  }
  const base = clean.split('/').at(-1) || '';
  const secretName = base === '.env'
    || (base.startsWith('.env.') && !base.endsWith('.example'))
    || base === 'room-adapters.json'
    || base === 'owner-token.txt'
    || /\.(?:pem|p12|pfx|key)$/i.test(base);
  if (secretName) throw new Error(`secret-like path is not snapshot eligible: ${pathValue}`);
  return clean;
}

/** @param {string} root @param {string} relPath */
export function resolveWithin(root, relPath) {
  const clean = assertSafeRelativePath(relPath);
  const target = resolve(root, clean);
  const rel = relative(resolve(root), target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`resolved path escapes root: ${relPath}`);
  }
  return target;
}

/**
 * Read-only Git invocation. Optional locks and global/system configs are
 * disabled so status inspection cannot refresh another worktree's index.
 * @param {string} root
 * @param {string[]} args
 * @param {{ allowFailure?: boolean, encoding?: BufferEncoding|null }} [options]
 */
export function runGit(root, args, options = {}) {
  const encoding = options.encoding === undefined ? 'utf8' : options.encoding;
  const result = spawnSync('/usr/bin/git', ['--no-optional-locks', '-C', root, ...args], {
    encoding,
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0',
      PATH: '/usr/bin:/bin',
    },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!options.allowFailure && (result.error || result.status !== 0)) {
    const message = result.error?.message || String(result.stderr || '').trim() || `exit ${result.status}`;
    throw new Error(`git ${args.join(' ')} failed: ${message}`);
  }
  return result;
}

/** @param {string|Buffer|null|undefined} value */
export function splitNul(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
  return text.split('\0').filter(Boolean);
}

/** @param {string} root */
export function gitHead(root) {
  return String(runGit(root, ['rev-parse', 'HEAD']).stdout || '').trim();
}

/**
 * Return the dirty overlay as delete/add pairs rather than rename inference.
 * @param {string} root
 */
export function listDirtyPaths(root) {
  const commands = [
    ['diff', '--no-renames', '--name-only', '-z', '--'],
    ['diff', '--cached', '--no-renames', '--name-only', '-z', '--'],
    ['ls-files', '--others', '--exclude-standard', '-z', '--'],
  ];
  const paths = new Set();
  for (const command of commands) {
    for (const pathValue of splitNul(runGit(root, command).stdout)) {
      paths.add(assertSafeRelativePath(pathValue));
    }
  }
  return [...paths].sort();
}

/**
 * @param {string} root
 * @param {string} relPath
 */
export function describePath(root, relPath) {
  const clean = assertSafeRelativePath(relPath);
  const realRoot = realpathSync.native(root);
  const absolute = resolveWithin(realRoot, clean);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { path: clean, kind: 'deleted', size: 0, mode: null, sha256: null };
    }
    throw error;
  }
  const mode = stat.mode & 0o777;
  if (stat.isSymbolicLink()) throw new Error(`symlink path refused: ${clean}`);
  assertNoSymlinkSegments(realRoot, absolute, 'described path');
  if (!stat.isFile()) throw new Error(`unsupported dirty path type: ${clean}`);
  if (stat.size > MAX_SNAPSHOT_FILE_BYTES) throw new Error(`snapshot file exceeds 64 MiB: ${clean}`);
  const bytes = readFileSync(absolute);
  return { path: clean, kind: 'file', size: stat.size, mode, sha256: hashBytes(bytes) };
}

/** @param {string} root @param {string[]} paths */
export function describePaths(root, paths) {
  return paths.map((item) => describePath(root, item)).sort((a, b) => a.path.localeCompare(b.path));
}

/** @param {Array<Record<string, unknown>>} items */
export function manifestDigest(items) {
  return hashBytes(canonicalJson(items));
}

/**
 * @param {string} sourceRoot
 * @param {string} destinationRoot
 * @param {Array<ReturnType<typeof describePath>>} items
 */
export function copyManifestFiles(sourceRoot, destinationRoot, items) {
  const realSourceRoot = realpathSync.native(sourceRoot);
  const realDestinationRoot = realpathSync.native(destinationRoot);
  for (const item of items) {
    if (item.kind === 'deleted') continue;
    if (item.kind === 'symlink') throw new Error(`snapshot symlink refused: ${item.path}`);
    const source = resolveWithin(realSourceRoot, item.path);
    const destination = resolveWithin(realDestinationRoot, item.path);
    assertNoSymlinkSegments(realSourceRoot, source, 'snapshot source');
    assertNoSymlinkSegments(realDestinationRoot, dirname(destination), 'snapshot destination');
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(source, destination);
    if (typeof item.mode === 'number') chmodSync(destination, item.mode);
  }
}
