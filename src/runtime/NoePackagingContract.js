// @ts-check
/**
 * Packaging path/output contract — unifies out-noe as canonical RC output.
 * Dist-signed and release-build must agree on directory names.
 * Update integrity: bad hash / bad signature / N-1→N / interrupt / health window.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const PACKAGING_CONTRACT_VERSION = 2;
export const CANONICAL_OUTPUT_DIR = 'out-noe';
export const LEGACY_OUTPUT_DIR = 'out';
export const MAX_HEALTH_WINDOW_SEC = 120;

/**
 * @param {object} [packageJson]
 */
export function resolvePackagingContract(packageJson = null) {
  let pkg = packageJson;
  if (!pkg) {
    try {
      pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    } catch {
      pkg = {};
    }
  }
  const configured = pkg?.build?.directories?.output || CANONICAL_OUTPUT_DIR;
  const mac = pkg?.build?.mac || {};
  const win = pkg?.build?.win || {};
  const linux = pkg?.build?.linux || {};
  const entitlementsPath = mac.entitlements || null;
  const entitlementsInheritPath = mac.entitlementsInherit || null;
  return {
    version: PACKAGING_CONTRACT_VERSION,
    packageVersion: pkg?.version || null,
    productName: pkg?.productName || pkg?.name || 'Neo 贾维斯',
    appId: pkg?.build?.appId || null,
    canonicalOutputDir: CANONICAL_OUTPUT_DIR,
    configuredOutputDir: configured,
    outputAligned: configured === CANONICAL_OUTPUT_DIR,
    legacyOutputDir: LEGACY_OUTPUT_DIR,
    hardenedRuntime: mac.hardenedRuntime === true,
    entitlements: entitlementsPath,
    entitlementsInherit: entitlementsInheritPath,
    entitlementsExist: !!(
      entitlementsPath &&
      existsSync(join(process.cwd(), entitlementsPath)) &&
      entitlementsInheritPath &&
      existsSync(join(process.cwd(), entitlementsInheritPath))
    ),
    identityConfigured: mac.identity != null && mac.identity !== '',
    identityValueIsNull: mac.identity == null,
    gatekeeperAssess: mac.gatekeeperAssess === true,
    writeUpdateInfo:
      pkg?.build?.dmg?.writeUpdateInfo === true ||
      mac.writeUpdateInfo === true ||
      win.writeUpdateInfo === true,
    platforms: {
      mac: Array.isArray(mac.target) ? mac.target : mac.target || null,
      win: win.target || null,
      linux: linux.target || null,
    },
    winNsisConfigured: Array.isArray(win.target)
      ? win.target.some((t) => (typeof t === 'string' ? t === 'nsis' : t?.target === 'nsis'))
      : win.target === 'nsis',
    linuxAppImageConfigured: Array.isArray(linux.target)
      ? linux.target.includes('AppImage') || linux.target.some((t) => t === 'AppImage' || t?.target === 'AppImage')
      : linux.target === 'AppImage',
    linuxDebConfigured: Array.isArray(linux.target)
      ? linux.target.includes('deb') || linux.target.some((t) => t === 'deb' || t?.target === 'deb')
      : linux.target === 'deb',
  };
}

/**
 * Resolve app path for arch under canonical output.
 * @param {string} root
 * @param {string} [arch]
 * @param {string} [productName]
 */
export function resolveMacAppPath(root, arch = 'arm64', productName = 'Neo 贾维斯') {
  const names = uniqueProductNames(productName);
  for (const name of names) {
    const primary = join(root, CANONICAL_OUTPUT_DIR, `mac-${arch}`, `${name}.app`);
    if (existsSync(primary)) return { path: primary, source: 'canonical', productName: name };
  }
  for (const name of names) {
    const legacy = join(root, LEGACY_OUTPUT_DIR, `mac-${arch}`, `${name}.app`);
    if (existsSync(legacy)) return { path: legacy, source: 'legacy', productName: name };
  }
  const preferred = names[0];
  return {
    path: join(root, CANONICAL_OUTPUT_DIR, `mac-${arch}`, `${preferred}.app`),
    source: 'expected_canonical_missing',
    productName: preferred,
  };
}

/**
 * Map dist-signed prepackaged path candidates (display brand first; legacy Noe retained).
 * @param {string} root
 * @param {string} [arch]
 * @param {string} [productName]
 */
export function listPrepackagedCandidates(root, arch = 'arm64', productName = 'Neo 贾维斯') {
  const names = uniqueProductNames(productName);
  /** @type {string[]} */
  const out = [];
  for (const name of names) {
    out.push(join(root, CANONICAL_OUTPUT_DIR, `mac-${arch}`, `${name}.app`));
    out.push(join(root, LEGACY_OUTPUT_DIR, `mac-${arch}`, `${name}.app`));
  }
  return out;
}

/** @param {string} productName */
function uniqueProductNames(productName) {
  const preferred = productName || 'Neo 贾维斯';
  return [...new Set([preferred, 'Neo 贾维斯', 'Noe'].filter(Boolean))];
}

/**
 * Validate update drain/checkpoint contract for running tasks.
 * @param {{ runningTaskCount?: number, drainComplete?: boolean, checkpointWritten?: boolean, healthOkWithinSec?: number }} state
 */
export function evaluateUpdateDrain(state = {}) {
  const running = Number.isInteger(state.runningTaskCount) && Number(state.runningTaskCount) >= 0
    ? Number(state.runningTaskCount)
    : null;
  const drainComplete = state.drainComplete === true;
  const checkpointWritten = state.checkpointWritten === true;
  const healthOkWithinSec = Number(state.healthOkWithinSec);
  const blockers = [];
  if (running == null) blockers.push('running_task_count_missing');
  if (!drainComplete) blockers.push('drain_not_confirmed');
  if (running != null && running > 0) blockers.push('running_tasks_not_drained');
  if (!checkpointWritten) blockers.push('checkpoint_missing');
  if (!Number.isFinite(healthOkWithinSec)) blockers.push('health_window_missing');
  else if (healthOkWithinSec > MAX_HEALTH_WINDOW_SEC) {
    blockers.push('health_window_exceeded_120s');
  }
  return {
    allowed: blockers.length === 0,
    blockers,
    maxHealthWindowSec: MAX_HEALTH_WINDOW_SEC,
  };
}

/**
 * Integrity gate for update packages (bad hash / bad signature / version order / interrupt / health).
 * Fail-closed: missing fields → reject.
 * @param {{
 *   expectedSha256?: string,
 *   actualSha256?: string,
 *   signatureValid?: boolean,
 *   fromVersion?: string,
 *   toVersion?: string,
 *   interrupted?: boolean,
 *   healthOkWithinSec?: number,
 *   rollbackTriggered?: boolean,
 * }} input
 */
export function evaluateUpdateIntegrity(input = {}) {
  const blockers = [];
  const expected = cleanHex(input.expectedSha256);
  const actual = cleanHex(input.actualSha256);
  if (!expected || !actual) blockers.push('hash_missing');
  else if (expected !== actual) blockers.push('bad_hash');

  if (input.signatureValid !== true) blockers.push('bad_signature');

  const fromV = String(input.fromVersion || '').trim();
  const toV = String(input.toVersion || '').trim();
  if (!fromV || !toV) blockers.push('version_missing');
  else if (!isVersionUpgrade(fromV, toV)) blockers.push('not_n_minus_1_to_n');

  if (typeof input.interrupted !== 'boolean') blockers.push('interrupted_state_missing');
  else if (input.interrupted === true) blockers.push('update_interrupted');

  const health = Number(input.healthOkWithinSec);
  if (!Number.isFinite(health)) blockers.push('health_window_missing');
  else if (health > MAX_HEALTH_WINDOW_SEC) blockers.push('health_window_exceeded_120s');

  const needsRollback =
    blockers.includes('bad_hash') ||
    blockers.includes('bad_signature') ||
    blockers.includes('update_interrupted') ||
    blockers.includes('health_window_exceeded_120s');

  if (needsRollback && input.rollbackTriggered !== true) {
    blockers.push('rollback_not_triggered');
  }

  return {
    accept: blockers.length === 0,
    blockers,
    needsRollback,
    maxHealthWindowSec: MAX_HEALTH_WINDOW_SEC,
  };
}

/**
 * Bind version / commit / sourceDigest / package artifact identity.
 * @param {{
 *   packageVersion?: string,
 *   appVersion?: string,
 *   commit?: string,
 *   expectedCommit?: string,
 *   sourceDigest?: string,
 *   expectedSourceDigest?: string,
 *   packageSha256?: string,
 *   manifestSha256?: string,
 * }} ids
 */
export function evaluateIdentityBinding(ids = {}) {
  const blockers = [];
  if (!ids.packageVersion || !ids.appVersion) blockers.push('version_missing');
  else if (ids.packageVersion !== ids.appVersion) blockers.push('version_mismatch');
  if (!ids.commit || !ids.expectedCommit) blockers.push('commit_missing');
  else if (ids.commit !== ids.expectedCommit) blockers.push('commit_mismatch');
  if (!ids.sourceDigest || !ids.expectedSourceDigest) blockers.push('source_digest_missing');
  else if (ids.sourceDigest !== ids.expectedSourceDigest) blockers.push('source_digest_mismatch');
  if (!ids.packageSha256) blockers.push('package_hash_missing');
  if (!ids.manifestSha256) blockers.push('manifest_hash_missing');
  else if (ids.packageSha256 && ids.manifestSha256 && ids.packageSha256 !== ids.manifestSha256) {
    blockers.push('package_manifest_hash_mismatch');
  }
  return { ok: blockers.length === 0, blockers };
}

/**
 * Split S8 status: internal work vs owner-only external blockers.
 * Whole stage is NOT blocked_external while internal items remain open.
 * @param {ReturnType<typeof resolvePackagingContract>} contract
 * @param {{
 *   sbomExists?: boolean,
 *   rcMacAppExists?: boolean,
 *   updateIntegritySuitePass?: boolean,
 *   drainSuitePass?: boolean,
 *   identityBindingOk?: boolean,
 *   macDmgArtifactExists?: boolean,
 *   macDmgArtifactSha256?: string,
 *   macZipArtifactExists?: boolean,
 *   macZipArtifactSha256?: string,
 *   winNsisArtifactExists?: boolean,
 *   winNsisArtifactSha256?: string,
 *   linuxAppImageArtifactExists?: boolean,
 *   linuxAppImageArtifactSha256?: string,
 *   linuxDebArtifactExists?: boolean,
 *   linuxDebArtifactSha256?: string,
 *   crossPlatformArtifactsExternal?: boolean,
 *   winInstallVerified?: boolean,
 *   linuxAppImageRunVerified?: boolean,
 *   linuxDebInstallVerified?: boolean,
 *   crossPlatformRuntimeExternal?: boolean,
 *   formalSignatureVerified?: boolean,
 *   notarizationVerified?: boolean,
 * }} evidence
 */
export function evaluateS8StageStatus(contract, evidence = {}) {
  const internalDone = [];
  const internalOpen = [];
  const externalOnly = [];

  const push = (ok, id, bucket = 'internal') => {
    if (ok) internalDone.push(id);
    else if (bucket === 'external') externalOnly.push(id);
    else internalOpen.push(id);
  };
  const artifactReady = (exists, sha256) =>
    exists === true && /^[0-9a-f]{64}$/i.test(String(sha256 || '').replace(/^sha256:/i, ''));
  const pushCrossPlatformArtifact = (ready, doneId, missingId, externalId) => {
    if (ready) internalDone.push(doneId);
    else if (evidence.crossPlatformArtifactsExternal === true) externalOnly.push(externalId);
    else internalOpen.push(missingId);
  };
  const pushCrossPlatformRuntime = (verified, doneId, missingId, externalId) => {
    if (verified) internalDone.push(doneId);
    else if (evidence.crossPlatformRuntimeExternal === true) externalOnly.push(externalId);
    else internalOpen.push(missingId);
  };

  push(contract.outputAligned === true, 'output_dir_out_noe');
  push(contract.hardenedRuntime === true, 'hardened_runtime');
  push(contract.entitlementsExist === true, 'entitlements');
  // Target declarations are contract information only. A stage may not pass
  // until target-host artifacts exist and have a concrete content hash.
  push(contract.winNsisConfigured === true, 'win_nsis_target_configured');
  push(contract.linuxAppImageConfigured === true, 'linux_appimage_target_configured');
  push(contract.linuxDebConfigured === true, 'linux_deb_target_configured');
  push(
    artifactReady(evidence.macDmgArtifactExists, evidence.macDmgArtifactSha256),
    'mac_dmg_hashed',
  );
  push(
    artifactReady(evidence.macZipArtifactExists, evidence.macZipArtifactSha256),
    'mac_zip_hashed',
  );
  pushCrossPlatformArtifact(
    artifactReady(evidence.winNsisArtifactExists, evidence.winNsisArtifactSha256),
    'win_nsis_binary_hashed',
    'win_nsis_binary_missing',
    'win_nsis_binary_cross_host',
  );
  pushCrossPlatformArtifact(
    artifactReady(evidence.linuxAppImageArtifactExists, evidence.linuxAppImageArtifactSha256),
    'linux_appimage_binary_hashed',
    'linux_appimage_binary_missing',
    'linux_appimage_binary_cross_host',
  );
  pushCrossPlatformArtifact(
    artifactReady(evidence.linuxDebArtifactExists, evidence.linuxDebArtifactSha256),
    'linux_deb_binary_hashed',
    'linux_deb_binary_missing',
    'linux_deb_binary_cross_host',
  );
  pushCrossPlatformRuntime(
    evidence.winInstallVerified === true,
    'win_nsis_install_verified',
    'win_nsis_install_not_verified',
    'win_nsis_install_cross_host',
  );
  pushCrossPlatformRuntime(
    evidence.linuxAppImageRunVerified === true,
    'linux_appimage_run_verified',
    'linux_appimage_run_not_verified',
    'linux_appimage_run_cross_host',
  );
  pushCrossPlatformRuntime(
    evidence.linuxDebInstallVerified === true,
    'linux_deb_install_verified',
    'linux_deb_install_not_verified',
    'linux_deb_install_cross_host',
  );
  push(evidence.sbomExists === true, 'sbom');
  push(evidence.rcMacAppExists === true, 'rc_macos_package');
  push(evidence.updateIntegritySuitePass === true, 'update_integrity_suite');
  push(evidence.drainSuitePass === true, 'update_drain_checkpoint');
  push(evidence.identityBindingOk === true, 'version_commit_digest_binding');

  // Configuration or authorization is not proof. Only direct verification of
  // the built artifact can close formal signing/notarization.
  if (evidence.formalSignatureVerified === true) {
    internalDone.push('formal_signing_identity');
  } else {
    externalOnly.push('formal_signing_identity_owner');
  }
  if (evidence.notarizationVerified === true) {
    internalDone.push('apple_notarization');
  } else {
    externalOnly.push('apple_notarization_owner');
  }

  let stageStatus = 'in_progress';
  if (internalOpen.length === 0 && externalOnly.length === 0) stageStatus = 'pass';
  else if (internalOpen.length === 0 && externalOnly.length > 0) stageStatus = 'blocked_external';
  // else remain in_progress — never whole-stage blocked while internal open

  return {
    stage: 'S8',
    status: stageStatus,
    contractVersion: PACKAGING_CONTRACT_VERSION,
    internalDone,
    internalOpen,
    externalOnly,
    wholeStageBlockedExternal: stageStatus === 'blocked_external',
    canContinueInternal: internalOpen.length > 0,
  };
}

/**
 * G-FIRST absolute policy. Automated isolated-HOME personas are useful technical
 * evidence, but they can never satisfy the five-real-human acceptance gate.
 *
 * @param {{
 *   technicalPass?: boolean,
 *   fiveRealHumans?: boolean,
 *   humanUserCount?: number,
 *   humanPassedUserCount?: number,
 *   requiredPassUsers?: number,
 * }} evidence
 */
export function evaluateGFirstGate(evidence = {}) {
  const technicalPass = evidence.technicalPass === true;
  const humanUserCount = Math.max(0, Number(evidence.humanUserCount) || 0);
  const humanPassedUserCount = Math.min(
    humanUserCount,
    Math.max(0, Number(evidence.humanPassedUserCount) || 0),
  );
  const requiredPassUsers = Math.max(1, Number(evidence.requiredPassUsers) || 4);
  const fiveRealHumans = evidence.fiveRealHumans === true && humanUserCount >= 5;
  const blockers = [];

  if (!technicalPass) blockers.push('technical_first_run_failed');
  if (!fiveRealHumans) blockers.push('five_real_humans_missing');
  if (humanPassedUserCount < requiredPassUsers) blockers.push('human_pass_threshold_not_met');

  const ok = blockers.length === 0;
  return {
    ok,
    status: ok ? 'pass' : technicalPass ? 'blocked_external' : 'fail',
    blockers,
    technicalPass,
    fiveRealHumans,
    humanUserCount,
    humanPassedUserCount,
    requiredPassUsers,
  };
}

export const DIRECTORY_TREE_HASH_KIND = 'directory_tree_v1';

/**
 * Hash a directory deterministically without depending on mtimes or absolute
 * paths. Relative names, entry types, permission bits, symlink targets and all
 * file bytes are framed into the digest.
 *
 * @param {string} directoryPath
 */
export function sha256DirectoryTree(directoryPath) {
  const rootStat = lstatSync(directoryPath);
  if (!rootStat.isDirectory()) throw new TypeError(`not_a_directory:${directoryPath}`);
  const hash = createHash('sha256');

  /** @param {string | Buffer} value */
  const frame = (value) => {
    const body = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    hash.update(String(body.length));
    hash.update(':');
    hash.update(body);
  };

  frame(DIRECTORY_TREE_HASH_KIND);

  /** @param {string} absDir @param {string} relDir */
  const walk = (absDir, relDir) => {
    const names = readdirSync(absDir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) {
      const absPath = join(absDir, name);
      const relPath = relDir ? `${relDir}/${name}` : name;
      const st = lstatSync(absPath);
      const mode = (st.mode & 0o7777).toString(8);

      if (st.isSymbolicLink()) {
        frame('symlink');
        frame(relPath);
        frame(mode);
        frame(readlinkSync(absPath));
      } else if (st.isDirectory()) {
        frame('directory');
        frame(relPath);
        frame(mode);
        walk(absPath, relPath);
      } else if (st.isFile()) {
        frame('file');
        frame(relPath);
        frame(mode);
        frame(String(st.size));
        frame(readFileSync(absPath));
      } else {
        frame('other');
        frame(relPath);
        frame(mode);
      }
    }
  };

  walk(directoryPath, '');
  return hash.digest('hex');
}

/**
 * @param {string} [filePath]
 */
export function sha256File(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  const st = statSync(filePath);
  if (st.isDirectory()) return sha256DirectoryTree(filePath);
  const buf = readFileSync(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * @param {string} [filePath]
 */
export function fileMeta(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  const st = statSync(filePath);
  const isDirectory = st.isDirectory();
  return {
    path: filePath,
    size: st.size,
    mtimeMs: st.mtimeMs,
    isDirectory,
    sha256: sha256File(filePath),
    hashKind: isDirectory ? DIRECTORY_TREE_HASH_KIND : 'file_bytes_v1',
  };
}

function cleanHex(v) {
  const s = String(v || '').trim().toLowerCase().replace(/^sha256:/, '');
  return /^[0-9a-f]{64}$/.test(s) ? s : '';
}

/** Semver-ish: to must be greater than from (N-1 → N upgrade). */
function isVersionUpgrade(fromV, toV) {
  const a = parseVer(fromV);
  const b = parseVer(toV);
  if (!a || !b) return fromV !== toV && Boolean(toV);
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return true;
    if (b[i] < a[i]) return false;
  }
  return false;
}

function parseVer(v) {
  const m = String(v).replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
