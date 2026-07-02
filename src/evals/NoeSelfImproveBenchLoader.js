// @ts-check
// NoeSelfImproveBenchLoader — 从 evals/neo/selfimprove-bench/ 把任务 fixtures 读进内存，
// 组装成 runner 需要的形状。纯读，不写任何东西；DI 注入 fs 以便单测。
//
// 【P0② 防把参考答案当候选】task 分两套视图：
//   - 完整 evaluator 视图（本模块返回的 task）：含 fixedContent / probes(带期望 expect) / harnessContent，
//     仅评测器内部使用。
//   - 候选可见视图（candidatePublicView）：只含 buggyContent + 公开约束（subjectFile/category/title/
//     summary/export/signature/probe 输入名）——【绝不含 fixedContent / 任何 expect / harness 内容】。
// runner 把候选可见视图喂给 getCandidate；oracle 只在评测器手里。
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_BENCH_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../evals/neo/selfimprove-bench');

/**
 * @typedef {{
 *   readFile: (p: string) => string,
 *   readdir: (p: string) => string[],
 *   exists: (p: string) => boolean,
 *   isDir: (p: string) => boolean,
 * }} FsLike
 */
/** @type {FsLike} */
const DEFAULT_FS = Object.freeze({
  readFile: (p) => readFileSync(p, 'utf8'),
  readdir: (p) => /** @type {string[]} */ (readdirSync(p)),
  exists: (p) => existsSync(p),
  isDir: (p) => { try { return statSync(p).isDirectory(); } catch { return false; } },
});

/**
 * @param {string} text
 * @returns {any}
 */
function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * @param {unknown} value
 * @returns {unknown[]}
 */
function arr(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * 把 manifest 的 probes 规范成 { name, args, expect, expectThrow } 列表（expect 是 oracle，仅评测器持有）。
 * @param {unknown} rawProbes
 * @returns {Array<{name: string, args: unknown[], hasExpect: boolean, expect: any, expectThrow: boolean}>}
 */
function normalizeProbes(rawProbes) {
  return arr(rawProbes)
    .filter((p) => p && typeof p === 'object')
    .map((p, i) => {
      /** @type {Record<string, any>} */
      const o = p;
      return {
        name: String(o.name ?? `probe-${i + 1}`),
        args: arr(o.args),
        // expect 缺省也允许（用 expectThrow 表达"应抛错"场景）；undefined 用哨兵标记便于精确比对。
        hasExpect: Object.prototype.hasOwnProperty.call(o, 'expect'),
        expect: o.expect,
        expectThrow: o.expectThrow === true,
      };
    });
}

/**
 * 加载所有任务。返回 { ok, tasks, errors }。tasks 每项是【完整评测器视图】。
 * @param {{ benchDir?: string, fs?: FsLike }} [opts]
 * @returns {{ ok: boolean, tasks: any[], errors: string[] }}
 */
export function loadNoeSelfImproveBenchTasks({ benchDir = DEFAULT_BENCH_DIR, fs = DEFAULT_FS } = {}) {
  const errors = [];
  const tasks = [];
  if (!fs.exists(benchDir) || !fs.isDir(benchDir)) {
    return { ok: false, tasks, errors: [`bench_dir_missing:${benchDir}`] };
  }
  const entries = fs.readdir(benchDir)
    .filter((name) => !name.startsWith('_') && !name.startsWith('.') && name !== 'manifest.json')
    .filter((name) => fs.isDir(join(benchDir, name)))
    .sort();
  for (const name of entries) {
    const dir = join(benchDir, name);
    const manifestPath = join(dir, 'task.json');
    if (!fs.exists(manifestPath)) continue;
    const manifest = safeJson(fs.readFile(manifestPath));
    if (!manifest) {
      errors.push(`task_manifest_invalid:${name}`);
      continue;
    }
    const subjectFile = String(manifest.subjectFile || 'subject.js');
    const testFile = String(manifest.testFile || 'test.mjs');
    const buggyFile = String(manifest.buggyFile || 'subject.buggy.js');
    const fixedFile = String(manifest.fixedFile || 'subject.fixed.js');
    const exportName = String(manifest.export || '');
    const signature = String(manifest.signature || '');
    const probes = normalizeProbes(manifest.probes);
    if (!exportName) errors.push(`task_export_missing:${name}`);
    if (probes.length === 0) errors.push(`task_probes_missing:${name}`);
    try {
      const buggyContent = fs.readFile(join(dir, buggyFile));
      // harnessContent = 通用采样壳源码（候选改不到；runner 原样拷进临时目录跑）。
      const harnessContent = fs.readFile(join(dir, testFile));
      const fixedContent = fs.exists(join(dir, fixedFile)) ? fs.readFile(join(dir, fixedFile)) : '';
      tasks.push({
        id: String(manifest.id || name),
        category: String(manifest.category || 'unknown'),
        title: String(manifest.title || ''),
        summary: String(manifest.summary || ''),
        source: String(manifest.source || 'synthetic'),
        dir,
        subjectFile,
        testFile,
        buggyFile,
        fixedFile,
        exportName,
        signature,
        probes,
        buggyContent,
        // harnessContent 取代旧 testContent；保留 testContent 别名给老调用方但语义相同（采样壳，非 oracle）。
        harnessContent,
        testContent: harnessContent,
        fixedContent,
      });
    } catch (err) {
      errors.push(`task_read_failed:${name}:${String(err?.message || err).slice(0, 120)}`);
    }
  }
  return { ok: errors.length === 0 && tasks.length > 0, tasks, errors };
}

/**
 * 从完整任务派生【候选可见视图】：剥离 fixedContent / 任何 expect / harness 内容。
 * 候选只看到 bug 现状 + 公开约束（函数名/签名/probe 输入），看不到正确答案。
 * @param {Record<string, any>} task 完整评测器视图任务
 * @returns {Record<string, any>} 候选安全视图
 */
export function candidatePublicView(task = {}) {
  return {
    id: String(task.id ?? ''),
    category: String(task.category ?? 'unknown'),
    title: String(task.title ?? ''),
    summary: String(task.summary ?? ''),
    subjectFile: String(task.subjectFile ?? 'subject.js'),
    exportName: String(task.exportName ?? ''),
    signature: String(task.signature ?? ''),
    // 只暴露 bug 现状（候选据此修复）。
    buggyContent: typeof task.buggyContent === 'string' ? task.buggyContent : '',
    // 只暴露 probe 的【输入名 + 实参】，绝不暴露 expect。
    probeInputs: arr(task.probes).map((p, i) => ({
      name: String(p?.name ?? `probe-${i + 1}`),
      args: arr(p?.args),
    })),
  };
}

export { DEFAULT_BENCH_DIR };
