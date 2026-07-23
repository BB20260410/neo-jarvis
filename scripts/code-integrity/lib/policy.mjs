// @ts-check

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const RESERVED_PORTS = Object.freeze([51735, 51835, 8123, 8126, 1234, 11434]);

export const DENIED_EXECUTABLE_NAMES = new Set([
  'bash',
  'codesign',
  'env',
  'fish',
  'kill',
  'killall',
  'launchctl',
  'npm',
  'npx',
  'open',
  'osascript',
  'pkill',
  'security',
  'sh',
  'spctl',
  'sudo',
  'xargs',
  'zsh',
]);

/** @param {string} value */
export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * SBPL accepts JSON-compatible quoted strings. Keeping the escaping in one
 * function prevents paths from becoming profile syntax.
 * @param {string} value
 */
export function quoteSbpl(value) {
  return JSON.stringify(String(value));
}

/**
 * @param {string} root
 * @param {string} candidate
 */
export function isPathInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * @param {string} root
 * @param {string} candidate
 * @param {string} label
 */
export function assertPathInside(root, candidate, label) {
  if (!isPathInside(root, candidate)) {
    throw new Error(`${label} escapes root: ${candidate}`);
  }
}

/**
 * Refuse every existing symlink component below a trusted real directory.
 * Call this before creating directories so mkdir cannot follow an attacker-
 * controlled parent link outside the task root.
 * @param {string} root
 * @param {string} candidate
 * @param {string} label
 */
export function assertNoSymlinkSegments(root, candidate, label) {
  const trustedRoot = resolve(root);
  const target = resolve(candidate);
  assertPathInside(trustedRoot, target, label);
  const rel = relative(trustedRoot, target);
  if (!rel) return;
  let cursor = trustedRoot;
  for (const segment of rel.split(sep)) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) continue;
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`${label} contains symlink component: ${cursor}`);
  }
}

/**
 * Resolve an existing directory and collapse symlinks before it becomes a
 * sandbox allow root.
 * @param {string} value
 * @param {string} label
 */
export function existingRealDirectory(value, label) {
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute: ${value}`);
  const real = realpathSync.native(value);
  if (!statSync(real).isDirectory()) throw new Error(`${label} must be a directory: ${real}`);
  return real;
}

/**
 * A protected path may not exist yet. Resolve it lexically, but collapse the
 * nearest existing parent is intentionally avoided: the sandbox must also
 * protect future creation under that exact location.
 * @param {string} value
 * @param {string} label
 */
export function absolutePath(value, label) {
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute: ${value}`);
  return resolve(value);
}

/**
 * @param {string} executable
 */
export function existingExecutable(executable) {
  if (!isAbsolute(executable)) {
    throw new Error(`executable must be an absolute path: ${executable}`);
  }
  const real = realpathSync.native(executable);
  if (!statSync(real).isFile()) throw new Error(`executable is not a file: ${real}`);
  return real;
}

/**
 * @param {string} executable
 */
export function assertExecutableNameAllowed(executable) {
  const name = basename(executable).toLowerCase();
  if (DENIED_EXECUTABLE_NAMES.has(name)) {
    throw new Error(`executable denied by static policy: ${name}`);
  }
}

/**
 * @param {string[]} roots
 */
export function uniquePaths(roots) {
  return [...new Set(roots.map((item) => resolve(item)))].sort();
}

/** @param {string} homeRoot */
export function defaultProtectedReadRoots(homeRoot) {
  const home = resolve(homeRoot);
  return uniquePaths([
    join(home, '.noe-panel'),
    join(home, '.noe-panel-keys'),
    join(home, '.noe-voice'),
    join(home, '.aws'),
    join(home, '.docker'),
    join(home, '.gnupg'),
    join(home, '.kube'),
    join(home, '.ssh'),
    join(home, '.config', 'gh'),
    join(home, '.config', 'gcloud'),
    join(home, 'Library', 'Keychains'),
    join(home, 'Library', 'LaunchAgents'),
  ]);
}

/** @param {string} homeRoot @param {string[]} targets */
function readTraversalPaths(homeRoot, targets) {
  const home = resolve(homeRoot);
  const paths = new Set([home]);
  for (const targetValue of targets) {
    let cursor = resolve(targetValue);
    if (!isPathInside(home, cursor)) continue;
    if (cursor !== home && !cursor.endsWith(sep)) cursor = dirname(cursor);
    while (isPathInside(home, cursor)) {
      paths.add(cursor);
      if (cursor === home) break;
      cursor = dirname(cursor);
    }
  }
  return [...paths].sort();
}

/**
 * @param {{
 *   allowedExecutables: string[],
 *   allowedWriteRoots: string[],
 *   protectedWriteRoots?: string[],
 *   allowedReadRoots?: string[],
 *   homeReadRoot?: string|null,
 *   protectedReadRoots?: string[],
 *   allowNetwork?: boolean
 * }} input
 */
export function buildSandboxProfile(input) {
  const allowedExecutables = uniquePaths(input.allowedExecutables || []);
  const allowedWriteRoots = uniquePaths(input.allowedWriteRoots || []);
  const protectedWriteRoots = uniquePaths(input.protectedWriteRoots || []);
  const allowedReadRoots = uniquePaths(input.allowedReadRoots || []);
  const protectedReadRoots = uniquePaths(input.protectedReadRoots || []);

  if (allowedExecutables.length === 0) throw new Error('at least one executable is required');
  if (allowedWriteRoots.length === 0) throw new Error('at least one write root is required');

  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny signal)',
    '(deny process-exec)',
    `(allow process-exec ${allowedExecutables.map((item) => `(literal ${quoteSbpl(item)})`).join(' ')})`,
    '(deny file-write*)',
    `(allow file-write* (literal "/dev/null") ${allowedWriteRoots.map((item) => `(subpath ${quoteSbpl(item)})`).join(' ')})`,
  ];
  if (protectedWriteRoots.length > 0) {
    lines.push(`(deny file-write* ${protectedWriteRoots.map((item) => `(subpath ${quoteSbpl(item)})`).join(' ')})`);
  }

  if (!input.allowNetwork) lines.push('(deny network*)');
  if (input.homeReadRoot) {
    const homeRoot = resolve(input.homeReadRoot);
    const traversalPaths = readTraversalPaths(homeRoot, [...allowedReadRoots, ...allowedExecutables]);
    lines.push(`(deny file-read* (subpath ${quoteSbpl(homeRoot)}))`);
    lines.push(`(allow file-read-metadata ${traversalPaths.map((item) => `(literal ${quoteSbpl(item)})`).join(' ')})`);
    if (allowedReadRoots.length > 0 || allowedExecutables.length > 0) {
      lines.push(`(allow file-read* ${allowedReadRoots.map((item) => `(subpath ${quoteSbpl(item)})`).join(' ')} ${allowedExecutables.map((item) => `(literal ${quoteSbpl(item)})`).join(' ')})`);
    }
  }
  if (protectedReadRoots.length > 0) {
    lines.push(`(deny file-read* ${protectedReadRoots.map((item) => `(subpath ${quoteSbpl(item)})`).join(' ')})`);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * @param {string[]} allowedWriteRoots
 * @param {string[]} protectedRoots
 */
export function assertNoProtectedOverlap(allowedWriteRoots, protectedRoots) {
  for (const allowed of allowedWriteRoots) {
    for (const protectedPath of protectedRoots) {
      if (isPathInside(protectedPath, allowed) || isPathInside(allowed, protectedPath)) {
        throw new Error(`allowed write root overlaps protected path: ${allowed} <-> ${protectedPath}`);
      }
    }
  }
}
