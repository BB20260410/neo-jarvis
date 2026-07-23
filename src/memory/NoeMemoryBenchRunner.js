// @ts-check

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { aggregateBench, passAtKForCase, WILSON_Z } from './NoeMemoryBenchScoring.js';

/**
 * P6 记忆召回基准 runner —— IO / 编排层（评分纯逻辑全在 NoeMemoryBenchScoring.js）。
 *
 * 职责：
 * 1. 读 LongMem/LOCOMO 风格自造题集（NeoEval case schema）+ 它们引用的 fixture 记忆语料。
 * 2. 把 fixture 经 writeGate 灌进「注入进来的」memory（DI——可以是 temp db，也可以是 live db 副本）。
 * 3. 对每题用「注入进来的」retriever 跑真召回链 k 次（execution-based），交给纯评分层判 pass^k。
 * 4. 产出 NeoEval scorer 可读的 report（不含记忆正文/secret，只出 id/count/分数）。
 *
 * 全程 DI：memory / writeGate / retriever 都从外面传进来，runner 自己不 new 任何 db。
 * 反作弊：retriever 是真召回链；喂错记忆 / stub 空召回时分数必须真掉（见单测反向探针）。
 */

const DEFAULT_BENCH_DIR = 'evals/neo/memory-bench';
export const BENCH_SOURCE_LABEL = 'longmem-style-synthetic';

function clean(value, max = 2000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * 加载 fixture 记忆语料（被召回的「历史」）。
 * @param {{benchDir?:string, root?:string, fixturesFile?:string}} [opts]
 * @returns {Array<object>}
 */
export function loadBenchFixtures({ benchDir = DEFAULT_BENCH_DIR, root = process.cwd(), fixturesFile = 'fixtures.json' } = {}) {
  const file = resolve(root, benchDir, fixturesFile);
  const data = readJson(file);
  const fixtures = Array.isArray(data) ? data : (Array.isArray(data?.fixtures) ? data.fixtures : []);
  if (!Array.isArray(fixtures) || !fixtures.length) throw new Error(`bench_fixtures_empty:${basename(file)}`);
  return fixtures;
}

/**
 * 加载题集（每个 case = NeoEval case JSON，携带 bench payload）。
 * 容错：单个文件坏不拖垮全集——记 errors。
 * @param {{benchDir?:string, root?:string, casesSubdir?:string}} [opts]
 * @returns {{cases: Array<object>, errors: Array<{file:string, error:string}>}}
 */
export function loadBenchCases({ benchDir = DEFAULT_BENCH_DIR, root = process.cwd(), casesSubdir = 'cases' } = {}) {
  const dir = resolve(root, benchDir, casesSubdir);
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch (error) {
    return { cases: [], errors: [{ file: dir, error: clean(error?.message || error, 200) }] };
  }
  const cases = [];
  const errors = [];
  for (const f of files) {
    try {
      const json = readJson(join(dir, f));
      cases.push({ ...json, __file: f });
    } catch (error) {
      errors.push({ file: f, error: clean(error?.message || error, 200) });
    }
  }
  return { cases, errors };
}

/**
 * 各题型的默认精度下限（治「过度召回不惩罚」P0 ①的第二道闸；第一道是 maxSelected）。
 * 标定依据：真召回链在 retrievalBudget(=期望+2) 预算下，单期望题返回 ~3 条(precision≈0.33)、
 *   多期望题返回 ~4 条(precision≈0.5+)。下限取「真链够得着、但比它更糙就过不了」：
 *   - single_hop/temporal/adversarial = 0.25：真链 0.33 能过；返回 4+ 条噪声只含 1 期望(P≤0.2) 被拦。
 *   - multi_hop = 0.34：真链 0.5 能过；过度召回稀释到 <0.34 被拦。
 * 注：把下限定到 0.5 会误伤这条「召回导向、低精度」的真注入链(实测单跳满预算 P=0.125、紧预算 P=0.33)，
 *   故 over-recall 主要靠 maxSelected 这道硬闸，minPrecision 作辅助。expectEmpty 题 → 0（没期望可比精度）。
 */
const DEFAULT_MIN_PRECISION_BY_TYPE = Object.freeze({
  single_hop: 0.25,
  temporal: 0.25,
  adversarial: 0.25,
  multi_hop: 0.34,
});

/**
 * 召回注入预算（runner 喂给 retriever 的 limit 与 over-recall 上限 maxSelected 的唯一真源）。
 * 取 期望数 + 2（至少 3）：
 *  - 真召回链在这个预算下返回 3-4 条（实测），既能召回全部期望、又留 1-2 条噪声空间。
 *  - return-all 这类把全语料（~29 条）塞进 selected 的刷分 retriever 必然 > 预算 → over-recall 拦下。
 *  - 旧实现 limit=max(exp+4,8) 让真链一律返回 8 条 → precision 被稀释到 ~0.12、且 maxSelected 怎么定都尴尬。
 * @param {{expectedIds?:string[]}} contract
 */
function retrievalBudget(contract) {
  const expectedCount = Array.isArray(contract?.expectedIds)
    ? contract.expectedIds.filter((x) => String(x ?? '').trim()).length
    : 0;
  return Math.max(expectedCount + 2, 3);
}

/**
 * 默认 over-recall 上限（与 scoring 层同口径，显式落进 contract 让报告可见）：
 * expectEmpty → 0（一条都不许选）；否则 = 召回注入预算。挡住 return-all 把全语料塞进 selected 的刷分。
 * @param {{expectEmpty?:boolean, expectedIds?:string[]}} contract
 */
function defaultMaxSelected(contract) {
  if (contract?.expectEmpty === true) return 0;
  return retrievalBudget(contract);
}

/**
 * 从 NeoEval case 抽出 bench 评分契约（query + 期望 id + 题型 + 判分参数）。
 * 优先读显式 `bench` payload；缺失时回落 expectations.mustSelect/mustNotSelect（保持 NeoEval 兼容）。
 * @param {object} evalCase
 */
export function benchExpectationFromCase(evalCase = {}) {
  const bench = evalCase?.bench && typeof evalCase.bench === 'object' ? evalCase.bench : {};
  const exp = evalCase?.expectations && typeof evalCase.expectations === 'object' ? evalCase.expectations : {};
  const expectedIds = Array.isArray(bench.expectedIds) ? bench.expectedIds
    : (Array.isArray(exp.mustSelectMemoryIds) ? exp.mustSelectMemoryIds : []);
  const disallowedIds = Array.isArray(bench.disallowedIds) ? bench.disallowedIds
    : (Array.isArray(exp.mustNotSelectMemoryIds) ? exp.mustNotSelectMemoryIds : []);
  const questionType = clean(bench.questionType, 60).toLowerCase() || 'unknown';
  const expectEmpty = bench.expectEmpty === true;
  // minPrecision：显式 case 值优先；否则按题型兜底；expectEmpty 题恒 0（没期望可比精度）。
  const minPrecision = Number.isFinite(Number(bench.minPrecision)) ? Number(bench.minPrecision)
    : (expectEmpty ? 0 : (DEFAULT_MIN_PRECISION_BY_TYPE[questionType] ?? 0.34));
  // maxSelected：显式 case 值优先；否则 期望数 + 余量。over-recall 上限。
  const maxSelected = Number.isFinite(Number(bench.maxSelected)) ? Number(bench.maxSelected)
    : defaultMaxSelected({ expectEmpty, expectedIds });
  return {
    id: clean(evalCase.id, 200) || 'unknown',
    questionType,
    lang: clean(bench.lang, 12) || 'unknown',
    query: clean(bench.query, 1600),
    routeType: clean(evalCase?.input?.routeType, 40) || 'chat',
    person: clean(bench.person, 120),
    expectedIds,
    disallowedIds,
    expectEmpty,
    minPrecision,
    minRecall: Number.isFinite(Number(bench.minRecall)) ? Number(bench.minRecall) : 1,
    maxSelected,
    matchScope: bench.matchScope === 'hit' ? 'hit' : 'selected',
    k: Math.max(1, Math.min(20, Math.trunc(Number(bench.k) || 0))) || null,
  };
}

/**
 * 把 fixture 语料经 writeGate 灌进 memory。
 * writeGate 缺失 → 直接 memory.write（仅供测试/副本注入）。
 * @param {{writeGate?: {commit: Function}|null, memory?: {write: Function}|null, projectId?: string, fixtures?: Array<any>}} args
 * @returns {{seeded:Array<{id:string, ok:boolean, reason?:string}>}}
 */
export function seedBenchFixtures({ writeGate = null, memory = null, projectId = 'noe', fixtures = [] } = {}) {
  const seeded = [];
  for (const fx of Array.isArray(fixtures) ? fixtures : []) {
    const id = clean(fx?.id, 160);
    if (!id) continue;
    try {
      if (writeGate?.commit) {
        const r = writeGate.commit({
          ...fx,
          projectId,
          targetMemoryId: id,
          sourceType: fx.sourceType || 'longmem_bench_fixture',
          writeMode: 'validated_consensus',
          actor: 'noe_memory_bench_runner',
        });
        seeded.push({ id, ok: r.ok === true, reason: r.reason });
      } else if (memory?.write) {
        memory.write({ ...fx, id, projectId, sourceType: fx.sourceType || 'longmem_bench_fixture' });
        seeded.push({ id, ok: true });
      } else {
        seeded.push({ id, ok: false, reason: 'no_write_target' });
      }
    } catch (error) {
      seeded.push({ id, ok: false, reason: clean(error?.message || error, 160) });
    }
  }
  return { seeded };
}

/**
 * 不透明 turnId（治 P0 ② caseId 泄漏）：旧实现 `memory-bench:${caseId}:${i}` 让 retriever 能从
 * turnId 反解 caseId → 去读公开 case 的 expectedIds 作弊。这里给每个 run 发一个随机 nonce，
 * 不含 caseId / 序号 / 任何可反推题目的信息，retriever 无从据此读公开 case 的 expectedIds 作弊。
 * @returns {string}
 */
function opaqueTurnId() {
  return `mb-${randomBytes(16).toString('hex')}`;
}

/**
 * 对一题跑 k 次真召回。retriever 必须是真链（NoeMemoryRetriever）；no-op/stub 会让分数真掉。
 * turnId 一律用不透明 nonce（不泄漏 caseId）；caseId 只在本闭包内（contract.id），不随 turnId 出去。
 * @returns {Promise<Array<{selectedIds:string[], hitIds:string[], ok:boolean, turnId:string}>>}
 */
async function runCaseKTimes({ retriever, contract, projectId, k }) {
  const runs = [];
  for (let i = 0; i < k; i += 1) {
    // 每个 run 一个全新不透明 nonce：retriever 拿到的 turnId 不含 caseId/序号/题型，无从反解 gold。
    // caseId 只在本闭包里（contract.id），从不随 turnId 出去，故无需再维护映射表。
    const turnId = opaqueTurnId();
    let result;
    try {
      // 注入预算与 over-recall 上限同源（retrievalBudget）：真链按此预算返回 3-4 条，
      // 既保召回、又不被旧 limit=8 把 precision 稀释，且与 maxSelected 判据一致。
      const budget = retrievalBudget(contract);
      result = await retriever.retrieve({
        transcript: contract.query,
        person: contract.person,
        projectId,
        routeType: contract.routeType,
        limit: budget,
        memoryPolicy: { recallLimit: budget },
        turnId,
      });
    } catch (error) {
      runs.push({ selectedIds: [], hitIds: [], ok: false, turnId, error: clean(error?.message || error, 160) });
      continue;
    }
    const selectedIds = Array.isArray(result?.selectedIds)
      ? result.selectedIds.map(String)
      : (result?.selected || []).map((m) => m?.id).filter(Boolean).map(String);
    const hitIds = Array.isArray(result?.hitIds) ? result.hitIds.map(String) : selectedIds.slice();
    runs.push({ selectedIds, hitIds, ok: result?.ok !== false, turnId });
  }
  return runs;
}

/**
 * 跑整套基准。
 * @param {{
 *   retriever: {retrieve: Function},
 *   writeGate?: {commit: Function}|null,
 *   memory?: object|null,
 *   cases: Array<object>,
 *   fixtures: Array<object>,
 *   projectId?: string,
 *   k?: number,
 *   seed?: boolean,
 *   z?: number,
 *   now?: () => number,
 * }} args
 */
export async function runMemoryBench({
  retriever,
  writeGate = null,
  memory = null,
  cases = [],
  fixtures = [],
  projectId = 'noe',
  k = 5,
  seed = true,
  z = WILSON_Z['95%'],
  now = Date.now,
} = {}) {
  if (!retriever?.retrieve) throw new Error('retriever_required');
  const kRuns = Math.max(1, Math.min(20, Math.trunc(Number(k) || 5)));
  const seedResult = seed ? seedBenchFixtures({ writeGate, memory, projectId, fixtures }) : { seeded: [] };

  const caseResults = [];
  for (const evalCase of Array.isArray(cases) ? cases : []) {
    const contract = benchExpectationFromCase(evalCase);
    const caseK = contract.k || kRuns;
    const started = now();
    const runs = await runCaseKTimes({ retriever, contract, projectId, k: caseK });
    const scored = passAtKForCase(runs, contract);
    caseResults.push({
      caseId: contract.id,
      questionType: contract.questionType,
      lang: contract.lang,
      status: scored.passAtK ? 'passed' : 'failed',
      passAtK: scored.passAtK,
      passAt1: scored.passAt1,
      k: scored.k,
      passedRuns: scored.passedRuns,
      avgRecall: scored.avgRecall,
      avgPrecision: scored.avgPrecision,
      expectedCount: contract.expectedIds.length,
      disallowedCount: contract.disallowedIds.length,
      minPrecision: contract.minPrecision,
      maxSelected: scored.maxSelected,
      overRecallRuns: scored.overRecallRuns,
      schemaError: scored.schemaError,
      latencyMs: now() - started,
    });
  }

  const aggregate = aggregateBench(
    caseResults.map((c) => ({
      passAtK: c.passAtK,
      passAt1: c.passAt1,
      questionType: c.questionType,
      schemaError: c.schemaError,
      k: c.k,
    })),
    { k: kRuns, z },
  );

  // seed 完整性（治 P1 ③）：当本函数负责 seed 时，任何 fixture 没入库 → 硬失败（disallowed/expected 没进库会让
  // 「不选它」「能选它」的判据失真）。seed:false 时由调用方（CLI）自己 seed 并覆写 report.seed + 做 fail-fast。
  const seededOk = seed ? seedResult.seeded.length > 0 && seedResult.seeded.every((s) => s.ok) : true;
  return {
    ok: aggregate.summary.cases > 0
      && aggregate.summary.passedAtK === aggregate.summary.cases
      && aggregate.summary.schemaErrors === 0
      && seededOk,
    schemaVersion: 1,
    kind: 'noe_memory_bench_report',
    source: BENCH_SOURCE_LABEL,
    benchProvenanceNote: '风格自造（LongMemEval/LOCOMO 体例），非原公开题集；题/语料均本地合成。',
    projectId,
    seed: { attempted: seedResult.seeded.length, ok: seededOk, failed: seedResult.seeded.filter((s) => !s.ok) },
    aggregate,
    caseResults,
    // 脱敏自检承诺：本 report 只含 id/count/分数，不含记忆 body / secret / owner token。
    policy: { noMemoryBodyOutput: true, noSecretOutput: true, executionBased: true, llmJudge: false },
  };
}
