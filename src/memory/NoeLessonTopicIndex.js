// @ts-check
// NoeLessonTopicIndex — lesson 写入侧 topic 索引化的纯逻辑工具（M3 召回质量根因修复）。
//   背景：lesson(learning_lesson/skill_distill)的专属召回通道按 sourceType 圈定（解决「能进」），
//   但不按主题相关性排序（没解决「够准」）——同主题盲卡和无关 lesson 平权进 selected。
//   本模块从 goal.title / 认知修正正文提取 2-4 个 topic 关键词，写入时落进 memory.tags；
//   召回时用 query 关键词与 lesson tags 的重叠度加权排序，让「同主题」lesson 优先。
//   纯函数、零依赖、无 env 读取（门控 NOE_LESSON_TOPIC_INDEX 由调用方判定）；可单测、零全局抓取。

// 中英停用词（高频虚词/通用方法论套话），提取 topic 时剔除——否则「我/这/的/the/how」抢占 topic 槽。
//   只放真无信息量的词；保留库名/API/概念等具体名词。
const STOPWORDS = new Set([
  // 中文虚词/代词/方法论套话
  '我', '你', '他', '她', '它', '我们', '你们', '他们', '这', '那', '这个', '那个', '这些', '那些',
  '的', '了', '和', '与', '或', '是', '在', '有', '把', '被', '让', '给', '对', '从', '到', '为', '以',
  '就', '都', '也', '还', '又', '才', '很', '更', '最', '会', '能', '要', '该', '应', '该', '可以', '应该',
  '一个', '一些', '一条', '一种', '一次', '本次', '这次', '下次', '上次', '原来', '其实', '实际', '具体',
  '内容', '问题', '方法', '方式', '步骤', '流程', '东西', '事情', '时候', '之后', '之前', '现在', '今天',
  '认知', '修正', '经验', '技能', '总结', '记录', '学到', '学习', '研究', '理解', '掌握', '完成', '处理',
  '搜索', '阅读', '扫描', '打开', '查看', '点击', '发现', '注意', '没有', '不是', '不要', '不会', '需要',
  // 英文虚词/方法论
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'and', 'or', 'but', 'if', 'then', 'so', 'as', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from',
  'i', 'we', 'you', 'he', 'she', 'it', 'they', 'my', 'our', 'your', 'me', 'us', 'them',
  'how', 'what', 'when', 'where', 'why', 'which', 'who', 'do', 'does', 'did', 'can', 'could', 'should',
  'will', 'would', 'may', 'might', 'must', 'have', 'has', 'had', 'not', 'no', 'yes',
  'search', 'read', 'scan', 'open', 'learn', 'learned', 'study', 'note', 'step', 'task', 'goal',
]);

// 单字 CJK 虚词：2-gram 碎片只要含其中一个就判为噪声丢弃（治「我学」「到的」「的是」「是用」这类无意义碎片当 topic）。
const CJK_CHAR_STOP = new Set([
  '我', '你', '他', '她', '它', '的', '了', '和', '与', '或', '是', '在', '有', '把', '被', '让', '给',
  '对', '从', '到', '为', '以', '就', '都', '也', '还', '又', '才', '很', '更', '最', '会', '能', '要',
  '该', '应', '可', '上', '下', '中', '里', '个', '种', '条', '次', '这', '那', '其', '之', '用', '做',
  '说', '看', '想', '学', '先', '再', '后', '前', '们', '着', '过', '地', '得', '所', '于', '而', '及',
]);

// 写入侧前缀/装饰：title 常是「技能：<x>」「认知修正：<x>」，先剥掉再提取（否则「技能/认知/修正」混进 topic）。
const TITLE_DECORATION_RE = /^\s*(技能|认知修正|认知|修正|lesson|skill|经验|总结)\s*[:：]\s*/i;

/** 归一：小写化英文、去首尾空白。 */
function lower(s) {
  return String(s ?? '').toLowerCase();
}

/**
 * 把一段中英混排文本切成「候选 token 流」(含重复，每个出现位置一个条目)，并标注是否「整词」/是否词对齐。
 * - 英文/数字/带连字符或下划线的标识符整段保留(库名、API、配置键、版本号)，每出现一次记一次，weight=2(信息量高优先)。
 * - 连续中文片段(≤4字)记整词 weight=2；同时按 2-gram 滑窗切碎片 weight=1(兜底召回，但排序输给整词)。
 *   碎片标 aligned：起点在片段内偶数位(0/2/4…)的 bigram 多半落在真词边界上(中文复合词以双字为主)，
 *   起点奇数位的多半是「跨词碎片」(如「代理节点切换」起于位1的「理节」/位3的「点切」)。extract 据此剔跨词垃圾。
 * 频率统计在 extract 里基于本流做(不靠 indexOf 子串匹配，避免 node 被 node24 串数)。
 * @param {string} text
 * @returns {Array<{tok:string, weight:number, order:number, aligned?:boolean}>}
 */
export function tokenizeForTopicsStream(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return [];
  const out = [];
  let order = 0;
  // 1) 英文/数字/标识符（含 . _ - / 内部连接，如 better-sqlite3、qwen3-embedding:0.6b、core.hooksPath）。
  const enRe = /[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]|[A-Za-z0-9]/g;
  for (const m of raw.matchAll(enRe)) {
    const t = lower(m[0]).replace(/[._/-]+$/, '').replace(/^[._/-]+/, '');
    if (t.length >= 2) out.push({ tok: t, weight: 2, order: order++ });
  }
  // 2) 中文：抽出连续中文片段。短片段(≤4字,多为专名/术语)记整词 weight=2；
  //    长片段不整记(无词典切分易把「我学到的是用」整段当伪 topic)，只发 2-gram 滑窗碎片 weight=1 兜底。
  //    每个滑窗碎片标 aligned=(起点为偶数)：偶数起点的 bigram 落在自然双字词边界上(代理/节点/切换)，
  //    奇数起点的多半跨词(理节/点切)——extract 把「孤立(频次1)的非对齐跨词碎片」剔掉，治跨词垃圾。
  const zhSegs = raw.match(/[一-鿿]+/g) || [];
  for (const seg of zhSegs) {
    if (seg.length >= 2 && seg.length <= 4) out.push({ tok: seg, weight: 2, order: order++ });
    if (seg.length >= 2) {
      for (let i = 0; i + 2 <= seg.length; i += 1) {
        out.push({ tok: seg.slice(i, i + 2), weight: 1, order: order++, aligned: i % 2 === 0 });
      }
    }
  }
  return out;
}

/**
 * 去重候选集（兼容旧签名/外部直调）：返回 tokenizeForTopicsStream 的去重 tok 列表。
 * @param {string} text
 * @returns {string[]}
 */
export function tokenizeForTopics(text) {
  return [...new Set(tokenizeForTopicsStream(text).map((e) => e.tok))];
}

/**
 * 从文本提取 topic 关键词（写入侧落 tags、召回侧解析 query 都用它）。
 * 简单中英分词去停用词，按出现频率取高频；不引入任何新依赖。
 * @param {string} text                     原文（goal.title / 认知修正正文 / query）
 * @param {object} [opts]
 * @param {number} [opts.max=4]             最多取几个 topic（默认 4，配合「2-4 个」）
 * @param {number} [opts.minLen=2]          token 最短长度
 * @param {boolean} [opts.stripTitleDecoration=false]  先剥「技能：」「认知修正：」前缀
 * @returns {string[]}                      去重、按频率降序、稳定的小写 topic 列表
 */
export function extractLessonTopics(text, { max = 4, minLen = 2, stripTitleDecoration = false } = {}) {
  let src = String(text ?? '');
  if (stripTitleDecoration) src = src.replace(TITLE_DECORATION_RE, '');
  // weightedScore = Σ(出现次数 × weight)：整词(weight2)天然压过其 2-gram 碎片(weight1)，重复强调的主题词更高。
  const score = new Map();
  const firstSeen = new Map();
  const count = new Map();          // 原始出现次数（不乘 weight），用于跨词碎片的「孤立(频次1)」判定
  const everAligned = new Map();    // 该 token 是否至少出现过一次「词对齐」(偶数起点 bigram / 整词)
  const whole = new Set(); // weight>=2 出现过的「整词」（英文标识符 / CJK 整片段），用于压制被它覆盖的 2-gram 碎片
  for (const { tok, weight, order, aligned } of tokenizeForTopicsStream(src)) {
    if (tok.length < minLen) continue;
    if (STOPWORDS.has(tok)) continue;
    if (/^\d+$/.test(tok)) continue; // 纯数字不当 topic（噪声），但带字母的版本号(qwen3/node24)保留
    const isCjk = !/[A-Za-z0-9]/.test(tok);
    // CJK 2-gram 碎片含单字虚词 → 噪声丢弃（纯中文双字、weight=1 才查；英文不查）。
    if (tok.length === 2 && weight === 1 && isCjk
        && (CJK_CHAR_STOP.has(tok[0]) || CJK_CHAR_STOP.has(tok[1]))) continue;
    // CJK 整词(weight=2)首/尾字是单字虚词 → 多半是无词典切分粘连出的伪词(如「做了向量」起于「做」)，不当整词 topic。
    //   不 continue（让其内部的合法 2-gram 碎片仍有机会被收），只是不进 whole/不计高权。
    if (weight >= 2 && isCjk && tok.length >= 3
        && (CJK_CHAR_STOP.has(tok[0]) || CJK_CHAR_STOP.has(tok[tok.length - 1]))) continue;
    if (weight >= 2) whole.add(tok);
    if (!firstSeen.has(tok)) firstSeen.set(tok, order);
    score.set(tok, (score.get(tok) || 0) + weight);
    count.set(tok, (count.get(tok) || 0) + 1);
    // 整词(weight>=2)恒视为对齐；滑窗碎片看其 aligned 标记。任意一次对齐即标 true。
    if (weight >= 2 || aligned === true) everAligned.set(tok, true);
    else if (!everAligned.has(tok)) everAligned.set(tok, false);
  }
  // 「CJK 整词」(weight>=2 的 ≤4 字真词，如独立成段的「向量召回」)覆盖的字集——跨词碎片若与某真词共享字，
  //   多半是该真词的一部分(同主题)，保留它做兜底召回。注意：只取真整词的字，不取兄弟滑窗碎片的字——
  //   否则连续段里每个跨词碎片都与相邻碎片共享字，过滤会全失效(「理节」蹭「代理」的「理」逃逸)。
  const wholeWordChars = new Set();
  for (const w of whole) {
    if (w.length >= 2 && !/[A-Za-z0-9]/.test(w)) for (const ch of w) wholeWordChars.add(ch);
  }
  const cap = Math.max(1, Math.min(8, Number(max) || 4));
  const candidates = [...score.keys()].filter((tok) => {
    const isCjkBigram = tok.length === 2 && !/[A-Za-z0-9]/.test(tok);
    if (!isCjkBigram || whole.has(tok)) return true; // 标识符/整词不受碎片过滤约束
    // 压制 2-gram 碎片：若它是某个更长 CJK 整词的真子串（且自己没作为整词独立出现过），丢弃——
    //   「向量召回」存在时不再让碎片「向量」「召回」「量召」抢 topic 槽（但若「向量」自己独立成段也保留）。
    for (const w of whole) {
      if (w.length > 2 && !/[A-Za-z0-9]/.test(w) && w.includes(tok)) return false;
    }
    // 跨词碎片剔除：从未词对齐(只在奇数起点出现) + 孤立(全文仅 1 次) + 不与任何 CJK 整词共享字 → 判为跨词垃圾丢弃。
    //   治「代理节点切换」→「理节」「点切」、「备份失败不重试」→「败不」这类逃逸碎片；对齐碎片(代理/节点/切换)与重复碎片保留。
    if (everAligned.get(tok) === false && (count.get(tok) || 0) <= 1
        && !wholeWordChars.has(tok[0]) && !wholeWordChars.has(tok[1])) return false;
    return true;
  });
  return candidates
    // 加权分降序；同分按首次出现顺序稳定（确定性，可单测）。
    .sort((a, b) => (score.get(b) - score.get(a)) || (firstSeen.get(a) - firstSeen.get(b)))
    .slice(0, cap);
}

/**
 * 把提取出的 topic 合进既有 tags（去重、保序、限量），写入侧用。
 * 既有 tags（如 ['lesson','think'] / ['skill']）保留在前，topic 追加在后。
 * @param {string[]} existingTags
 * @param {string[]} topics
 * @param {number} [maxTags=40]
 * @returns {string[]}
 */
export function mergeTopicTags(existingTags = [], topics = [], maxTags = 40) {
  const seen = new Set();
  const out = [];
  for (const t of [...(Array.isArray(existingTags) ? existingTags : []), ...(Array.isArray(topics) ? topics : [])]) {
    const tag = String(t ?? '').trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= Math.max(1, maxTags)) break;
  }
  return out;
}

/**
 * 召回侧：给定 query 关键词集合与一条 lesson 的 tags，算重叠加权分（0..1+）。
 * 重叠 topic 越多分越高；归一到「重叠数 / query 关键词数」，再轻微奖励绝对重叠数（治 query 关键词少时分辨率不足）。
 * 无重叠返回 0（不惩罚，只是不加权）。
 * @param {string[]} queryTopics  query 提取出的关键词（小写）
 * @param {string[]} lessonTags   lesson 的 tags
 * @returns {{overlap:number, score:number, matched:string[]}}
 */
export function topicOverlapScore(queryTopics = [], lessonTags = []) {
  const q = new Set((Array.isArray(queryTopics) ? queryTopics : []).map((t) => String(t ?? '').toLowerCase()).filter(Boolean));
  if (!q.size) return { overlap: 0, score: 0, matched: [] };
  const matched = [];
  const seenTag = new Set();
  for (const raw of (Array.isArray(lessonTags) ? lessonTags : [])) {
    const tag = String(raw ?? '').toLowerCase();
    if (!tag || seenTag.has(tag)) continue;
    seenTag.add(tag);
    if (q.has(tag)) matched.push(tag);
  }
  const overlap = matched.length;
  if (!overlap) return { overlap: 0, score: 0, matched: [] };
  // 归一覆盖率 + 绝对重叠的对数奖励（封顶，防长 tags 刷分）。
  const coverage = overlap / q.size;
  const absBonus = Math.min(0.3, overlap * 0.1);
  return { overlap, score: coverage + absBonus, matched };
}
