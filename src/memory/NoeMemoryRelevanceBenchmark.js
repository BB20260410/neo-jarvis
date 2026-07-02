// @ts-check

export const DEFAULT_MEMORY_RELEVANCE_CASES = Object.freeze([
  {
    id: 'user_note_scope_recall',
    query: '记住我喜欢美式咖啡',
    routeType: 'chat',
    expectedIds: ['bench-user-note'],
    disallowedIds: ['bench-project-note'],
    limit: 5,
    minExpectedRecall: 1,
    maxExpectedRank: 1,
    maxDisallowedHits: 0,
  },
]);

function clean(value, max = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function uniqueStrings(value, max = 100) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const text = clean(item, 180);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 8;
  return Math.max(1, Math.min(20, Math.trunc(n)));
}

function normalizeRate(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function normalizeCount(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(20, Math.trunc(n)));
}

function normalizeCase(item = {}, index = 0) {
  const expectedIds = uniqueStrings(item.expectedIds);
  return {
    id: clean(item.id || `case-${index + 1}`, 100) || `case-${index + 1}`,
    query: clean(item.query || item.q || '', 1000),
    routeType: clean(item.routeType || 'chat', 60) || 'chat',
    expectedIds,
    disallowedIds: uniqueStrings(item.disallowedIds),
    limit: normalizeLimit(item.limit ?? item.k),
    minExpectedRecall: normalizeRate(item.minExpectedRecall, expectedIds.length ? 1 : 0),
    maxExpectedRank: normalizeCount(item.maxExpectedRank, item.maxRank ?? 20),
    maxDisallowedHits: normalizeCount(item.maxDisallowedHits, 0),
    maxUnlabeledSelected: normalizeCount(item.maxUnlabeledSelected, item.maxUnlabeled ?? 20),
    expectEmpty: item.expectEmpty === true,
  };
}

function normalizeCases(cases) {
  return (Array.isArray(cases) ? cases : DEFAULT_MEMORY_RELEVANCE_CASES)
    .map(normalizeCase)
    .filter((item) => item.query);
}

function rankForExpected(selectedIds, expectedIds) {
  const ranks = expectedIds
    .map((id) => selectedIds.indexOf(id))
    .filter((index) => index >= 0)
    .map((index) => index + 1);
  return ranks.length ? Math.min(...ranks) : null;
}

function round3(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function scoreSelection({ selectedIds = [], expectedIds = [], disallowedIds = [] } = {}) {
  const expected = new Set(expectedIds);
  const disallowed = new Set(disallowedIds);
  const expectedHitIds = selectedIds.filter((id) => expected.has(id));
  const disallowedHitIds = selectedIds.filter((id) => disallowed.has(id));
  const unlabeledSelectedIds = selectedIds.filter((id) => !expected.has(id) && !disallowed.has(id));
  const labeledHits = expectedHitIds.length + disallowedHitIds.length;
  return {
    selectedIds,
    expectedHitIds,
    disallowedHitIds,
    unlabeledSelectedIds,
    unlabeledSelectedCount: unlabeledSelectedIds.length,
    expectedRecallAtK: expectedIds.length ? round3(expectedHitIds.length / expectedIds.length) : 1,
    labeledPrecisionAtK: labeledHits ? round3(expectedHitIds.length / labeledHits) : (expectedIds.length ? 0 : 1),
    bestExpectedRank: rankForExpected(selectedIds, expectedIds),
  };
}

function selectedIdsFromResult(result = {}, limit = 8) {
  const ids = Array.isArray(result.selectedIds)
    ? result.selectedIds
    : (Array.isArray(result.selected) ? result.selected.map((item) => item?.id) : []);
  return uniqueStrings(ids, limit);
}

async function runOne({ retriever, item, projectId, mode }) {
  const result = await retriever.retrieve({
    transcript: item.query,
    projectId,
    routeType: item.routeType,
    limit: item.limit,
    memoryPolicy: { recallLimit: item.limit, injectLimit: item.limit },
    turnId: `memory-relevance-benchmark:${mode}:${item.id}`,
  });
  const metrics = scoreSelection({
    selectedIds: selectedIdsFromResult(result, item.limit),
    expectedIds: item.expectedIds,
    disallowedIds: item.disallowedIds,
  });
  const rankOk = item.expectedIds.length
    ? metrics.bestExpectedRank !== null && metrics.bestExpectedRank <= item.maxExpectedRank
    : true;
  return {
    ok: result.ok === true,
    passed: result.ok === true
      && metrics.expectedRecallAtK >= item.minExpectedRecall
      && metrics.disallowedHitIds.length <= item.maxDisallowedHits
      && metrics.unlabeledSelectedCount <= item.maxUnlabeledSelected
      && rankOk
      && (item.expectEmpty ? metrics.selectedIds.length === 0 : true),
    ...metrics,
    droppedReasons: result.droppedReasons || [],
  };
}

function compareCase(item, baseline, semantic) {
  const baselineRank = baseline.bestExpectedRank ?? 999;
  const semanticRank = semantic.bestExpectedRank ?? 999;
  return {
    id: item.id,
    routeType: item.routeType,
    queryRef: item.id,
    limit: item.limit,
    expectedIds: item.expectedIds,
    disallowedIds: item.disallowedIds,
    thresholds: {
      minExpectedRecall: item.minExpectedRecall,
      maxExpectedRank: item.maxExpectedRank,
      maxDisallowedHits: item.maxDisallowedHits,
      maxUnlabeledSelected: item.maxUnlabeledSelected,
    },
    baseline,
    semantic,
    comparison: {
      semanticExpectedHitDelta: semantic.expectedHitIds.length - baseline.expectedHitIds.length,
      semanticDisallowedHitDelta: semantic.disallowedHitIds.length - baseline.disallowedHitIds.length,
      semanticRankImproved: semanticRank < baselineRank,
      semanticNotWorse: semantic.expectedHitIds.length >= baseline.expectedHitIds.length
        && semantic.disallowedHitIds.length <= baseline.disallowedHitIds.length,
    },
  };
}

function summarize(cases) {
  const semanticPassed = cases.filter((item) => item.semantic.passed).length;
  const baselinePassed = cases.filter((item) => item.baseline.passed).length;
  const semanticExpectedHits = cases.reduce((sum, item) => sum + item.semantic.expectedHitIds.length, 0);
  const baselineExpectedHits = cases.reduce((sum, item) => sum + item.baseline.expectedHitIds.length, 0);
  const semanticDisallowedHits = cases.reduce((sum, item) => sum + item.semantic.disallowedHitIds.length, 0);
  const baselineDisallowedHits = cases.reduce((sum, item) => sum + item.baseline.disallowedHitIds.length, 0);
  const semanticUnlabeledSelected = cases.reduce((sum, item) => sum + item.semantic.unlabeledSelectedCount, 0);
  const baselineUnlabeledSelected = cases.reduce((sum, item) => sum + item.baseline.unlabeledSelectedCount, 0);
  const semanticNotWorseCases = cases.filter((item) => item.comparison.semanticNotWorse).length;
  const semanticRankImprovedCases = cases.filter((item) => item.comparison.semanticRankImproved).length;
  return {
    cases: cases.length,
    semanticPassed,
    baselinePassed,
    failed: cases.length - semanticPassed,
    semanticExpectedHits,
    baselineExpectedHits,
    semanticDisallowedHits,
    baselineDisallowedHits,
    semanticUnlabeledSelected,
    baselineUnlabeledSelected,
    semanticNotWorseCases,
    semanticRankImprovedCases,
    semanticQualityOk: cases.length > 0
      && semanticPassed === cases.length
      && semanticExpectedHits >= baselineExpectedHits
      && semanticDisallowedHits <= baselineDisallowedHits,
  };
}

export async function runNoeMemoryRelevanceBenchmark({
  semanticRetriever,
  baselineRetriever,
  projectId = 'noe',
  cases = DEFAULT_MEMORY_RELEVANCE_CASES,
  semantic = null,
} = {}) {
  if (!semanticRetriever?.retrieve) throw new Error('semanticRetriever required');
  if (!baselineRetriever?.retrieve) throw new Error('baselineRetriever required');
  const normalized = normalizeCases(cases);
  const results = [];
  for (const item of normalized) {
    const baseline = await runOne({ retriever: baselineRetriever, item, projectId, mode: 'baseline' });
    const semanticResult = await runOne({ retriever: semanticRetriever, item, projectId, mode: 'semantic' });
    results.push(compareCase(item, baseline, semanticResult));
  }
  const summary = summarize(results);
  return {
    ok: summary.semanticQualityOk,
    projectId,
    semantic,
    summary,
    results,
    policy: {
      noMemoryBodyOutput: true,
      noSecretOutput: true,
      realDbWrites: false,
      retrievalLogWrites: false,
      selectedIdsOnly: true,
    },
  };
}

export async function runNoeMemoryRelevanceBenchmarkSelfTest() {
  const baselineRetriever = {
    async retrieve() {
      return { ok: true, selectedIds: ['bench-project-note'] };
    },
  };
  const semanticRetriever = {
    async retrieve() {
      return { ok: true, selectedIds: ['bench-user-note'] };
    },
  };
  return runNoeMemoryRelevanceBenchmark({
    baselineRetriever,
    semanticRetriever,
    projectId: 'noe-test',
    semantic: { provider: 'fixture', model: 'fixture' },
  });
}
