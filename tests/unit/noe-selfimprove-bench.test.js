// @ts-check
import { describe, expect, it } from 'vitest';
import {
  passAtK,
  precheckSelfImproveCandidate,
  validateSelfImproveBenchTasks,
  aggregateSelfImproveBench,
  deepEqualSample,
  assertSamplesAgainstProbes,
  NOE_SELF_IMPROVE_BENCH_DEFAULT_K,
} from '../../src/evals/NoeSelfImproveBenchScore.js';
import { runNoeSelfImproveBench } from '../../src/evals/NoeSelfImproveBenchRunner.js';
import { loadNoeSelfImproveBenchTasks, candidatePublicView } from '../../src/evals/NoeSelfImproveBenchLoader.js';
import {
  selfImproveForbiddenEvalPathReason,
  NOE_SELF_IMPROVE_FORBIDDEN_EVAL_PREFIXES,
} from '../../src/candidates/NoeCandidatePatchArtifactGate.js';

// ——— 任务集加载 + 合法性 ———
describe('self-improve bench 任务集（合成 fixtures）', () => {
  const loaded = loadNoeSelfImproveBenchTasks();

  it('加载到 10-20 个合成任务，三类齐全', () => {
    expect(loaded.ok).toBe(true);
    expect(loaded.errors).toEqual([]);
    expect(loaded.tasks.length).toBeGreaterThanOrEqual(10);
    expect(loaded.tasks.length).toBeLessThanOrEqual(20);
    const cats = new Set(loaded.tasks.map((t) => t.category));
    expect(cats.has('bug_fix')).toBe(true);
    expect(cats.has('boundary')).toBe(true);
    expect(cats.has('feature')).toBe(true);
  });

  it('每个任务都来源=synthetic 且自带 buggy/harness/fixed/export/probes 内容', () => {
    for (const t of loaded.tasks) {
      expect(t.source).toBe('synthetic');
      expect(t.buggyContent.length).toBeGreaterThan(0);
      expect(t.harnessContent.length).toBeGreaterThan(0);
      expect(t.fixedContent.length).toBeGreaterThan(0);
      expect(t.buggyContent).not.toBe(t.fixedContent);
      expect(t.exportName.length).toBeGreaterThan(0);
      expect(t.probes.length).toBeGreaterThan(0);
      // 每个 probe 必须带 oracle 期望（hasExpect 或 expectThrow），否则无法判分。
      for (const p of t.probes) {
        expect(p.hasExpect === true || p.expectThrow === true).toBe(true);
        expect(Array.isArray(p.args)).toBe(true);
      }
    }
  });

  it('【P0②】候选可见视图剥离 fixedContent / 任何 expect / harness（不泄漏 oracle）', () => {
    for (const t of loaded.tasks) {
      const view = candidatePublicView(t);
      expect('fixedContent' in view).toBe(false);
      expect('testContent' in view).toBe(false);
      expect('harnessContent' in view).toBe(false);
      expect('probes' in view).toBe(false);
      // probeInputs 只暴露输入名 + 实参，绝不含 expect。
      for (const pi of view.probeInputs) {
        expect('expect' in pi).toBe(false);
        expect(typeof pi.name).toBe('string');
        expect(Array.isArray(pi.args)).toBe(true);
      }
      // 候选视图整体序列化里不得出现参考修复源码（用 fixedContent 字节做反向探测）。
      const blob = JSON.stringify(view);
      expect(blob.includes(t.fixedContent)).toBe(false);
      // 但 bug 现状必须可见（候选据此修复）。
      expect(view.buggyContent).toBe(t.buggyContent);
    }
  });

  it('validateSelfImproveBenchTasks 接受合法集、拒绝不安全路径', () => {
    expect(validateSelfImproveBenchTasks(loaded.tasks).ok).toBe(true);
    const bad = validateSelfImproveBenchTasks([
      { id: 'x', category: 'bug_fix', subjectFile: '../escape.js', testFile: 'test.mjs', buggyFile: 'b.js' },
      { id: 'x', category: 'nope', subjectFile: 'subject.js', testFile: 't.mjs', buggyFile: 'b.js' },
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.errors.some((e) => e.includes('subjectFile_unsafe'))).toBe(true);
    expect(bad.errors.some((e) => e.includes('category_unknown'))).toBe(true);
    expect(bad.errors.some((e) => e.includes('id_duplicate'))).toBe(true);
  });

  it('空任务集判不合法', () => {
    const r = validateSelfImproveBenchTasks([]);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('bench_tasks_empty');
  });
});

// ——— pass^k 纯函数 ———
describe('pass^k 算法', () => {
  it('k 次全绿才算过', () => {
    expect(passAtK([true, true, true], 3).passed).toBe(true);
    expect(passAtK([true, true, true], 3).score).toBe(1);
  });
  it('任一次失败即不过', () => {
    expect(passAtK([true, false, true], 3).passed).toBe(false);
    expect(passAtK([true, true, false], 3).score).toBe(0);
  });
  it('运行次数不足 k 视为不过', () => {
    const r = passAtK([true, true], 3);
    expect(r.passed).toBe(false);
    expect(r.sufficient).toBe(false);
  });
  it('空运行集不过', () => {
    expect(passAtK([], 3).passed).toBe(false);
    expect(passAtK([], 3).greenRate).toBe(0);
  });
  it('非法 k 回退默认值', () => {
    expect(passAtK([true], 0).k).toBe(NOE_SELF_IMPROVE_BENCH_DEFAULT_K);
    expect(passAtK([true], -5).k).toBe(NOE_SELF_IMPROVE_BENCH_DEFAULT_K);
  });
});

// ——— 父进程判分纯函数（oracle 比对，候选够不到）———
describe('deepEqualSample 结构深比', () => {
  it('基本标量', () => {
    expect(deepEqualSample(1, 1)).toBe(true);
    expect(deepEqualSample('a', 'a')).toBe(true);
    expect(deepEqualSample(true, true)).toBe(true);
    expect(deepEqualSample(1, 2)).toBe(false);
    expect(deepEqualSample(0, false)).toBe(false); // 不做松散相等
    expect(deepEqualSample(null, undefined)).toBe(false);
  });
  it('NaN 相等于 NaN', () => {
    expect(deepEqualSample(NaN, NaN)).toBe(true);
  });
  it('数组与对象递归', () => {
    expect(deepEqualSample([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqualSample([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqualSample({ a: 2, b: 1 }, { b: 1, a: 2 })).toBe(true);
    expect(deepEqualSample({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqualSample([], {})).toBe(false);
  });
});

describe('assertSamplesAgainstProbes（父进程用 oracle 判转绿）', () => {
  const probes = [
    { name: '4', args: [4], hasExpect: true, expect: true },
    { name: '7', args: [7], hasExpect: true, expect: false },
  ];
  it('采样全对 -> green', () => {
    const r = assertSamplesAgainstProbes({ ok: true, samples: [
      { name: '4', returned: true }, { name: '7', returned: false },
    ] }, probes);
    expect(r.green).toBe(true);
    expect(r.matched).toBe(2);
  });
  it('任一采样值错 -> 不绿', () => {
    const r = assertSamplesAgainstProbes({ ok: true, samples: [
      { name: '4', returned: false }, { name: '7', returned: false },
    ] }, probes);
    expect(r.green).toBe(false);
    expect(r.reason).toBe('mismatch:4');
  });
  it('缺采样 -> 不绿', () => {
    const r = assertSamplesAgainstProbes({ ok: true, samples: [{ name: '4', returned: true }] }, probes);
    expect(r.green).toBe(false);
    expect(r.reason).toBe('sample_missing:7');
  });
  it('采样块非法(null / ok!=true) -> 不绿', () => {
    expect(assertSamplesAgainstProbes(null, probes).green).toBe(false);
    expect(assertSamplesAgainstProbes({ ok: false, error: 'boom' }, probes).reason).toBe('samples_invalid:boom');
  });
  it('expectThrow 的 probe：抛错算过、不抛算挂', () => {
    const tp = [{ name: 'x', args: [], hasExpect: false, expectThrow: true }];
    expect(assertSamplesAgainstProbes({ ok: true, samples: [{ name: 'x', threw: 'TypeError' }] }, tp).green).toBe(true);
    expect(assertSamplesAgainstProbes({ ok: true, samples: [{ name: 'x', returned: 1 }] }, tp).reason).toBe('expected_throw:x');
  });
  it('该返回值却抛错 -> unexpected_throw', () => {
    const r = assertSamplesAgainstProbes({ ok: true, samples: [
      { name: '4', threw: 'boom' }, { name: '7', returned: false },
    ] }, probes);
    expect(r.reason).toBe('unexpected_throw:4');
  });
  it('无 probe -> 不绿（防空集刷分）', () => {
    expect(assertSamplesAgainstProbes({ ok: true, samples: [] }, []).green).toBe(false);
  });
});

// ——— 候选预检（反向 probe 的纯函数核心）———
describe('候选预检 precheck（防 reward-hack）', () => {
  const task = { id: 't', subjectFile: 'subject.js', buggyFile: 'subject.buggy.js' };
  const buggyContent = 'export const x = 1; // bug\n';

  it('① 空改动 -> not_attempted', () => {
    const r = precheckSelfImproveCandidate({}, task, { buggyContent });
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe('not_attempted');
    expect(r.reason).toBe('no_subject_content');
  });

  it('① 与 buggy 字节一致 -> not_attempted', () => {
    const r = precheckSelfImproveCandidate({ content: buggyContent }, task, { buggyContent });
    expect(r.verdict).toBe('not_attempted');
    expect(r.reason).toBe('identical_to_buggy');
  });

  it('① 仅空白差异 -> not_attempted', () => {
    const r = precheckSelfImproveCandidate({ content: buggyContent + '\n\n   ' }, task, { buggyContent });
    expect(r.verdict).toBe('not_attempted');
    expect(r.reason).toBe('whitespace_only_change');
  });

  it('② 候选写评测结果文件 -> forbidden', () => {
    const r = precheckSelfImproveCandidate({
      writes: [
        { path: 'subject.js', content: 'export const x = 2;\n' },
        { path: 'output/noe-selfimprove-bench/result.json', content: '{}' },
      ],
    }, task, { buggyContent });
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe('forbidden');
    expect(r.reason).toContain('eval_path_forbidden');
  });

  it('② 候选写 conftest 类污染文件 -> forbidden', () => {
    const r = precheckSelfImproveCandidate({
      writes: [{ path: 'conftest.mjs', content: 'x' }],
    }, task, { buggyContent });
    expect(r.verdict).toBe('forbidden');
  });

  it('③ 越界改非本任务 subjectFile -> out_of_scope', () => {
    const r = precheckSelfImproveCandidate({
      writes: [{ path: 'src/server/routes/noe.js', content: 'x' }],
    }, task, { buggyContent });
    expect(r.verdict).toBe('out_of_scope');
  });

  it('真修复（内容不同且只写 subjectFile）-> attempted', () => {
    const r = precheckSelfImproveCandidate({ content: 'export const x = 2; // fixed\n' }, task, { buggyContent });
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe('attempted');
    expect(r.normalizedContent).toContain('fixed');
  });
});

// ——— ④ 直接打 FORBIDDEN_TARGET 复用入口 ———
describe('④ FORBIDDEN 禁区复用（候选 patch gate 思路扩到评测产物）', () => {
  it('评测目录前缀全部被挡', () => {
    for (const prefix of NOE_SELF_IMPROVE_FORBIDDEN_EVAL_PREFIXES) {
      expect(selfImproveForbiddenEvalPathReason(`${prefix}anything.json`)).not.toBe('');
    }
  });
  it('private_holdout 被挡', () => {
    expect(selfImproveForbiddenEvalPathReason('evals/neo/private_holdout/secret.json')).not.toBe('');
  });
  it('路径混淆 / 越级被挡', () => {
    expect(selfImproveForbiddenEvalPathReason('../../etc/passwd')).not.toBe('');
    expect(selfImproveForbiddenEvalPathReason('evals/neo/selfimprove-bench/../../escape')).not.toBe('');
  });
  it('结果/产物文件名特征被挡（即便不在已知前缀）', () => {
    expect(selfImproveForbiddenEvalPathReason('some/dir/score.json')).not.toBe('');
    expect(selfImproveForbiddenEvalPathReason('a/b/verdict.json')).not.toBe('');
  });
  it('正常源码路径不被误挡', () => {
    expect(selfImproveForbiddenEvalPathReason('subject.js')).toBe('');
    expect(selfImproveForbiddenEvalPathReason('src/cognition/NoeWorkspace.js')).toBe('');
  });
});

// ——— 聚合 ———
describe('aggregateSelfImproveBench 聚合', () => {
  it('全过 ok=true，分数=1', () => {
    const r = aggregateSelfImproveBench([
      { id: 'a', category: 'bug_fix', passAtK: { passed: true } },
      { id: 'b', category: 'boundary', passAtK: { passed: true } },
    ], 3);
    expect(r.ok).toBe(true);
    expect(r.score).toBe(1);
    expect(r.passedTasks).toBe(2);
  });
  it('部分过 ok=false', () => {
    const r = aggregateSelfImproveBench([
      { id: 'a', category: 'bug_fix', passAtK: { passed: true } },
      { id: 'b', category: 'boundary', passAtK: { passed: false } },
    ], 3);
    expect(r.ok).toBe(false);
    expect(r.score).toBe(0.5);
    expect(r.byCategory.bug_fix.passed).toBe(1);
    expect(r.byCategory.boundary.passed).toBe(0);
  });
});

// ——— 隔离执行（端到端，真跑子进程 + mkdtemp）———
// 注意：getCandidate 收到的是【候选可见视图】（无 fixedContent）。评测器自己持有完整任务，需用
// fixedContent 造"真修复"候选时从 id 索引取（模拟 CLI 的 oracle-fixed 自检路径）。
describe('隔离执行 runNoeSelfImproveBench（真子进程 + 临时目录）', () => {
  const loaded = loadNoeSelfImproveBenchTasks();
  const fixedById = new Map(loaded.tasks.map((t) => [t.id, t.fixedContent]));
  const buggyById = new Map(loaded.tasks.map((t) => [t.id, t.buggyContent]));

  it('③ 真修复 -> 全部任务 pass^k 转绿，score=1', () => {
    const sink = [];
    const report = runNoeSelfImproveBench({
      tasks: loaded.tasks,
      getCandidate: (pt) => ({ content: fixedById.get(pt.id) }),
      k: 2,
      resultSink: sink,
    });
    expect(report.ok).toBe(true);
    expect(report.summary.passedTasks).toBe(loaded.tasks.length);
    expect(report.summary.score).toBe(1);
    // 评测结论从隔离 sink 读取（与执行临时目录不同源）
    expect(report.resultSinkCount).toBe(loaded.tasks.length);
    expect(sink.length).toBe(loaded.tasks.length);
    for (const c of report.caseResults) {
      expect(c.passAtK.passed).toBe(true);
      expect(c.runs.length).toBe(2);
    }
  });

  it('① 空改动 -> 0 分，且根本没执行（runs 为空）', () => {
    const report = runNoeSelfImproveBench({
      tasks: loaded.tasks,
      getCandidate: () => ({}),
      k: 2,
    });
    expect(report.summary.passedTasks).toBe(0);
    expect(report.summary.score).toBe(0);
    for (const c of report.caseResults) {
      expect(c.verdict).toBe('not_attempted');
      expect(c.runs.length).toBe(0); // 不劳而获被挡在执行之前
    }
  });

  it('buggy 原文 -> 0 分（等价空改动）', () => {
    const report = runNoeSelfImproveBench({
      tasks: loaded.tasks,
      getCandidate: (pt) => ({ content: buggyById.get(pt.id) }),
      k: 2,
    });
    expect(report.summary.score).toBe(0);
    for (const c of report.caseResults) expect(c.reason).toBe('identical_to_buggy');
  });

  it('② 污染候选（真修复 + 企图写评测结果）-> 被 FORBIDDEN 挡，0 分，不执行', () => {
    const report = runNoeSelfImproveBench({
      tasks: loaded.tasks,
      getCandidate: (pt) => ({
        writes: [
          { path: pt.subjectFile, content: fixedById.get(pt.id) }, // 即便带真修复
          { path: 'output/noe-selfimprove-bench/result.json', content: '{"passed":true}' },
        ],
      }),
      k: 2,
    });
    expect(report.summary.score).toBe(0); // 写结果文件刷分企图未得逞
    for (const c of report.caseResults) {
      expect(c.verdict).toBe('forbidden');
      expect(c.runs.length).toBe(0);
    }
  });

  it('混合：一半真修复一半 buggy -> 分数严格反映真实通过率', () => {
    const report = runNoeSelfImproveBench({
      tasks: loaded.tasks,
      getCandidate: (pt) => {
        const idx = loaded.tasks.findIndex((t) => t.id === pt.id);
        return idx % 2 === 0 ? { content: fixedById.get(pt.id) } : { content: buggyById.get(pt.id) };
      },
      k: 2,
    });
    const expectedPass = loaded.tasks.filter((_, i) => i % 2 === 0).length;
    expect(report.summary.passedTasks).toBe(expectedPass);
    expect(report.ok).toBe(false);
  });

  it('candidate 抛错 -> 该任务计为 not_attempted 不崩', () => {
    const report = runNoeSelfImproveBench({
      tasks: loaded.tasks.slice(0, 2),
      getCandidate: () => { throw new Error('boom'); },
      k: 2,
    });
    expect(report.summary.score).toBe(0);
    for (const c of report.caseResults) expect(c.prechecked).toBe(false);
  });

  it('任务集非法 / 缺 getCandidate -> 报告 ok=false 不崩', () => {
    expect(runNoeSelfImproveBench({ tasks: [], getCandidate: () => ({}) }).ok).toBe(false);
    expect(runNoeSelfImproveBench({ tasks: loaded.tasks, getCandidate: null }).errors).toContain('get_candidate_required');
  });
});

// ——— 防 reward-hack 伪造转绿（三方审 P0① 命脉）：判分搬到候选够不到处后，攻击全 score0 ———
// 这些用例钉死：判定不再依赖任何"子进程自报凭证"，无 nonce 可偷、子进程 exit code 不参与判定、
// 伪造采样块算不出合法 mac（认证 token 候选够不到）。
describe('防伪造转绿（候选 subject 企图欺骗判定）', () => {
  const loaded = loadNoeSelfImproveBenchTasks();
  const task = loaded.tasks.find((t) => t.id === 'is-even');
  const B = '<<<NOE_BENCH_SAMPLES_BEGIN>>>';
  const E = '<<<NOE_BENCH_SAMPLES_END>>>';
  const correctPayload = JSON.stringify({
    ok: true,
    exportName: 'isEven',
    samples: [
      { name: '4', returned: true }, { name: '7', returned: false },
      { name: '0', returned: true }, { name: 'neg2', returned: true },
    ],
  });
  const run = (content) => runNoeSelfImproveBench({ tasks: [task], getCandidate: () => ({ content }), k: 3 });

  it('【P0①机制B】ps 从 OS 进程表偷信息 + 错误实现 -> 被静态闸挡，score0', () => {
    const content = "import { execSync } from 'node:child_process';\n"
      + "try { execSync('ps -p ' + process.pid + ' -o command='); } catch {}\n"
      + 'export function isEven(){ return false; }\n';
    const r = run(content);
    expect(r.summary.score).toBe(0);
    expect(r.caseResults[0].runs.every((x) => x.reason === 'subject_uses_forbidden_api')).toBe(true);
  });

  it('【P0①机制A】顶层污染 process.exit + 错误实现 -> exit code 不参与判定，score0', () => {
    const content = 'process.exit = () => {};\nexport function isEven(){ return false; }\n';
    expect(run(content).summary.score).toBe(0);
  });

  it('【P0①机制A】顶层污染 Array.prototype.push + 错误实现 -> 判分不在子进程，score0', () => {
    const content = 'Array.prototype.push = function(){ return this.length; };\nexport function isEven(){ return false; }\n';
    expect(run(content).summary.score).toBe(0);
  });

  it('顶层伪造采样块(给正确值)但无合法 mac -> 被弃用，score0', () => {
    const content = `process.stdout.write('\\n${B}\\n' + JSON.stringify({ mac: '${'0'.repeat(64)}', json: ${JSON.stringify(correctPayload)} }) + '\\n${E}\\n');\n`
      + 'process.exit(0);\nexport function isEven(){ return false; }\n';
    expect(run(content).summary.score).toBe(0);
  });

  it('偷 __bench_token 文件再算 mac -> token 已在 import 前 unlink，偷不到，score0', () => {
    const content = "import { readFileSync } from 'node:fs';\nimport { createHash } from 'node:crypto';\n"
      + "let tok=''; try { tok = readFileSync(new URL('./__bench_token', import.meta.url),'utf8'); } catch {}\n"
      + `const payload = ${JSON.stringify(correctPayload)};\n`
      + "const mac = createHash('sha256').update(tok+payload).digest('hex');\n"
      + `process.stdout.write('\\n${B}\\n' + JSON.stringify({ mac, json: payload }) + '\\n${E}\\n');\n`
      + 'process.exit(0);\nexport function isEven(){ return false; }\n';
    expect(run(content).summary.score).toBe(0);
  });

  it('污染 JSON.stringify 让采样壳输出垃圾 -> 父进程读不到合法块，score0', () => {
    const content = "JSON.stringify = () => 'garbage';\nexport function isEven(){ return false; }\n";
    expect(run(content).summary.score).toBe(0);
  });

  it('真实现 isEven -> 转绿（确认加固未误伤真修复）', () => {
    const r = runNoeSelfImproveBench({ tasks: [task], getCandidate: () => ({ content: task.fixedContent }), k: 3 });
    expect(r.summary.score).toBe(1);
  });
});
