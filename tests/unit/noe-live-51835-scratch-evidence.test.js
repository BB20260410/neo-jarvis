import { describe, expect, it } from 'vitest';
import {
  buildStageDEvidencePack,
  buildStageDLiveScratchReport,
  buildStageDRollbackReport,
  buildStageDScratchMemoryInput,
  scanStageDRedaction,
} from '../../src/runtime/NoeLive51835ScratchEvidence.js';
import { validateNoeFinalStageEvidence } from '../../src/runtime/NoeFinalStageMatrix.js';

function matrix() {
  return {
    schemaVersion: 1,
    roundId: '20260619-final-real-machine-authorization',
    order: ['A', 'B', 'C', 'D', 'E'],
    stageEvidenceDir: 'output/noe-final-real-machine-stages/20260619',
    redactionRules: ['no raw secret', 'no raw private_holdout'],
    forbidden: ['raw secret read', 'raw private_holdout read'],
    authorization: {
      B: { authorized: true, scope: 'configured mechanism only', redactionRequired: true, rawSecretReadAllowed: false, rawPrivateHoldoutReadAllowed: false },
      C: { authorized: true, scope: 'sealed aggregate only', redactionRequired: true, rawSecretReadAllowed: false, rawPrivateHoldoutReadAllowed: false },
      D: { authorized: true, scope: 'scratch write with cleanup', redactionRequired: true, rollbackRequired: true, rawSecretReadAllowed: false, rawPrivateHoldoutReadAllowed: false },
      E: { authorized: true, scope: 'final restart recovery', redactionRequired: true, finalStage: true, rawSecretReadAllowed: false, rawPrivateHoldoutReadAllowed: false },
    },
  };
}

describe('Noe live 51835 scratch evidence', () => {
  it('builds scratch input while keeping the evidence report redacted', () => {
    const marker = 'stage-d-marker-raw';
    const scratchId = 'stage-d-live-scratch-raw';
    const credential = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const memoryInput = buildStageDScratchMemoryInput({
      scratchId,
      marker,
      sourceRef: 'output/noe-final-real-machine-stages/20260619/stage-D-live-51835-scratch-write.json',
      now: new Date('2026-06-19T06:30:00Z'),
    });

    expect(memoryInput.body).toContain(marker);
    expect(memoryInput.id).toBe(scratchId);

    const rollback = buildStageDRollbackReport({
      observedAt: '2026-06-19T06:30:00Z',
      scratchId,
      marker,
      httpStatus: 200,
      cleanupOk: true,
      visibleAfterCleanup: false,
    });
    const report = buildStageDLiveScratchReport({
      observedAt: '2026-06-19T06:30:00Z',
      auth: {
        authorized: true,
        mode: 'standing_grant',
        scope: 'live-protected-api:call+owner-token:read',
        grantRefStatus: 'standing_grant_present',
      },
      scratch: {
        id: scratchId,
        marker,
        projectId: 'stage-d-scratch',
        ttlMs: memoryInput.ttlMs,
        salience: memoryInput.salience,
      },
      steps: [
        { name: 'before_query', ok: true, httpStatus: 200, expected: 'absent' },
        { name: 'scratch_write', ok: true, httpStatus: 201, expected: 'created' },
        { name: 'after_write_query', ok: true, httpStatus: 200, expected: 'visible' },
        { name: 'cleanup_delete', ok: true, httpStatus: 200, expected: 'hidden' },
        { name: 'after_cleanup_query', ok: true, httpStatus: 200, expected: 'absent' },
      ],
      counts: { beforeVisible: 0, afterWriteVisible: 1, afterCleanupVisible: 0 },
      cleanup: { attempted: true, ok: true, httpStatus: 200, visibleAfterCleanup: false },
    });

    const text = JSON.stringify({ report, rollback });
    expect(report.ok).toBe(true);
    expect(rollback.ok).toBe(true);
    expect(text).not.toContain(marker);
    expect(text).not.toContain(scratchId);
    expect(text).not.toContain(memoryInput.body);
    expect(text).not.toContain(credential);
    expect(scanStageDRedaction(report, { disallowedStrings: [marker, scratchId, memoryInput.body, credential] })).toEqual([]);
    expect(scanStageDRedaction(rollback, { disallowedStrings: [marker, scratchId, memoryInput.body, credential] })).toEqual([]);
  });

  it('is accepted by the final stage matrix as redacted Stage D evidence', () => {
    const report = buildStageDLiveScratchReport({
      observedAt: '2026-06-19T06:30:00Z',
      rollbackRef: 'output/noe-final-real-machine-stages/20260619/stage-D-rollback.json',
      auth: { authorized: true, mode: 'standing_grant', scope: 'live-protected-api:call+owner-token:read' },
      scratch: { id: 'scratch-id', marker: 'marker' },
      steps: [
        { name: 'before_query', ok: true, httpStatus: 200 },
        { name: 'scratch_write', ok: true, httpStatus: 201 },
        { name: 'after_write_query', ok: true, httpStatus: 200 },
        { name: 'cleanup_delete', ok: true, httpStatus: 200 },
        { name: 'after_cleanup_query', ok: true, httpStatus: 200 },
      ],
      counts: { beforeVisible: 0, afterWriteVisible: 1, afterCleanupVisible: 0 },
      cleanup: { attempted: true, ok: true, httpStatus: 200, visibleAfterCleanup: false },
    });

    const result = validateNoeFinalStageEvidence({
      matrix: matrix(),
      stageEvidence: { D: report },
      requireComplete: false,
    });

    expect(result.ok).toBe(true);
    expect(result.completed).toEqual(['D']);
  });

  it('creates a reviewer capsule evidence pack without raw scratch content', () => {
    const marker = 'raw-marker';
    const scratchId = 'raw-scratch-id';
    const report = buildStageDLiveScratchReport({
      observedAt: '2026-06-19T06:30:00Z',
      scratch: { id: scratchId, marker },
      steps: [{ name: 'only_step', ok: true, httpStatus: 200 }],
      cleanup: { attempted: true, ok: true, httpStatus: 200, visibleAfterCleanup: false },
    });
    const rollback = buildStageDRollbackReport({
      observedAt: '2026-06-19T06:30:00Z',
      scratchId,
      marker,
      httpStatus: 200,
      cleanupOk: true,
      visibleAfterCleanup: false,
    });
    const pack = buildStageDEvidencePack({
      report,
      rollbackReport: rollback,
      redactionFindings: [],
      commandRefs: ['node scripts/noe-live-51835-scratch-write.mjs'],
    });

    expect(pack).toContain('Shared Reviewer Capsule');
    expect(pack).toContain('qualityProfile: exhaustive');
    expect(pack).not.toContain(marker);
    expect(pack).not.toContain(scratchId);
  });
});
