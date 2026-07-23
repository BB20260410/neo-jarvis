// @ts-check
// NoeSelfImproveBenchRunner — P6 自改回归集的【隔离执行层】（IO，与纯函数评分分离）。
//
// 【P0 反 reward-hack 隔离重构（三方审命脉）——判分搬到候选完全够不到的地方】
// 旧架构的命门：候选 subject 与"判分逻辑"同进程/同 realm，且转绿靠子进程【自报】一个 nonce 凭证。
// 三方审实测三种绕过全部 score1：① ps 从 OS 进程表读 argv 里的 nonce；② 顶层污染 process.exit；
// ③ 顶层污染 Array.prototype.push 腐蚀测试壳失败门。根因都是"判定信号在候选可达处、可被伪造"。
//
// 新架构（本文件）：
//   1. 子进程只跑【任务无关的通用采样壳】(harnessContent)：import subject、对父进程给定【输入】调用
//      目标函数、把【真实返回值 / 抛错】结构化打印到一对哨兵之间。它【不判对错、不读 nonce、不打印
//      任何"通过信号"】。
//   2. 期望输出（oracle = probes[].expect）只在【父进程】手里，写进临时目录的 __probe_inputs.json 的
//      只有【输入】（函数名 + 实参），【绝不含期望值】。
//   3. 转绿判定 100% 在父进程 realm：parseSamples() 解析哨兵块 -> assertSamplesAgainstProbes() 用
//      oracle 深度比对。子进程对父进程结论【没有任何句柄】，任何全局污染只会让采样不可信 => 判不绿，
//      绝无法把错误返回值伪装成正确返回值。
//   4. 子进程 env 收紧到最小白名单（默认仅 PATH/HOME/临时目录变量），并静态拒绝引用 child_process /
//      process.binding / createRequire / require( 的 subject（断 ps/execSync 这条偷信息的路）。
//   5. 评测结果写到调用方给的 resultSink（默认内存数组），与执行临时目录不同源。
//
// nonce 彻底退场：判定不再依赖任何"子进程自报的成功凭证"，因此 OS 进程表/argv/env 里【根本没有】
// 可偷可伪造的 nonce —— P0① 的两条机制（ps 读 / argv 偷）失去攻击面。
//
// DI：执行/读写全部经 deps 注入（spawn / mkdtemp / writeFile / readFile / rm），便于单测替身。
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  passAtK,
  precheckSelfImproveCandidate,
  validateSelfImproveBenchTasks,
  aggregateSelfImproveBench,
  assertSamplesAgainstProbes,
  NOE_SELF_IMPROVE_BENCH_DEFAULT_K,
  NOE_SELF_IMPROVE_BENCH_SCHEMA_VERSION,
} from './NoeSelfImproveBenchScore.js';
import { candidatePublicView } from './NoeSelfImproveBenchLoader.js';

/** @typedef {{ status: number|null, stdout?: string, stderr?: string }} SpawnResult */

const SAMPLES_BEGIN = '<<<NOE_BENCH_SAMPLES_BEGIN>>>';
const SAMPLES_END = '<<<NOE_BENCH_SAMPLES_END>>>';

// 子进程最小 env 白名单（P0③）：只放运行 node 必需的少量变量，剥掉其余（含可能携带 nonce/secret 的）。
const ENV_ALLOWLIST = ['PATH', 'HOME', 'TMPDIR', 'NODE_PATH', 'LANG', 'LC_ALL'];

// 静态禁止 subject 引用进程/原生能力（断 execSync('ps ...') 这条从 OS 进程表偷信息的路）。
const SUBJECT_FORBIDDEN_API_RE = /\b(?:child_process|process\.binding|createRequire|require\s*\()/;

const DEFAULT_DEPS = Object.freeze({
  spawnSync: nodeSpawnSync,
  mkdtemp: (prefix) => mkdtempSync(prefix),
  writeFile: (p, c) => writeFileSync(p, c),
  readFile: (p) => readFileSync(p, 'utf8'),
  rm: (p) => rmSync(p, { recursive: true, force: true }),
  mkdir: (p) => mkdirSync(p, { recursive: true }),
  token: () => randomBytes(32).toString('hex'),
});

function macOf(token, json) {
  return createHash('sha256').update(String(token) + String(json)).digest('hex');
}

function asResultSink(sink) {
  // resultSink 可注入；默认给内存数组。它与执行临时目录解耦——候选进程够不到。
  const store = Array.isArray(sink) ? sink : [];
  return {
    push: (record) => { store.push(record); },
    all: () => store.slice(),
  };
}

function minimalEnv() {
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  return env;
}

/**
 * 从子进程 stdout 抽出哨兵包裹的【认证采样块】，验证 HMAC 后返回内层采样对象。
 * envelope = { mac, json }，要求 mac === sha256(token + json)。逐对哨兵从后往前扫，返回【第一个
 * 通过 mac 校验】的块（防候选顶层抢印伪造块：伪造块算不出合法 mac => 被跳过 => 取不到合法采样）。
 * @param {string} stdout
 * @param {string} token  本次运行的一次性认证 token（仅父进程与采样壳知道，候选 subject 够不到）
 * @returns {object|null}  通过校验的内层采样对象；无合法块返回 null
 */
function parseSamples(stdout, token) {
  const text = String(stdout ?? '');
  let searchFrom = text.length;
  // 从后往前遍历所有哨兵块，找第一个 mac 合法的（容忍前面混入的伪造块）。
  for (;;) {
    const endIdx = text.lastIndexOf(SAMPLES_END, searchFrom);
    if (endIdx < 0) return null;
    const beginIdx = text.lastIndexOf(SAMPLES_BEGIN, endIdx);
    if (beginIdx < 0) return null;
    searchFrom = beginIdx - 1;
    const inner = text.slice(beginIdx + SAMPLES_BEGIN.length, endIdx).trim();
    try {
      const envelope = JSON.parse(inner);
      if (envelope && typeof envelope === 'object'
        && typeof envelope.mac === 'string'
        && typeof envelope.json === 'string'
        && envelope.mac === macOf(token, envelope.json)) {
        const payload = JSON.parse(envelope.json);
        if (payload && typeof payload === 'object') return payload;
      }
    } catch { /* 该块损坏/伪造，继续往前找 */ }
    if (beginIdx <= 0) return null;
  }
}

/**
 * 在隔离临时目录里跑一次该任务的采样（独立子进程），父进程用 oracle 判定是否转绿。
 * @param {object} task            完整评测器视图任务（含 probes 带 expect / harnessContent / exportName）
 * @param {string} subjectContent  候选给 subjectFile 的完整内容
 * @param {object} deps
 * @returns {{ green: boolean, status: number|null, reason: string, stdout: string, stderr: string }}
 */
function runOnceIsolated(task, subjectContent, deps) {
  // 静态闸（P0③）：subject 引用进程/原生能力一律不执行，直接判不绿（断偷 nonce/越权路）。
  if (SUBJECT_FORBIDDEN_API_RE.test(String(subjectContent))) {
    return { green: false, status: null, reason: 'subject_uses_forbidden_api', stdout: '', stderr: '' };
  }
  const dir = deps.mkdtemp(join(tmpdir(), 'noe-si-bench-'));
  // 一次性认证 token：只写进临时文件 __bench_token（采样壳读后即删），【不进 argv/env/命令行】。
  const token = String(deps.token ? deps.token() : randomBytes(32).toString('hex'));
  try {
    const subjectPath = join(dir, String(task.subjectFile));
    const harnessPath = join(dir, String(task.testFile || 'test.mjs'));
    const inputsPath = join(dir, '__probe_inputs.json');
    const tokenPath = join(dir, '__bench_token');
    // __probe_inputs.json 只含【输入】（函数名 + 实参），绝不含期望值（oracle 只留父进程）。
    const probeInputs = candidatePublicView(task).probeInputs;
    deps.writeFile(subjectPath, subjectContent);
    deps.writeFile(harnessPath, String(task.harnessContent ?? task.testContent ?? ''));
    deps.writeFile(inputsPath, JSON.stringify({ exportName: String(task.exportName || ''), inputs: probeInputs }));
    deps.writeFile(tokenPath, token);
    /** @type {SpawnResult} */
    const res = deps.spawnSync('node', [harnessPath], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30000,
      env: minimalEnv(), // P0③：最小 env 白名单（token 不在 env 里）
    });
    const status = res?.status ?? null;
    const stdout = String(res?.stdout ?? '');
    const stderr = String(res?.stderr ?? '');
    // 父进程 realm 判定：验 mac 取合法采样块 -> 用 oracle(probes) 深度比对。子进程 exit code 不参与判定。
    const samples = parseSamples(stdout, token);
    const verdict = assertSamplesAgainstProbes(samples, task.probes);
    return {
      green: verdict.green,
      status,
      reason: verdict.reason,
      stdout: stdout.slice(0, 2000),
      stderr: stderr.slice(0, 2000),
    };
  } finally {
    try { deps.rm(dir); } catch { /* 临时目录残留人工清，不影响结论 */ }
  }
}

/**
 * 执行整个 self-improve bench：对每个任务取候选改动（喂【候选可见视图】，无 oracle）-> 纯函数预检
 * （防 reward-hack）-> 通过则隔离跑 k 次（父进程判分）-> pass^k -> 聚合。
 *
 * @param {object} options
 * @param {Array<object>} options.tasks            任务清单（完整评测器视图，含 probes 带 expect）
 * @param {(publicTask:object)=>object} options.getCandidate  给定【候选可见视图】返回候选改动
 *   { content } | { writes:[...] }。注意：传入的是剥离了 fixedContent/expect/harness 的安全视图。
 * @param {number} [options.k]
 * @param {Array} [options.resultSink]  评测结果落点（与执行临时目录隔离）；默认内存数组
 * @param {object} [options.deps]
 * @returns {object} 总报告
 */
export function runNoeSelfImproveBench({
  tasks = [],
  getCandidate,
  k = NOE_SELF_IMPROVE_BENCH_DEFAULT_K,
  resultSink,
  deps = DEFAULT_DEPS,
} = {}) {
  const mergedDeps = { ...DEFAULT_DEPS, ...(deps || {}) };
  const sink = asResultSink(resultSink);
  const tasksValidation = validateSelfImproveBenchTasks(tasks);
  if (!tasksValidation.ok) {
    return {
      ok: false,
      schemaVersion: NOE_SELF_IMPROVE_BENCH_SCHEMA_VERSION,
      errors: tasksValidation.errors,
      caseResults: [],
      summary: aggregateSelfImproveBench([], k),
    };
  }
  if (typeof getCandidate !== 'function') {
    return {
      ok: false,
      schemaVersion: NOE_SELF_IMPROVE_BENCH_SCHEMA_VERSION,
      errors: ['get_candidate_required'],
      caseResults: [],
      summary: aggregateSelfImproveBench([], k),
    };
  }

  const caseResults = [];
  for (const task of tasks) {
    const buggyContent = typeof task.buggyContent === 'string' ? task.buggyContent : '';
    // P0②：只把【候选可见视图】喂给候选——剥离 fixedContent / 任何 expect / harness 内容。
    const publicTask = candidatePublicView(task);
    let candidate = {};
    try {
      candidate = getCandidate(publicTask) || {};
    } catch (err) {
      candidate = { __error: String(err?.message || err) };
    }

    const precheck = precheckSelfImproveCandidate(candidate, task, { buggyContent });
    /** @type {object} */
    const record = {
      id: String(task.id),
      category: String(task.category || 'unknown'),
      verdict: precheck.verdict,
      reason: precheck.reason,
      prechecked: precheck.ok,
      passAtK: null,
      runs: [],
    };

    if (!precheck.ok) {
      // 预检不过（空改动 / 写禁区 / 越界）：直接 0 分，绝不执行（防不劳而获 + 防污染评测）。
      record.passAtK = passAtK([], k);
      caseResults.push(record);
      sink.push(record);
      continue;
    }

    const runs = [];
    const need = passAtK([], k).k; // 归一化后的 k
    for (let i = 0; i < need; i += 1) {
      const r = runOnceIsolated(task, precheck.normalizedContent || '', mergedDeps);
      runs.push(r.green);
      record.runs.push({ green: r.green, status: r.status, reason: r.reason });
    }
    record.passAtK = passAtK(runs, k);
    record.verdict = record.passAtK.passed ? 'fixed' : 'still_failing';
    caseResults.push(record);
    sink.push(record);
  }

  const summary = aggregateSelfImproveBench(caseResults, k);
  return {
    ok: summary.ok,
    schemaVersion: NOE_SELF_IMPROVE_BENCH_SCHEMA_VERSION,
    errors: [],
    k: summary.k,
    caseResults,
    summary,
    // 评测结论从隔离 sink 读取（与执行临时目录不同源），证明"评测器在另一处读结果"。
    resultSinkCount: sink.all().length,
  };
}
