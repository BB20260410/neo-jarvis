// @ts-check

export const DEFAULT_MEMORY_RETRIEVAL_SAMPLE_QUERIES = Object.freeze([
  { id: 'memory_status', q: '长期记忆', routeType: 'chat' },
  { id: 'source_linkage', q: 'source_episode', routeType: 'mission' },
  { id: 'voice_archive', q: 'voice', routeType: 'chat' },
  { id: 'fact_extract', q: 'fact_extract', routeType: 'reflection' },
  { id: 'skill_distill', q: 'skill_distill', routeType: 'mission' },
  { id: 'nightly_reflection', q: 'nightly_reflection', routeType: 'reflection' },
  { id: 'project_memory', q: 'project', routeType: 'mission' },
  { id: 'preference', q: '偏好', routeType: 'chat' },
  { id: 'provenance', q: 'provenance', routeType: 'mission' },
  { id: 'canary', q: 'canary', routeType: 'chat' },
  { id: 'roadmap', q: '路线图', routeType: 'mission' },
  { id: 'memory_gate', q: 'gate', routeType: 'mission' },
  { id: 'retrieval', q: 'retrieval', routeType: 'chat' },
  { id: 'semantic', q: 'semantic', routeType: 'reflection' },
  { id: 'maintenance', q: 'maintenance', routeType: 'reflection' },
  { id: 'quarantine', q: 'quarantine', routeType: 'mission' },
  { id: 'owner', q: 'owner', routeType: 'chat' },
  { id: '任务', q: '任务', routeType: 'mission' },
  { id: '证据', q: '证据', routeType: 'mission' },
  { id: '回滚', q: '回滚', routeType: 'mission' },
]);

function clean(value, max = 120) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export async function runNoeMemoryRetrievalSample({
  retriever,
  projectId = 'noe',
  queries = DEFAULT_MEMORY_RETRIEVAL_SAMPLE_QUERIES,
  limit = 6,
  turnPrefix = `memory-retrieval-sample-${Date.now()}`,
} = {}) {
  if (!retriever?.retrieve) throw new Error('retriever required');
  const rows = [];
  for (const query of Array.isArray(queries) ? queries : []) {
    const id = clean(query.id || query.q || `q-${rows.length}`, 80);
    const q = clean(query.q || query.query || '', 240);
    if (!q) continue;
    const routeType = clean(query.routeType || 'chat', 40) || 'chat';
    const result = await retriever.retrieve({
      transcript: q,
      projectId,
      routeType,
      limit,
      memoryPolicy: { recallLimit: limit, injectLimit: limit },
      turnId: `${turnPrefix}:${id}`,
    });
    const selectedIds = Array.isArray(result.selectedIds)
      ? result.selectedIds
      : (Array.isArray(result.selected) ? result.selected.map((item) => item.id).filter(Boolean) : []);
    rows.push({
      id,
      ok: result.ok === true,
      routeType,
      selectedCount: selectedIds.length,
      selectedIds: selectedIds.slice(0, limit),
      droppedReasons: result.droppedReasons || [],
    });
  }
  const okRows = rows.filter((row) => row.ok).length;
  const selectedRows = rows.filter((row) => row.selectedCount > 0).length;
  return {
    ok: rows.length > 0 && okRows === rows.length,
    sampled: rows.length,
    okRows,
    selectedRows,
    rows,
    policy: {
      noMemoryBodyOutput: true,
      noSecretOutput: true,
      writesRetrievalLogOnly: true,
    },
  };
}
