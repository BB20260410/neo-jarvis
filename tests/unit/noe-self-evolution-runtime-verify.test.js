import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeNoeSelfEvolutionRuntimeVerify } from '../../src/loop/NoeSelfEvolutionExecutors.js';

// P0：runtimeVerify 不再只信 exitCode，交叉校验 vitest JSON 报告 + fail-closed。
// readJsonReport 可注入 → 不必让 mock spawn 去真写文件，直接喂各种报告形态验判据。

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'noe-rv-')); });
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

function mk({ exitCode = 0, report = { numTotalTests: 100, numPassedTests: 100, numFailedTests: 0 }, reportThrows = false } = {}) {
  return makeNoeSelfEvolutionRuntimeVerify({
    cwd: root,
    now: () => new Date('2026-06-21T00:00:00Z'),
    spawnFn: vi.fn(async () => ({ exitCode, stdout: 'ran', stderr: '' })),
    readJsonReport: reportThrows ? () => { throw new Error('ENOENT: report missing'); } : () => report,
  });
}

describe('P0 runtimeVerify 堵假绿', () => {
  it('正常：exitCode0 + 报告 failed0/total>0 → ok=true（不误杀正常 patch）', async () => {
    const r = await mk()({ root });
    expect(r.ok).toBe(true);
    expect(r.numFailedTests).toBe(0);
    expect(r.reportTrusted).toBe(true);
  });

  it('假绿①：exitCode0 但报告 numFailedTests>0 → ok=false', async () => {
    const r = await mk({ exitCode: 0, report: { numTotalTests: 100, numFailedTests: 3 } })({ root });
    expect(r.ok).toBe(false);
    expect(r.numFailedTests).toBe(3);
  });

  it('假绿②：exitCode0 但 0 测试跑（numTotalTests=0）→ ok=false', async () => {
    const r = await mk({ exitCode: 0, report: { numTotalTests: 0, numFailedTests: 0 } })({ root });
    expect(r.ok).toBe(false);
    expect(r.reportTrusted).toBe(false);
  });

  it('fail-closed：报告缺失/解析失败 → ok=false（绝不回退到只信 exitCode）', async () => {
    const r = await mk({ exitCode: 0, reportThrows: true })({ root });
    expect(r.ok).toBe(false);
    expect(r.reportError).toMatch(/report|ENOENT|missing/i);
    expect(r.reportTrusted).toBe(false);
  });

  it('fail-closed：报告字段缺失（无 numFailedTests）→ ok=false', async () => {
    const r = await mk({ exitCode: 0, report: { foo: 'bar' } })({ root });
    expect(r.ok).toBe(false);
    expect(r.reportError).toBe('report_fields_invalid');
  });

  it('fail-closed：字段被 boolean 伪装（numTotalTests:true/numFailedTests:false）→ 整数校验拒（防 Number 强转假绿）', async () => {
    const r = await mk({ exitCode: 0, report: { numTotalTests: true, numFailedTests: false } })({ root });
    expect(r.ok).toBe(false);
    expect(r.reportError).toBe('report_fields_invalid');
  });

  it('vitest success=false 但 failed 计数=0 → ok=false（采信 vitest 自身判定）', async () => {
    const r = await mk({ exitCode: 0, report: { numTotalTests: 100, numFailedTests: 0, success: false } })({ root });
    expect(r.ok).toBe(false);
  });

  it('exitCode 非0 → ok=false（即便报告好看）', async () => {
    const r = await mk({ exitCode: 1, report: { numTotalTests: 100, numFailedTests: 0 } })({ root });
    expect(r.ok).toBe(false);
  });

  it('spawn 抛错 → ok=false 且记 error，不崩', async () => {
    const rv = makeNoeSelfEvolutionRuntimeVerify({
      cwd: root,
      spawnFn: vi.fn(async () => { throw new Error('npm not found'); }),
      readJsonReport: () => { throw new Error('no report'); },
    });
    const r = await rv({ root });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('npm not found');
  });

  it('传给 spawn 的参数带 --reporter=json --outputFile（落盘而非读 stdout）', async () => {
    const spawnFn = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    await makeNoeSelfEvolutionRuntimeVerify({ cwd: root, spawnFn, readJsonReport: () => ({ numTotalTests: 1, numFailedTests: 0 }) })({ root });
    const args = spawnFn.mock.calls[0][1];
    expect(args).toContain('--reporter=json');
    expect(args.some((a) => String(a).startsWith('--outputFile='))).toBe(true);
  });
});
