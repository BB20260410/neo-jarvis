import { describe, it, expect } from 'vitest';
import { createClusterMemoryTickHandler } from '../../src/loop/clusterMemoryTick.js';

function makeMemory() {
  const writes = [];
  return {
    writes,
    write(input) { writes.push(input); return { ...input }; },
  };
}

describe('clusterMemoryTick', () => {
  it('absorbs non-archived room summaries into memory with stable ids', async () => {
    const memory = makeMemory();
    const roomStore = {
      list: () => [
        { id: 'r1', name: 'CE12 验收', mode: 'cross_verify', status: 'completed', members: ['claude', 'codex'], taskList: [{}, {}], finalConsensus: { summary: '通过' } },
        { id: 'r2', name: '草稿', mode: 'debate', status: 'idle' },
        { id: 'r3', name: '归档的', mode: 'chat', status: 'done', archived: true },
      ],
    };
    const tick = createClusterMemoryTickHandler({ memory, roomStore, projectId: 'noe' });
    const result = await tick();

    expect(result.absorbed).toBe(2); // r1 + r2，r3 已归档被跳过
    expect(result.scanned).toBe(3);

    const ids = memory.writes.map((w) => w.id);
    expect(ids).toContain('cluster-room:r1');
    expect(ids).toContain('cluster-room:r2');
    expect(ids).not.toContain('cluster-room:r3');

    const r1 = memory.writes.find((w) => w.id === 'cluster-room:r1');
    expect(r1.scope).toBe('cluster');
    expect(r1.projectId).toBe('noe');
    expect(r1.confidence).toBe(0.7); // 有 finalConsensus → 更可信
    expect(r1.body).toContain('consensus: 通过');
    expect(r1.tags).toEqual(['cluster', 'cross_verify', 'completed']);

    const r2 = memory.writes.find((w) => w.id === 'cluster-room:r2');
    expect(r2.confidence).toBe(0.4); // 无 consensus
  });

  it('is safe when roomStore missing or list() throws', async () => {
    const memory = makeMemory();
    const noStore = await createClusterMemoryTickHandler({ memory })();
    expect(noStore.skipped).toBe('no_room_store');

    const badStore = { list: () => { throw new Error('boom'); } };
    const r = await createClusterMemoryTickHandler({ memory, roomStore: badStore })();
    expect(r.absorbed).toBe(0);
    expect(r.error).toBeTruthy();
  });

  it('throws if memory.write is not provided', () => {
    expect(() => createClusterMemoryTickHandler({})).toThrow(/memory\.write/);
  });
});
