import { resolve } from 'node:path';
import { createNoeMemoryProviderManager } from './NoeMemoryProviderManager.js';
import { searchWiki } from '../knowledge/LLMWiki.js';

export const NOE_EXTERNAL_MEMORY_PROVIDER_SCHEMA_VERSION = 1;

function clean(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function flagOn(env = {}, name) {
  return String(env?.[name] || '').trim() === '1';
}

export function hashTextToVector(text = '', dimension = 32) {
  const size = Math.max(3, Math.min(256, Math.trunc(Number(dimension) || 32)));
  const vector = Array.from({ length: size }, () => 0);
  const input = String(text || '').toLowerCase();
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    vector[(code + i) % size] += (code % 29) + 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / norm).toFixed(6)));
}

function memoryTextFromSyncItem(item = {}) {
  const input = item.input && typeof item.input === 'object' ? item.input : item;
  return clean(input.body || input.text || input.content || input.title || '', 4000);
}

async function openOrCreateLanceTable({ lancedb, dbDir, tableName, row }) {
  const db = await lancedb.connect(dbDir);
  try {
    return { table: await db.openTable(tableName), created: false };
  } catch {
    return { table: await db.createTable(tableName, [row]), created: true };
  }
}

export function createNoeLanceDbMemoryProvider({
  lancedb,
  dbDir = 'output/noe-memory-providers/lancedb',
  tableName = 'memories',
  dimension = 32,
  vectorize = hashTextToVector,
} = {}) {
  if (!lancedb?.connect) throw new Error('lancedb_dependency_required');
  const absDir = resolve(dbDir);
  const dim = Math.max(3, Math.min(256, Math.trunc(Number(dimension) || 32)));
  return {
    id: 'lancedb_memory',
    external: true,
    kind: 'lancedb',
    tools: ['lancedb.memory.upsert', 'lancedb.memory.recall'],
    dbDir: absDir,
    async upsert(item = {}) {
      const text = memoryTextFromSyncItem(item);
      if (!text) return { ok: true, skipped: true, reason: 'empty_memory_text' };
      const input = item.input && typeof item.input === 'object' ? item.input : item;
      const row = {
        id: clean(item.localId || input.id || item.id || `memory-${Date.now()}`, 160),
        scope: clean(input.scope || input.sourceType || 'memory', 120),
        text,
        vector: vectorize(text, dim),
        updatedAt: new Date().toISOString(),
      };
      const { table, created } = await openOrCreateLanceTable({ lancedb, dbDir: absDir, tableName, row });
      if (!created && table.add) await table.add([row]);
      table.close?.();
      return { ok: true, providerId: 'lancedb_memory', id: row.id, dbDir: absDir, tableName };
    },
    async recall({ q = '', query = '', topK = 5 } = {}) {
      const text = clean(query || q, 1000);
      if (!text) return [];
      const db = await lancedb.connect(absDir);
      let table;
      try {
        table = await db.openTable(tableName);
      } catch {
        return [];
      }
      const rows = await table.vectorSearch(vectorize(text, dim)).limit(Math.max(1, Math.min(20, Number(topK) || 5))).toArray();
      table.close?.();
      return rows.map((row) => ({
        id: row.id,
        scope: row.scope,
        text: row.text,
        score: typeof row._distance === 'number' ? 1 / (1 + row._distance) : null,
      }));
    },
  };
}

export function createNoeWikiMemoryProvider({
  wikiSearch = searchWiki,
  root = 'knowledge/llm-wiki',
} = {}) {
  return {
    id: 'llm_wiki_memory',
    external: true,
    kind: 'wiki',
    tools: ['llm-wiki.memory.recall'],
    async recall({ q = '', query = '', topK = 5 } = {}) {
      const text = clean(query || q, 1000);
      if (!text) return [];
      const out = await wikiSearch({ root, query: text, topK });
      const hits = Array.isArray(out?.hits) ? out.hits : [];
      return hits.map((hit) => ({
        id: `wiki:${clean(hit.file || hit.title, 180)}`,
        scope: 'wiki',
        text: `${clean(hit.title, 220)}\n${clean(hit.snippet, 1200)}`,
        score: Number.isFinite(Number(hit.score)) ? Number(hit.score) : null,
      }));
    },
  };
}

export function buildNoeExternalMemoryProviders({
  env = process.env,
  lancedb = null,
  lancedbDir = 'output/noe-memory-providers/lancedb',
  wikiRoot = 'knowledge/llm-wiki',
  wikiSearch = searchWiki,
} = {}) {
  const lancedbEnabled = flagOn(env, 'NOE_LANCEDB_MEMORY');
  const wikiEnabled = flagOn(env, 'NOE_WIKI_MEMORY_PROVIDER');
  if (lancedbEnabled && wikiEnabled) throw new Error('external_memory_single_provider_feature_flag');
  if (lancedbEnabled) {
    return {
      schemaVersion: NOE_EXTERNAL_MEMORY_PROVIDER_SCHEMA_VERSION,
      externalEnabled: true,
      activeFeature: 'NOE_LANCEDB_MEMORY',
      providers: [createNoeLanceDbMemoryProvider({ lancedb, dbDir: lancedbDir })],
    };
  }
  if (wikiEnabled) {
    return {
      schemaVersion: NOE_EXTERNAL_MEMORY_PROVIDER_SCHEMA_VERSION,
      externalEnabled: true,
      activeFeature: 'NOE_WIKI_MEMORY_PROVIDER',
      providers: [createNoeWikiMemoryProvider({ wikiSearch, root: wikiRoot })],
    };
  }
  return {
    schemaVersion: NOE_EXTERNAL_MEMORY_PROVIDER_SCHEMA_VERSION,
    externalEnabled: false,
    activeFeature: '',
    providers: [],
    reason: 'external_memory_feature_flag_disabled',
  };
}

export function createNoeExternalMemoryProviderManager(opts = {}) {
  const built = buildNoeExternalMemoryProviders(opts);
  const manager = createNoeMemoryProviderManager({
    ...opts,
    externalEnabled: built.externalEnabled,
    providers: built.providers,
  });
  return { ok: true, ...built, manager };
}
