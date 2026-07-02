// @ts-check

/**
 * P6 记忆召回基准 —— 纯函数评分层（execution-based，无 IO / 无 LLM-judge）。
 *
 * 设计要点（与 owner 约束对齐）：
 * - 评分一律比对「召回到的 memory id / 内容」是否覆盖期望、是否踩中对抗干扰项，不调模型当裁判。
 * - pass^k：每题独立跑 k 次，k 次全过才算这题 pass（最严格口径，治「偶尔蒙对」）。
 * - 置信区间：题级 pass^k 比例用 Wilson score interval（小样本比单纯正态近似更稳，不会越界 [0,1]）。
 * - 全部纯函数：输入普通对象，输出普通对象；不碰 db、不碰网络、不读时钟做判定（latency 由 runner 注入）。
 *
 * 术语：
 * - run：一题的「一次」召回结果（含 selectedIds / hitIds）。
 * - case（题）：跑 k 个 run。
 */

/** @typedef {{selectedIds?: string[], hitIds?: string[], ok?: boolean}} BenchRun */
/** @typedef {{
 *   id: string,
 *   questionType?: string,
 *   expectedIds?: string[],
 *   disallowedIds?: string[],
 *   expectEmpty?: boolean,
 *   minPrecision?: number,
 *   minRecall?: number,
 *   maxSelected?: number|null,
 *   matchScope?: 'selected'|'hit',
 * }} BenchExpectation */

const EPS = 1e-9;
// 精确的标准正态分位数（不要用 1.96/2.576 近似硬编码 label）。
/** @type {{readonly [key: string]: number}} */
export const WILSON_Z = Object.freeze({ '90%': 1.644854, '95%': 1.959964, '99%': 2.575829 });

/**
 * @param {string[]} [ids]
 * @returns {Set<string>}
 */
function toIdSet(ids) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const id of Array.isArray(ids) ? ids : []) {
    const clean = String(id ?? '').trim();
    if (clean) out.add(clean);
  }
  return out;
}

/**
 * Precision@k：选中里有多少是期望的。
 * 空选中 + 空期望 = 1（正确地什么都没选）；空选中 + 有期望 = 0。
 * @param {string[]} selectedIds
 * @param {string[]} expectedIds
 * @returns {number}
 */
export function precisionAt(selectedIds, expectedIds) {
  const selected = Array.isArray(selectedIds) ? selectedIds.filter((x) => Boolean(String(x ?? '').trim())) : [];
  const expected = toIdSet(expectedIds);
  if (selected.length === 0) return expected.size === 0 ? 1 : 0;
  const hit = selected.filter((id) => expected.has(String(id).trim())).length;
  return hit / selected.length;
}

/**
 * Recall@k：期望里有多少被选中。无期望（负样本题）= 1。
 * @param {string[]} selectedIds
 * @param {string[]} expectedIds
 * @returns {number}
 */
export function recallAt(selectedIds, expectedIds) {
  const expected = toIdSet(expectedIds);
  if (expected.size === 0) return 1;
  const selected = toIdSet(selectedIds);
  let hit = 0;
  for (const id of expected) if (selected.has(id)) hit += 1;
  return hit / expected.size;
}

/**
 * case 自洽性检查（schema error）：空 expectedIds 却没声明 expectEmpty = 题目本身就错了
 * （永远满足 recall/precision、又没人挡 over-recall → 这种题刷不出真分，必须显式判错而非静默放过）。
 * @param {BenchExpectation} expectation
 * @returns {string|null} 错误码或 null
 */
export function caseSchemaError(expectation) {
  const exp = expectation || {};
  const expectedIds = Array.isArray(exp.expectedIds) ? exp.expectedIds.filter((x) => Boolean(String(x ?? '').trim())) : [];
  if (expectedIds.length === 0 && exp.expectEmpty !== true) return 'empty_expected_without_expectEmpty';
  return null;
}

/**
 * 默认 over-recall 上限：没显式给 maxSelected 时，按「期望数 + 余量」兜底，挡住 return-all 这类
 * 把一切都塞进 selected 的刷分 retriever。expectEmpty 题上限恒为 0（一条都不许选）。
 * 余量 3 给真召回链留噪声空间（真链 totalLimit 本就 8-10，不会被误伤），但远低于全语料规模。
 * @param {BenchExpectation} exp
 * @returns {number}
 */
function defaultMaxSelected(exp) {
  if (exp?.expectEmpty === true) return 0;
  const expectedCount = Array.isArray(exp?.expectedIds)
    ? (exp?.expectedIds ?? []).filter((x) => Boolean(String(x ?? '').trim())).length
    : 0;
  return expectedCount + 3;
}

/**
 * 判一次 run 是否通过（execution-based 硬判）：
 * - recall ≥ minRecall（默认 1：必须召回全部期望）
 * - precision ≥ minPrecision（默认 0：不强制纯净，除非题里要求）
 * - selectedCount ≤ maxSelected（over-recall 上限：治「全召回不惩罚」，return-all 必被拦）
 * - 不得选中任何 disallowed（对抗干扰项），命中即 fail
 * - expectEmpty 题：必须一条都不选
 * - run 本身 ok!==false（召回链没报错）
 * - case schema 自洽（空期望必须显式 expectEmpty，否则该 run 直接判 schemaError=fail）
 * matchScope='hit' 时按 hitIds（召回池）判，默认按 selectedIds（真注入决策）判。
 * @param {BenchRun} run
 * @param {BenchExpectation} expectation
 */
export function scoreOneRun(run, expectation) {
  const exp = expectation || {};
  const scopeIds = (exp.matchScope === 'hit' ? run?.hitIds : run?.selectedIds) || [];
  const ids = Array.isArray(scopeIds) ? scopeIds.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
  const expectedIds = Array.isArray(exp.expectedIds) ? exp.expectedIds.filter((x) => Boolean(String(x ?? '').trim())) : [];
  const disallowedIds = toIdSet(exp.disallowedIds);
  const precision = precisionAt(ids, expectedIds || []);
  const recall = recallAt(ids, expectedIds || []);
  const blocked = ids.filter((id) => disallowedIds.has(id));
  const minRecall = Number.isFinite(Number(exp.minRecall)) ? Number(exp.minRecall) : 1;
  const minPrecision = Number.isFinite(Number(exp.minPrecision)) ? Number(exp.minPrecision) : 0;
  const maxSelected = Number.isFinite(Number(exp.maxSelected)) ? Number(exp.maxSelected) : defaultMaxSelected(exp);
  const schemaError = caseSchemaError(exp);
  const runOk = run?.ok !== false;
  const emptyOk = exp.expectEmpty ? ids.length === 0 : true;
  const overRecall = ids.length > maxSelected;
  const passed = runOk
    && !schemaError
    && recall + EPS >= minRecall
    && precision + EPS >= minPrecision
    && !overRecall
    && blocked.length === 0
    && emptyOk;
  return {
    passed,
    runOk,
    schemaError,
    precision: round3(precision),
    recall: round3(recall),
    blockedIds: blocked,
    selectedCount: ids.length,
    maxSelected,
    overRecall,
  };
}

/**
 * 单题 pass^k：把 k 个 run 的判定折叠成「全过=过」。
 * 返回每个 run 的明细 + 该题是否 pass（k 次全 pass）+ 通过的 run 数。
 * @param {BenchRun[]} runs
 * @param {BenchExpectation} expectation
 */
export function passAtKForCase(runs, expectation) {
  const list = Array.isArray(runs) ? runs : [];
  const schemaError = caseSchemaError(expectation);
  const runResults = list.map((run) => scoreOneRun(run, expectation));
  const k = runResults.length;
  const passedRuns = runResults.filter((r) => r.passed).length;
  // pass^k：k 次全过才算过。k=0（没跑）或题目本身 schema 不自洽 → 一律未通过（不能凭空算过）。
  const passedAll = k > 0 && !schemaError && passedRuns === k;
  return {
    id: expectation?.id || 'unknown',
    questionType: expectation?.questionType || 'unknown',
    k,
    passedRuns,
    passAtK: passedAll,
    // pass@1（任意一次过即过）也给出来做对照——pass^k 与 pass@1 的差就是「不稳定度」。
    passAt1: !schemaError && runResults.some((r) => r.passed),
    schemaError,
    avgRecall: round3(mean(runResults.map((r) => r.recall))),
    avgPrecision: round3(mean(runResults.map((r) => r.precision))),
    maxSelected: runResults[0]?.maxSelected ?? null,
    overRecallRuns: runResults.filter((r) => r.overRecall).length,
    runs: runResults,
  };
}

/**
 * Wilson score interval（95% 默认 z=1.959964）：给「n 题里 x 题 pass^k」的比例算置信区间。
 * 比正态近似在小 n / 极端比例下更稳：x=0 或 x=n 时区间不会越出 [0,1]，宽度也更诚实。
 * 边界硬化：
 * - z 取绝对值（负 z 是误传，|z| 才有统计意义；z=0 视为退化→区间塌成点，不报假置信）。
 * - 非有限/非正 z 一律回落默认 95%，绝不用 NaN 算出垃圾区间。
 * @param {number} successes 通过题数
 * @param {number} total 总题数
 * @param {number} [z] z 分数（95%→1.959964，99%→2.575829）
 * @returns {{point:number, lower:number, upper:number, n:number, z:number, method:'wilson'}}
 */
export function wilsonInterval(successes, total, z = WILSON_Z['95%']) {
  const n = Math.max(0, Math.trunc(Number(total) || 0));
  const x = Math.max(0, Math.min(n, Math.trunc(Number(successes) || 0)));
  const zRaw = Number(z);
  // 负 z 取绝对值；非有限 z 回落 95%。z=0（退化）保留为 0 → 区间塌成点（诚实地表达"无置信宽度"）。
  const zAbs = Number.isFinite(zRaw) ? Math.abs(zRaw) : WILSON_Z['95%'];
  if (n === 0) return { point: 0, lower: 0, upper: 0, n: 0, z: zAbs, method: 'wilson' };
  const phat = x / n;
  const z2 = zAbs * zAbs;
  const denom = 1 + z2 / n;
  const center = (phat + z2 / (2 * n)) / denom;
  const margin = (zAbs * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n)) / denom;
  return {
    point: round4(phat),
    lower: round4(Math.max(0, center - margin)),
    upper: round4(Math.min(1, center + margin)),
    n,
    z: zAbs,
    method: 'wilson',
  };
}

/**
 * 汇总整套基准：把每题的 pass^k 折叠成总分 + 置信区间 + 分题型分布。
 * @param {Array<ReturnType<typeof passAtKForCase>>} caseResults
 * @param {{k?:number, z?:number}} [opts]
 */
export function aggregateBench(caseResults, { k = null, z = WILSON_Z['95%'] } = {}) {
  const all = Array.isArray(caseResults) ? caseResults : [];
  // k=0 的 case（没真跑过任何 run）从分母里剔除——它们既没 pass 也不该稀释比例/CI（否则"没跑"被算成"没过"压低分）。
  const skippedNoRun = all.filter((c) => (Number(c.k) || 0) <= 0).length;
  const cases = all.filter((c) => (Number(c.k) || 0) > 0);
  const total = cases.length;
  const passed = cases.filter((c) => c.passAtK).length;
  const passedAt1 = cases.filter((c) => c.passAt1).length;
  const schemaErrors = cases.filter((c) => c.schemaError).length;
  const byType = {};
  for (const c of cases) {
    // 题型归一：聚合前 lowercase+trim，避免 "Single_Hop" / "single_hop " 被当成不同桶。
    const t = String(c.questionType ?? 'unknown').toLowerCase().trim() || 'unknown';
    byType[t] = byType[t] || { total: 0, passed: 0 };
    byType[t].total += 1;
    if (c.passAtK) byType[t].passed += 1;
  }
  const perTypeInterval = {};
  for (const [t, agg] of Object.entries(byType)) {
    perTypeInterval[t] = { ...agg, ...wilsonInterval(agg.passed, agg.total, z) };
  }
  const observedK = cases.reduce((m, c) => Math.max(m, Number(c.k) || 0), 0);
  return {
    k: Number(k) || observedK || null,
    confidence: { z: Math.abs(Number(z)) || WILSON_Z['95%'], level: zToLevel(z) },
    summary: {
      cases: total,
      passedAtK: passed,
      passedAt1,
      // 不稳定题数：pass@1 过但 pass^k 没过（k 次里有失败）——直接量化召回链非确定性。
      flaky: Math.max(0, passedAt1 - passed),
      // 自洽性 / 完整性诊断：schema 错的题数 + 因 k=0 被剔除的题数（都不计入分母，但要可见）。
      schemaErrors,
      skippedNoRun,
    },
    passAtK: wilsonInterval(passed, total, z),
    passAt1: wilsonInterval(passedAt1, total, z),
    byQuestionType: perTypeInterval,
  };
}

/**
 * z → 置信水平 label。只为「认识的」z 贴标准 label；未知 z 不硬写 95%，而是显式标 z 值
 * （避免把任意 z 谎报成 95% 区间）。负 z 先取绝对值。
 * @param {number} z
 * @returns {string}
 */
function zToLevel(z) {
  const zAbs = Number.isFinite(Number(z)) ? Math.abs(Number(z)) : WILSON_Z['95%'];
  if (Math.abs(zAbs - WILSON_Z['99%']) < 0.01) return '99%';
  if (Math.abs(zAbs - WILSON_Z['95%']) < 0.01) return '95%';
  if (Math.abs(zAbs - WILSON_Z['90%']) < 0.01) return '90%';
  return `custom(z=${round4(zAbs)})`;
}

function mean(arr) {
  const nums = (Array.isArray(arr) ? arr : []).map(Number).filter(Number.isFinite);
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function round3(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

function round4(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}
