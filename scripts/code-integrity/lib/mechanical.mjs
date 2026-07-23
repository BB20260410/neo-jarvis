// @ts-check

import { lstatSync, readFileSync } from 'node:fs';
import { resolveWithin } from './artifacts.mjs';

const CODE_PATH = /\.(?:cjs|js|mjs)$/i;
const TEXT_PATH = /\.(?:cjs|css|html?|js|json|md|mjs|toml|txt|ya?ml)$/i;
const TEST_PATH = /(?:^|\/)(?:test|tests)\/|\.(?:spec|test)\.(?:cjs|js|mjs)$/i;
const TS_NOCHECK = new RegExp(`@ts-${'nocheck'}\\b`);
const TS_IGNORE = new RegExp(`@ts-${'ignore'}\\b`);
const BLANKET_ESLINT_DISABLE = new RegExp(`^\\s*(?:\\/\\/|\\/\\*)\\s*eslint-${'disable'}\\s*(?:\\*\\/)?\\s*$`, 'm');

/** @param {string} text */
function hasTsCheckHeader(text) {
  const lines = text.split(/\r?\n/).slice(0, 4);
  if (lines[0]?.startsWith('#!')) lines.shift();
  return lines.slice(0, 3).some((line) => line.trim() === '// @ts-check');
}

/**
 * These checks intentionally cover only deterministic cross-model hygiene.
 * ESLint remains the semantic/style authority; DI and behavior quality still
 * require tests/review and are not guessed from source strings.
 * @param {string} repoRoot
 * @param {string[]} changedPaths
 * @param {string[]} newPaths
 * @param {Record<string, Array<{ line: number, text: string }>>} addedLinesByPath
 */
export function inspectChangedFiles(repoRoot, changedPaths, newPaths = [], addedLinesByPath = {}) {
  const newSet = new Set(newPaths);
  /** @type {Record<string, number>} */
  const incrementalAddedLineCounts = {};
  /** @type {Array<{ code: string, path: string, line: number|null }>} */
  const issues = [];

  /** @param {string} code @param {string} pathValue @param {number|null} [line] */
  const add = (code, pathValue, line = null) => issues.push({ code, path: pathValue, line });

  for (const pathValue of [...new Set(changedPaths)].sort()) {
    const absolute = resolveWithin(repoRoot, pathValue);
    if (!TEXT_PATH.test(pathValue)) continue;
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      add('symlink_not_allowed', pathValue);
      continue;
    }
    if (!stat.isFile()) {
      add('non_file_not_allowed', pathValue);
      continue;
    }
    const bytes = readFileSync(absolute);
    const text = bytes.toString('utf8');
    if (text.includes('\uFFFD')) add('invalid_utf8', pathValue);

    if (!text.endsWith('\n')) add('missing_final_newline', pathValue);

    if (!CODE_PATH.test(pathValue)) continue;
    const isNew = newSet.has(pathValue);
    const scopedLines = isNew
      ? text.split('\n').slice(0, text.endsWith('\n') ? -1 : undefined).map((line, index) => ({ line: index + 1, text: line }))
      : (addedLinesByPath[pathValue] || []);
    incrementalAddedLineCounts[pathValue] = scopedLines.length;

    const conflictStart = scopedLines.find((item) => /^<{7} .+$/.test(item.text));
    const conflictMiddle = scopedLines.some((item) => /^={7}$/.test(item.text));
    const conflictEnd = scopedLines.some((item) => /^>{7} .+$/.test(item.text));
    if (conflictStart && conflictMiddle && conflictEnd) add('merge_conflict_marker', pathValue, conflictStart.line);
    const crlf = scopedLines.find((item) => item.text.endsWith('\r'));
    if (crlf) add('crlf_line_endings', pathValue, crlf.line);
    const trailing = scopedLines.find((item) => /[ \t]+\r?$/.test(item.text));
    if (trailing) add('trailing_whitespace', pathValue, trailing.line);
    const tabIndent = scopedLines.find((item) => /^\t+/.test(item.text));
    if (tabIndent) add('tab_indentation', pathValue, tabIndent.line);

    if (isNew) {
      if (!hasTsCheckHeader(text)) add('new_code_missing_ts_check', pathValue);
      const lineCount = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      if (lineCount >= 500) add('new_code_not_under_500_lines', pathValue);
    }

    const noCheck = scopedLines.find((item) => TS_NOCHECK.test(item.text));
    if (noCheck) add('ts_nocheck_forbidden', pathValue, noCheck.line);
    const tsIgnore = scopedLines.find((item) => TS_IGNORE.test(item.text));
    if (tsIgnore) add('ts_ignore_forbidden', pathValue, tsIgnore.line);
    const blanketEslint = scopedLines.find((item) => BLANKET_ESLINT_DISABLE.test(item.text));
    if (blanketEslint) add('blanket_eslint_disable', pathValue, blanketEslint.line);

    if (TEST_PATH.test(pathValue)) {
      const skipped = scopedLines.find((item) => /\b(?:describe|suite|it|test)(?:\.[A-Za-z_$][\w$]*)*\.(?:only|skip|todo|skipIf|runIf)(?:\.[A-Za-z_$][\w$]*)*\s*\(/.test(item.text));
      if (skipped) add('focused_or_skipped_test', pathValue, skipped.line);
    }
  }

  return {
    schema: 'neo.code-integrity.mechanical.v1',
    checkedPaths: [...new Set(changedPaths)].sort(),
    newPaths: [...new Set(newPaths)].sort(),
    incrementalAddedLineCounts,
    issues,
    passed: issues.length === 0,
  };
}
