// @ts-check
/**
 * Pure, fail-closed reducer for the Neo takeover closeout.
 *
 * This module does not read files, run commands, or mutate evidence. It only
 * reduces already-collected evidence into a local technical status and a
 * stricter overall claim status.
 */

export const TAKEOVER_CLOSEOUT_CONTRACT_VERSION = 1;
export const REQUIRED_RELATIVE_DIMENSIONS = 12;
export const FULL_TEST_MIN_FILES = 900;
export const FULL_TEST_MIN_CASES = 8400;
export const PACKAGED_ELECTRON_RUNTIME = 'packaged_electron';

/** @typedef {'pass'|'in_progress'|'fail'|'pending_owner_waived'} LocalTechnicalStatus */
/** @typedef {'pass'|'in_progress'|'fail'|'pending_owner_waived'|'blocked_external'} OverallStatus */
/** @typedef {'pass'|'pending'|'fail'} CheckStatus */

/**
 * @typedef {object} DigestBoundEvidence
 * @property {string} [sourceDigest]
 */

/**
 * @typedef {DigestBoundEvidence & {
 *   testFilesPassed?: number,
 *   testFilesTotal?: number,
 *   testFilesFailed?: number,
 *   testsPassed?: number,
 *   testsTotal?: number,
 *   testsFailed?: number,
 *   testFilesSkipped?: number,
 *   testsSkipped?: number,
 * }} TestSummary
 */

/**
 * @typedef {DigestBoundEvidence & {
 *   ok?: boolean,
 * }} BuildEvidence
 */

/**
 * @typedef {DigestBoundEvidence & {
 *   app_ready?: boolean,
 *   server_ready?: boolean,
 *   window_loaded?: boolean,
 *   runtime?: string,
 * }} SmokeEvidence
 */

/**
 * @typedef {DigestBoundEvidence & {
 *   verified?: boolean,
 *   productName?: string,
 *   bundleIdentifier?: string,
 *   version?: string,
 *   versionMatchesPackage?: boolean,
 * }} InfoPlistEvidence
 */

/**
 * @typedef {DigestBoundEvidence & {
 *   macAppSha256?: string,
 *   macDmgSha256?: string,
 *   macZipSha256?: string,
 * }} ArtifactEvidence
 */

/**
 * @typedef {DigestBoundEvidence & {
 *   status?: string,
 *   internalOpen?: string[],
 *   internalDone?: string[],
 *   externalOnly?: string[],
 *   formalSignatureVerified?: boolean,
 *   notarizationVerified?: boolean,
 *   windowsRealHostVerified?: boolean,
 *   linuxRealHostVerified?: boolean,
 * }} PackagingStageEvidence
 */

/**
 * @typedef {DigestBoundEvidence & {
 *   technicalPass?: boolean,
 *   fiveRealHumans?: boolean,
 *   humanUserCount?: number,
 *   humanPassedUserCount?: number,
 *   requiredPassUsers?: number,
 * }} GFirstEvidence
 */

/**
 * @typedef {DigestBoundEvidence & {
 *   total?: number,
 *   relativePass?: number,
 *   nonComparable?: number,
 *   pending?: number,
 *   pendingOwnerWaived?: number,
 *   neoBelow?: number,
 *   complete?: boolean,
 * }} RelativeDimensionSummary
 */

/**
 * @typedef {DigestBoundEvidence & {
 *   ownerWaived?: boolean,
 *   status?: string,
 *   completed?: boolean,
 *   observedHours?: number,
 *   requiredHours?: number,
 * }} SoakEvidence
 */

/**
 * @typedef {object} TakeoverCloseoutInput
 * @property {string} [sourceDigest]
 * @property {TestSummary} [testSummary]
 * @property {BuildEvidence} [build]
 * @property {SmokeEvidence} [smoke]
 * @property {InfoPlistEvidence} [infoPlist]
 * @property {ArtifactEvidence} [artifacts]
 * @property {PackagingStageEvidence} [packagingStage]
 * @property {GFirstEvidence} [gFirst]
 * @property {RelativeDimensionSummary} [relativeDimensionSummary]
 * @property {SoakEvidence} [soak]
 * @property {string[]} [externalBlockers]
 */

const EVIDENCE_SECTIONS = Object.freeze([
  'testSummary',
  'build',
  'smoke',
  'infoPlist',
  'artifacts',
  'packagingStage',
  'gFirst',
  'relativeDimensionSummary',
  'soak',
]);

/**
 * Reduce all takeover evidence. A `pass` is intentionally difficult to obtain:
 * every evidence section must bind to the same source digest; all local checks,
 * the real soak, all twelve relative dimensions, and all external gates must
 * pass. Owner waiver never upgrades the soak to pass.
 *
 * @param {TakeoverCloseoutInput} [input]
 */
export function evaluateTakeoverCloseout(input = {}) {
  const sourceBinding = evaluateSourceBinding(input);
  const localChecks = {
    source_binding: sourceBinding.check,
    tests: evaluateTests(input.testSummary),
    build: evaluateBuild(input.build),
    packaged_smoke: evaluateSmoke(input.smoke),
    info_plist: evaluateInfoPlist(input.infoPlist),
    mac_artifact_hashes: evaluateArtifacts(input.artifacts),
    packaging_internal: evaluatePackagingInternal(input.packagingStage),
    g_first_technical: evaluateGFirstTechnical(input.gFirst),
  };

  const localCheckRows = Object.entries(localChecks);
  const localFailed = localCheckRows.filter(([, value]) => value.status === 'fail');
  const localPending = localCheckRows.filter(([, value]) => value.status === 'pending');
  const localPassed = localCheckRows.filter(([, value]) => value.status === 'pass');
  const localBlockers = unique([
    ...localFailed.flatMap(([, value]) => value.blockers),
    ...localPending.flatMap(([, value]) => value.blockers),
  ]);

  /** @type {LocalTechnicalStatus} */
  let localTechnicalStatus = 'pass';
  // A missing/mismatched digest means the other evidence cannot be trusted as
  // current, even if it contains an explicit failure from an older source.
  if (!sourceBinding.ok) localTechnicalStatus = 'in_progress';
  else if (localFailed.length > 0) localTechnicalStatus = 'fail';
  else if (localPending.length > 0) localTechnicalStatus = 'in_progress';

  const relative = evaluateRelativeDimensions(input.relativeDimensionSummary);
  const soak = evaluateSoak(input.soak);
  const external = evaluateExternalBlockers(input);

  const claimBlockers = unique([
    ...localBlockers,
    ...relative.blockers,
    ...soak.blockers,
    ...external.blockers,
  ]);

  /** @type {OverallStatus} */
  let overallStatus = 'pass';
  // A real local/relative/soak failure must never be hidden behind an external
  // blocker. Evidence binding is next; only an otherwise non-failing candidate
  // can be summarized as blocked_external.
  if (localTechnicalStatus === 'fail' || relative.status === 'fail' || soak.status === 'fail') {
    overallStatus = 'fail';
  } else if (!sourceBinding.ok) overallStatus = 'in_progress';
  else if (external.blockers.length > 0) overallStatus = 'blocked_external';
  else if (localTechnicalStatus !== 'pass' || relative.status !== 'pass') {
    overallStatus = 'in_progress';
  } else if (soak.status === 'pending_owner_waived') {
    overallStatus = 'pending_owner_waived';
  } else if (soak.status !== 'pass') {
    overallStatus = 'in_progress';
  }

  const canClaimFullySurpassed =
    sourceBinding.ok &&
    localTechnicalStatus === 'pass' &&
    overallStatus === 'pass' &&
    relative.status === 'pass' &&
    soak.status === 'pass' &&
    external.blockers.length === 0;

  return {
    contractVersion: TAKEOVER_CLOSEOUT_CONTRACT_VERSION,
    sourceDigest: sourceBinding.sourceDigest,
    sourceDigestBound: sourceBinding.ok,
    localTechnicalStatus,
    overallStatus,
    canClaimFullySurpassed,
    soakStatus: soak.status,
    relativeStatus: relative.status,
    checks: localChecks,
    counts: {
      localChecks: {
        total: localCheckRows.length,
        passed: localPassed.length,
        failed: localFailed.length,
        pending: localPending.length,
      },
      testFiles: {
        passed: nonNegativeInteger(input.testSummary?.testFilesPassed),
        total: nonNegativeInteger(input.testSummary?.testFilesTotal),
        failed: nonNegativeInteger(input.testSummary?.testFilesFailed),
      },
      tests: {
        passed: nonNegativeInteger(input.testSummary?.testsPassed),
        total: nonNegativeInteger(input.testSummary?.testsTotal),
        failed: nonNegativeInteger(input.testSummary?.testsFailed),
      },
      relativeDimensions: relative.counts,
      externalBlockers: external.blockers.length,
      claimBlockers: claimBlockers.length,
    },
    blockers: {
      local: localBlockers,
      relative: relative.blockers,
      soak: soak.blockers,
      external: external.blockers,
      claim: claimBlockers,
    },
  };
}

/** @param {TakeoverCloseoutInput} input */
function evaluateSourceBinding(input) {
  const sourceDigest = normalizeSourceDigest(input.sourceDigest);
  const blockers = [];
  if (!sourceDigest) blockers.push('source_digest_missing');

  for (const key of EVIDENCE_SECTIONS) {
    const section = input[key];
    const evidenceDigest = normalizeSourceDigest(section?.sourceDigest);
    if (!evidenceDigest) blockers.push(`source_digest_missing:${key}`);
    else if (sourceDigest && evidenceDigest !== sourceDigest) {
      blockers.push(`source_digest_mismatch:${key}`);
    }
  }

  return {
    ok: blockers.length === 0,
    sourceDigest,
    check: check(blockers.length === 0 ? 'pass' : 'pending', blockers),
  };
}

/** @param {TestSummary | undefined} evidence */
function evaluateTests(evidence) {
  if (!evidence) return check('pending', ['test_summary_missing']);
  const filesPassed = nonNegativeInteger(evidence.testFilesPassed);
  const filesTotal = nonNegativeInteger(evidence.testFilesTotal);
  const filesFailed = nonNegativeInteger(evidence.testFilesFailed);
  const testsPassed = nonNegativeInteger(evidence.testsPassed);
  const testsTotal = nonNegativeInteger(evidence.testsTotal);
  const testsFailed = nonNegativeInteger(evidence.testsFailed);
  const filesSkipped = optionalNonNegativeInteger(evidence.testFilesSkipped);
  const testsSkipped = optionalNonNegativeInteger(evidence.testsSkipped);

  if ((filesFailed ?? 0) > 0 || (testsFailed ?? 0) > 0) {
    return check('fail', ['full_test_suite_failed']);
  }
  if (
    filesPassed == null ||
    filesTotal == null ||
    filesFailed == null ||
    testsPassed == null ||
    testsTotal == null ||
    testsFailed == null ||
    filesTotal <= 0 ||
    testsTotal <= 0
  ) {
    return check('pending', ['full_test_counts_missing']);
  }
  if (filesTotal < FULL_TEST_MIN_FILES || testsTotal < FULL_TEST_MIN_CASES) {
    return check('pending', ['full_test_scope_too_small']);
  }
  if (
    filesPassed !== filesTotal ||
    testsPassed !== testsTotal ||
    (filesSkipped != null && filesSkipped !== 0) ||
    (testsSkipped != null && testsSkipped !== 0)
  ) {
    return check('pending', ['full_test_suite_not_all_green']);
  }
  return check('pass');
}

/** @param {BuildEvidence | undefined} evidence */
function evaluateBuild(evidence) {
  if (evidence?.ok === true) return check('pass');
  if (evidence?.ok === false) return check('fail', ['packaged_build_failed']);
  return check('pending', ['packaged_build_missing']);
}

/** @param {SmokeEvidence | undefined} evidence */
function evaluateSmoke(evidence) {
  if (!evidence) return check('pending', ['packaged_smoke_missing']);
  const flags = [evidence.app_ready, evidence.server_ready, evidence.window_loaded];
  if (flags.some((value) => value === false)) {
    return check('fail', ['packaged_smoke_failed']);
  }
  if (evidence.runtime && evidence.runtime !== PACKAGED_ELECTRON_RUNTIME) {
    return check('fail', ['smoke_not_packaged_electron_runtime']);
  }
  if (flags.some((value) => value !== true) || !evidence.runtime) {
    return check('pending', ['packaged_smoke_incomplete']);
  }
  return check('pass');
}

/** @param {InfoPlistEvidence | undefined} evidence */
function evaluateInfoPlist(evidence) {
  if (!evidence) return check('pending', ['info_plist_evidence_missing']);
  if (evidence.verified === false || evidence.versionMatchesPackage === false) {
    return check('fail', ['info_plist_verification_failed']);
  }
  const valuesComplete =
    evidence.verified === true &&
    evidence.productName === 'Neo 贾维斯' &&
    evidence.bundleIdentifier === 'com.hxx.noe' &&
    clean(evidence.version) !== '' &&
    evidence.versionMatchesPackage === true;
  if (!valuesComplete) return check('pending', ['info_plist_contract_incomplete']);
  return check('pass');
}

/** @param {ArtifactEvidence | undefined} evidence */
function evaluateArtifacts(evidence) {
  if (
    !isSha256(evidence?.macAppSha256) ||
    !isSha256(evidence?.macDmgSha256) ||
    !isSha256(evidence?.macZipSha256)
  ) {
    return check('pending', ['mac_app_dmg_zip_hashes_missing_or_invalid']);
  }
  return check('pass');
}

/** @param {PackagingStageEvidence | undefined} evidence */
function evaluatePackagingInternal(evidence) {
  if (!evidence) return check('pending', ['packaging_stage_missing']);
  if (evidence.status === 'fail') return check('fail', ['packaging_stage_failed']);
  if (!Array.isArray(evidence.internalOpen)) {
    return check('pending', ['packaging_internal_inventory_missing']);
  }
  if (evidence.internalOpen.length > 0) {
    return check('pending', evidence.internalOpen.map((id) => `packaging_internal_open:${clean(id)}`));
  }
  if (evidence.status !== 'pass' && evidence.status !== 'blocked_external') {
    return check('pending', ['packaging_stage_not_closed']);
  }
  return check('pass');
}

/** @param {GFirstEvidence | undefined} evidence */
function evaluateGFirstTechnical(evidence) {
  if (evidence?.technicalPass === true) return check('pass');
  if (evidence?.technicalPass === false) return check('fail', ['g_first_technical_failed']);
  return check('pending', ['g_first_technical_missing']);
}

/** @param {RelativeDimensionSummary | undefined} summary */
function evaluateRelativeDimensions(summary) {
  const counts = {
    total: nonNegativeInteger(summary?.total),
    relativePass: nonNegativeInteger(summary?.relativePass),
    nonComparable: nonNegativeInteger(summary?.nonComparable),
    pending: nonNegativeInteger(summary?.pending),
    pendingOwnerWaived: nonNegativeInteger(summary?.pendingOwnerWaived),
    neoBelow: nonNegativeInteger(summary?.neoBelow),
  };
  const values = Object.values(counts);
  if (values.some((value) => value == null)) {
    return { status: 'pending', blockers: ['relative_summary_counts_missing'], counts };
  }

  const total = /** @type {number} */ (counts.total);
  const relativePass = /** @type {number} */ (counts.relativePass);
  const nonComparable = /** @type {number} */ (counts.nonComparable);
  const pending = /** @type {number} */ (counts.pending);
  const pendingOwnerWaived = /** @type {number} */ (counts.pendingOwnerWaived);
  const neoBelow = /** @type {number} */ (counts.neoBelow);
  const partition = relativePass + nonComparable + pending + pendingOwnerWaived + neoBelow;
  if (partition !== total) {
    return { status: 'pending', blockers: ['relative_summary_inconsistent'], counts };
  }
  if (neoBelow > 0) {
    return { status: 'fail', blockers: ['neo_below_bailongma_dimension'], counts };
  }
  if (
    total !== REQUIRED_RELATIVE_DIMENSIONS ||
    relativePass !== REQUIRED_RELATIVE_DIMENSIONS ||
    nonComparable !== 0 ||
    pending !== 0 ||
    pendingOwnerWaived !== 0 ||
    summary?.complete !== true
  ) {
    const blockers = [];
    if (nonComparable > 0) blockers.push('relative_dimensions_non_comparable');
    if (pendingOwnerWaived > 0) blockers.push('relative_dimensions_pending_owner_waived');
    if (pending > 0) blockers.push('relative_dimensions_pending');
    if (total !== REQUIRED_RELATIVE_DIMENSIONS) blockers.push('relative_dimension_total_not_12');
    if (relativePass !== REQUIRED_RELATIVE_DIMENSIONS) blockers.push('relative_dimensions_not_12_of_12');
    if (summary?.complete !== true) blockers.push('relative_summary_not_complete');
    return { status: 'pending', blockers: unique(blockers), counts };
  }
  return { status: 'pass', blockers: [], counts };
}

/** @param {SoakEvidence | undefined} evidence */
function evaluateSoak(evidence) {
  if (evidence?.status === 'fail') {
    return { status: 'fail', blockers: ['soak_failed'] };
  }
  if (evidence?.ownerWaived === true) {
    return {
      status: 'pending_owner_waived',
      blockers: ['soak_pending_owner_waived'],
    };
  }
  const observedHours = finiteNonNegative(evidence?.observedHours);
  const requiredHours = finitePositive(evidence?.requiredHours);
  if (
    evidence?.status === 'pass' &&
    evidence?.completed === true &&
    observedHours != null &&
    requiredHours != null &&
    observedHours >= requiredHours
  ) {
    return { status: 'pass', blockers: [] };
  }
  return { status: 'pending', blockers: ['soak_not_completed'] };
}

/** @param {TakeoverCloseoutInput} input */
function evaluateExternalBlockers(input) {
  const blockers = [];
  const packaging = input.packagingStage;
  const gFirst = input.gFirst;

  if (packaging?.formalSignatureVerified !== true) blockers.push('formal_signature_missing');
  if (packaging?.notarizationVerified !== true) blockers.push('apple_notarization_missing');
  if (packaging?.windowsRealHostVerified !== true) {
    blockers.push('windows_true_host_verification_missing');
  }
  if (packaging?.linuxRealHostVerified !== true) {
    blockers.push('linux_true_host_verification_missing');
  }

  const humanUserCount = nonNegativeInteger(gFirst?.humanUserCount);
  const humanPassedUserCount = nonNegativeInteger(gFirst?.humanPassedUserCount);
  const requiredPassUsers = positiveInteger(gFirst?.requiredPassUsers);
  const fiveRealHumans = gFirst?.fiveRealHumans === true && (humanUserCount ?? 0) >= 5;
  if (!fiveRealHumans) blockers.push('five_real_humans_missing');
  if (
    requiredPassUsers == null ||
    humanPassedUserCount == null ||
    humanPassedUserCount < requiredPassUsers
  ) {
    blockers.push('human_pass_threshold_not_met');
  }

  if (!Array.isArray(input.externalBlockers)) {
    blockers.push('external_blocker_inventory_missing');
  } else {
    blockers.push(...input.externalBlockers.map(clean).filter(Boolean));
  }
  return { blockers: unique(blockers) };
}

/**
 * @param {CheckStatus} status
 * @param {string[]} [blockers]
 */
function check(status, blockers = []) {
  return { status, blockers: unique(blockers) };
}

/** @param {unknown} value */
function normalizeSourceDigest(value) {
  const text = clean(value).toLowerCase();
  return /^sha256:[0-9a-f]{64}$/.test(text) ? text : '';
}

/** @param {unknown} value */
function isSha256(value) {
  return /^(?:sha256:)?[0-9a-f]{64}$/i.test(clean(value));
}

/** @param {unknown} value */
function clean(value) {
  return String(value ?? '').trim();
}

/** @param {unknown} value */
function nonNegativeInteger(value) {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

/** @param {unknown} value */
function optionalNonNegativeInteger(value) {
  return value == null ? null : nonNegativeInteger(value);
}

/** @param {unknown} value */
function positiveInteger(value) {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

/** @param {unknown} value */
function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/** @param {unknown} value */
function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** @param {string[]} values */
function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
