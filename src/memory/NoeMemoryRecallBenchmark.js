// @ts-check

export const DEFAULT_MEMORY_RECALL_FIXTURES = Object.freeze([
  {
    id: 'bench-pref-coffee',
    kind: 'preference',
    body: '主人长期偏好黑咖啡，不加糖。',
    tags: ['preference', 'coffee'],
    sourceEpisodeId: 'bench-episode-coffee',
    evidenceRefs: ['episode:bench-episode-coffee'],
    confidence: 0.9,
  },
  {
    id: 'bench-project-roadmap',
    kind: 'skill',
    body: 'Neo 长期记忆路线图需要 provenance、recall benchmark、semantic provider 和 canary 验收。',
    tags: ['memory', 'roadmap'],
    sourceEpisodeId: 'bench-episode-roadmap',
    evidenceRefs: ['episode:bench-episode-roadmap'],
    confidence: 0.88,
  },
  {
    id: 'bench-insight-voice',
    kind: 'insight',
    body: 'voice 原始记录需要先升华为事实摘要，再注入长期上下文。',
    tags: ['voice', 'sublimation'],
    sourceEpisodeId: 'bench-episode-voice',
    evidenceRefs: ['episode:bench-episode-voice'],
    confidence: 0.84,
  },
  {
    id: 'bench-distractor-coffee',
    kind: 'fact',
    body: '项目测试日志里出现黑咖啡这个词，不代表主人长期偏好。',
    tags: ['distractor', 'coffee'],
    sourceEpisodeId: 'bench-episode-distractor',
    evidenceRefs: ['episode:bench-episode-distractor'],
    confidence: 0.38,
    salience: 1,
  },
]);

export const DEFAULT_MEMORY_RECALL_CASES = Object.freeze([
  { id: 'coffee_preference', query: '黑咖啡', expectedIds: ['bench-pref-coffee'], disallowedIds: ['bench-distractor-coffee'], routeType: 'chat', k: 1, minPrecision: 1 },
  { id: 'roadmap_provenance', query: 'provenance', expectedIds: ['bench-project-roadmap'], routeType: 'mission', k: 5 },
  { id: 'voice_sublimation', query: '升华为事实摘要', expectedIds: ['bench-insight-voice'], routeType: 'reflection', k: 5 },
  { id: 'negative_unrelated', query: '不存在的航天偏好', expectedIds: [], routeType: 'chat', k: 3, expectEmpty: true },
]);

function precisionAt(selectedIds, expectedIds) {
  if (!selectedIds.length) return expectedIds.length ? 0 : 1;
  const expected = new Set(expectedIds);
  return selectedIds.filter((id) => expected.has(id)).length / selectedIds.length;
}

function recallAt(selectedIds, expectedIds) {
  if (!expectedIds.length) return 1;
  const selected = new Set(selectedIds);
  return expectedIds.filter((id) => selected.has(id)).length / expectedIds.length;
}

export function seedNoeMemoryRecallBenchmark({ writeGate, projectId = 'noe', fixtures = DEFAULT_MEMORY_RECALL_FIXTURES } = {}) {
  if (!writeGate?.commit) throw new Error('writeGate required');
  const seeded = [];
  for (const fixture of fixtures) {
    const result = writeGate.commit({
      ...fixture,
      projectId,
      targetMemoryId: fixture.id,
      sourceType: 'recall_benchmark_fixture',
      writeMode: 'validated_consensus',
      actor: 'noe_memory_recall_benchmark',
    });
    seeded.push({ id: fixture.id, ok: result.ok === true, decision: result.decision, reason: result.reason });
  }
  return seeded;
}

export async function runNoeMemoryRecallBenchmark({
  retriever,
  writeGate = null,
  projectId = 'noe',
  cases = DEFAULT_MEMORY_RECALL_CASES,
  fixtures = DEFAULT_MEMORY_RECALL_FIXTURES,
  seed = true,
  minRecall = 1,
} = {}) {
  if (!retriever?.retrieve) throw new Error('retriever required');
  const seeded = seed ? seedNoeMemoryRecallBenchmark({ writeGate, projectId, fixtures }) : [];
  const results = [];
  for (const item of cases) {
    const k = Math.max(1, Math.min(20, Number(item.k) || 5));
    const result = await retriever.retrieve({
      transcript: item.query,
      task: item.task || '',
      goal: item.goal || '',
      person: item.person || '',
      projectId,
      routeType: item.routeType || 'chat',
      limit: k,
      memoryPolicy: { recallLimit: k, injectLimit: k },
      turnId: `recall-benchmark:${item.id}`,
    });
    const selectedIds = Array.isArray(result.selectedIds)
      ? result.selectedIds.slice(0, k)
      : (result.selected || []).map((m) => m.id).slice(0, k);
    const expectedIds = Array.isArray(item.expectedIds) ? item.expectedIds : [];
    const disallowedIds = Array.isArray(item.disallowedIds) ? item.disallowedIds : [];
    const recall = recallAt(selectedIds, expectedIds);
    const precision = precisionAt(selectedIds, expectedIds);
    const blocked = selectedIds.filter((id) => disallowedIds.includes(id));
    const minPrecisionForCase = Number.isFinite(Number(item.minPrecision)) ? Number(item.minPrecision) : 0;
    results.push({
      id: item.id,
      passed: result.ok === true
        && recall >= minRecall
        && precision >= minPrecisionForCase
        && blocked.length === 0
        && (item.expectEmpty ? selectedIds.length === 0 : true),
      routeType: item.routeType || 'chat',
      k,
      expectedIds,
      disallowedIds,
      selectedIds,
      precisionAtK: Math.round(precision * 1000) / 1000,
      recallAtK: Math.round(recall * 1000) / 1000,
      blockedIds: blocked,
      droppedReasons: result.droppedReasons || [],
    });
  }
  const failed = results.filter((r) => !r.passed);
  return {
    ok: failed.length === 0 && seeded.every((r) => r.ok),
    seeded,
    summary: {
      cases: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      minRecall,
    },
    results,
    policy: {
      noMemoryBodyOutput: true,
      noSecretOutput: true,
    },
  };
}
