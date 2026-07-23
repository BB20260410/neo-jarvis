const MAX_EVIDENCE_ITEMS = 8;
const MAX_GRAPH_ITEMS = 8;

function safeString(value, max = 4000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function uniqBy(list, keyFn) {
  const out = [];
  const seen = new Set();
  for (const item of list || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function evidenceFileFor(map, path) {
  return (map?.evidence || []).find((file) => file.path === path) || null;
}

function nearLine(item, line, tolerance = 2) {
  const itemLine = Math.max(1, Number(item?.line) || 1);
  const targetLine = Math.max(1, Number(line) || 1);
  return Math.abs(itemLine - targetLine) <= tolerance;
}

function symbolEvidence(file, result) {
  const anchor = safeString(result.anchor, 160);
  return (file?.symbols || []).filter((symbol) => (
    symbol.name === anchor ||
    nearLine(symbol, result.line, 1) ||
    (result.symbols || []).some((item) => item.name === symbol.name)
  )).map((symbol) => ({
    kind: 'symbol',
    path: file.path,
    line: Math.max(1, Number(symbol.line) || 1),
    name: symbol.name,
    type: symbol.type,
    exported: !!symbol.exported,
  }));
}

function anchorEvidence(file, result) {
  const anchor = safeString(result.anchor, 180);
  return (file?.anchors || []).filter((item) => (
    item.name === anchor ||
    nearLine(item, result.line, 1) ||
    (result.routes || []).some((route) => route.name === item.name)
  )).map((item) => ({
    kind: item.kind || 'anchor',
    path: file.path,
    line: Math.max(1, Number(item.line) || 1),
    name: item.name,
  }));
}

function textEvidence(file, result) {
  return (file?.snippets || []).filter((item) => (
    nearLine(item, result.line, 1) ||
    (result.text && item.text && safeString(result.text, 120).includes(safeString(item.text, 80)))
  )).map((item) => ({
    kind: `snippet:${item.reason || 'evidence'}`,
    path: file.path,
    line: Math.max(1, Number(item.line) || 1),
    text: safeString(item.text, 220),
  }));
}

function importMatchesAnchor(item, anchor, line) {
  if (nearLine(item, line, 1)) return true;
  const specifiers = item.specifiers || [];
  return specifiers.some((specifier) => specifier.local === anchor || specifier.imported === anchor);
}

function exportMatchesAnchor(item, anchor, line) {
  return nearLine(item, line, 1) || item.name === anchor || item.local === anchor;
}

function mapImportEvidence(file, item) {
  return {
    kind: `import:${item.kind || 'import'}`,
    path: file.path,
    line: Math.max(1, Number(item.line) || 1),
    source: item.source,
    specifiers: (item.specifiers || []).slice(0, 6),
  };
}

function mapExportEvidence(file, item) {
  return {
    kind: `export:${item.kind || 'named'}`,
    path: file.path,
    line: Math.max(1, Number(item.line) || 1),
    name: item.name,
    local: item.local,
    source: item.source || '',
  };
}

function importExportEvidence(file, result) {
  const anchor = safeString(result.anchor, 160);
  const imports = (file?.imports || [])
    .filter((item) => importMatchesAnchor(item, anchor, result.line))
    .map((item) => mapImportEvidence(file, item));
  const exports = (file?.exports || [])
    .filter((item) => exportMatchesAnchor(item, anchor, result.line))
    .map((item) => mapExportEvidence(file, item));
  return [...imports, ...exports];
}

function referenceEvidence(file, result) {
  const anchor = safeString(result.anchor, 160);
  return (file?.references || []).filter((item) => (
    nearLine(item, result.line, 1) ||
    item.name === anchor
  )).map((item) => ({
    kind: `reference:${item.kind || 'reference'}`,
    path: file.path,
    line: Math.max(1, Number(item.line) || 1),
    name: item.name,
    text: safeString(item.text, 220),
  }));
}

function definitionsMatch(item, anchor, result) {
  return item.path === result.path && (item.name === anchor || nearLine(item, result.line, 1));
}

function referencesMatch(item, anchor, result) {
  return item.fromPath === result.path || item.toPath === result.path || item.symbol === anchor;
}

function routeUsagesMatch(item, anchor, result) {
  return item.fromPath === result.path || item.toPath === result.path || item.route === anchor;
}

function routeTestChainsMatch(item, anchor, result) {
  if (item.routePath === result.path || item.testPath === result.path || item.route === anchor) return true;
  return (item.path || []).some((step) => step.path === result.path || step.toPath === result.path);
}

function unresolvedReferencesMatch(item, anchor, result) {
  return item.fromPath === result.path || item.name === anchor;
}

function graphSlice(items, matcher, anchor, result) {
  return (items || []).filter((item) => matcher(item, anchor, result)).slice(0, MAX_GRAPH_ITEMS);
}

function graphEvidence(map, result) {
  const graph = map?.symbolGraph || {};
  const anchor = safeString(result.anchor, 160);
  return {
    definitions: graphSlice(graph.definitions, definitionsMatch, anchor, result),
    references: graphSlice(graph.references, referencesMatch, anchor, result),
    routeUsages: graphSlice(graph.routeUsages, routeUsagesMatch, anchor, result),
    routeTestChains: graphSlice(graph.routeTestChains, routeTestChainsMatch, anchor, result),
    unresolvedReferences: graphSlice(graph.unresolvedReferences, unresolvedReferencesMatch, anchor, result),
  };
}

function baseName(p = '') {
  const s = String(p || '');
  const idx = s.lastIndexOf('/');
  return idx >= 0 ? s.slice(idx + 1) : s;
}

// 把 route 链串成人类可读的引用路径，如：
// route POST /api/x -> createX (routes.js:12) -> XStore.create (store.js:30) -> test x.test.js:5
function formatChainStep(step = {}) {
  const loc = step.path ? `${baseName(step.path)}:${step.line || '?'}` : '';
  const label = step.label || step.kind || '';
  if (!label && !loc) return null;
  return loc ? `${label} (${loc})` : label;
}

function readableChainPath(chain = {}) {
  const header = `route ${chain.route || '?'}`;
  const steps = (chain.path || []).map(formatChainStep).filter(Boolean);
  const tail = `test ${baseName(chain.testPath)}:${chain.testLine || '?'}`;
  return [header, ...steps, tail].join(' -> ');
}

/**
 * Extracts citation paths from the graph evidence.
 * @param {Object} graph - The graph evidence object containing routeTestChains.
 * @returns {Array<Object>} An array of citation path objects.
 */
export function citationPathsFromGraph(graph = {}) {
  return (graph.routeTestChains || []).map((chain) => ({
    kind: 'route-to-test',
    label: `${chain.route} -> ${chain.testPath}:${chain.testLine}`,
    readable: readableChainPath(chain),
    route: chain.route,
    steps: (chain.path || []).map((step) => ({
      kind: step.kind,
      path: step.path,
      line: step.line,
      label: step.label,
      toPath: step.toPath || '',
    })),
  })).slice(0, MAX_GRAPH_ITEMS);
}

/**
 * Collects and deduplicates evidence entries for a result.
 * @param {Object|null} file - The matched file entry or null.
 * @param {Object} result - The analysis result.
 * @returns {Array} Deduplicated evidence items, capped to MAX_EVIDENCE_ITEMS.
 */
function collectCitationEvidence(file, result) {
  if (!file) return [];
  const dedupeKey = (item) => `${item.kind}:${item.path}:${item.line}:${item.name || item.source || item.text || ''}`;
  return uniqBy([
    ...symbolEvidence(file, result),
    ...anchorEvidence(file, result),
    ...textEvidence(file, result),
    ...importExportEvidence(file, result),
    ...referenceEvidence(file, result),
  ], dedupeKey).slice(0, MAX_EVIDENCE_ITEMS);
}

/**
 * Resolves the canonical 1-based line number for a result.
 * @param {Object} result - The analysis result.
 * @returns {number} A line number no less than 1.
 */
function citationLineFor(result) {
  return Math.max(1, Number(result.line) || 1);
}

/**
 * Resolves the citation kind, falling back to 'file' when missing.
 * @param {Object} result - The analysis result.
 * @returns {string} The citation kind label.
 */
function citationKindFor(result) {
  return safeString(result.kind, 80) || 'file';
}

/**
 * Resolves the citation parser name with a graceful fallback chain.
 * @param {Object} result - The analysis result.
 * @param {Object|null} file - The matched file entry or null.
 * @returns {string} The parser identifier.
 */
function citationParserFor(result, file) {
  return result.parser || file?.parser || 'unknown';
}

/**
 * Limits and copies the reason list to at most 9 entries.
 * @param {Object} result - The analysis result.
 * @returns {Array} The trimmed reason array.
 */
function citationReasonsFor(result) {
  return Array.isArray(result.reason) ? result.reason.slice(0, 9) : [];
}

/**
 * Builds a codebase citation object for a specific result.
 * @param {Object} map - The file map.
 * @param {Object} result - The analysis result.
 * @returns {Object} The constructed citation object.
 */
export function buildCodebaseCitation(map = {}, result = {}) {
  const file = evidenceFileFor(map, result.path);
  const line = citationLineFor(result);
  const graph = graphEvidence(map, result);
  return {
    id: `${safeString(result.path, 300)}:${line}:${safeString(result.kind, 80)}`,
    path: safeString(result.path, 300),
    line,
    kind: citationKindFor(result),
    anchor: result.anchor || null,
    parser: citationParserFor(result, file),
    reason: citationReasonsFor(result),
    evidence: collectCitationEvidence(file, result),
    graph,
    paths: citationPathsFromGraph(graph),
  };
}

/**
 * Attaches codebase citations to a list of results.
 * @param {Object} map - The file map.
 * @param {Array<Object>} results - The array of results to attach citations to.
 * @returns {Array<Object>} The results with attached citations.
 */
export function attachCodebaseCitations(map = {}, results = []) {
  return (results || []).map((result) => ({
    ...result,
    citation: buildCodebaseCitation(map, result),
  }));
}

/**
 * Summarizes a list of codebase citations.
 * @param {Array<Object>} results - The array of results containing citations.
 * @returns {Object} A summary object with counts of various citation metrics.
 */
export function summarizeCodebaseCitations(results = []) {
  const citations = (results || []).map((item) => item.citation).filter(Boolean);
  return {
    enabled: true,
    chainCount: citations.length,
    evidenceItemCount: citations.reduce((sum, item) => sum + (item.evidence || []).length, 0),
    graphReferenceCount: citations.reduce((sum, item) => sum + (item.graph?.references || []).length, 0),
    typeImplementationCount: citations.reduce((sum, item) => (
      sum + (item.graph?.references || []).filter((ref) => ref.kind === 'type-implementation').length
    ), 0),
    routeUsageCount: citations.reduce((sum, item) => sum + (item.graph?.routeUsages || []).length, 0),
    routeToTestChainCount: citations.reduce((sum, item) => sum + (item.graph?.routeTestChains || []).length, 0),
    unresolvedReferenceCount: citations.reduce((sum, item) => sum + (item.graph?.unresolvedReferences || []).length, 0),
    citationPathCount: citations.reduce((sum, item) => sum + (item.paths || []).length, 0),
  };
}
