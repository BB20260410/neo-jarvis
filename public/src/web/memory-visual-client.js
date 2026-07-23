// @ts-check
/** Browser copy of NoeMemoryVisual.buildMemoryVisualModel (sync with src/runtime/NoeMemoryVisual.js). */
export function buildMemoryVisualModel(items, opts = {}) {
  const limit = Math.max(1, Math.min(Number(opts.limit) || 80, 200));
  const now = Number(opts.now) || Date.now();
  const list = Array.isArray(items) ? items : [];
  const nodes = [];
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
    nodes.push({
      id,
      title,
      bodyPreview: body,
      scope: raw.scope || 'unknown',
      sourceType: raw.sourceType || '',
      tags,
      updatedAt: raw.updatedAt != null ? Number(raw.updatedAt) || raw.updatedAt : null,
      salience: Number.isFinite(Number(raw.salience)) ? Number(raw.salience) : null,
      confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : null,
    });
  }
  const timeline = [...nodes].sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
  const clusterMap = new Map();
  for (const n of nodes) {
    const key = n.tags[0] || n.scope || 'general';
    if (!clusterMap.has(key)) clusterMap.set(key, []);
    clusterMap.get(key).push(n.id);
  }
  const clusters = [...clusterMap.entries()]
    .map(([label, memberIds]) => ({ label, memberIds, size: memberIds.length }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 24);
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
    kind: 'neo.memory.visual.v1',
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
