// @ts-check
// NoeTopicDiscovery — P10 发现端增厚：动态发现研究主题（治「只有静态预定义主题表」）。
//
// 现状缺口（已诊断）：
//   · NoeLearningTopics.js 是「人工列死」的 6 主题种子 + 24 具体概念（NOE_LEARNING_TOPICS /
//     NOE_LEARNING_CONCEPTS），Neo 自己永远只能从这张静态表里轮转（NoeTopicCurator 的饱和冷却也
//     只是「在静态表里换着选」），不会从自身状态长出「该研究什么」的新主题种子。
//   · 发现端已有的真实信号源——记忆里反复出现却没深究的实体（NoeKnowledgeGraph.mention_count 高、
//     description 空）、好奇回路高好奇信号（NoeGoalSystem.harvestSurprise / curiosityScore）、
//     owner 未兑现承诺（NoeCommitmentStore 的 open 项）——都没有被汇成「研究主题种子」。
//
// 本模块做的事（不改任何现有文件，纯新增 DI 生成器）：
//   从三个真实状态源各抽信号 → 归一成「研究主题种子」{title, url, query, source, evidence}，
//   过质量闸（须含可定位技术对象/明确问题，拒情绪碎片）→ 去重（与静态表 + 近期已研究 + 自身互相）
//   → 返回候选列表。产物形状与 NoeTopicCurator.getNextTopic 的 dynamicConcepts 入参（{title,url,query}）
//   兼容，可直接喂给现有动态选题管道，或并入 DeepResearcher 候选——本模块只「发现+产种子」，
//   绝不自己发起研究/写库（点火驱动力留给调用方 + flag）。
//
// 工程纪律（与 NoeTopicCurator / NoeCuriosityDecompose 同款）：
//   - 注入式（DI）：所有数据源（kg / commitmentStore / goalSystem / staticConcepts / now / kv）从参数传入，
//     不全局乱抓、不碰时钟/网络/RNG/真模型；纯逻辑、确定性、可单测。
//   - 行为变化由 env NOE_TOPIC_DISCOVERY 门控，默认 OFF（factory 暴露 enabled，调用方自行分支）。
//     分量动作（自主发现会驱动自主研究），默认 OFF 留 owner kickstart。
//   - fail-open：任一数据源缺失/抛异常 → 该源贡献 0 个种子，绝不让坏数据污染、绝不抛穿。
//   - 质量闸借鉴 NoeSelfEvolutionTrigger 的 AUTOSEED 精神：种子须含可定位对象/明确问题，
//     去情绪碎片、去太短/太空、去停用词堆砌——不凭脏信号发起研究。

import { clamp01 } from './_mathUtils.js';

// 质量闸：种子标题/查询里至少要命中一个「可研究信号」——技术对象（英文标识符/驼峰/带数字版本号/
//   url 片段）或明确问句（为什么/怎么/how/why/what）。纯情绪/纯中文虚词碎片不过闸。
const TECH_OBJECT_RE = /[A-Za-z][A-Za-z0-9_.-]{2,}|[A-Za-z]+\d|\bv?\d+\.\d+|https?:\/\//;
const QUESTION_RE = /为什么|怎么|如何|是什么|为何|why|how|what|when|where|which/i;
// 同 QUESTION_RE 但带 g：用于从串里抠掉全部问句标记（中文无词边界，逐 token 判会误杀实义词）。
const QUESTION_STRIP_RE = /为什么|怎么|如何|是什么|为何|why|how|what|when|where|which/gi;
// 纯情绪/寒暄碎片（命中且无技术对象、无问句 → 判为情绪碎片，拒）。
// P10-fix(Opus审):外层 (?:…)+ 允许多词寒暄串(如 "ok thanks"/"thank you"/"谢谢晚安")整体判情绪——
//   否则多词寒暄只要含一个 ≥3 字母英文词(thanks)就被 TECH_OBJECT_RE 误当技术对象放行进研究池。
const EMOTION_FRAGMENT_RE = /^(?:(?:嗯+|啊+|哦+|哈+|呵+|谢谢|好的|加油|辛苦了|早安|晚安|晚上好|你好|love you|thank you|thanks?|ok|okay|hi|hello|nice|cool|haha)[\s!！。.~,，]*)+$/i;
// 太泛的占位词，单独出现没有研究价值（须配技术对象才放行）。英文按词去，中文按子串抠。
const VAGUE_WORDS_EN = new Set([
  'thing', 'things', 'stuff', 'something', 'anything', 'todo', 'task', 'item', 'note',
]);
const VAGUE_CN = ['事情', '东西', '问题', '内容', '情况', '一下', '这个', '那个', '什么', '怎么'];

/** 安全字符串：trim + 截断；非字符串归一为空串。 */
function s(value, max = 240) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

/** 稳定 key：优先 url，退而归一标题（小写去多余空白）——用于跨源/跨静态表去重。 */
function seedKey(seed) {
  const url = s(seed?.url, 400).toLowerCase();
  if (url) return `u:${url}`;
  const title = s(seed?.title, 400).toLowerCase().replace(/\s+/g, ' ');
  const query = s(seed?.query, 400).toLowerCase().replace(/\s+/g, ' ');
  return `t:${title || query}`;
}

/**
 * 质量闸：判一条种子是否「值得研究」。
 *   过闸条件（与情绪碎片/空泛碎片二分）：
 *     · 标题或查询非空且去空白后长度 ≥ minLen；
 *     · 不是纯情绪/寒暄碎片；
 *     · 命中至少一个可研究信号：技术对象 或 明确问句；
 *     · 去掉技术对象后若只剩泛词/停用词，仍需有技术对象兜底（防「研究一下这个东西」过闸）。
 * @param {{title?:string, query?:string}} seed
 * @param {{minLen?:number}} [opts]
 * @returns {{ok:boolean, reason:string}}
 */
export function isResearchableSeed(seed, { minLen = 4 } = {}) {
  const title = s(seed?.title, 240);
  const query = s(seed?.query, 240);
  const probe = `${title} ${query}`.trim();
  if (!probe || probe.length < minLen) return { ok: false, reason: 'too_short' };
  // 纯情绪/寒暄碎片：标题与查询都判定为情绪碎片才拒（任一为实质内容即继续）。
  const titleEmotion = !title || EMOTION_FRAGMENT_RE.test(title);
  const queryEmotion = !query || EMOTION_FRAGMENT_RE.test(query);
  if (titleEmotion && queryEmotion) return { ok: false, reason: 'emotion_fragment' };

  const hasTech = TECH_OBJECT_RE.test(probe);
  const hasQuestion = QUESTION_RE.test(probe);
  if (!hasTech && !hasQuestion) return { ok: false, reason: 'no_research_signal' };

  // 防「问句 + 纯泛词」（如「这个东西是什么」）：有问句但无技术对象时，须含至少一个非泛词实义词。
  //   先把问句标记词从串里抠掉（中文无词边界，逐 token 判 QUESTION_RE 会把「为什么记忆召回」整块误杀），
  //   再看剩余内容是否还有非泛词的实义片段。
  // P10-fix(M3+Codex审):泛词检查不再只在 !hasTech 路径——TECH_OBJECT_RE 把任意 ≥3 字母英文词(thing/stuff/todo)
  //   当技术对象,hasTech=true 会绕过此检查放行泛词种子。改为总是剥泛词看剩余实义内容(真技术词如 memory/agent 自然留存)。
  {
    let stripped = probe.toLowerCase().replace(QUESTION_STRIP_RE, ' ');
    // 中文无词边界：把已知泛词子串整条抠掉，看是否还剩实义中文片段（避免滑窗 bigram 造出「个东」之类伪词）。
    for (const cn of VAGUE_CN) stripped = stripped.split(cn).join(' ');
    const enWords = (stripped.match(/[a-z0-9]{2,}/g) || []).filter((w) => !VAGUE_WORDS_EN.has(w));
    const cnLeft = stripped.match(/[一-鿿]{2,}/g) || []; // 抠掉泛词后仍 ≥2 字的中文 = 实义内容
    if (!enWords.length && !cnLeft.length) return { ok: false, reason: 'only_vague_terms' };
  }
  return { ok: true, reason: 'researchable' };
}

/** 把一个实体名/概念编成 github 仓库搜索 url（一定有效、列出真实项目）——与 NOE_LEARNING_CONCEPTS 同口径。 */
function repoSearchUrl(term) {
  const q = encodeURIComponent(s(term, 120));
  return `https://github.com/search?q=${q}&type=repositories`;
}

/**
 * 源①：记忆里反复出现但未深究的实体/概念。
 *   信号 = NoeKnowledgeGraph 的 noe_kg_entity：mention_count 高（反复出现）+ description 空/极短（没深究）。
 *   用 kg.search 拿候选行（含 mention_count/description），本模块只读不写。
 * @param {{ search?: Function }|null} kg
 * @param {{minMentions?:number, maxDescLen?:number, limit?:number, probes?:string[]}} cfg
 * @returns {Array<{title:string,url:string,query:string,source:string,evidence:object,score:number}>}
 */
function fromUnexploredEntities(kg, { minMentions = 3, maxDescLen = 12, limit = 8, probes = [], coldStartBoost = false } = {}) {
  if (!kg || typeof kg.search !== 'function') return [];
  try {
    // 用一组宽 probe 扫库（kg.search 是 LIKE 模糊匹配；空 probe 时退回单次空查询取高频实体）。
    const queries = Array.isArray(probes) && probes.length ? probes : [''];
    const seen = new Set();
    /** @type {Array<{name:string,mention:number,descLen:number,type:string}>} */
    const rows = [];
    for (const q of queries) {
      let res;
      try { res = kg.search({ q: s(q, 200), limit: 100 }); } catch { continue; }
      for (const e of (res?.entities || [])) {
        const name = s(e?.name, 120);
        if (!name) continue;
        const k = name.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        rows.push({
          name,
          mention: Number(e?.mention_count) || 0,
          descLen: s(e?.description, 4000).length,
          type: s(e?.type, 40),
        });
      }
    }
    // 反复出现（mention ≥ 阈值）但没深究（description 空/极短）= 知识缺口。
    // 实体名非泛词 + 未深究(desc 短)才算知识缺口（泛词 name 过滤理由见 P10-fix(M3+Codex审)：
    //   query 模板的实义词会救泛词 name 绕过质量闸，故实体名本身是 VAGUE 即不当知识缺口）。
    const notVagueDeep = (r) => {
      if (r.descLen > maxDescLen) return false;
      const nm = s(r.name, 120).toLowerCase().trim();
      return !!nm && !VAGUE_WORDS_EN.has(nm) && !VAGUE_CN.includes(nm);
    };
    let gaps = rows.filter((r) => r.mention >= minMentions && notVagueDeep(r));
    // research 多样化·冷启动自适应（coldStartBoost）：mention≥minMentions 的缺口不足 limit 时，把 mention≥1 的
    //   未深究新实体也当种子——治 KG 冷启动期实体多为 mention=1(刚抽出未反复出现)、绝大多数被阈值挡掉、主题不够多样。
    //   KG 积累后 mention 自然涨过阈值、缺口够了就不再放宽（自限，不长期稀释）。
    if (coldStartBoost && gaps.length < limit) {
      const have = new Set(gaps.map((g) => g.name.toLowerCase()));
      const more = rows.filter((r) => r.mention >= 1 && r.mention < minMentions && notVagueDeep(r) && !have.has(r.name.toLowerCase()));
      gaps = [...gaps, ...more];
    }
    gaps = gaps.sort((a, b) => b.mention - a.mention).slice(0, Math.max(0, limit));
    return gaps.map((r) => ({
      title: `搞清楚反复出现却没深究的「${r.name}」到底是什么、该怎么用`,
      url: repoSearchUrl(r.name),
      query: `${r.name} explained best practices how to use`,
      source: 'unexplored_entity',
      evidence: { name: r.name, mentionCount: r.mention, type: r.type },
      // 归一分：提及越多越该补；description 越空越该补。
      score: clamp01(r.mention / (r.mention + 5)),
    }));
  } catch { return []; }
}

/**
 * 源②：好奇回路高好奇信号。
 *   信号 = NoeGoalSystem 里 source='surprise' 的目标（harvestSurprise 立的「搞明白为什么没料到」），
 *   它的 meta.curiosity.score 是 NoeCuriosityDecompose 的双因子好奇分。读高好奇且尚未转成研究种子的，
 *   抽出 claim 作主题。本模块只读 goalSystem.list（不写、不立项）。
 * @param {{ list?: Function }|null} goalSystem
 * @param {{minCuriosity?:number, limit?:number}} cfg
 * @returns {Array<{title:string,url:string,query:string,source:string,evidence:object,score:number}>}
 */
function fromCuriositySignals(goalSystem, { minCuriosity = 0.5, limit = 6 } = {}) {
  if (!goalSystem || typeof goalSystem.list !== 'function') return [];
  try {
    // P10-fix(Opus审):真实 NoeGoalSystem.list({status,limit}) 不支持 source 过滤——必须 JS 内自筛,
    //   否则 reflection/owner 等所有来源目标都被当好奇种子(无 meta.curiosity 的普通目标拿保守 0.5 照样过闸)。
    const goals = goalSystem.list({ limit: 200 }) || [];
    const out = [];
    for (const g of goals) {
      if (s(g?.source, 40) !== 'surprise') continue; // 只认 harvestSurprise 立的 surprise 目标
      const meta = g?.meta && typeof g.meta === 'object' ? g.meta : null;
      const cur = meta?.curiosity && typeof meta.curiosity === 'object' ? meta.curiosity : null;
      // 有双因子分用之；没有（NOE_EFE_CURIOSITY OFF 时不写 meta）则按「能立项即过 2bit 阈值」给保守 0.5。
      const score = cur && Number.isFinite(Number(cur.score)) ? clamp01(Number(cur.score)) : 0.5;
      if (score < minCuriosity) continue;
      // claim 藏在 title「搞明白为什么没料到：<claim>」里，剥前缀拿研究对象。
      const title = s(g?.title, 240);
      const claim = title.replace(/^搞明白为什么没料到[:：]?/, '').trim() || title;
      if (!claim) continue;
      out.push({
        title: `深入研究我没料到的情况：${claim}`,
        url: repoSearchUrl(claim),
        query: `${claim} why explanation root cause`,
        source: 'curiosity_signal',
        evidence: { claim, curiosity: score, label: cur?.label || 'unknown', goalId: g?.id || null },
        score,
      });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, Math.max(0, limit));
  } catch { return []; }
}

/**
 * 源③：owner 未兑现承诺 / 未解开放回路。
 *   信号 = NoeCommitmentStore 的 open 项（open_loop/task 类最像「该去查/该去做」的研究触发；
 *   reminder/event_check_in 多是日程提醒，研究价值低，默认排除）。本模块只读 list（不 resolve）。
 * @param {{ list?: Function }|null} commitmentStore
 * @param {{categories?:string[], limit?:number}} cfg
 * @returns {Array<{title:string,url:string,query:string,source:string,evidence:object,score:number}>}
 */
function fromOpenCommitments(commitmentStore, { categories = ['open_loop', 'task'], limit = 6 } = {}) {
  if (!commitmentStore || typeof commitmentStore.list !== 'function') return [];
  try {
    const open = commitmentStore.list({ status: 'open' }) || [];
    const wanted = new Set(categories);
    const out = [];
    for (const c of open) {
      if (wanted.size && !wanted.has(s(c?.category, 40))) continue;
      const text = s(c?.text, 240);
      if (!text) continue;
      out.push({
        title: `推进未兑现的开放回路：${text}`,
        url: repoSearchUrl(text),
        query: text,
        source: 'open_commitment',
        evidence: { commitmentId: c?.id || null, category: s(c?.category, 40), text },
        // care 类（关心 owner 的）优先级稍高于 routine。
        score: s(c?.sensitivity, 40) === 'care' ? 0.7 : 0.55,
      });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, Math.max(0, limit));
  } catch { return []; }
}

/**
 * 工厂：动态主题发现器。
 * @param {object} [deps]
 * @param {{search:Function}|null} [deps.kg] NoeKnowledgeGraph 实例（只读 search）——源①
 * @param {{list:Function}|null} [deps.goalSystem] NoeGoalSystem 实例（只读 list）——源②
 * @param {{list:Function}|null} [deps.commitmentStore] NoeCommitmentStore 实例（只读 list）——源③
 * @param {{get:Function}|null} [deps.kv] 取 NoeTopicCurator 的访问账本（noe.learning.topicArchive.v1）做近期已研究去重
 * @param {Array<{title?:string,url?:string,query?:string}>} [deps.staticConcepts] 静态表（NOE_LEARNING_CONCEPTS）——去重基准
 * @param {boolean} [deps.enabled] 显式覆盖；缺省读 env NOE_TOPIC_DISCOVERY === '1'（默认 OFF）
 * @param {() => number} [deps.now]
 * @param {object} [deps.config] 各源参数覆盖：{ entity, curiosity, commitment, totalCap }
 */
export function createTopicDiscovery({
  kg = null,
  goalSystem = null,
  commitmentStore = null,
  kv = null,
  staticConcepts = [],
  enabled,
  now = Date.now,
  config = {},
} = {}) {
  const on = typeof enabled === 'boolean' ? enabled : process.env.NOE_TOPIC_DISCOVERY === '1';
  const cfg = config && typeof config === 'object' ? config : {};
  // research 多样化·冷启动 boost（NOE_TOPIC_COLD_START_BOOST，默认 OFF）：注入源① entity cfg，让 KG 冷启动期新实体也能成种子。
  const coldStartBoost = typeof cfg.coldStartBoost === 'boolean' ? cfg.coldStartBoost : process.env.NOE_TOPIC_COLD_START_BOOST === '1';
  const entityCfg = { ...(cfg.entity || {}), coldStartBoost };
  const totalCap = Math.max(1, Math.round(Number(cfg.totalCap)) || 12);
  const KV_ARCHIVE = 'noe.learning.topicArchive.v1';

  /**
   * 构建去重黑名单：
   *   · keys：静态表 seedKey + curator 访问账本键（近期已研究）——URL/标题精确去重。
   *   · nameBlob：静态表 + 账本的全部标题/查询拼成的小写大串——用于「同概念不同 query 串」的名级兜底
   *     去重（如静态表 Letta 的 url 是 ?q=Letta+MemGPT，实体源生成 ?q=Letta，URL 不同但其实同概念）。
   */
  function buildKnown() {
    const keys = new Set();
    const blobParts = [];
    // 静态表（与 NOE_LEARNING_CONCEPTS 重复的不再发现）
    if (Array.isArray(staticConcepts)) {
      for (const c of staticConcepts) {
        const k = seedKey(c);
        if (k) keys.add(k);
        blobParts.push(`${s(c?.title, 240)} ${s(c?.query, 240)}`);
      }
    }
    // curator 访问账本：archive 的键本身就是 topicKey（url||title 小写）——这正是「近期已研究」。
    try {
      const archive = kv && typeof kv.get === 'function' ? kv.get(KV_ARCHIVE) : null;
      if (archive && typeof archive === 'object') {
        for (const [key, rec] of Object.entries(archive)) {
          const norm = s(key, 400).toLowerCase();
          if (!norm) continue;
          // archive 键无 u:/t: 前缀；同时按 url 形态和标题形态都加入，覆盖两种 seedKey 命中。
          keys.add(`u:${norm}`);
          keys.add(`t:${norm}`);
          blobParts.push(`${norm} ${s(rec?.title, 240)}`);
        }
      }
    } catch { /* 账本读失败不阻断发现，只是少了一层去重 */ }
    return { keys, nameBlob: blobParts.join(' \n ').toLowerCase() };
  }

  /**
   * 发现：从三源各抽种子 → 质量闸 → 去重（跨静态表/账本/源间） → 按分排序截断。
   * @param {{ entityProbes?:string[], minQuality?:number }} [opts]
   * @returns {{ enabled:boolean, seeds:Array<object>, dropped:{quality:number,duplicate:number}, bySource:Record<string,number> }}
   */
  function discover({ entityProbes = [], minQuality = 4 } = {}) {
    if (!on) return { enabled: false, seeds: [], dropped: { quality: 0, duplicate: 0 }, bySource: {} };

    const raw = [
      ...fromUnexploredEntities(kg, { ...entityCfg, probes: entityProbes }),
      ...fromCuriositySignals(goalSystem, cfg.curiosity || {}),
      ...fromOpenCommitments(commitmentStore, cfg.commitment || {}),
    ];

    const { keys: known, nameBlob } = buildKnown();
    const picked = new Set();
    const seeds = [];
    let qualityDropped = 0;
    let dupDropped = 0;
    let sourceCapDropped = 0;
    // per-source cap（防单源刷屏：单源最多占 totalCap 的 maxSourceRatio，留名额给其他源保多样性，治审查 Finding「某源刷满挤掉别源」）。
    //   maxSourceRatio 默认 1.0=不限(逐字零回归)；生产装配传 0.5 启用防刷屏。
    const perSourceCount = {};
    const srcRatio = Number.isFinite(Number(cfg.maxSourceRatio)) && Number(cfg.maxSourceRatio) > 0 ? Number(cfg.maxSourceRatio) : 1;
    const maxPerSource = Math.max(1, Math.ceil(totalCap * srcRatio));
    // 高分优先（让有限的 totalCap 名额留给最值得研究的）。
    raw.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
    for (const seed of raw) {
      const q = isResearchableSeed(seed, { minLen: minQuality });
      if (!q.ok) { qualityDropped += 1; continue; }
      const key = seedKey(seed);
      if (!key || known.has(key) || picked.has(key)) { dupDropped += 1; continue; }
      // 名级兜底去重：实体源种子的核心对象名（evidence.name）若已出现在静态表/账本里（同概念不同
      //   query 串、url 不同 → 上面 key 去重漏掉），也算重复。名须够长（≥3 字符）避免误伤短名。
      // P10-fix(M3+Codex审):curiosity(evidence.claim)/commitment(evidence.text)源无 evidence.name → 名级去重原在 2/3 源失效。
      //   回退:从 query 抽首个技术词当去重名,让「同概念不同 query 串」跨源也能去重(如承诺源生成 LangGraph url 的 %20 变体)。
      let ename = s(seed?.evidence?.name, 120).toLowerCase();
      if (!ename) {
        const qm = s(seed?.query, 200).match(/[A-Za-z][A-Za-z0-9_.-]{2,}/);
        ename = qm ? qm[0].toLowerCase() : '';
      }
      // P10-fix(Opus审):名级去重用词边界(\b)而非裸 includes——防短名撞子串(RAG vs sto[rag]e / AST vs F[ast]API /
      //   AGE vs im[age])误删高频真实技术实体。\b 对纯中文名无效→含中文的名回退上面 key/账本去重(中文技术名子串撞概率低)。
      if (ename && ename.length >= 3) {
        const enameRe = new RegExp('\\b' + ename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
        if (enameRe.test(nameBlob)) { dupDropped += 1; continue; }
      }
      // per-source cap：单源占满则后续该源种子丢，留名额给其他源（多样性，防一波同源刷屏）。
      const src = String(seed.source || 'unknown');
      if ((perSourceCount[src] || 0) >= maxPerSource) { sourceCapDropped += 1; continue; }
      perSourceCount[src] = (perSourceCount[src] || 0) + 1;
      picked.add(key);
      seeds.push({ ...seed, discoveredAt: now() });
      if (seeds.length >= totalCap) break;
    }
    /** @type {Record<string, number>} */
    const bySource = {};
    for (const sd of seeds) bySource[sd.source] = (bySource[sd.source] || 0) + 1;
    return { enabled: true, seeds, dropped: { quality: qualityDropped, duplicate: dupDropped, sourceCap: sourceCapDropped }, bySource };
  }

  /**
   * 兼容产物：把发现的种子降成 NoeTopicCurator.getNextTopic 的 dynamicConcepts 入参（{title,url,query}），
   *   可直接喂现有动态选题管道（与 collectLearningConcepts 并列），无需调用方理解 source/evidence。
   * @param {{ entityProbes?:string[], minQuality?:number }} [opts]
   * @returns {Array<{title:string,url:string,query:string}>}
   */
  function discoverConcepts(opts = {}) {
    return discover(opts).seeds.map((sd) => ({ title: sd.title, url: sd.url, query: sd.query }));
  }

  return {
    enabled: on,
    discover,
    discoverConcepts,
    // 暴露纯函数便于调用方/测试单独验质量闸。
    isResearchableSeed,
  };
}
