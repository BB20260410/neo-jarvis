// @ts-check
// NoeMemoryDedup — 记忆写入去重/冲突合并的确定性判定（借鉴 mem0 的 ADD/UPDATE 模式，本地化零 LLM）。
//
// 治什么：MemoryCore 写入基本是 append——"我喜欢美式""我改喝拿铁了"会并存矛盾记忆，召回两条都喂大脑。
// mem0 的做法是写入时用 LLM 判 ADD/UPDATE/DELETE/NOOP；这里用本机字符级相似度做**确定性**判断
// （零额外 LLM 调用、零联网）：与近期同 scope 记忆高度相似 → UPDATE 替换并记 merge_trace，否则 ADD。
// 保守优先：判定模糊一律 ADD（宁可留两条，绝不误删真记忆）；身份级铁律记忆（salience 高）不参与被替换。
// 能力边界（诚实标注）：字符 bigram 相似度只抓「近重复」（同句反复写/追加细节/加语气词）——这是对话记忆
// 堆积的真实主因；「换关键词的语义矛盾」（我喜欢美式 → 我改喝拿铁）字符法抓不到——这一类由下面的
// decideSemanticConflict 语义版补上（方向三）：向量相似度从 MemoryCore.semanticIndex 拿，本模块仍零 LLM 纯判定。

/** 归一化：去空白与标点，仅留中文/字母/数字，小写——让"我喜欢美式。"与"我喜欢美式"判为同源。 */
export function normalizeForDedup(text) {
  // 审计 §3.3 P2③：原 `一-鿿` 仅基本汉字区，漏 CJK 扩展区(扩展A/B…)与全角数字（被当标点删）；
  // 用 \p{Script=Han}(/u) 覆盖全部汉字，并保留全角数字 ０-９（否则含扩展字/全角数字的记忆去重失真）。
  return String(text || '')
    .toLowerCase()
    .replace(/[^0-9a-z０-９\p{Script=Han}]+/gu, '');
}

/** 字符 bigram 集合（中文按字、英文数字按字符滑窗），用于 Jaccard。 */
function bigrams(s) {
  const set = new Set();
  if (s.length === 1) { set.add(s); return set; }
  for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
  return set;
}

/**
 * 已归一化输入的 bigram Jaccard 内核（性能：供 decideMemoryWrite 循环复用——把"incoming 归一化 +
 * incoming bigram 集合"提到循环外，每个候选不再重复算同一段 incoming）。
 * 行为与 textSimilarity 逐字等价：空/单空/全等的判定顺序、union 兜底完全一致，且
 * `getBa` 是惰性 getter——仅在真正进入 Jaccard 分支时才求 incoming 的 bigram 集合，
 * 故 textSimilarity 在空/全等早返回路径上不做任何额外计算（只更快不更慢）。
 * @param {string} na 已 normalizeForDedup 的 a
 * @param {() => Set<string>} getBa 返回 bigrams(na) 的惰性 getter（建议外层 memoize 复用）
 * @param {string} nb 已 normalizeForDedup 的 b
 */
function bigramJaccardNormalized(na, getBa, nb) {
  if (!na && !nb) return 0;  // 两段归一化后皆空(纯标点/emoji/全角符号)不算相似，避免误合并不同内容
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ba = getBa();
  const bb = bigrams(nb);
  let inter = 0;
  for (const g of ba) if (bb.has(g)) inter += 1;
  const union = ba.size + bb.size - inter;
  return union ? inter / union : 0;
}

/**
 * 两段文本的相似度 0..1（bigram Jaccard）。完全相同=1，毫不相干≈0。
 * 对"我喜欢喝美式咖啡"vs"我喜欢喝拿铁咖啡"这类只改关键词的句子给中高分（命中合并候选后再看 shouldUpdate）。
 */
export function textSimilarity(a, b) {
  const na = normalizeForDedup(a);
  const nb = normalizeForDedup(b);
  return bigramJaccardNormalized(na, () => bigrams(na), nb);
}

/**
 * 在候选记忆里挑出"应当被本次写入 UPDATE 替换"的那条。
 * @param {{body: string, scope?: string, salience?: number}} incoming 本次写入
 * @param {Array<{id: string, body: string, scope?: string, salience?: number}>} candidates 同 project 近期记忆
 * @param {object} [opts]
 * @param {number} [opts.threshold] 相似度阈值（默认 0.62，近重复去重——字符法只抓"追加内容/加语气词"型近重复；
 *        换了关键词的语义矛盾如"美式→拿铁"字符相似度仅 ~0.4 不会合并，那需向量/LLM 语义版，是后续升级方向）
 * @param {number} [opts.protectSalience] 此 salience 及以上的记忆不被替换（身份级铁律，默认 5）
 * @returns {{action: 'add'|'update', target?: object, similarity?: number}}
 */
// 前缀包含判据（深析改进#3）：短句+追加细节型（"明天三点开会"→"明天三点开会，在会议室A"）
// 原句越短 Jaccard 被追加部分稀释越狠（实测 0.58/0.60 漏过 0.62 阈值），但"一段是另一段的前缀"
// 这个结构本身就是强近重复信号——归一化后前缀包含且短方 ≥6 字 → 直接判近重复。
// 审计 §3.3 P0-6：原判据只看前缀关系，会把"短句 + 一大堆无关新事实"（"明天三点开会"→
// "明天三点开会在A室另外下周去北京出差讨论项目"）也强制拉满到阈值误合并、丢失新事实。
// 加长度膨胀约束：长方不超过短方 maxExpandRatio(2) 倍——温和细化才算近重复，大幅追加视为独立记忆。
// 已归一化输入的前缀包含内核（性能：decideMemoryWrite 直接传已归一化的 incoming/candidate 复用，
// 不再像旧 isPrefixContainment(a,b) 包装那样每次重复 normalizeForDedup）。判定逐字等价：
// 短/长按归一化长度划分，短方 ≥minLen 且为长方前缀且长方 ≤短方×maxExpandRatio 才算近重复。
function isPrefixContainmentNormalized(na, nb, minLen = 6, maxExpandRatio = 2) {
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  return short.length >= minLen && long.startsWith(short) && long.length <= short.length * maxExpandRatio;
}

/**
 * 语义冲突判定（方向三：把去重从字符升级到语义——"我喜欢美式 → 我改喝拿铁"这类换关键词矛盾）。
 * 纯函数零 LLM：向量分（调用方从 semanticIndex 拿）+ 字符分双指标联判——
 *   vecScore ≥ semanticThreshold＝语义上说的是同一件事（同一偏好/事实槽位）；
 *   charSim < charThreshold＝字符法没判近重复（近重复归 decideMemoryWrite 字符路合并，不归这里）。
 * 保守优先（与字符路同款铁律）：跨 scope / salience 受保护 / 向量分不够 / 文本太短（嵌入噪声大），一律不判冲突。
 * @param {{body: string, scope?: string}} incoming 本次写入
 * @param {{id: string, body: string, scope?: string, salience?: number}} candidate 向量召回的旧记忆
 * @param {object} [opts]
 * @param {number} [opts.vecScore] 两者向量相似度 0..1（来自 semanticIndex.search 的 score）
 * @param {number} [opts.semanticThreshold] 语义同位阈值（默认 0.82，故意偏高——宁可漏合并绝不误删）
 * @param {number} [opts.charThreshold] 字符近重复阈值（默认 0.62，≥此值归字符路）
 * @param {number} [opts.protectSalience] 此 salience 及以上不被替换（默认 5）
 * @param {number} [opts.minLen] 归一化后短于此长度不参与（默认 6，短句嵌入分不可靠）
 * @returns {{conflict: boolean, reason?: string, vecScore?: number, charSim?: number}}
 */
export function decideSemanticConflict(incoming, candidate, {
  vecScore = 0, semanticThreshold = 0.82, charThreshold = 0.62, protectSalience = 5, minLen = 6,
} = {}) {
  const a = String(incoming?.body || '');
  const b = String(candidate?.body || '');
  if (!a || !b || candidate?.id == null) return { conflict: false, reason: 'empty' };
  if ((incoming?.scope || 'project') !== (candidate?.scope || 'project')) return { conflict: false, reason: 'scope' };
  if (Number(candidate?.salience) >= protectSalience) return { conflict: false, reason: 'protected' };
  if (normalizeForDedup(a).length < minLen || normalizeForDedup(b).length < minLen) return { conflict: false, reason: 'too_short' };
  if (!(Number(vecScore) >= semanticThreshold)) return { conflict: false, reason: 'low_vec' };
  const charSim = textSimilarity(a, b);
  if (charSim >= charThreshold) return { conflict: false, reason: 'near_dup_char_path' };
  return { conflict: true, vecScore: Number(vecScore), charSim };
}

export function decideMemoryWrite(incoming, candidates = [], { threshold = 0.62, protectSalience = 5 } = {}) {
  const body = String(incoming?.body || '');
  if (!body || !Array.isArray(candidates) || !candidates.length) return { action: 'add' };
  const incScope = incoming?.scope || 'project';
  // 性能（热路径：每次 memory.write() 对最多 scanLimit≈25 条候选跑此循环）：把"incoming 归一化 +
  // incoming bigram 集合"提到循环外算一次，候选不再各算一遍同一段 incoming。incBigrams 惰性 memoize
  // ——空 incoming/全等命中等早返回路径上不求 bigram。每候选的 candidate 也只归一化一次（原先
  // textSimilarity 与 isPrefixContainment 各归一化一遍，重复两次）。realSim/contained/sim 逐字等价。
  const incNorm = normalizeForDedup(body);
  let incBigrams = null;
  const getIncBigrams = () => (incBigrams ?? (incBigrams = bigrams(incNorm)));
  let best = null;
  for (const c of candidates) {
    if (!c || !c.body || c.id == null) continue;
    if ((c.scope || 'project') !== incScope) continue;        // 只在同 scope 内合并，跨 scope 各管各
    if (Number(c.salience) >= protectSalience) continue;       // 身份级铁律记忆只增不替
    const cNorm = normalizeForDedup(c.body);
    const realSim = bigramJaccardNormalized(incNorm, getIncBigrams, cNorm);
    const contained = isPrefixContainmentNormalized(incNorm, cNorm);
    // 过阈判定用 clamp 后的分(前缀包含拉到阈值)；但 best 的择优按真实相似度比较，
    // 避免多个前缀包含候选都被 clamp 到阈值并列时、误选候选顺序靠前而非最相似的那条
    const sim = contained ? Math.max(realSim, threshold) : realSim;
    if (sim >= threshold && (!best || realSim > best.realSim)) best = { target: c, similarity: sim, realSim };
  }
  // 完全一致(sim≈1)也算 update：等于刷新 updated_at + 记一次 merge_trace，避免库里堆同一句
  return best ? { action: 'update', target: best.target, similarity: best.similarity } : { action: 'add' };
}
