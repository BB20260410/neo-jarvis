// @ts-check
// P0.4 反向 probe：验证「oracle 独立」——自验 ≠ 外部验。
//
// 两道被测机制（皆为真实模块、非 mock 被测逻辑本身）：
//   A. runtimeVerify 是注入式外部 oracle：fail-closed。进程退出码（implementer 易伪造的弱信号）
//      说成功不够，必须交叉校验 vitest JSON 报告。exitCode=0 但报告有失败/0 测试/success=false
//      → 必须 ok=false。若退回「只信 exitCode」(机制被改坏)，本测试变红。
//   B. post_review 的 required reviewer 集排除 active executor(implementer=codex)：codex 自投 approve
//      不算进 quorum，外部 reviewer 不够时 validateNoePostReview 必须报错。若排除逻辑被改坏
//      (codex 自盖章可放行)，本测试变红。
//
// 反向精髓：全部喂「危险/造假输入」，断言系统正确拦截，而非 happy path。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeNoeSelfEvolutionRuntimeVerify } from '../../src/loop/NoeSelfEvolutionExecutors.js';
import {
  requiredReviewerModels,
  collectPostReviews,
  validateNoePostReview,
  nonImplementerApprovals,
} from '../../src/room/NoePostReviewGate.js';

const FIXED_NOW = () => new Date('2026-06-22T00:00:00.000Z');
const tmpRoots = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'noe-p04-oracle-'));
  tmpRoots.push(root);
  return root;
}
afterEach(() => {
  while (tmpRoots.length) {
    try { rmSync(tmpRoots.pop(), { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// 注入式 spawnFn：永远报告子进程「成功退出」（exitCode 0）——模拟 implementer 制造的弱信号。
const spawnExit0 = async () => ({ exitCode: 0, stdout: '', stderr: '' });

describe('P0.4 oracle 独立 A — runtimeVerify fail-closed（exitCode 不能哄骗外部 oracle）', () => {
  it('反向①：exitCode=0 但 JSON 报告 numFailedTests>0 → 必须 ok=false（不信弱退出码）', async () => {
    const verify = makeNoeSelfEvolutionRuntimeVerify({
      cwd: makeRoot(),
      spawnFn: spawnExit0,
      // 注入式报告读取（模块设计的注入点）：喂一份「退出码绿但真有失败」的造假报告。
      readJsonReport: () => ({ numTotalTests: 12, numPassedTests: 11, numFailedTests: 1, success: true }),
      now: FIXED_NOW,
    });
    const out = await verify({});
    // 反向断言（机制失效会红）：若 reportTrusted 被改成「只信 exitCode」，下面会变 true 而失败。
    expect(out.ok).toBe(false);
    expect(out.reportTrusted).toBe(false);
    expect(out.numFailedTests).toBe(1);
  });

  it('反向②：exitCode=0 但报告 0 测试（删光测试假绿）→ ok=false', async () => {
    const verify = makeNoeSelfEvolutionRuntimeVerify({
      cwd: makeRoot(),
      spawnFn: spawnExit0,
      readJsonReport: () => ({ numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, success: true }),
      now: FIXED_NOW,
    });
    const out = await verify({});
    expect(out.ok).toBe(false); // numTotalTests>0 是可信前提，0 测试不可信
    expect(out.reportTrusted).toBe(false);
  });

  it('反向③：exitCode=0、计数全绿、但 vitest 自报 success:false → ok=false（不只赖计数）', async () => {
    const verify = makeNoeSelfEvolutionRuntimeVerify({
      cwd: makeRoot(),
      spawnFn: spawnExit0,
      readJsonReport: () => ({ numTotalTests: 50, numPassedTests: 50, numFailedTests: 0, success: false }),
      now: FIXED_NOW,
    });
    const out = await verify({});
    expect(out.ok).toBe(false);
    expect(out.reportTrusted).toBe(false);
  });

  it('反向④：报告读不到/解析失败 → fail-closed ok=false（坏 patch 删报告不能假绿）', async () => {
    const verify = makeNoeSelfEvolutionRuntimeVerify({
      cwd: makeRoot(),
      spawnFn: spawnExit0,
      readJsonReport: () => { throw new Error('ENOENT report missing'); },
      now: FIXED_NOW,
    });
    const out = await verify({});
    expect(out.ok).toBe(false);
    expect(out.reportTrusted).toBe(false);
    expect(out.reportError).toBeTruthy(); // 留痕：报告不可信的原因可见
  });

  it('正向对照：exitCode=0 且报告真绿（≥1 测试、0 失败、success!==false）→ ok=true（避免 fail-closed 误伤一切）', async () => {
    const verify = makeNoeSelfEvolutionRuntimeVerify({
      cwd: makeRoot(),
      spawnFn: spawnExit0,
      readJsonReport: () => ({ numTotalTests: 100, numPassedTests: 100, numFailedTests: 0, success: true }),
      now: FIXED_NOW,
    });
    const out = await verify({});
    // 对照锚点：证明上面的红不是「永远 false」，而是机制在真区分真假绿。
    expect(out.ok).toBe(true);
    expect(out.reportTrusted).toBe(true);
  });
});

describe('P0.4 oracle 独立 B — post_review required reviewer 集排除 implementer(codex)', () => {
  it('反向⑤：required reviewer 集绝不含 active executor(codex 自己)——implementer 不能盖自己的章', () => {
    const required = requiredReviewerModels('codex');
    // 反向断言（机制失效会红）：若排除逻辑被移除，codex 会重新出现在必需 reviewer 里。
    expect(required).not.toContain('codex');
    // 外部 reviewer 仍在（claude/m3）——排除的是实施者，不是把人删空。
    expect(required).toContain('claude');
    expect(required).toContain('m3');
  });

  it('反向⑥：codex 自投 approve 被丢弃，不计入非实施者 approvals', () => {
    const postReview = {
      ok: true,
      reviews: [
        { model: 'codex', decision: 'approve', canWrite: true, rawOutputRef: 'output/r/codex.txt' },
        { model: 'claude', decision: 'approve', canWrite: false, rawOutputRef: 'output/r/claude.txt' },
      ],
    };
    const { byModel } = collectPostReviews(postReview, 'codex');
    // codex 自己的复核被归集逻辑直接丢弃（既实施又背书 = 不允许）。
    expect(byModel.has('codex')).toBe(false);
    expect(byModel.has('claude')).toBe(true);
    // 非实施者 approvals 里没有 codex 自盖章。
    const approvals = nonImplementerApprovals(postReview, 'codex');
    expect(approvals.map((r) => r.model)).not.toContain('codex');
  });

  it('反向⑦：仅 implementer(codex) 自投 approve、外部 reviewer 不够 → validateNoePostReview 必须报错（自验不能放行）', () => {
    const errors = [];
    const summary = validateNoePostReview(errors, {
      // 危险输入：codex 给自己一堆 approve，企图凑够 quorum 放行 complete。
      postReview: {
        ok: true,
        reviews: [
          { model: 'codex', decision: 'approve', canWrite: true, rawOutputRef: 'output/r/codex1.txt' },
          { model: 'codex', decision: 'approve', canWrite: true, rawOutputRef: 'output/r/codex2.txt' },
        ],
      },
      activeExecutor: 'codex',
      requireFile: false,
    });
    // 反向断言（机制失效会红）：若 codex 自投被算进 quorum，summary.ok 会变 true、approvalCount≥2，本断言失败。
    expect(summary.ok).toBe(false);
    expect(summary.approvalCount).toBe(0); // codex 自投全被排除 → 外部批准数为 0
    // 必须明确报「缺必需的外部 reviewer」+「可用模型不足」——可见地拦下，而非静默放行。
    expect(errors.some((e) => e.startsWith('post_review_missing_required_reviewer:'))).toBe(true);
    expect(errors.some((e) => e.includes('insufficient_available_models'))).toBe(true);
  });

  it('正向对照：两个真正的外部 reviewer(claude/m3) approve → validateNoePostReview 通过', () => {
    const errors = [];
    const summary = validateNoePostReview(errors, {
      postReview: {
        ok: true,
        reviews: [
          { model: 'claude', decision: 'approve', canWrite: false, rawOutputRef: 'output/r/claude.txt' },
          { model: 'm3', decision: 'approve', canWrite: false, rawOutputRef: 'output/r/m3.txt' },
        ],
      },
      activeExecutor: 'codex',
      requireFile: false,
    });
    // 对照锚点：证明上面的红是「自验被拦」，不是 validateNoePostReview 永远 false。
    expect(summary.ok).toBe(true);
    expect(errors).toEqual([]);
    expect(summary.approvalCount).toBe(2);
  });
});
