import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const MAX_SYMBOLS = 80;
const MAX_REFERENCES = 240;
const MAX_ROUTE_USAGES = 80;
const MAX_ROUTE_TEST_CHAINS = 80;
const MAX_UNRESOLVED_REFERENCES = 120;
const MIN_SYMBOL_LEN = 3;
const COMMON_SYMBOLS = new Set([
  'array',
  'app',
  'boolean',
  'ctx',
  'date',
  'describe',
  'err',
  'error',
  'expect',
  'fetch',
  'it',
  'json',
  'map',
  'math',
  'number',
  'object',
  'promise',
  'query',
  'req',
  'require',
  'res',
  'regexp',
  'row',
  'set',
  'get',
  'string',
  'test',
  'tobe',
  'tocontain',
  'toequal',
  'out',
]);

function safeString(value, max = 4000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeRel(path = '') {
  return safeString(path, 300).replace(/\\/g, '/').replace(/^\/+/, '');
}

function withinRoot(root, abs) {
  const rel = relative(root, abs);
  return rel && !rel.startsWith('..') && !rel.includes('\0') && !rel.startsWith('/');
}

function readProjectFile(cwd, path, fsApi = {}) {
  const rel = normalizeRel(path);
  if (!cwd || !rel) return '';
  const root = resolve(cwd);
  const abs = resolve(root, rel);
  if (!withinRoot(root, abs)) return '';
  try {
    const read = fsApi.readFileSync || readFileSync;
    return read(abs, 'utf8');
  } catch {
    return '';
  }
}

function cleanLine(line = '') {
  return line.replace(/\s+/g, ' ').trim().slice(0, 220);
}

function normalizeDefinition(file, symbol) {
  const name = safeString(symbol?.name, 120);
  if (!name || name.length < MIN_SYMBOL_LEN || COMMON_SYMBOLS.has(name.toLowerCase())) return null;
  return {
    id: `${file.path}:${name}:${Number(symbol.line) || 1}`,
    name,
    type: safeString(symbol.type, 40) || 'symbol',
    path: file.path,
    line: Math.max(1, Number(symbol.line) || 1),
    exported: !!symbol.exported,
    owner: safeString(symbol.owner, 120),
    ownerType: safeString(symbol.ownerType, 40),
    exportNames: exportNamesForSymbol(file, symbol),
  };
}

function exportNamesForSymbol(file, symbol) {
  const name = safeString(symbol?.name, 120);
  const out = new Set();
  if (symbol?.exported && name) out.add(name);
  for (const item of file?.exports || []) {
    if (item.source) continue;
    const local = safeString(item.local || item.name, 120);
    const exported = safeString(item.name, 120);
    if (!exported) continue;
    if (local === name || (exported === 'default' && symbol?.exported)) out.add(exported);
  }
  return [...out].slice(0, 8);
}

function collectDefinitions(evidence = []) {
  const definitions = [];
  const seen = new Set();
  for (const file of evidence || []) {
    for (const symbol of file.symbols || []) {
      const def = normalizeDefinition(file, symbol);
      if (!def || seen.has(def.id)) continue;
      seen.add(def.id);
      definitions.push(def);
      if (definitions.length >= MAX_SYMBOLS) return definitions;
    }
  }
  return definitions;
}

function findReferencesForDefinition(definition, file, text) {
  if (!definition?.name || !file?.path || !text) return [];
  const re = new RegExp(`\\b${escapeRegExp(definition.name)}\\b\\s*(\\()?`, 'g');
  const lines = String(text || '').split(/\r?\n/);
  const refs = [];
  lines.forEach((line, idx) => {
    let match = re.exec(line);
    while (match) {
      const lineNumber = idx + 1;
      const isDefinitionLine = definition.path === file.path && definition.line === lineNumber;
      if (!isDefinitionLine) {
        refs.push({
          symbolId: definition.id,
          symbol: definition.name,
          fromPath: file.path,
          toPath: definition.path,
          line: lineNumber,
          kind: match[1] ? 'call' : 'reference',
          text: cleanLine(line),
        });
      }
      match = re.exec(line);
    }
  });
  return refs;
}

function normalizeReferenceKind(kind = '') {
  const value = safeString(kind, 40);
  if (value === 'call') return 'call';
  if (value === 'dynamic-import') return 'dynamic-import';
  if (value.startsWith('type-')) return value;
  if (value.startsWith('member-')) return value;
  return 'reference';
}

function resolveImportTarget(fromPath, source, availablePaths) {
  if (!source || !source.startsWith('.')) return null;
  const base = normalizeRel(join(dirname(fromPath), source));
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.jsx`,
    `${base}/index.js`,
    `${base}/index.ts`,
  ].map(normalizeRel);
  return candidates.find((candidate) => availablePaths.has(candidate)) || null;
}

function getImportSpecifiers(item) {
  if (Array.isArray(item.specifiers) && item.specifiers.length) {
    return item.specifiers;
  }
  return [{ imported: '*', local: '*', kind: safeString(item.kind, 40) || 'import' }];
}

function buildImportBinding(specifier, item, target) {
  const local = safeString(specifier.local, 120);
  const imported = safeString(specifier.imported || specifier.local, 120);
  if (!local || !imported) return null;
  return {
    local,
    imported,
    kind: safeString(specifier.kind, 40) || 'named',
    source: item.source,
    target,
    line: Math.max(1, Number(item.line) || 1),
  };
}

function importBindingsForFile(file, availablePaths) {
  const bindings = [];
  for (const item of file?.imports || []) {
    const target = resolveImportTarget(file.path, item.source, availablePaths);
    if (!target) continue;
    for (const specifier of getImportSpecifiers(item)) {
      const binding = buildImportBinding(specifier, item, target);
      if (binding) bindings.push(binding);
    }
  }
  return bindings;
}

function definitionsByPath(definitions = []) {
  const out = new Map();
  for (const definition of definitions || []) {
    const bucket = out.get(definition.path) || [];
    bucket.push(definition);
    out.set(definition.path, bucket);
  }
  return out;
}

function explicitExportsByPath(files = [], availablePaths) {
  const out = new Map();
  for (const file of files || []) {
    const items = [];
    for (const item of file.exports || []) {
      const source = safeString(item.source, 160);
      items.push({
        name: safeString(item.name, 120),
        local: safeString(item.local || item.name, 120),
        source,
        target: source ? resolveImportTarget(file.path, source, availablePaths) : null,
        kind: safeString(item.kind, 40) || 'named',
        line: Math.max(1, Number(item.line) || 1),
      });
    }
    out.set(file.path, items.filter((item) => item.name));
  }
  return out;
}

function definitionMatchesExport(definition, safeName) {
  if ((definition.exportNames || []).includes(safeName)) return true;
  if (safeName === 'default') return false;
  return Boolean(definition.exported) && definition.name === safeName;
}

function findDirectDefinitions(context, safePath, safeName) {
  const definitions = context.definitionsByPath.get(safePath) || [];
  return definitions.filter((definition) => definitionMatchesExport(definition, safeName));
}

function resolveExportItem(item, safeName, context, seen) {
  if (!item.target) return [];
  if (item.kind === 'all' || item.name === '*') {
    return resolveExportedDefinitions(item.target, safeName, context, seen);
  }
  if (item.name !== safeName) return [];
  return resolveExportedDefinitions(item.target, item.local, context, seen);
}

function followExportItems(context, safePath, safeName, seen) {
  const resolved = [];
  for (const item of context.exportsByPath.get(safePath) || []) {
    const next = resolveExportItem(item, safeName, context, seen);
    if (next.length) resolved.push(...next);
  }
  return resolved;
}

function resolveExportedDefinitions(path, exportName, context, seen = new Set()) {
  const safePath = normalizeRel(path);
  const safeName = safeString(exportName, 120);
  if (!safePath || !safeName) return [];
  const key = `${safePath}:${safeName}`;
  if (seen.has(key)) return [];
  seen.add(key);

  const direct = findDirectDefinitions(context, safePath, safeName);
  if (direct.length) return direct;
  return followExportItems(context, safePath, safeName, seen);
}

function definitionsForReference(name, file, context) {
  const matching = context.definitionsByName.get(name) || [];
  const local = matching.filter((definition) => definition.path === file.path);
  if (local.length) return local;
  const binding = (context.importBindingsByPath.get(file.path) || []).find((item) => item.local === name);
  if (binding?.target) {
    const imported = resolveExportedDefinitions(binding.target, binding.imported, context);
    if (imported.length) return imported;
    const importedByPath = matching.filter((definition) => definition.path === binding.target);
    if (importedByPath.length) return importedByPath;
  }
  if (matching.length <= 1) return matching;
  return [];
}

const UNRESOLVED_BLOCKED_KINDS = new Set(['dynamic-import', 'import', 'type-import']);

function isShortMemberKind(kind, name) {
  return kind.startsWith('member-') && name.length < 4;
}

function isShortConstantLikeName(name) {
  return /^[A-Z0-9_]+$/.test(name) && name.length <= 4;
}

function shouldTrackUnresolvedReference(item = {}) {
  const name = safeString(item.name || item.symbol, 120);
  if (!name || name.length < MIN_SYMBOL_LEN) return false;
  if (COMMON_SYMBOLS.has(name.toLowerCase())) return false;
  const kind = normalizeReferenceKind(item.kind);
  if (UNRESOLVED_BLOCKED_KINDS.has(kind)) return false;
  if (isShortMemberKind(kind, name)) return false;
  if (isShortConstantLikeName(name)) return false;
  return true;
}

function safeReferenceName(item = {}) {
  return safeString(item.name || item.symbol, 120);
}

function safeReferenceLine(item = {}) {
  return Math.max(1, Number(item.line) || 1);
}

function isSelfReference(definition, file, lineNumber) {
  return definition.path === file.path && definition.line === lineNumber;
}

function resolveDefinitionsFor(item, file, context) {
  const name = safeReferenceName(item);
  if (!name) return null;
  return definitionsForReference(name, file, context);
}

function recordUnresolvedReference(target, item, file) {
  if (!shouldTrackUnresolvedReference(item)) return;
  target.push({
    name: safeReferenceName(item),
    fromPath: file.path,
    line: safeReferenceLine(item),
    kind: normalizeReferenceKind(item.kind),
    text: safeString(item.text, 240),
    reason: 'no-local-definition',
  });
}

function recordResolvedReferences(target, item, definitions, file) {
  const lineNumber = safeReferenceLine(item);
  for (const definition of definitions) {
    if (isSelfReference(definition, file, lineNumber)) continue;
    target.push({
      symbolId: definition.id,
      symbol: definition.name,
      fromPath: file.path,
      toPath: definition.path,
      line: lineNumber,
      kind: normalizeReferenceKind(item.kind),
      text: safeString(item.text, 240),
    });
  }
}

function collectEvidenceReferenceLinks(context, file) {
  const refs = [];
  const unresolvedReferences = [];
  const astRefs = Array.isArray(file?.references) ? file.references : [];
  if (!astRefs.length) return { refs, unresolvedReferences };
  for (const item of astRefs) {
    const definitions = resolveDefinitionsFor(item, file, context);
    if (!definitions) continue;
    if (!definitions.length) {
      recordUnresolvedReference(unresolvedReferences, item, file);
      continue;
    }
    recordResolvedReferences(refs, item, definitions, file);
  }
  return { refs, unresolvedReferences };
}

function pushUniqueReferences(target, refs, seen, limit) {
  for (const ref of refs) {
    if (target.length >= limit) break;
    const key = `${ref.symbolId}:${ref.fromPath}:${ref.line}:${ref.kind}:${ref.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(ref);
  }
}

function pushUniqueUnresolvedReferences(target, refs, seen, limit) {
  for (const ref of refs) {
    if (target.length >= limit) break;
    const key = `${ref.name}:${ref.fromPath}:${ref.line}:${ref.kind}:${ref.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(ref);
  }
}

function routePathFromAnchor(anchor = {}) {
  const name = safeString(anchor.name, 200);
  const match = name.match(/(?:GET|POST|PUT|DELETE|PATCH)\s+(\/api\/\S+)/i) || name.match(/(\/api\/[^\s]+)/);
  return match ? match[1].replace(/[)"'`;]+$/g, '') : '';
}

function collectRoutes(evidence = []) {
  const routes = [];
  const seen = new Set();
  for (const file of evidence || []) {
    for (const anchor of file.anchors || []) {
      if (anchor.kind !== 'route') continue;
      const route = routePathFromAnchor(anchor);
      if (!route) continue;
      const id = `${file.path}:${route}:${Number(anchor.line) || 1}`;
      if (seen.has(id)) continue;
      seen.add(id);
      routes.push({
        id,
        route,
        path: file.path,
        line: Math.max(1, Number(anchor.line) || 1),
        kind: safeString(anchor.kind, 40) || 'api',
      });
    }
  }
  return routes;
}

function findRouteUsages(routes, file, text) {
  if (!routes.length || !text) return [];
  const lines = String(text || '').split(/\r?\n/);
  const usages = [];
  for (const route of routes) {
    lines.forEach((line, idx) => {
      if (!line.includes(route.route)) return;
      const lineNumber = idx + 1;
      const isDefinitionLine = route.path === file.path && route.line === lineNumber;
      if (isDefinitionLine) return;
      usages.push({
        routeId: route.id,
        route: route.route,
        fromPath: file.path,
        toPath: route.path,
        line: lineNumber,
        text: cleanLine(line),
      });
    });
  }
  return usages;
}

function isTestFile(file = {}) {
  const path = normalizeRel(file.path);
  if (/^tests\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) return true;
  return (file.anchors || []).some((anchor) => ['describe', 'it', 'test'].includes(anchor.kind));
}

function routeHandlerReferences(route, references = []) {
  return (references || []).filter((item) => (
    item.fromPath === route.path &&
    Math.abs((Number(item.line) || 1) - route.line) <= 3 &&
    ['call', 'reference', 'member-call', 'member-reference'].includes(item.kind)
  )).slice(0, 4);
}

function collectRouteTestChains(routes = [], routeUsages = [], references = [], files = []) {
  const filesByPath = new Map((files || []).map((file) => [file.path, file]));
  const chains = [];
  const seen = new Set();
  for (const route of routes || []) {
    const testUsages = filterRouteTestUsages(route, routeUsages, filesByPath);
    if (!testUsages.length) continue;
    const handlers = routeHandlerReferences(route, references);
    for (const usage of testUsages) {
      const id = `${route.id}:${usage.fromPath}:${usage.line}`;
      if (seen.has(id)) continue;
      seen.add(id);
      chains.push(buildRouteTestChain(route, usage, handlers, id));
      if (chains.length >= MAX_ROUTE_TEST_CHAINS) return chains;
    }
  }
  return chains;
}

function filterRouteTestUsages(route, routeUsages = [], filesByPath) {
  return (routeUsages || []).filter((usage) => (
    usage.routeId === route.id &&
    isTestFile(filesByPath.get(usage.fromPath) || { path: usage.fromPath })
  ));
}

function buildRouteTestChain(route, usage, handlers, id) {
  return {
    id,
    routeId: route.id,
    route: route.route,
    routePath: route.path,
    routeLine: route.line,
    testPath: usage.fromPath,
    testLine: usage.line,
    testText: usage.text,
    handlerSymbols: handlers.map(toHandlerSymbol),
    path: buildRouteTestChainSteps(route, usage, handlers),
  };
}

function buildRouteTestChainSteps(route, usage, handlers) {
  return [
    {
      kind: 'api-route',
      path: route.path,
      line: route.line,
      label: route.route,
    },
    ...handlers.map(toHandlerStep),
    {
      kind: 'test',
      path: usage.fromPath,
      line: usage.line,
      label: usage.text || usage.route,
    },
  ];
}

function toHandlerStep(handler) {
  return {
    kind: handler.kind === 'call' || handler.kind === 'member-call' ? 'handler-call' : 'handler-reference',
    path: handler.fromPath,
    line: handler.line,
    label: handler.symbol,
    toPath: handler.toPath,
  };
}

function toHandlerSymbol(handler) {
  return {
    symbol: handler.symbol,
    kind: handler.kind,
    path: handler.fromPath,
    line: handler.line,
    toPath: handler.toPath,
  };
}

/**
 * Normalizes a symbol graph input object into a standardized structure.
 * It extracts and validates definitions, references, routes, route usages,
 * route test chains, and unresolved references, applying size limits and
 * type normalization.
 *
 * @param {Object} [input={}] - The input graph object, which may contain
 *   symbolGraph, codeContextGraph, or graph properties.
 * @returns {Object} A normalized symbol graph object with counts and arrays
 *   of definitions, references, routes, routeUsages, routeTestChains, and
 *   unresolvedReferences.
 */
export function normalizeSymbolGraph(input = {}) {
  const graph = input && typeof input === 'object'
    ? (input.symbolGraph || input.codeContextGraph || input.graph || input)
    : {};
  const definitions = Array.isArray(graph.definitions) ? graph.definitions.map((item) => ({
    id: safeString(item.id, 260),
    name: safeString(item.name, 120),
    type: safeString(item.type, 40) || 'symbol',
    path: normalizeRel(item.path),
    line: Math.max(1, Number(item.line) || 1),
    exported: !!item.exported,
    owner: safeString(item.owner, 120),
    ownerType: safeString(item.ownerType, 40),
    exportNames: Array.isArray(item.exportNames) ? item.exportNames.map((name) => safeString(name, 120)).filter(Boolean).slice(0, 8) : [],
    referenceCount: Math.max(0, Number(item.referenceCount) || 0),
    callCount: Math.max(0, Number(item.callCount) || 0),
  })).filter((item) => item.id && item.name && item.path).slice(0, MAX_SYMBOLS) : [];
  const references = Array.isArray(graph.references) ? graph.references.map((item) => ({
    symbolId: safeString(item.symbolId, 260),
    symbol: safeString(item.symbol, 120),
    fromPath: normalizeRel(item.fromPath),
    toPath: normalizeRel(item.toPath),
    line: Math.max(1, Number(item.line) || 1),
    kind: safeString(item.kind, 40) || 'reference',
    text: safeString(item.text, 240),
  })).filter((item) => item.symbolId && item.fromPath && item.toPath).slice(0, MAX_REFERENCES) : [];
  const routes = Array.isArray(graph.routes) ? graph.routes.map((item) => ({
    id: safeString(item.id, 260),
    route: safeString(item.route, 160),
    path: normalizeRel(item.path),
    line: Math.max(1, Number(item.line) || 1),
    kind: safeString(item.kind, 40) || 'api',
    usageCount: Math.max(0, Number(item.usageCount) || 0),
  })).filter((item) => item.id && item.route && item.path).slice(0, MAX_SYMBOLS) : [];
  const routeUsages = Array.isArray(graph.routeUsages) ? graph.routeUsages.map((item) => ({
    routeId: safeString(item.routeId, 260),
    route: safeString(item.route, 160),
    fromPath: normalizeRel(item.fromPath),
    toPath: normalizeRel(item.toPath),
    line: Math.max(1, Number(item.line) || 1),
    text: safeString(item.text, 240),
  })).filter((item) => item.routeId && item.fromPath && item.toPath).slice(0, MAX_ROUTE_USAGES) : [];
  const routeTestChains = Array.isArray(graph.routeTestChains) ? graph.routeTestChains.map((item) => ({
    id: safeString(item.id, 320),
    routeId: safeString(item.routeId, 260),
    route: safeString(item.route, 160),
    routePath: normalizeRel(item.routePath),
    routeLine: Math.max(1, Number(item.routeLine) || 1),
    testPath: normalizeRel(item.testPath),
    testLine: Math.max(1, Number(item.testLine) || 1),
    testText: safeString(item.testText, 240),
    handlerSymbols: Array.isArray(item.handlerSymbols) ? item.handlerSymbols.map((handler) => ({
      symbol: safeString(handler.symbol, 120),
      kind: safeString(handler.kind, 40),
      path: normalizeRel(handler.path),
      line: Math.max(1, Number(handler.line) || 1),
      toPath: normalizeRel(handler.toPath),
    })).filter((handler) => handler.symbol && handler.path).slice(0, 6) : [],
    path: Array.isArray(item.path) ? item.path.map((step) => ({
      kind: safeString(step.kind, 60),
      path: normalizeRel(step.path),
      line: Math.max(1, Number(step.line) || 1),
      label: safeString(step.label, 160),
      toPath: normalizeRel(step.toPath),
    })).filter((step) => step.kind && step.path).slice(0, 8) : [],
  })).filter((item) => item.id && item.route && item.routePath && item.testPath).slice(0, MAX_ROUTE_TEST_CHAINS) : [];
  const unresolvedReferences = Array.isArray(graph.unresolvedReferences) ? graph.unresolvedReferences.map((item) => ({
    name: safeString(item.name || item.symbol, 120),
    fromPath: normalizeRel(item.fromPath),
    line: Math.max(1, Number(item.line) || 1),
    kind: safeString(item.kind, 40) || 'reference',
    text: safeString(item.text, 240),
    reason: safeString(item.reason, 100) || 'unresolved',
  })).filter((item) => item.name && item.fromPath).slice(0, MAX_UNRESOLVED_REFERENCES) : [];
  return {
    definitionCount: Math.max(definitions.length, Number(graph.definitionCount) || 0),
    referenceCount: Math.max(references.length, Number(graph.referenceCount) || 0),
    callCount: Math.max(references.filter((item) => item.kind === 'call').length, Number(graph.callCount) || 0),
    typeImplementationCount: Math.max(references.filter((item) => item.kind === 'type-implementation').length, Number(graph.typeImplementationCount) || 0),
    routeCount: Math.max(routes.length, Number(graph.routeCount) || 0),
    routeUsageCount: Math.max(routeUsages.length, Number(graph.routeUsageCount) || 0),
    routeToTestChainCount: Math.max(routeTestChains.length, Number(graph.routeToTestChainCount) || 0),
    unresolvedReferenceCount: Math.max(unresolvedReferences.length, Number(graph.unresolvedReferenceCount) || 0),
    definitions,
    references,
    routes,
    routeUsages,
    routeTestChains,
    unresolvedReferences,
  };
}

/**
 * Summarizes a symbol graph by normalizing it and extracting top items
 * based on reference counts, usage counts, and other metrics.
 *
 * @param {Object} [input={}] - The input graph object to summarize.
 * @returns {Object} A summary object containing counts and arrays of top
 *   definitions, references, type implementations, routes, route usages,
 *   route test chains, and unresolved references.
 */
export function summarizeSymbolGraph(input = {}) {
  const graph = normalizeSymbolGraph(input);
  return {
    definitionCount: graph.definitionCount,
    referenceCount: graph.referenceCount,
    callCount: graph.callCount,
    typeImplementationCount: graph.typeImplementationCount,
    routeCount: graph.routeCount,
    routeUsageCount: graph.routeUsageCount,
    routeToTestChainCount: graph.routeToTestChainCount,
    unresolvedReferenceCount: graph.unresolvedReferenceCount,
    topDefinitions: [...graph.definitions]
      .sort((a, b) => (b.referenceCount + b.callCount) - (a.referenceCount + a.callCount) || a.name.localeCompare(b.name))
      .slice(0, 10),
    topReferences: graph.references.slice(0, 12),
    topTypeImplementations: graph.references.filter((item) => item.kind === 'type-implementation').slice(0, 12),
    topRoutes: [...graph.routes].sort((a, b) => b.usageCount - a.usageCount || a.route.localeCompare(b.route)).slice(0, 10),
    topRouteUsages: graph.routeUsages.slice(0, 12),
    topRouteTestChains: graph.routeTestChains.slice(0, 12),
    topUnresolvedReferences: graph.unresolvedReferences.slice(0, 12),
  };
}

function definitionsByOwner(definitions = []) {
  const out = new Map();
  for (const definition of definitions || []) {
    if (!definition.owner) continue;
    const key = `${definition.path}:${definition.owner}`;
    const bucket = out.get(key) || [];
    bucket.push(definition);
    out.set(key, bucket);
  }
  return out;
}

function referencesNearLine(file, classDefinition) {
  return (file?.references || []).filter((item) => (
    item.kind === 'type-implements' &&
    Math.abs((Number(item.line) || 1) - classDefinition.line) <= 2
  ));
}

function collectTypeImplementationReferences(context, file) {
  const refs = [];
  const localDefinitions = context.definitionsByPath.get(file.path) || [];
  const classes = localDefinitions.filter((definition) => definition.type === 'class');
  if (!classes.length) return refs;
  const ownerDefinitions = context.definitionsByOwner;

  for (const classDefinition of classes) {
    const classMethods = (ownerDefinitions.get(`${file.path}:${classDefinition.name}`) || [])
      .filter((definition) => definition.type === 'method');
    if (!classMethods.length) continue;

    for (const implementRef of referencesNearLine(file, classDefinition)) {
      const interfaceDefinitions = definitionsForReference(implementRef.name, file, context)
        .filter((definition) => ['interface', 'type'].includes(definition.type));
      for (const interfaceDefinition of interfaceDefinitions) {
        const contractMethods = (ownerDefinitions.get(`${interfaceDefinition.path}:${interfaceDefinition.name}`) || [])
          .filter((definition) => definition.type === 'type-method');
        for (const classMethod of classMethods) {
          const contractMethod = contractMethods.find((definition) => definition.name === classMethod.name);
          if (!contractMethod) continue;
          refs.push({
            symbolId: contractMethod.id,
            symbol: contractMethod.name,
            fromPath: classMethod.path,
            toPath: contractMethod.path,
            line: classMethod.line,
            kind: 'type-implementation',
            text: `${classDefinition.name}.${classMethod.name} implements ${interfaceDefinition.name}.${contractMethod.name}`,
          });
        }
      }
    }
  }
  return refs;
}

/**
 * Indexes definitions by their `name` so reference collection can resolve
 * symbols in O(1).
 * @param {Array<Object>} definitions
 * @returns {Map<string, Array<Object>>}
 */
function indexDefinitionsByName(definitions) {
  const definitionsByName = new Map();
  for (const definition of definitions) {
    const bucket = definitionsByName.get(definition.name) || [];
    bucket.push(definition);
    definitionsByName.set(definition.name, bucket);
  }
  return definitionsByName;
}

/**
 * Reads the text content of every evidence file once into a map keyed by
 * path so per-file processing does not have to hit the file system again.
 * @param {string|undefined} cwd
 * @param {Array<Object>} files
 * @param {Object} fsApi
 * @returns {Map<string, string>}
 */
function readEvidenceTexts(cwd, files, fsApi) {
  const textByPath = new Map();
  for (const file of files) {
    textByPath.set(file.path, readProjectFile(cwd, file.path, fsApi));
  }
  return textByPath;
}

/**
 * Collects references (and unresolved references) for a single evidence
 * file, dispatching between AST-based parsers (`acorn` / `babel`) and
 * plain-text parsers.
 * @param {Object} context
 * @param {Array<Object>} definitions
 * @param {Object} file
 * @param {string} text
 * @param {Array<Object>} references
 * @param {Array<Object>} unresolvedReferences
 * @param {Set<string>} seenReferences
 * @param {Set<string>} seenUnresolvedReferences
 */
function collectReferencesForFile(
  context,
  definitions,
  file,
  text,
  references,
  unresolvedReferences,
  seenReferences,
  seenUnresolvedReferences,
) {
  if (file.parser === 'acorn' || file.parser === 'babel') {
    const referenceLinks = collectEvidenceReferenceLinks(context, file);
    pushUniqueReferences(
      references,
      [
        ...referenceLinks.refs,
        ...collectTypeImplementationReferences(context, file),
      ],
      seenReferences,
      MAX_REFERENCES,
    );
    pushUniqueUnresolvedReferences(
      unresolvedReferences,
      referenceLinks.unresolvedReferences,
      seenUnresolvedReferences,
      MAX_UNRESOLVED_REFERENCES,
    );
    return;
  }
  for (const definition of definitions) {
    if (references.length >= MAX_REFERENCES) break;
    pushUniqueReferences(
      references,
      findReferencesForDefinition(definition, file, text),
      seenReferences,
      MAX_REFERENCES,
    );
  }
}

/**
 * Appends route usages discovered in a single file, capped by
 * `MAX_ROUTE_USAGES` overall.
 * @param {Array<Object>} routes
 * @param {Object} file
 * @param {string} text
 * @param {Array<Object>} routeUsages
 */
function collectRouteUsagesForFile(routes, file, text, routeUsages) {
  if (routeUsages.length >= MAX_ROUTE_USAGES) return;
  routeUsages.push(
    ...findRouteUsages(routes, file, text).slice(0, MAX_ROUTE_USAGES - routeUsages.length),
  );
}

/**
 * Tallies reference and call counts per symbol across the collected
 * references.
 * @param {Array<Object>} references
 * @returns {{referenceCountBySymbol: Map<string, number>, callCountBySymbol: Map<string, number>}}
 */
function countReferencesBySymbol(references) {
  const referenceCountBySymbol = new Map();
  const callCountBySymbol = new Map();
  for (const ref of references) {
    referenceCountBySymbol.set(ref.symbolId, (referenceCountBySymbol.get(ref.symbolId) || 0) + 1);
    if (ref.kind === 'call') {
      callCountBySymbol.set(ref.symbolId, (callCountBySymbol.get(ref.symbolId) || 0) + 1);
    }
  }
  return { referenceCountBySymbol, callCountBySymbol };
}

/**
 * Tallies usage counts per route across the collected route usages.
 * @param {Array<Object>} routeUsages
 * @returns {Map<string, number>}
 */
function countUsagesByRoute(routeUsages) {
  const usageCountByRoute = new Map();
  for (const usage of routeUsages) {
    usageCountByRoute.set(usage.routeId, (usageCountByRoute.get(usage.routeId) || 0) + 1);
  }
  return usageCountByRoute;
}

/**
 * Builds a symbol graph from a set of evidence files.
 * It collects definitions, references, routes, and route usages, then
 * normalizes the result into a standardized graph structure.
 *
 * @param {Object} [options={}] - The build options.
 * @param {string} [options.cwd] - The current working directory.
 * @param {Array<Object>} [options.evidence=[]] - An array of file evidence
 *   objects containing path, parser, and other metadata.
 * @param {Object} [options.fsApi={}] - A custom file system API for reading
 *   files.
 * @returns {Object} A normalized symbol graph object.
 */
export function buildSymbolGraph({ cwd, evidence = [], fsApi = {} } = {}) {
  const files = Array.isArray(evidence) ? evidence : [];
  const definitions = collectDefinitions(files);
  const definitionsByName = indexDefinitionsByName(definitions);
  const availablePaths = new Set(files.map((file) => file.path));
  const context = {
    definitionsByName,
    definitionsByPath: definitionsByPath(definitions),
    exportsByPath: explicitExportsByPath(files, availablePaths),
    importBindingsByPath: new Map(files.map((file) => [file.path, importBindingsForFile(file, availablePaths)])),
  };
  context.definitionsByOwner = definitionsByOwner(definitions);
  const routes = collectRoutes(files);
  const references = [];
  const routeUsages = [];
  const unresolvedReferences = [];
  const seenReferences = new Set();
  const seenUnresolvedReferences = new Set();
  const textByPath = readEvidenceTexts(cwd, files, fsApi);

  for (const file of files) {
    const text = textByPath.get(file.path) || '';
    collectReferencesForFile(
      context,
      definitions,
      file,
      text,
      references,
      unresolvedReferences,
      seenReferences,
      seenUnresolvedReferences,
    );
    collectRouteUsagesForFile(routes, file, text, routeUsages);
  }

  const routeTestChains = collectRouteTestChains(routes, routeUsages, references, files);
  const { referenceCountBySymbol, callCountBySymbol } = countReferencesBySymbol(references);
  const usageCountByRoute = countUsagesByRoute(routeUsages);

  return normalizeSymbolGraph({
    definitions: definitions.map((definition) => ({
      ...definition,
      referenceCount: referenceCountBySymbol.get(definition.id) || 0,
      callCount: callCountBySymbol.get(definition.id) || 0,
    })),
    references,
    routes: routes.map((route) => ({
      ...route,
      usageCount: usageCountByRoute.get(route.id) || 0,
    })),
    routeUsages,
    routeTestChains,
    unresolvedReferences,
  });
}
