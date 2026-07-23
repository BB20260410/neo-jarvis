import { describe, expect, it } from 'vitest';
import {
  assembleUpdateVerificationDocument,
  planUpdateApply,
  runUpdateCase,
  sha256Hex,
} from '../../src/runtime/NoeRealUpdateExecutor.js';

describe('NoeRealUpdateExecutor', () => {
  it('sha256Hex hashes real bytes', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('planUpdateApply requires integrity + drain', () => {
    const good = planUpdateApply(
      {
        expectedSha256: 'a'.repeat(64),
        actualSha256: 'a'.repeat(64),
        signatureValid: true,
        fromVersion: '2.0.9',
        toVersion: '2.1.0',
        interrupted: false,
        healthOkWithinSec: 10,
        rollbackTriggered: false,
      },
      {
        runningTaskCount: 0,
        drainComplete: true,
        checkpointWritten: true,
        healthOkWithinSec: 10,
      },
    );
    expect(good.accept).toBe(true);

    const badHash = planUpdateApply(
      {
        expectedSha256: 'a'.repeat(64),
        actualSha256: 'b'.repeat(64),
        signatureValid: true,
        fromVersion: '2.0.9',
        toVersion: '2.1.0',
        interrupted: false,
        healthOkWithinSec: 10,
        rollbackTriggered: true,
      },
      {
        runningTaskCount: 0,
        drainComplete: true,
        checkpointWritten: true,
        healthOkWithinSec: 10,
      },
    );
    expect(badHash.accept).toBe(false);
    expect(badHash.blockers).toContain('bad_hash');
  });

  it('runUpdateCase good nMinus1ToN drives real step probes', () => {
    const result = runUpdateCase({
      caseId: 'nMinus1ToN',
      sourceDigest: 'sha256:test',
      buildId: 'build-n',
      fromVersion: '2.0.9',
      toVersion: '2.1.0',
      fromBuildId: 'build-n1',
      toBuildId: 'build-n',
      expectedSha256: 'c'.repeat(64),
      actualSha256: 'c'.repeat(64),
      signatureValid: true,
      interrupted: false,
      steps: {
        writeCheckpoint: () => ({ ok: true, path: '/tmp/cp.json' }),
        probeDrain: () => ({ runningTaskCount: 0, drainComplete: true }),
        applyUpdate: () => ({ ok: true, exitCode: 0, log: 'applied' }),
        rollback: () => ({ ok: true, exitCode: 0, log: 'unused' }),
        probeHealth: () => ({ ok: true, withinSec: 12, log: 'healthy' }),
        verifyInstalled: () => ({ ok: true, version: '2.1.0', buildId: 'build-n', log: 'ok' }),
      },
    });
    expect(result.runner).toBe('noe_real_update_case_v1');
    expect(result.pass).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.logText).toContain('case_start nMinus1ToN');
  });

  it('runUpdateCase badHash rejects apply and requires rollback', () => {
    let rolled = false;
    const result = runUpdateCase({
      caseId: 'badHash',
      sourceDigest: 'sha256:test',
      buildId: 'build-n',
      fromVersion: '2.0.9',
      toVersion: '2.1.0',
      fromBuildId: 'build-n1',
      toBuildId: 'build-n',
      expectedSha256: 'c'.repeat(64),
      actualSha256: 'd'.repeat(64),
      signatureValid: true,
      interrupted: false,
      steps: {
        writeCheckpoint: () => ({ ok: true, path: '/tmp/cp.json' }),
        probeDrain: () => ({ runningTaskCount: 0, drainComplete: true }),
        applyUpdate: () => ({ ok: true, exitCode: 0, log: 'should not apply' }),
        rollback: () => {
          rolled = true;
          return { ok: true, exitCode: 0, log: 'restored' };
        },
        probeHealth: () => ({ ok: true, withinSec: 1, log: 'n/a' }),
      },
    });
    expect(result.pass).toBe(true);
    expect(rolled).toBe(true);
    expect(result.plan.blockers).toContain('bad_hash');
  });

  it('assembleUpdateVerificationDocument requires all eight cases', () => {
    const cases = Object.fromEntries(
      [
        'nMinus1ToN',
        'badHash',
        'badSignature',
        'interruptionRecovery',
        'rollback',
        'taskDrain',
        'checkpoint',
        'healthWindow',
      ].map((id) => [
        id,
        {
          receiptRel: `cases/${id}.json`,
          receiptSha256: 'e'.repeat(64),
          logRel: `cases/${id}.log`,
          logSha256: 'f'.repeat(64),
          pass: true,
        },
      ]),
    );
    const doc = assembleUpdateVerificationDocument({
      sourceDigest: 'sha256:x',
      buildId: 'b1',
      fromVersion: '2.0.9',
      toVersion: '2.1.0',
      fromBuildId: 'b0',
      fromArtifact: { fileName: 'from.zip', sha256: '1'.repeat(64), relativePath: 'from.zip' },
      toArtifact: { fileName: 'to.zip', sha256: '2'.repeat(64) },
      cases,
      commandReceipt: { relativePath: 'command.json', sha256: '3'.repeat(64) },
    });
    expect(doc.runner).toBe('noe_real_update_verification_v1');
    expect(doc.schemaVersion).toBe(2);
    expect(doc.pass).toBe(true);
    expect(doc.nMinus1ToNVerified).toBe(true);
  });
});
