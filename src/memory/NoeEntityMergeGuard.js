// @ts-check
// NoeEntityMergeGuard（P3-3 语义去重守卫）——合并两条记忆/实体前的「类型/实体守卫」，防带编号/版本/频率的
// 不同实体因文本高相似被误合（实证：graph-resolve 0.92 阈值在带编号/版本实体上 ~70% 误合，纯调阈值救不了）。
//
// 规则：抽取两侧的「区分性标识」（版本号 v1.2 / 编号后缀 x-1、#5 / 带单位数字 440Hz、300ms / 裸显著数字）；
//   两侧标识集合有差异（对称差非空）→ **禁合**（它们是编号/版本/频率变体，是不同实体）。
//   无任何标识 或 标识完全一致 → 不拦（交给文本/语义相似度照常判定）。
//   方向保守：拦 = 不合（最坏=两条相似记忆各留一份，不丢数据）；放 = 才可能误合丢数据。防数据损坏侧从严。

// 强标识：版本号 / 编号后缀 / 带单位数字（频率/时长/尺寸等）。
const VERSION_RE = /\bv?\d+(?:\.\d+)+\b/gi;                 // v1.2 / 1.2.3
const NUMBERED_SUFFIX_RE = /\b[\p{L}\w]+[-_#]\d+\b/giu;     // x-1 / item_10 / id#5
const UNIT_NUMBER_RE = /\b\d+(?:\.\d+)?\s?(?:hz|khz|mhz|ghz|ms|s|min|h|kb|mb|gb|tb|px|%|fps|bpm|°c|°f|元|次|个|条|首|张|天|月|年)\b/giu;
// 裸显著数字（≥2 位，避免把 1/2 这类太常见的词噪声化；含小数）。
const BARE_NUMBER_RE = /(?<![\w.])\d{2,}(?:\.\d+)?(?![\w%])/g;

function collect(text, re) {
  const s = String(text || '');
  const out = new Set();
  const m = s.match(re);
  if (m) for (const x of m) out.add(x.toLowerCase().replace(/\s+/g, ''));
  return out;
}

// 抽取一段文本的区分性标识集合。
export function extractEntityIdentifiers(text = '') {
  const ids = new Set();
  for (const re of [VERSION_RE, NUMBERED_SUFFIX_RE, UNIT_NUMBER_RE, BARE_NUMBER_RE]) {
    for (const x of collect(text, re)) ids.add(x);
  }
  return ids;
}

function symmetricDiff(a, b) {
  const out = [];
  for (const x of a) if (!b.has(x)) out.push(x);
  for (const x of b) if (!a.has(x)) out.push(x);
  return out;
}

/**
 * 是否应禁止合并 a、b（两侧标识集合有差异 → 不同编号/版本/频率实体）。
 * @returns {{block:boolean, reason:string, diff:string[], idsA:string[], idsB:string[]}}
 */
export function shouldBlockEntityMerge(a = '', b = '') {
  const idsA = extractEntityIdentifiers(a);
  const idsB = extractEntityIdentifiers(b);
  if (idsA.size === 0 && idsB.size === 0) {
    return { block: false, reason: 'no_identifiers', diff: [], idsA: [], idsB: [] };
  }
  const diff = symmetricDiff(idsA, idsB);
  if (diff.length > 0) {
    return { block: true, reason: 'distinct_numbered_or_versioned_entity', diff, idsA: [...idsA], idsB: [...idsB] };
  }
  return { block: false, reason: 'identifiers_match', diff: [], idsA: [...idsA], idsB: [...idsB] };
}
