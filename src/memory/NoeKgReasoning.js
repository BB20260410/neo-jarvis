// @ts-check
// NoeKgReasoning — 阶段二·让自我记忆图谱真正参与推理。
//
// KG 此前只喂召回(recallFused 第三路)。「参与推理」= self-evolution 立项/implement 前,用目标查 KG 相关实体 +
//   一跳邻居,格式化成一段推理上下文注入 prompt——让模型带着「图谱里关于这个模块的已知知识/关联」去改,
//   而不是孤立地只看目标文件。search/oneHop 注入(复用 NoeKnowledgeGraph 的公开 API),纯函数、fail-open、有限流。

/**
 * @param {object} node
 * @returns {string}
 */
function nameOf(node) {
  return (node && (node.name || node.dstName || node.srcName || node.id)) || '';
}

/**
 * 用 query 查 KG,取相关实体 + 一跳邻居,格式化成推理上下文(空则返 ''，不注入垃圾)。
 * @param {object} deps
 * @param {string} deps.query 目标/objective(用于 KG search)
 * @param {(args:{q:string,limit:number})=>Array<any>} [deps.search] KG 实体检索
 * @param {(args:{id:string,name:string,limit:number})=>Array<any>} [deps.oneHop] 一跳邻居
 * @param {number} [deps.maxEntities] 最多几个实体(默认 3,防撑爆 prompt)
 * @param {number} [deps.maxNeighbors] 每实体最多几个邻居(默认 5)
 * @returns {string} 推理上下文段(带前缀换行),无则 ''
 */
export function buildKgReasoningContext({ query, search, oneHop, maxEntities = 3, maxNeighbors = 5 } = {}) {
  const q = String(query || '').trim();
  if (!q || typeof search !== 'function') return '';
  let hits;
  try { hits = search({ q, limit: maxEntities }) || []; } catch { return ''; }
  if (!Array.isArray(hits) || !hits.length) return '';
  const lines = [];
  for (const h of hits.slice(0, maxEntities)) {
    const name = nameOf(h);
    if (!name) continue;
    let neighbors = [];
    try { neighbors = (typeof oneHop === 'function' ? oneHop({ id: h.id, name, limit: maxNeighbors }) : []) || []; } catch { neighbors = []; }
    const nbrNames = (Array.isArray(neighbors) ? neighbors : []).slice(0, maxNeighbors).map(nameOf).filter(Boolean);
    const desc = (h && h.description) ? `: ${String(h.description).slice(0, 120)}` : '';
    lines.push(`- ${name}${desc}${nbrNames.length ? `（关联: ${nbrNames.join(', ')}）` : ''}`);
  }
  if (!lines.length) return '';
  return `\n\n相关记忆图谱知识(供参考,可能与本次改动相关的模块/关联):\n${lines.join('\n')}`;
}
