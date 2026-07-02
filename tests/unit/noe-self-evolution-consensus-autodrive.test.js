import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeNoeSelfEvolutionConsensusAutodrive } from '../../src/room/NoeSelfEvolutionConsensusAutodrive.js';
import { resolveNoeSelfEvolutionConsensus, isNoeConsensusAuthorizationPassed } from '../../src/room/NoeSelfEvolutionGate.js';
import { evaluateNoeSelfEvolutionLoop } from '../../src/room/NoeSelfEvolutionLoop.js';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'noe-se-autodrive-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const grantOk = () => ({ authorized: true, grantId: 'grant-test' });
const grantNo = () => ({ authorized: false });

describe('NoeSelfEvolutionConsensusAutodrive', () => {
  it('standing grant 缺失 → 不解锁（保持 consensus_blocked 语义）', () => {
    const assemble = makeNoeSelfEvolutionConsensusAutodrive({ root, evaluateGrant: grantNo });
    const out = assemble({ goal: '修复 startsWith 越界' });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('standing_grant_required_for_consensus_autodrive');
  });

  it('授权后 → 产出真 validated consensus ledger + 工件全落盘', () => {
    const assemble = makeNoeSelfEvolutionConsensusAutodrive({ root, evaluateGrant: grantOk });
    const out = assemble({ goal: '修复 startsWith 越界', objective: '补 path.sep 尾界' });
    expect(out.ok).toBe(true);
    expect(out.consensusLedgerRef).toMatch(/ledger\.json$/);
    // 文件真落盘
    expect(existsSync(join(root, out.consensusLedgerRef))).toBe(true);
    expect(existsSync(join(root, out.evidenceRef))).toBe(true);
    expect(existsSync(join(root, out.rollback.planRef))).toBe(true);
    // ledger 自身 gate.ok
    const ledger = JSON.parse(readFileSync(join(root, out.consensusLedgerRef), 'utf8'));
    expect(ledger.gate.ok).toBe(true);
    expect(ledger.gate.errors).toEqual([]);
    // 不含 secret 标记
    expect(ledger.gate.consensus.approvedCount).toBeGreaterThanOrEqual(2);
  });

  it('产出的 ledgerRef 真能过 self-evolution gate consensus 校验', () => {
    const assemble = makeNoeSelfEvolutionConsensusAutodrive({ root, evaluateGrant: grantOk });
    const out = assemble({ goal: '修复 startsWith 越界' });
    const resolved = resolveNoeSelfEvolutionConsensus({ ledgerRef: out.consensusLedgerRef, root });
    expect(resolved.ok).toBe(true);
    expect(resolved.ledgerVerified).toBe(true);
    expect(resolved.source).toBe('validated_consensus_ledger');
    expect(isNoeConsensusAuthorizationPassed(resolved)).toBe(true);
  });

  it('把产出 patch 进 cycle → loop 从 consensus_blocked 推进到 implementation_ready', () => {
    const assemble = makeNoeSelfEvolutionConsensusAutodrive({ root, evaluateGrant: grantOk });
    const out = assemble({ goal: '修复 startsWith 越界' });
    // 解锁前：纯 cycle 无 ledger → consensus_blocked
    const before = evaluateNoeSelfEvolutionLoop({ cycleId: 'c1', goal: '修复 startsWith 越界', dryRun: true });
    expect(before.stage).toBe('consensus_blocked');
    // 解锁后：patch consensusLedgerRef + authorization + rollback
    const after = evaluateNoeSelfEvolutionLoop({
      cycleId: 'c1', goal: '修复 startsWith 越界', root, dryRun: true,
      consensusLedgerRef: out.consensusLedgerRef,
      authorization: out.authorization,
      rollback: out.rollback,
    });
    expect(after.stage).toBe('implementation_ready');
    expect(after.blocked).toBe(false);
  });

  it('requireStandingGrant=false → 无 grant 也装配（便于离线 drill）', () => {
    const assemble = makeNoeSelfEvolutionConsensusAutodrive({ root, requireStandingGrant: false });
    const out = assemble({ goal: '修复 startsWith 越界' });
    expect(out.ok).toBe(true);
  });
});
