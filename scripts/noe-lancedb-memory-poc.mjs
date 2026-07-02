#!/usr/bin/env node
import * as lancedb from '@lancedb/lancedb';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNoeExternalMemoryProviderManager } from '../src/memory/NoeExternalMemoryProviders.js';
import { searchWiki } from '../src/knowledge/LLMWiki.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'output/noe-ecosystem-install-2026-06-12');
const DB_DIR = resolve(OUT_DIR, 'lancedb-memory-poc');
const WIKI_ROOT = resolve(OUT_DIR, 'wiki-memory-provider-poc');
const OUT_JSON = resolve(OUT_DIR, 'lancedb-memory-poc.json');

mkdirSync(OUT_DIR, { recursive: true });
rmSync(DB_DIR, { recursive: true, force: true });
rmSync(WIKI_ROOT, { recursive: true, force: true });
mkdirSync(resolve(WIKI_ROOT, 'wiki'), { recursive: true });
writeFileSync(resolve(WIKI_ROOT, 'wiki', 'index.md'), '# Index\n- [Provider Memory](./provider-memory.md)\n');
writeFileSync(resolve(WIKI_ROOT, 'wiki', 'log.md'), '# Log\n');
writeFileSync(resolve(WIKI_ROOT, 'wiki', 'provider-memory.md'), [
  '# Provider Memory',
  '',
  'The wiki memory provider reduces repeated research by exposing local LLM Wiki hits as external memory recall.',
].join('\n'));

const localWrites = [];
const localMemory = {
  write(input = {}) {
    const memory = { id: `local-${localWrites.length + 1}`, ...input };
    localWrites.push(memory);
    return memory;
  },
  recall() {
    return localWrites;
  },
};

const defaultOff = createNoeExternalMemoryProviderManager({ env: {}, localMemory });
const defaultWrite = defaultOff.manager.writeLocal({ body: 'default local memory only', scope: 'project' });

const lance = createNoeExternalMemoryProviderManager({
  env: { NOE_LANCEDB_MEMORY: '1' },
  lancedb,
  lancedbDir: DB_DIR,
  localMemory,
});
lance.manager.writeLocal({ id: 'm1', scope: 'project', body: 'Qwen main brain route memory uses local execution evidence.' });
lance.manager.writeLocal({ id: 'm2', scope: 'voice', body: 'CosyVoice local speech stays offline first.' });
const lanceDrain = await lance.manager.drainSync({ maxItems: 8 });
const lanceRecall = await lance.manager.recallExternal({ q: 'Qwen main brain route memory', topK: 2 });

const wiki = createNoeExternalMemoryProviderManager({
  env: { NOE_WIKI_MEMORY_PROVIDER: '1' },
  wikiRoot: WIKI_ROOT,
  wikiSearch: searchWiki,
  localMemory,
});
const wikiRecall = await wiki.manager.recallExternal({ q: 'repeated research provider', topK: 2 });

const report = {
  ok: defaultWrite.syncQueued === 0
    && defaultOff.manager.status().externalEnabled === false
    && lanceDrain.ok === true
    && lanceDrain.processed === 2
    && lanceRecall.memories.some((item) => item.id === 'm1')
    && wikiRecall.memories.some((item) => item.id.includes('provider-memory.md')),
  generatedAt: new Date().toISOString(),
  featureFlags: {
    NOE_LANCEDB_MEMORY: process.env.NOE_LANCEDB_MEMORY ? 'set' : 'unset',
    NOE_WIKI_MEMORY_PROVIDER: process.env.NOE_WIKI_MEMORY_PROVIDER ? 'set' : 'unset',
    defaultChangesNoeBehavior: false,
    note: 'Providers are created only by explicit feature flag; this PoC does not replace MemoryCore.',
  },
  defaultOff: {
    status: defaultOff.manager.status(),
    write: { ok: defaultWrite.ok, syncQueued: defaultWrite.syncQueued },
  },
  lancedb: {
    activeFeature: lance.activeFeature,
    dbDir: DB_DIR,
    dbDirExistsAfterRun: existsSync(DB_DIR),
    status: lance.manager.status(),
    drain: lanceDrain,
    recall: lanceRecall.memories.map((item) => ({ id: item.id, scope: item.scope, score: item.score })),
  },
  wiki: {
    activeFeature: wiki.activeFeature,
    wikiRoot: WIKI_ROOT,
    status: wiki.manager.status(),
    recall: wikiRecall.memories.map((item) => ({ id: item.id, scope: item.scope, score: item.score })),
  },
};

writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
