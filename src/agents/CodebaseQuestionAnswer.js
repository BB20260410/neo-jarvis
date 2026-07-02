const MAX_ANSWER_RESULTS = 6;
const MAX_REASON_COUNT = 4;

function safeString(value, max = 4000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function uniq(list = []) {
  return [...new Set((list || []).filter(Boolean))];
}

function shortReasonList(reasons = []) {
  return uniq(reasons).slice(0, MAX_REASON_COUNT);
}

function citationSnippet(result = {}) {
  const text = safeString(result.text, 260);
  if (text) return text;
  const evidence = result.citation?.evidence || [];
  const snippet = evidence.find(item => item.text);
  return safeString(snippet?.text, 260);
}

function citationEvidenceCounts(citation = {}) {
  const graphReferences = Array.isArray(citation.graph?.references) ? citation.graph.references : [];
  const routeTestChains = Array.isArray(citation.graph?.routeTestChains) ? citation.graph.routeTestChains : [];
  const unresolvedReferences = Array.isArray(citation.graph?.unresolvedReferences) ? citation.graph.unresolvedReferences : [];
  return {
    evidence: Array.isArray(citation.evidence) ? citation.evidence.length : 0,
    graphReferences: graphReferences.length,
    typeImplementations: graphReferences.filter((item) => item.kind === 'type-implementation').length,
    routeUsages: Array.isArray(citation.graph?.routeUsages) ? citation.graph.routeUsages.length : 0,
    routeTestChains: routeTestChains.length,
    unresolvedReferences: unresolvedReferences.length,
    citationPaths: Array.isArray(citation.paths) ? citation.paths.length : 0,
  };
}

function citationLine(result = {}) {
  return Math.max(1, Number(result.line) || 1);
}

function citationSemanticScore(result = {}) {
  const value = Number(result.semanticScore);
  return Number.isFinite(value) ? value : null;
}

function citationField(result, key, fallback) {
  const direct = result[key];
  if (direct) return direct;
  const nested = result.citation?.[key];
  if (nested) return nested;
  return fallback;
}

function buildCitation(result = {}, index = 0) {
  const line = citationLine(result);
  const counts = citationEvidenceCounts(result.citation || {});
  const path = safeString(result.path, 300);
  return {
    id: `C${index + 1}`,
    path,
    line,
    label: `${path}:${line}`,
    kind: safeString(citationField(result, 'kind', 'file'), 100),
    anchor: safeString(citationField(result, 'anchor', ''), 180),
    parser: safeString(citationField(result, 'parser', 'unknown'), 80),
    score: Number(result.score || 0),
    semanticScore: citationSemanticScore(result),
    reasons: shortReasonList(citationField(result, 'reason', [])),
    snippet: citationSnippet(result),
    evidenceCount: counts.evidence,
    graphReferenceCount: counts.graphReferences,
    typeImplementationCount: counts.typeImplementations,
    routeUsageCount: counts.routeUsages,
    routeToTestChainCount: counts.routeTestChains,
    unresolvedReferenceCount: counts.unresolvedReferences,
    citationPathCount: counts.citationPaths,
  };
}

function confidenceFor(results = [], citations = []) {
  if (!results.length) return 'none';
  const top = Number(results[0]?.score || 0);
  const evidence = citations.reduce((sum, item) => (
    sum + item.evidenceCount + item.graphReferenceCount + item.routeUsageCount + item.routeToTestChainCount
  ), 0);
  if (top >= 130 && evidence >= 2) return 'high';
  if (top >= 80 || evidence >= 1) return 'medium';
  return 'low';
}

function answerLine(citation = {}) {
  const anchor = citation.anchor ? ` ${citation.anchor}` : '';
  const reasons = citation.reasons.length ? `; signals: ${citation.reasons.join(', ')}` : '';
  const chains = citation.routeToTestChainCount ? `; route-test chains: ${citation.routeToTestChainCount}` : '';
  return `[${citation.id}] ${citation.label} (${citation.kind}${anchor})${reasons}${chains}`;
}

function supportCountFor(coverage = {}) {
  return (coverage?.evidenceItemCount || 0) +
    (coverage?.graphReferenceCount || 0) +
    (coverage?.routeUsageCount || 0) +
    (coverage?.routeToTestChainCount || 0);
}

function hasInsufficientSupport(confidence, coverage = {}) {
  return confidence === 'low' || supportCountFor(coverage) === 0;
}

function hasUnresolvedReferences(coverage = {}) {
  return (coverage?.unresolvedReferenceCount || 0) > 0;
}

function hasRouteUsageWithoutChain(coverage = {}) {
  return (coverage?.routeUsageCount || 0) > 0 && (coverage?.routeToTestChainCount || 0) === 0;
}

function limitationsFor({ confidence, coverage } = {}) {
  const limitations = [
    'Deterministic local evidence only',
    'No model inference',
    'LSP/Tree-sitter dynamic references are not complete yet',
  ];
  if (hasInsufficientSupport(confidence, coverage)) {
    limitations.push('Evidence is insufficient for a complete implementation summary; use citations as leads only');
  }
  if (hasUnresolvedReferences(coverage)) {
    limitations.push(`${coverage.unresolvedReferenceCount} indexed references were unresolved in the local graph`);
  }
  if (hasRouteUsageWithoutChain(coverage)) {
    limitations.push('Route usage was found, but no route-to-test chain was proven');
  }
  return limitations;
}

/**
 * Builds a structured answer object for codebase questions based on indexed results.
 *
 * @param {Object} queryResult - The raw query result object from the indexer.
 * @param {string} [queryResult.query] - The original question string.
 * @param {string} [queryResult.question] - Alias for query.
 * @param {Array} [queryResult.results] - Array of matched code results.
 * @param {number} [queryResult.resultCount] - Total count of results before slicing.
 * @param {Object} [queryResult.symbolGraphSummary] - Summary statistics from the symbol graph.
 * @param {Object} [queryResult.status] - Status object, potentially containing symbolGraphSummary.
 * @returns {Object} Structured answer object containing confidence, citations, coverage, and limitations.
 */
function extractAnswerQuestion(queryResult = {}) {
  return safeString(queryResult.query || queryResult.question, 500);
}

function extractTopAnswerResults(queryResult = {}) {
  return Array.isArray(queryResult.results) ? queryResult.results.slice(0, MAX_ANSWER_RESULTS) : [];
}

function sumCitationField(citations, field) {
  return citations.reduce((sum, item) => sum + item[field], 0);
}

function extractGraphSummary(queryResult = {}) {
  return queryResult.symbolGraphSummary || queryResult.status?.symbolGraphSummary || {};
}

function aggregateReferenceKinds(results) {
  const referenceKindCounts = {};
  for (const result of results) {
    for (const ref of result.citation?.graph?.references || []) {
      const k = safeString(ref.kind, 80);
      if (k) referenceKindCounts[k] = (referenceKindCounts[k] || 0) + 1;
    }
  }
  return referenceKindCounts;
}

function computeCoverage({
  citations,
  results,
  queryResult,
  graphSummary,
  routeToTestChainCount,
  unresolvedReferenceCount,
}) {
  return {
    resultCount: Number(queryResult.resultCount || queryResult.results?.length || 0),
    citedResultCount: citations.length,
    uniqueFileCount: uniq(citations.map(item => item.path)).length,
    evidenceItemCount: citations.reduce((sum, item) => sum + item.evidenceCount, 0),
    graphReferenceCount: citations.reduce((sum, item) => sum + item.graphReferenceCount, 0),
    typeImplementationCount: citations.reduce((sum, item) => sum + item.typeImplementationCount, 0),
    routeUsageCount: citations.reduce((sum, item) => sum + item.routeUsageCount, 0),
    routeToTestChainCount: Math.max(routeToTestChainCount, Number(graphSummary.routeToTestChainCount) || 0),
    unresolvedReferenceCount: Math.max(unresolvedReferenceCount, Number(graphSummary.unresolvedReferenceCount) || 0),
    citationPathCount: citations.reduce((sum, item) => sum + item.citationPathCount, 0),
    referenceKindCounts: aggregateReferenceKinds(results),
  };
}

function buildStructuralEvidenceCount(coverage) {
  return coverage.graphReferenceCount
    + coverage.routeUsageCount
    + coverage.typeImplementationCount
    + coverage.routeToTestChainCount;
}

function buildAnswerText({ top, support, weakEvidence }) {
  const anchor = top.anchor ? ` (${top.anchor})` : '';
  const supportText = support.length ? ` Supporting evidence: ${support.join(', ')}.` : '';
  const weakText = weakEvidence
    ? ' Evidence is weak (no structural or low-confidence matches); treat the citations as leads only, not a complete implementation map.'
    : '';
  return `Most relevant local evidence points to ${top.label}${anchor}.${supportText} Use the citations below as the source of truth; this answer is a deterministic summary of indexed code evidence.${weakText}`;
}

function buildEvidenceAnswer({ question, confidence, weakEvidence, citations, coverage, limitations }) {
  const top = citations[0];
  const support = citations.slice(1, 4).map(item => item.label);
  return {
    ok: true,
    mode: 'local-codebase-question',
    generatedBy: 'CodebaseIndexStore',
    question,
    confidence,
    weakEvidence,
    answer: buildAnswerText({ top, support, weakEvidence }),
    answerLines: citations.map(answerLine),
    citations,
    coverage,
    nextActions: ['Add cited files to Dispatch Preview', 'Open the top path in the editor', 'Rebuild if the code changed after the last index'],
    limitations,
  };
}

function buildNoEvidenceAnswer({ question, confidence, coverage, limitations }) {
  return {
    ok: true,
    mode: 'local-codebase-question',
    generatedBy: 'CodebaseIndexStore',
    question,
    confidence,
    weakEvidence: true,
    answer: 'No indexed code evidence matched this question. Rebuild the local Codebase Index or narrow the question to a symbol, route, file, or UI element.',
    answerLines: [],
    citations: [],
    coverage,
    nextActions: ['Rebuild Codebase Index', 'Try a symbol, route, file path, or UI element name'],
    limitations,
  };
}

/**
 * Build a deterministic answer summary for a local-codebase question.
 *
 * Aggregates citations, computes coverage metrics (file count, evidence counts,
 * reference-kind breakdown, route/test-chain coverage, unresolved references),
 * derives a confidence label plus a weak-evidence flag, and assembles the final
 * answer payload (text + supporting lines + next actions + limitations).
 *
 * @param {Object} [queryResult] - Raw query result from the local Codebase Index.
 * @param {string} [queryResult.query] - The question text (alias: `question`).
 * @param {Array}  [queryResult.results] - Top retrieved hits from the index.
 * @param {number} [queryResult.resultCount] - Total hits before slicing.
 * @param {Object} [queryResult.symbolGraphSummary] - Summary statistics from the symbol graph.
 * @param {Object} [queryResult.status] - Status object, potentially containing symbolGraphSummary.
 * @returns {Object} Structured answer payload: `question`, `confidence`, `weakEvidence`, `answer`, `answerLines`, `citations`, `coverage`, `nextActions`, `limitations`.
 */
export function buildCodebaseQuestionAnswer(queryResult = {}) {
  const question = extractAnswerQuestion(queryResult);
  const results = extractTopAnswerResults(queryResult);
  const citations = results.map(buildCitation);
  const graphSummary = extractGraphSummary(queryResult);
  const routeToTestChainCount = sumCitationField(citations, 'routeToTestChainCount');
  const unresolvedReferenceCount = sumCitationField(citations, 'unresolvedReferenceCount');
  const coverage = computeCoverage({
    citations,
    results,
    queryResult,
    graphSummary,
    routeToTestChainCount,
    unresolvedReferenceCount,
  });
  const confidence = confidenceFor(results, citations);
  const structuralEvidenceCount = buildStructuralEvidenceCount(coverage);
  const weakEvidence = confidence === 'low' || structuralEvidenceCount === 0;
  const limitations = limitationsFor({ confidence, coverage });
  if (citations.length && structuralEvidenceCount === 0) {
    limitations.push('No structural (reference/route/type) evidence — answer rests on name/text matches; verify citations before relying on it');
  }
  if (!citations.length) {
    return buildNoEvidenceAnswer({ question, confidence, coverage, limitations });
  }
  return buildEvidenceAnswer({ question, confidence, weakEvidence, citations, coverage, limitations });
}
