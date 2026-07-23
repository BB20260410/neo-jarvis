// @ts-check
// NoeCodeIntegrationMetric（P2-3 整合度量化）——用**可工程计算的标准软件度量**量化认知模块整合度，
// 替代不可计算的 IIT Φ（逻辑+红队双审计裁定：Φ 在通用 Agent 架构需枚举子系统状态、指数级不可实时采样，
// 「Φ 方差下降」无法指导代码优化）。
//
// 与 NoeIntegrationMetric.js 的分工（两个不同视角，都保留）：
//   - NoeIntegrationMetric：**运行态**整合（TC 总相关，看每周期子系统状态是否同步整合成统一内容）。
//   - 本模块：**静态代码结构**整合（图论耦合度 + 圈复杂度），有明确算法、可复算、可指导重构。
//
// 度量（皆纯函数、确定性、只读）：
//   ① 模块间调用依赖图的**耦合度**：节点=模块、边=intra-set import；耦合密度 = 边数 / 可能边数；
//      fan-in/fan-out；**拓扑熵** = fan-out 分布的香农熵（越均匀=耦合越分散；越尖=少数枢纽主导）。
//   ② **圈复杂度**（Cyclomatic Complexity 文件级近似）：判定点数（if/for/while/case/catch/&&/||/??/三元）+1。
//      诚实声明：文件级近似（非逐函数 AST），用于**趋势**比较（同口径可复算），非精确合规审计。

// 4 分支无重叠正则（红队修复 ReDoS）：原 `[\w*${}\s,]+\s+from` 的字符类含 \s 又紧跟 \s+，空白上量词重叠 →
//   `import `+长空白触发灾难回溯。改为按出现形态各自匹配，每分支仅单个 \s*/\s+，量词互不重叠：
//   ① `from '...'`（覆盖 import {a} from / import x from / export ... from，绑定子句不靠正则吃，交给 from 锚）
//   ② `import '...'`（side-effect）③ `import('...')`（动态）④ `require('...')`。
const IMPORT_RE = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g;

function basename(p = '') {
  const s = String(p).replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

// 抽取源码里的 import/require 模块说明符。
export function extractImports(source = '') {
  const out = [];
  const s = String(source || '');
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(s)) !== null) {
    const spec = m[1] || m[2] || m[3] || m[4]; // 命中分支的捕获组
    if (spec) out.push(spec);
  }
  return out;
}

// 去注释 + 字符串字面量（粗），降低误计 decision token。
function stripCommentsAndStrings(source = '') {
  return String(source || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1') // 行注释（避开 http://）
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')   // 模板串
    .replace(/'(?:\\.|[^'\\])*'/g, "''")        // 单引号串
    .replace(/"(?:\\.|[^"\\])*"/g, '""');       // 双引号串
}

// 圈复杂度（文件级近似）：判定点数 + 1。
export function cyclomaticComplexity(source = '') {
  const s = stripCommentsAndStrings(source);
  const kw = (s.match(/\b(?:if|for|while|case|catch)\b/g) || []).length;
  const logic = (s.match(/&&|\|\||\?\?/g) || []).length;
  // 三元 ?：排除可选链 ?. 和 ?? 与类型可选；近似匹配 `? ` 形式
  const ternary = (s.match(/\?(?![.?:])/g) || []).length;
  return kw + logic + ternary + 1;
}

function shannonEntropyBits(values) {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let h = 0;
  for (const v of values) {
    if (v > 0) { const p = v / total; h -= p * Math.log2(p); }
  }
  return h;
}

/**
 * 构造模块耦合图（仅统计 set 内部互相 import）。
 * @param {Record<string,string>} fileSources { 相对路径 或 名字 : 源码 }
 * @returns {{nodes:string[], edges:Array<[string,string]>, fanOut:Record<string,number>, fanIn:Record<string,number>, density:number, topologicalEntropy:number}}
 */
export function buildCouplingGraph(fileSources = {}) {
  const keys = Object.keys(fileSources || {});
  const byBase = new Map(); // basename -> key（解析相对 import）
  for (const k of keys) byBase.set(basename(k), k);
  const nodes = [...keys];
  const edges = [];
  const fanOut = Object.fromEntries(nodes.map((n) => [n, 0]));
  const fanIn = Object.fromEntries(nodes.map((n) => [n, 0]));
  const seen = new Set();
  for (const k of keys) {
    for (const spec of extractImports(fileSources[k])) {
      const target = byBase.get(basename(spec));
      if (!target || target === k) continue; // 只算 set 内、非自环
      const sig = `${k}->${target}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      edges.push([k, target]);
      fanOut[k] += 1;
      fanIn[target] += 1;
    }
  }
  const n = nodes.length;
  const possible = n > 1 ? n * (n - 1) : 1;
  const density = edges.length / possible;
  const topologicalEntropy = shannonEntropyBits(nodes.map((nd) => fanOut[nd]));
  return { nodes, edges, fanOut, fanIn, density, topologicalEntropy };
}

/**
 * 综合代码整合度报告（耦合度 + 圈复杂度），确定性可复算。
 * @param {Record<string,string>} fileSources
 * @returns {{ok:boolean, moduleCount:number, coupling:{density:number, edgeCount:number, topologicalEntropy:number, topHubs:Array<{module:string,fanOut:number,fanIn:number}>}, complexity:{avg:number, max:number, total:number, byModule:Record<string,number>, hottest:Array<{module:string,complexity:number}>}}}
 */
export function computeCodeIntegration(fileSources = {}) {
  const keys = Object.keys(fileSources || {});
  if (keys.length === 0) return { ok: false, moduleCount: 0, coupling: { density: 0, edgeCount: 0, topologicalEntropy: 0, topHubs: [] }, complexity: { avg: 0, max: 0, total: 0, byModule: {}, hottest: [] } };
  const graph = buildCouplingGraph(fileSources);
  const byModule = {};
  for (const k of keys) byModule[basename(k)] = cyclomaticComplexity(fileSources[k]);
  const comps = Object.values(byModule);
  const total = comps.reduce((a, b) => a + b, 0);
  const max = comps.reduce((a, b) => Math.max(a, b), 0);
  const avg = comps.length ? total / comps.length : 0;
  const hottest = Object.entries(byModule).map(([module, complexity]) => ({ module, complexity }))
    .sort((a, b) => b.complexity - a.complexity).slice(0, 5);
  const topHubs = graph.nodes.map((nd) => ({ module: basename(nd), fanOut: graph.fanOut[nd], fanIn: graph.fanIn[nd] }))
    .sort((a, b) => (b.fanOut + b.fanIn) - (a.fanOut + a.fanIn)).slice(0, 5);
  return {
    ok: true,
    moduleCount: keys.length,
    coupling: {
      density: Number(graph.density.toFixed(4)),
      edgeCount: graph.edges.length,
      topologicalEntropy: Number(graph.topologicalEntropy.toFixed(4)),
      topHubs,
    },
    complexity: {
      avg: Number(avg.toFixed(2)),
      max,
      total,
      byModule,
      hottest,
    },
  };
}
