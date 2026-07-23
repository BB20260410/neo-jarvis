import { describe, it, expect } from 'vitest';
import { createNoeCrossLayerSearch } from '../../src/knowledge/NoeCrossLayerSearch.js';

describe('createNoeCrossLayerSearch（P3-5 跨层融合）', () => {
  it('并行查多层 + RRF 融合 + 跨层命中更靠前', async () => {
    const docs = { name: 'docs', search: async () => [{ id: 'A', text: 'doc A' }, { id: 'B', text: 'doc B' }] };
    const evidence = { name: 'evidence', search: async () => [{ id: 'B', text: 'ev B' }, { id: 'C', text: 'ev C' }] };
    const memory = { name: 'memory', search: async () => [{ id: 'B', text: 'mem B' }] };
    const x = createNoeCrossLayerSearch({ layers: [docs, evidence, memory] });
    const r = await x.search('q', { limit: 10 });
    expect(r.ok).toBe(true);
    expect(r.layersQueried.map((l) => l.name)).toEqual(['docs', 'evidence', 'memory']);
    // B 三层都命中 → RRF 累加最高 → 排第一 + crossLayer
    expect(r.results[0].id).toBe('B');
    expect(r.results[0].crossLayer).toBe(true);
    expect(r.results[0].layers.sort()).toEqual(['docs', 'evidence', 'memory']);
  });

  it('单层抛错 graceful 跳过，不阻断其他层', async () => {
    const ok = { name: 'ok', search: async () => [{ id: 'X', text: 'x' }] };
    const bad = { name: 'bad', search: async () => { throw new Error('layer down'); } };
    const x = createNoeCrossLayerSearch({ layers: [ok, bad] });
    const r = await x.search('q');
    expect(r.ok).toBe(true);
    expect(r.results.map((i) => i.id)).toContain('X');
    expect(r.layersQueried.find((l) => l.name === 'bad').ok).toBe(false);
  });

  it('空 query → empty_query；无层 → no_layers', async () => {
    expect((await createNoeCrossLayerSearch({ layers: [{ name: 'a', search: async () => [] }] }).search('')).reason).toBe('empty_query');
    expect((await createNoeCrossLayerSearch({ layers: [] }).search('q')).reason).toBe('no_layers');
  });

  it('无 id 的结果按文本去重融合', async () => {
    const l1 = { name: 'l1', search: async () => [{ text: '同一段内容' }] };
    const l2 = { name: 'l2', search: async () => [{ text: '同一段内容' }] };
    const x = createNoeCrossLayerSearch({ layers: [l1, l2] });
    const r = await x.search('q');
    expect(r.results.length).toBe(1); // 文本相同 → 融合为一条
    expect(r.results[0].crossLayer).toBe(true);
  });
});
