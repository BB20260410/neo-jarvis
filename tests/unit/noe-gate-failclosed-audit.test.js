// @ts-check
/**
 * Codex audit: Gate runner fail-closed + matrix apply only.
 * Drives real evaluateAbsoluteGate / runAcceptanceGates / applyGateResultsToMatrix.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  evaluateAbsoluteGate,
  runAcceptanceGates,
  validateEvidenceRecord,
  applyGateResultsToMatrix,
  markStaleEvidenceByDigest,
  summarizeGateStatuses,
  resolveEvidencePath,
  GATE_RUNNER_SCHEMA_VERSION,
} from '../../src/runtime/NoeAcceptanceGateRunner.js';
import { sha256Hex } from '../../src/runtime/NoeSourceDigest.js';

function makeMatrix(gates) {
  return {
    planId: 'test-plan',
    authority: { executorMaximumStatus: 'ready_for_codex_validation' },
    candidate: {
      overallStatus: 'in_progress',
      sourceDigest: 'sha256:current',
      runtimeConfigDigest: 'sha256:cfg',
      startedAt: '2026-01-01T00:00:00Z',
    },
    absoluteGates: gates,
    stages: [{ id: 'S0', name: 'S0', dependsOn: [], status: 'completed', evidence: [] }],
  };
}

describe('Gate fail-closed (Codex audit)', () => {
  it('exports schema v2', () => {
    expect(GATE_RUNNER_SCHEMA_VERSION).toBe(2);
  });

  it('evidenceCount=0 → pending even if metric hits target', () => {
    const r = evaluateAbsoluteGate(
      {
        id: 'G-SAFE-01',
        metric: 'highRiskConfirmationAccuracy',
        operator: 'gte',
        target: 1.0,
        evidence: [],
      },
      {
        metrics: { highRiskConfirmationAccuracy: 1.0 },
        sourceDigest: 'sha256:abc',
      },
    );
    expect(r.status).toBe('pending');
    expect(r.evidenceCount).toBe(0);
    expect(r.validEvidenceCount).toBe(0);
    expect(r.blockers).toContain('evidence_count_zero');
    expect(r.blockers).toContain('no_valid_bound_evidence');
  });

  it('validEvidenceCount=0 (missing file) → pending, never pass', () => {
    const r = evaluateAbsoluteGate(
      {
        id: 'G-VOICE-01',
        metric: 'voiceTaskSuccessRate',
        operator: 'gte',
        target: 0.9,
        evidence: [
          {
            path: '/nonexistent/voice-proof.json',
            sourceDigest: 'sha256:abc',
            artifactSha256: 'deadbeef',
          },
        ],
      },
      {
        metrics: { voiceTaskSuccessRate: 1.0 },
        sourceDigest: 'sha256:abc',
      },
    );
    expect(r.status).toBe('pending');
    expect(r.validEvidenceCount).toBe(0);
    expect(r.evidenceCount).toBe(1);
    expect(r.blockers).toContain('no_valid_bound_evidence');
    expect(r.blockers).toContain('artifact_missing');
  });

  it('sourceDigest mismatch → invalid evidence → pending', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gate-mm-'));
    const art = join(tmp, 'p.json');
    writeFileSync(art, '{"ok":true}\n');
    try {
      const r = evaluateAbsoluteGate(
        {
          id: 'G-SAFE-01',
          metric: 'highRiskConfirmationAccuracy',
          operator: 'gte',
          target: 1,
          evidence: [
            {
              path: art,
              sourceDigest: 'sha256:old',
              artifactSha256: sha256Hex('{"ok":true}\n'),
            },
          ],
        },
        {
          metrics: { highRiskConfirmationAccuracy: 1 },
          sourceDigest: 'sha256:new',
        },
      );
      expect(r.status).toBe('pending');
      expect(r.validEvidenceCount).toBe(0);
      expect(r.blockers.join(' ')).toMatch(/sourceDigest_mismatch|no_valid_bound_evidence/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('evidence missing sourceDigest when required → pending', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gate-nodig-'));
    const art = join(tmp, 'p.json');
    writeFileSync(art, 'x\n');
    try {
      const r = evaluateAbsoluteGate(
        {
          id: 'G-X',
          metric: 'm',
          operator: 'eq',
          target: 0,
          evidence: [{ path: art, artifactSha256: sha256Hex('x\n') }],
        },
        { metrics: { m: 0 }, sourceDigest: 'sha256:req' },
      );
      expect(r.status).toBe('pending');
      expect(r.blockers).toContain('evidence_missing_sourceDigest');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('artifact hash mismatch → pending', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gate-hash-'));
    const art = join(tmp, 'p.json');
    writeFileSync(art, 'real\n');
    try {
      const r = evaluateAbsoluteGate(
        {
          id: 'G-X',
          metric: 'm',
          operator: 'eq',
          target: 0,
          evidence: [
            {
              path: art,
              sourceDigest: 'sha256:abc',
              artifactSha256: sha256Hex('wrong\n'),
            },
          ],
        },
        { metrics: { m: 0 }, sourceDigest: 'sha256:abc' },
      );
      expect(r.status).toBe('pending');
      expect(r.blockers).toContain('artifact_hash_mismatch');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('unknown exit on evidence → invalid', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gate-exit-'));
    const art = join(tmp, 'p.json');
    writeFileSync(art, 'ok\n');
    try {
      const v = validateEvidenceRecord(
        {
          path: art,
          sourceDigest: 'sha256:abc',
          artifactSha256: sha256Hex('ok\n'),
          unknownExit: true,
        },
        { sourceDigest: 'sha256:abc' },
      );
      expect(v.valid).toBe(false);
      expect(v.reason).toBe('evidence_unknown_exit');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('forbidden soleProofType → invalid', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gate-sole-'));
    const art = join(tmp, 'p.json');
    writeFileSync(art, 'ok\n');
    try {
      const v = validateEvidenceRecord(
        {
          path: art,
          sourceDigest: 'sha256:abc',
          soleProofType: 'tts_stt_only',
        },
        { sourceDigest: 'sha256:abc' },
      );
      expect(v.valid).toBe(false);
      expect(v.reason).toBe('sole_proof_type_forbidden');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('pass only with metric + existing path + matching digest + hash', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gate-ok-'));
    const art = join(tmp, 'p.json');
    const body = '{"accuracy":1}\n';
    writeFileSync(art, body);
    try {
      const r = evaluateAbsoluteGate(
        {
          id: 'G-SAFE-01',
          metric: 'highRiskConfirmationAccuracy',
          operator: 'gte',
          target: 1,
          evidence: [
            {
              path: art,
              sourceDigest: 'sha256:abc',
              artifactSha256: sha256Hex(body),
            },
          ],
        },
        {
          metrics: { highRiskConfirmationAccuracy: 1 },
          sourceDigest: 'sha256:abc',
        },
      );
      expect(r.status).toBe('pass');
      expect(r.validEvidenceCount).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('runAcceptanceGates summary never counts illegal pass', () => {
    const report = runAcceptanceGates(
      makeMatrix([
        {
          id: 'G-SAFE-01',
          metric: 'highRiskConfirmationAccuracy',
          operator: 'gte',
          target: 1,
          evidence: [],
          status: 'pass', // hand-written PASS must not survive evaluation
        },
      ]),
      {
        metrics: { highRiskConfirmationAccuracy: 1 },
        sourceDigest: 'sha256:current',
      },
    );
    expect(report.absolute[0].status).toBe('pending');
    expect(report.summary.pass).toBe(0);
    expect(report.summary.pending).toBe(1);
    expect(report.readyForCodexValidation).toBe(false);
  });

  it('applyGateResultsToMatrix is the only path to set PASS and demotes hand PASS', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gate-apply-'));
    const art = join(tmp, 'ok.json');
    writeFileSync(art, 'ok\n');
    try {
      const matrix = makeMatrix([
        {
          id: 'G1',
          metric: 'm',
          operator: 'eq',
          target: 0,
          status: 'pass', // illegal hand pass with empty evidence
          evidence: [],
        },
        {
          id: 'G2',
          metric: 'm',
          operator: 'eq',
          target: 0,
          status: 'pending',
          evidence: [
            {
              path: art,
              sourceDigest: 'sha256:current',
              artifactSha256: sha256Hex('ok\n'),
            },
          ],
        },
      ]);
      const report = runAcceptanceGates(matrix, {
        metrics: { m: 0 },
        sourceDigest: 'sha256:current',
      });
      const applied = applyGateResultsToMatrix(matrix, report, {
        sourceDigest: 'sha256:current',
        runtimeConfigDigest: 'sha256:cfg',
      });
      const g1 = applied.absoluteGates.find((g) => g.id === 'G1');
      const g2 = applied.absoluteGates.find((g) => g.id === 'G2');
      expect(g1.status).toBe('pending');
      expect(g2.status).toBe('pass');
      expect(g2.lastEvaluation.validEvidenceCount).toBe(1);
      expect(applied.candidate.sourceDigest).toBe('sha256:current');
      expect(applied.candidate.overallStatus).not.toBe('accepted');
      expect(applied.candidate.readyForCodexValidationAt).toBeFalsy();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('markStaleEvidenceByDigest marks old digest and demotes pass', () => {
    const matrix = makeMatrix([
      {
        id: 'G1',
        metric: 'm',
        operator: 'eq',
        target: 0,
        status: 'pass',
        evidence: [{ path: 'x', sourceDigest: 'sha256:old' }],
      },
    ]);
    const { matrix: next, staleCount } = markStaleEvidenceByDigest(matrix, 'sha256:new');
    expect(staleCount).toBe(1);
    expect(next.absoluteGates[0].evidence[0].stale).toBe(true);
    expect(next.absoluteGates[0].status).toBe('pending');
  });

  it('resolveEvidencePath finds files under evidenceRoot', () => {
    const root = mkdtempSync(join(tmpdir(), 'evroot-'));
    const nested = join(root, 'S10');
    mkdirSync(nested, { recursive: true });
    const f = join(nested, 'a.json');
    writeFileSync(f, '{}');
    try {
      const r = resolveEvidencePath('S10/a.json', { evidenceRoot: root });
      expect(r).toBe(f);
      expect(resolveEvidencePath('missing.json', { evidenceRoot: root })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('summarizeGateStatuses matches statuses', () => {
    expect(
      summarizeGateStatuses([
        { status: 'pass' },
        { status: 'pending' },
        { status: 'fail' },
        { status: 'blocked_external' },
      ]),
    ).toEqual({ pass: 1, fail: 1, pending: 1, blocked_external: 1 });
  });
});
