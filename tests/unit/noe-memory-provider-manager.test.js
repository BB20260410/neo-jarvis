import { describe, expect, it } from 'vitest';
import {
  NoeMemoryProviderManager,
  scrubExternalMemoryText,
} from '../../src/memory/NoeMemoryProviderManager.js';

describe('NoeMemoryProviderManager', () => {
  it('keeps local memory as the foreground authority by default', () => {
    const localMemory = {
      recall: () => [{ id: 'local-1', body: 'local memory' }],
    };
    const manager = new NoeMemoryProviderManager({
      localMemory,
      providers: [{ id: 'external-fixture', recall: () => [{ id: 'external-1', body: 'external memory' }] }],
    });

    const out = manager.recallLocal({ q: 'memory' });

    expect(out.source).toBe('local');
    expect(out.memories).toEqual([{ id: 'local-1', body: 'local memory' }]);
    expect(out.externalEnabled).toBe(false);
  });

  it('rejects provider tools that shadow local memory tools', () => {
    expect(() => new NoeMemoryProviderManager({
      externalEnabled: true,
      providers: [{ id: 'bad-provider', tools: ['noe.memory.write'] }],
    })).toThrow(/memory_provider_tool_shadow_rejected:noe\.memory\.write/);
  });

  it('allows only one external provider', () => {
    expect(() => new NoeMemoryProviderManager({
      externalEnabled: true,
      providers: [
        { id: 'provider-a', tools: ['providerA.memory.upsert'] },
        { id: 'provider-b', tools: ['providerB.memory.upsert'] },
      ],
    })).toThrow(/memory_provider_single_external_limit/);
  });

  it('queues external sync without blocking foreground local writes', async () => {
    const localWrites = [];
    const externalWrites = [];
    const manager = new NoeMemoryProviderManager({
      externalEnabled: true,
      localMemory: {
        write: (input) => {
          localWrites.push(input);
          return { id: 'local-written', ...input };
        },
      },
      providers: [{
        id: 'provider-a',
        tools: ['providerA.memory.upsert'],
        upsert: async (item) => {
          externalWrites.push(item);
          return { ok: true };
        },
      }],
    });

    const write = manager.writeLocal({ body: 'foreground memory' });

    expect(write.memory.id).toBe('local-written');
    expect(write.syncQueued).toBe(1);
    expect(localWrites).toHaveLength(1);
    expect(externalWrites).toHaveLength(0);

    const drained = await manager.drainSync();

    expect(drained.processed).toBe(1);
    expect(drained.remaining).toBe(0);
    expect(externalWrites).toHaveLength(1);
  });

  it('drains external sync in bounded batches', async () => {
    const synced = [];
    const manager = new NoeMemoryProviderManager({
      externalEnabled: true,
      maxSyncBatch: 2,
      providers: [{
        id: 'provider-a',
        tools: ['providerA.memory.upsert'],
        upsert: async (item) => {
          synced.push(item.id);
          return { ok: true };
        },
      }],
    });
    manager.enqueueSync({ id: 'a', body: 'A' });
    manager.enqueueSync({ id: 'b', body: 'B' });
    manager.enqueueSync({ id: 'c', body: 'C' });

    const drained = await manager.drainSync({ maxItems: 99 });

    expect(drained.processed).toBe(2);
    expect(drained.remaining).toBe(1);
    expect(synced).toEqual(['a', 'b']);
    expect(manager.status().syncQueued).toBe(1);
  });

  it('scrubs external memory text and hidden memory-context blocks', async () => {
    const scrubbed = scrubExternalMemoryText('visible <memory-context>private MINIMAX_API_KEY=example-placeholder</memory-context> after');

    expect(scrubbed.text).toContain('visible');
    expect(scrubbed.text).toContain('after');
    expect(scrubbed.text).not.toContain('private');
    expect(scrubbed.text).not.toContain('example-placeholder');
    expect(scrubbed.stripped[0]).toMatchObject({ kind: 'memory-context' });

    const manager = new NoeMemoryProviderManager({
      externalEnabled: true,
      providers: [{
        id: 'provider-a',
        tools: ['providerA.memory.recall'],
        recall: async () => [{ id: 'external-1', body: 'safe <memory-context>hidden</memory-context> text' }],
      }],
    });

    const out = await manager.recallExternal({ q: 'safe' });

    expect(out.memories[0].text).toBe('safe  text');
    expect(out.memories[0].stripped[0].kind).toBe('memory-context');
  });
});
