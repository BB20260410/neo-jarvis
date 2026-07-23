// @ts-check
// type_error_fix 域(扩展自主能力域第一个,2026-06-29):解析 `tsc --checkJs` 输出,
//   提取指定前缀(默认 src/)下低 error 文件,作飞轮自主"修结构性类型 error"的目标。
//   验证前移证:src/ 502文件/5213 error(属性不存在/null误用等真bug);低error文件优先(M3易修)。
//   纯函数(无 IO,无依赖)——跑 typecheck 取 stdout 的活由调用方(信号源)做,这里只解析,便于单测。

const TSC_LINE_RE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;

/**
 * 解析 tsc 输出文本,按文件聚合 error,过滤前缀 + 低 error,按 errorCount 升序(低优先)。
 * P4 救域（2026-07-02）：denyCodes 排除含「M3 修不动的难 error 码」的文件（实测 TS2339/TS2322 结构性错
 *   12 连 dropped）——文件里任一 error 命中 deny 即整体排除,只留 M3 能全修的简单 error 文件（null check/默认值类）。
 * @param {string} typecheckOutput - `npm run typecheck` 的 stdout
 * @param {{ maxErrorsPerFile?: number, pathPrefix?: string, denyCodes?: string[] }} [opts]
 * @returns {Array<{ file: string, errorCount: number, errors: Array<{line:number, col:number, code:string, message:string}> }>}
 */
export function parseTypecheckTargets(typecheckOutput, opts = {}) {
  const { maxErrorsPerFile = Infinity, pathPrefix = 'src/', denyCodes = [] } = opts;
  if (typeof typecheckOutput !== 'string' || !typecheckOutput) return [];
  const denied = new Set(
    (Array.isArray(denyCodes) ? denyCodes : [])
      .map((c) => String(c || '').trim().toUpperCase())
      .filter(Boolean)
      .map((c) => (c.startsWith('TS') ? c : `TS${c}`)),
  );

  /** @type {Map<string, Array<{line:number, col:number, code:string, message:string}>>} */
  const byFile = new Map();
  for (const raw of typecheckOutput.split('\n')) {
    const m = TSC_LINE_RE.exec(raw.trim());
    if (!m) continue;
    const [, file, line, col, code, message] = m;
    if (!file.startsWith(pathPrefix)) continue;
    let list = byFile.get(file);
    if (!list) { list = []; byFile.set(file, list); }
    list.push({ line: Number(line), col: Number(col), code, message });
  }

  /** @type {Array<{ file: string, errorCount: number, errors: any[] }>} */
  const targets = [];
  for (const [file, errors] of byFile) {
    if (errors.length > maxErrorsPerFile) continue;
    if (denied.size && errors.some((e) => denied.has(String(e.code).toUpperCase()))) continue;
    targets.push({ file, errorCount: errors.length, errors });
  }
  targets.sort((a, b) => a.errorCount - b.errorCount);
  return targets;
}

// 防作弊消音标记:type_error_fix 域必须拦 M3 用这些"逃避而非修"的手段消除 error。
const CHEAT_PATTERNS = [
  { re: /@ts-ignore/, name: '@ts-ignore' },
  { re: /@ts-nocheck/, name: '@ts-nocheck' },
  { re: /eslint-disable/, name: 'eslint-disable' },
  { re: /@type\s*\{\s*any\s*\}/, name: '@type {any}' },
  { re: /\bas\s+any\b/, name: 'as any' },
  { re: /:\s*any\b/, name: ': any' },
];

/**
 * type_error_fix 域价值锚(核心 reward hacking 防护):patch 不得引入消音标记 + 该文件 error 必须真减少。
 * @param {{ patchText?: string, beforeErrorCount?: number, afterErrorCount?: number }} [input]
 * @returns {{ ok: boolean, reason: string }}
 */
export function assessTypeErrorFix(input = {}) {
  const { patchText = '', beforeErrorCount, afterErrorCount } = input;
  for (const { re, name } of CHEAT_PATTERNS) {
    if (re.test(patchText)) return { ok: false, reason: `作弊消音标记 ${name}(逃避而非修类型 error)` };
  }
  if (typeof beforeErrorCount === 'number' && typeof afterErrorCount === 'number') {
    if (afterErrorCount >= beforeErrorCount) {
      return { ok: false, reason: `error 未减少 ${beforeErrorCount}→${afterErrorCount}(没真修)` };
    }
  }
  return { ok: true, reason: afterErrorCount === 0 ? '该文件类型 error 清零' : `error 减少 ${beforeErrorCount}→${afterErrorCount}` };
}

/**
 * apply 后算单文件的 type error 数(after),交 assessTypeErrorFix 判是否真减少。复用 parseTypecheckTargets。
 * @param {string} typecheckOutput
 * @param {string} filePath
 * @returns {number}
 */
export function countFileTypeErrors(typecheckOutput, filePath) {
  const hit = parseTypecheckTargets(typecheckOutput, { pathPrefix: '' }).find((t) => t.file === filePath);
  return hit ? hit.errorCount : 0;
}
