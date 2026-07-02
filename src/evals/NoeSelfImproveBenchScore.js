// @ts-check
// NoeSelfImproveBenchScore — P6 自改可执行任务回归集的【纯函数层】（评分 / pass^k / 候选合法性 /
// 禁区判定 / 行为采样比对），与隔离执行 IO 完全分离，便于单测穷举（含反向 probe）。
//
// 设计要点：
//  - pass^k：每个任务跑 k 次，k 次「全」转绿才算该任务过（任一次失败 => 该任务 0 分）。
//    这是防"偶发/不确定性刷分"的核心——单次绿不算数。
//  - 防 reward-hack 三道纯函数闸（执行前就能挡）：
//      ① 空改动（候选未提供任何 subject 内容 / 内容与 buggy 字节一致）=> 直接判 not_attempted，0 分。
//      ② 候选声称写"评测产物/结果/conftest"等受控路径 => 判 forbidden，0 分（复用候选 patch gate 禁区思路）。
//      ③ 候选越界改了非本任务 subjectFile 之外的路径 => 判 out_of_scope，0 分。
//  - 【转绿判定核心（重构后）】不再依赖子进程自报任何"成功凭证"。子进程只回吐函数对给定输入的
//    真实返回值/抛错（结构化采样）；本模块 assertSamplesAgainstProbes() 在【父进程 realm】用 oracle
//    (probes[].expect，子进程够不到) 深度比对得出转绿与否。子进程任何污染只能让采样不可信 => 判不绿，
//    无法把错误返回值伪装成正确返回值。
import { selfImproveForbiddenEvalPathReason } from '../candidates/NoeCandidatePatchArtifactGate.js';

export const NOE_SELF_IMPROVE_BENCH_SCHEMA_VERSION = 1;
export const NOE_SELF_IMPROVE_BENCH_DEFAULT_K = 3;

function clean(value, max = 4000) {
  return String(value ?? '').replace(/\x00/g, '').slice(0, max);
}

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeK(k) {
  const n = Math.floor(Number(k));
  if (!Number.isFinite(n) || n < 1) return NOE_SELF_IMPROVE_BENCH_DEFAULT_K;
  return Math.min(n, 50);
}

/**
 * pass^k 单任务判定：runs 是该任务 k 次隔离执行的布尔结果（true=测试转绿）。
 * 全过才算过；runs 数量必须 >= k，否则视为执行不足（不通过）。
 * @param {boolean[]} runs
 * @param {number} k
 */
export function passAtK(runs, k = NOE_SELF_IMPROVE_BENCH_DEFAULT_K) {
  const need = normalizeK(k);
  const list = arr(runs).map((r) => r === true);
  // 短路：空样本（无 runs）直接返回零分结构，避免后续聚合产生 NaN 或抛错。
  // 所有零分样本（runs 全 false / runs 不足 k）天然落在下方分支，不会触发除零。
  if (list.length === 0) {
    return {
      passed: false,
      k: need,
      runs: 0,
      greenRuns: 0,
      sufficient: false,
      // 单任务分：pass^k 是 0/1（全绿才 1）；空样本一律 0。
      score: 0,
      greenRate: 0,
    };
  }
  const greenRuns = list.filter(Boolean).length;
  const sufficient = list.length >= need;
  const passed = sufficient && list.slice(0, need).every(Boolean);
  return {
    passed,
    k: need,
    runs: list.length,
    greenRuns,
    sufficient,
    // 单任务分：pass^k 是 0/1（全绿才 1）。另给 greenRate 作诊断（非计分用）。
    score: passed ? 1 : 0,
    greenRate: list.length ? Math.round((greenRuns / list.length) * 10000) / 10000 : 0,
  };
}

/**
 * 校验任务集合法性（任务 = fixture 清单）。每个任务必须有 id/category/subjectFile/testFile，
 * 且 subjectFile 与 testFile 必须是相对、无路径混淆的安全名。
 * @param {Array<object>} tasks
 */
export function validateSelfImproveBenchTasks(tasks) {
  const errors = [];
  const list = arr(tasks);
  if (list.length === 0) errors.push('bench_tasks_empty');
  const seen = new Set();
  const allowedCategories = new Set(['bug_fix', 'boundary', 'feature']);
  for (const [index, task] of list.entries()) {
    const where = `task[${index}]`;
    if (!isObject(task)) {
      errors.push(`${where}_must_be_object`);
      continue;
    }
    const id = clean(task.id, 160);
    if (!id) errors.push(`${where}_id_required`);
    if (id && seen.has(id)) errors.push(`bench_task_id_duplicate:${id}`);
    if (id) seen.add(id);
    if (!allowedCategories.has(clean(task.category, 40))) errors.push(`${where}_category_unknown:${clean(task.category, 40) || 'blank'}`);
    for (const field of ['subjectFile', 'testFile', 'buggyFile']) {
      const ref = clean(task[field], 240);
      if (!ref) {
        errors.push(`${where}_${field}_required`);
        continue;
      }
      if (ref.startsWith('/') || ref.startsWith('~') || ref.includes('..') || ref.includes('\\') || ref.includes('\x00')) {
        errors.push(`${where}_${field}_unsafe:${ref}`);
      }
    }
  }
  return { ok: errors.length === 0, errors, taskCount: list.length };
}

/**
 * 候选改动纯函数预检（执行前防 reward-hack）。
 * candidate 形如 { content?: string, writes?: [{ path, content }] }：
 *   - content：直接给本任务 subjectFile 的完整新内容（最常见）。
 *   - writes：候选声称要写的路径列表（用于检测越界 / 写评测产物刷分企图）。
 * @param {object} candidate
 * @param {object} task                本任务清单（含 subjectFile / buggyFile 等）
 * @param {{ buggyContent?: string, extraForbiddenPrefixes?: string[] }} ctx
 * @returns {{ ok: boolean, verdict: string, reason: string, normalizedContent: string|null }}
 */
export function precheckSelfImproveCandidate(candidate, task, ctx = {}) {
  const subjectFile = clean(task?.subjectFile, 240);
  const buggyContent = typeof ctx.buggyContent === 'string' ? ctx.buggyContent : '';
  const extraForbiddenPrefixes = arr(ctx.extraForbiddenPrefixes);

  if (!isObject(candidate)) {
    return { ok: false, verdict: 'not_attempted', reason: 'candidate_not_object', normalizedContent: null };
  }

  // ② + ③：先扫所有声称要写的路径（writes 列表 + 隐含的 subjectFile）。
  const declaredWrites = arr(candidate.writes)
    .map((w) => (isObject(w) ? clean(w.path, 240) : clean(w, 240)))
    .filter(Boolean);
  for (const path of declaredWrites) {
    const forbiddenReason = selfImproveForbiddenEvalPathReason(path, { extraPrefixes: extraForbiddenPrefixes });
    if (forbiddenReason) {
      return { ok: false, verdict: 'forbidden', reason: forbiddenReason, normalizedContent: null };
    }
    if (path !== subjectFile) {
      return { ok: false, verdict: 'out_of_scope', reason: `write_outside_subject:${path}`, normalizedContent: null };
    }
  }

  // 取候选给 subjectFile 的新内容：优先 writes 里匹配 subjectFile 的；否则用 candidate.content。
  let content = null;
  const subjectWrite = arr(candidate.writes).find((w) => isObject(w) && clean(w.path, 240) === subjectFile);
  if (subjectWrite && typeof subjectWrite.content === 'string') content = subjectWrite.content;
  else if (typeof candidate.content === 'string') content = candidate.content;

  // ① 空改动：没给内容 / 与 buggy 完全一致 / 仅空白差异 => 不劳而获，判 not_attempted。
  if (content === null) {
    return { ok: false, verdict: 'not_attempted', reason: 'no_subject_content', normalizedContent: null };
  }
  if (content === buggyContent) {
    return { ok: false, verdict: 'not_attempted', reason: 'identical_to_buggy', normalizedContent: null };
  }
  if (content.replace(/\s+/g, '') === buggyContent.replace(/\s+/g, '')) {
    return { ok: false, verdict: 'not_attempted', reason: 'whitespace_only_change', normalizedContent: null };
  }

  return { ok: true, verdict: 'attempted', reason: '', normalizedContent: content };
}

/**
 * 结构化深度相等（父进程 oracle 比对用）。只认 JSON 可表达的值（number/string/bool/null/array/
 * plain object），NaN 视为相等于 NaN（probe 期望可写 NaN 时也能比）。不调用任何被测对象方法，
 * 避免被污染的原型/toJSON 干扰判定。
 * @param {any} a
 * @param {any} b
 */
export function deepEqualSample(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqualSample(a[i], b[i])) return false;
    }
    return true;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqualSample(a[key], b[key])) return false;
  }
  return true;
}

/**
 * 【转绿判定核心】父进程拿子进程回吐的行为采样 + 本任务 oracle(probes) 比对。
 * - sampleResult：通用采样壳输出的 { ok, exportName, samples:[{name, returned?|threw?}] } | { ok:false, error }。
 * - probes：评测器内部持有的期望清单 [{ name, args, hasExpect, expect, expectThrow }]。
 * 判定规则（任一不满足 => 不绿）：
 *   1. 采样块本身合法（ok===true 且 samples 是数组）。
 *   2. 每个 probe 都有对应同名采样。
 *   3. expectThrow 的 probe：采样必须 threw（抛错）。
 *   4. 否则采样必须 returned 且 deepEqual(returned, expect)。
 * 子进程伪造不出来：它给不出"正确返回值"除非真实现正确；给假 ok/缺采样/错值一律判不绿。
 * @param {object|null} sampleResult
 * @param {Array<object>} probes
 * @returns {{ green: boolean, reason: string, matched: number, total: number }}
 */
export function assertSamplesAgainstProbes(sampleResult, probes) {
  const list = arr(probes);
  const total = list.length;
  if (!isObject(sampleResult) || sampleResult.ok !== true || !Array.isArray(sampleResult.samples)) {
    const why = isObject(sampleResult) && sampleResult.error
      ? clean(sampleResult.error, 200)
      : 'no_valid_samples';
    return { green: false, reason: `samples_invalid:${why}`, matched: 0, total };
  }
  if (total === 0) {
    return { green: false, reason: 'no_probes', matched: 0, total };
  }
  const byName = new Map();
  for (const s of sampleResult.samples) {
    if (isObject(s) && typeof s.name === 'string') byName.set(s.name, s);
  }
  let matched = 0;
  for (const probe of list) {
    const sample = byName.get(String(probe.name));
    if (!sample) {
      return { green: false, reason: `sample_missing:${probe.name}`, matched, total };
    }
    if (probe.expectThrow) {
      if (typeof sample.threw === 'string') { matched += 1; continue; }
      return { green: false, reason: `expected_throw:${probe.name}`, matched, total };
    }
    if (typeof sample.threw === 'string') {
      return { green: false, reason: `unexpected_throw:${probe.name}`, matched, total };
    }
    if (!Object.prototype.hasOwnProperty.call(sample, 'returned')) {
      return { green: false, reason: `no_return:${probe.name}`, matched, total };
    }
    if (!deepEqualSample(sample.returned, probe.expect)) {
      return { green: false, reason: `mismatch:${probe.name}`, matched, total };
    }
    matched += 1;
  }
  return { green: matched === total, reason: matched === total ? '' : 'incomplete', matched, total };
}

/**
 * 聚合多任务的 pass^k 结果成总分（passedTasks / totalTasks），并保留每任务明细。
 * caseResults 每项形如：
 *   { id, category, verdict, prechecked:boolean, passAtK:{ passed,... } | null }
 * @param {Array<object>} caseResults
 * @param {number} k
 */
export function aggregateSelfImproveBench(caseResults, k = NOE_SELF_IMPROVE_BENCH_DEFAULT_K) {
  const need = normalizeK(k);
  const list = arr(caseResults);
  const total = list.length;
  const passed = list.filter((c) => c?.passAtK?.passed === true).length;
  const byCategory = {};
  for (const c of list) {
    const cat = clean(c?.category, 40) || 'unknown';
    byCategory[cat] = byCategory[cat] || { total: 0, passed: 0 };
    byCategory[cat].total += 1;
    if (c?.passAtK?.passed === true) byCategory[cat].passed += 1;
  }
  return {
    ok: total > 0 && passed === total,
    schemaVersion: NOE_SELF_IMPROVE_BENCH_SCHEMA_VERSION,
    k: need,
    totalTasks: total,
    passedTasks: passed,
    failedTasks: total - passed,
    // 总分 = 通过任务占比（每任务本身是 pass^k 的 0/1）。
    score: total ? Math.round((passed / total) * 10000) / 10000 : 0,
    byCategory,
  };
}
