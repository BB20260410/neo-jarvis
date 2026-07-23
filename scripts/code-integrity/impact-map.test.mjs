#!/usr/bin/env node
// @ts-check

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTERNAL_IMPACT_MAP, loadImpactMap } from './lib/impact-map.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TASK_ROOT = resolve(SCRIPT_DIR, '../..');
const runtimeInput = process.argv[2] || process.env.NOE_CODE_INTEGRITY_RUNTIME_ROOT;
if (!runtimeInput) throw new Error('runtime root argument is required');

/** @type {string[]} */
const sources = [INTERNAL_IMPACT_MAP];
/** @param {string} directory */
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else if (entry.isFile() && entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')) {
      sources.push(relative(TASK_ROOT, absolute).split(sep).join('/'));
    }
  }
}
walk(SCRIPT_DIR);
const current = loadImpactMap(TASK_ROOT, sources);
assert.deepEqual(current.blockers, []);
assert.equal(current.coverage.length, new Set(sources).size);
assert.ok(current.tests.includes('scripts/code-integrity/gate.integration.test.mjs'));
assert.ok(current.requiredScenarioIds.includes('gate:worktree-current:0'));

const fixtureRoot = join(resolve(runtimeInput), 'impact-map-tests', randomUUID());
mkdirSync(join(fixtureRoot, 'src'), { recursive: true, mode: 0o700 });
mkdirSync(join(fixtureRoot, 'test'), { recursive: true, mode: 0o700 });
writeFileSync(join(fixtureRoot, 'src', 'value.mjs'), '// @ts-check\nexport const value = 1;\n');
writeFileSync(join(fixtureRoot, 'test', 'value.test.mjs'), '// @ts-check\n');
const mapPath = join(fixtureRoot, '.neo-code-integrity-impact.json');
writeFileSync(mapPath, `${JSON.stringify({
  schema: 'neo.code-integrity.impact-map.v1',
  entries: [{
    source: 'src/value.mjs',
    invariants: [
      { id: 'value-success', polarity: 'success', test: 'test/value.test.mjs' },
      { id: 'value-failure', polarity: 'failure', test: 'test/value.test.mjs' },
    ],
  }],
}, null, 2)}\n`);
assert.deepEqual(loadImpactMap(fixtureRoot, ['src/value.mjs']).blockers, []);
writeFileSync(mapPath, `${JSON.stringify({
  schema: 'neo.code-integrity.impact-map.v1',
  entries: [{
    source: 'src/value.mjs',
    invariants: [{ id: 'only-success', polarity: 'success', test: 'test/value.test.mjs' }],
  }],
}, null, 2)}\n`);
assert.ok(loadImpactMap(fixtureRoot, ['src/value.mjs']).blockers.some((item) => item.startsWith('impact_map_polarities_incomplete:')));
assert.ok(loadImpactMap(fixtureRoot, ['src/unmapped.mjs']).blockers.some((item) => item.startsWith('impact_map_source_unmapped:')));

process.stdout.write('impact map tests: PASS (exact source/test/invariant coverage)\n');
