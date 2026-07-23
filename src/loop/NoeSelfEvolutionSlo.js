// @ts-check
//
// NoeSelfEvolutionSlo — 自进化 SLO 可观测基线聚合（P3）
//
// 纯读取自进化产物，聚合成结构化 SLO（每阶段成功率/耗时/失败归因），供 P9 看板消费。
//
// 设计铁律（项目强制）：
//   - 注入式 DI：产物目录、读文件函数、now、落盘函数全部从参数传入，默认真实路径/真实 fs/真实时钟。
//   - fail-open：任何单个产物 JSON 畸形/读失败 → 跳过该文件不崩；目录不存在 → 返回零值结构不抛。
//   - 纯聚合（aggregateSelfEvolutionSlo）不做任何 IO，只接收已读数组 → 最易单测。
//   - IO 读取（collectSelfEvolutionArtifacts）与落盘（writeSelfEvolutionSlo）独立导出。
//
// ── 数据源真实字段（2026-06-21 实测 21+1+42 份样本，与早期 spec 有出入，本模块对两种 shape 都兼容）──
//   apply-reports（output/noe-patch-transactions/apply-reports/*.json）:
//     status ∈ {applied, dry_run_ready, blocked, skipped, rolled_back...}、ok、dryRun、generatedAt、
//     counts:{operations,changedFiles,blocked,errors}、changedFiles[]、applyId、patchPlanRef。
//   runtime-verify（output/noe-self-evolution/runtime-verify/*.json）:
//     ok、exitCode、generatedAt；新字段 numTotalTests/numPassedTests/numFailedTests/reportTrusted/reportError。
//     成功口径对齐 P0 fail-closed（ok&&reportTrusted&&numTotalTests>0&&numFailedTests===0）；旧产物缺
//     reportTrusted/numTotalTests → 计入 legacyUnknown（既不算成功也不算失败，不进 successRate 分母）。
//   implementer-fail（output/noe-self-evolution/implementer-fail/*.json）两种 shape 都兼容：
//     旧 shape（kind/at/adapterId/error/...）退回 error/reason 字符串归因；
//     新 shape（attemptedCandidates[{id,error,...}]/routedAdapterId/reason）用逐条 error 归因。
//
// ── 耗时配对策略（重要，照实说明）──
//   实测三类产物均无 durationMs/startedAt 字段，也无可靠关联键配对同一次进化的三段。故【不编造】
//   阶段耗时：仅当产物自带显式 durationMs（经 isFiniteValueStrict 严格校验，拒 null/''/false 假 0）
//   才纳入百分位，否则 P50/P95 给 null 并在 durationNote 标因（生产者补字段后自动生效）。
//
// ── 百分位算法 ──
//   nearest-rank（最近秩，向上取整法）：对升序样本 sorted（长度 n），分位 p∈[0,100]
//   取 rank = ceil(p/100 * n)（p=0 时取第 1 个），索引 sorted[rank-1]。
//   选 nearest-rank 而非线性插值，因样本量通常很小（个位数），插值会产生原始数据里不存在的虚构值。

import fs from 'node:fs';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根（src/loop/ 上两级）。 */
export const DEFAULT_SELF_EVOLUTION_SLO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const APPLY_REPORTS_REL = 'output/noe-patch-transactions/apply-reports';
export const RUNTIME_VERIFY_REL = 'output/noe-self-evolution/runtime-verify';
export const IMPLEMENTER_FAIL_REL = 'output/noe-self-evolution/implementer-fail';
export const SLO_OUTPUT_REL = 'output/self-evolution-slo';

export const SCHEMA_VERSION = 1;
const DEFAULT_TOP_N = 5;

const DURATION_NOTE_NO_SOURCE =
  '产物无 durationMs/startedAt 字段且无可靠跨阶段关联键，故不编造耗时；生产者补 durationMs 后自动生效。';

// ───────────────────────── 小工具（纯函数） ─────────────────────────

/** 安全字符串化（trim）。 */
function cleanString(value) {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

/** 是否为非空、非数组的普通对象。 */
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 取首个为有限数的字段值，否则 null。
 * 内部用 Number()，故 null/''/false 会被强制成 0、true→1。仅用于"缺失当 0 无害"的内部
 * 计数场景（countsFor 的 parsed/skipped/files，值本由本模块产出的真实 number）。
 * 对"缺失 ≠ 0"的语义字段（durationMs/numFailedTests 等）必须用 isFiniteValueStrict。 */
function firstFiniteNumber(...values) {
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * 严格有限数：拒绝 null/undefined/''/boolean，只接受真 number 或纯数字字符串。防假数据用——
 * 避免 Number(null)===0 / Number('')===0 / Number(false)===0 把字段缺失误聚合成真实 0 样本
 * （如 durationMs:null 当成 0ms 耗时）。
 * @param {unknown} v
 * @returns {number|null} 严格有限数；否则 null
 */
function isFiniteValueStrict(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return null;
    // 仅接受严格 numeric 字符串（整数/小数/科学计数/正负号），拒 '12px'、'0x1F'
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
    return Number(s);
  }
  return null; // null / undefined / boolean / object 等一律拒
}

/** 取首个非空字符串字段，否则 ''。 */
function firstString(...values) {
  for (const v of values) {
    const s = cleanString(v);
    if (s) return s;
  }
  return '';
}

/**
 * nearest-rank 百分位。
 * @param {number[]} values 任意顺序的数值数组（内部排序）
 * @param {number} p 分位 0..100
 * @returns {number|null} 命中样本值；空数组返回 null
 */
export function percentileNearestRank(values, p) {
  const nums = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite);
  if (nums.length === 0) return null;
  const sorted = nums.slice().sort((a, b) => a - b);
  const clampedP = Math.min(100, Math.max(0, Number(p) || 0));
  if (clampedP <= 0) return sorted[0];
  const rank = Math.ceil((clampedP / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

/** 把一组 apply 记录按 status 计数成 {status:count}（缺 status 归 'unknown'）。 */
function countStatuses(records) {
  const counts = {};
  for (const rec of Array.isArray(records) ? records : []) {
    const status = cleanString(rec.status) || 'unknown';
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

/** 把 {key:count} 计数对象转成降序 top-N 数组 [{reason,count}]。 */
function topNFromCounts(counts, topN) {
  return Object.entries(counts)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, Math.max(0, topN));
}

/** 计算一组显式 durationMs 的 P50/P95；无样本则 null + 说明。 */
function durationStats(durationsMs) {
  const nums = (Array.isArray(durationsMs) ? durationsMs : []).map(Number).filter(Number.isFinite);
  if (nums.length === 0) {
    return { sampleCount: 0, p50Ms: null, p95Ms: null, note: DURATION_NOTE_NO_SOURCE };
  }
  return {
    sampleCount: nums.length,
    p50Ms: percentileNearestRank(nums, 50),
    p95Ms: percentileNearestRank(nums, 95),
    note: '',
  };
}

// ───────────────────────── 失败归因分类（纯函数，导出供测试） ─────────────────────────

/**
 * 把 implementer 的 error/reason 字符串归类为 network / empty_plan / other。
 * @param {string} text
 * @returns {'network'|'empty_plan'|'other'}
 */
export function classifyImplementerError(text) {
  const s = cleanString(text);
  if (!s) return 'other';
  // empty_plan 优先于 network：明确的"无可用补丁计划"信号
  if (/no_patch_plan|non[_-]?usable[_-]?patch[_-]?plan|no\s+patch\s+plan|empty[_\s-]*plan/i.test(s)) {
    return 'empty_plan';
  }
  if (/error\s*61|ECONNREFUSED|ENOTFOUND|connection\s+refused|wss?:\/\/|websocket|网络超时|fetch\s+failed/i.test(s)) {
    return 'network';
  }
  return 'other';
}

/**
 * 把单条 runtime-verify 记录归类失败原因。
 * 兼容旧产物（仅 ok/exitCode）：缺新字段时只看 exitCode。
 * @returns {'tests_failed'|'report_untrusted'|'nonzero_exit'|'unknown'}
 */
export function classifyRuntimeFailure(record) {
  const r = isObject(record) ? record : {};
  // 严格版：缺失 numFailedTests（null/undefined）必须保持 null，绝不当成 0 个失败
  // ——否则"测试数缺失"会被误读成"无测试失败"，掩盖真实失败。
  const numFailed = isFiniteValueStrict(r.numFailedTests);
  if (numFailed !== null && numFailed > 0) return 'tests_failed';
  if (r.reportTrusted === false) return 'report_untrusted';
  // exitCode 同理用严格版：缺失保持 null（落到 unknown），不当成 exit 0。
  const exitCode = isFiniteValueStrict(r.exitCode);
  if (exitCode !== null && exitCode !== 0) return 'nonzero_exit';
  return 'unknown';
}

// ───────────────────────── 单条记录判定 ─────────────────────────

/** apply 记录是否算"成功"（status===applied 且 ok）。 */
function isApplySuccess(record) {
  return cleanString(record.status) === 'applied' && record.ok === true;
}

/**
 * runtime 记录三态判定，与 P0 runtime-verify fail-closed 口径对齐。
 *   success        = ok && reportTrusted===true && numTotalTests>0 && numFailedTests===0
 *   legacy_unknown = 旧产物缺 reportTrusted 或 numTotalTests（undefined）：不算成功也不算失败，
 *                    单独计数，避免把旧产物全打成失败致 SLO 失真。
 *   fail           = 有这些字段但不达标。
 * 仅看 record.ok===true 会在 SLO 层重开 P0 防假绿绕过面（{ok:true,reportTrusted:false} 误判成功）。
 * @param {object} record
 * @returns {'success'|'fail'|'legacy_unknown'}
 */
function classifyRuntimeOutcome(record) {
  const r = isObject(record) ? record : {};
  // P9-fix(Codex):reportTrusted 明确 false = 报告不可信 = fail(fail-closed),优先于 legacy_unknown——
  //   防 reportTrusted:false 但 numTotalTests 缺失(历史/手工产物)时被误判 legacy_unknown 漏出失败(P0 防假绿精神)。
  if (r.reportTrusted === false) return 'fail';
  if (r.reportTrusted === undefined || r.numTotalTests === undefined) return 'legacy_unknown';
  const numTotal = isFiniteValueStrict(r.numTotalTests);
  const numFailed = isFiniteValueStrict(r.numFailedTests);
  // 字段存在但非严格数字（如 numTotalTests:null）→ 不可信，按 fail（fail-closed）
  const ok =
    r.ok === true && r.reportTrusted === true && numTotal !== null && numTotal > 0 && numFailed === 0;
  return ok ? 'success' : 'fail';
}

/**
 * 从一条 implementer-fail 记录抽出归因事件列表。
 * 新 shape：逐条 attemptedCandidates.error。旧 shape：单条 error 或 reason。
 * @returns {{category:string}[]}
 */
function implementerFailureEvents(record) {
  const r = isObject(record) ? record : {};
  if (Array.isArray(r.attemptedCandidates) && r.attemptedCandidates.length > 0) {
    return r.attemptedCandidates.map((c) => ({
      category: classifyImplementerError(isObject(c) ? c.error : ''),
    }));
  }
  const text = firstString(r.error, r.reason);
  return [{ category: classifyImplementerError(text) }];
}

// ───────────────────────── 纯聚合（核心，不做任何 IO） ─────────────────────────

/**
 * 纯聚合：接收已读的三类产物记录数组，返回结构化 SLO 对象。不做任何 IO。
 *
 * @param {object} input
 * @param {object[]} [input.applyReports]      apply-reports 记录（已 JSON.parse）
 * @param {object[]} [input.runtimeVerify]     runtime-verify 记录
 * @param {object[]} [input.implementerFail]   implementer-fail 记录
 * @param {object} [input.fileCounts]          各源文件计数（含 skipped 畸形数），透传进结果
 * @param {() => Date} [input.now]             时钟（默认真实）
 * @param {number} [input.topN]                失败归因 top-N（默认 5）
 * @returns {object} SLO 聚合结果
 */
export function aggregateSelfEvolutionSlo(input = {}) {
  const now = typeof input.now === 'function' ? input.now : () => new Date();
  const topN = Number.isFinite(input.topN) ? Number(input.topN) : DEFAULT_TOP_N;
  const apply = (Array.isArray(input.applyReports) ? input.applyReports : []).filter(isObject);
  const runtime = (Array.isArray(input.runtimeVerify) ? input.runtimeVerify : []).filter(isObject);
  const impl = (Array.isArray(input.implementerFail) ? input.implementerFail : []).filter(isObject);

  // ── implementer 阶段 ──
  // implementer-fail 产物按定义全是失败样本（成功不落此目录）→ success=0、fail=total、successRate=null。
  const implFailReasons = {};
  for (const rec of impl) {
    for (const ev of implementerFailureEvents(rec)) {
      implFailReasons[ev.category] = (implFailReasons[ev.category] || 0) + 1;
    }
  }
  const implementerStage = {
    total: impl.length,
    success: 0,
    fail: impl.length,
    successRate: null, // 该产物只记失败，无成功样本来源；分母不可知 → 不编造
    successRateNote: 'implementer-fail 产物仅含失败样本，无成功样本来源，successRate 分母不可知。',
    failureReasonsTopN: topNFromCounts(implFailReasons, topN),
    duration: durationStats(impl.map((r) => isFiniteValueStrict(r.durationMs)).filter((n) => n !== null)),
  };

  // ── apply 阶段 ──
  // statusDistribution 保留全量分布；successRate 分母只看"真实终态 attempts"（排除 dry-run 报告与
  // P3 幂等 skipped），否则健康路径成功率被 dry_run 堆积系统性压低 → P9 看板读出假退化。
  const applyStatusDist = {};
  for (const rec of apply) {
    const status = cleanString(rec.status) || 'unknown';
    applyStatusDist[status] = (applyStatusDist[status] || 0) + 1;
  }
  const isApplyRated = (rec) => {
    const status = cleanString(rec.status);
    return rec.dryRun !== true && status !== 'dry_run_ready' && status !== 'skipped';
  };
  const applyRatedReports = apply.filter(isApplyRated);
  const applySuccess = applyRatedReports.filter(isApplySuccess).length;
  const applyRatedTotal = applyRatedReports.length;
  const applyStage = {
    total: apply.length,
    success: applySuccess,
    fail: applyRatedTotal - applySuccess,
    ratedTotal: applyRatedTotal,
    successRate: applyRatedTotal ? round4(applySuccess / applyRatedTotal) : null,
    successRateNote:
      'successRate 分母 = 真实终态 apply attempts（排除 dryRun===true / status dry_run_ready / skipped）；成功 = status applied && ok。statusDistribution 仍为全量分布。',
    statusDistribution: applyStatusDist,
    failureReasonsTopN: topNFromCounts(
      // 失败归因 = 真实终态 attempts 里非 applied 的 status 分布（不含 dry_run_ready/skipped）
      countStatuses(applyRatedReports.filter((r) => !isApplySuccess(r))),
      topN,
    ),
    duration: durationStats(apply.map((r) => isFiniteValueStrict(r.durationMs)).filter((n) => n !== null)),
  };

  // ── runtime_verify 阶段（三态：success / fail / legacy_unknown，对齐 P0 fail-closed）──
  let runtimeSuccess = 0;
  let runtimeFail = 0;
  let runtimeLegacyUnknown = 0;
  const runtimeFailReasons = {};
  for (const rec of runtime) {
    const outcome = classifyRuntimeOutcome(rec);
    if (outcome === 'success') {
      runtimeSuccess += 1;
    } else if (outcome === 'legacy_unknown') {
      // 旧产物缺字段：不进 success 也不进 fail，不进失败归因，单独计数
      runtimeLegacyUnknown += 1;
    } else {
      runtimeFail += 1;
      const cat = classifyRuntimeFailure(rec);
      runtimeFailReasons[cat] = (runtimeFailReasons[cat] || 0) + 1;
    }
  }
  // 成功率分母 = success + fail（不含 legacy_unknown，避免旧产物拉低/失真）
  const runtimeRated = runtimeSuccess + runtimeFail;
  const runtimeStage = {
    total: runtime.length,
    success: runtimeSuccess,
    fail: runtimeFail,
    legacyUnknown: runtimeLegacyUnknown,
    successRate: runtimeRated ? round4(runtimeSuccess / runtimeRated) : null,
    successRateNote:
      'success 口径对齐 P0 = ok && reportTrusted && numTotalTests>0 && numFailedTests===0；分母 = success+fail，旧产物缺字段计入 legacyUnknown 不进分母。',
    failureReasonsTopN: topNFromCounts(runtimeFailReasons, topN),
    duration: durationStats(runtime.map((r) => isFiniteValueStrict(r.durationMs)).filter((n) => n !== null)),
  };

  const fileCounts = isObject(input.fileCounts) ? input.fileCounts : {};

  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'noe_self_evolution_slo',
    generatedAt: now().toISOString(),
    durationNote: DURATION_NOTE_NO_SOURCE,
    percentileMethod: 'nearest-rank',
    sources: {
      applyReports: { dir: APPLY_REPORTS_REL, ...countsFor('apply', fileCounts, apply.length) },
      runtimeVerify: { dir: RUNTIME_VERIFY_REL, ...countsFor('runtime', fileCounts, runtime.length) },
      implementerFail: { dir: IMPLEMENTER_FAIL_REL, ...countsFor('implementer', fileCounts, impl.length) },
    },
    stages: {
      implementer: implementerStage,
      apply: applyStage,
      runtime_verify: runtimeStage,
    },
  };
}

/** 4 位小数四舍五入（成功率）。 */
function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/** 拼装单源计数（parsed + skipped 畸形）。 */
function countsFor(key, fileCounts, parsedFallback) {
  const entry = isObject(fileCounts[key]) ? fileCounts[key] : {};
  const parsed = firstFiniteNumber(entry.parsed);
  const skipped = firstFiniteNumber(entry.skipped);
  return {
    files: firstFiniteNumber(entry.files) ?? (parsed ?? parsedFallback) + (skipped ?? 0),
    parsed: parsed ?? parsedFallback,
    skipped: skipped ?? 0,
  };
}

// ───────────────────────── IO：读取产物（fail-open） ─────────────────────────

/**
 * 默认读目录函数：读一个目录下全部 *.json，逐个 JSON.parse，畸形/读失败的跳过并计数。
 * 目录不存在 → 返回空 records + skipped 0（不抛）。
 *
 * @param {string} absDir
 * @param {object} io { existsSync, readdirSync, readFileSync }
 * @returns {{records:object[], parsed:number, skipped:number, files:number}}
 */
function readJsonDir(absDir, io) {
  const exists = io.existsSync(absDir);
  if (!exists) return { records: [], parsed: 0, skipped: 0, files: 0 };
  let names = [];
  try {
    names = io.readdirSync(absDir).filter((f) => typeof f === 'string' && f.endsWith('.json'));
  } catch {
    return { records: [], parsed: 0, skipped: 0, files: 0 };
  }
  const records = [];
  let skipped = 0;
  for (const name of names) {
    try {
      const raw = io.readFileSync(path.join(absDir, name), 'utf8');
      const parsed = JSON.parse(raw);
      if (isObject(parsed)) records.push(parsed);
      else skipped += 1; // 顶层非对象（数组/标量）当畸形跳过
    } catch {
      skipped += 1; // 读失败 / JSON 畸形 → fail-open 跳过
    }
  }
  return { records, parsed: records.length, skipped, files: names.length };
}

/**
 * 收集三类产物（带 DI）。所有路径、fs 函数可注入，便于单测指向临时目录。
 *
 * @param {object} [opts]
 * @param {string} [opts.root]               项目根（默认真实根）
 * @param {string} [opts.applyDir]           apply-reports 绝对目录（默认 root/APPLY_REPORTS_REL）
 * @param {string} [opts.runtimeDir]         runtime-verify 绝对目录
 * @param {string} [opts.implementerDir]     implementer-fail 绝对目录
 * @param {object} [opts.fs]                 { existsSync, readdirSync, readFileSync }（默认 node:fs）
 * @returns {{applyReports:object[], runtimeVerify:object[], implementerFail:object[], fileCounts:object}}
 */
export function collectSelfEvolutionArtifacts(opts = {}) {
  const root = cleanString(opts.root) || DEFAULT_SELF_EVOLUTION_SLO_ROOT;
  const io = {
    existsSync: opts.fs?.existsSync || fs.existsSync,
    readdirSync: opts.fs?.readdirSync || fs.readdirSync,
    readFileSync: opts.fs?.readFileSync || fs.readFileSync,
  };
  const applyDir = cleanString(opts.applyDir) || path.join(root, APPLY_REPORTS_REL);
  const runtimeDir = cleanString(opts.runtimeDir) || path.join(root, RUNTIME_VERIFY_REL);
  const implementerDir = cleanString(opts.implementerDir) || path.join(root, IMPLEMENTER_FAIL_REL);

  const apply = readJsonDir(applyDir, io);
  const runtime = readJsonDir(runtimeDir, io);
  const impl = readJsonDir(implementerDir, io);

  return {
    applyReports: apply.records,
    runtimeVerify: runtime.records,
    implementerFail: impl.records,
    fileCounts: {
      apply: { files: apply.files, parsed: apply.parsed, skipped: apply.skipped },
      runtime: { files: runtime.files, parsed: runtime.parsed, skipped: runtime.skipped },
      implementer: { files: impl.files, parsed: impl.parsed, skipped: impl.skipped },
    },
  };
}

// ───────────────────────── 编排：读 + 聚合 ─────────────────────────

/**
 * 读取真实（或注入）产物并聚合成 SLO。不落盘。
 * @param {object} [opts] 透传给 collectSelfEvolutionArtifacts；额外支持 now/topN。
 * @returns {object} SLO 聚合结果
 */
export function buildSelfEvolutionSlo(opts = {}) {
  const collected = collectSelfEvolutionArtifacts(opts);
  return aggregateSelfEvolutionSlo({
    applyReports: collected.applyReports,
    runtimeVerify: collected.runtimeVerify,
    implementerFail: collected.implementerFail,
    fileCounts: collected.fileCounts,
    now: opts.now,
    topN: opts.topN,
  });
}

// ───────────────────────── IO：落盘（独立导出） ─────────────────────────

/**
 * 把 SLO 聚合结果写到 output/self-evolution-slo/<ISO时间戳>.json（落盘目录可注入）。
 * 落盘目录不存在则递归创建。
 *
 * @param {object} [opts]
 * @param {object} [opts.slo]            已聚合的 SLO（不传则内部 buildSelfEvolutionSlo(opts)）
 * @param {string} [opts.root]           项目根
 * @param {string} [opts.outputDir]      落盘绝对目录（默认 root/SLO_OUTPUT_REL）
 * @param {() => Date} [opts.now]        时钟（默认真实；同时用于聚合与文件名）
 * @param {object} [opts.fs]             { existsSync, mkdirSync, writeFileSync, ...read 函数 }（默认 node:fs）
 * @returns {{filePath:string, slo:object}}
 */
export function writeSelfEvolutionSlo(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => new Date();
  const root = cleanString(opts.root) || DEFAULT_SELF_EVOLUTION_SLO_ROOT;
  const io = {
    existsSync: opts.fs?.existsSync || fs.existsSync,
    mkdirSync: opts.fs?.mkdirSync || fs.mkdirSync,
    writeFileSync: opts.fs?.writeFileSync || fs.writeFileSync,
  };
  const slo = isObject(opts.slo) ? opts.slo : buildSelfEvolutionSlo({ ...opts, now });
  const outputDir = cleanString(opts.outputDir) || path.join(root, SLO_OUTPUT_REL);
  // 文件名时间戳：冒号/点替成连字符（与项目其它落盘一致，文件系统安全）
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(outputDir, `${stamp}.json`);
  if (!io.existsSync(outputDir)) io.mkdirSync(outputDir, { recursive: true });
  io.writeFileSync(filePath, JSON.stringify(slo, null, 2), 'utf8');
  return { filePath, slo };
}
