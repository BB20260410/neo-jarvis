import { describe, expect, it, vi } from 'vitest';
import {
  buildNoeExternalMemoryProviders,
  createNoeExternalMemoryProviderManager,
  createNoeLanceDbMemoryProvider,
  createNoeWikiMemoryProvider,
  hashTextToVector,
} from '../../src/memory/NoeExternalMemoryProviders.js';

function fakeLanceDb() {
  const rows = [];
  const table = {
    add: vi.fn(async (items) => rows.push(...items)),
    vectorSearch: vi.fn(() => ({
      limit: (n) => ({
        toArray: async () => rows.slice(0, n).map((row, index) => ({ ...row, _distance: index })),
      }),
    })),
    close: vi.fn(),
  };
  const db = {
    created: false,
    async openTable() {
      if (!this.created) throw new Error('table_missing');
      return table;
    },
    async createTable(_name, items) {
      this.created = true;
      rows.push(...items);
      return table;
    },
  };
  return { lancedb: { connect: vi.fn(async () => db) }, rows, table };
}

describe('Noe external memory providers', () => {
  it('keeps external providers disabled by default', () => {
    const built = buildNoeExternalMemoryProviders({ env: {} });
    const localWrites = [];
    const out = createNoeExternalMemoryProviderManager({
      env: {},
      localMemory: { write: (input) => { localWrites.push(input); return { id: 'local-1', ...input }; } },
    });

    expect(built).toMatchObject({
      externalEnabled: false,
      providers: [],
      reason: 'external_memory_feature_flag_disabled',
    });
    const write = out.manager.writeLocal({ body: 'local only' });
    expect(write.externalEnabled).toBe(false);
    expect(write.syncQueued).toBe(0);
    expect(localWrites).toHaveLength(1);
  });

  it('creates exactly one LanceDB provider when NOE_LANCEDB_MEMORY=1', () => {
    const fake = fakeLanceDb();
    const out = createNoeExternalMemoryProviderManager({
      env: { NOE_LANCEDB_MEMORY: '1' },
      lancedb: fake.lancedb,
    });

    expect(out.externalEnabled).toBe(true);
    expect(out.activeFeature).toBe('NOE_LANCEDB_MEMORY');
    expect(out.manager.status().providers).toEqual([
      expect.objectContaining({ id: 'lancedb_memory', external: true, hasRecall: true, hasUpsert: true }),
    ]);
  });

  it('rejects enabling LanceDB and wiki providers at the same time', () => {
    expect(() => buildNoeExternalMemoryProviders({
      env: { NOE_LANCEDB_MEMORY: '1', NOE_WIKI_MEMORY_PROVIDER: '1' },
      lancedb: fakeLanceDb().lancedb,
    })).toThrow(/external_memory_single_provider_feature_flag/);
  });

  it('upserts and recalls through a LanceDB-compatible provider adapter', async () => {
    const fake = fakeLanceDb();
    const provider = createNoeLanceDbMemoryProvider({
      lancedb: fake.lancedb,
      dbDir: '/tmp/noe-lancedb-test',
      dimension: 8,
    });

    const first = await provider.upsert({ id: 'sync-1', input: { id: 'm1', body: 'Qwen main brain route memory', scope: 'project' } });
    const second = await provider.upsert({ id: 'sync-2', input: { id: 'm2', body: 'wiki provider memory', scope: 'wiki' } });
    const recalled = await provider.recall({ q: 'Qwen main brain route memory', topK: 1 });

    expect(first).toMatchObject({ ok: true, id: 'm1', providerId: 'lancedb_memory' });
    expect(second).toMatchObject({ ok: true, id: 'm2' });
    expect(fake.rows).toHaveLength(2);
    expect(fake.table.add).toHaveBeenCalledTimes(1);
    expect(recalled[0]).toMatchObject({ id: 'm1', scope: 'project', text: 'Qwen main brain route memory' });
  });

  it('wraps local wiki search as a read-only memory provider', async () => {
    const wikiSearch = vi.fn(async () => ({
      ok: true,
      hits: [
        { title: 'Karpathy LLM Wiki Pattern', file: 'wiki/karpathy.md', score: 3, snippet: 'Reduces repeated research.' },
      ],
    }));
    const provider = createNoeWikiMemoryProvider({ wikiSearch, root: '/tmp/wiki-root' });

    const out = await provider.recall({ q: 'repeated research', topK: 2 });

    expect(wikiSearch).toHaveBeenCalledWith({ root: '/tmp/wiki-root', query: 'repeated research', topK: 2 });
    expect(out[0]).toMatchObject({
      id: 'wiki:wiki/karpathy.md',
      scope: 'wiki',
      text: expect.stringContaining('Karpathy LLM Wiki Pattern'),
      score: 3,
    });
    expect(provider.upsert).toBeUndefined();
  });

  it('builds stable normalized vectors without external embeddings', () => {
    const a = hashTextToVector('same text', 8);
    const b = hashTextToVector('same text', 8);

    expect(a).toEqual(b);
    expect(a).toHaveLength(8);
    expect(Math.sqrt(a.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1, 4);
  });
});
