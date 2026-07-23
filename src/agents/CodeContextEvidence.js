import { existsSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { defaultParserRegistry } from './parsers/ParserRegistry.js';
import { CODEBASE_LIMITS } from './codebaseLimits.js';

// 与 codebaseLimits 同源（C3 续）：上限可经 ~/.noe-panel/codebase-limits.json 统一覆盖
const MAX_EVIDENCE_FILES = CODEBASE_LIMITS.maxFocusFiles;
const MAX_FILE_BYTES = CODEBASE_LIMITS.maxFileBytes;
const MAX_SYMBOLS_PER_FILE = 16;
const MAX_IMPORTS_PER_FILE = 18;
const MAX_EXPORTS_PER_FILE = 18;
const MAX_ANCHORS_PER_FILE = 18;
const MAX_SNIPPETS_PER_FILE = 10;
const MAX_REFERENCES_PER_FILE = 120;
const MAX_DIAGNOSTICS_PER_FILE = 5;
const TEXT_EXTENSIONS = new Set([
  '.cjs', '.css', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.scss', '.ts', '.tsx', '.txt',
]);

function safeString(value, max = 4000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function compactPath(value) {
  let text = safeString(value, 300);
  if (!text) return '';
  text = text.replace(/^[ MADRCU?!]{1,3}\s+/, '').trim();
  if (text.includes(' -> ')) text = text.split(' -> ').pop().trim();
  return text.replace(/\\/g, '/').replace(/^\/+/, '');
}

function extensionOf(path = '') {
  const idx = path.lastIndexOf('.');
  return idx >= 0 ? path.slice(idx).toLowerCase() : '';
}

function detectLanguage(path = '') {
  const ext = extensionOf(path);
  if (['.js', '.mjs', '.cjs'].includes(ext)) return 'javascript';
  if (['.ts', '.tsx'].includes(ext)) return 'typescript';
  if (ext === '.jsx') return 'javascript';
  if (ext === '.css' || ext === '.scss') return 'css';
  if (ext === '.html') return 'html';
  if (ext === '.md' || ext === '.mdx') return 'markdown';
  if (ext === '.json') return 'json';
  return ext ? ext.slice(1) : 'text';
}

function isTextLike(path = '') {
  const ext = extensionOf(path);
  return TEXT_EXTENSIONS.has(ext) || /(^|\/)(Dockerfile|LICENSE|README)$/i.test(path);
}

function safeProjectFile(cwd, inputPath) {
  const displayPath = compactPath(inputPath);
  if (!cwd || !displayPath || !isTextLike(displayPath)) return null;
  const root = resolve(cwd);
  const abs = resolve(root, displayPath);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || rel.includes('\0') || rel.startsWith('/')) return null;
  return { abs, rel: rel.replace(/\\/g, '/') };
}

function pushLimited(list, item, limit, keyFn = null) {
  if (!item || list.length >= limit) return;
  if (keyFn) {
    const key = keyFn(item);
    if (key && list.some((existing) => keyFn(existing) === key)) return;
  }
  list.push(item);
}

function cleanSnippet(line = '') {
  return line.replace(/\s+/g, ' ').trim().slice(0, 220);
}

function addSnippet(snippets, line, lineNumber, reason) {
  const text = cleanSnippet(line);
  if (!text || text.length < 4) return;
  pushLimited(snippets, { line: lineNumber, reason, text }, MAX_SNIPPETS_PER_FILE, (item) => `${item.line}:${item.reason}`);
}

const SYMBOL_PATTERNS = [
  { type: 'function', re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/ },
  { type: 'class', re: /^\s*(?:export\s+default\s+)?class\s+([A-Za-z_$][\w$]*)\b/ },
  { type: 'const', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/ },
  { type: 'const', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/ },
];

function extractSymbols(line, lineNumber, symbols, exports, snippets) {
  for (const pattern of SYMBOL_PATTERNS) {
    const match = line.match(pattern.re);
    if (!match) continue;
    pushLimited(symbols, {
      name: match[1],
      type: pattern.type,
      line: lineNumber,
      exported: /\bexport\b/.test(line),
    }, MAX_SYMBOLS_PER_FILE, (item) => `${item.type}:${item.name}`);
    if (/\bexport\b/.test(line)) {
      pushLimited(exports, {
        name: match[1],
        local: match[1],
        kind: 'named',
        line: lineNumber,
      }, MAX_EXPORTS_PER_FILE, (item) => `${item.kind}:${item.name}:${item.local}:${item.line}`);
    }
    addSnippet(snippets, line, lineNumber, 'symbol');
    return;
  }
}

function extractImports(line, lineNumber, imports, snippets) {
  const dynamicImportMatch = line.match(/\bimport\(\s*['"`]([^'"`]+)['"`]\s*\)/);
  if (dynamicImportMatch) {
    pushLimited(imports, {
      source: dynamicImportMatch[1],
      line: lineNumber,
      kind: 'dynamic-import',
      specifiers: [{ imported: '*', local: 'import', kind: 'dynamic' }],
    }, MAX_IMPORTS_PER_FILE, (item) => `${item.kind || 'import'}:${item.source}`);
    addSnippet(snippets, line, lineNumber, 'dynamic-import');
    return;
  }
  const importMatch = line.match(/^\s*import\s+(?:.+?\s+from\s+)?['"]([^'"]+)['"]/) ||
    line.match(/^\s*export\s+.+?\s+from\s+['"]([^'"]+)['"]/) ||
    line.match(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/);
  if (importMatch) {
    pushLimited(imports, { source: importMatch[1], line: lineNumber }, MAX_IMPORTS_PER_FILE, (item) => item.source);
    addSnippet(snippets, line, lineNumber, 'import');
  }
}

function extractExportFrom(line, lineNumber, exports) {
  const exportFromMatch = line.match(/^\s*export\s+(?:\{([^}]+)\}|\*)\s+from\s+['"]([^'"]+)['"]/);
  if (!exportFromMatch) return;
  const source = exportFromMatch[2];
  const names = exportFromMatch[1]
    ? exportFromMatch[1].split(',').map((part) => part.trim()).filter(Boolean)
    : ['*'];
  for (const part of names) {
    const aliasMatch = part.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
    const local = aliasMatch ? aliasMatch[1] : part;
    const name = aliasMatch?.[2] || local;
    pushLimited(exports, {
      name,
      local,
      source,
      kind: part === '*' ? 'all' : 're-export',
      line: lineNumber,
    }, MAX_EXPORTS_PER_FILE, (item) => `${item.kind}:${item.name}:${item.local}:${item.source}:${item.line}`);
  }
}

function extractJsLike(lines) {
  const symbols = [];
  const imports = [];
  const exports = [];
  const anchors = [];
  const snippets = [];

  lines.forEach((line, idx) => {
    const lineNumber = idx + 1;
    extractSymbols(line, lineNumber, symbols, exports, snippets);
    extractImports(line, lineNumber, imports, snippets);
    extractExportFrom(line, lineNumber, exports);

    const routeMatch = line.match(/\bapp\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/);
    if (routeMatch) {
      pushLimited(anchors, { kind: 'route', name: `${routeMatch[1].toUpperCase()} ${routeMatch[2]}`, line: lineNumber }, MAX_ANCHORS_PER_FILE, (item) => `${item.kind}:${item.name}`);
      addSnippet(snippets, line, lineNumber, 'route');
    }

    const testMatch = line.match(/\b(describe|it|test)\(\s*['"`]([^'"`]+)['"`]/);
    if (testMatch) {
      pushLimited(anchors, { kind: testMatch[1], name: testMatch[2].slice(0, 120), line: lineNumber }, MAX_ANCHORS_PER_FILE, (item) => `${item.kind}:${item.name}`);
      addSnippet(snippets, line, lineNumber, 'test');
    }

    const apiMatch = line.match(/['"`](\/api\/[^'"`\s)]+)['"`]/);
    if (apiMatch) {
      pushLimited(anchors, { kind: 'api', name: apiMatch[1], line: lineNumber }, MAX_ANCHORS_PER_FILE, (item) => `${item.kind}:${item.name}`);
    }
  });

  return { parser: 'regex', diagnostics: [], symbols, imports, exports, anchors, snippets, references: [] };
}

function extractCss(lines) {
  const anchors = [];
  const snippets = [];
  lines.forEach((line, idx) => {
    const match = line.match(/^\s*([.#][A-Za-z0-9_-][^{,\s]*)\s*[{,]/);
    if (!match) return;
    pushLimited(anchors, { kind: 'selector', name: match[1], line: idx + 1 }, MAX_ANCHORS_PER_FILE, (item) => item.name);
    addSnippet(snippets, line, idx + 1, 'selector');
  });
  return { symbols: [], imports: [], anchors, snippets };
}

function extractHtml(lines) {
  const anchors = [];
  const snippets = [];
  lines.forEach((line, idx) => {
    const idMatch = line.match(/\bid=["']([^"']+)["']/);
    if (!idMatch) return;
    pushLimited(anchors, { kind: 'dom-id', name: `#${idMatch[1]}`, line: idx + 1 }, MAX_ANCHORS_PER_FILE, (item) => item.name);
    addSnippet(snippets, line, idx + 1, 'dom-id');
  });
  return { symbols: [], imports: [], anchors, snippets };
}

function extractMarkdown(lines) {
  const anchors = [];
  const snippets = [];
  lines.forEach((line, idx) => {
    const match = line.match(/^(#{1,4})\s+(.+)$/);
    if (!match) return;
    pushLimited(anchors, { kind: 'heading', name: match[2].slice(0, 140), line: idx + 1 }, MAX_ANCHORS_PER_FILE, (item) => item.name);
    addSnippet(snippets, line, idx + 1, 'heading');
  });
  return { symbols: [], imports: [], anchors, snippets };
}

function extractEvidence(path, text) {
  const language = detectLanguage(path);
  const lines = String(text || '').split(/\r?\n/);
  const ext = extensionOf(path);
  const astAdapter = defaultParserRegistry.getAdapter(ext);
  if (['javascript', 'typescript'].includes(language) && astAdapter) {
    const ast = astAdapter.parse({ path, text });
    if (ast.ok) return { language, ...ast };
    return { language, ...extractJsLike(lines), diagnostics: ast.diagnostics || [] };
  }
  if (['javascript', 'typescript'].includes(language)) return { language, ...extractJsLike(lines) };
  if (language === 'css') return { language, parser: 'selector-regex', diagnostics: [], references: [], ...extractCss(lines) };
  if (language === 'html') return { language, parser: 'dom-regex', diagnostics: [], references: [], ...extractHtml(lines) };
  if (language === 'markdown') return { language, parser: 'heading-regex', diagnostics: [], references: [], ...extractMarkdown(lines) };
  return { language, parser: 'none', diagnostics: [], symbols: [], imports: [], anchors: [], snippets: [], references: [] };
}

function sanitizeEvidenceFile(input = {}) {
  const path = compactPath(input.path || input.file || input.relativePath);
  if (!path) return null;
  return {
    path,
    language: safeString(input.language || detectLanguage(path), 40),
    parser: safeString(input.parser, 40) || 'unknown',
    exists: input.exists !== false,
    bytes: Math.max(0, Number(input.bytes) || 0),
    lineCount: Math.max(0, Number(input.lineCount) || 0),
    diagnostics: Array.isArray(input.diagnostics) ? input.diagnostics.slice(0, MAX_DIAGNOSTICS_PER_FILE).map((item) => ({
      code: safeString(item.code, 80) || 'diagnostic',
      message: safeString(item.message, 240),
      line: Math.max(1, Number(item.line) || 1),
      column: Math.max(0, Number(item.column) || 0),
    })).filter((item) => item.message || item.code) : [],
    symbols: Array.isArray(input.symbols) ? input.symbols.slice(0, MAX_SYMBOLS_PER_FILE).map((item) => ({
      name: safeString(item.name, 120),
      type: safeString(item.type, 40) || 'symbol',
      line: Math.max(1, Number(item.line) || 1),
      exported: !!item.exported,
      owner: safeString(item.owner, 120),
      ownerType: safeString(item.ownerType, 40),
    })).filter((item) => item.name) : [],
    imports: Array.isArray(input.imports) ? input.imports.slice(0, MAX_IMPORTS_PER_FILE).map((item) => ({
      source: safeString(item.source, 160),
      line: Math.max(1, Number(item.line) || 1),
      kind: safeString(item.kind, 40) || 'import',
      specifiers: Array.isArray(item.specifiers) ? item.specifiers.slice(0, 12).map((specifier) => ({
        imported: safeString(specifier.imported, 120),
        local: safeString(specifier.local, 120),
        kind: safeString(specifier.kind, 40) || 'named',
      })).filter((specifier) => specifier.imported || specifier.local) : [],
    })).filter((item) => item.source) : [],
    exports: Array.isArray(input.exports) ? input.exports.slice(0, MAX_EXPORTS_PER_FILE).map((item) => ({
      name: safeString(item.name, 120),
      local: safeString(item.local || item.name, 120),
      source: safeString(item.source, 160),
      kind: safeString(item.kind, 40) || 'named',
      line: Math.max(1, Number(item.line) || 1),
    })).filter((item) => item.name) : [],
    anchors: Array.isArray(input.anchors) ? input.anchors.slice(0, MAX_ANCHORS_PER_FILE).map((item) => ({
      kind: safeString(item.kind, 40) || 'anchor',
      name: safeString(item.name, 180),
      line: Math.max(1, Number(item.line) || 1),
    })).filter((item) => item.name) : [],
    snippets: Array.isArray(input.snippets) ? input.snippets.slice(0, MAX_SNIPPETS_PER_FILE).map((item) => ({
      line: Math.max(1, Number(item.line) || 1),
      reason: safeString(item.reason, 40) || 'evidence',
      text: safeString(item.text, 240),
    })).filter((item) => item.text) : [],
    references: Array.isArray(input.references) ? input.references.slice(0, MAX_REFERENCES_PER_FILE).map((item) => ({
      name: safeString(item.name || item.symbol, 120),
      kind: safeString(item.kind, 40) || 'reference',
      line: Math.max(1, Number(item.line) || 1),
      text: safeString(item.text, 240),
    })).filter((item) => item.name) : [],
  };
}

/**
 * Normalizes input into a list of sanitized code context evidence files.
 * Deduplicates by file path (case-insensitive) and limits to MAX_EVIDENCE_FILES.
 *
 * @param {Object|Object[]} input - The input evidence object or array of evidence objects.
 * @returns {Object[]} An array of normalized evidence file objects.
 */
export function normalizeCodeContextEvidence(input = {}) {
  const source = input && typeof input === 'object'
    ? (input.codeContextEvidence || input.evidence || input.files || input)
    : input;
  const list = Array.isArray(source) ? source : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const file = sanitizeEvidenceFile(item);
    if (!file || seen.has(file.path.toLowerCase())) continue;
    seen.add(file.path.toLowerCase());
    out.push(file);
    if (out.length >= MAX_EVIDENCE_FILES) break;
  }
  return out;
}

/**
 * Builds a single code context evidence file object from a path and optional metadata.
 * Reads the file, extracts evidence (symbols, anchors, snippets, references), and sanitizes it.
 *
 * @param {Object} options - The build options.
 * @param {string} options.cwd - The current working directory for resolving relative paths.
 * @param {string|Object} options.file - The file path string or an object with a 'path' property.
 * @param {Object} [options.fsApi={}] - Optional custom filesystem API (existsSync, statSync, readFileSync).
 * @param {string|null} [options.text=null] - Optional pre-read file content. If null, reads from disk.
 * @param {Object|null} [options.meta=null] - Optional pre-read file stat metadata. If null, reads from disk.
 * @returns {Object|null} The sanitized evidence file object, or null if the path is invalid.
 */
function buildBaseEvidenceRecord(resolved) {
  return {
    path: resolved.rel,
    language: detectLanguage(resolved.rel),
    exists: false,
    bytes: 0,
    lineCount: 0,
    parser: 'unknown',
    diagnostics: [],
    symbols: [],
    imports: [],
    exports: [],
    anchors: [],
    snippets: [],
    references: [],
  };
}

function resolveFsOperations(fsApi) {
  return {
    exists: fsApi.existsSync || existsSync,
    stat: fsApi.statSync || statSync,
    read: fsApi.readFileSync || readFileSync,
  };
}

function finalizeEvidenceRecord(record, base) {
  return normalizeCodeContextEvidence([record])[0] || base;
}

function readEvidenceText({ providedText, read, resolved }) {
  if (providedText === null || providedText === undefined) {
    return read(resolved.abs, 'utf8');
  }
  return providedText;
}

function readEvidenceMeta({ providedMeta, stat, resolved }) {
  return providedMeta || stat(resolved.abs);
}

function isFileReadable(meta) {
  return meta.isFile() && meta.size <= MAX_FILE_BYTES;
}

function countEvidenceLines(text) {
  return String(text || '').split(/\r?\n/).length;
}

function buildEvidenceErrorRecord(base, error) {
  return {
    ...base,
    error: safeString(error?.message || String(error), 200),
  };
}

/**
 * Builds a single code context evidence record for the given file.
 * Resolves the path safely against the project root, reads metadata and text
 * (or uses provided values when supplied), extracts evidence, and finalizes
 * the record. Returns null when the file cannot be resolved within the project.
 *
 * @param {Object} options - The build options.
 * @param {string} options.cwd - The current working directory used to resolve relative paths.
 * @param {string|Object} options.file - A file path string or an object with a `path` property.
 * @param {Object} [options.fsApi={}] - Optional custom filesystem API providing exists/stat/read.
 * @param {string|null} [options.text=null] - Optional pre-read file text to skip the filesystem read.
 * @param {Object|null} [options.meta=null] - Optional pre-read file metadata to skip the filesystem stat.
 * @returns {Object|null} The finalized evidence record, or null when the path is not a project file.
 */
export function buildCodeContextEvidenceFile({ cwd, file, fsApi = {}, text: providedText = null, meta: providedMeta = null } = {}) {
  const itemPath = typeof file === 'string' ? file : file?.path;
  const resolved = safeProjectFile(cwd, itemPath);
  if (!resolved) return null;
  const base = buildBaseEvidenceRecord(resolved);
  const fs = resolveFsOperations(fsApi);

  try {
    if (!fs.exists(resolved.abs)) {
      return finalizeEvidenceRecord({ ...base }, base);
    }
    const meta = readEvidenceMeta({ providedMeta, stat: fs.stat, resolved });
    if (!isFileReadable(meta)) {
      return finalizeEvidenceRecord({ ...base, exists: meta.isFile(), bytes: meta.size }, base);
    }
    const text = readEvidenceText({ providedText, read: fs.read, resolved });
    const extracted = extractEvidence(resolved.rel, text);
    return finalizeEvidenceRecord({
      ...base,
      ...extracted,
      exists: true,
      bytes: meta.size,
      lineCount: countEvidenceLines(text),
    }, base);
  } catch (e) {
    return finalizeEvidenceRecord(buildEvidenceErrorRecord(base, e), base);
  }
}

/**
 * Builds code context evidence for a list of files.
 * Resolves paths, extracts evidence for each file, and normalizes the result.
 *
 * @param {Object} options - The build options.
 * @param {string} options.cwd - The current working directory for resolving relative paths.
 * @param {string[]|Object[]} options.files - An array of file paths or objects with 'path' properties.
 * @param {Object} [options.fsApi={}] - Optional custom filesystem API.
 * @returns {Object[]} An array of normalized evidence file objects.
 */
export function buildCodeContextEvidence({ cwd, files = [], fsApi = {} } = {}) {
  const evidence = [];
  const seen = new Set();
  for (const file of files || []) {
    const itemPath = typeof file === 'string' ? file : file?.path;
    const resolved = safeProjectFile(cwd, itemPath);
    if (!resolved || seen.has(resolved.rel.toLowerCase())) continue;
    seen.add(resolved.rel.toLowerCase());
    const fileEvidence = buildCodeContextEvidenceFile({ cwd, file: resolved.rel, fsApi });
    if (fileEvidence) evidence.push(fileEvidence);

    if (evidence.length >= MAX_EVIDENCE_FILES) break;
  }

  return normalizeCodeContextEvidence(evidence);
}

function accumulateEvidenceItems(file, buckets) {
  for (const key of Object.keys(buckets)) {
    for (const item of file[key] || []) buckets[key].push({ ...item, path: file.path });
  }
}

function recordParserUsage(file, parsers) {
  const parser = file.parser || 'unknown';
  parsers.set(parser, (parsers.get(parser) || 0) + 1);
}

/**
 * Summarizes code context evidence by aggregating counts and top items across all files.
 *
 * @param {Object|Object[]} input - The input evidence object or array of evidence objects.
 * @returns {Object} A summary object containing counts and top 12 items for symbols, anchors, imports, exports, and references.
 */
export function summarizeCodeContextEvidence(input = {}) {
  const evidence = normalizeCodeContextEvidence(input);
  const buckets = { symbols: [], anchors: [], imports: [], exports: [], references: [] };
  const parsers = new Map();
  for (const file of evidence) {
    accumulateEvidenceItems(file, buckets);
    recordParserUsage(file, parsers);
  }
  return {
    fileCount: evidence.length,
    symbolCount: buckets.symbols.length,
    anchorCount: buckets.anchors.length,
    importCount: buckets.imports.length,
    exportCount: buckets.exports.length,
    referenceCount: buckets.references.length,
    parserCounts: Object.fromEntries(parsers.entries()),
    topSymbols: buckets.symbols.slice(0, 12),
    topAnchors: buckets.anchors.slice(0, 12),
    topImports: buckets.imports.slice(0, 12),
    topExports: buckets.exports.slice(0, 12),
    topReferences: buckets.references.slice(0, 12),
  };
}
