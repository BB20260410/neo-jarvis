// @ts-check
// NoeCrossLayerSearch（P3-5）——跨层融合查询：一次 query 并行查多层（文档 KnowledgeStore + 证据
// EvidenceKnowledgeStore(FTS) + 记忆 MemoryCore + 图谱），RRF（Reciprocal Rank Fusion）融合排序，
// 解三层孤岛（原文档 KB / 证据 FTS 两条平行独立端点各查各的）。
//
// 全注入式：layers=[{ name, search: async(query,{limit})=>[{id?,text,score?,...}] }]；某层缺失/抛错 graceful
// 跳过（不阻断其他层）。RRF 标准式 score=Σ 1/(K+rank)，跨层按 id（无 id 用 text 规范化）去重并累加。

const RRF_K = 60;

/**
 * @param {any} item
 */
function idKey(item) {
  const id = item && (item.id || item.refId || item.ref_id);
  if (id) return `id:${String(id)}`;
  const text = String((item && (item.text || item.body || item.title)) || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 120);
  return `tx:${text}`;
}

/**
 * @param {{ layers?: Array<{name:string, search:Function}> }} deps
 */
export function createNoeCrossLayerSearch({ layers = [] } = {}) {
  const active = (Array.isArray(layers) ? layers : []).filter((l) => l && typeof l.search === 'function' && l.name);

  /**
   * @param {string} query
   * @param {{ limit?: number, perLayerLimit?: number }} [opts]
   */
  async function search(query, { limit = 10, perLayerLimit = 10 } = {}) {
    const q = String(query || '').trim();
    if (!q) return { ok: false, reason: 'empty_query', results: [], layersQueried: [] };
    if (active.length === 0) return { ok: false, reason: 'no_layers', results: [], layersQueried: [] };

    // 并行查各层，单层失败 graceful 跳过。
    const settled = await Promise.all(active.map(async (layer) => {
      try {
        const rows = await layer.search(q, { limit: perLayerLimit });
        return { name: layer.name, rows: Array.isArray(rows) ? rows.slice(0, perLayerLimit) : [], ok: true };
      } catch (/** @type {any} */ e) {
        return { name: layer.name, rows: [], ok: false, error: String(e?.message || e).slice(0, 120) };
      }
    }));

    // RRF 融合：每层内按返回顺序为 rank（0-based），贡献 1/(K+rank+1）。
    const fused = new Map(); // key -> { item, rrf, layers:Set, perLayer:{} }
    for (const layer of settled) {
      layer.rows.forEach((item, rank) => {
        const key = idKey(item);
        const contrib = 1 / (RRF_K + rank + 1);
        let agg = fused.get(key);
        if (!agg) { agg = { item, rrf: 0, layers: new Set(), perLayer: {} }; fused.set(key, agg); }
        agg.rrf += contrib;
        agg.layers.add(layer.name);
        agg.perLayer[layer.name] = { rank: rank + 1, score: Number(item.score) || null };
      });
    }
    const results = [...fused.values()]
      .map((a) => ({
        id: a.item.id || a.item.refId || a.item.ref_id || null,
        text: String(a.item.text || a.item.body || a.item.title || '').slice(0, 500),
        rrfScore: Number(a.rrf.toFixed(6)),
        layers: [...a.layers],
        crossLayer: a.layers.size > 1, // 多层共同命中 = 更可信
        perLayer: a.perLayer,
      }))
      .sort((x, y) => y.rrfScore - x.rrfScore || (y.crossLayer === x.crossLayer ? 0 : (y.crossLayer ? 1 : -1)))
      .slice(0, limit);

    return {
      ok: true,
      results,
      layersQueried: settled.map((s) => ({ name: s.name, ok: s.ok, count: s.rows.length, ...(s.error ? { error: s.error } : {}) })),
    };
  }

  return { search, layerCount: active.length };
}
