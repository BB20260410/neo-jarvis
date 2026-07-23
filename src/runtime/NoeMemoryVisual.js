// @ts-check
/**
 * Visual memory view-model on Neo memory SSOT (compact memory records).
 * BaiLongma-inspired: timeline + soft concept clusters — no parallel store.
 */

export const MEMORY_VISUAL_SCHEMA = 'neo.memory.visual.v1';

/**
 * @typedef {object} CompactMemory
 * @property {string} [id]
 * @property {string} [title]
 * @property {string} [body]
 * @property {string} [scope]
 * @property {string} [sourceType]
 * @property {string[]|string} [tags]
 * @property {number|string} [updatedAt]
 * @property {number} [salience]
 * @property {number} [confidence]
 * @property {boolean} [hidden]
 */

/**
 * @param {CompactMemory[]} items
 * @param {{ limit?: number, now?: number }} [opts]
 */
export function buildMemoryVisualModel(items, opts = {}) {
  const limit = Math.max(1, Math.min(Number(opts.limit) || 80, 200));
  const now = Number(opts.now) || Date.now();
  const list = Array.isArray(items) ? items : [];

  /** @type {Array<object>} */
  const nodes = [];
  /** @type {Map<string, number>} */
  const tagCounts = new Map();

  for (const raw of list.slice(0, limit)) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.hidden === true) continue;
    const id = String(raw.id || '').trim() || `anon_${nodes.length}`;
    const title = String(raw.title || '').trim() || String(raw.body || '').slice(0, 48) || id;
    const body = String(raw.body || '').slice(0, 280);
    const tags = Array.isArray(raw.tags)
      ? raw.tags.map((t) => String(t).slice(0, 40)).filter(Boolean)
      : typeof raw.tags === 'string' && raw.tags
        ? [raw.tags.slice(0, 40)]
        : [];
    for (const t of tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    const updatedAt = raw.updatedAt != null ? Number(raw.updatedAt) || raw.updatedAt : null;
    nodes.push({
      id,
      title,
      bodyPreview: body,
      scope: raw.scope || 'unknown',
      sourceType: raw.sourceType || '',
      tags,
      updatedAt,
      salience: Number.isFinite(Number(raw.salience)) ? Number(raw.salience) : null,
      confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : null,
    });
  }

  // Timeline: newest first when timestamps exist
  const timeline = [...nodes].sort((a, b) => {
    const ta = Number(a.updatedAt) || 0;
    const tb = Number(b.updatedAt) || 0;
    return tb - ta;
  });

  // Soft clusters by primary tag (or scope)
  /** @type {Map<string, string[]>} */
  const clusterMap = new Map();
  for (const n of nodes) {
    const key = (n.tags && n.tags[0]) || n.scope || 'general';
    if (!clusterMap.has(key)) clusterMap.set(key, []);
    clusterMap.get(key).push(n.id);
  }
  const clusters = [...clusterMap.entries()]
    .map(([label, memberIds]) => ({ label, memberIds, size: memberIds.length }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 24);

  // Edges: shared tag (capped)
  /** @type {Array<{from:string,to:string,reason:string}>} */
  const edges = [];
  const byTag = new Map();
  for (const n of nodes) {
    for (const t of n.tags.slice(0, 3)) {
      if (!byTag.has(t)) byTag.set(t, []);
      byTag.get(t).push(n.id);
    }
  }
  for (const [tag, ids] of byTag) {
    for (let i = 0; i < ids.length && i < 6; i += 1) {
      for (let j = i + 1; j < ids.length && j < 6; j += 1) {
        edges.push({ from: ids[i], to: ids[j], reason: `tag:${tag}` });
        if (edges.length >= 80) break;
      }
      if (edges.length >= 80) break;
    }
    if (edges.length >= 80) break;
  }

  return {
    schemaVersion: 1,
    kind: MEMORY_VISUAL_SCHEMA,
    generatedAt: now,
    empty: nodes.length === 0,
    emptyHint: nodes.length === 0 ? '还没有可展示的记忆。先对话或让 Neo 记住一件事。' : null,
    nodeCount: nodes.length,
    nodes,
    timeline,
    clusters,
    edges,
    topTags: [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([tag, count]) => ({ tag, count })),
  };
}
