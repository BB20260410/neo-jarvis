// @ts-check
// NoeRelationHarvest — 用本地 LLM 从 research 报告抽实体间关系三元组，写知识图谱 noe_kg_relation。
//
// 背景：知识图谱长期「41 实体 0 关系」——实体抽取(NoeEntityHarvest)只写点(upsertEntity)，全仓无任何路径写边
//   （唯一 upsertRelation 调用方 ingestFileIndex 是按需工具、从不自动触发）。本模块补上关系抽取这条路：
//   research report + 该轮已抽实体 → 本地 LLM 抽 (主体,关系,客体) 三元组 → 只在【已知实体】之间 upsertRelation。
// 设计要点：
//   - 只连「已抽取实体」(name→id 映射，小写容大小写漂移)，不新建实体——防 LLM 幻觉造点污染图谱。
//   - relType 小写+空白转下划线规范化；技术关系(built_with/depends_on/part_of/related_to)多为多值，不误触单值关旧窗。
//   - 鲁棒解析(容 LLM 带解释文字，提取首个 JSON 数组块)；去重；maxRelations 上限防灌爆。
//   - flag NOE_KG_RELATIONS 默认 OFF(分量动作：认知层 + LLM 调用)。纯 DI(getAdapter/knowledgeGraph) + 全程 fail-open。

import { NOE_MAIN_BRAIN_MODEL, normalizeNoeAutoModel } from '../model/NoeLocalModelPolicy.js';

const REL_SYSTEM = [
  '你是知识图谱关系抽取器。从给定文本和实体列表中，抽取实体之间真实存在的关系。',
  '严格规则：',
  '1. 只用「实体列表」里给出的实体名作为 src 和 dst，不要发明新实体。',
  '2. 关系类型(rel)用简短英文小写蛇形命名，如 built_with / depends_on / part_of / uses / alternative_to / related_to。',
  '3. 只抽文本明确支持的关系，不臆测；没有可靠关系就返回空数组 []。',
  '4. 只输出 JSON 数组，每项形如 {"src":"实体名","rel":"关系类型","dst":"实体名"}，不要任何解释文字。',
].join('\n');

const DEFAULT_MAX_RELATIONS = 20;
const REPORT_SLICE = 3000; // 喂模型的报告字数上限（防超 context）

/** 鲁棒解析 LLM 返回的三元组 JSON 数组（容错：整体解析失败时提取首个 [...] 块）。 */
export function parseTriples(reply) {
  const text = String(reply || '').trim();
  if (!text) return [];
  let arr = null;
  try { arr = JSON.parse(text); } catch { /* 下面退化为提取块 */ }
  if (!Array.isArray(arr)) {
    const m = text.match(/\[[\s\S]*\]/);
    if (m) { try { arr = JSON.parse(m[0]); } catch { arr = null; } }
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter((t) => t && typeof t === 'object' && t.src && t.rel && t.dst).slice(0, 200);
}

/**
 * @param {object} [deps]
 * @param {{ upsertRelation: Function }} [deps.knowledgeGraph]
 * @param {(id: string) => ({chat: Function}|null|undefined)} [deps.getAdapter]
 * @param {string} [deps.brainAdapterId]
 * @param {string} [deps.model]
 * @param {{ maxRelations?: number }} [deps.config]
 * @param {string} [deps.projectId]
 */
export function createRelationHarvest({
  knowledgeGraph,
  getAdapter,
  brainAdapterId = process.env.NOE_INNER_BRAIN || 'lmstudio',
  model = process.env.NOE_INNER_MODEL ?? NOE_MAIN_BRAIN_MODEL,
  config = {},
  projectId = 'noe',
} = {}) {
  const maxRelations = Math.max(1, Math.floor(Number(config.maxRelations ?? process.env.NOE_KG_RELATIONS_MAX) || DEFAULT_MAX_RELATIONS));
  const resolvedModel = normalizeNoeAutoModel(model, { allowEmpty: true });

  // 从 research 产出 + 已抽实体抽关系三元组写图谱。fail-open（不抛、不阻断研究闭环）。
  async function harvest({ report, topic = '', entities = [] } = {}) {
    if (process.env.NOE_KG_RELATIONS !== '1') return { ok: false, skipped: 'flag_off' };
    if (!knowledgeGraph || typeof knowledgeGraph.upsertRelation !== 'function') return { ok: false, skipped: 'no_kg' };
    const valid = (Array.isArray(entities) ? entities : []).filter((e) => e && e.id && e.name);
    if (valid.length < 2) return { ok: false, skipped: 'too_few_entities' }; // 少于 2 个实体无从连边
    const text = String(report || '');
    if (text.length < 200) return { ok: false, skipped: 'too_short' };

    let adapter = null;
    try { adapter = getAdapter?.(brainAdapterId); } catch { adapter = null; }
    if (!adapter?.chat) return { ok: false, skipped: 'no_brain' };

    // name(小写) → id：容 LLM 输出实体名大小写漂移。
    const nameToId = new Map();
    for (const e of valid) nameToId.set(String(e.name).toLowerCase().trim(), e.id);

    let triples = [];
    try {
      const r = await adapter.chat(
        [
          { role: 'system', content: REL_SYSTEM },
          { role: 'user', content: `实体列表：\n${valid.map((e) => e.name).join(', ')}\n\n文本（主题：${String(topic).slice(0, 80)}）：\n${text.slice(0, REPORT_SLICE)}` },
        ],
        // 不设超时（跑模型纪律）；maxTokens 4096：本地 reasoning 模型(qwen3.6)即便 think:false 仍可能占额，留足余量防 JSON 截断。
        { budgetContext: { projectId, taskId: 'noe-relation-harvest' }, think: false, maxTokens: 4096, ...(resolvedModel ? { model: resolvedModel } : {}) },
      );
      if (r?.incomplete) return { ok: false, skipped: 'brain_incomplete' };
      triples = parseTriples(r?.reply);
    } catch (e) {
      return { ok: false, error: String(e?.message || e).slice(0, 120) }; // fail-open
    }

    let written = 0;
    const seen = new Set();
    const ref = `research:${String(topic).slice(0, 80)}`;
    for (const t of triples) {
      if (written >= maxRelations) break;
      const srcId = nameToId.get(String(t.src || '').toLowerCase().trim());
      const dstId = nameToId.get(String(t.dst || '').toLowerCase().trim());
      const relType = String(t.rel || '').toLowerCase().trim().replace(/\s+/g, '_').slice(0, 80);
      if (!srcId || !dstId || srcId === dstId || !relType) continue; // 只连已知实体、非自指、relType 非空
      const key = `${srcId}|${relType}|${dstId}`;
      if (seen.has(key)) continue; // 本轮去重
      seen.add(key);
      try {
        const id = knowledgeGraph.upsertRelation({ projectId, srcId, dstId, relType, ref, strength: 5 });
        if (typeof id === 'string' && id) written += 1;
      } catch { /* 单条写入失败不阻断整批 */ }
    }
    return { ok: true, written, triples: triples.length, entities: valid.length };
  }

  return { harvest };
}
