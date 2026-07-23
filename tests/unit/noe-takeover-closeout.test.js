// @ts-check
import { describe, expect, it } from 'vitest';
import {
  evaluateTakeoverCloseout,
  PACKAGED_ELECTRON_RUNTIME,
  REQUIRED_RELATIVE_DIMENSIONS,
  TAKEOVER_CLOSEOUT_CONTRACT_VERSION,
} from '../../src/runtime/NoeTakeoverCloseout.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;

function completeEvidence() {
  const bound = () => ({ sourceDigest: DIGEST });
  return {
    sourceDigest: DIGEST,
    testSummary: {
      ...bound(),
      testFilesPassed: 902,
      testFilesTotal: 902,
      testFilesFailed: 0,
      testsPassed: 8408,
      testsTotal: 8408,
      testsFailed: 0,
      testFilesSkipped: 0,
      testsSkipped: 0,
    },
    build: { ...bound(), ok: true },
    smoke: {
      ...bound(),
      app_ready: true,
      server_ready: true,
      window_loaded: /** @type {boolean | undefined} */ (true),
      runtime: PACKAGED_ELECTRON_RUNTIME,
    },
    infoPlist: {
      ...bound(),
      verified: true,
      productName: 'Neo 贾维斯',
      bundleIdentifier: 'com.hxx.noe',
      version: '2.1.0',
      versionMatchesPackage: true,
    },
    artifacts: {
      ...bound(),
      macAppSha256: '1'.repeat(64),
      macDmgSha256: '2'.repeat(64),
      macZipSha256: '3'.repeat(64),
    },
    packagingStage: {
      ...bound(),
      status: 'pass',
      internalOpen: /** @type {string[]} */ ([]),
      internalDone: ['rc_macos_package'],
      externalOnly: [],
      formalSignatureVerified: true,
      notarizationVerified: true,
      windowsRealHostVerified: true,
      linuxRealHostVerified: true,
    },
    gFirst: {
      ...bound(),
      technicalPass: true,
      fiveRealHumans: true,
      humanUserCount: 5,
      humanPassedUserCount: 4,
      requiredPassUsers: 4,
    },
    relativeDimensionSummary: {
      ...bound(),
      total: REQUIRED_RELATIVE_DIMENSIONS,
      relativePass: REQUIRED_RELATIVE_DIMENSIONS,
      nonComparable: 0,
      pending: 0,
      pendingOwnerWaived: 0,
      neoBelow: 0,
      complete: true,
    },
    soak: {
      ...bound(),
      ownerWaived: false,
      status: 'pass',
      completed: true,
      observedHours: 72,
      requiredHours: 72,
    },
    externalBlockers: /** @type {string[] | undefined} */ ([]),
  };
}

describe('NoeTakeoverCloseout', () => {
  it('is deterministic and does not mutate its evidence input', () => {
    const evidence = completeEvidence();
    const before = structuredClone(evidence);
    const first = evaluateTakeoverCloseout(evidence);
    const second = evaluateTakeoverCloseout(evidence);
    expect(first).toEqual(second);
    expect(evidence).toEqual(before);
  });

  it('allows the full-surpass claim only when every local, relative, soak and external gate passes', () => {
    const result = evaluateTakeoverCloseout(completeEvidence());
    expect(result.contractVersion).toBe(TAKEOVER_CLOSEOUT_CONTRACT_VERSION);
    expect(result.sourceDigestBound).toBe(true);
    expect(result.localTechnicalStatus).toBe('pass');
    expect(result.overallStatus).toBe('pass');
    expect(result.relativeStatus).toBe('pass');
    expect(result.soakStatus).toBe('pass');
    expect(result.canClaimFullySurpassed).toBe(true);
    expect(result.counts.localChecks).toEqual({ total: 8, passed: 8, failed: 0, pending: 0 });
    expect(result.counts.testFiles).toEqual({ passed: 902, total: 902, failed: 0 });
    expect(result.blockers.claim).toEqual([]);
  });

  it('requires a genuinely all-green full test summary', () => {
    const failed = completeEvidence();
    failed.testSummary.testFilesPassed = 901;
    failed.testSummary.testFilesFailed = 1;
    failed.testSummary.testsPassed = 8407;
    failed.testSummary.testsFailed = 1;
    const failedResult = evaluateTakeoverCloseout(failed);
    expect(failedResult.checks.tests.status).toBe('fail');
    expect(failedResult.localTechnicalStatus).toBe('fail');
    expect(failedResult.canClaimFullySurpassed).toBe(false);

    const incomplete = completeEvidence();
    incomplete.testSummary.testFilesPassed = 901;
    const incompleteResult = evaluateTakeoverCloseout(incomplete);
    expect(incompleteResult.checks.tests.status).toBe('pending');
    expect(incompleteResult.localTechnicalStatus).toBe('in_progress');
    expect(incompleteResult.blockers.local).toContain('full_test_suite_not_all_green');

    const tiny = completeEvidence();
    tiny.testSummary.testFilesPassed = 1;
    tiny.testSummary.testFilesTotal = 1;
    tiny.testSummary.testsPassed = 1;
    tiny.testSummary.testsTotal = 1;
    const tinyResult = evaluateTakeoverCloseout(tiny);
    expect(tinyResult.localTechnicalStatus).toBe('in_progress');
    expect(tinyResult.blockers.local).toContain('full_test_scope_too_small');
  });

  it('requires app_ready, server_ready and window_loaded from the packaged Electron runtime', () => {
    const wrongRuntime = completeEvidence();
    wrongRuntime.smoke.runtime = 'node_server';
    const wrongRuntimeResult = evaluateTakeoverCloseout(wrongRuntime);
    expect(wrongRuntimeResult.checks.packaged_smoke.status).toBe('fail');
    expect(wrongRuntimeResult.blockers.local).toContain('smoke_not_packaged_electron_runtime');
    expect(wrongRuntimeResult.canClaimFullySurpassed).toBe(false);

    const incomplete = completeEvidence();
    incomplete.smoke.window_loaded = undefined;
    const incompleteResult = evaluateTakeoverCloseout(incomplete);
    expect(incompleteResult.checks.packaged_smoke.status).toBe('pending');
    expect(incompleteResult.localTechnicalStatus).toBe('in_progress');
  });

  it('fails closed when the source digest is missing or any evidence digest differs', () => {
    const missing = completeEvidence();
    missing.sourceDigest = '';
    const missingResult = evaluateTakeoverCloseout(missing);
    expect(missingResult.sourceDigestBound).toBe(false);
    expect(missingResult.localTechnicalStatus).toBe('in_progress');
    expect(missingResult.overallStatus).toBe('in_progress');
    expect(missingResult.canClaimFullySurpassed).toBe(false);
    expect(missingResult.blockers.local).toContain('source_digest_missing');

    const mismatched = completeEvidence();
    mismatched.smoke.sourceDigest = OTHER_DIGEST;
    const mismatchResult = evaluateTakeoverCloseout(mismatched);
    expect(mismatchResult.sourceDigestBound).toBe(false);
    expect(mismatchResult.localTechnicalStatus).toBe('in_progress');
    expect(mismatchResult.canClaimFullySurpassed).toBe(false);
    expect(mismatchResult.blockers.local).toContain('source_digest_mismatch:smoke');
  });

  it('never converts owner-waived soak time into PASS', () => {
    const evidence = completeEvidence();
    evidence.soak.ownerWaived = true;
    evidence.soak.status = 'pass';
    evidence.soak.completed = true;
    evidence.soak.observedHours = 72;
    const result = evaluateTakeoverCloseout(evidence);
    expect(result.localTechnicalStatus).toBe('pass');
    expect(result.soakStatus).toBe('pending_owner_waived');
    expect(result.overallStatus).toBe('pending_owner_waived');
    expect(result.canClaimFullySurpassed).toBe(false);
    expect(result.blockers.soak).toEqual(['soak_pending_owner_waived']);
  });

  it('does not count non_comparable or pending_owner_waived dimensions as relative PASS', () => {
    const nonComparable = completeEvidence();
    nonComparable.relativeDimensionSummary.relativePass = 11;
    nonComparable.relativeDimensionSummary.nonComparable = 1;
    nonComparable.relativeDimensionSummary.complete = false;
    const nonComparableResult = evaluateTakeoverCloseout(nonComparable);
    expect(nonComparableResult.relativeStatus).toBe('pending');
    expect(nonComparableResult.overallStatus).toBe('in_progress');
    expect(nonComparableResult.canClaimFullySurpassed).toBe(false);
    expect(nonComparableResult.blockers.relative).toContain('relative_dimensions_non_comparable');
    expect(nonComparableResult.counts.relativeDimensions.relativePass).toBe(11);

    const waived = completeEvidence();
    waived.relativeDimensionSummary.relativePass = 11;
    waived.relativeDimensionSummary.pendingOwnerWaived = 1;
    waived.relativeDimensionSummary.complete = false;
    const waivedResult = evaluateTakeoverCloseout(waived);
    expect(waivedResult.relativeStatus).toBe('pending');
    expect(waivedResult.blockers.relative).toContain('relative_dimensions_pending_owner_waived');
  });

  it('marks the overall result blocked_external when any mandatory external proof is missing', () => {
    const evidence = completeEvidence();
    evidence.packagingStage.status = 'blocked_external';
    evidence.packagingStage.formalSignatureVerified = false;
    evidence.packagingStage.notarizationVerified = false;
    evidence.packagingStage.windowsRealHostVerified = false;
    evidence.packagingStage.linuxRealHostVerified = false;
    evidence.gFirst.fiveRealHumans = false;
    evidence.gFirst.humanUserCount = 0;
    evidence.gFirst.humanPassedUserCount = 0;
    const result = evaluateTakeoverCloseout(evidence);
    expect(result.localTechnicalStatus).toBe('pass');
    expect(result.overallStatus).toBe('blocked_external');
    expect(result.canClaimFullySurpassed).toBe(false);
    expect(result.blockers.external).toEqual(expect.arrayContaining([
      'formal_signature_missing',
      'apple_notarization_missing',
      'windows_true_host_verification_missing',
      'linux_true_host_verification_missing',
      'five_real_humans_missing',
      'human_pass_threshold_not_met',
    ]));
  });

  it('does not hide a local or soak failure behind external blockers or an owner waiver', () => {
    const localFailure = completeEvidence();
    localFailure.testSummary.testsPassed = 8407;
    localFailure.testSummary.testsFailed = 1;
    localFailure.packagingStage.notarizationVerified = false;
    expect(evaluateTakeoverCloseout(localFailure).overallStatus).toBe('fail');

    const soakFailure = completeEvidence();
    soakFailure.soak.ownerWaived = true;
    soakFailure.soak.status = 'fail';
    const result = evaluateTakeoverCloseout(soakFailure);
    expect(result.soakStatus).toBe('fail');
    expect(result.overallStatus).toBe('fail');
  });

  it('keeps internal packaging work visible even when external gates also block overall', () => {
    const evidence = completeEvidence();
    evidence.packagingStage.status = 'in_progress';
    evidence.packagingStage.internalOpen = ['mac_zip_hashed'];
    evidence.packagingStage.notarizationVerified = false;
    const result = evaluateTakeoverCloseout(evidence);
    expect(result.localTechnicalStatus).toBe('in_progress');
    expect(result.overallStatus).toBe('blocked_external');
    expect(result.blockers.local).toContain('packaging_internal_open:mac_zip_hashed');
    expect(result.blockers.external).toContain('apple_notarization_missing');
  });

  it('merges declared external blockers and rejects a missing blocker inventory', () => {
    const declared = completeEvidence();
    declared.externalBlockers = ['owner_release_authorization'];
    const declaredResult = evaluateTakeoverCloseout(declared);
    expect(declaredResult.overallStatus).toBe('blocked_external');
    expect(declaredResult.blockers.external).toContain('owner_release_authorization');

    const missing = completeEvidence();
    missing.externalBlockers = undefined;
    const missingResult = evaluateTakeoverCloseout(missing);
    expect(missingResult.overallStatus).toBe('blocked_external');
    expect(missingResult.blockers.external).toContain('external_blocker_inventory_missing');
  });
});
