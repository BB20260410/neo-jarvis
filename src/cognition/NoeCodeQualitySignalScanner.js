// @ts-check
// NoeCodeQualitySignalScanner — 路 2 真信号目标源的第一个扫描器：从真实代码改进点产 self-evolution 信号。
//
// 痛点（飞轮真转后实证）：autoseed 唯一目标源是 inner thoughts 反刍，产抒情诗性目标（"怀念调试代码的静谧时光"），
//   本地 implement 对它产空 operations / 编造 patch → 失败 → 飞轮空转。路 1 证明只要喂含 src 路径的真目标，
//   本地引擎就能产完美 patch 走通 complete。本扫描器是「真信号供给」第一源：缺 JSDoc 的导出函数。
//
// 设计：纯函数 + DI（fsReadFile/projectRoot/isProtected/now 全注入）+ fail-open（读失败/解析失败 → 该文件 0 信号，绝不崩）。
//   用 acorn（项目已依赖，参考 src/agents/JavaScriptAstAnalyzer.js）解析 AST + onComment 收集注释，
//   判「ExportNamedDeclaration 上一行是否 JSDoc Block(/** */)」。信号含 file:line:name + title（含 src 路径，
//   让 implementer 的 readTargetFileContext 提取真实代码 → 本地 35b 产高质量 patch）。
//   protected 文件（NoePolicyFileGuard）由调用方注入的 isProtected 排除；本次扫描内按 {file:line:name} 去重。

import * as acorn from 'acorn';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 把绝对路径转项目相对、正斜杠形式（与 NoePolicyFileGuard / readTargetFileContext 同口径）。
 * @param {string} absPath
 * @param {string} projectRoot
 * @returns {string}
 */
function toRelPosix(absPath, projectRoot) {
  return path.relative(projectRoot, absPath).split(path.sep).join('/');
}

/**
 * 扫单个文件，返回缺 JSDoc 的导出函数信号（不含 title，scan 统一补）。fail-open：读/解析失败返回 []。
 * @param {string} absPath
 * @param {string} rel
 * @param {(p:string, enc:string)=>string} fsReadFile
 * @returns {Array<{type:string, file:string, line:number, name:string}>}
 */
function scanOneFile(absPath, rel, fsReadFile) {
  let code;
  try { code = fsReadFile(absPath, 'utf8'); } catch { return []; }
  const comments = [];
  let ast;
  try {
    ast = acorn.parse(String(code), { ecmaVersion: 'latest', sourceType: 'module', locations: true, onComment: comments });
  } catch {
    // 解析失败（语法错/非标准语法）→ fail-open，该文件 0 信号，绝不崩飞轮
    return [];
  }
  // JSDoc Block 注释（/** … */ → acorn 中 type='Block' 且 value 以 '*' 开头）的结束行集合。
  const jsdocEndLines = new Set();
  for (const c of comments) {
    if (c && c.type === 'Block' && typeof c.value === 'string' && c.value.startsWith('*') && c.loc) {
      jsdocEndLines.add(c.loc.end.line);
    }
  }
  const out = [];
  for (const node of (ast.body || [])) {
    if (!node || node.type !== 'ExportNamedDeclaration' || !node.declaration || !node.loc) continue;
    const line = node.loc.start.line;
    // 上一行是 JSDoc 结束行 → 视为已有 JSDoc（行注释 // = type 'Line'，不在集合内 → 仍算缺）。
    if (jsdocEndLines.has(line - 1)) continue;
    const decl = node.declaration;
    /** @type {string[]} */
    let names = [];
    if (decl.type === 'FunctionDeclaration' && decl.id) {
      names = [decl.id.name];
    } else if (decl.type === 'VariableDeclaration' && Array.isArray(decl.declarations)) {
      // 仅 export const/let fn = () => {} / function(){}（函数型导出）才算；export const X = 1 不算。
      names = decl.declarations
        .filter((d) => d && d.id && d.id.type === 'Identifier' && d.init
          && (d.init.type === 'ArrowFunctionExpression' || d.init.type === 'FunctionExpression'))
        .map((d) => d.id.name);
    }
    for (const name of names) out.push({ type: 'missing_jsdoc', file: rel, line, name });
  }
  return out;
}

/**
 * 创建代码质量信号扫描器。
 * @param {object} [deps]
 * @param {(p:string, enc:string)=>string} [deps.fsReadFile] 读文件（注入便于测试）
 * @param {string} [deps.projectRoot] 项目根（算相对路径）
 * @param {(rel:string)=>boolean} [deps.isProtected] 判断项目相对路径是否 protected（注入 NoePolicyFileGuard）
 * @param {()=>number} [deps.now]
 * @returns {{ scan: (opts?:{files?:string[], limit?:number}) => { signals: Array<object>, dropped: {protected:number, duplicate:number} } }}
 */
export function createCodeQualitySignalScanner({
  fsReadFile = readFileSync,
  projectRoot = process.cwd(),
  isProtected = () => false,
  now = () => Date.now(),
} = {}) {
  /**
   * 扫一批文件，产去重后的缺 JSDoc 信号。protected 文件计入 dropped 不扫。
   * @param {{files?:string[], limit?:number}} [opts]
   */
  function scan({ files = [], limit = 20 } = {}) {
    const signals = [];
    const dropped = { protected: 0, duplicate: 0 };
    const seen = new Set();
    for (const absPath of (Array.isArray(files) ? files : [])) {
      const rel = toRelPosix(absPath, projectRoot);
      if (isProtected(rel)) { dropped.protected += 1; continue; }
      const found = scanOneFile(absPath, rel, fsReadFile);
      for (const sig of found) {
        const key = `${sig.file}:${sig.line}:${sig.name}`;
        if (seen.has(key)) { dropped.duplicate += 1; continue; }
        seen.add(key);
        signals.push({
          ...sig,
          title: `为 ${sig.file}:${sig.line} 的 ${sig.name}() 补 JSDoc 注释`,
          discoveredAt: now(),
        });
        if (signals.length >= limit) break;
      }
      if (signals.length >= limit) break;
    }
    return { signals, dropped };
  }

  return { scan };
}
