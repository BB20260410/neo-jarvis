// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { decideGreenAutonomy } from '../../src/security/NoeGreenAutonomyDecision.js';

// 测试用保护路径判定（模拟 isNoePolicyFilePath）
const protect = (p) => /^(server\.js|src\/security\/)/.test(String(p));

describe('NoeGreenAutonomyDecision 绿档自驱决策（P3.2）', () => {
  it('fail-closed：空 changedFiles（首跑无事实证据）→ 不自主', () => {
    expect(decideGreenAutonomy({ changedFiles: [] }).greenTierApproved).toBe(false);
    expect(decideGreenAutonomy({}).greenTierApproved).toBe(false);
    // 即便其他维全 green，无 changedFiles 仍 fail-closed
    expect(decideGreenAutonomy({ changedFiles: [], hasRollback: true, hasOracle: true }).greenTierApproved).toBe(false);
  });

  it('green：小 diff 非保护 + rollback + oracle + 不触外部 → 自主', () => {
    const r = decideGreenAutonomy(
      { changedFiles: ['src/foo/a.js', 'src/foo/b.js'], hasRollback: true, hasOracle: true, touchesExternal: false },
      { isProtectedPath: protect },
    );
    expect(r.tier).toBe('green');
    expect(r.greenTierApproved).toBe(true);
  });

  it('red：触保护路径 → 不自主（blast 一票否决，即便其他全 green）', () => {
    const r = decideGreenAutonomy(
      { changedFiles: ['server.js'], hasRollback: true, hasOracle: true },
      { isProtectedPath: protect },
    );
    expect(r.tier).toBe('red');
    expect(r.greenTierApproved).toBe(false);
  });

  it('yellow：缺 rollback → 不自主（reversible 维）', () => {
    const r = decideGreenAutonomy({ changedFiles: ['src/foo/a.js'], hasRollback: false, hasOracle: true }, { isProtectedPath: protect });
    expect(r.greenTierApproved).toBe(false);
  });

  it('yellow：缺 oracle → 不自主（semantic 维，无独立验证）', () => {
    const r = decideGreenAutonomy({ changedFiles: ['src/foo/a.js'], hasRollback: true, hasOracle: false }, { isProtectedPath: protect });
    expect(r.greenTierApproved).toBe(false);
  });

  it('red：触外部依赖 → 不自主（external 维）', () => {
    const r = decideGreenAutonomy({ changedFiles: ['src/foo/a.js'], hasRollback: true, hasOracle: true, touchesExternal: true }, { isProtectedPath: protect });
    expect(r.greenTierApproved).toBe(false);
  });

  it('yellow：大 diff（>5 文件）→ 不自主（blast 维）', () => {
    const r = decideGreenAutonomy(
      { changedFiles: ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => `src/foo/${x}.js`), hasRollback: true, hasOracle: true },
      { isProtectedPath: protect },
    );
    expect(r.greenTierApproved).toBe(false);
  });

  it('reason 透传 tierRisk 拒因（可观测）', () => {
    const r = decideGreenAutonomy({ changedFiles: ['server.js'], hasRollback: false }, { isProtectedPath: protect });
    expect(r.reason).toContain('保护路径');
  });

  it('fail-closed（codex 加固）：isProtectedPath 抛错 → 当保护(red) → 非 green', () => {
    const r = decideGreenAutonomy(
      { changedFiles: ['src/foo/a.js'], hasRollback: true, hasOracle: true },
      { isProtectedPath: () => { throw new Error('boom'); } },
    );
    expect(r.tier).toBe('red');
    expect(r.greenTierApproved).toBe(false);
  });
});
