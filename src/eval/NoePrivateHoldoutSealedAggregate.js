// @ts-check

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

function clean(value, max = 160) {
  return String(value ?? '').trim().slice(0, max);
}

/**
 * @param {Map<string, number>} map
 * @param {string} key
 * @param {number} [amount]
 */
function pushCount(map, key, amount = 1) {
  const resolved = clean(key) || 'unknown';
  map.set(resolved, (map.get(resolved) || 0) + amount);
}

/**
 * @param {Map<string, number>} map
 * @returns {{ category: string, count: number }[]}
 */
function sortedCategoryCounts(map) {
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, count]) => ({ category, count }));
}

/**
 * @param {string} datasetDir
 * @param {string} [dir]
 * @param {{ ext: string, size: number, mode: number, mtimeMs: number }[]} [out]
 * @returns {{ ext: string, size: number, mode: number, mtimeMs: number }[]}
 */
function walkFileStats(datasetDir, dir = datasetDir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFileStats(datasetDir, file, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = statSync(file);
    const rel = relative(datasetDir, file);
    if (!rel || rel.startsWith('..') || rel.includes('/../') || rel.includes('\\..\\')) {
      throw new Error('sealed_holdout_file_outside_dataset');
    }
    out.push({
      ext: extname(entry.name).toLowerCase(),
      size: stat.size,
      mode: stat.mode & 0o777,
      mtimeMs: Math.trunc(stat.mtimeMs),
    });
  }
  return out;
}

/**
 * @param {string} stage
 * @param {string} observedAt
 */
function missingDatasetReport(stage, observedAt) {
  return {
    schemaVersion: 1,
    stage,
    ok: false,
    redacted: true,
    observedAt,
    mode: 'sealed_private_holdout_metadata_aggregate',
    datasetRef: 'private_holdout:sealed',
    aggregateHashSha256: sha256Text('missing-dataset'),
    fileCount: 0,
    jsonFileCount: 0,
    nonJsonFileCount: 0,
    parsedJsonFileCount: 0,
    parseFailedFileCount: 0,
    artifactCount: 0,
    artifactValidCount: 0,
    artifactInvalidCount: 0,
    artifactKindCounts: [],
    failureCategories: [{ category: 'dataset_missing', count: 1 }],
    warningCategories: [],
    evaluationMode: 'sealed_metadata_hash_only',
    policy: {
      redactedAggregateOnly: true,
      filenamesStored: false,
      caseIdsStored: false,
      rawContentRead: false,
      rawContentPrinted: false,
      rawCaseContentStored: false,
      rawContentReadAllowed: false,
      rawSecretReadAllowed: false,
      live51835Touched: false,
      memoryV2Writes: false,
    },
    hashPolicy: 'sha256(sorted file metadata size/mode/mtimeMs; filenames and file content excluded)',
  };
}

/**
 * @param {{
 *   datasetDir?: string,
 *   observedAt?: string,
 *   stage?: string,
 *   minFiles?: number,
 * }} [options]
 */
export function createNoePrivateHoldoutSealedAggregate({
  datasetDir,
  observedAt = new Date().toISOString(),
  stage = 'C',
  minFiles = 1,
} = {}) {
  const root = resolve(datasetDir || '');
  if (!datasetDir || !existsSync(root) || !statSync(root).isDirectory()) {
    return missingDatasetReport(stage, observedAt);
  }

  const failureCategories = new Map();
  const warningCategories = new Map();
  const stats = walkFileStats(root).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const jsonFileCount = stats.filter((item) => item.ext === '.json').length;
  const nonJsonFileCount = stats.length - jsonFileCount;

  if (stats.length < minFiles) pushCount(failureCategories, 'sealed_holdout_file_count_below_min');
  if (jsonFileCount === 0) pushCount(warningCategories, 'sealed_holdout_no_json_artifacts');
  if (jsonFileCount > 0) pushCount(warningCategories, 'sealed_holdout_json_artifacts_not_parsed_by_policy');
  if (nonJsonFileCount > 0) pushCount(warningCategories, 'non_json_file', nonJsonFileCount);

  const aggregateHashSha256 = sha256Text(stats.map((item) => `${item.size}:${item.mode}:${item.mtimeMs}`).join('\n'));
  const failures = sortedCategoryCounts(failureCategories);

  return {
    schemaVersion: 1,
    stage,
    ok: failures.length === 0,
    redacted: true,
    observedAt,
    mode: 'sealed_private_holdout_metadata_aggregate',
    datasetRef: 'private_holdout:sealed',
    aggregateHashSha256,
    fileCount: stats.length,
    jsonFileCount,
    nonJsonFileCount,
    parsedJsonFileCount: 0,
    parseFailedFileCount: 0,
    artifactCount: 0,
    artifactValidCount: 0,
    artifactInvalidCount: 0,
    artifactKindCounts: [],
    failureCategories: failures,
    warningCategories: sortedCategoryCounts(warningCategories),
    evaluationMode: 'sealed_metadata_hash_only',
    policy: {
      redactedAggregateOnly: true,
      filenamesStored: false,
      caseIdsStored: false,
      rawContentRead: false,
      rawContentPrinted: false,
      rawCaseContentStored: false,
      rawContentReadAllowed: false,
      rawSecretReadAllowed: false,
      live51835Touched: false,
      memoryV2Writes: false,
    },
    hashPolicy: 'sha256(sorted file metadata size/mode/mtimeMs; filenames and file content excluded)',
  };
}
