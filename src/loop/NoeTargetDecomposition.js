// @ts-check
// NoeTargetDecomposition — 阶段二·难目标分解(治本地模型编造 from 的根因)。
//
// 2B(编造 from → re-ask)是治标:题库首验未抬,因为大改动本身就让模型产大 diff、大 from,越大越难逐字复制、越容易编造。
// 治本 = 对复杂目标约束模型「只做最小的、单一的第一步」:小改动=小 from=能逐字复制=可 apply。飞轮下一拍再推进下一步,
//   把「一个改不动的大目标」变成「一串改得动的小步」。纯函数 gate + 指令段,fail-open。flag NOE_SELFEVO_DECOMPOSE 门控。

// 多改动子句的信号:并/且/以及/、/;/ and /,then（一个 objective 想同时干好几件事 = 复杂）。
const MULTI_CLAUSE_RE = /并且|以及|、|；|;|\band\b|,\s*then|还要|同时/i;

/**
 * 判目标是否复杂到该分解(约束最小第一步)。文件长 或 目标含多改动子句 → 该分解。
 * @param {object} [args]
 * @param {string} [args.objective]
 * @param {string} [args.fileContent] 目标文件当前内容(判长度)
 * @param {number} [args.maxLines] 文件超此行数算复杂(默认 60)
 * @returns {{ decompose: boolean, reason: string }}
 */
export function shouldDecompose({ objective = '', fileContent = '', maxLines = 60 } = {}) {
  const obj = String(objective || '');
  const lines = String(fileContent || '').split('\n').length;
  if (lines > maxLines) return { decompose: true, reason: `file_long(${lines}>${maxLines})` };
  if (MULTI_CLAUSE_RE.test(obj)) return { decompose: true, reason: 'multi_clause_objective' };
  return { decompose: false, reason: 'simple' };
}

/**
 * 约束模型「只做最小第一步」的指令段(附到 implement prompt)。
 * @returns {string}
 */
export function buildDecompositionInstruction() {
  return [
    '\n\n【难目标分解 · 只做最小第一步】这是一个复杂目标,不要一次改完。',
    '只做朝目标推进的**单一、最小、最内聚**的一处改动(理想 1 个 op、最多 2 个),',
    '"from" 必须短且从上面文件内容逐字复制(越短越不会编造);找不到确切短片段就用 op:write_file。',
    '把剩余部分留给后续迭代——飞轮下一拍会继续推进。宁可小而准,不要大而错。',
  ].join('');
}
