// @ts-check
//
// NoeSelfEvolutionSlo 单测：纯聚合 + 落盘 + fail-open。
// 全程 mkdtempSync 造临时目录，DI 指向临时路径/注入时钟，绝不碰真实产物或 secret。

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  aggregateSelfEvolutionSlo,
  collectSelfEvolutionArtifacts,
  buildSelfEvolutionSlo,
  writeSelfEvolutionSlo,
  classifyImplementerError,
  classifyRuntimeFailure,
  percentileNearestRank,
} from '../../src/loop/NoeSelfEvolutionSlo.js';

const FIXED_NOW = () => new Date('2026-06-21T12:00:00.000Z');

/** 造一组三类产物子目录并写入样本，返回三目录路径。 */
function seedArtifacts() {
  const root = mkdtempSync(join(tmpdir(), 'noe-slo-'));
  const applyDir = join(root, 'apply');
  const runtimeDir = join(root, 'runtime');
  const implDir = join(root, 'impl');
  for (const d of [applyDir, runtimeDir, implDir]) mkdirSync(d, { recursive: true });

  // apply：1 applied(成功) + 1 rolled_back + 1 blocked + 1 dry_run_ready
  writeFileSync(join(applyDir, 'a1.json'), JSON.stringify({
    status: 'applied', ok: true, dryRun: false, generatedAt: '2026-06-21T01:00:00.000Z',
    counts: { operations: 3, changedFiles: 2, blocked: 0, errors: 0 }, applyId: 'apply-1',
  }));
  writeFileSync(join(applyDir, 'a2.json'), JSON.stringify({
    status: 'rolled_back', ok: false, generatedAt: '2026-06-21T01:01:00.000Z', applyId: 'apply-2',
  }));
  writeFileSync(join(applyDir, 'a3.json'), JSON.stringify({
    status: 'blocked', ok: false, generatedAt: '2026-06-21T01:02:00.000Z', applyId: 'apply-3',
  }));
  writeFileSync(join(applyDir, 'a4.json'), JSON.stringify({
    status: 'dry_run_ready', ok: true, dryRun: true, generatedAt: '2026-06-21T01:03:00.000Z', applyId: 'apply-4',
  }));

  // runtime：1 ok(成功) + 1 numFailedTests>0 + 1 reportTrusted=false + 1 旧 shape exitCode!=0
  writeFileSync(join(runtimeDir, 'r1.json'), JSON.stringify({
    ok: true, exitCode: 0, numTotalTests: 10, numPassedTests: 10, numFailedTests: 0,
    reportTrusted: true, generatedAt: '2026-06-21T02:00:00.000Z',
  }));
  writeFileSync(join(runtimeDir, 'r2.json'), JSON.stringify({
    ok: false, exitCode: 1, numTotalTests: 10, numPassedTests: 8, numFailedTests: 2,
    reportTrusted: true, generatedAt: '2026-06-21T02:01:00.000Z',
  }));
  writeFileSync(join(runtimeDir, 'r3.json'), JSON.stringify({
    ok: false, exitCode: 0, reportTrusted: false, generatedAt: '2026-06-21T02:02:00.000Z',
  }));
  writeFileSync(join(runtimeDir, 'r4.json'), JSON.stringify({
    ok: false, exitCode: 137, generatedAt: '2026-06-21T02:03:00.000Z', // 旧 shape：只有 ok/exitCode
  }));

  // implementer-fail：新 shape(含 attemptedCandidates) + 旧 shape(仅 error) + 旧 shape(用 reason)
  writeFileSync(join(implDir, 'i1.json'), JSON.stringify({
    kind: 'noe_self_evolution_implementer_fail', generatedAt: '2026-06-21T03:00:00.000Z',
    routedAdapterId: 'codex',
    attemptedCandidates: [
      { id: 'c1', error: 'failed to connect: Connection refused (os error 61)', operationsLen: 0, ok: false },
      { id: 'c2', error: 'no_patch_plan: implementer returned empty', operationsLen: 0, ok: false },
    ],
  }));
  writeFileSync(join(implDir, 'i2.json'), JSON.stringify({
    kind: 'noe_self_evolution_implementer_fail', at: '2026-06-21T03:01:00.000Z',
    adapterId: 'codex', resultOk: false, attempts: 3,
    error: 'adapter_error:Codex exit code=1 wss://chatgpt.com/backend-api/codex ECONNREFUSED',
  }));
  writeFileSync(join(implDir, 'i3.json'), JSON.stringify({
    kind: 'noe_self_evolution_implementer_fail', generatedAt: '2026-06-21T03:02:00.000Z',
    reason: 'non_usable_patch_plan',
  }));
  writeFileSync(join(implDir, 'i4.json'), JSON.stringify({
    kind: 'noe_self_evolution_implementer_fail', generatedAt: '2026-06-21T03:03:00.000Z',
    error: 'some weird unparseable thing happened',
  }));

  return { root, applyDir, runtimeDir, implDir };
}

describe('NoeSelfEvolutionSlo — 纯聚合 aggregateSelfEvolutionSlo（不做 IO）', () => {
  it('apply 阶段：total/success/fail/successRate 与 status 分布正确', () => {
    const slo = aggregateSelfEvolutionSlo({
      applyReports: [
        { status: 'applied', ok: true },
        { status: 'applied', ok: true },
        { status: 'blocked', ok: false },
        { status: 'rolled_back', ok: false },
      ],
      now: FIXED_NOW,
    });
    const s = slo.stages.apply;
    expect(s.total).toBe(4);
    expect(s.success).toBe(2);
    expect(s.fail).toBe(2);
    expect(s.successRate).toBe(0.5);
    expect(s.statusDistribution).toEqual({ applied: 2, blocked: 1, rolled_back: 1 });
    // 失败归因 = 非 applied 的 status
    const reasons = Object.fromEntries(s.failureReasonsTopN.map((r) => [r.reason, r.count]));
    expect(reasons).toEqual({ blocked: 1, rolled_back: 1 });
  });

  it('runtime_verify 阶段：成功率 + 三类失败归因（tests_failed/report_untrusted/nonzero_exit）', () => {
    // 全部带齐 reportTrusted+numTotalTests（非 legacy），才进 success/fail 判定。
    const slo = aggregateSelfEvolutionSlo({
      runtimeVerify: [
        { ok: true, exitCode: 0, reportTrusted: true, numTotalTests: 10, numFailedTests: 0 },
        { ok: false, exitCode: 1, reportTrusted: true, numTotalTests: 10, numFailedTests: 2 },
        { ok: false, exitCode: 0, reportTrusted: false, numTotalTests: 10, numFailedTests: 0 },
        { ok: false, exitCode: 137, reportTrusted: true, numTotalTests: 0, numFailedTests: 0 },
      ],
      now: FIXED_NOW,
    });
    const s = slo.stages.runtime_verify;
    expect(s.total).toBe(4);
    expect(s.success).toBe(1);
    expect(s.fail).toBe(3);
    expect(s.legacyUnknown).toBe(0);
    expect(s.successRate).toBe(0.25);
    const reasons = Object.fromEntries(s.failureReasonsTopN.map((r) => [r.reason, r.count]));
    expect(reasons).toEqual({ tests_failed: 1, report_untrusted: 1, nonzero_exit: 1 });
  });

  // P0.6 SLO v2：产物补 durationMs 后，duration P50/P95 自动从 null 变实数（P4.4 提速放行前提）。
  it('P0.6 SLO duration：产物带 durationMs → P50/P95 非 null；缺字段 → null + note(不编造)', () => {
    const withDur = aggregateSelfEvolutionSlo({
      runtimeVerify: [
        { ok: true, exitCode: 0, reportTrusted: true, numTotalTests: 10, numFailedTests: 0, durationMs: 1200 },
        { ok: true, exitCode: 0, reportTrusted: true, numTotalTests: 10, numFailedTests: 0, durationMs: 3400 },
      ],
      now: FIXED_NOW,
    });
    const d = withDur.stages.runtime_verify.duration;
    expect(d.sampleCount).toBe(2);
    expect(d.p50Ms).not.toBeNull();
    expect(d.p95Ms).not.toBeNull();
    // 反向对照：无 durationMs → 不编造，给 null + note。
    const noDur = aggregateSelfEvolutionSlo({
      runtimeVerify: [{ ok: true, exitCode: 0, reportTrusted: true, numTotalTests: 10, numFailedTests: 0 }],
      now: FIXED_NOW,
    });
    expect(noDur.stages.runtime_verify.duration.p50Ms).toBeNull();
    expect(noDur.stages.runtime_verify.duration.note).toBeTruthy();
  });

  it('P9-fix(Codex)：reportTrusted:false 即使 numTotalTests 缺失也判 fail(不漏成 legacy_unknown)', () => {
    const slo = aggregateSelfEvolutionSlo({
      runtimeVerify: [
        { ok: true, reportTrusted: true, numTotalTests: 5, numFailedTests: 0 }, // success
        { ok: false, reportTrusted: false }, // reportTrusted 明确 false + 无 numTotalTests → fail(收紧前是 legacy)
      ],
      now: FIXED_NOW,
    });
    const s = slo.stages.runtime_verify;
    expect(s.success).toBe(1);
    expect(s.fail).toBe(1); // reportTrusted:false 不再漏成 legacy
    expect(s.legacyUnknown).toBe(0);
    expect(Object.fromEntries(s.failureReasonsTopN.map((r) => [r.reason, r.count]))).toEqual({ report_untrusted: 1 });
  });

  it('major-B 防假绿：{ok:true, reportTrusted:false} 不算 success（对齐 P0 fail-closed）', () => {
    const slo = aggregateSelfEvolutionSlo({
      runtimeVerify: [
        // ok 为真但 reportTrusted 假 + 有失败测试 → 必须 fail，绝不算成功
        { ok: true, reportTrusted: false, numTotalTests: 10, numFailedTests: 5 },
        // ok 为真、reportTrusted 真，但有失败测试 → fail
        { ok: true, reportTrusted: true, numTotalTests: 10, numFailedTests: 1 },
        // ok 为真、reportTrusted 真，但 numTotalTests=0（没真正跑测试）→ fail
        { ok: true, reportTrusted: true, numTotalTests: 0, numFailedTests: 0 },
        // 唯一真成功
        { ok: true, reportTrusted: true, numTotalTests: 8, numFailedTests: 0 },
      ],
      now: FIXED_NOW,
    });
    const s = slo.stages.runtime_verify;
    expect(s.success).toBe(1);
    expect(s.fail).toBe(3);
    expect(s.legacyUnknown).toBe(0);
    expect(s.successRate).toBe(0.25);
    const reasons = Object.fromEntries(s.failureReasonsTopN.map((r) => [r.reason, r.count]));
    // 第1条 numFailedTests>0 → tests_failed（注意：numFailed>0 优先于 reportTrusted=false）
    // 第2条 tests_failed；第3条 numTotal=0 且 reportTrusted=true 且无失败 → unknown
    expect(reasons.tests_failed).toBe(2);
    expect(reasons.unknown).toBe(1);
  });

  it('major-B legacy_unknown：旧产物缺 reportTrusted/numTotalTests 单独计数，不进 successRate 分母也不进失败归因', () => {
    const slo = aggregateSelfEvolutionSlo({
      runtimeVerify: [
        { ok: true, reportTrusted: true, numTotalTests: 5, numFailedTests: 0 }, // success
        { ok: false, reportTrusted: true, numTotalTests: 5, numFailedTests: 3 }, // fail
        { ok: false, exitCode: 137 }, // 旧 shape：缺新字段 → legacy_unknown
        { ok: true, exitCode: 0 }, // 旧 shape ok 为真但缺字段 → legacy_unknown（不能算成功）
        { ok: false, exitCode: 0 }, // 旧 shape 缺 reportTrusted/numTotalTests → legacy_unknown(P9-fix:reportTrusted:false 已另测为 fail)
      ],
      now: FIXED_NOW,
    });
    const s = slo.stages.runtime_verify;
    expect(s.total).toBe(5);
    expect(s.success).toBe(1);
    expect(s.fail).toBe(1);
    expect(s.legacyUnknown).toBe(3);
    // 分母 = success + fail = 2（不含 legacy_unknown）→ 1/2 = 0.5
    expect(s.successRate).toBe(0.5);
    // legacy_unknown 不进失败归因，只 fail 的 tests_failed=1
    const reasons = Object.fromEntries(s.failureReasonsTopN.map((r) => [r.reason, r.count]));
    expect(reasons).toEqual({ tests_failed: 1 });
  });

  it('major-B 全 legacy_unknown → successRate 为 null（分母为 0 不编造）', () => {
    const slo = aggregateSelfEvolutionSlo({
      runtimeVerify: [
        { ok: true, exitCode: 0 },
        { ok: false, exitCode: 1 },
      ],
      now: FIXED_NOW,
    });
    const s = slo.stages.runtime_verify;
    expect(s.success).toBe(0);
    expect(s.fail).toBe(0);
    expect(s.legacyUnknown).toBe(2);
    expect(s.successRate).toBeNull();
  });

  it('implementer 阶段：兼容含/不含 attemptedCandidates，归因 network/empty_plan/other 正确', () => {
    const slo = aggregateSelfEvolutionSlo({
      implementerFail: [
        // 含 attemptedCandidates：2 条 → network + empty_plan
        { attemptedCandidates: [
          { error: 'Connection refused (os error 61)' },
          { error: 'no_patch_plan' },
        ] },
        // 旧 shape error → network
        { error: 'ECONNREFUSED wss://x' },
        // 旧 shape reason → empty_plan
        { reason: 'non_usable_patch_plan' },
        // 旧 shape error → other
        { error: 'totally unknown failure' },
      ],
      now: FIXED_NOW,
    });
    const s = slo.stages.implementer;
    expect(s.total).toBe(4);
    expect(s.success).toBe(0);
    expect(s.fail).toBe(4);
    expect(s.successRate).toBeNull(); // 仅失败样本，分母不可知 → 不编造
    const reasons = Object.fromEntries(s.failureReasonsTopN.map((r) => [r.reason, r.count]));
    // 事件计数：network=2(候选1 + i2), empty_plan=2(候选2 + reason), other=1
    expect(reasons).toEqual({ network: 2, empty_plan: 2, other: 1 });
  });

  it('耗时：无 durationMs 时 P50/P95 为 null 且带说明；有 durationMs 时按 nearest-rank 计算', () => {
    const noDuration = aggregateSelfEvolutionSlo({
      applyReports: [{ status: 'applied', ok: true }],
      now: FIXED_NOW,
    });
    expect(noDuration.stages.apply.duration.p50Ms).toBeNull();
    expect(noDuration.stages.apply.duration.p95Ms).toBeNull();
    expect(noDuration.stages.apply.duration.sampleCount).toBe(0);
    expect(noDuration.stages.apply.duration.note).toMatch(/不编造|durationMs/);

    const withDuration = aggregateSelfEvolutionSlo({
      applyReports: [10, 20, 30, 40, 100].map((d) => ({ status: 'applied', ok: true, durationMs: d })),
      now: FIXED_NOW,
    });
    expect(withDuration.stages.apply.duration.sampleCount).toBe(5);
    // nearest-rank P50: ceil(0.5*5)=3 → sorted[2]=30
    expect(withDuration.stages.apply.duration.p50Ms).toBe(30);
    // nearest-rank P95: ceil(0.95*5)=5 → sorted[4]=100
    expect(withDuration.stages.apply.duration.p95Ms).toBe(100);
  });

  it('major-A 防假数据：durationMs:null/空串/false 不被当成真实 0ms 样本（p50/sampleCount）', () => {
    // 全部 durationMs 都是"假 0"诱饵（Number() 会把它们变 0），严格版必须拒绝 → 0 样本
    const allFake = aggregateSelfEvolutionSlo({
      runtimeVerify: [
        { ok: true, reportTrusted: true, numTotalTests: 3, numFailedTests: 0, durationMs: null },
        { ok: true, reportTrusted: true, numTotalTests: 3, numFailedTests: 0, durationMs: '' },
        { ok: true, reportTrusted: true, numTotalTests: 3, numFailedTests: 0, durationMs: false },
      ],
      now: FIXED_NOW,
    });
    const d = allFake.stages.runtime_verify.duration;
    expect(d.sampleCount).toBe(0); // 不是 3
    expect(d.p50Ms).toBeNull(); // 不是 0
    expect(d.p95Ms).toBeNull();
    expect(d.note).toMatch(/不编造|durationMs/);

    // 混合：只有 1 个真 number 应被计入，2 个假 0 被拒
    const mixed = aggregateSelfEvolutionSlo({
      applyReports: [
        { status: 'applied', ok: true, durationMs: 50 },
        { status: 'applied', ok: true, durationMs: null },
        { status: 'applied', ok: true, durationMs: undefined },
      ],
      now: FIXED_NOW,
    });
    const md = mixed.stages.apply.duration;
    expect(md.sampleCount).toBe(1);
    expect(md.p50Ms).toBe(50);

    // 纯数字字符串应被接受（前向兼容生产者可能写字符串）
    const strNum = aggregateSelfEvolutionSlo({
      applyReports: [{ status: 'applied', ok: true, durationMs: '120' }],
      now: FIXED_NOW,
    });
    expect(strNum.stages.apply.duration.sampleCount).toBe(1);
    expect(strNum.stages.apply.duration.p50Ms).toBe(120);
  });

  it('major-A 防假数据：缺失 numFailedTests 不被当 0（不会误判为无测试失败）', () => {
    // numFailedTests 缺失 + reportTrusted false → 应归 report_untrusted，不是因 numFailed=0 落到别处
    expect(classifyRuntimeFailure({ reportTrusted: false, numTotalTests: 5 })).toBe('report_untrusted');
    // numFailedTests 为 null（假 0 诱饵）不该被当 tests_failed，也不该被当 0 → 落 exitCode/unknown
    expect(classifyRuntimeFailure({ numFailedTests: null, exitCode: 2 })).toBe('nonzero_exit');
    expect(classifyRuntimeFailure({ numFailedTests: '', exitCode: 0 })).toBe('unknown');
  });

  it('major-C 防假退化：dry_run_ready/skipped/dryRun 不进 apply successRate 分母，statusDistribution 仍全量', () => {
    const slo = aggregateSelfEvolutionSlo({
      applyReports: [
        { status: 'applied', ok: true }, // 真成功（计入分母）
        { status: 'rolled_back', ok: false }, // 真失败（计入分母）
        { status: 'dry_run_ready', ok: true, dryRun: true }, // 排除
        { status: 'dry_run_ready', ok: true, dryRun: true }, // 排除
        { status: 'skipped', ok: true }, // P3 幂等跳过，排除
        { status: 'applied', ok: true, dryRun: true }, // dryRun=true 即使 status applied 也排除
      ],
      now: FIXED_NOW,
    });
    const s = slo.stages.apply;
    expect(s.total).toBe(6); // total 仍是全部报告数
    expect(s.ratedTotal).toBe(2); // 真实终态 attempts 只有 applied + rolled_back
    expect(s.success).toBe(1);
    expect(s.fail).toBe(1);
    expect(s.successRate).toBe(0.5); // 1/2，不是 1/6 也不是被 dry_run 压低
    // statusDistribution 必须保留全量（含 dry_run_ready/skipped）
    expect(s.statusDistribution).toEqual({
      applied: 2, rolled_back: 1, dry_run_ready: 2, skipped: 1,
    });
    // 失败归因只含真实终态里非 applied 的（不含 dry_run_ready/skipped）
    const reasons = Object.fromEntries(s.failureReasonsTopN.map((r) => [r.reason, r.count]));
    expect(reasons).toEqual({ rolled_back: 1 });
  });

  it('major-C：apply 全是 dry_run_ready/skipped → successRate 为 null（分母为 0 不编造）', () => {
    const slo = aggregateSelfEvolutionSlo({
      applyReports: [
        { status: 'dry_run_ready', ok: true, dryRun: true },
        { status: 'skipped', ok: true },
      ],
      now: FIXED_NOW,
    });
    const s = slo.stages.apply;
    expect(s.total).toBe(2);
    expect(s.ratedTotal).toBe(0);
    expect(s.successRate).toBeNull();
    expect(s.statusDistribution).toEqual({ dry_run_ready: 1, skipped: 1 });
  });

  it('顶层元数据：schemaVersion/kind/generatedAt/percentileMethod 就位', () => {
    const slo = aggregateSelfEvolutionSlo({ now: FIXED_NOW });
    expect(slo.kind).toBe('noe_self_evolution_slo');
    expect(slo.schemaVersion).toBe(1);
    expect(slo.generatedAt).toBe('2026-06-21T12:00:00.000Z');
    expect(slo.percentileMethod).toBe('nearest-rank');
    // 三阶段零值不崩
    expect(slo.stages.apply.total).toBe(0);
    expect(slo.stages.runtime_verify.total).toBe(0);
    expect(slo.stages.implementer.total).toBe(0);
    expect(slo.stages.apply.successRate).toBeNull();
  });
});

describe('NoeSelfEvolutionSlo — percentileNearestRank 单元', () => {
  it('空数组 → null', () => {
    expect(percentileNearestRank([], 50)).toBeNull();
    expect(percentileNearestRank(null, 95)).toBeNull();
  });
  it('p<=0 取最小，p=100 取最大', () => {
    expect(percentileNearestRank([5, 1, 3], 0)).toBe(1);
    expect(percentileNearestRank([5, 1, 3], 100)).toBe(5);
  });
  it('过滤非有限数', () => {
    expect(percentileNearestRank([1, 'x', 2, NaN, 3], 50)).toBe(2);
  });
});

describe('NoeSelfEvolutionSlo — 分类纯函数', () => {
  it('classifyImplementerError', () => {
    expect(classifyImplementerError('os error 61')).toBe('network');
    expect(classifyImplementerError('ECONNREFUSED')).toBe('network');
    expect(classifyImplementerError('ENOTFOUND host')).toBe('network');
    expect(classifyImplementerError('wss://chatgpt.com/...')).toBe('network');
    expect(classifyImplementerError('no_patch_plan')).toBe('empty_plan');
    expect(classifyImplementerError('non_usable_patch_plan')).toBe('empty_plan');
    expect(classifyImplementerError('random failure')).toBe('other');
    expect(classifyImplementerError('')).toBe('other');
  });
  it('classifyRuntimeFailure 兼容旧 shape', () => {
    expect(classifyRuntimeFailure({ numFailedTests: 3 })).toBe('tests_failed');
    expect(classifyRuntimeFailure({ reportTrusted: false })).toBe('report_untrusted');
    expect(classifyRuntimeFailure({ exitCode: 1 })).toBe('nonzero_exit');
    expect(classifyRuntimeFailure({ exitCode: 0 })).toBe('unknown'); // 旧 shape 无新字段且 exit 0
  });
});

describe('NoeSelfEvolutionSlo — collectSelfEvolutionArtifacts（IO + fail-open）', () => {
  it('从临时目录读全三类产物并交给纯聚合，断言计数与归因', () => {
    const { root, applyDir, runtimeDir, implDir } = seedArtifacts();
    try {
      const collected = collectSelfEvolutionArtifacts({ applyDir, runtimeDir, implementerDir: implDir });
      expect(collected.applyReports).toHaveLength(4);
      expect(collected.runtimeVerify).toHaveLength(4);
      expect(collected.implementerFail).toHaveLength(4);

      const slo = aggregateSelfEvolutionSlo({
        applyReports: collected.applyReports,
        runtimeVerify: collected.runtimeVerify,
        implementerFail: collected.implementerFail,
        fileCounts: collected.fileCounts,
        now: FIXED_NOW,
      });
      // apply：a1 applied+ok=success；a2 rolled_back/a3 blocked=fail；a4 dry_run_ready 排除出分母
      expect(slo.stages.apply.success).toBe(1);
      expect(slo.stages.apply.ratedTotal).toBe(3); // 4 份报告排除 1 份 dry_run_ready
      expect(slo.stages.apply.successRate).toBe(0.3333); // 1/3，不被 dry_run 压成 1/4
      expect(slo.stages.apply.statusDistribution).toEqual({
        applied: 1, rolled_back: 1, blocked: 1, dry_run_ready: 1, // 分布仍全量
      });
      // runtime：r1=success；r2(numFailedTests:2)=fail；P9-fix(Codex):r3(reportTrusted:false,缺 numTotalTests)从
      //   legacy_unknown 收紧为 fail(reportTrusted 明确 false=报告不可信=fail,防假绿);r4(旧shape缺reportTrusted)=legacy。
      expect(slo.stages.runtime_verify.success).toBe(1);
      expect(slo.stages.runtime_verify.fail).toBe(2); // r2(numFailedTests>0) + r3(reportTrusted:false)
      expect(slo.stages.runtime_verify.legacyUnknown).toBe(1); // 仅 r4 旧 shape(缺 reportTrusted/numTotalTests)
      expect(slo.stages.runtime_verify.successRate).toBe(0.3333); // 1/(1+2)，聚合器 round 4 位，legacy 不进分母
      expect(slo.stages.implementer.fail).toBe(4);
      // implementer 事件：i1(network+empty_plan) + i2(network) + i3(empty_plan) + i4(other)
      const r = Object.fromEntries(slo.stages.implementer.failureReasonsTopN.map((x) => [x.reason, x.count]));
      expect(r).toEqual({ network: 2, empty_plan: 2, other: 1 });
      // 源文件计数透传
      expect(slo.sources.applyReports.parsed).toBe(4);
      expect(slo.sources.applyReports.skipped).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('空目录 → 零值结构不崩', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-slo-empty-'));
    const applyDir = join(root, 'apply');
    const runtimeDir = join(root, 'runtime');
    const implDir = join(root, 'impl');
    for (const d of [applyDir, runtimeDir, implDir]) mkdirSync(d, { recursive: true });
    try {
      const collected = collectSelfEvolutionArtifacts({ applyDir, runtimeDir, implementerDir: implDir });
      expect(collected.applyReports).toEqual([]);
      const slo = aggregateSelfEvolutionSlo({ ...collected, now: FIXED_NOW });
      expect(slo.stages.apply.total).toBe(0);
      expect(slo.stages.runtime_verify.total).toBe(0);
      expect(slo.stages.implementer.total).toBe(0);
      expect(slo.stages.apply.failureReasonsTopN).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('目录完全不存在 → 不抛，返回零值', () => {
    const collected = collectSelfEvolutionArtifacts({
      applyDir: '/nonexistent/path/apply/__none__',
      runtimeDir: '/nonexistent/path/runtime/__none__',
      implementerDir: '/nonexistent/path/impl/__none__',
    });
    expect(collected.applyReports).toEqual([]);
    expect(collected.fileCounts.apply.files).toBe(0);
    const slo = aggregateSelfEvolutionSlo({ ...collected, now: FIXED_NOW });
    expect(slo.stages.apply.total).toBe(0);
  });

  it('畸形 JSON 文件被跳过，其余正常聚合 + skipped 计数', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-slo-bad-'));
    const applyDir = join(root, 'apply');
    mkdirSync(applyDir, { recursive: true });
    writeFileSync(join(applyDir, 'good.json'), JSON.stringify({ status: 'applied', ok: true }));
    writeFileSync(join(applyDir, 'bad.json'), '{ this is not valid json ,, }');
    writeFileSync(join(applyDir, 'array.json'), JSON.stringify([1, 2, 3])); // 顶层非对象也算畸形
    try {
      const collected = collectSelfEvolutionArtifacts({
        applyDir,
        runtimeDir: join(root, 'no-runtime'),
        implementerDir: join(root, 'no-impl'),
      });
      expect(collected.applyReports).toHaveLength(1); // 只剩 good
      expect(collected.fileCounts.apply.skipped).toBe(2); // bad + array
      expect(collected.fileCounts.apply.files).toBe(3);
      const slo = aggregateSelfEvolutionSlo({ ...collected, now: FIXED_NOW });
      expect(slo.stages.apply.total).toBe(1);
      expect(slo.stages.apply.success).toBe(1);
      expect(slo.sources.applyReports.skipped).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('NoeSelfEvolutionSlo — buildSelfEvolutionSlo + writeSelfEvolutionSlo（落盘可注入）', () => {
  it('buildSelfEvolutionSlo 读 + 聚合一步到位', () => {
    const { root, applyDir, runtimeDir, implDir } = seedArtifacts();
    try {
      const slo = buildSelfEvolutionSlo({
        applyDir, runtimeDir, implementerDir: implDir, now: FIXED_NOW,
      });
      expect(slo.stages.apply.total).toBe(4);
      expect(slo.stages.implementer.fail).toBe(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writeSelfEvolutionSlo 写到注入的 outputDir，文件名为安全时间戳，内容可回读', () => {
    const { root, applyDir, runtimeDir, implDir } = seedArtifacts();
    const outputDir = join(root, 'slo-out');
    try {
      const { filePath, slo } = writeSelfEvolutionSlo({
        applyDir, runtimeDir, implementerDir: implDir, outputDir, now: FIXED_NOW,
      });
      // 时间戳文件名：冒号/点已替成连字符
      expect(filePath).toBe(join(outputDir, '2026-06-21T12-00-00-000Z.json'));
      const files = readdirSync(outputDir);
      expect(files).toContain('2026-06-21T12-00-00-000Z.json');
      const onDisk = JSON.parse(readFileSync(filePath, 'utf8'));
      expect(onDisk.kind).toBe('noe_self_evolution_slo');
      expect(onDisk.stages.apply.total).toBe(4);
      expect(onDisk).toEqual(slo);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writeSelfEvolutionSlo 接受预聚合的 slo（不重新读盘）', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-slo-pre-'));
    const outputDir = join(root, 'out');
    try {
      const pre = aggregateSelfEvolutionSlo({
        applyReports: [{ status: 'applied', ok: true }], now: FIXED_NOW,
      });
      const { filePath } = writeSelfEvolutionSlo({ slo: pre, outputDir, now: FIXED_NOW });
      const onDisk = JSON.parse(readFileSync(filePath, 'utf8'));
      expect(onDisk.stages.apply.total).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
