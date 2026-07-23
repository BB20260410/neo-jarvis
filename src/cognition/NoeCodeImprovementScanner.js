// @ts-check
// NoeCodeImprovementScanner — P2 多元真信号源：扩展飞轮「该改什么」的视野（除缺 JSDoc 外的代码改进点）。
//   三种信号：stale_todo(TODO/FIXME/XXX/HACK 注释)、high_complexity(函数圈复杂度超阈值)、test_gap(有导出函数但无测试)。
//   纯函数 + DI(fsReadFile/hasTest/isProtected) + fail-open。
//   - stale_todo 走正则逐行扫（不依赖 AST，语法错文件也能扫）；
//   - high_complexity / test_gap 依赖 acorn AST（解析失败 → 跳过该两类，不崩）。
//   每种独立 signalType，调用方按 flag 选要哪些。信号带 title（含 src 路径，喂 implementer 产 patch）。

import * as acorn from 'acorn';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const TODO_RE = /(?:\/\/|\/\*|\*)\s*(TODO|FIXME|XXX|HACK)\b[:：]?\s*(.*)/i;

function toRelPosix(absPath, projectRoot) {
  return path.relative(projectRoot, absPath).split(path.sep).join('/');
}

// 递归遍历 AST 节点（跳过位置元数据键）。
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue;
    const child = node[key];
    if (Array.isArray(child)) { for (const c of child) walk(c, visit); }
    else if (child && typeof child === 'object' && typeof child.type === 'string') walk(child, visit);
  }
}

// 圈复杂度 = 决策点数 + 1（if/循环/catch/三元/switch-case/逻辑短路）。
function cyclomaticComplexity(fnNode) {
  let count = 1;
  const decision = new Set(['IfStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement', 'CatchClause', 'ConditionalExpression']);
  walk(fnNode, (n) => {
    if (decision.has(n.type)) count += 1;
    else if (n.type === 'SwitchCase' && n.test) count += 1; // 非 default
    else if (n.type === 'LogicalExpression' && (n.operator === '&&' || n.operator === '||' || n.operator === '??')) count += 1;
  });
  return count;
}

// 收集所有函数节点（声明 + 表达式 + 箭头）。
function collectFunctions(ast) {
  const fns = [];
  walk(ast, (n) => {
    if (n.type === 'FunctionDeclaration' && n.id && n.loc) fns.push({ name: n.id.name, line: n.loc.start.line, node: n });
    else if ((n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') && n.loc) {
      fns.push({ name: (n.id && n.id.name) || `fn@${n.loc.start.line}`, line: n.loc.start.line, node: n });
    }
  });
  return fns;
}

// 文件是否有导出函数（test_gap 判据：无导出函数的文件无需单测）。
function hasExportedFunction(ast) {
  for (const node of (ast.body || [])) {
    if (node && node.type === 'ExportNamedDeclaration' && node.declaration) {
      const d = node.declaration;
      if (d.type === 'FunctionDeclaration') return true;
      if (d.type === 'VariableDeclaration' && Array.isArray(d.declarations)
        && d.declarations.some((x) => x && x.init && (x.init.type === 'ArrowFunctionExpression' || x.init.type === 'FunctionExpression'))) return true;
    }
    if (node && node.type === 'ExportDefaultDeclaration' && node.declaration
      && (node.declaration.type === 'FunctionDeclaration' || node.declaration.type === 'ArrowFunctionExpression')) return true;
  }
  return false;
}

/**
 * @param {object} [deps]
 * @param {(p:string, enc:string)=>string} [deps.fsReadFile]
 * @param {string} [deps.projectRoot]
 * @param {(rel:string)=>boolean} [deps.isProtected]
 * @param {(rel:string)=>boolean} [deps.hasTest] 判文件是否有对应测试（test_gap 用）
 * @param {number} [deps.complexityThreshold]
 * @param {()=>number} [deps.now]
 */
// P4 test_gap 可测性预筛（2026-07-02）：生产数据 test_gap 目标 drop 率 57%（全信号最差）、test_only 尝试
//   保留率仅 18%——大头是给「M3 根本补不动测试」的文件立目标（超大文件 / 直接 import 重运行时依赖没法单测）。
//   预筛掉这两类，只给可测文件立目标。deny 列表：需要真实服务/原生绑定/GUI 的模块。
const TEST_GAP_MAX_LINES = 400;
const TEST_GAP_HEAVY_IMPORTS = new Set(['express', 'ws', 'better-sqlite3', 'electron', 'playwright', 'node-pty', '@lancedb/lancedb']);

function collectImportSources(ast) {
  const sources = [];
  for (const node of ast.body || []) {
    if (node.type === 'ImportDeclaration' && node.source && typeof node.source.value === 'string') {
      sources.push(node.source.value);
    }
  }
  return sources;
}

function isTestableForTestGap(ast, code) {
  if (code.split('\n').length > TEST_GAP_MAX_LINES) return false;
  for (const source of collectImportSources(ast)) {
    const base = source.startsWith('@') ? source.split('/').slice(0, 2).join('/') : source.split('/')[0];
    if (TEST_GAP_HEAVY_IMPORTS.has(base)) return false;
  }
  return true;
}

export function createCodeImprovementScanner({
  fsReadFile = readFileSync,
  projectRoot = process.cwd(),
  isProtected = () => false,
  hasTest = () => true,
  complexityThreshold = 12,
  now = () => Date.now(),
} = {}) {
  function scanOneFile(absPath, rel, signalTypes) {
    let code;
    try { code = String(fsReadFile(absPath, 'utf8')); } catch { return []; }
    const out = [];
    // stale_todo：正则逐行（不依赖 AST，语法错文件也能扫）
    if (signalTypes.includes('stale_todo')) {
      const lines = code.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const m = lines[i].match(TODO_RE);
        if (m) {
          const tag = m[1].toUpperCase();
          const text = (m[2] || '').trim().slice(0, 80);
          out.push({ type: 'stale_todo', file: rel, line: i + 1, name: tag, text, title: `处理 ${rel}:${i + 1} 的 ${tag}：${text.slice(0, 50)}` });
        }
      }
    }
    // high_complexity / test_gap：依赖 acorn AST（解析失败跳过）
    if (signalTypes.includes('high_complexity') || signalTypes.includes('test_gap')) {
      let ast = null;
      try { ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true }); } catch { ast = null; }
      if (ast) {
        if (signalTypes.includes('high_complexity')) {
          for (const fn of collectFunctions(ast)) {
            const cx = cyclomaticComplexity(fn.node);
            if (cx >= complexityThreshold) {
              out.push({ type: 'high_complexity', file: rel, line: fn.line, name: fn.name, complexity: cx, title: `重构 ${rel}:${fn.line} 的 ${fn.name}() 降圈复杂度（当前 ${cx}）` });
            }
          }
        }
        if (signalTypes.includes('test_gap') && hasExportedFunction(ast) && !hasTest(rel) && isTestableForTestGap(ast, code)) {
          out.push({ type: 'test_gap', file: rel, title: `为 ${rel} 的导出函数补单元测试（当前无测试覆盖）` });
        }
      }
    }
    return out;
  }

  // priorityTypes 非空 → 全量收集后按类型优先级排序再 slice(limit)，让「截断本身尊重优先级」。
  //   根治：逐文件 break 会让排在后面文件的稀缺信号（如 test_gap，全库仅几十个）被前面海量
  //   high_complexity 占满 limit 而永远扫不到——此时调用方在结果上再排序也救不回被截掉的信号。
  function scan({ files = [], signalTypes = ['stale_todo', 'high_complexity', 'test_gap'], limit = 20, priorityTypes = [] } = {}) {
    const usePriority = Array.isArray(priorityTypes) && priorityTypes.length > 0;
    const signals = [];
    const dropped = { protected: 0, duplicate: 0 };
    const seen = new Set();
    for (const absPath of (Array.isArray(files) ? files : [])) {
      const rel = toRelPosix(absPath, projectRoot);
      if (isProtected(rel)) { dropped.protected += 1; continue; }
      for (const sig of scanOneFile(absPath, rel, signalTypes)) {
        const key = `${sig.type}:${sig.file}:${sig.line || 0}:${sig.name || ''}`;
        if (seen.has(key)) { dropped.duplicate += 1; continue; }
        seen.add(key);
        signals.push({ ...sig, discoveredAt: now() });
        if (!usePriority && signals.length >= limit) break; // 优先模式不中途截断，待全收集后按优先级 slice
      }
      if (!usePriority && signals.length >= limit) break;
    }
    if (usePriority) {
      const rank = (t) => { const i = priorityTypes.indexOf(t); return i === -1 ? priorityTypes.length : i; };
      signals.sort((a, b) => rank(a.type) - rank(b.type)); // V8 稳定排序：同优先级保持扫描顺序
      return { signals: signals.slice(0, limit), dropped };
    }
    return { signals, dropped };
  }

  return { scan };
}
