// @ts-check

import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertSafeRelativePath, canonicalJson, hashBytes } from './artifacts.mjs';
import { assertNoSymlinkSegments } from './policy.mjs';

export const INTERNAL_IMPACT_MAP = 'scripts/code-integrity/impact-map.json';
export const PROJECT_IMPACT_MAP = '.neo-code-integrity-impact.json';
const TEST_PATH = /(?:^|\/)(?:test|tests)\/.*\.(?:spec|test)\.(?:cjs|js|mjs)$|\.(?:spec|test)\.(?:cjs|js|mjs)$/i;

/** @param {string} pathValue */
function isTestPath(pathValue) {
  return TEST_PATH.test(pathValue);
}

/** @param {string} absolute @param {string} label */
function requireRegularFile(absolute, label) {
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}_not_regular`);
}

/**
 * Read a data-only, exact-path impact map. Globs and executable maps are
 * deliberately unsupported so an unrelated passing test cannot satisfy a
 * changed source file.
 * @param {string} repoRoot
 * @param {string[]} codePaths
 */
export function loadImpactMap(repoRoot, codePaths) {
  if (codePaths.length === 0) {
    return { path: null, sha256: null, coverage: [], tests: [], requiredScenarioIds: [], blockers: [] };
  }
  const relativePath = codePaths.some((item) => item.startsWith('scripts/code-integrity/'))
    ? INTERNAL_IMPACT_MAP
    : PROJECT_IMPACT_MAP;
  const absolute = resolve(repoRoot, relativePath);
  /** @type {string[]} */
  const blockers = [];
  let bytes;
  let value;
  try {
    assertNoSymlinkSegments(repoRoot, absolute, 'impact map');
    requireRegularFile(absolute, 'impact_map');
    bytes = readFileSync(absolute);
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    return {
      path: relativePath,
      sha256: null,
      coverage: [],
      tests: [],
      requiredScenarioIds: [],
      blockers: [`impact_map_missing_or_invalid:${relativePath}:${error instanceof Error ? error.message : String(error)}`],
    };
  }
  if (value.schema !== 'neo.code-integrity.impact-map.v1' || !Array.isArray(value.entries)) {
    blockers.push(`impact_map_schema_invalid:${relativePath}`);
  }
  const entries = Array.isArray(value.entries) ? value.entries : [];
  const sourceSet = new Set();
  const invariantIds = new Set();
  /** @type {Map<string, { source: string, tests: string[], successInvariantIds: string[], failureInvariantIds: string[], requiredScenarioIds: string[] }>} */
  const bySource = new Map();
  for (const raw of entries) {
    let source = '';
    try { source = assertSafeRelativePath(String(raw.source || '')); }
    catch { blockers.push(`impact_map_source_invalid:${String(raw.source || '')}`); continue; }
    if (sourceSet.has(source)) blockers.push(`impact_map_source_duplicate:${source}`);
    sourceSet.add(source);
    try {
      const sourceAbsolute = resolve(repoRoot, source);
      assertNoSymlinkSegments(repoRoot, sourceAbsolute, 'impact source');
      requireRegularFile(sourceAbsolute, 'impact_source');
    } catch (error) {
      blockers.push(`impact_map_source_missing:${source}:${error instanceof Error ? error.message : String(error)}`);
    }
    const invariants = Array.isArray(raw.invariants) ? raw.invariants : [];
    const tests = new Set();
    const success = [];
    const failure = [];
    const scenarios = new Set();
    for (const invariant of invariants) {
      const id = String(invariant.id || '');
      if (!/^[a-z0-9][a-z0-9._-]{2,100}$/i.test(id) || invariantIds.has(id)) {
        blockers.push(`impact_map_invariant_id_invalid_or_duplicate:${source}:${id}`);
        continue;
      }
      invariantIds.add(id);
      const polarity = invariant.polarity;
      if (!['success', 'failure'].includes(polarity)) {
        blockers.push(`impact_map_polarity_invalid:${source}:${id}`);
        continue;
      }
      let testPath = '';
      try { testPath = assertSafeRelativePath(String(invariant.test || '')); }
      catch { blockers.push(`impact_map_test_invalid:${source}:${id}`); continue; }
      if (!isTestPath(testPath)) {
        blockers.push(`impact_map_test_not_test_path:${source}:${id}:${testPath}`);
        continue;
      }
      try {
        const testAbsolute = resolve(repoRoot, testPath);
        assertNoSymlinkSegments(repoRoot, testAbsolute, 'impact test');
        requireRegularFile(testAbsolute, 'impact_test');
      } catch (error) {
        blockers.push(`impact_map_test_missing:${source}:${id}:${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      tests.add(testPath);
      if (polarity === 'success') success.push(id);
      else failure.push(id);
      if (invariant.scenarioId !== undefined) {
        const scenarioId = String(invariant.scenarioId);
        if (!/^[a-z0-9][a-z0-9:._-]{2,160}$/i.test(scenarioId)) blockers.push(`impact_map_scenario_invalid:${source}:${id}`);
        else scenarios.add(scenarioId);
      }
    }
    if (success.length === 0 || failure.length === 0) blockers.push(`impact_map_polarities_incomplete:${source}`);
    bySource.set(source, {
      source,
      tests: [...tests].sort(),
      successInvariantIds: success.sort(),
      failureInvariantIds: failure.sort(),
      requiredScenarioIds: [...scenarios].sort(),
    });
  }
  const coverage = [];
  for (const source of [...new Set(codePaths)].sort()) {
    const entry = bySource.get(source);
    if (!entry) blockers.push(`impact_map_source_unmapped:${source}`);
    else coverage.push(entry);
  }
  const tests = [...new Set(coverage.flatMap((item) => item.tests))].sort();
  const requiredScenarioIds = [...new Set(coverage.flatMap((item) => item.requiredScenarioIds))].sort();
  return {
    schema: value.schema,
    path: relativePath,
    sha256: hashBytes(bytes),
    coverage,
    tests,
    requiredScenarioIds,
    blockers: [...new Set(blockers)],
    digest: hashBytes(canonicalJson({ path: relativePath, sha256: hashBytes(bytes), coverage })),
  };
}
