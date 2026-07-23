// @ts-check
// NoeToolMatch — 阶段二·扩展可自主调用的工具生态:让 Neo 推理「自己已有哪些工具」。
//
// 轴3 察觉能力缺口时先查现有工具能否满足(再决定装新)——更好地用现有生态 + 零新增安装风险。
// 纯函数:按 need 与 tool 的 name/description/category 关键词重叠打分,只返回 enabled(可真调用)的工具,按分降序。

// 切词:中英混排,按非字母数字中日韩分隔 + 2gram(中文重叠靠子串,简单有效)。去停用。
const STOP = new Set(['需要', '一个', '工具', '能力', '的', 'need', 'a', 'an', 'tool', 'the', 'to']);
function tokens(text) {
  const t = String(text || '').toLowerCase();
  const words = t.split(/[^a-z0-9一-鿿]+/i).filter(Boolean);
  const out = new Set();
  for (const w of words) {
    if (w.length >= 2 && !STOP.has(w)) out.add(w);
    // 中文串补 2gram,让"抓取网页"能与"抓取""网页"重叠
    if (/[一-鿿]/.test(w)) {
      for (let i = 0; i + 2 <= w.length; i += 1) { const g = w.slice(i, i + 2); if (!STOP.has(g)) out.add(g); }
    }
  }
  return out;
}

function overlapScore(needTokens, tool) {
  const hay = tokens(`${tool && tool.name || ''} ${tool && tool.description || ''} ${tool && tool.category || ''}`);
  let score = 0;
  for (const nt of needTokens) if (hay.has(nt)) score += 1;
  return score;
}

/**
 * 从已注册工具里找能满足 need 的(只 enabled)。按关键词重叠分降序,无重叠不返回。
 * @param {string} need 能力缺口描述
 * @param {Array<{id?:string,name?:string,description?:string,category?:string,enabled?:boolean|number}>} tools 已注册工具
 * @returns {Array<{id?:string,name?:string,description?:string,category?:string,enabled?:boolean|number}>} 匹配的 enabled 工具(按相关度降序),无则 []
 */
export function matchToolsForNeed(need, tools) {
  const rows = Array.isArray(tools) ? tools : [];
  const needTokens = tokens(need);
  if (!needTokens.size || !rows.length) return [];
  return rows
    .filter((t) => t && (t.enabled === true || t.enabled === 1))
    .map((t) => ({ tool: t, score: overlapScore(needTokens, t) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.tool);
}
