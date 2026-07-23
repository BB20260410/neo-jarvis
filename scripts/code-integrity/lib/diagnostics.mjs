// @ts-check

import { canonicalJson, hashBytes } from './artifacts.mjs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** @param {string} value */
function normalizeMessage(value) {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * TypeScript positions are deliberately excluded from the fingerprint so a
 * harmless line move does not appear as a new diagnostic.
 * @param {string} line
 * @param {string} root
 */
export function parseDiagnosticLine(line, root = '') {
  const text = line.trim();
  if (!text) return null;
  const ts = text.match(/^(.*?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s*(.*)$/i);
  if (ts) {
    const rawPath = ts[1];
    let pathValue = rawPath.split('\\').join('/');
    if (root) {
      const rootPath = resolve(root);
      const absolutePath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(rootPath, rawPath);
      const rel = relative(rootPath, absolutePath);
      if (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) pathValue = rel.split(sep).join('/');
    }
    return {
      tool: 'typescript',
      path: pathValue,
      severity: ts[4].toLowerCase(),
      code: ts[5].toUpperCase(),
      message: normalizeMessage(ts[6]),
    };
  }
  const global = text.match(/^(error|warning)\s+(TS\d+):\s*(.*)$/i);
  if (global) {
    return { tool: 'typescript', path: '', severity: global[1].toLowerCase(), code: global[2].toUpperCase(), message: normalizeMessage(global[3]) };
  }
  return null;
}

/** @param {string} text @param {string} root */
export function diagnosticCounts(text, root = '') {
  const counts = new Map();
  /** @type {ReturnType<typeof parseDiagnosticLine>} */
  let pending = null;
  const flush = () => {
    if (!pending) return;
    const fingerprint = hashBytes(canonicalJson(pending));
    const current = counts.get(fingerprint) || { fingerprint, diagnostic: pending, count: 0 };
    current.count += 1;
    counts.set(fingerprint, current);
    pending = null;
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = parseDiagnosticLine(line, root);
    if (parsed) {
      flush();
      pending = parsed;
      continue;
    }
    if (/^Found \d+ errors?(?: in \d+ files?)?\.?$/i.test(line.trim())) {
      flush();
      continue;
    }
    if (/^\s+\S/.test(line) && pending) {
      pending.message = normalizeMessage(`${pending.message} ${line}`);
      continue;
    }
    throw new Error(`unsupported TypeScript diagnostic output at line: ${JSON.stringify(line.slice(0, 160))}`);
  }
  flush();
  return [...counts.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}

/** @param {ReturnType<typeof diagnosticCounts>} baseline @param {ReturnType<typeof diagnosticCounts>} current */
export function compareDiagnostics(baseline, current) {
  const baselineCounts = new Map(baseline.map((item) => [item.fingerprint, item.count]));
  return current
    .map((item) => ({ ...item, baselineCount: baselineCounts.get(item.fingerprint) || 0, newCount: Math.max(0, item.count - (baselineCounts.get(item.fingerprint) || 0)) }))
    .filter((item) => item.newCount > 0);
}
