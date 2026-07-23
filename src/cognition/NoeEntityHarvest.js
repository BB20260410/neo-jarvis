// @ts-check
// NoeEntityHarvest — 从 research 产出抽技术实体写知识图谱，让自主发现源①（知识图谱缺口）活起来。
//
// 根因（主线程亲查生产库实证，2026-06-23）：noe_kg_entity = 0 行——没有任何代码从 research/对话自动抽实体，
//   upsertEntity 只被「导入文件结构」工具(noe.kg.ingest_file_index)调过。导致 NoeTopicDiscovery 源①
//   「记忆里反复出现却没深究的实体」永远无货 → Neo 实际只能从静态表轮转（self_learning 7天230次 vs surprise仅4次）。
//
// 解法：research report 产出 → 抽 report 里反复出现的技术实体 → upsertEntity(mention 累加)。
//   · 当前 research 主题对应的实体：description = 报告摘要（已深究，不会被源①当缺口）。
//   · report 里提到的【其他】技术实体：description 留空（没深究）。Neo research 越多、反复提到的实体 mention 越涨，
//     description 仍空 → 源①识别为「该深究 X」自主立研究目标。这正是 owner 要的「从遇到的东西自主学」。
//
// flag NOE_KG_INGEST 默认 OFF（分量动作：驱动自主选题）。DI(knowledgeGraph 注入) + fail-open + 纯增量。

// 技术实体候选：英文标识符/驼峰/带版本号/含 ._+#- 的技术名（与 NoeTopicDiscovery.TECH_OBJECT_RE 同精神）。
const TECH_RE = /[A-Za-z][A-Za-z0-9_.+#-]{2,}/g;
// 泛词/停用词/url 碎片（命中即跳，防写垃圾实体）。
const VAGUE = new Set([
  'http', 'https', 'www', 'com', 'org', 'net', 'html', 'github', 'search', 'repositories', 'repository',
  'the', 'and', 'for', 'with', 'this', 'that', 'use', 'using', 'used', 'best', 'practices', 'practice',
  'how', 'what', 'why', 'when', 'where', 'which', 'can', 'are', 'was', 'has', 'have', 'will', 'not',
  'from', 'into', 'about', 'more', 'most', 'some', 'such', 'than', 'then', 'they', 'them', '其中', 'one',
]);

const DEFAULT_MIN_MENTION_IN_TEXT = 2; // report 里出现 ≥N 次才算「值得记的实体」（一次性提及多是噪声）
const DEFAULT_MAX_ENTITIES = 12;       // 单次 research 最多写入实体数（防一篇长报告灌爆）

export function resolveEntityHarvestConfig(env = process.env) {
  const enabled = env?.NOE_KG_INGEST === '1';
  const minMentionInText = Math.max(1, Math.floor(Number(env?.NOE_KG_INGEST_MIN_MENTION) || DEFAULT_MIN_MENTION_IN_TEXT));
  const maxEntities = Math.max(1, Math.floor(Number(env?.NOE_KG_INGEST_MAX_ENTITIES) || DEFAULT_MAX_ENTITIES));
  return { enabled, minMentionInText, maxEntities };
}

/**
 * @param {{ knowledgeGraph:{upsertEntity:Function}, config?:{minMentionInText?:number, maxEntities?:number} }} deps
 */
export function createEntityHarvest({ knowledgeGraph, config = resolveEntityHarvestConfig() } = {}) {
  const minMentionInText = config.minMentionInText ?? DEFAULT_MIN_MENTION_IN_TEXT;
  const maxEntities = config.maxEntities ?? DEFAULT_MAX_ENTITIES;

  // 从 research 产出抽实体写知识图谱。fail-open（不抛、不阻断研究闭环）。
  function harvest({ report, sources = [], topic = '' } = {}) {
    if (process.env.NOE_KG_INGEST !== '1') return { ok: false, skipped: 'flag_off' };
    if (!knowledgeGraph || typeof knowledgeGraph.upsertEntity !== 'function') return { ok: false, skipped: 'no_kg' };
    try {
      const text = String(report || '');
      if (text.length < 200) return { ok: false, skipped: 'too_short' }; // 太短无足够上下文抽实体
      const topicLow = String(topic || '').toLowerCase().trim();
      // 抽技术实体 + 频率（report 全文 + sources 标题——标题常是干净的项目/概念名）。
      const corpus = `${text} ${(Array.isArray(sources) ? sources : []).map((s) => String(s?.title || '')).join(' ')}`;
      const freq = new Map();
      for (const m of corpus.matchAll(TECH_RE)) {
        const w = m[0];
        const low = w.toLowerCase();
        // 专有名词特征过滤（Codex P1#4：TECH_RE 会匹配 framework/assigns/roles/compared 等普通小写词→污染 KG）：
        //   只收含大写(MetaGPT)/数字(GPT4)/符号(包名版本号 ._+#-/)的技术实体，排纯小写普通英文词。
        if (w.length < 3 || VAGUE.has(low) || !(/[A-Z]/.test(w) || /[0-9._+#/-]/.test(w))) continue;
        freq.set(w, (freq.get(w) || 0) + 1);
      }
      // 只取出现 ≥minMention 的（反复提=值得记），按频率排序取 top maxEntities。
      const ranked = [...freq.entries()]
        .filter(([, c]) => c >= minMentionInText)
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxEntities);
      let written = 0;
      const entitiesWritten = []; // 收集写入的实体 {name,id}，供 NoeRelationHarvest 在已知实体间抽关系（防幻觉造点）
      for (const [name, count] of ranked) {
        // topic 传入的是 research step 文本/query（非纯实体名）→ 用 includes 判主题实体（Codex P1#4：=== 永假，
        //   致已研究主题的实体 description 仍为空、被源①误当"未深究缺口"反复立项研究）。
        const isTopicEntity = !!topicLow && topicLow.includes(name.toLowerCase());
        // 主题实体=已深究→description 给摘要头（不被源①当缺口）；其他=没深究→description 空（留给源①识别为缺口）。
        const description = isTopicEntity ? text.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
        const ref = `research:${String(topic || '').slice(0, 80)}`;
        const safeName = String(name).slice(0, 80);
        const id = knowledgeGraph.upsertEntity({ projectId: 'noe', name: safeName, type: 'concept', description, ref });
        if (id) { written += 1; entitiesWritten.push({ name: safeName, id }); }
        void count;
      }
      return { ok: true, written, candidates: ranked.length, entities: entitiesWritten };
    } catch (e) {
      return { ok: false, error: String(e?.message || e).slice(0, 120) };
    }
  }

  return { harvest };
}
