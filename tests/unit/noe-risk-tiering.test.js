// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { tierRisk, isGreenTier } from '../../src/security/NoeRiskTiering.js';

const GREEN = { changedFiles: ['src/a.js'], rollbackRef: 'sha1', hasOracle: true }; // 全绿基线

describe('NoeRiskTiering 5 维风险分级 (ROADMAP P2.3)', () => {
  it('全 green：单文件+有rollback+有oracle+不触外部+单模块', () => {
    const r = tierRisk(GREEN);
    expect(r.tier).toBe('green');
    expect(r.dims).toEqual({ blast: 'green', reversible: 'green', external: 'green', semantic: 'green', coupling: 'green' });
  });
  it('blast red：触保护路径', () => {
    const r = tierRisk({ ...GREEN, changedFiles: ['server.js'] }, { isProtectedPath: (p) => p === 'server.js' });
    expect(r.dims.blast).toBe('red');
    expect(r.tier).toBe('red');
  });
  it('blast yellow：改动 >5 文件', () => {
    const r = tierRisk({ ...GREEN, changedFiles: ['a', 'b', 'c', 'd', 'e', 'f'] });
    expect(r.dims.blast).toBe('yellow');
    expect(r.tier).toBe('yellow');
  });
  it('可逆 yellow：缺 rollbackRef', () => {
    expect(tierRisk({ changedFiles: ['src/a.js'], hasOracle: true }).dims.reversible).toBe('yellow');
  });
  it('外部 red：命令触网/装包/凭据 或 显式标记', () => {
    expect(tierRisk({ ...GREEN, command: 'npm install foo' }).dims.external).toBe('red');
    expect(tierRisk({ ...GREEN, command: 'curl http://x' }).dims.external).toBe('red');
    expect(tierRisk({ ...GREEN, touchesExternal: true }).dims.external).toBe('red');
  });
  it('语义 yellow：无独立 oracle', () => {
    expect(tierRisk({ changedFiles: ['src/a.js'], rollbackRef: 's' }).dims.semantic).toBe('yellow');
  });
  it('耦合 yellow：跨 >3 模块', () => {
    const r = tierRisk({ ...GREEN, changedFiles: ['src/a/x.js', 'src/b/y.js', 'src/c/z.js', 'src/d/w.js'] });
    expect(r.dims.coupling).toBe('yellow');
  });
  it('汇总就高不就低：任一 red → red', () => {
    const r = tierRisk({ changedFiles: ['server.js', 'b', 'c', 'd', 'e', 'f'], command: 'curl http://x' }, { isProtectedPath: (p) => p === 'server.js' });
    expect(r.tier).toBe('red');
  });
  it('汇总：无 red 有 yellow → yellow', () => {
    expect(tierRisk({ changedFiles: ['src/a.js'], rollbackRef: 's' }).tier).toBe('yellow'); // semantic yellow
  });
  it('reasons 列出黄/红原因', () => {
    const r = tierRisk({ changedFiles: ['src/a.js'] }); // 缺 rollback + oracle
    expect(r.reasons.some((x) => x.includes('可逆'))).toBe(true);
    expect(r.reasons.some((x) => x.includes('语义验证'))).toBe(true);
  });
  it('isGreenTier', () => {
    expect(isGreenTier(tierRisk(GREEN))).toBe(true);
    expect(isGreenTier(tierRisk({ changedFiles: ['src/a.js'] }))).toBe(false);
    expect(isGreenTier(null)).toBe(false);
  });
  it('反向 probe：空候选不崩', () => {
    expect(() => tierRisk()).not.toThrow();
    expect(() => tierRisk({})).not.toThrow();
  });
  it('反向 probe：isProtectedPath 抛错 → 该文件不算保护(不崩)', () => {
    const r = tierRisk({ ...GREEN, changedFiles: ['x.js'] }, { isProtectedPath: () => { throw new Error('boom'); } });
    expect(r.dims.blast).toBe('green');
  });
});
