import Database from 'better-sqlite3';
import { tokenizeCodebaseQuery } from './CodebaseQueryEngine.js';
import { CODEBASE_LIMITS } from './codebaseLimits.js';

const MAX_FTS_ROWS = CODEBASE_LIMITS.maxFtsRows;
const MAX_BODY_CHARS = 1200;
const MAX_QUERY_TOKENS = 24;

function safeString(value, max = 4000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function uniq(list) {
  return [...new Set((list || []).filter(Boolean))];
}

function escapeFtsToken(token = '') {
  return safeString(token, 80).replace(/"/g, '""');
}

function buildMatchQuery(query = '') {
  const tokens = tokenizeCodebaseQuery(query)
    .map((token) => token.toLowerCase())
    .filter((token) => /^[a-z0-9_$\u4e00-\u9fff-]{2,80}$/u.test(token))
    .slice(0, MAX_QUERY_TOKENS);
  if (!tokens.length) return '';
  return uniq(tokens).map((token) => `"${escapeFtsToken(token)}"*`).join(' OR ');
}

function compactBody(parts = []) {
  return parts
    .map((part) => safeString(part, 400))
    .filter(Boolean)
    .join('\n')
    .replace(/\s+/g, ' ')
    .slice(0, MAX_BODY_CHARS);
}

function symbolsJson(symbols = []) {
  return JSON.stringify((symbols || []).slice(0, 8).map((item) => ({
    name: safeString(item.name, 120),
    type: safeString(item.type, 40),
    line: Math.max(1, Number(item.line) || 1),
    exported: !!item.exported,
  })).filter((item) => item.name));
}

function routesJson(routes = []) {
  return JSON.stringify((routes || []).slice(0, 8).map((item) => ({
    kind: safeString(item.kind, 40),
    name: safeString(item.name, 180),
    line: Math.max(1, Number(item.line) || 1),
  })).filter((item) => item.name));
}

function normalizeRankScore(rank, index) {
  const rankMagnitude = Math.abs(Number(rank) || 0);
  const rankScore = Math.max(1, 36 - Math.min(24, Math.floor(rankMagnitude * 1_000_000)));
  return Math.max(1, rankScore - Math.min(16, index));
}

function insertRow(insert, row) {
  insert.run(
    safeString(row.path, 500),
    Math.max(1, Number(row.line) || 1),
    safeString(row.kind, 80) || 'text',
    safeString(row.anchor, 240),
    safeString(row.parser, 80) || 'unknown',
    safeString(row.body, MAX_BODY_CHARS),
    row.symbols || '[]',
    row.routes || '[]',
    safeString(row.reason, 240),
  );
}

function addEvidenceRows(insert, evidence) {
  let rowCount = 0;
  const add = (row) => {
    if (rowCount >= MAX_FTS_ROWS) return;
    insertRow(insert, row);
    rowCount += 1;
  };

  for (const file of evidence || []) {
    const routeAnchors = (file.anchors || []).filter((anchor) => anchor.kind === 'route' || anchor.kind === 'api');
    add({
      path: file.path,
      line: 1,
      kind: 'file',
      anchor: file.path,
      parser: file.parser,
      body: compactBody([
        file.path,
        file.language,
        file.parser,
        ...(file.symbols || []).map((symbol) => `${symbol.type} ${symbol.name}`),
        ...(file.imports || []).map((item) => `import ${item.source} ${(item.specifiers || []).map((specifier) => `${specifier.imported}:${specifier.local}`).join(' ')}`),
        ...(file.exports || []).map((item) => `export ${item.name} ${item.local} ${item.source || ''}`),
        ...(file.anchors || []).map((anchor) => `${anchor.kind} ${anchor.name}`),
        ...(file.snippets || []).map((snippet) => snippet.text),
        ...(file.references || []).map((ref) => `${ref.kind} ${ref.name} ${ref.text}`),
      ]),
      symbols: symbolsJson(file.symbols),
      routes: routesJson(routeAnchors),
      reason: 'fts:file',
    });

    for (const symbol of file.symbols || []) {
      add({
        path: file.path,
        line: symbol.line,
        kind: `symbol:${symbol.type}`,
        anchor: symbol.name,
        parser: file.parser,
        body: compactBody([file.path, symbol.type, symbol.name, symbol.exported ? 'exported' : 'local']),
        symbols: symbolsJson([symbol]),
        routes: '[]',
        reason: 'fts:symbol',
      });
    }

    for (const anchor of file.anchors || []) {
      const isRoute = anchor.kind === 'route' || anchor.kind === 'api';
      add({
        path: file.path,
        line: anchor.line,
        kind: `anchor:${anchor.kind}`,
        anchor: anchor.name,
        parser: file.parser,
        body: compactBody([file.path, anchor.kind, anchor.name]),
        symbols: symbolsJson(file.symbols || []),
        routes: routesJson(isRoute ? [anchor] : []),
        reason: isRoute ? 'fts:route' : `fts:anchor:${anchor.kind}`,
      });
    }

    for (const snippet of file.snippets || []) {
      add({
        path: file.path,
        line: snippet.line,
        kind: 'text',
        anchor: snippet.reason,
        parser: file.parser,
        body: compactBody([file.path, snippet.reason, snippet.text]),
        symbols: symbolsJson(file.symbols || []),
        routes: '[]',
        reason: `fts:text:${snippet.reason || 'snippet'}`,
      });
    }

    for (const ref of file.references || []) {
      add({
        path: file.path,
        line: ref.line,
        kind: `reference:${ref.kind}`,
        anchor: ref.name,
        parser: file.parser,
        body: compactBody([file.path, ref.kind, ref.name, ref.text]),
        symbols: symbolsJson(file.symbols || []),
        routes: '[]',
        reason: `fts:reference:${ref.kind || 'reference'}`,
      });
    }
  }

  return rowCount;
}

/**
 * Builds a full-text search index for the codebase using SQLite FTS5.
 *
 * @param {Object} map - The evidence map containing file references and symbols.
 * @param {Array<Object>} [map.evidence=[]] - Array of file evidence objects to index.
 * @returns {Object} An object containing summary statistics and query/close methods.
 * @returns {Object} return.summary - Metadata about the index (engine, file count, row count, etc.).
 * @returns {Function} return.query - Function to search the index. Takes a query string and options.
 * @returns {Function} return.close - Function to close the database connection.
 */
function createCodebaseFtsTable(db) {
  db.exec(`
    CREATE VIRTUAL TABLE codebase_fts USING fts5(
      path UNINDEXED,
      line UNINDEXED,
      kind UNINDEXED,
      anchor UNINDEXED,
      parser UNINDEXED,
      body,
      symbols UNINDEXED,
      routes UNINDEXED,
      reason UNINDEXED
    );
  `);
}

function prepareCodebaseFtsInsert(db) {
  return db.prepare(`
    INSERT INTO codebase_fts(path, line, kind, anchor, parser, body, symbols, routes, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
}

function runCodebaseFtsSearch(db, match, limit) {
  try {
    return db.prepare(`
      SELECT path, line, kind, anchor, parser, body, symbols, routes, reason, bm25(codebase_fts) AS rank
      FROM codebase_fts
      WHERE codebase_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(match, limit);
  } catch {
    return [];
  }
}

function mapCodebaseFtsRow(row, index) {
  return {
    path: row.path,
    line: Math.max(1, Number(row.line) || 1),
    kind: row.kind || 'text',
    anchor: row.anchor || null,
    parser: row.parser || 'unknown',
    text: safeString(row.body, 260),
    score: normalizeRankScore(row.rank, index),
    bm25Rank: Number(row.rank) || 0,
    reason: uniq(['fts5', 'bm25', row.reason]).filter(Boolean),
    symbols: JSON.parse(row.symbols || '[]'),
    routes: JSON.parse(row.routes || '[]'),
  };
}

/**
 * 在内存 SQLite + FTS5 之上构建一个轻量的代码库全文索引。
 *
 * 会创建一个临时 SQLite 数据库，注册 FTS5 虚拟表，并把传入的 evidence 行
 * 批量写入索引；返回的对象封装了查询能力与生命周期管理。
 *
 * @param {Object} [map={}] 来自检索/证据流水线的输入映射。
 * @param {Array<Object>} [map.evidence=[]] 需要写入 FTS5 的证据行数组，
 *   每行至少应包含 path / line / body / kind / anchor / parser / symbols /
 *   routes 等可被 FTS5 模式识别的字段。
 * @returns {{
 *   summary: {
 *     enabled: boolean,
 *     engine: string,
 *     ranking: string,
 *     fileCount: number,
 *     rowCount: number,
 *     maxRows: number
 *   },
 *   query: (query: string, options?: { maxResults?: number }) => Array<Object>,
 *   close: () => void
 * }} 封装了 FTS5 索引的查询器：summary 描述索引元信息，query 用于执行
 * 带 BM25 打分的全文检索，close 用于显式释放底层数据库句柄。
 */
export function buildCodebaseFtsIndex(map = {}) {
  const db = new Database(':memory:');
  createCodebaseFtsTable(db);
  const insert = prepareCodebaseFtsInsert(db);
  const evidence = map.evidence || [];
  const rowCount = db.transaction(() => addEvidenceRows(insert, evidence))();
  const fileCount = evidence.length;

  return {
    summary: {
      enabled: true,
      engine: 'sqlite-fts5',
      ranking: 'bm25',
      fileCount,
      rowCount,
      maxRows: MAX_FTS_ROWS,
    },
    query(query, { maxResults = 20 } = {}) {
      const match = buildMatchQuery(query);
      if (!match || rowCount === 0) return [];
      const limit = Math.max(1, Math.min(100, Number(maxResults) || 20));
      return runCodebaseFtsSearch(db, match, limit).map(mapCodebaseFtsRow);
    },
    close() {
      db.close();
    },
  };
}
