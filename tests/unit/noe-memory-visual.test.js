import { describe, it, expect } from 'vitest';
import { buildMemoryVisualModel, MEMORY_VISUAL_SCHEMA } from '../../src/runtime/NoeMemoryVisual.js';

describe('buildMemoryVisualModel', () => {
  it('returns empty model for empty input', () => {
    const result = buildMemoryVisualModel([]);
    expect(result.empty).toBe(true);
    expect(result.nodeCount).toBe(0);
    expect(result.nodes).toEqual([]);
    expect(result.timeline).toEqual([]);
    expect(result.clusters).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.topTags).toEqual([]);
    expect(result.kind).toBe(MEMORY_VISUAL_SCHEMA);
    expect(result.schemaVersion).toBe(1);
    expect(result.emptyHint).toContain('还没有可展示的记忆');
  });

  it('filters out hidden items', () => {
    const items = [
      { id: '1', title: 'Visible', hidden: false },
      { id: '2', title: 'Hidden', hidden: true },
    ];
    const result = buildMemoryVisualModel(items);
    expect(result.nodeCount).toBe(1);
    expect(result.nodes[0].id).toBe('1');
  });

  it('generates anonymous IDs for items without id', () => {
    const items = [{ title: 'No ID' }];
    const result = buildMemoryVisualModel(items);
    expect(result.nodeCount).toBe(1);
    expect(result.nodes[0].id).toMatch(/^anon_/);
  });

  it('sorts timeline by updatedAt descending', () => {
    const now = Date.now();
    const items = [
      { id: 'old', updatedAt: now - 1000 },
      { id: 'new', updatedAt: now },
    ];
    const result = buildMemoryVisualModel(items, { now });
    expect(result.timeline[0].id).toBe('new');
    expect(result.timeline[1].id).toBe('old');
  });

  it('creates clusters based on primary tag', () => {
    const items = [
      { id: '1', tags: ['js', 'code'] },
      { id: '2', tags: ['js', 'web'] },
      { id: '3', tags: ['python'] },
    ];
    const result = buildMemoryVisualModel(items);
    const jsCluster = result.clusters.find((c) => c.label === 'js');
    expect(jsCluster).toBeDefined();
    expect(jsCluster.memberIds).toContain('1');
    expect(jsCluster.memberIds).toContain('2');
    expect(jsCluster.size).toBe(2);
  });

  it('creates edges for shared tags', () => {
    const items = [
      { id: '1', tags: ['shared'] },
      { id: '2', tags: ['shared'] },
    ];
    const result = buildMemoryVisualModel(items);
    const edge = result.edges.find((e) => e.from === '1' && e.to === '2');
    expect(edge).toBeDefined();
    expect(edge.reason).toBe('tag:shared');
  });

  it('respects limit option', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: String(i) }));
    const result = buildMemoryVisualModel(items, { limit: 10 });
    expect(result.nodeCount).toBe(10);
  });

  it('computes topTags correctly', () => {
    const items = [
      { id: '1', tags: ['a', 'b'] },
      { id: '2', tags: ['a', 'c'] },
      { id: '3', tags: ['a'] },
    ];
    const result = buildMemoryVisualModel(items);
    const topTag = result.topTags[0];
    expect(topTag.tag).toBe('a');
    expect(topTag.count).toBe(3);
  });

  it('handles non-array input gracefully', () => {
    const result = buildMemoryVisualModel(null);
    expect(result.empty).toBe(true);
    expect(result.nodeCount).toBe(0);
  });

  it('truncates body preview', () => {
    const longBody = 'a'.repeat(500);
    const items = [{ id: '1', body: longBody }];
    const result = buildMemoryVisualModel(items);
    expect(result.nodes[0].bodyPreview.length).toBeLessThanOrEqual(280);
  });
});
